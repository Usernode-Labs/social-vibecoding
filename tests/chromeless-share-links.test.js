// Tests for the chromeless share-link flow (#app/<slug>/full).
//
// Direct visits to an app's own subdomain used to dead-end on the app
// container's 401 ("Not authenticated") because the iframe token only
// exists inside the platform shell. The fix spans four layers; the edge
// gate's redirect is covered behaviorally in tests/edge-gate.test.js.
// This file guards the other three plus the shell wiring:
//   1. The scaffold template's generated server.js redirects
//      unauthenticated top-level document navigations to the platform's
//      chromeless view (real generated output, not source grep).
//   2. login.html / register.html preserve the URL fragment through the
//      post-auth redirect (and across the login ↔ register hop), so the
//      deep link survives sign-in.
//   3. The shell (public/js/app.js + index.html) understands the
//      #app/<slug>/full route: source guards in the style of
//      tests/cc-progress-summary.test.js so the hash routing, the
//      chrome toggling, and the pill can't silently become dead code.
//   4. The Caddyfile's wildcard site carries the 401-interception
//      redirect ({applink} map output + handle_response).
//
// Run with: node --test tests/chromeless-share-links.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getTemplateFiles } = require('../src/services/template.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── 1. Scaffold template ────────────────────────────────────────────────

test('scaffold server.js redirects unauthenticated document navigations to the chromeless view', () => {
  const files = getTemplateFiles('Demo App', 'demo-app-abc123', 'postgres://x', 's');
  const server = files.find((f) => f.path === 'server.js').content;
  assert.ok(
    server.includes("req.get('sec-fetch-dest') === 'document'"),
    'gates the redirect on Sec-Fetch-Dest: document'
  );
  assert.match(
    server,
    /res\.redirect\(302, 'https:\/\/[^']+\/#app\/demo-app-abc123\/full' \+ deepPath\)/,
    'redirects to the platform chromeless deep link for this slug, carrying the inner path'
  );
  // The redirect must live INSIDE the unauthenticated branch, before the
  // landing-page fallback (iframe loads must keep getting the 401 page,
  // never a redirect that would nest the shell inside its own iframe).
  const unauthBranch = server.indexOf('if (!req.user) {');
  const redirect = server.indexOf("req.get('sec-fetch-dest')");
  const landing = server.indexOf('Open this app inside Usernode');
  assert.ok(unauthBranch !== -1 && unauthBranch < redirect && redirect < landing,
    'redirect sits between the auth check and the landing-page fallback');
});

test('scaffold server.js derives ?path= from req.originalUrl behind the character gate (#743)', () => {
  const files = getTemplateFiles('Demo App', 'demo-app-abc123', 'postgres://x', 's');
  const server = files.find((f) => f.path === 'server.js').content;
  assert.ok(server.includes("'?path=' + req.originalUrl"),
    'forwards the visited path+query verbatim as the final fragment param');
  // The gate keeps the value attribute-safe for the landing anchor and
  // relative-only (leading /, no quotes/angle brackets/backslash/space).
  assert.ok(server.includes('/^\\/[A-Za-z0-9\\-._~!$&()*+,;=:@\\/%?]*$/.test(req.originalUrl)'),
    'character allowlist gates the deep path');
  const deepPath = server.indexOf('const deepPath =');
  const unauthBranch = server.indexOf('if (!req.user) {');
  const redirect = server.indexOf("req.get('sec-fetch-dest')");
  assert.ok(unauthBranch < deepPath && deepPath < redirect,
    'deepPath is computed inside the unauthenticated branch, before the redirect');
  // The generated code must be valid JS (the regex survives the
  // template-literal escaping in src/services/template.js).
  assert.doesNotThrow(() => new Function(server), 'generated server.js parses');
});

test('scaffold landing page deep-links to the app, not the bare platform origin', () => {
  const files = getTemplateFiles('Demo App', 'demo-app-abc123', 'postgres://x', 's');
  const server = files.find((f) => f.path === 'server.js').content;
  assert.match(server, /href="https:\/\/[^"]+\/#app\/demo-app-abc123\/full\$\{deepPath\}"/,
    'landing anchor carries the gated deep path too');
});

