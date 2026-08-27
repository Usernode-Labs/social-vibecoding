// Source pins for the landing page's persistent header + full app directory:
//   - the header CTA row offers exactly Sign in + Join waitlist (Create
//     account is deferred to the waitlist journey / gated-app taps), and
//     survives an app being open alongside Back + the app name,
//   - the landing CTA area is a compact pitch + ONE link into the
//     dedicated #waitlist screen, and the survey itself lives on that
//     screen (reachable to shots via ?shot=anon),
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

// The landing screen crossed over to React in #1080 chunk C, so the pins that
// used to read public/js/auth-screens.js read the component instead. Same
// contracts, same behaviour — a different file owns them.
const LANDING_TSX = 'frontend/src/features/auth/landing.tsx';
const WAITLIST_TSX = 'frontend/src/features/auth/waitlist.tsx';

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
  const tsx = read(LANDING_TSX);
  // Only Back and the title react to an app being open — the CTA row is
  // toggled by session state (signed-in → queue status), never by the viewer.
  const back = tsx.slice(tsx.indexOf('id="landing-back-btn"'));
  assert.match(back.slice(0, 400), /hiddenLast\(\s*\n?\s*!openApp/,
    'the back button is what the open app toggles');
  assert.match(tsx, /const headerTitle = openApp \?/);
  assert.match(tsx, /id="landing-header-ctas" className=\{hiddenLast\(session,/,
    'the CTA row is toggled by session state, not by the viewer');
  assert.match(tsx, /id="landing-back-to-waiting" className=\{session \?/);
  // AppBar mirroring for the Flutter WebView.
  assert.match(tsx, /document\.title = headerTitle/);
});

// ─── the landing CTA area vs the #waitlist screen ─────────────────

test('the landing CTA area is a compact CTA + link, and carries no form', () => {
  const html = read('public/index.html');
  const section = html.match(/id="landing-waitlist"[\s\S]*?<\/section>/);
  assert.ok(section, 'landing-waitlist section exists');
  const classes = html.match(/id="landing-waitlist"[^>]*class="([^"]*)"/);
  // Visible on first paint — it's the pitch, not something behind a toggle.
  assert.doesNotMatch(classes[1], /\bhidden\b/);
  // One link into the dedicated screen…
  assert.match(section[0], /id="landing-waitlist-link"[^>]*href="#waitlist"/);
  // …and none of the survey: a four-question form flat on the homepage
  // buried the app directory under it.
  assert.doesNotMatch(section[0], /<form/);
  assert.doesNotMatch(section[0], /id="waitlist-email"/);
  // The queued line still swaps in for a waiting-room session.
  assert.match(section[0], /id="landing-cta-queued"/);
});

test('the header CTA is an anchor to #waitlist, not a scroll-to-form', () => {
  const html = read('public/index.html');
  const cta = html.match(/<a[^>]*id="landing-waitlist-cta"[^>]*>/);
  assert.ok(cta, 'landing-waitlist-cta is an anchor');
  assert.match(cta[0], /href="#waitlist"/);
  const tsx = read(LANDING_TSX);
  // Every CTA that leaves the landing screen tears the viewer down first —
  // nothing scrolls or focuses on the landing page any more.
  for (const id of ['landing-signin-cta', 'landing-waitlist-cta', 'landing-waitlist-link']) {
    const tag = tsx.slice(tsx.indexOf(`id="${id}"`));
    assert.match(tag.slice(0, 600), /onClick=\{onLeaveCta\}/, `${id} leaves via onLeaveCta`);
  }
  assert.match(tsx, /const onLeaveCta[\s\S]{0,200}resetViewer\(\)/);
  assert.doesNotMatch(tsx, /scrollIntoView/);
});

test('the stage-1 survey lives on its own #waitlist screen', () => {
  const html = read('public/index.html');
  // Not anchored on indentation: public/index.html is generated from
  // frontend/src/Shell.tsx now and ships without the hand-written line
  // breaks. <main> cannot nest, so the first close tag is this screen's.
  const screen = html.match(/id="auth-waitlist-screen"[\s\S]*?<\/main>/);
  assert.ok(screen, 'auth-waitlist-screen exists');
  const classes = html.match(/id="auth-waitlist-screen"[^>]*class="([^"]*)"/);
  // Same overlay shape as the other anonymous screens (#more, #login).
  for (const cls of ['hidden', 'fixed', 'inset-0', 'z-40', 'overflow-y-auto']) {
    assert.match(classes[1], new RegExp(cls.replace('-', '\\-')), `screen is ${cls}`);
  }
  // The whole survey moved here, ids intact so the wiring is a pure move.
  //
  // #waitlist-made-url is deliberately NOT in this list any more. It was a
  // REQUIRED stage-1 field, which contradicted the email-only join the
  // onboarding doc settled on, so the question moved to the stage-2
  // "Want in sooner?" form as #more-made-url (recorded in RETIRED_IDS /
  // ADDED_IDS in tests/shell-id-inventory.test.js). Joining asks for an
  // address and nothing else; everything below is still on this screen.
  for (const id of ['waitlist-form', 'waitlist-email',
    'waitlist-country', 'waitlist-discovery-chips', 'waitlist-submit',
    'waitlist-msg', 'waitlist-joined', 'waitlist-more-offer',
    'waitlist-more-link', 'waitlist-queued']) {
    assert.match(screen[0], new RegExp(`id="${id}"`), `${id} is on the screen`);
  }
  // Back goes to the landing page via the shared delegated handler.
  assert.match(screen[0], /data-auth-back/);
  // NOT a <header>: the header-layout code used to measure document.querySelector
  // ('header') and must keep resolving to #platform-header.
  assert.doesNotMatch(screen[0], /<header/);
});

