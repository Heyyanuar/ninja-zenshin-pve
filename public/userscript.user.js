// ==UserScript==
// @name         Ninja Zenshin PVE Auto-Sync Bot
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Otomatis mengirim update PVE Leaderboard dari Ninja Zenshin ke Cloudflare Pages
// @match        *://*.ninjazenshin.com/*
// @grant        GM_xmlhttpRequest
// ==UserScript==

(function() {
    'use strict';

    const PAGES_INGEST_URL = "https://ninja-zenshin-pve.pages.dev/api/ingest"; // Ganti dengan domain pages.dev Anda jika beda

    function autoSyncLeaderboard() {
        const lbPanel = document.getElementById('leaderboard-content') || document.querySelector('.lb-table');
        if (lbPanel) {
            const htmlContent = lbPanel.outerHTML;
            GM_xmlhttpRequest({
                method: "POST",
                url: PAGES_INGEST_URL,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify({ html: htmlContent }),
                onload: function(response) {
                    console.log("[PVE Auto-Sync] Leaderboard data synced successfully to Cloudflare!");
                }
            });
        }
    }

    // Auto sync setiap 60 detik saat halaman web Ninja Zenshin terbuka
    setInterval(autoSyncLeaderboard, 60000);
    setTimeout(autoSyncLeaderboard, 3000);
})();
