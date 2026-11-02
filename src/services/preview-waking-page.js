'use strict';

// The "Waking this preview…" page (#6157): what a direct link to a sleeping
// preview answers while its pod comes back (services/preview-sleep.js).
//
// Two servers send it, and both must work without the platform's
// environment, so this module is pure and dependency-free:
//   - the platform's /__app_unavailable (routes/app-error.js), which the
//     app-host gate falls back to when a preview's Service has no pod, with
//     the gate on (APP_GATE);
//   - the shared asset backend in the app namespace
//     (scripts/serve-platform-assets.js), where a sleeping preview's Ingress
//     sends its link with the gate off.
//
// The page is self-contained (inline CSS and script, nothing loaded from the
// preview's origin, which has no pod). It asks the platform to wake the
// preview (a POST to `wakeUrl`, the platform's own origin, sent no-cors: the
// answer is not read, the page only needs it delivered), asks again every
// so often in case that one was lost, polls its own address, and reloads
// once something other than a 5xx answers, which is the app. After two
// minutes it says it is taking longer and polls more slowly. It is a
// standalone page that loads no shell bundle, so its words are written here
// in English (frontend/locales/README.md).

const ESCALATE_AFTER_MS = 2 * 60 * 1000;
const POLL_MS = 3000;
const ASK_AGAIN_MS = 20000;
// The path a waking page asks the platform to wake a preview at.
const WAKE_PATH = '/__preview_wake';

// A Homeroom preview host: `<slug>--s<sessionId>` under the apps domain
// (caddy.js stagingHostname, app-access.js parseAppHost).
const PREVIEW_LABEL_RE = /^[a-z0-9-]+?--s\d+(?:--[a-z0-9]+)?$/;

function previewHost(rawHost, appsDomain) {
  const host = String(rawHost || '').trim().toLowerCase().replace(/:\d+$/, '');
  const domain = String(appsDomain || '').trim().toLowerCase();
  if (!host || !domain || !host.endsWith(`.${domain}`)) return null;
  const label = host.slice(0, -(domain.length + 1));
  return label && !label.includes('.') && PREVIEW_LABEL_RE.test(label) ? host : null;
}

// The platform's wake address for a preview host, scheme-relative so the
// page uses its own scheme.
function wakeUrlFor(platformDomain, host) {
  const domain = String(platformDomain || '').trim().toLowerCase();
  if (!domain || !/^[a-z0-9.-]+(?::\d+)?$/.test(domain)) return null;
  return `//${domain}${WAKE_PATH}?host=${encodeURIComponent(String(host || ''))}`;
}

// Document navigations get the page; anything else (an asset, an app's
// fetch) gets a short 503 its caller can read.
function wantsDocument(headers = {}) {
  const dest = String(headers['sec-fetch-dest'] || '').toLowerCase();
  return dest === 'document' || dest === 'iframe' || (!dest && String(headers.accept || '').includes('text/html'));
}

function renderWakingPage({ wakeUrl = null } = {}) {
  // JSON-encoded into the script: a string literal, never markup.
  const wake = JSON.stringify(wakeUrl || '').replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Waking this preview…</title>
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
  .wrap { padding: 32px 16px; max-width: 26rem; }
  .spinner {
    width: 40px; height: 40px; margin: 0 auto 20px;
    border: 3px solid rgba(124, 58, 237, 0.25);
    border-top-color: #7c3aed; border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }
  h1 { font-size: 1.15rem; margin: 0 0 8px; font-weight: 600; }
  p { margin: 0; font-size: 0.95rem; opacity: 0.75; line-height: 1.5; }
</style>
</head>
<body>
  <div class="wrap" data-usernode-waking="1">
    <div class="spinner" aria-hidden="true"></div>
    <h1 id="title">Waking this preview…</h1>
    <p id="msg" role="status">Nobody had opened it for a while, so it was asleep. It usually takes 10 to 30 seconds to wake, and this page opens it when it is ready.</p>
  </div>
<script>
(function () {
  var WAKE_URL = ${wake};
  var POLL_MS = ${POLL_MS};
  var ASK_AGAIN_MS = ${ASK_AGAIN_MS};
  var ESCALATE_MS = ${ESCALATE_AFTER_MS};
  var startedAt = Date.now();
  var askedAt = 0;
  var escalated = false;

  // Ask the platform to wake it. Sent, not read: no-cors.
  function ask() {
    askedAt = Date.now();
    if (!WAKE_URL) return;
    try { fetch(WAKE_URL, { method: 'POST', mode: 'no-cors', cache: 'no-store', keepalive: true }).catch(function () {}); }
    catch (e) { /* the poll below still reloads once it is up */ }
  }

  // Its own address answers 503 while it sleeps (this page, or the
  // platform's JSON for a fetch). Anything else is the app.
  function tick() {
    if (Date.now() - askedAt > ASK_AGAIN_MS) ask();
    fetch(window.location.href, { cache: 'no-store', credentials: 'include' })
      .then(function (res) {
        if (res.status < 500) { window.location.reload(); return; }
        schedule();
      })
      .catch(schedule);
  }

  function schedule() {
    if (!escalated && Date.now() - startedAt > ESCALATE_MS) {
      escalated = true;
      document.getElementById('title').textContent = 'Still waking this preview';
      document.getElementById('msg').textContent =
        'It is taking longer than usual. This page keeps trying and opens it as soon as it answers.';
    }
    setTimeout(tick, escalated ? 10000 : POLL_MS);
  }

  ask();
  setTimeout(tick, POLL_MS);
})();
</script>
</body>
</html>`;
}

module.exports = {
  WAKE_PATH, ESCALATE_AFTER_MS, POLL_MS, ASK_AGAIN_MS,
  previewHost, wakeUrlFor, wantsDocument, renderWakingPage,
};
