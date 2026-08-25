// Cloudflare Pages Function: /api/leaderboard & /api/sync
// Direct Edge API route for Ninja Zenshin PVE Leaderboard (ninjazenshin.online)

const TARGET_URLS = [
  "https://ninjazenshin.online/pve-leaderboard",
  "https://ninjazenshin.online/leaderboard",
  "https://ninjazenshin.online/pve"
];

const AFK_THRESHOLD_MS = 15 * 60 * 1000;
const MATCH_ESTIMATE_MS = 5 * 60 * 1000;

export async function onRequest(context) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=5"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(context.request.url);

  // Manual / Auto Sync Request
  if (url.searchParams.get("sync") === "true" || url.pathname.endsWith("/sync")) {
    const data = await fetchAndParseFromGame(context.env);
    if (data) {
      return new Response(JSON.stringify({ success: true, data }), { headers: corsHeaders });
    }
  }

  // Get cached snapshot from D1 / KV / fallback
  let data = await getLatestSnapshot(context.env);
  
  // If no cache or cache older than 1 minute, auto-fetch from ninjazenshin.online
  if (!data || !data.players || (Date.now() - new Date(data.updated_at).getTime() > 60000)) {
    const fetched = await fetchAndParseFromGame(context.env);
    if (fetched) data = fetched;
  }

  return new Response(JSON.stringify(data || {}), { headers: corsHeaders });
}

async function fetchAndParseFromGame(env) {
  let html = null;
  for (const targetUrl of TARGET_URLS) {
    try {
      const response = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5"
        }
      });
      if (response.ok) {
        html = await response.text();
        if (html.includes("lb-table") || html.includes("PvE Leaderboard")) break;
      }
    } catch(e) {}
  }

  if (!html) return null;
  return await parseSnapshot(html, env);
}

