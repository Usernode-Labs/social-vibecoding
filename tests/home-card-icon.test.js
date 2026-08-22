// Home-card icon tile states (dapp.json `icon` block): renderAppCard
// must render exactly one of three tile kinds — a custom image
// (icon_url), an emoji (icon_emoji), or the first-letter fallback —
// tagged with data-icon so the WS rename handler (app.js) can tell a
// custom icon from the letter placeholder, and updateAppCardIcon must
// patch a mounted tile in place across all three states.
//
// home.js declares `const Home = {…}` at top level; we load it into a vm
// context, stub the globals it reaches, and assert on the returned HTML
// strings — same harness as card-action-layout.test.js. Both sources come
// from ./helpers/home-modules, which resolves their post-#1083 location and
// strips the one `import` line a vm context cannot parse.
//
// Run with: node --test tests/home-card-icon.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installAppCard } = require('./helpers/app-card');
const { installGridStore } = require('./helpers/home-grid-store');
// The "Create app" tile moved out of home.js: it is a home-screen WIDGET now
// (HomePanels.renderCreatePanel), so home-panels.js is loaded here too, to
// keep it under the same shared-icon-treatment assertions the app tiles are.
const { HOME_SRC: SRC, PANELS_SRC, LAYOUT_SRC } = require('./helpers/home-modules');

