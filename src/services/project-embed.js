'use strict';

// A public project inside a post on X: the page X frames.
//
// X draws a link whose page says `twitter:card` "player" as a frame inside
// the post itself, around whatever https page `twitter:player` names, with
// no approval of any kind. That is how a block game ended up playable in a
// post in October 2026 (Tweetcraft). So the shared link of a public project
// somebody with no account can use (`/app/<slug>`,
// services/project-preview.js) names this page as its player, and whoever
// scrolls past the post uses the project right there, as the guest they
// would be at its own address (services/edge-gate.js, "Guests (P15)"):
//
//   embedFor(app)         whether a project may be shown in a post, and the
//                         token its frame carries; null when it may not.
//   embedPage(...)        the page: the project's name and Join on a slim
//                         bar, the app under it, and the Join sheet the
//                         bridge asks for when the app answers a guest with
//                         account_required.
//   embedHeaders(...)     its headers: framed by X alone, holding the app's
//                         own address and nothing else.
//
// Nobody is signed in here. Inside a post the page is a frame on x.com, and
// a browser keeps a frame on another site apart from Homeroom's own sign-in,
// so everybody is a guest and every way in opens Homeroom in a tab of its
// own.

const crypto = require('crypto');
const platformJwt = require('./platform-jwt');
const appPermissions = require('./app-permissions');

// The frame's size in the post. Square, as the posts that made this a thing
// were; X scales it to the post's width.
const PLAYER_WIDTH = 480;
const PLAYER_HEIGHT = 480;

// Who may frame the page: X, at every address it serves posts from, and the
// page itself. Nothing else, so the page is not a way to put a project in
// somebody else's site under Homeroom's name.
const FRAME_ANCESTORS = ["'self'", 'https://x.com', 'https://*.x.com', 'https://twitter.com', 'https://*.twitter.com'];

// The query parameter that tells the app's bridge it is in this page, so it
// hands account prompts up to the page instead of drawing its own sheet
// (public/usernode-bridge/v1/bridge.js, the guest block).
const EMBED_PARAM = 'un-embed';

// The app frame's sandbox: the App tab's own (frontend/src/features/
// app-frame/app-frame-policy.js APP_FRAME_SANDBOX).
const FRAME_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock allow-downloads';

function embedPath(slug) { return `/embed/${encodeURIComponent(slug)}`; }

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function originOf(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch { return null; }
}

/**
 * Whether a project from the public directory (public-app-directory.js
 * shapeApp) may be shown in a post, and how its frame signs in:
 *   { token: null }      it needs no credential at all, as its probe saw it;
 *   { token: '<guest>' } it answers a guest's token, so its frame carries one;
 *   null                 nobody with no account can use it, or it needs a
 *                        guest token and none can be signed (a staging copy
 *                        has no guest key).
 * `sign: false` answers the question without signing anything.
 */
function embedFor(app, { sign = true } = {}) {
  if (!app || !app.guest_ready || !originOf(app.url)) return null;
  if (!app.requires_login) return { token: null };
  const appId = Number(app.id);
  if (!Number.isInteger(appId) || appId <= 0 || !platformJwt.guestPublicKeyPem()) return null;
  if (!sign) return { token: '' };
  try {
    return { token: platformJwt.signGuestToken({ appId }) };
  } catch {
    return null;
  }
}

/** The app's own address, as the page frames it. */
function frameSrc(app, token) {
  const u = new URL(app.url);
  if (token) u.searchParams.set('token', token);
  u.searchParams.set(EMBED_PARAM, '1');
  return u.toString();
}

const STYLE = [
  ':root{color-scheme:light dark;--bg:#fff;--ink:#1c1c1e;--muted:#68686c;--line:#e3e3e6;--tile:#eaeaea;--accent:#0a6ee0;--on-accent:#fff;--quiet:#f5f5f7}',
  '@media (prefers-color-scheme: dark){:root{--bg:#1c1c1e;--ink:#f5f5f7;--muted:#8e8e93;--line:#3a3a3c;--tile:#2c2c2e;--quiet:#2c2c2e}}',
  '*{box-sizing:border-box}',
  '[hidden]{display:none!important}',
  'html,body{height:100%;margin:0}',
  'body{display:flex;flex-direction:column;background:var(--bg);color:var(--ink);font:15px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
  '.bar{flex:none;display:flex;align-items:center;gap:10px;height:48px;padding:0 8px 0 10px;border-bottom:1px solid var(--line)}',
  '.who{flex:1;min-width:0;display:flex;align-items:center;gap:10px;color:inherit;text-decoration:none}',
  '.icon{flex:none;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:var(--tile);overflow:hidden;font-size:18px;font-weight:650}',
  '.icon img{width:100%;height:100%;object-fit:cover}',
  '.name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650}',
  '.by{flex:none;color:var(--muted);font-size:13px}',
  '.join{flex:none;display:inline-flex;align-items:center;min-height:34px;padding:0 16px;border-radius:999px;background:var(--accent);color:var(--on-accent);font-weight:650;text-decoration:none}',
  '.app{flex:1;width:100%;min-height:0;border:0;display:block;background:var(--bg)}',
  '.scrim{position:fixed;inset:0;background:rgba(0,0,0,0.32)}',
  '.sheet{position:fixed;left:0;right:0;bottom:0;margin:0 auto;max-width:480px;padding:20px;border-radius:20px 20px 0 0;background:var(--bg);color:var(--ink);box-shadow:0 -10px 30px rgba(0,0,0,0.2)}',
  '.sheet h2{margin:0 0 6px;font-size:19px;font-weight:700}',
  '.sheet p{margin:0 0 16px;color:var(--muted)}',
  '.btn{display:flex;align-items:center;justify-content:center;width:100%;min-height:48px;margin:0 0 8px;padding:0 16px;border:0;border-radius:999px;font:inherit;font-weight:650;text-decoration:none;cursor:pointer}',
  '.primary{background:var(--accent);color:var(--on-accent)}',
  '.secondary{background:transparent;color:var(--muted);margin-bottom:0}',
].join('\n');

