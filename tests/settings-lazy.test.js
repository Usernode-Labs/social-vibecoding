// The Settings module as a lazy chunk (frontend/src/features/settings/).
//
// ./settings.js and the sixteen panes are ~180KB of the shell bundle that
// every load of every screen used to download, parse and compile so that
// the Settings screen could open. They are one dynamically imported chunk
// now (./settings-chunk.ts), behind an eager façade (./facade.js) that owns
// the two things the shell needs from Settings on a load that never opens
// the screen: the boot read into Settings.state, and the per-navigation
// isOpen()/close()/syncChrome() calls app.js makes.
//
// What has to hold, and is pinned here:
//   1. the façade's boot read is the SAME read settings.js makes — field for
//      field — so a reader of Settings.state cannot tell which one answered;
//   2. settings.js takes over window.Settings sharing the façade's state
//      object, so a read still in flight lands where everyone looks;
//   3. the panes are committed synchronously when the chunk arrives, and
//      init() runs where the panes are, so Settings.open() keeps the
//      synchronous contract lib/mount-on-reveal.ts gives it;
//   4. the boot triggers that must fire before the screen is ever opened
//      (the first-run terms prompt) stay in the shell, not in the chunk;
//   5. every image copies every chunk, not the entry alone;
//   6. a legacy-owned host inside a pane is repainted when the pane mounts,
//      because deferring the panes moved them past the boot answer.
//
// Run with: node --test tests/settings-lazy.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SETTINGS_DIR = 'frontend/src/features/settings';
const facadeJs = read(`${SETTINGS_DIR}/facade.js`);
const settingsJs = read(`${SETTINGS_DIR}/settings.js`);
const indexTsx = read(`${SETTINGS_DIR}/index.tsx`);
const chunkTs = read(`${SETTINGS_DIR}/settings-chunk.ts`);
const mountTs = read(`${SETTINGS_DIR}/mount.ts`);
const sectionsTsx = read(`${SETTINGS_DIR}/sections/index.tsx`);
const aboutTsx = read(`${SETTINGS_DIR}/sections/about.tsx`);

// The `key: default` pairs of an object literal, in order.
function literalKeys(src, start) {
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (; end < src.length; end++) {
    if (src[end] === '{') depth += 1;
    else if (src[end] === '}') { depth -= 1; if (depth === 0) break; }
  }
  return [...src.slice(open + 1, end).matchAll(/(\w+):\s*([^,\n]+)/g)].map((m) => [m[1], m[2].trim()]);
}

// The `X.field = …` assignments inside a function body.
function assignedFields(src, header, target) {
  const start = src.indexOf(header);
  assert.ok(start > -1, `found ${header}`);
  // The method ends at the first `},` back at the header's own indentation.
  const indent = header.match(/^\s*/)[0];
  const end = src.indexOf(`\n${indent}},`, start);
  const body = src.slice(start, end > -1 ? end : src.length);
  return [...body.matchAll(new RegExp(`${target}\\.(\\w+) = `, 'g'))].map((m) => m[1]);
}

// ── 1. The same boot read ──────────────────────────────────────────────

test('the façade\'s state has the same fields and defaults as settings.js', () => {
  const facade = literalKeys(facadeJs, facadeJs.indexOf('const state = '));
  const real = literalKeys(settingsJs, settingsJs.indexOf('    state: {'));
  assert.ok(real.length >= 10, `settings.js state literal parsed (${real.length} fields)`);
  assert.deepEqual(facade, real, 'facade.js `state` must mirror settings.js `state` field for field');
});

