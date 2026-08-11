// Cmd-click opens a navigation control in a new tab (#1036).
//
// The shell is a hash-routed SPA whose navigation chrome was built as
// <button>/<div> + a click handler that assigns location.hash. Every
// screen HAS an address, so the only thing standing between the user and
// "⌘-click the home icon to open home in a new tab" was the element tag.
//
// Two mechanisms now cover it, and both fail SILENTLY if they drift — a
// button quietly stops being an anchor, or a guard gets dropped and the
// handler preventDefaults a modified click again. So each strand is
// pinned against the shipped source, in the static-assertion style of
// tests/drawer-nav-motion.test.js (there is no DOM in this suite).
//
// Run with: node --test tests/nav-new-tab.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const navLinkJs = read('public/js/nav-link.js');
const html = read('public/index.html');
const swJs = read('public/js/../sw.js');
const appJs = read('public/js/app.js');
const appViewJs = read('public/js/app-view.js');
const browseJs = read('public/js/browse.js');
const devChatJs = read('public/js/dev-chat.js');
const homeJs = read('public/js/home.js');
const leaderboardJs = read('public/js/leaderboard.js');
const settingsJs = read('frontend/src/features/settings/settings.js');
const adminConsoleJs = read('frontend/src/features/admin/admin-console.js');
const dapp = JSON.parse(read('dapp.json'));

// The body of one method in the NavLink object literal.
function navLinkFn(signature) {
  const at = navLinkJs.indexOf(signature);
  assert.ok(at !== -1, `NavLink.${signature} went missing`);
  const end = navLinkJs.indexOf('\n    },', at);
  assert.ok(end !== -1, `could not find the end of NavLink.${signature}`);
  return navLinkJs.slice(at, end);
}

// The listener body registered on `anchor`, from the addEventListener
// call through the end of its callback.
function handlerAfter(src, anchor, span = 700) {
  const at = src.indexOf(anchor);
  assert.ok(at !== -1, `${anchor} went missing`);
  return src.slice(at, at + span);
}

// ── The shared module ──────────────────────────────────────────────────

test('NavLink ships and is exposed on window', () => {
  assert.match(navLinkJs, /window\.NavLink = NavLink;/,
    'every consumer resolves it off window — there is no module system here');
});

test('isNativeClick defers to the browser on every modified activation', () => {
  const fn = navLinkFn('isNativeClick(e) {');
  for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) {
    assert.ok(fn.includes(key),
      `${key} must be honoured — suppressing it means overriding a user gesture`);
  }
  assert.match(fn, /e\.button !== 0/,
    'a non-primary button (middle-click) is the browser\'s to handle');
  assert.match(fn, /defaultPrevented/,
    'an event another handler already claimed must not be re-claimed here');
  // ?shot= screenshot hooks fire synthetic .click()s, which carry no
  // `button` — treating those as non-primary would break every capture.
  assert.match(fn, /typeof e\.button === 'number'/,
    'a synthetic .click() has no button and must still read as a plain click');
});

test('isNewTabClick covers cmd/ctrl and the middle button', () => {
  const fn = navLinkFn('isNewTabClick(e) {');
  assert.match(fn, /e\.button === 1/, 'middle-click is the mouse-wheel new-tab gesture');
  assert.match(fn, /metaKey \|\| e\.ctrlKey/, 'cmd on macOS, ctrl everywhere else');
});

test('absolute() resolves against the SHELL document, never an app iframe', () => {
  const fn = navLinkFn('absolute(href) {');
  assert.match(fn, /new URL\([\s\S]{0,60}window\.location\.href\)/,
    'resolving against anything else (an app iframe URL) would open a new tab '
    + 'on a page that is not a usable top-level address — that IS the bug');
});

test('homeHref() drops the fragment and keeps the query', () => {
  const fn = navLinkFn('homeHref() {');
  assert.match(fn, /window\.location\.pathname \+ window\.location\.search/,
    'mirrors the home branch of App.updateHash — the staging ?token= and '
    + '?demo= must survive into the new tab');
});