// The page's one script: the Join sheet, opened when the app's bridge says a
// guest needs an account ({ __usernode_embed: 'account', action }), and only
// when the app's own frame says so.
const SCRIPT = `(function () {
  var body = document.body;
  var frame = document.getElementById('app');
  var scrim = document.getElementById('join-scrim');
  var sheet = document.getElementById('join-sheet');
  var title = document.getElementById('join-title');
  var appOrigin = body.getAttribute('data-app-origin');
  var name = body.getAttribute('data-name');
  function close() { sheet.hidden = true; scrim.hidden = true; }
  function open(action) {
    title.textContent = action ? 'Make an account to ' + action : 'Make an account to join ' + name;
    scrim.hidden = false;
    sheet.hidden = false;
    document.getElementById('join-go').focus();
  }
  window.addEventListener('message', function (e) {
    if (!frame || e.source !== frame.contentWindow || e.origin !== appOrigin) return;
    var data = e.data;
    if (!data || data.__usernode_embed !== 'account') return;
    var action = typeof data.action === 'string' ? data.action.replace(/\\s+/g, ' ').trim() : '';
    open(action && action.length <= 60 ? action : null);
  });
  document.getElementById('join-keep').addEventListener('click', close);
  document.getElementById('join-go').addEventListener('click', close);
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
})();`;

const hashOf = (text) => `'sha256-${crypto.createHash('sha256').update(text).digest('base64')}'`;
const STYLE_HASH = hashOf(STYLE);
const SCRIPT_HASH = hashOf(SCRIPT);

/** The project's picture on the bar: its icon, else its emoji, else its initial. */
function iconHtml(app, origin) {
  if (app.icon_url) return `<img src="${escapeHtml(origin + app.icon_url)}" alt="">`;
  const glyph = app.icon_emoji || String(app.name || app.slug || '?').trim().charAt(0).toUpperCase() || '?';
  return escapeHtml(glyph);
}

/**
 * The page X frames. `origin` is the platform's; `token` the frame's own
 * (embedFor). Every word a project chose is text, never markup.
 */
function embedPage(app, origin, token) {
  const name = app.name || app.slug;
  const page = `${origin}/app/${encodeURIComponent(app.slug)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(name)} · Homeroom</title>
<style>${STYLE}</style>
</head>
<body data-app-origin="${escapeHtml(originOf(app.url))}" data-name="${escapeHtml(name)}">
<header class="bar">
<a class="who" href="${escapeHtml(page)}" target="_blank" rel="noopener">
<span class="icon">${iconHtml(app, origin)}</span>
<span class="name">${escapeHtml(name)}</span>
<span class="by">on Homeroom</span>
</a>
<a class="join" id="join" href="${escapeHtml(page)}" target="_blank" rel="noopener">Join</a>
</header>
<iframe class="app" id="app" src="${escapeHtml(frameSrc(app, token))}" title="${escapeHtml(name)}" sandbox="${FRAME_SANDBOX}" allow="${escapeHtml(appPermissions.allowAttribute([]))}"></iframe>
<div class="scrim" id="join-scrim" hidden></div>
<div class="sheet" id="join-sheet" role="dialog" aria-modal="true" aria-labelledby="join-title" hidden>
<h2 id="join-title">Make an account to join ${escapeHtml(name)}</h2>
<p>${escapeHtml(name)} is on Homeroom, where the people who use it make it together.</p>
<a class="btn primary" id="join-go" href="${escapeHtml(page)}" target="_blank" rel="noopener">Join on Homeroom</a>
<button class="btn secondary" id="join-keep" type="button">Keep looking around</button>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** What a post shows for a project it may not show: a line and a way to Homeroom. */
function refusedPage(origin) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Homeroom</title>
<style>${STYLE}</style>
</head>
<body>
<div class="sheet" role="status">
<h2>This project can't be shown here</h2>
<p>It's on Homeroom, where the people who use a project make it together.</p>
<a class="btn primary" href="${escapeHtml(origin || '')}/" target="_blank" rel="noopener">Open Homeroom</a>
</div>
</body>
</html>
`;
}

/** The page's headers. `appUrl` is the one address it may frame, if any. */
function embedHeaders(appUrl) {
  const frame = originOf(appUrl);
  const csp = [
    "default-src 'none'",
    `style-src ${STYLE_HASH}`,
    `script-src ${SCRIPT_HASH}`,
    "img-src 'self' data:",
    frame ? `frame-src ${frame}` : null,
    `frame-ancestors ${FRAME_ANCESTORS.join(' ')}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].filter(Boolean).join('; ');
  return {
    'Content-Security-Policy': csp,
    // Every load signs a fresh guest token into the page: never kept.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex',
  };
}

module.exports = {
  embedFor,
  embedPage,
  refusedPage,
  embedHeaders,
  embedPath,
  frameSrc,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  FRAME_ANCESTORS,
  FRAME_SANDBOX,
  EMBED_PARAM,
  SCRIPT,
  STYLE,
};