test('the façade\'s refresh() assigns exactly the fields settings.js\'s refresh() assigns', () => {
  const facade = assignedFields(facadeJs, '  async refresh() {', 'state');
  const real = assignedFields(settingsJs, '    async refresh() {', 'this\\.state');
  assert.ok(real.length >= 10, `settings.js refresh parsed (${real.length} assignments)`);
  assert.deepEqual(facade, real);
  // And primes the CLI-auth memo from the same payload, like the original.
  assert.match(facadeJs, /Promise\.resolve\(u\.cliAuthEnabled !== false\)/);
  assert.match(settingsJs, /this\._cliAuthPromise = Promise\.resolve\(j\.user\?\.cliAuthEnabled !== false\);/);
  // Joining the boot read, not repeating it — and ?demo=1 reading for itself.
  assert.match(facadeJs, /window\.App\.bootSession\(\)/);
  assert.match(facadeJs, /fetch\(`\/api\/auth\/me\$\{meDemoQ\}`, \{ credentials: 'same-origin' \}\)/);
  // The byok dot is published from here, so it does not wait for the chunk.
  assert.match(facadeJs, /publish\?\.\('switcher-byok-dot', !!state\.hasApiKey\)/);
});

test('the façade reads /api/auth/me into state and publishes the dot, without loading anything', async () => {
  const published = [];
  const budget = { calls: 0 };
  const boot = { user: { hasApiKey: true, keyLast4: '4242', walletLinkEnabled: true, locale: 'fr', cliAuthEnabled: false } };
  const win = {
    location: { search: '' },
    App: { bootSession: async () => boot, Visibility: { publish: (k, v) => published.push([k, v]) } },
    DevChat: { renderBudget: () => { budget.calls += 1; } },
    addEventListener() {},
  };
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  globalThis.window = win;
  globalThis.document = { addEventListener() {} };
  try {
    const mod = loadTsx(`${SETTINGS_DIR}/facade.js`);
    const S = win.Settings;
    assert.ok(S && S.__facade, 'publishes window.Settings at module scope');
    assert.equal(S, mod.SettingsFacade);
    // The per-navigation surface answers without a chunk.
    assert.equal(S.isOpen(), false);
    assert.equal(S.close(), undefined);
    assert.equal(S.syncChrome(), undefined);
    assert.equal(S._cliTokensDemo(), false);
    assert.equal(S.state.hasApiKey, false, 'defaults until the read lands');
    await S.refresh();
    assert.equal(S.state.hasApiKey, true);
    assert.equal(S.state.keyLast4, '4242');
    assert.equal(S.state.walletLinkEnabled, true);
    assert.equal(S.state.locale, 'fr');
    assert.equal(await S._cliAuthPromise, false, 'the CLI-auth memo is primed from the same payload');
    assert.deepEqual(published, [['switcher-byok-dot', true]]);
    assert.equal(budget.calls, 1, 'dev-chat is told to repaint its budget indicator');
    assert.equal(mod.settingsChunkStore.get().Sections, null, 'no chunk was loaded for any of this');
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
  }
});

// ── 2. The takeover ────────────────────────────────────────────────────