test('#waitlist is a registered route ordered under landing, above #more', () => {
  const js = read('public/js/auth-screens.js');
  assert.match(js, /waitlist: 'auth-waitlist-screen'/);
  const depth = js.match(/const DEPTH = \{[\s\S]*?\};/);
  assert.ok(depth, 'DEPTH map exists');
  // landing(0) → waitlist(1) → more(2): push in, pop back out.
  assert.match(depth[0], /landing: 0/);
  assert.match(depth[0], /waitlist: 1/);
  assert.match(depth[0], /more: 2/);
  // Per-show side effects + one-shot wiring are both dispatched.
  assert.match(js, /if \(route === 'waitlist'\) AuthScreens\._waitlistOnShow\(\);/);
  assert.match(js, /if \(id === 'auth-waitlist-screen'\) AuthScreens\._wireWaitlist\(\);/);
});

test('the waitlist screen swaps the form for the queued note on a session', () => {
  // Stage 1 is React since #1080 chunk C, so both branches are derived from
  // one piece of state rather than toggled onto two elements.
  const tsx0 = read(WAITLIST_TSX);
  const fn = tsx0.match(/const waitlistOnShow = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[/);
  assert.ok(fn, 'waitlistOnShow exists');
  // Same predicate the landing header uses — shared.ts's hasSession.
  assert.match(fn[0], /sessionExists\(\)/);
  assert.match(read('frontend/src/features/auth/shared.ts'),
    /export function hasSession\(\)[\s\S]*?legacy\(\)\.App\?\.user/);
  assert.match(tsx0, /id="waitlist-form"[\s\S]{0,200}hiddenLast\(hasSession \|\| joined/);
  assert.match(tsx0, /id="waitlist-queued"[\s\S]{0,200}hiddenFirst\(!hasSession/);
  // AppBar mirroring for the Flutter WebView, same as the landing header.
  assert.match(fn[0], /document\.title/);
  // The landing CTA block toggles its LINK now, not a form.
  const tsx = read(LANDING_TSX);
  assert.match(tsx, /id="landing-waitlist-link"/);
  assert.doesNotMatch(tsx, /waitlist-form/);
});

test('a gated (waiting-room) session can still reach #waitlist', () => {
  const js = read('public/js/app.js');
  const gated = js.match(/if \(App\.user\.hasPlatformAccess === false\) \{[\s\S]*?showWaiting\(\);/);
  assert.ok(gated, 'gated-session branch exists');
  assert.match(gated[0], /authRoute === 'waitlist'/);
  assert.match(gated[0], /AuthScreens\.show\('waitlist'\)/);
});

test('the anonymous screens are reachable to shots via ?shot=anon', () => {
  const js = read('public/js/app.js');
  // Captures carry a capture token, so the /me fetch would give them a full
  // session and restoreFromHash would strip the auth hash to home. The
  // override has to run BEFORE that fetch.
  const init = js.match(/async init\(\) \{[\s\S]*?\n  \},/);
  assert.ok(init, 'init exists');
  const shotAt = init[0].indexOf('_anonShot()');
  // The fetch itself moved into App._fetchSession when boot gained a
  // deadline (#1021); init calls it, and the ordering is what matters.
  const meAt = init[0].indexOf('_fetchSession()');
  assert.ok(shotAt > -1 && meAt > -1, 'both the shot check and the /me fetch are in init');
  assert.ok(shotAt < meAt, 'the shot override runs before the /me fetch');
  assert.match(js.match(/async _fetchSession\(\) \{[\s\S]*?\n  \},/)[0],
    /fetch\('\/api\/auth\/me'/);
  const fn = js.match(/_anonShot\(\) \{[\s\S]*?\n  \},/);
  assert.ok(fn, '_anonShot exists');
  assert.match(fn[0], /'anon'/);
  assert.match(fn[0], /'waitlist-joined'/);
  // Pure UI state: no env gate, and no request of its own.
  assert.doesNotMatch(fn[0], /USERNODE_ENV|fetch\(/);
  // The joined shot paints the success state client-side — it never POSTs.
  const tsx1 = read(WAITLIST_TSX);
  const shot = tsx1.match(/const shotJoined = shot === 'waitlist-joined';[\s\S]*?\n    \}/);
  assert.ok(shot, 'the waitlist-joined shot branch exists');
  assert.doesNotMatch(shot[0], /fetch\(/);
  // It shows the stage-2 offer with no token, so the link keeps the inert
  // prerendered href.
  assert.match(shot[0], /setOffer\(true\)/);
  assert.doesNotMatch(shot[0], /setMoreToken/);
  assert.match(tsx1, /id="waitlist-more-offer"[\s\S]{0,200}hiddenFirst\(\s*!offer/);
});

test('the stage-1 submit handler cannot be later than the first render', () => {
  // The imperative version wired the submit listener BEFORE awaiting the
  // options fetch on purpose: the email field is focused on arrival, so a
  // submit inside the fetch window would otherwise fall through to a native
  // GET navigation off the SPA. React removes the window rather than ordering
  // it — onSubmit is part of the element, and the options arrive in an effect
  // that cannot run before the render that attached it.
  const tsx = read(WAITLIST_TSX);
  assert.match(tsx, /id="waitlist-form"[\s\S]{0,200}onSubmit=\{onSubmit\}/);
  const submit = tsx.match(/const onSubmit = useCallback\([\s\S]*?\n    \[discovery\],\s*\n  \);/);
  assert.ok(submit, 'onSubmit exists');
  assert.match(submit[0], /e\.preventDefault\(\)/);
  assert.match(submit[0], /'\/api\/public\/waitlist'/);
  // The options really are effect-scoped, not fetched during render.
  const shared = read('frontend/src/features/auth/waitlist-shared.tsx');
  assert.match(shared, /export function useWaitlistOptions\(\)[\s\S]*?useEffect\(/);
});

// ─── index.html + landing.tsx: in-flow app viewer ─────────────────

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
  const tsx = read(LANDING_TSX);
  assert.match(tsx, /type: 'zoom-in'/);
  assert.match(tsx, /type: 'zoom-out'/);
  // fromEl is the tapped tile, scoped to the landing grid.
  assert.match(tsx, /landingTileFor/);
  assert.match(tsx, /#landing-apps \.app-card\[data-slug=/);
  // #764: two visible flex:1 siblings split the height 50/50, so the kit's
  // synchronous pre-paint measurement needs the outgoing element handed to
  // it explicitly.
  assert.match(tsx, /outEl: scroller/);
  // Leaving a LIVE iframe must not take a View-Transition snapshot (iOS
  // Safari flash) — mirrors App.navigateHome.
  assert.match(tsx, /fallback: 'none'/);
  // The no-kit path has to run BOTH halves of the split mutation.
  const shared = read('frontend/src/features/auth/shared.ts');
  assert.match(shared, /export function zoomFx/);
  assert.match(shared, /opts\.after === 'function'/);
});

test('leaving the landing screen tears the viewer down instead of stranding it', () => {
  const tsx = read(LANDING_TSX);
  // The router still calls the teardown on every route change off landing.
  assert.match(read('public/js/auth-screens.js'), /_resetLandingViewer\(\)/);
  assert.match(tsx, /_resetLandingViewer: \(\) => live\.current\.resetViewer\(\)/);
  // #1028: the live iframe is dropped by replacing the ELEMENT, not by
  // pointing it at about:blank — that assignment is a real navigation and
  // pushed an entry onto the history stack shared with the app.
  assert.match(tsx, /swapViewerFrame/);
  assert.match(tsx, /replaceChild\(fresh, old\)/);
  assert.doesNotMatch(tsx, /src = 'about:blank'/);
  // The replacement carries no src, so the next open is the initial
  // about:blank navigation browsers elide.
  assert.doesNotMatch(tsx, /fresh\.src\s*=/);
  // OS/browser back closes the viewer via a history marker, so the hash
  // router is never disturbed.
  assert.match(tsx, /svAnonAppViewer/);
  assert.match(tsx, /addEventListener\('popstate'/);
});

test('the guest back arrow closes the viewer directly (#1028)', () => {
  const tsx = read(LANDING_TSX);
  // The button performs the navigation; it never delegates to the browser
  // (the old `if (history.state...) history.back()` is what broke).
  const back = tsx.slice(tsx.indexOf('id="landing-back-btn"'));
  assert.match(back.slice(0, 500), /onClick=\{\(\) => live\.current\.closeLandingApp\(\)\}/);
  // The marker entry is unwound AFTER the close, behind a re-entrancy flag.
  assert.match(tsx, /unwindingViewerEntry/);
  // The popstate listener ignores a pop that lands ON the marker entry.
  assert.match(tsx, /if \(history\.state && history\.state\.svAnonAppViewer\) return;/);
  // The frame is re-resolved per use — a captured const goes stale on swap.
  assert.match(tsx, /byId<HTMLIFrameElement>\('app-viewer-frame'\)/);
});

test('?shot=anon-back scripts two guest open/back cycles', () => {
  const app = read('public/js/app.js');
  // Must skip /api/auth/me, or the check runner's own session promotes the
  // page into the signed-in shell and the guest viewer is never exercised.
  assert.match(app, /shot !== 'anon-back'/);
  const tsx = read(LANDING_TSX);
  assert.match(tsx, /runAnonBackShot/);
  // Two cycles: the bug only appears from the second open onward.
  assert.match(tsx, /cycle < 2/);
  // Every step of the script waits on DOM state, INCLUDING the first one:
  // `appsReady` settles when the fetch resolves, a tick before React commits
  // the tiles, so reading the grid straight after it found nothing to open
  // and the shot returned having stamped nothing at all.
  assert.match(tsx, /if \(!\(await until\(\(\) => !!landingTileFor\(target\.slug\), \d+\)\)\) return;/);
  // The completion stamp the dapp.json test asserts on.
  assert.match(tsx, /setAttribute\('data-anon-back', 'done'\)/);
  const manifest = JSON.parse(read('dapp.json'));
  const t = manifest.tests.find((x) => /anon-back/.test(x.path || ''));
  assert.ok(t, 'dapp.json declares the guest-back test');
  assert.match(t.expectSelector, /#app-viewer\.hidden\[data-anon-back="done"\]/);
  // The shot deliberately loads a real app in the viewer iframe, and the
  // staging fixture's own hostname isn't deployed — its 404 reaches the
  // runner's console listener. The behaviour is asserted by the selector;
  // console health on this screen is covered by the plain `?shot=anon#landing`
  // test, which opens no iframe.
  assert.equal(t.allowConsoleErrors, true);
  assert.ok(manifest.tests.some((x) => x.path === '/?shot=anon#landing'),
    'the console-clean landing test still exists');
  // Only the first 12 entries run (src/services/app-manifest readTests).
  assert.ok(manifest.tests.indexOf(t) < 12, 'inside the run window');
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
  const tsx = read(LANDING_TSX);
  // PTR must attach to the INNER scroller, never the fixed overlay: the
  // kit's rubber-band translateY on the overlay itself slides the whole
  // opaque screen down and exposes the authed shell's header behind it.
  assert.match(tsx, /pullToRefresh\(byId\('auth-landing-scroll'\)/);
  assert.doesNotMatch(tsx, /pullToRefresh\(byId\('auth-landing-screen'\)/);
  assert.match(tsx, /loadLandingApps\(\)\)/);
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

// ─── landing.tsx: tile renderer ────────────────────────────────────

test('landing tiles mirror home cards and gate on requires_login', () => {
  const tsx = read(LANDING_TSX);
  assert.match(tsx, /function LandingTile/);
  // Gated presentation: dimmed + lock + caption.
  assert.match(tsx, /opacity-50 grayscale/);
  assert.match(tsx, /Account required/);
  // Gated tap: remember the app deep link, then the signup flow.
  assert.match(tsx, /rememberDeepLink[\s\S]{0,160}'#app\/' \+ \(app\.slug \|\| ''\)/);
  assert.match(tsx, /location\.hash = '#signup'/);
  // Icon priority mirrors home.js iconTileFor: image > emoji > letter.
  assert.match(tsx, /data-icon="image"/);
  assert.match(tsx, /data-icon="emoji"/);
  assert.match(tsx, /data-icon="letter"/);
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
