// Source pins for the landing page's persistent header + full app directory:
//   - the header CTA row offers exactly Sign in + Join waitlist (Create
//     account is deferred to the waitlist journey / gated-app taps), and
//     survives an app being open alongside Back + the app name,
//   - the waitlist explainer and form are always visible, not collapsed,
//   - #app-viewer is an in-flow flex sibling of the scroller and opens /
//     closes with the kit zoom transition (with the outEl the flex-sibling
//     measurement pitfall requires),
//   - the directory grid matches the authed homescreen's launcher shape,
//   - gated tiles dim, badge a lock, and route taps to #signup with the
//     app deep link remembered,
//   - the shell probe is wired at boot and its columns exist in schema,
//   - staging seeds one open + one gated tile so both branches render.
//
// These are content pins (same style as tests/chromeless-share-links
// .test.js): they hold the contract in place so a refactor that silently
// drops a piece fails loudly here.
//
// Run with: node --test tests/landing-directory.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ─── index.html: persistent header ────────────────────────────────

test('landing CTAs: Sign in + Join waitlist only — no Create account', () => {
  const html = read('public/index.html');
  const ctas = html.match(/id="landing-header-ctas"[\s\S]*?<\/div>/);
  assert.ok(ctas, 'landing-header-ctas block exists');
  assert.match(ctas[0], /href="#login"/);
  assert.match(ctas[0], /id="landing-waitlist-cta"/);
  assert.doesNotMatch(ctas[0], /Create account/);
  assert.doesNotMatch(ctas[0], /href="#signup"/);
});

test('the landing header is a persistent, non-scrolling sibling of the scroller', () => {
  const html = read('public/index.html');
  const header = html.match(/id="landing-header"[^>]*class="([^"]*)"/);
  assert.ok(header, 'landing-header exists');
  // shrink-0 keeps the header out of the flex free-space split, so the
  // scroller (and, when open, the app viewer) take the remaining height.
  assert.match(header[1], /shrink-0/);
  // Notch/status-bar handling, same as the authed #platform-header.
  assert.match(header[1], /un-safe-top-extend/);
  // The overlay is a column so header + body stack instead of overlapping.
  const overlay = html.match(/id="auth-landing-screen"[^>]*class="([^"]*)"/);
  assert.ok(overlay, 'landing overlay exists');
  assert.match(overlay[1], /flex flex-col/);
  // Back + title live in the header, NOT in a viewer-owned bar: the header
  // is what stays put while an app is open.
  assert.match(html, /id="landing-back-btn"/);
  assert.match(html, /id="landing-header-title"/);
  assert.doesNotMatch(html, /id="app-viewer-back"/);
  assert.doesNotMatch(html, /id="app-viewer-title"/);
});

test('the header keeps Sign in / Join waitlist while an app is open', () => {
  const js = read('public/js/auth-screens.js');
  const fn = js.match(/_renderLandingHeader\(\)\s*\{[\s\S]*?\n    \},/);
  assert.ok(fn, '_renderLandingHeader exists');
  // Only Back and the title react to an app being open — the CTA row is
  // toggled by session state (signed-in → queue status), never by the viewer.
  assert.match(fn[0], /_openAppSlug/);
  assert.match(fn[0], /landing-back-btn/);
  assert.match(fn[0], /landing-header-title/);
  assert.match(fn[0], /landing-header-ctas/);
  assert.doesNotMatch(fn[0], /landing-header-ctas[\s\S]{0,120}_openAppSlug/);
  // AppBar mirroring for the Flutter WebView.
  assert.match(fn[0], /document\.title/);
});

test('the waitlist explainer + form are always visible on the landing page', () => {
  const html = read('public/index.html');
  const section = html.match(/id="landing-waitlist"[^>]*class="([^"]*)"/);
  assert.ok(section, 'landing-waitlist section exists');
  // No longer collapsed behind the CTA — the pitch and the email field are
  // part of the first paint.
  assert.doesNotMatch(section[1], /\bhidden\b/);
  assert.match(html, /id="waitlist-form"/);
  assert.match(html, /id="waitlist-email"/);
  // The header CTA now only closes any open app, scrolls to the form and
  // focuses it — it no longer un-hides anything.
  const js = read('public/js/auth-screens.js');
  const handler = js.match(/waitlistCta\.addEventListener\('click'[\s\S]*?\n      \}\);/);
  assert.ok(handler, 'waitlist CTA handler exists');
  assert.match(handler[0], /_closeLandingApp\(\)/);
  assert.match(handler[0], /scrollIntoView/);
  assert.match(handler[0], /focus\(/);
  assert.doesNotMatch(handler[0], /classList\.remove\('hidden'\)/);
});

