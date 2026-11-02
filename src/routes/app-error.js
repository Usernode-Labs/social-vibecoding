'use strict';

// Friendly "app is restarting" page for dead app containers (#426).
//
// The Caddyfile's wildcard site routes every `<slug>.<domain>` request to
// the container named `usernode-app-<slug>`. When that container is down
// (crashed, stopped, or mid-redeploy — deployProduction stops the old
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
//   2. Tells app delivery the app could not be reached
//      (services/app-heal.js reportVisit), so a visitor landing on a dead
//      app starts its recovery now instead of at the next look of the
//      app-health clock, and one up but not answering is probed. App
//      delivery decides whether to heal it (src/workflow/app-delivery/).
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
const appOutages = require('../services/app-outages');
const wakingPage = require('../services/preview-waking-page');

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
    background: #f8f7fc; color: #1f2937;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #17151f; color: #e5e7eb; }
  }
  .wrap { padding: 32px; max-width: 26rem; }
  .spinner {
    width: 40px; height: 40px; margin: 0 auto 20px;
    border: 3px solid rgba(124, 58, 237, 0.25);
    border-top-color: #7c3aed; border-radius: 50%;
    animation: spin 0.9s linear infinite;
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

// A sleeping preview's host (#6157, services/preview-sleep.js): its
// Service has no pod, so the app-host gate's proxy fails and lands here with
// the gate on. The preview is woken, and the visitor gets the waking page,
// which polls and reloads once it serves. Null for any other host, or a
// preview that is not asleep (that one is down for another reason).
async function asleepPreview(pool, rawHost) {
  const previewSleep = require('../services/preview-sleep');
  const named = previewSleep.previewSessionOfHost(rawHost);
  if (!named) return null;
  const { rows: [row] } = await pool.query(
    `SELECT cs.id, cs.staging_asleep_at, cs.staging_runtime_kind FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1 AND a.slug = $2`, [named.sessionId, named.slug]);
  return row && previewSleep.isAsleep(row) ? named : null;
}

function appErrorRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // The waking page's ask (#6157): wake the preview this host names. Sent
  // by the page from the preview's own origin with no credentials and no
  // body (a no-cors POST), so it carries nothing to check but the host,
  // which is the preview's own public address: anybody who can open the link
  // can wake it, as opening it would. Answered at once; the page polls.
  router.post(wakingPage.WAKE_PATH, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const host = typeof req.query.host === 'string' ? req.query.host.slice(0, 253) : '';
      const out = await require('../services/preview-sleep').wakeByHost(config, pool, host);
      return res.status(out.status === 'unknown' ? 404 : 202).json(out);
    } catch (err) {
      log.warn('app-error', 'A waking page\'s wake could not be asked', { err: err.message });
      return res.status(503).json({ status: 'unavailable' });
    }
  });

  router.get('/__app_unavailable', async (req, res) => {
    res.status(503);
    res.set('Retry-After', '10');
    res.set('Cache-Control', 'no-store');

    // Caddy's reverse_proxy preserves the original Host, so the app
    // subdomain the user was visiting arrives here.
    const rawHost = req.headers['x-forwarded-host'] || req.headers.host;

    // A sleeping preview: woken, and the visitor waits on the waking page.
    let sleeping = null;
    try { sleeping = await asleepPreview(pool, rawHost); } catch (err) {
      log.warn('app-error', 'Could not read whether a preview is asleep', { host: rawHost, err: err.message });
    }
    if (sleeping) {
      require('../services/preview-sleep').wakeByHost(config, pool, sleeping.host)
        .catch((err) => log.warn('app-error', 'A sleeping preview\'s wake could not be asked', { host: sleeping.host, err: err.message }));
      if (!wakingPage.wantsDocument(req.headers)) return res.json({ error: 'preview_waking' });
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(wakingPage.renderWakingPage({
        wakeUrl: wakingPage.wakeUrlFor(require('../services/caddy').USERNODE_DOMAIN, sleeping.host),
      }));
    }

    let displayName = null;
    let productionSlug = null;
    try {
      // A Homeroom host or a live custom domain (#4405).
      const parsed = await require('../services/app-domains').resolveAppHost(pool, rawHost);
      if (parsed) {
        // Only production hosts: a staging preview's runtime is its
        // preview machine's (src/workflow/preview/).
        if (parsed.label === parsed.slug) {
          productionSlug = parsed.slug;
          appHeal.reportVisit(pool, parsed.slug);
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
    // Somebody opening a production app got this page, not the app: the
    // Infra topic's "App opens that worked" counts it. The page's own
    // retries are fetches, so they never land here.
    if (productionSlug) appOutages.recordUnavailable(pool, productionSlug);
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderPage(displayName));
  });

  return router;
}

module.exports = { appErrorRoutes, _asleepPreviewForTest: asleepPreview };