test('bind() guards before preventDefault, and treats a falsy href as inert', () => {
  const fn = navLinkFn('bind(el, href, onActivate) {');
  const guard = fn.indexOf('NavLink.isNativeClick(e)');
  const prevent = fn.indexOf('e.preventDefault()');
  assert.ok(guard !== -1 && prevent !== -1);
  assert.ok(guard < prevent,
    'preventDefault before the guard would swallow the browser\'s new-tab');
  assert.match(fn, /removeAttribute\('href'\)/,
    'no resolvable route means no href — better than minting #app/undefined/dev');
});

test('wireModified() binds auxclick as well as click', () => {
  const fn = navLinkFn('wireModified(el, hrefFn, onActivate) {');
  assert.match(fn, /addEventListener\('auxclick'/,
    'a middle-click on a NON-anchor fires auxclick only — without this the '
    + 'mouse-wheel press on a list row does nothing');
  assert.match(fn, /window\.open\(NavLink\.absolute\(href\), '_blank', 'noopener'\)/,
    'the opened URL must be the absolute one, and noopener is not optional');
  assert.match(fn, /if \(!href\) return true;/,
    'a falsy href means the control is inert right now — a modified click '
    + 'must then behave exactly like the plain click (nothing)');
});

test('no converted control opts into target=_blank', () => {
  // In the Flutter WebView target=_blank pushes a PLAIN tap out to the
  // system browser, which is the opposite of the intent here.
  assert.ok(!/id="back-btn"[^>]*target=/.test(html),
    'the header control must not carry target — see NavLink\'s header comment');
  for (const [name, src] of [['app-view.js', appViewJs], ['dev-chat.js', devChatJs],
    ['browse.js', browseJs], ['leaderboard.js', leaderboardJs]]) {
    for (const id of ['dc-back', 'dev-chat-back', 'dev-topic-back',
      'browse-detail-back', 'data-lb-back']) {
      const at = src.indexOf(`${id}"`) !== -1 ? src.indexOf(`${id}"`) : src.indexOf(id);
      if (at === -1) continue;
      const tag = src.slice(at, src.indexOf('>', at));
      assert.ok(!tag.includes('target='),
        `${name}'s ${id} must not carry target=_blank`);
    }
  }
  // NavLink must never SET the attribute either. (Its own header comment
  // names it in prose, and wireModified passes '_blank' as window.open's
  // window NAME — neither is an anchor target, so match on the setters.)
  assert.ok(!/setAttribute\(\s*'target'/.test(navLinkJs)
    && !/\.target\s*=/.test(navLinkJs),
    'NavLink itself must never set an anchor target');
});

test('the module is registered in the shell AND the service worker', () => {
  assert.match(html, /<script src="\/js\/nav-link\.js"><\/script>/,
    'the shell has to load it');
  assert.ok(html.indexOf('/js/nav-link.js') < html.indexOf('/js/platform-ui.js'),
    'it has no dependencies and several later modules consume it — load it first');
  assert.match(swJs, /'\/js\/nav-link\.js',/,
    'a module missing from the precache list 404s the whole shell offline');
});

// ── The header control ─────────────────────────────────────────────────

test('the header back/home control is a real anchor', () => {
  assert.match(html, /<a id="back-btn"/,
    'a <button> ignores cmd-click — being an anchor IS the fix');
  assert.ok(!/<button id="back-btn"/.test(html), 'the old button tag is gone');
  // The 28px header content-row floor is load-bearing (see
  // tests/header-height-parity.test.js); an <a> is `inline` where a
  // <button> was `inline-block`.
  const tag = html.match(/<a id="back-btn"[^>]*>/)[0];
  assert.match(tag, /\binline-flex\b/, 'the anchor keeps the icon block-level');
  assert.match(tag, /\bitems-center\b/, 'and centred in the 28px row');
  assert.match(tag, /\bhidden\b/, 'it still ships hidden — app.js toggles that class');
  // Both icons still live inside it, and the wrapper is untouched.
  const inner = html.slice(html.indexOf('<a id="back-btn"'), html.indexOf('</a>', html.indexOf('<a id="back-btn"')));
  assert.match(inner, /id="back-icon-home"/, 'the house icon');
  assert.match(inner, /id="back-icon-arrow"/, 'the chevron');
  assert.match(html, /<div class="w-5 h-7 shrink-0 flex items-center">/,
    'the fixed 20x28 wrapper the header-layout hook measures must not change');
});

test('the header click handler guards before it preventDefaults', () => {
  const body = handlerAfter(appJs, "document.getElementById('back-btn').addEventListener", 900);
  const guard = body.indexOf('NavLink.isNativeClick(e)');
  const prevent = body.indexOf('e.preventDefault()');
  assert.ok(guard !== -1, 'the modified-click guard went missing');
  assert.ok(guard < prevent, 'the guard must come FIRST, or cmd-click is swallowed');
  // The existing screen-hook chain is unchanged and still ordered.
  assert.ok(body.indexOf('AdminConsole?.handleBack') < body.indexOf('Settings?.handleBack'));
  assert.ok(body.indexOf('Settings?.handleBack') < body.indexOf('Browse?.handleBack'));
  assert.ok(body.indexOf('Browse?.handleBack') < body.indexOf('App.navigateHome()'));
});

test('setBackIcon owns the anchor href, defaulting to home', () => {
  const at = appJs.indexOf('  setBackIcon(mode, href) {');
  assert.ok(at !== -1, 'setBackIcon must take the href as a second argument');
  const fn = appJs.slice(at, appJs.indexOf('\n  },', at));
  assert.match(fn, /setAttribute\('href'/, 'it writes the target onto the anchor');
  assert.match(fn, /href \|\| \(window\.NavLink \? NavLink\.homeHref\(\) : '\/'\)/,
    'omitting the argument means home — correct for every screen except the '
    + 'three that claim the chevron as "up one level"');
  assert.match(fn, /aria-label', arrow \? 'Back' : 'Home'/,
    'the accessible name still tracks the icon');
});

test('every screen entry refreshes the href through the one choke point', () => {
  const at = appJs.indexOf('  _showOnlyScreen(revealId, keepAlso) {');
  assert.ok(at !== -1, '_showOnlyScreen went missing');
  const fn = appJs.slice(at, appJs.indexOf('\n  },', at));
  assert.match(fn, /App\.setBackIcon\('home'\)/,
    'this is what keeps the href from ever going stale — every screen change '
    + 'passes through here');
});

test('the three up-one-level screens pass their own target', () => {
  assert.match(browseJs, /App\.setBackIcon\(\s*onDetail \? 'arrow' : 'home',[\s\S]{0,160}?'#apps'/,
    'browse detail goes up to the list…');
  assert.match(browseJs, /Browse\._detailOrigin !== 'home'/,
    '…except when it was opened from a home card, where handleBack goes home');
  assert.match(adminConsoleJs, /setBackIcon\(inSection \? 'arrow' : 'home', inSection \? '#admin' : undefined\)/,
    'the admin section chevron pops to the console menu');
  assert.match(settingsJs, /setBackIcon\(inSection \? 'arrow' : 'home', inSection \? '#settings' : undefined\)/,
    'the settings section chevron pops to the settings menu');
});

// ── The converted back controls ────────────────────────────────────────

const ANCHORS = [
  {
    label: 'back out of a dev session',
    src: () => devChatJs, file: 'dev-chat.js',
    markup: /<a id="dc-back"/,
    oldTag: /<button id="dc-back"/,
    href: /href="\$\{App\.currentApp \? `#app\/\$\{escapeHtml\(App\.currentApp\)\}\/dev` : ''\}"/,
    handler: "document.getElementById('dc-back').addEventListener",
  },
  {
    label: 'back out of the app-wide dev chat',
    src: () => appViewJs, file: 'app-view.js',
    markup: /<a id="dev-chat-back"/,
    oldTag: /<button id="dev-chat-back"/,
    href: /href="\$\{AppView\._devPageHref\(\)\}"/,
    handler: "document.getElementById('dev-chat-back').addEventListener",
  },
  {
    label: 'back out of an issue / proposal / governance topic',
    src: () => appViewJs, file: 'app-view.js',
    markup: /<a id="dev-topic-back"/,
    oldTag: /<button id="dev-topic-back"/,
    href: /href="\$\{AppView\._devPageHref\(\)\}"/,
    handler: "document.getElementById('dev-topic-back').addEventListener",
  },
  {
    label: 'back to all apps',
    src: () => browseJs, file: 'browse.js',
    markup: /<a id="browse-detail-back" href="#apps"/,
    oldTag: /<button type="button" id="browse-detail-back"/,
    href: /id="browse-detail-back" href="#apps"/,
    handler: "host.querySelector('#browse-detail-back')",
  },
  {
    label: 'back to the top-users leaderboard',
    src: () => leaderboardJs, file: 'leaderboard.js',
    markup: /<a data-lb-back href="#leaderboard\/users"/,
    oldTag: /<button data-lb-back/,
    href: /data-lb-back href="#leaderboard\/users"/,
    handler: "root.querySelector('[data-lb-back]').addEventListener",
  },
];

for (const a of ANCHORS) {
  test(`"${a.label}" is a real anchor with a real target`, () => {
    const src = a.src();
    assert.match(src, a.markup, `${a.file}: the control must be an <a>`);
    assert.ok(!a.oldTag.test(src), `${a.file}: the old <button> tag is gone`);
    assert.match(src, a.href, `${a.file}: it must carry a resolvable href`);
  });

  test(`"${a.label}" leaves a modified click to the browser`, () => {
    const body = handlerAfter(a.src(), a.handler, 700);
    const guard = body.indexOf('NavLink.isNativeClick(e)');
    const prevent = body.indexOf('e.preventDefault()');
    assert.ok(guard !== -1, `${a.file}: the modified-click guard went missing`);
    assert.ok(prevent !== -1, `${a.file}: a plain click must still be intercepted`);
    assert.ok(guard < prevent,
      `${a.file}: preventDefault ahead of the guard swallows the new tab`);
  });
}

test('the dev sub-views resolve their target through one helper', () => {
  const at = appViewJs.indexOf('  _devPageHref() {');
  assert.ok(at !== -1, 'AppView._devPageHref went missing');
  const fn = appViewJs.slice(at, appViewJs.indexOf('\n  },', at));
  assert.match(fn, /AppView\.appData && AppView\.appData\.slug\) \|\| App\.currentApp/,
    'either source of the open app\'s slug is acceptable');
  assert.match(fn, /return slug \? `#app\/\$\{encodeURIComponent\(slug\)\}\/dev` : ''/,
    'no slug means an EMPTY href, never "#app/undefined/dev"');
});

test('[data-lb-back] keeps its bottom margin as an anchor', () => {
  const tag = leaderboardJs.match(/<a data-lb-back[^>]*>/)[0];
  assert.match(tag, /\bmb-3\b/, 'the spacing the button had');
  assert.match(tag, /\binline-block\b/,
    'an <a> is `inline`, and margin-bottom does nothing on an inline box — '
    + 'without this the button-to-anchor swap silently collapses the gap');
});

test('#browse-detail-back keeps its own layout as an anchor', () => {
  const tag = browseJs.match(/<a id="browse-detail-back"[^>]*>/)[0];
  assert.match(tag, /\binline-block\b/, 'same inline-vs-inline-block trap');
});

// ── The rows that stay buttons / divs ──────────────────────────────────

test('the App/Dev switch stays a radiogroup and intercepts by hand', () => {
  // An <a> cannot carry role="radio" inside a role="radiogroup"; that is
  // why this one control uses mechanism B.
  assert.match(html, /<button[^>]*role="radio"[^>]*class="[^"]*app-mode-seg/,
    'the segments must remain buttons with their ARIA role');
  const at = appJs.indexOf(".querySelectorAll('.app-mode-seg')");
  assert.ok(at !== -1, 'the switch wiring went missing');
  const body = appJs.slice(at, at + 900);
  assert.match(body, /NavLink\.wireModified\(btn, hrefFor, activate\)/,
    'the switch routes through the interception helper');
  assert.match(body, /#app\/\$\{App\.currentApp\}\/\$\{btn\.dataset\.tab === 'dev' \? 'dev' : 'app'\}/,
    'the target is resolved at click time — App.currentApp is not stable at wiring time');
  assert.match(body, /App\.currentApp\s*\?/,
    'no open app means no target rather than "#app/null/app"');
  // The "re-tapping the active App segment is a no-op" guard belongs to
  // the plain path only: a cmd-click is not re-mounting this tab's iframe.
  const activate = body.slice(body.indexOf('const activate'));
  assert.match(activate.slice(0, 200), /btn\.dataset\.tab === 'app' && App\.currentTab === 'app'\) return/,
    'the no-op guard survives on the plain-click path');
});

const ROWS = [
  {
    label: 'home app cards',
    src: () => homeJs, file: 'home.js',
    anchor: ".querySelectorAll('.app-card')",
    wire: /NavLink\.wireModified\(card, hrefFor, activate\)/,
    href: /#app\/\$\{encodeURIComponent\(card\.dataset\.slug\)\}\/app/,
    guards: ['card-add-btn', 'card-menu-btn', "card.dataset.demo === 'true'", 'awaiting_secrets'],
  },
  {
    label: 'browse list rows',
    src: () => browseJs, file: 'browse.js',
    anchor: ".querySelectorAll('.browse-row')",
    wire: /NavLink\.wireModified\(row, hrefFor, activate\)/,
    href: /#apps\/\$\{encodeURIComponent\(slug\)\}/,
    guards: ['browse-add-btn', "row.dataset.demo === 'true'"],
  },
  {
    label: 'dev-chat session rows',
    src: () => devChatJs, file: 'dev-chat.js',
    anchor: ".querySelectorAll('.dc-active-item')",
    wire: /NavLink\.wireModified\(el, hrefFor, activate\)/,
    href: /#app\/\$\{encodeURIComponent\(slug\)\}\/dev\/sessions\/\$\{id\}/,
    guards: ['Number.isFinite(id)'],
  },
];

for (const r of ROWS) {
  test(`${r.label} open in a new tab under a modifier`, () => {
    const at = r.src().indexOf(r.anchor);
    assert.ok(at !== -1, `${r.file}: ${r.anchor} went missing`);
    const body = r.src().slice(at, at + 1600);
    assert.match(body, r.wire, `${r.file}: must route through NavLink.wireModified`);
    assert.match(body, r.href, `${r.file}: the new tab must open the row's own route`);
    // hrefFor has to repeat the plain click's guards, or a modified click
    // would drill into a row the plain click treats as inert.
    const hrefFor = body.slice(body.indexOf('const hrefFor'), body.indexOf('const activate'));
    for (const g of r.guards) {
      assert.ok(hrefFor.includes(g),
        `${r.file}: hrefFor must repeat the "${g}" guard — otherwise cmd-click `
        + 'drills into a row a plain click refuses');
    }
    assert.ok(hrefFor.includes('return null'),
      `${r.file}: a guarded-out row must resolve to no href, i.e. stay inert`);
  });
}

// ── The drawer's delegated handler ─────────────────────────────────────

test('a modified click in the drawer neither arms the flag nor closes it', () => {
  // #1079 chunk B moved App.HeaderMenu into the React bundle beside the
  // markup it drives; the delegated handler went with it.
  const headerMenuJs = read('frontend/src/features/header/header-menu-controller.js');
  const at = headerMenuJs.indexOf("const drawerPanel = document.getElementById('header-menu-panel');");
  assert.ok(at !== -1, 'the delegated drawer handler went missing');
  const body = headerMenuJs.slice(at, at + 1400);
  const guard = body.indexOf('NavLink.isNativeClick(e)');
  const arm = body.indexOf('_navArmedAt = HeaderMenu._now()');
  const close = body.indexOf('HeaderMenu.close()');
  assert.ok(guard !== -1, 'the guard went missing');
  assert.ok(arm !== -1 && close !== -1, 'the existing arm/close behaviour must survive');
  assert.ok(guard < arm,
    'nothing navigates in THIS document on a cmd-click, so the one-shot '
    + 'animation-suppression flag must not be armed — it would leak onto the '
    + 'next real navigation until its TTL');
  assert.ok(guard < close,
    'and the drawer must not be torn down under a user who opened another tab');
  // The existing contract (tests/drawer-nav-motion.test.js) is intact.
  assert.match(body, /closest\('a\[href\]'\)/);
  assert.match(body, /getAttribute\('href'\)/);
});

// ── The declared checks ────────────────────────────────────────────────

test('dapp.json pins the anchors that a capture can actually see', () => {
  // A headless capture cannot synthesise a ⌘-click, so the checks assert
  // the anchors exist with the right target — which IS the contract.
  const checks = (dapp.tests || []).filter(
    (t) => typeof t.name === 'string' && t.name.includes('#1036')
  );
  assert.ok(checks.length >= 3,
    'without checks a button-to-anchor regression ships silently');

  const bySelector = (frag) => checks.find(
    (t) => typeof t.expectSelector === 'string' && t.expectSelector.includes(frag)
  );

  const session = bySelector('a#dc-back');
  assert.ok(session, 'the control named in the issue needs its own check');
  assert.match(session.expectSelector, /a#dc-back\[href="#app\/[^"]+\/dev"\]/,
    'assert the TARGET, not just the tag — an anchor with no href is no fix');
  assert.match(session.path, /dev\/sessions\/\d+/, 'it must land on a session');

  const home = bySelector('a#back-btn');
  assert.ok(home, 'the header home control needs a check');
  assert.match(home.expectSelector, /a#back-btn/,
    'a <button id="back-btn"> must fail this selector');

  const upLevel = checks.find(
    (t) => typeof t.expectSelector === 'string'
      && t.expectSelector.includes('a#back-btn[href="#apps"]')
  );
  assert.ok(upLevel, 'the setBackIcon(mode, href) plumbing needs its own regression check');
  // The self-app is hash-routed, so its declared paths carry the fragment.
  assert.match(upLevel.path, /^\/#apps\/[^/]+$/, 'it has to be on an app detail page');

  // Ungated, ordinary routes: an env-gated path starves the production
  // "before" shot forever (same rule as tests/drawer-nav-motion.test.js).
  for (const t of checks) {
    assert.ok(!/IS_STAGING|USERNODE_ENV/.test(t.path),
      `${t.name}: the path must not be env-gated`);
  }
});

test('the declared checks survive the manifest reader', () => {
  const appManifest = require('../src/services/app-manifest');
  const meta = appManifest.readTestsWithMeta(dapp);
  assert.equal(meta.ceilingDropped, 0,
    `dapp.json declares more than ${appManifest.MAX_DECLARED_TESTS} valid checks — `
    + 'checks past the ceiling never run');
  const kept = meta.tests.filter((t) => /#1036/.test(t.name || ''));
  assert.ok(kept.length >= 3,
    'a malformed entry is silently dropped, which gates nothing');
});