// ─── index.html + auth-screens.js: in-flow app viewer ─────────────

test('#app-viewer is an in-flow flex sibling, not a stacked overlay', () => {
  const html = read('public/index.html');
  const viewer = html.match(/id="app-viewer"[^>]*class="([^"]*)"/);
  assert.ok(viewer, 'app-viewer exists');
  // Demoted from `fixed inset-0 z-50`: it now shares the overlay's column
  // with the header, so the header stays visible above an open app.
  assert.doesNotMatch(viewer[1], /\bfixed\b/);
  assert.doesNotMatch(viewer[1], /inset-0/);
  assert.match(viewer[1], /flex-1/);
  assert.match(viewer[1], /min-h-0/);
  // Opaque background — the zoom pins it as a live overlay mid-flight.
  assert.match(viewer[1], /bg-white/);
});

test('landing app open/close use the kit zoom with the flex-sibling outEl', () => {
  const js = read('public/js/auth-screens.js');
  assert.match(js, /type: 'zoom-in'/);
  assert.match(js, /type: 'zoom-out'/);
  // fromEl is the tapped tile, scoped to the landing grid.
  assert.match(js, /_landingTileFor/);
  assert.match(js, /#landing-apps \.app-card\[data-slug=/);
  // #764: two visible flex:1 siblings split the height 50/50, so the kit's
  // synchronous pre-paint measurement needs the outgoing element handed to
  // it explicitly.
  assert.match(js, /outEl: scroller/);
  // Leaving a LIVE iframe must not take a View-Transition snapshot (iOS
  // Safari flash) — mirrors App.navigateHome.
  assert.match(js, /fallback: 'none'/);
  // The no-kit path has to run BOTH halves of the split mutation.
  assert.match(js, /function zoomFx/);
  assert.match(js, /opts\.after === 'function'/);
});

test('leaving the landing screen tears the viewer down instead of stranding it', () => {
  const js = read('public/js/auth-screens.js');
  assert.match(js, /_resetLandingViewer/);
  // The live iframe is dropped, not just hidden.
  assert.match(js, /frame\.src = 'about:blank'/);
  // OS/browser back closes the viewer via a history marker, so the hash
  // router is never disturbed.
  assert.match(js, /svAnonAppViewer/);
  assert.match(js, /addEventListener\('popstate'/);
});

test('App._tileFor is scoped to the authed grid', () => {
  // Both grids render `.app-card[data-slug]` and after a reload-free login
  // they share one document — an unscoped lookup could zoom from the wrong
  // tile.
  const js = read('public/js/app.js');
  assert.match(js, /#app-list \.app-card\[data-slug=/);
});

test('public apps list is sorted by usage (active users first)', () => {
  const src = read('src/routes/public-api.js');
  assert.match(src, /ORDER BY COALESCE\(au\.cnt, 0\) DESC/);
});

test('landing scroller has kit pull-to-refresh with overscroll containment', () => {
  const js = read('public/js/auth-screens.js');
  // PTR must attach to the INNER scroller, never the fixed overlay: the
  // kit's rubber-band translateY on the overlay itself slides the whole
  // opaque screen down and exposes the authed shell's header behind it.
  assert.match(js, /PlatformUI\.pullToRefresh\(byId\('auth-landing-scroll'\)/);
  assert.doesNotMatch(js, /pullToRefresh\(byId\('auth-landing-screen'\)/);
  assert.match(js, /_loadLandingApps\(\)\)/);
  // Containment keeps the browser's native pull-refresh from competing
  // with the kit gesture — same treatment as #home-screen.
  const css = read('public/css/app.css');
  const block = css.match(/#home-screen,\s*#auth-landing-scroll \{[^}]*\}/);
  assert.ok(block, 'shared containment block exists');
  assert.match(block[0], /overscroll-behavior-y: contain/);
});

test('the landing overlay keeps its own scroll wrapper (pull-down backstop)', () => {
  const html = read('public/index.html');
  // The overlay itself must NOT be the scroller...
  const overlay = html.match(/id="auth-landing-screen"[^>]*class="([^"]*)"/);
  assert.ok(overlay, 'landing overlay exists');
  assert.doesNotMatch(overlay[1], /overflow-y-auto/);
  // ...the inner wrapper is, filling the overlay's height.
  const scroller = html.match(/id="auth-landing-scroll"[^>]*class="([^"]*)"/);
  assert.ok(scroller, 'inner landing scroller exists');
  assert.match(scroller[1], /overflow-y-auto/);
  // Fills what the header leaves, rather than the whole overlay: h-full
  // under a column flex parent would overflow past the header.
  assert.match(scroller[1], /flex-1/);
  assert.match(scroller[1], /min-h-0/);
});

// ─── index.html: directory grid ───────────────────────────────────

test('landing directory uses the homescreen launcher-grid shape', () => {
  const html = read('public/index.html');
  const grid = html.match(/id="landing-apps"[^>]*class="([^"]*)"/);
  assert.ok(grid, 'landing-apps grid exists');
  // Same column progression as the authed #app-list grid.
  assert.match(grid[1], /grid-cols-2/);
  assert.match(grid[1], /md:grid-cols-3/);
});

// ─── auth-screens.js: tile renderer ───────────────────────────────

test('landing tiles mirror home cards and gate on requires_login', () => {
  const js = read('public/js/auth-screens.js');
  assert.match(js, /_buildLandingAppTile/);
  // Gated presentation: dimmed + lock + caption.
  assert.match(js, /opacity-50 grayscale/);
  assert.match(js, /Account required/);
  // Gated tap: remember the app deep link, then the signup flow.
  assert.match(js, /rememberDeepLink\('#app\/' \+ \(app\.slug \|\| ''\)\)/);
  assert.match(js, /location\.hash = '#signup'/);
  // Icon priority mirrors home.js iconTileFor: image > emoji > letter.
  assert.match(js, /data-icon', 'image'/);
  assert.match(js, /data-icon', 'emoji'/);
  assert.match(js, /data-icon', 'letter'/);
});

// ─── probe wiring ─────────────────────────────────────────────────

test('shell probe starts at boot and its columns are in schema', () => {
  assert.match(read('server.js'), /shell-probe'\)\.start\(config\)/);
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ADD COLUMN IF NOT EXISTS anon_shell VARCHAR\(10\) NOT NULL DEFAULT 'unknown'/);
  assert.match(schema, /ADD COLUMN IF NOT EXISTS anon_shell_checked_at TIMESTAMPTZ/);
});

// ─── public API contract ──────────────────────────────────────────

test('public apps API exposes the home-card fields the landing consumes', () => {
  const src = read('src/routes/public-api.js');
  for (const field of ['icon_emoji', 'icon_url', 'active_users', 'requires_login']) {
    assert.match(src, new RegExp(field), `public-api carries ${field}`);
  }
  // Fail-safe mapping: only a positive 'public' classification is open.
  assert.match(src, /a\.anon_shell !== 'public'/);
});

// ─── staging seed ─────────────────────────────────────────────────

test('staging seeds one open + one gated landing tile', () => {
  const src = read('src/db/migrate.js');
  assert.match(src, /async function seedStagingLandingDirectory\(pool\)/);
  assert.match(src, /await seedStagingLandingDirectory\(pool\);/);
  // Staging-only, like every other mock-data seed.
  const fn = src.match(/async function seedStagingLandingDirectory\(pool\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'seed body found');
  assert.match(fn[0], /process\.env\.USERNODE_ENV !== 'staging'/);
  // Both branches of requires_login are represented.
  assert.match(fn[0], /'staging-landing-open'/);
  assert.match(fn[0], /'staging-landing-gated'/);
  // The shell probe re-checks running public apps whose stamp is stale, and
  // these fixtures have no container — a NOW() stamp would flip the open
  // tile to 'unknown' (→ gated) inside one 5-minute sweep.
  assert.match(fn[0], /anon_shell_checked_at = NOW\(\) \+ INTERVAL '1 year'/);
  // Idempotent on the every-boot re-run path.
  assert.match(fn[0], /ON CONFLICT DO NOTHING/);
  // Nonzero active-users badge on the open tile.
  assert.match(fn[0], /INSERT INTO app_activity/);
});
