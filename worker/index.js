// Cloudflare Worker for PVE Leaderboard Tracker
// Target Domain: https://ninjazenshin.online/pve-leaderboard (Matches Clan War project architecture)
// KV Namespace ID: dcf7d4858257402aaf72f98f94839350

const DEFAULT_GAME_URL = "https://ninjazenshin.online/pve-leaderboard";
const AFK_THRESHOLD_MS = 15 * 60 * 1000;
const MATCH_ESTIMATE_MS = 5 * 60 * 1000;

function getKV(env) {
  if (!env) return null;
  return env.LEADERBOARD_KV || env.KV || null;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateLeaderboardData(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json; charset=utf-8"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/api/sync") {
      const updated = await updateLeaderboardData(env);
      return new Response(JSON.stringify({ success: true, data: updated }), { headers: corsHeaders });
    }

    if (url.pathname === "/api/ingest" && request.method === "POST") {
      try {
        const body = await request.json();
        const html = body.html;
        if (!html) return new Response(JSON.stringify({ error: "Missing html content" }), { status: 400, headers: corsHeaders });
        const updated = await parseAndSaveSnapshot(html, env);
        return new Response(JSON.stringify({ success: true, data: updated }), { headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    const data = await getLatestLeaderboard(env);
    return new Response(JSON.stringify(data), { headers: corsHeaders });
  }
};

async function updateLeaderboardData(env) {
  const targetUrl = (env && env.TARGET_GAME_URL) ? env.TARGET_GAME_URL : DEFAULT_GAME_URL;
  try {
    const response = await fetch(targetUrl, {
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    return await parseAndSaveSnapshot(html, env);
  } catch (err) {
    console.error("Worker Sync Error:", err);
    return null;
  }
}

async function sendIPhoneNotification(env, player, oldRank) {
  const isRankUp = oldRank && player.rank < oldRank;
  const title = isRankUp ? "🚀 RANK UP! CHAOS KONTOL" : "🔥 SCORE INCREASED! CHAOS KONTOL";
  const bodyText = `Rank #${player.rank} | Score: ${player.score.toLocaleString()} (+${player.gain.toLocaleString()})`;

  if (env && env.BARK_DEVICE_KEY) {
    try {
      const barkUrl = `https://api.day.app/${env.BARK_DEVICE_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(bodyText)}?sound=minuet&group=PVETracker`;
      await fetch(barkUrl);
    } catch (e) {}
  }

  if (env && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      const tgUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const text = `*${title}*\n${bodyText}\nDaily Gain: +${player.daily_gain.toLocaleString()} pts`;
      await fetch(tgUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" })
      });
    } catch (e) {}
  }
}

async function parseAndSaveSnapshot(html, env) {
  const seasonMatch = html.match(/<div class="lb-season">(.*?)<\/div>/i);
  const seasonTitle = seasonMatch ? seasonMatch[1].trim() : "Season 3 · Round 1/2";

  const endMatch = html.match(/data-end="(.*?)"/i);
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

  const kv = getKV(env);

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

      if (name === "CHAOS KONTOL" && gain > 0 && env) {
        sendIPhoneNotification(env, { name, rank, score, gain, daily_gain: dailyGain, active_hours_today: activeHoursToday }, prev.rank);
      }
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

async function getLatestLeaderboard(env) {
  const kv = getKV(env);
  if (kv) {
    const raw = await kv.get("SHARED_LEADERBOARD_SNAPSHOT");
    if (raw) return JSON.parse(raw);
  }
  return null;
}