// Minimal functional stand-in for the DOM bits home.js's escapeHtml
// leans on (createElement + textContent/innerHTML round-trip).
function fakeElement() {
  let text = '';
  return {
    style: {},
    set textContent(v) { text = String(v); },
    get textContent() { return text; },
    get innerHTML() {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  };
}

function makeHome() {
  const sandbox = {
    console,
    App: { user: null },
    document: {
      createElement: fakeElement,
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    // An origin so _widgetSlugFor can resolve a widget item's URL back
    // to an SV slug (widget tiles key their icon off the matched app).
    location: { search: '', origin: 'https://sv.test' },
    URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // home.js's iconTileFor / renderAppPillsHtml delegate to the shared card
  // builders (frontend/src/features/apps/app-card.js) since #1083 chunk F.
  // It imports them; this declares what the stripped import would have bound.
  installAppCard(sandbox);
  // #1191: updateAppCardIcon publishes a render rather than writing into
  // the tile, so the sandbox needs the store binding the stripped import
  // would have made — and the geometry module render() lays out against.
  const gridStore = installGridStore(sandbox);
  vm.runInContext(`${LAYOUT_SRC}\n${SRC}\n${PANELS_SRC}\n;globalThis.__Home = Home;`, sandbox);
  const Home = sandbox.__Home;
  Home.__sandbox = sandbox;
  Home.__gridStore = gridStore;
  Home.__HP = sandbox.HomePanels;
  return Home;
}

function baseApp(overrides = {}) {
  return {
    slug: 'demo',
    name: 'Demo App',
    status: 'running',
    active_users: 0,
    locked: false,
    icon_emoji: null,
    icon_url: null,
    ...overrides,
  };
}

test('letter fallback renders when no icon is declared', () => {
  const html = makeHome().renderAppCard(baseApp());
  assert.match(html, /data-icon="letter"/);
  assert.match(html, />\s*D\s*</);
  assert.doesNotMatch(html, /<img/);
});

test('emoji icon renders on the tile', () => {
  const html = makeHome().renderAppCard(baseApp({ icon_emoji: '🎮' }));
  assert.match(html, /data-icon="emoji"/);
  assert.ok(html.includes('🎮'));
  assert.doesNotMatch(html, /<img/);
});

test('image icon renders an <img> and wins over emoji', () => {
  const html = makeHome().renderAppCard(
    baseApp({ icon_emoji: '🎮', icon_url: '/app-icons/' + 'a'.repeat(32) })
  );
  assert.match(html, /data-icon="image"/);
  assert.match(html, /<img src="\/app-icons\/a{32}"/);
  assert.match(html, /object-cover/);
});

// The tile treatment itself (app.css `.app-icon-tile`): a white face
// with a faint grey hairline, and the first-letter fallback a step
// fainter still. Every tile call site routes its colours through that
// one class, so no tile may carry its own violet colour utilities.
test('every icon tile carries .app-icon-tile and no violet colouring', () => {
  const Home = makeHome();
  const variants = [
    Home.renderAppCard(baseApp()),
    Home.renderAppCard(baseApp({ icon_emoji: '🎮' })),
    Home.renderAppCard(baseApp({ icon_url: '/app-icons/' + 'a'.repeat(32) })),
    Home.__HP.renderCreatePanel({ key: 'create' }),
    Home.renderWidgetTile({ id: 'w1', name: 'Demo App', slug: 'demo' }),
  ];
  for (const html of variants) {
    const tile = html.match(/class="app-icon-tile[^"]*"/);
    assert.ok(tile, 'tile uses the shared class');
    // Scoped to the tile's own class list: the surrounding create-tile
    // chrome (dashed violet card outline, violet "Create new app" pill)
    // is deliberately untouched.
    assert.doesNotMatch(tile[0], /bg-violet/, 'no violet tile background');
    assert.doesNotMatch(tile[0], /text-violet/, 'no violet glyph colour');
  }
  // The create-tile placeholder keeps its "empty slot" variant.
  assert.match(Home.__HP.renderCreatePanel({ key: 'create' }), /app-icon-tile app-icon-tile--empty/);
});

// The fainter letter is CSS-side: the tile tags its kind with
// data-icon and app.css steps ONLY the letter kind down to
// --text-faint. Pin both halves — the markup tag on every tile call
// site, and the stylesheet rule that keys off it — so neither can drift
// away from the other and silently restore the darker letter.
test('letter tiles are tagged data-icon="letter" on every call site', () => {
  const Home = makeHome();
  const widgetItem = { id: 'w1', name: 'Demo App', url: 'https://sv.test/#app/demo' };
  assert.match(Home.renderAppCard(baseApp()), /class="app-icon-tile[^"]*"[^>]*data-icon="letter"/);
  Home._apps = [baseApp()];
  assert.match(
    Home.renderWidgetTile(widgetItem),
    /class="app-icon-tile[^"]*"[^>]*data-icon="letter"/
  );
  // …and the other two kinds keep their own tags, so the letter rule
  // can never catch an emoji or image tile.
  assert.match(Home.renderAppCard(baseApp({ icon_emoji: '🎮' })), /data-icon="emoji"/);
  Home._apps = [baseApp({ icon_emoji: '🎮' })];
  assert.match(Home.renderWidgetTile(widgetItem), /data-icon="emoji"/);
  Home._apps = [baseApp({ icon_url: '/app-icons/' + 'a'.repeat(32) })];
  assert.match(Home.renderWidgetTile(widgetItem), /data-icon="image"/);
});

test('app.css steps the letter glyph down to the faint token', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'css', 'app.css'),
    'utf8'
  );
  // Scoped to :not([data-tint]) since the widget language landed: an untinted
  // tile still steps its letter down, but on an app's identity tint the
  // near-black ink is what reads and the faint token would be near-invisible.
  assert.match(
    css,
    /\.app-icon-tile\[data-icon="letter"\]:not\(\[data-tint\]\)\s*\{\s*color:\s*var\(--text-faint\);/,
    'untinted letter tiles use --text-faint, one step fainter than the base glyph'
  );
  // The base tile colour stays where it is — only the letter steps down.
  assert.match(css, /\.app-icon-tile \{[^}]*color: var\(--text-secondary\);/);
  // And a tinted face drops the hairline and pins the glyph, in both themes.
  assert.match(css, /\.app-icon-tile\[data-tint\]\s*\{[^}]*color: var\(--tile-ink\);/);
});