// ── 2. Login / register fragment preservation ───────────────────────────

test('login.html post-auth redirects all preserve the URL fragment', () => {
  const src = read('public/login.html');
  assert.ok(!src.includes("window.location.href = '/';"),
    'no bare go-home redirect remains');
  assert.ok(src.includes("window.location.href = '/' + window.location.hash;"),
    'hash-preserving redirect present');
});

test('register.html post-auth redirect preserves the URL fragment', () => {
  const src = read('public/register.html');
  assert.ok(!src.includes("window.location.href = '/';"));
  assert.ok(src.includes("window.location.href = '/' + window.location.hash;"));
});

test('login ↔ register cross-links carry the fragment', () => {
  const login = read('public/login.html');
  assert.ok(login.includes("registerAnchor.href = '/register.html' + window.location.hash;"));
  // Must run before the native-wallet early return or web browsers never
  // execute it.
  assert.ok(
    login.indexOf('registerAnchor.href') < login.indexOf('if (!isNative) return;'),
    'register-link carry runs before the !isNative early return'
  );
  const register = read('public/register.html');
  assert.ok(register.includes("loginLink.href = '/login.html' + window.location.hash;"));
});

// ── 3. Shell wiring (source guards) ─────────────────────────────────────

test('app.js routes #app/<slug>/full onto the App tab in chromeless mode', () => {
  const src = read('public/js/app.js');
  assert.ok(src.includes("const chromeless = tab === 'full';"),
    'restoreFromHash recognizes the full segment');
  assert.ok(src.includes('App.setChromeless(chromeless);'),
    'restoreFromHash applies the mode on app routes');
  assert.ok(src.includes('App.setChromeless(false)'),
    'non-app routes clear the mode');
});

test('app.js updateHash round-trips the chromeless hash, inner path included', () => {
  const src = read('public/js/app.js');
  assert.ok(src.includes('? `#app/${App.currentApp}/full${innerPath ? `?path=${innerPath}` : \'\'}`'),
    'updateHash emits /full while chromeless and re-emits the ?path deep link');
});

// ── 5. Inner-path pass-through (#743) ────────────────────────────────────

test('app.js splits the fragment-query off before segment routing', () => {
  const src = read('public/js/app.js');
  assert.ok(src.includes("const qIdx = rawHash.indexOf('?');"),
    'restoreFromHash finds the fragment-query boundary');
  assert.ok(src.includes('const hash = qIdx === -1 ? rawHash : rawHash.slice(0, qIdx);'),
    'routes on the query-stripped hash — plain #app/<slug>/full is unchanged');
  // The value is everything after the first path= (final-param contract,
  // so an inner query string survives raw & / = / ?).
  assert.ok(src.includes('fragQuery.match(/(?:^|&)path=(.*)$/)'),
    'path value is the raw tail of the fragment query');
  assert.ok(src.includes('if (chromeless && fragQuery) {'),
    'the fragment-query is honored on the chromeless route only');
});

test('app.js validates the inner path (relative-only, attribute-safe, capped)', () => {
  const src = read('public/js/app.js');
  assert.ok(src.includes('_validateInnerPath(p)'), 'validator exists');
  assert.ok(src.includes("if (!path.startsWith('/') || path.startsWith('//')) return null;"),
    'relative-only: leading /, never protocol-relative //');
  assert.ok(src.includes('/[\\s\\\\`\'"<>]/.test(path)'),
    'rejects whitespace, backslash, backtick, quotes and angle brackets');
  assert.ok(src.includes('path.length > 512'), 'length cap matches TESTING_PATH_MAX');
  assert.ok(src.includes('/[\\x00-\\x1f\\x7f]/.test(path)'), 'rejects control characters');
});