test('settings.js takes over window.Settings sharing the façade\'s state object', () => {
  const tail = settingsJs.slice(settingsJs.lastIndexOf("if (typeof window !== 'undefined') {"));
  assert.match(tail, /const facade = window\.Settings;/);
  assert.match(tail, /if \(facade && facade\.__facade\) \{\s*Settings\.state = facade\.state;/,
    'the OBJECT is adopted, not copied — a read resolving after the takeover must land where readers look');
  assert.match(tail, /Settings\._cliAuthPromise = facade\._cliAuthPromise \|\| null;/);
  assert.match(tail, /window\.Settings = Settings;/);
  // And the façade never clobbers a module that got there first.
  assert.match(facadeJs, /if \(typeof window !== 'undefined' && !window\.Settings\) window\.Settings = Facade;/);
  // A read that resolves after the takeover still primes the module's memo.
  assert.match(facadeJs, /if \(window\.Settings && window\.Settings !== Facade\) window\.Settings\._cliAuthPromise = cliAuth;/);
});

// ── 3. The synchronous open() contract ─────────────────────────────────

test('the chunk commits the panes with flushSync before a forwarded open() runs', () => {
  assert.match(facadeJs, /settingsChunkStore\.setFlush\(flushSync\);/);
  const load = facadeJs.slice(facadeJs.indexOf('export function ensureSettings()'), facadeJs.indexOf('export function prefetchSettings()'));
  assert.match(load, /import\('\.\/settings-chunk\.ts'\)\.then\(\(m\) => \{\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*settingsChunkStore\.set\(\{ Sections: m\.SettingsSections, failed: false \}\);\s*ready = true;/,
    'panes first, synchronously; then the module is the answer');
  assert.match(load, /chunk = null;/, 'a failed load leaves the next open free to retry');
  // open()/route() forward through the loaded module, and never re-enter a
  // screen the viewer has already left.
  assert.match(facadeJs, /open\(section, opts\) \{\s*whenLoaded\(\(real\) => \{\s*if \(window\.App && !window\.App\._inSettings\) return;\s*real\.open\(section, opts\);/);
  assert.match(facadeJs, /if \(opts && opts\.chrome === false\) real\.syncChrome\(\);/,
    'the header write navigateToSettings delegated to syncChrome() is made up once the module is in');
  assert.match(facadeJs, /route\(section\) \{\s*whenLoaded\(\(real\) => \{\s*if \(window\.App && !window\.App\._inSettings\) return;\s*real\.route\(section\);/);
  assert.match(facadeJs, /showTermsSheet\(onAccepted, opts\) \{\s*return whenLoaded\(\(real\) => real\.showTermsSheet\(onAccepted, opts\)\);/);
  assert.match(facadeJs, /async logout\(\) \{\s*return whenLoaded\(\(real\) => real\.logout\(\)\);/);
});

test('the chassis gates the panes on the chunk, and init() runs where the panes are', () => {
  assert.match(indexTsx, /import \{ ensureSettings, prefetchSettings, settingsChunkStore \} from '\.\/facade\.js';/);
  assert.doesNotMatch(indexTsx, /from '\.\/sections'/, 'the panes must not be a static import of the entry');
  assert.doesNotMatch(indexTsx, /import '\.\/mount'/, 'nor settings.js (which ./mount imports)');
  assert.match(indexTsx, /\{mounted && Sections \? <Sections \/> : null\}/);
  assert.match(indexTsx, /if \(mounted\) ensureSettings\(\);/, 'a reveal without open() still asks for the module');
  assert.match(indexTsx, /Settings could not be loaded\./, 'a failed load says so in the host instead of leaving it blank');
  assert.match(sectionsTsx, /export function SettingsSections\(\) \{\n[\s\S]{0,900}?useIsomorphicLayoutEffect\(\(\) => \{\n\s*window\.Settings\?\.init\?\.\(\);\n\s*\}, \[\]\);/,
    'init() binds by id once the panes exist: a layout effect of the panes component');
  assert.match(chunkTs, /^import '\.\/mount';/m, 'the chunk evaluates settings.js (via ./mount) …');
  assert.match(chunkTs, /export \{ SettingsSections \} from '\.\/sections';/, '… and carries the panes');
  assert.ok(chunkTs.indexOf("import './mount'") < chunkTs.indexOf("from './sections'"), 'module before panes');
});

// ── 4. What stays in the shell ─────────────────────────────────────────

test('the boot-time triggers and the nav islands stay in the entry', () => {
  assert.match(indexTsx, /import '\.\/terms-first-run\.js';/, 'the first-run terms prompt listens for sv:authed at boot');
  assert.doesNotMatch(mountTs, /import '\.\/terms-first-run\.js';/, 'so it must not ride the chunk');
  assert.match(indexTsx, /import \{ SettingsMobileMenu, SettingsNavDesktop \} from '\.\/settings-nav';/,
    'the two nav hosts are in the prerendered document and stay React-owned from the entry');
  // The idle prefetch: signed-in viewers only, never on a shot/demo route.
  const prefetch = facadeJs.slice(facadeJs.indexOf('export function prefetchSettings()'), facadeJs.indexOf('// ── The boot read'));
  assert.match(prefetch, /if \(q\.get\('shot'\) \|\| q\.get\('demo'\)\) return;/);
  // Idle time is asked for only AFTER the boot: requestIdleCallback fires
  // inside a boot's network waits, and a chunk parsed there lands on the
  // first paint (measured: ~700ms into a 1,200ms board boot at 4x CPU).
  assert.match(prefetch, /const whenIdle = \(\) => afterBoot\(\(\) => \{\s*if \(typeof requestIdleCallback === 'function'\) requestIdleCallback\(start, \{ timeout: 20000 \}\);/);
  assert.match(facadeJs, /const PREFETCH_DELAY_MS = 6000;/);
  assert.match(facadeJs, /function afterBoot\(fn\) \{\s*const later = \(\) => setTimeout\(fn, PREFETCH_DELAY_MS\);\s*if \(document\.readyState === 'complete'\) later\(\);\s*else window\.addEventListener\('load', later, \{ once: true \}\);/);
  assert.match(prefetch, /document\.addEventListener\('sv:authed', whenIdle, \{ once: true \}\);/);
  assert.match(indexTsx, /window\.Settings\?\.refresh\?\.\(\);\n\s*prefetchSettings\(\);/, 'armed from the chassis at hydration');
});

// ── 5. Every image, every chunk ────────────────────────────────────────

test('the chunk is a lazy route chunk: unlisted in the precache, copied by every image', () => {
  const sw = require('../public/sw.js');
  assert.ok(!sw.SHELL_ASSETS.some((p) => p.includes('settings-chunk')), 'not precached — the module graph loads it');
  assert.match(read('public/sw.js'), /shell-settings-chunk\.js/, 'but named in the LAZY CHUNKS note');
  assert.match(read('Dockerfile'), /COPY --from=shell \/build\/public\/shell\/assets\/ \.\/public\/shell\/assets\//);
  assert.match(read('Dockerfile.kubernetes'), /COPY --chown=node:node --from=shell \/build\/public\/shell\/assets\/ \.\/public\/shell\/assets\//,
    'the Kubernetes image copied shell.js alone, which left every lazy chunk out of it');
  assert.match(read('frontend/vite.config.ts'), /chunkFileNames: 'assets\/shell-\[name\]\.js'/);
});

// ── 6. A legacy-owned host, repainted when its pane mounts ─────────────

test('Settings → About asks app.js to repaint the platform pill on mount', () => {
  // The bug this pins, found on the staging preview and reproduced in a
  // browser: app.js paints #platform-version-pill-slot from /api/version once
  // at boot and then every 10s, and #1504 made the panes mount on first
  // reveal. Deferring the module widened the gap between those two enough
  // that the boot answer always landed BEFORE the host existed — the paint
  // went nowhere and the row sat blank for up to ten seconds (measured:
  // 10.4s to paint, against 0.46s before the split). The pane asks for the
  // answer app.js already has, so mounting after it is no longer a race.
  const row = aboutTsx.slice(aboutTsx.indexOf('function PlatformVersionRow()'),
    aboutTsx.indexOf('export function AboutSection()'));
  assert.match(row, /useIsomorphicLayoutEffect\(\(\) => \{/,
    'a mount effect, so the paint happens in the same commit that put the host in the document');
  assert.match(row, /if \(App\?\._lastVersionInfo\) App\.renderPlatformVersionPill\?\.\(App\._lastVersionInfo\);/,
    "app.js's own last answer, painted the way its prefetch-settled repaint does");
  assert.match(row, /\}, \[\]\);/, 'once, on mount — the 10s poll owns every later repaint');
  assert.match(aboutTsx, /<PlatformVersionRow \/>/);
});

test('the About pane still renders the pill slot EMPTY, as app.js\'s host', () => {
  // The other half of the same rule: React renders the box and never what
  // goes in it. A pane that rendered a pill of its own would be a second
  // owner of that node, and the repaint above would fight it.
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const { AboutSection } = loadTsx(`${SETTINGS_DIR}/sections/about.tsx`);
  const html = renderToHtml(createElement(AboutSection, {}));
  const slot = html.slice(html.indexOf('id="platform-version-pill-slot"'));
  const inner = slot.slice(slot.indexOf('>') + 1, slot.indexOf('</span>'));
  assert.equal(inner.trim(), '', `the slot must render empty, got ${JSON.stringify(inner)}`);
  assert.ok(!html.includes('drawer-ver drawer-ver--'),
    'no pill variant class: those are app.js\'s to write');
  assert.match(html, /id="drawer-row-platform-version"/);
});