// --border-light is inverted between the palettes (fainter than
// --border in light mode, BRIGHTER in dark mode), so a single token
// for the hairline gives dark-mode tiles the most contrasty ring on
// the page. Pin the per-mode pair so neither half drifts back.
test('the tile hairline steps down to --border in dark mode', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'css', 'app.css'),
    'utf8'
  );
  assert.match(
    css,
    /\.app-icon-tile \{[^}]*border: 1px solid var\(--border-light\);/,
    'light mode keeps the faint --border-light hairline'
  );
  // The widget strip mirrors the pinned homescreen grid, and on a
  // dual-icon shell the widget wears exactly these per-theme faces — so
  // the strip gets them by routing through the shared class, with no
  // scoped override of its own. (An appearance-neutral translucent
  // override lived here briefly and was reverted with the approach.)
  assert.doesNotMatch(
    css,
    /\.widget-tile \.app-icon-tile\s*\{/,
    'strip tiles take the shared face, not a scoped one'
  );
  // Scoped :not([data-tint]) since the widget language landed. This rule and
  // `.app-icon-tile[data-tint="…"]` are both (0,2,0), and this one is later —
  // unscoped it won, so every tinted launcher tile lost its colour in dark
  // mode while keeping the near-black glyph the tint exists to carry. A
  // tinted tile is an app's icon and follows neither theme.
  assert.match(
    css,
    /\.dark \.app-icon-tile:not\(\[data-tint\]\) \{[^}]*border-color: var\(--border\);/,
    'dark mode steps the UNTINTED hairline down to --border'
  );
});

// The widget PNG is baked once per pinned tile and can't restyle
// itself, so both palettes have to live in the source and the scheme
// has to reach the staleness marker. Pin all three halves together:
// the palette table, the render-time lookup, and the generation bump —
// a rendering change without a bump never reaches a homescreen.
test('the widget PNG carries a light AND a dark palette', () => {
  const src = SRC;
  // Light: unchanged from the original single-palette treatment.
  assert.match(
    src,
    /light: \{ face: '#ffffff', hairline: '#e4e4e7', letter: '#a1a1aa' \}/,
    'light palette matches the in-app light tile'
  );
  // Dark: --bg-secondary / --border / --text-faint under `.dark`.
  assert.match(
    src,
    /dark: \{ face: '#1a1a30', hairline: '#2e2e50', letter: '#9898b0' \}/,
    'dark palette matches the in-app dark tile'
  );
  // Emoji keep their own colour glyphs in BOTH palettes.
  assert.match(src, /app\.icon_emoji \? null : palette\.letter/);
  assert.match(src, /WIDGET_ICON_GEN: 5,/);
});