test('app-view.js builds the iframe src via the URL API with origin check and token clobbering', () => {
  const src = read('public/js/app-view.js');
  assert.ok(src.includes('buildAppIframeSrc()'), 'shared builder exists');
  assert.ok(src.includes("new URL(AppView.pendingInnerPath || '/', appUrl)"),
    'inner path composes against the app origin; no path → root (backward compat)');
  assert.ok(src.includes('if (url.origin !== new URL(appUrl).origin) url = new URL(appUrl);'),
    'a path that escapes the app origin falls back to the root');
  assert.ok(src.includes("url.searchParams.set('token', token)"),
    'token is set via searchParams so a smuggled ?token= is clobbered');
  // Tokens are per-app since the RSA cutover: the builder must read the
  // cached token through tokenForSlug, which returns null unless the
  // cached token was minted for the app now being framed. Otherwise a
  // stale token for the previously-open app rides along and the child
  // rejects it on audience.
  assert.ok(src.includes("const token = AppView.tokenForSlug(AppView.appData && AppView.appData.slug);"),
    'builder reads the token through the per-app slug guard');
  assert.ok(src.includes('const iframeSrc = AppView.buildAppIframeSrc();'),
    'renderAppTab uses the shared builder');
  // The 45-min token refresh must reuse it too, so a mid-session refresh
  // does not yank the viewer back to the app root.
  assert.ok(src.includes('iframe.src = AppView.buildAppIframeSrc();'),
    'token refresh reuses the shared builder');
  assert.ok(!src.includes('?token=${AppView.iframeToken}'),
    'no string-concat token src remains for the production iframe');
  assert.ok(src.includes('AppView.pendingInnerPath = null;'),
    'close() clears the stored inner path');
});

test('app.js screenIdOf treats ?path= as the same screen and re-dispatches on a changed path', () => {
  const src = read('public/js/app.js');
  assert.ok(src.includes(".replace(/^#/, '').split('?')[0].split('/')"),
    'screenIdOf strips the fragment-query before splitting');
  assert.ok(src.includes('(chromeless && innerPath !== prevInnerPath)'),
    'a chromeless hash with a different inner path forces a re-render');
});

test('app.js setChromeless toggles the header, tab bar and pill', () => {
  const src = read('public/js/app.js');
  assert.ok(src.includes("document.getElementById('platform-header')"));
  assert.ok(src.includes("document.getElementById('app-tabs')"));
  assert.ok(src.includes('_mountChromelessPill'));
  assert.ok(src.includes('_unmountChromelessPill'));
  // The pill's exit target is the regular App-tab view, which clears the
  // mode via restoreFromHash.
  assert.ok(src.includes('location.hash = `#app/${App.currentApp}/app`;'));
});

test('index.html carries the ids setChromeless toggles', () => {
  const html = read('public/index.html');
  assert.ok(html.includes('id="platform-header"'));
  assert.ok(html.includes('id="app-tabs"'));
});

test('login redirects out of the shell preserve the fragment', () => {
  const src = read('public/js/app.js');
  assert.ok(src.includes("window.location.href = '/login.html' + window.location.hash;"),
    'App.init keeps the deep link when bouncing an expired session to login');
  assert.ok(!src.includes("window.location.href = '/login.html';"),
    'no fragment-dropping login redirect remains in app.js');
});

// ── 4. Caddyfile 401 interception ───────────────────────────────────────

test('Caddyfile maps production hosts to a chromeless {applink} and intercepts 401s', () => {
  const caddy = read('Caddyfile');
  assert.ok(caddy.includes('map {host} {upstream} {applink}'),
    'map emits the applink output');
  assert.ok(caddy.includes('"https://{$USERNODE_DOMAIN}/#app/${1}/full"'),
    'production rows deep-link to the chromeless view');
  assert.match(caddy, /@unauth status 401/, 'response matcher on upstream 401');
  assert.match(caddy, /handle_response @unauth/, '401s route through handle_response');
  assert.match(caddy, /header Sec-Fetch-Dest document/, 'only document navigations redirect');
  assert.match(caddy, /not vars \{applink\} ""/, 'staging/default rows are excluded');
  assert.match(caddy, /redir @chromeless \{applink\}\?path=\{uri\} 302/,
    'redirects to the applink carrying the original request URI as the final ?path= param');
  assert.match(caddy, /copy_response/, 'non-matching 401s pass through verbatim');
});
