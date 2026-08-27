'use strict';

// Friendly "app is restarting" page for dead app containers (#426).
//
// The Caddyfile's wildcard site routes every `<slug>.<domain>` request to
// the container named `usernode-app-<slug>`. When that container is down
// (crashed, stopped, or mid-redeploy — rebuildProduction stops the old
// container before the new one passes its healthcheck), the proxy fails
// and Caddy's handle_errors used to answer with the raw text "502 Bad
// Gateway". Now the wildcard site's handle_errors rewrites 502/503/504 to
// this route and proxies it to the platform, which:
//
//   1. Serves a small self-contained HTML page (inline CSS/JS only — the
//      app's origin is down, so it can't load assets from anywhere) with
//      deliberately NEUTRAL copy: "This app is restarting — it'll be back
//      in a moment". The same page appears during perfectly normal
//      redeploys, so it must not read as an alarm. The page re-fetches
//      itself every ~5s and reloads the moment the app answers; after ~2
//      minutes it switches to the honest "Still not responding — the team
//      has been notified" escalation and slows down.
//   2. Kicks the production watchdog's on-demand heal for the slug
//      (services/app-heal.js requestHeal), so a visitor landing on a dead
//      app starts its recovery immediately instead of waiting for the
//      next sweep tick.
//
// Mounted in server.js BEFORE authMiddleware: the request arrives
// host-routed from Caddy carrying the original app-subdomain Host and no
// platform session. No auth is needed — for view-private apps the
// Caddyfile's forward_auth gate already ran (and passed) before the proxy
// attempt that failed, and this route reveals nothing private anyway: the
// app display name is only rendered for view-PUBLIC apps, preserving the
// existence-hiding posture of the edge gate in routes/internal.js.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const appAccess = require('../services/app-access');
const appHeal = require('../services/app-heal');

// How long the page keeps showing the calm "restarting" copy before
// escalating to "still not responding" (client-side; keep in sync with
// the ESCALATE_MS constant baked into the page script).
const ESCALATE_AFTER_MS = 2 * 60 * 1000;

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Self-contained page: no external assets (the app origin is down and we
// don't want the error path depending on anything else), works in both
// the shell iframe and a direct tab, light/dark aware.
function renderPage(displayName) {
  const name = escapeHtml(displayName || 'This app');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} is restarting</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; text-align: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f9f8e9; color: #2d2c28;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #171614; color: #e4e4d9; }
  }
  .wrap { padding: 32px; max-width: 26rem; }
  .spinner {
    width: 40px; height: 40px; margin: 0 auto 20px;
    border: 3px solid rgba(8, 107, 179, 0.25);
    border-top-color: #086bb3; border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  /* The accent has to FLIP with the scheme, unlike the neutrals above, which
     only change places: #086bb3 is 2.6:1 on the dark ground and the spinner
     is the only motion on the page, so it would all but vanish. The platform's
     dark accent reads at 8.9:1. This block sits AFTER the rule it overrides
     because both selectors are the same class — equal specificity, so source
     order decides.
     (Nothing in this page may contain a backtick: the whole document is one
     JS template literal in this file.) */
  @media (prefers-color-scheme: dark) {
    .spinner { border-color: rgba(111, 183, 251, 0.25); border-top-color: #6fb7fb; }
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size: 1.15rem; margin: 0 0 8px; font-weight: 600; }
  p { margin: 0; font-size: 0.95rem; opacity: 0.75; line-height: 1.5; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="spinner" id="spinner"></div>
    <h1 id="title">${name} is restarting</h1>
    <p id="msg">It&#39;ll be back in a moment. This page retries automatically.</p>
  </div>
<script>
(function () {
  // Poll our own URL until the app answers, then reload so the original
  // navigation (token query param included) replays against the live app.
  // While the app is down this same URL serves the JSON branch of the
  // error route (503), so "non-5xx" is a reliable "the app is back"
  // signal. After ESCALATE_MS of failures, switch to the honest
  // still-down copy and slow the polling.
  var ESCALATE_MS = ${ESCALATE_AFTER_MS};
  var startedAt = Date.now();
  var escalated = false;

  function tick() {
    fetch(window.location.href, { cache: 'no-store' })
      .then(function (res) {
        if (res.status < 500) { window.location.reload(); return; }
        schedule();
      })
      .catch(schedule);
  }

  function schedule() {
    var elapsed = Date.now() - startedAt;
    if (!escalated && elapsed > ESCALATE_MS) {
      escalated = true;
      document.getElementById('title').textContent = 'Still not responding';
      document.getElementById('msg').textContent =
        'The team has been notified. We\\u2019ll keep retrying in the background.';
    }
    setTimeout(tick, escalated ? 15000 : 5000);
  }

  setTimeout(tick, 5000);
})();
</script>
</body>
</html>`;
}

function appErrorRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/__app_unavailable', async (req, res) => {
    res.status(503);
    res.set('Retry-After', '10');
    res.set('Cache-Control', 'no-store');

    // Caddy's reverse_proxy preserves the original Host, so the app
    // subdomain the user was visiting arrives here.
    const rawHost = req.headers['x-forwarded-host'] || req.headers.host;

    let displayName = null;
    try {
      const parsed = appAccess.parseAppHost(rawHost);
      if (parsed) {
        // Only production hosts get the on-demand heal — staging previews
        // are owned by the staging heal sweep (server.js Pass 3).
        if (parsed.label === parsed.slug) {
          appHeal.requestHeal(parsed.slug, config);
        }
        // Existence-hiding: name only for view-PUBLIC apps. The generic
        // fallback copy is used for private (or unknown) hosts.
        const vis = await appAccess.getHostVisibility(pool, parsed.slug);
        if (vis && !vis.viewPrivate) {
          const { rows } = await pool.query(
            'SELECT name FROM apps WHERE id = $1', [vis.appId]
          );
          displayName = rows[0]?.name || null;
        }
      }
    } catch (err) {
      // Best-effort context only — the page must render regardless.
      log.warn('app-error', 'Unavailable-page context lookup failed', {
        host: rawHost, err: err.message,
      });
    }

    // Document navigations (top-level tab or the shell's app iframe) get
    // the HTML page; API fetches from a half-loaded app frontend get JSON
    // so they don't try to parse HTML. Sec-Fetch-Dest is 'document' /
    // 'iframe' for navigations, 'empty' for fetch(); tools/older browsers
    // that omit it fall back to the Accept header.
    const dest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
    const isDocument = dest === 'document' || dest === 'iframe'
      || (!dest && String(req.headers.accept || '').includes('text/html'));

    if (!isDocument) {
      return res.json({ error: 'app_unavailable' });
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderPage(displayName));
  });

  return router;
}

module.exports = { appErrorRoutes };