// The PNG lands on the iOS homescreen, which renders under the SYSTEM
// appearance — it cannot see SV's in-app Light/Dark/System override.
// Keying the palette off `.dark` / Theme.get() would paint a light
// widget onto a dark homescreen for anyone who forces SV to light.
test('the widget palette keys off the system scheme, not the .dark class', () => {
  const src = SRC;
  const scheme = src.match(/_widgetScheme\(\) \{[\s\S]*?\n  \},/);
  assert.ok(scheme, '_widgetScheme is defined');
  assert.doesNotMatch(scheme[0], /classList/, 'does not read the .dark class');
  assert.doesNotMatch(scheme[0], /Theme/, 'does not read the in-app theme');
  assert.match(src, /_schemeQuery\(\) \{[\s\S]*?prefers-color-scheme: dark/);
});

// ── Dual-icon capability (#948) ──────────────────────────────────────
//
// Where the shell can hold a light/dark pair, SV sends both and the
// widget picks natively — the only way a pinned tile follows a flip
// with SV closed. Where it can't, everything stays on the gen-5 path.

test('the dark-icon capability string is pinned', () => {
  const Home = makeHome();
  assert.equal(Home.WIDGET_DARK_ICON_CAPABILITY, 'homeScreenShortcutDarkIcon',
    'the exact string the shell advertises — the two repos agree on this');
});

// An explicit variant must win over the live appearance, always. That
// is what lets the capable path build a payload that is byte-identical
// in light and dark: if the renderer peeked at prefers-color-scheme,
// the pair itself would drift with the appearance and re-send forever.
test('an explicit variant beats the system appearance in the renderer', () => {
  const Home = makeHome();
  const paints = [];
  Home.__sandbox.document.createElement = () => ({
    getContext: () => ({
      fillStyle: null, strokeStyle: null,
      beginPath() {}, closePath() {}, moveTo() {}, arcTo() {}, roundRect() {},
      fill() { paints.push(this.fillStyle); },
      stroke() { paints.push(this.strokeStyle); },
      fillRect() {}, fillText() { paints.push(this.fillStyle); },
    }),
    toDataURL: () => 'data:image/png;base64,FAKE',
  });
  // System says dark…
  Home.__sandbox.matchMedia = () => ({ matches: true, addEventListener: () => {} });
  Home._widgetIconDataUrl(baseApp(), 'light');
  assert.equal(paints[0], '#ffffff', '…but an explicit light variant paints white');
  paints.length = 0;
  // …and the other way round.
  Home.__sandbox.matchMedia = () => ({ matches: false, addEventListener: () => {} });
  Home._widgetIconDataUrl(baseApp(), 'dark');
  assert.equal(paints[0], '#1a1a30', 'an explicit dark variant paints the dark face');
});

// The marker records WHICH artwork was baked. On the capable path that
// is 'dual' in both appearances, so a flip marks nothing stale (there
// is nothing to repaint). On the fallback path it is the scheme, byte
// for byte as gen 5 recorded it — that identity is what guarantees
// non-capable users see zero churn from this change.
test('the marker variant is dual when capable, the scheme when not', () => {
  const Home = makeHome();
  let dark = false;
  Home.__sandbox.matchMedia = () => ({ get matches() { return dark; }, addEventListener: () => {} });

  const letter = baseApp();
  const emoji = baseApp({ icon_emoji: '🎮' });
  const image = baseApp({ icon_url: '/app-icons/' + 'a'.repeat(32) });
  const imageSrc = Home._desiredIconSrcFor(image);

  // Capability absent (unprobed null and explicit false both count).
  for (const state of [null, false]) {
    Home._widgetDarkIcons = state;
    dark = false;
    assert.equal(Home._desiredIconSrcFor(letter), `tile:${Home.WIDGET_ICON_GEN}:light:`);
    assert.equal(Home._desiredIconSrcFor(emoji), `tile:${Home.WIDGET_ICON_GEN}:light:🎮`);
    dark = true;
    assert.equal(Home._desiredIconSrcFor(letter), `tile:${Home.WIDGET_ICON_GEN}:dark:`);
    assert.equal(Home._desiredIconSrcFor(emoji), `tile:${Home.WIDGET_ICON_GEN}:dark:🎮`);
  }

  // Capability present: identical in both appearances, and with no
  // matchMedia at all.
  Home._widgetDarkIcons = true;
  for (const state of [false, true]) {
    dark = state;
    assert.equal(Home._desiredIconSrcFor(letter), `tile:${Home.WIDGET_ICON_GEN}:dual:`);
    assert.equal(Home._desiredIconSrcFor(emoji), `tile:${Home.WIDGET_ICON_GEN}:dual:🎮`);
  }
  delete Home.__sandbox.matchMedia;
  assert.equal(Home._desiredIconSrcFor(letter), `tile:${Home.WIDGET_ICON_GEN}:dual:`);

  // Image icons keep one marker in every state — their payload really
  // is identical, so folding the variant in would re-send for nothing.
  assert.equal(Home._desiredIconSrcFor(image), imageSrc);
});

// The probe answers "could not say" — NOT false — wherever there is no
// native shell to ask, and never throws (_desiredIconSrcFor runs on
// every heal pass, so a rejection here would break icon healing
// outright).
//
// This used to assert `false` for both cases, and that assertion was the
// bug: a shell whose getBridgeInfo is degraded reports no capabilities,
// the old `NativeChrome.has()` collapsed that to false, and the answer
// was memoised for the whole page load — so a build that HAD shipped the
// dark-icon support never got a pair, and never re-asked. An unresolved
// probe must therefore stay unresolved and drop its own memo.
test('the capability probe reports "could not say", and never latches it', async () => {
  const Home = makeHome();
  assert.equal(Home.__sandbox.window.NativeChrome, undefined, 'sandbox has no NativeChrome');
  assert.equal(await Home._ensureDarkIconCapability(), null);
  assert.equal(Home._widgetDarkIcons, null);
  assert.equal(Home._darkIconProbe, null, 'the inconclusive answer is not memoised');

  const rejecting = makeHome();
  rejecting.__sandbox.NativeChrome = { supports: async () => { throw new Error('nope'); } };
  assert.equal(await rejecting._ensureDarkIconCapability(), null, 'a rejection is not fatal');
  assert.equal(rejecting._darkIconProbe, null, 'and is re-asked next pass');

  // A conclusive answer IS memoised — re-asking on every heal pass would
  // be pure churn, and only the negative-that-isn't-one is dangerous.
  const capable = makeHome();
  let asked = 0;
  capable.__sandbox.NativeChrome = {
    supports: async () => { asked += 1; return true; },
    getInfo: async () => ({ version: 4, capabilities: [], appVersion: '1.4.0', buildNumber: '9' }),
  };
  assert.equal(await capable._ensureDarkIconCapability(), true);
  assert.equal(await capable._ensureDarkIconCapability(), true);
  assert.equal(asked, 1, 'a conclusive answer is asked for once');
});

// The variant the payload builder emits is driven by the RESOLVED
// capability, and an unresolved one behaves exactly like "no" — a
// half-built pair would be worse than either answer.
test('an unresolved capability sends the same single face as a "no"', () => {
  const Home = makeHome();
  const app = { slug: 'demo', name: 'Demo', icon_emoji: '' };
  Home._widgetDarkIcons = null;
  assert.equal('icon_url_dark' in Home._shortcutPayloadFor(app), false);
  assert.equal(Home._desiredIconSrcFor(app), `tile:${Home.WIDGET_ICON_GEN}:light:`);
  Home._widgetDarkIcons = false;
  assert.equal('icon_url_dark' in Home._shortcutPayloadFor(app), false);
  assert.equal(Home._desiredIconSrcFor(app), `tile:${Home.WIDGET_ICON_GEN}:light:`);

  // …except for the one caller that must force a pair to find out.
  assert.equal('icon_url_dark' in Home._shortcutPayloadFor(app, 'dual'), true,
    'the confirmation send carries both faces whatever the state says');
});

// The verdict is a claim about an installed binary, so it must not
// survive the binary changing.
test('a stored verdict is bound to the app version pair', () => {
  const Home = makeHome();
  const store = {};
  Home.__sandbox.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  store[Home.WIDGET_DARK_VERDICT_KEY] = JSON.stringify({
    appVersion: '1.4.0', buildNumber: '1223', verdict: 'supported',
  });
  assert.equal(
    Home._storedVerdictForBuild({ appVersion: '1.4.0', buildNumber: '1223' }),
    'supported'
  );
  assert.equal(
    Home._storedVerdictForBuild({ appVersion: '1.4.0', buildNumber: '1224' }),
    null, 'a new build number re-opens the question'
  );
  assert.equal(
    Home._storedVerdictForBuild({ appVersion: '1.5.0', buildNumber: '1223' }),
    null, 'so does a new app version'
  );
  assert.equal(Home._storedVerdictForBuild(null), null,
    'an unreadable version binds nothing');
  store[Home.WIDGET_DARK_VERDICT_KEY] = 'not json';
  assert.equal(
    Home._storedVerdictForBuild({ appVersion: '1.4.0', buildNumber: '1223' }),
    null, 'a corrupt record is ignored, not thrown on'
  );
});

// The contract spans two repos, so the doc is the only thing keeping
// the Flutter side in sync. Changing the code without the doc is the
// drift this catches.
test('NATIVE-BRIDGE.md documents the dual-icon contract', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'NATIVE-BRIDGE.md'), 'utf8');
  assert.match(doc, /icon_url_dark/, 'the additive payload field');
  assert.match(doc, /has_icon_dark/, 'the registry read-back flag');
  assert.match(doc, /homeScreenShortcutDarkIcon/, 'the capability string');
  // The behavioural half of the contract. The shell can only hold up its
  // end of these if they are written down: SV now believes the read-back
  // over the capability list, binds the answer to the installed version,
  // and requires the widget to choose its face at RENDER time.
  assert.match(doc, /appVersion/, 'the verdict is bound to the version pair');
  assert.match(doc, /render time/i, 'appearance selection is a render-time decision');
  assert.match(doc, /statement of fact/i, 'has_icon_dark is authoritative, not a hint');
});