async function parseSnapshot(html, env) {
  const seasonMatch = html.match(/<div class="lb-season">(.*?)<\/div>/i);
  const seasonTitle = seasonMatch ? seasonMatch[1].trim() : "Season 3 · Round 1/2";

  const endMatch = html.match(/data-end="([^"]+)"/i);
  const nextRoundEnd = endMatch ? endMatch[1].trim() : "2026-09-07T00:00:00+08:00";

  const onlineMatch = html.match(/<div class="lb-online"><i><\/i>(\d+)\s*online<\/div>/i);
  const onlineCount = onlineMatch ? parseInt(onlineMatch[1], 10) : 6;

  const rowRegex = /<td class="r">(\d+)<\/td>\s*<td>(.*?)<\/td>\s*<td class="sc">([\d,]+)<\/td>/gi;
  let match;
  const now = new Date();

  const sgtOffset = 8 * 60 * 60 * 1000;
  const sgtDate = new Date(now.getTime() + sgtOffset);
  const sgtISO = sgtDate.toISOString().replace("Z", "+08:00");
  const todaySgtStr = sgtISO.split("T")[0];

  const kv = env ? (env.LEADERBOARD_KV || env.KV) : null;
  let prevData = null;

  if (kv) {
    const rawPrev = await kv.get("SHARED_LEADERBOARD_SNAPSHOT");
    if (rawPrev) prevData = JSON.parse(rawPrev);
  }

  const prevMap = new Map();
  if (prevData && prevData.players) {
    prevData.players.forEach(p => prevMap.set(p.name, p));
  }

  const currentPlayers = [];

  while ((match = rowRegex.exec(html)) !== null) {
    const rank = parseInt(match[1], 10);
    const name = match[2].trim();
    const score = parseInt(match[3].replace(/,/g, ""), 10);

    let guild = "NONE";
    if (name.startsWith("CHAOS")) guild = "CHAOS";
    else if (name.includes("DoA") || name.includes("𝓓𝓸𝓐") || name.includes("DøA")) guild = "DoA";
    else if (name.startsWith("TDY")) guild = "TDY";
    else if (name.startsWith("LMN")) guild = "LMN";
    else if (name.toLowerCase().includes("anbu") || name.includes("αηвυ")) guild = "ANBU";
    else if (name.includes("SØΛ")) guild = "SOA";
    else if (name.startsWith("J͎G͎")) guild = "JG";
    else if (name.startsWith("PF")) guild = "PF";

    const prev = prevMap.get(name);
    let gain = 0;
    let dailyGain = 0;
    let activeHoursToday = 0;
    let totalActiveHours = 0;
    let isOnline = false;
    let lastScoreTime = sgtISO;
    let sessionStartTime = sgtISO;
    let totalActiveMsToday = 0;
    let totalActiveMsAllTime = 0;

    if (prev) {
      const prevScore = prev.score || 0;
      gain = score > prevScore ? score - prevScore : 0;
      const prevLastScoreTs = new Date(prev.last_score_time || sgtISO).getTime();
      const nowTs = now.getTime();
      const gapMs = nowTs - prevLastScoreTs;

      isOnline = gain > 0 || (gapMs < AFK_THRESHOLD_MS);

      const prevDateSgt = (prev.last_score_time || "").split("T")[0];
      const isNewDaySgt = prevDateSgt !== todaySgtStr;

      if (isNewDaySgt) {
        dailyGain = gain;
        totalActiveMsToday = gain > 0 ? MATCH_ESTIMATE_MS : 0;
        sessionStartTime = sgtISO;
      } else {
        dailyGain = (prev.daily_gain || 0) + gain;
        totalActiveMsToday = prev.total_active_ms_today || (prev.active_hours_today * 3600000) || 0;
        sessionStartTime = prev.session_start_time || sgtISO;

        if (gain > 0) {
          if (gapMs <= AFK_THRESHOLD_MS) {
            totalActiveMsToday += gapMs;
          } else {
            totalActiveMsToday += MATCH_ESTIMATE_MS;
            sessionStartTime = sgtISO;
          }
        }
      }

      totalActiveMsAllTime = (prev.total_active_ms_all_time || (prev.total_active_hours * 3600000) || 0) + (gain > 0 ? (gapMs <= AFK_THRESHOLD_MS ? gapMs : MATCH_ESTIMATE_MS) : 0);
      lastScoreTime = gain > 0 ? sgtISO : (prev.last_score_time || sgtISO);

      activeHoursToday = Math.round((totalActiveMsToday / 3600000) * 10) / 10;
      totalActiveHours = Math.round((totalActiveMsAllTime / 3600000) * 10) / 10;
    } else {
      gain = 0;
      dailyGain = 0;
      activeHoursToday = 0.1;
      totalActiveHours = 0.1;
      isOnline = true;
      sessionStartTime = sgtISO;
    }

    currentPlayers.push({
      rank,
      name,
      score,
      guild,
      gain: gain,
      daily_gain: dailyGain,
      active_hours_today: activeHoursToday,
      total_active_hours: totalActiveHours,
      total_active_ms_today: totalActiveMsToday,
      total_active_ms_all_time: totalActiveMsAllTime,
      session_start_time: sessionStartTime,
      is_online: isOnline,
      last_score_time: lastScoreTime
    });
  }

  const payload = {
    season: seasonTitle,
    next_round_end: nextRoundEnd,
    online_count: onlineCount,
    updated_at: sgtISO,
    players: currentPlayers
  };

  if (kv) {
    await kv.put("SHARED_LEADERBOARD_SNAPSHOT", JSON.stringify(payload));
  }

  return payload;
}

async function getLatestSnapshot(env) {
  const kv = env ? (env.LEADERBOARD_KV || env.KV) : null;
  if (kv) {
    const raw = await kv.get("SHARED_LEADERBOARD_SNAPSHOT");
    if (raw) return JSON.parse(raw);
  }
  return null;
}