// Source-level twin of tests/native-bridge-boundary.test.js's "a degraded
// capability probe fails closed and never latches a negative": the same
// #978 rule, one layer up. NativeChrome.has() is deliberately BINARY — it
// collapses a degraded probe into `false` — so the icon path must ask
// through the tri-state supports() and must not memoise the third state.
// A future edit that "simplifies" this back to has() would restore the
// exact bug (the dark-icon capability going permanently unseen after one
// cold-start hiccup) while every behavioural test above still passed,
// because they stub NativeChrome rather than exercise the real one.
test('the icon path asks through the tri-state probe, not has()', () => {
  const capBlock = SRC.slice(
    SRC.indexOf('_probeDarkIconCapability'),
    SRC.indexOf('_iconSrcKey')
  );
  assert.ok(capBlock.length, 'the capability probe is where it is expected');
  assert.match(capBlock, /chrome\.supports\(/, 'asks the tri-state probe');
  assert.equal(/chrome\.has\(/.test(capBlock), false,
    'never the binary one, which collapses degraded into false');
  assert.match(capBlock, /_darkIconProbe = null/,
    'and an unresolved answer is not memoised');
});

test('image icons fill the tile inside its hairline (w-full/h-full)', () => {
  const Home = makeHome();
  const html = Home.renderAppCard(
    baseApp({ icon_url: '/app-icons/' + 'a'.repeat(32) })
  );
  assert.match(html, /<img[^>]*class="w-full h-full rounded-xl object-cover"/);
  assert.doesNotMatch(html, /<img[^>]*w-14 h-14/,
    'a fixed 56px image would be cropped by the 1px border box');
});

test('icon_url is HTML-escaped', () => {
  const html = makeHome().renderAppCard(
    baseApp({ icon_url: '/x"><script>alert(1)</script>' })
  );
  assert.doesNotMatch(html, /<script>/);
});

test('updateAppCardIcon republishes the tile across icon states', () => {
  // #1191: the tile is React-owned, so this no longer patches the DOM. It
  // updates the Home._apps cache and publishes a render; features/home/
  // app-grid.tsx repaints the one tile whose icon moved. Asserting the
  // PUBLISHED MODEL is asserting the same thing the old DOM check did, one
  // layer earlier — and it is the layer home.js still owns.
  const Home = makeHome();
  // `is_favorited` matters: Home.presentIds() derives the placeable set from
  // partitionApps(), and currentLayout() drops any item that is not present —
  // so an app nobody has pinned is filtered out of the canvas before it can
  // reach the model.
  Home._apps = [baseApp({ is_favorited: true })];
  const placed = [{ type: 'app', slug: 'demo', col: 0, row: 0 }];
  Home._layouts = { 4: placed, 5: placed };
  Home._layoutFetchedAt = Date.now();
  const iconOf = () => {
    const item = Home.__gridStore.get().items.find((i) => i.kind === 'card');
    return item && item.app.icon;
  };

  Home.updateAppCardIcon('demo', '🚀', null);
  // Field-wise, not deepEqual: these objects are built inside the vm context,
  // so they carry that realm's prototypes and deepStrictEqual rejects them
  // however identical their contents.
  assert.equal(iconOf().kind, 'emoji');
  assert.equal(iconOf().emoji, '🚀');
  assert.equal(Home._apps[0].icon_emoji, '🚀');

  Home.updateAppCardIcon('demo', null, '/app-icons/' + 'b'.repeat(32));
  assert.equal(iconOf().kind, 'image');
  assert.match(iconOf().src, /^\/app-icons\//);

  // Cleared back to the letter fallback (derived from the cached name).
  Home.updateAppCardIcon('demo', null, null);
  assert.equal(iconOf().kind, 'letter');
  assert.equal(iconOf().letter, 'D');
  assert.equal(Home._apps[0].icon_url, null);
});

test('updateAppCardIcon is a safe no-op for an app it has never seen', () => {
  // "Not mounted" is no longer the interesting case — publishing a model for
  // an unmounted island is harmless, and React paints it when it mounts. What
  // still has to be safe is a slug that is in no cache at all.
  const Home = makeHome();
  Home._apps = [];
  assert.doesNotThrow(() => Home.updateAppCardIcon('ghost', '🎮', null));
  assert.equal(Home.__gridStore.get().items.length, 0, 'and it publishes no card for it');
});

// _desiredIconSrcFor calls _widgetScheme on every heal pass, so a throw
// where matchMedia is missing (old WebViews, this sandbox) would break
// icon healing outright rather than just the palette choice.
test('_widgetScheme falls back to light without matchMedia', () => {
  const Home = makeHome();
  assert.equal(Home.__sandbox.window.matchMedia, undefined, 'sandbox has no matchMedia');
  assert.equal(Home._widgetScheme(), 'light');
  assert.doesNotThrow(() => Home._desiredIconSrcFor(baseApp()));
});

test('_widgetScheme tracks the media query when matchMedia exists', () => {
  const Home = makeHome();
  let dark = false;
  Home.__sandbox.matchMedia = (q) => ({
    media: q,
    get matches() { return dark; },
    addEventListener: () => {},
  });
  assert.equal(Home._widgetScheme(), 'light');
  dark = true;
  assert.equal(Home._widgetScheme(), 'dark');
});

// The scheme rides in the canvas-tile marker (that's what makes a flip
// re-send), but NOT in the image-icon marker — an app's own icon URL
// looks the same in both schemes, so folding it in would re-send every
// image tile on each flip for no visual change.
test('the scheme is part of the canvas-tile marker only', () => {
  const Home = makeHome();
  let dark = false;
  Home.__sandbox.matchMedia = () => ({ get matches() { return dark; }, addEventListener: () => {} });

  const letter = baseApp();
  const emoji = baseApp({ icon_emoji: '🎮' });
  const image = baseApp({ icon_url: '/app-icons/' + 'a'.repeat(32) });

  assert.equal(Home._desiredIconSrcFor(letter), `tile:${Home.WIDGET_ICON_GEN}:light:`);
  assert.equal(Home._desiredIconSrcFor(emoji), `tile:${Home.WIDGET_ICON_GEN}:light:🎮`);
  const imageSrc = Home._desiredIconSrcFor(image);

  dark = true;
  assert.equal(Home._desiredIconSrcFor(letter), `tile:${Home.WIDGET_ICON_GEN}:dark:`);
  assert.equal(Home._desiredIconSrcFor(emoji), `tile:${Home.WIDGET_ICON_GEN}:dark:🎮`);
  assert.equal(
    Home._desiredIconSrcFor(image), imageSrc,
    'image icons keep one scheme-independent marker'
  );
});
