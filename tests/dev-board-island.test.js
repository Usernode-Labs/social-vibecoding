// #1084 chunk G — the Dev board's React conversion, and the INTERIM ROOT
// mechanism it introduces (chunk A's mechanism 4, #1078).
//
// Chunks A–F converted regions that are present in the prerendered document, so
// `hydrateRoot(document.body, …)` adopts them and tests/shell-id-inventory.js
// can see their ids. The Dev surfaces are different: #app-content ships EMPTY
// and AppView.renderDevView() injects a surface at runtime, so each one gets its
// own createRoot, created by the still-legacy module. That mechanism has three
// invariants, and getting any of them wrong is a console.error or a leak rather
// than a visible bug — which is exactly why they are asserted here rather than
// left to review:
//
//   1. one root per host, ever (a second createRoot on a live container is a
//      console.error, and a console error on any route fails proposal checks);
//   2. the root is torn down before anything replaces #app-content by hand;
//   3. the mount is synchronous, because every caller reads the DOM on its
//      next line.
//
// Plus the ownership rule the conversion itself has to respect: React renders
// the frame, and every subtree a public/js/** module writes into stays that
// module's host.
//
// These are source-level assertions. The tests run with no
// frontend/node_modules — the root install never touches that workspace — so
// there is no React here to render with, which is the same constraint
// tests/standings-screen.test.js works under.
//
// Run with: node --test tests/dev-board-island.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const INTERIM = read('frontend/src/lib/interim-root.ts');
const MOUNT = read('frontend/src/features/dev-board/mount.ts');
const FRAME = read('frontend/src/features/dev-board/board-frame.tsx');
const CHAT_FRAME = read('frontend/src/features/dev-board/chat-frame.tsx');
const SESSION_FRAME = read('frontend/src/features/dev-board/session-frame.tsx');
const STORE = read('frontend/src/features/dev-board/view-mode-store.ts');
const MAIN = read('frontend/src/main.tsx');
const APP_VIEW = read('public/js/app-view.js');
const APP = read('public/js/app.js');
const SHELL = read('frontend/src/Shell.tsx');

// ── mechanism 4: the helper's three invariants ───────────────────────────

test('one root per host: the registry is keyed by the host node', () => {
  assert.match(INTERIM, /new WeakMap<Element, Root>\(\)/,
    'roots are held in a WeakMap keyed by the host element');
  // A second mount against a live host must REUSE the root, not create one.
  assert.match(
    INTERIM,
    /let root = roots\.get\(host\);\s*\n\s*if \(!root\) \{\s*\n\s*root = createRoot\(host\)/,
    'createRoot only runs when the host has no root yet'
  );
  // Exactly one createRoot CALL, so there is no second path around the map.
  // (The name also appears in the header comment, hence matching the call.)
  assert.equal(INTERIM.split('createRoot(host)').length - 1, 1,
    'exactly one createRoot call site');
  // WeakMap, not Map: a discarded host must not be pinned by the registry.
  assert.ok(!/new Map<Element/.test(INTERIM), 'hosts are not strongly held by the registry');
});

test('tear-down deletes the registry entry before unmounting', () => {
  // Order matters: unmount() can run effects that re-enter, and a stale entry
  // would then be handed a root that is already unmounting.
  const fn = INTERIM.slice(INTERIM.indexOf('export function unmountInterimRoot'));
  const del = fn.indexOf('roots.delete(host)');
  const un = fn.indexOf('root.unmount()');
  assert.ok(del !== -1 && un !== -1 && del < un, 'the entry is deleted before unmount()');
  assert.match(INTERIM, /export function unmountAllInterimRoots/,
    'a sweep exists for the surface-swap case');
  // The sweep iterates a COPY — unmountInterimRoot mutates the set it walks.
  assert.match(INTERIM, /for \(const host of \[\.\.\.hosts\]\) unmountInterimRoot\(host\)/,
    'the sweep iterates a copy of the host set');
});

test('the mount is synchronous, because the legacy caller reads the DOM next', () => {
  assert.match(INTERIM, /flushSync\(\(\) => \{\s*\n\s*\(root as Root\)\.render\(element\);/,
    'render runs inside flushSync');
  // Every mount goes through the helper — no component renders itself.
  for (const [name, src] of [['mount.ts', MOUNT]]) {
    assert.ok(!src.includes('createRoot'), `${name} does not create roots of its own`);
  }
});

test('no interim root outlives its surface', () => {
  // Every hand-written replacement of #app-content retires the root first.
  const teardowns = APP_VIEW.split('AppView._teardownDevRoots();').length - 1;
  assert.ok(teardowns >= 4,
    `every #app-content writer retires the root (found ${teardowns} call sites)`);
  assert.match(APP_VIEW, /_teardownDevRoots\(\) \{\s*\n\s*AppView\._reactDevBoard\(\)\?\.unmountAll\(\);/,
    'the teardown helper sweeps every live root');
  // Including closing the app screen entirely, which blanks #app-content.
  const close = APP.indexOf('AppView._teardownDevRoots();');
  assert.ok(close !== -1, 'closeApp retires the root before blanking #app-content');
  assert.ok(
    close < APP.indexOf("content.innerHTML = ''", close),
    'the teardown runs BEFORE the node is blanked'
  );
  // The topic sub-view is still a template, so it is the one Dev branch that
  // must retire the root rather than re-render it.
  assert.match(
    APP_VIEW,
    /if \(subTab === 'topic' && ref && ref\.kind && ref\.id\) AppView\._teardownDevRoots\(\);/,
    'the still-templated topic branch retires the root'
  );
  // …and a leak assertion is reachable from the bridge.
  assert.match(MOUNT, /rootCount\(\): number/, 'the bridge exposes a live-root count');
});

// ── the seam: published at module scope, not from an effect ──────────────

test('the bridge is published before hydration, and guarded for the SSG pass', () => {
  assert.match(MAIN, /import '\.\/features\/dev-board\/mount';/,
    'main.tsx imports the mount module for its side effect');
  // Above hydrateRoot, or app-view.js could reach renderDevView first.
  assert.ok(
    MAIN.indexOf("import './features/dev-board/mount';") < MAIN.indexOf('hydrateRoot('),
    'the publication happens before hydration'
  );
  assert.match(MOUNT, /if \(typeof window !== 'undefined'\) \{/,
    'the publication is guarded — the prerender pass evaluates this module in Node');
  assert.match(MOUNT, /bridge\.devBoard = devBoardBridge;/, 'published as UsernodeReact.devBoard');
  // The legacy side reaches it optionally, so the vm-context tests (which load
  // app-view.js with no bundle) do not throw.
  assert.match(APP_VIEW, /AppView\._reactDevBoard\(\)\?\.mountBoard\(content, \{/,
    'renderDevView mounts the board through the bridge');
  assert.match(APP_VIEW, /AppView\._reactDevBoard\(\)\?\.mountChatSubView\(content, \{/,
    'the general-chat sub-view mounts through the bridge');
  assert.match(APP_VIEW, /AppView\._reactDevBoard\(\)\?\.mountSessionShell\(content\);/,
    'the session shell mounts through the bridge');
});

// ── the conversion: React owns the frame, modules keep their hosts ───────

test('#dev-body stays a legacy host — a constant dangerouslySetInnerHTML', () => {
  // AppView._repaintDevBody() replaces its innerHTML on every mode switch, so
  // rendering #dev-feed / #gc-merged as JSX children would make each
  // view-mode re-render reconcile against nodes the module has replaced.
  assert.match(
    FRAME,
    /id="dev-body"[\s\S]{0,200}dangerouslySetInnerHTML=\{\{ __html: DEV_BODY_INITIAL_HTML \}\}/,
    '#dev-body is filled from a constant HTML string'
  );
  // Constant means constant: the string is a module-level const with no
  // interpolation, so React writes it once and never looks inside again.
  const decl = /^const DEV_BODY_INITIAL_HTML =\n([\s\S]*?);$/m.exec(FRAME);
  assert.ok(decl, 'DEV_BODY_INITIAL_HTML is a module-level constant');
  assert.ok(!decl[1].includes('${'), 'no interpolation — the string never changes');
  // Byte-for-byte what the template put there.
  assert.ok(decl[1].includes('<div id="dev-feed">'), 'still ships #dev-feed');
  assert.ok(decl[1].includes('Loading…'), 'still ships the loading placeholder');
  assert.ok(decl[1].includes('<div id="gc-merged" class="mt-4"></div>'), 'still ships #gc-merged');
  // The module still owns it.
  assert.match(APP_VIEW, /_repaintDevBody\(\)/, '_repaintDevBody is still the swap owner');
});

test('the other legacy-owned leaves render empty or constant, never live', () => {
  // #dev-locked-notice — the module writes its innerHTML and toggles `hidden`.
  // React may render its className ONCE (a constant prop is never rewritten),
  // but must not render children into it.
  assert.match(FRAME, /<div id="dev-locked-notice" className="px-3 pt-2 hidden"><\/div>/,
    'the locked notice is an empty leaf with a constant className');
  // #dc-secrets-state — refreshDevChatSecretsState writes its textContent.
  assert.match(FRAME, /id="dc-secrets-state"[\s\S]{0,140}?><\/span>/,
    'the secrets-state slot is an empty leaf');
  // #dev-chat-body / #dev-section — hosts for renderGroupChatTab and
  // renderDevChatTab respectively.
  assert.match(CHAT_FRAME, /<div id="dev-chat-body" className="flex-1 min-h-0"><\/div>/,
    '#dev-chat-body is an empty host');
  assert.match(SESSION_FRAME, /id="dev-section"/, '#dev-section is rendered');
  assert.ok(!/dangerouslySetInnerHTML=/.test(SESSION_FRAME),
    '#dev-section ships empty, so it needs no constant string to keep React out');
});

test('the view toggle is real React state, and the className writer is gone', () => {
  // _updateViewToggleUI assigned btn.className outright — two owners of one
  // attribute, which is the conflict the migration forbids.
  // Asserted against comment-stripped source: all four names still appear in
  // the comment block that records WHY each one went, which is the point of
  // that comment. What must be gone is the code.
  const code = APP_VIEW.replace(/^\s*\/\/.*$/gm, '');
  for (const gone of [
    '_updateViewToggleUI',
    '_renderViewToggle',
    '_wireViewToggle',
    '_viewToggleBtnCls',
  ]) {
    assert.ok(!code.includes(gone), `${gone} has no definition or call site left`);
  }
  // What replaced it: the module publishes, React renders.
  assert.match(APP_VIEW, /AppView\._reactDevBoard\(\)\?\.publishViewMode\(next\);/,
    '_setViewMode publishes the new mode');
  assert.match(STORE, /useSyncExternalStore\(subscribe, getSnapshot/,
    'the frame subscribes through useSyncExternalStore');
  assert.match(FRAME, /const mode = useDevViewMode\(\);/, 'the frame reads the store');
  // The click still runs the module's behaviour, unchanged.
  assert.match(APP_VIEW, /_selectViewMode\(v\) \{/, 'the click handler lives in the module');
  assert.match(APP_VIEW, /AppView\._setViewMode\(mode\);\s*\n\s*\/\/[^\n]*\n\s*AppView\._repaintDevBody\(\);/,
    'a mode change still persists and repaints, in that order');
  // All four buttons, with their ids and aria-pressed, survive.
  for (const id of ['dev-view-list', 'dev-view-kanban', 'dev-view-pm', 'dev-view-report']) {
    assert.ok(FRAME.includes(`id: '${id}'`), `${id} still rendered`);
  }
  assert.match(FRAME, /aria-pressed=\{active === mode\}/, 'aria-pressed still reflects the mode');
  // Seeded from the module before the first paint, so ?view=kanban does not
  // flash list first.
  assert.match(MOUNT, /publishViewMode\(options\.viewMode\);/, 'the store is seeded at mount');
  assert.match(APP_VIEW, /viewMode: AppView._getViewMode\(\)/, 'seeded from the resolved mode');
});

test('the wiring the module still owns is untouched', () => {
  // Listeners and `hidden` toggles are the two mutations the migration
  // sanctions on React-rendered nodes, so none of this had to move.
  for (const call of [
    'AppView._wirePlusMenu(content);',
    'PlatformUI.pullToRefresh(devScroll, () => AppView._loadDevFeed());',
    'AppView._attrInit();',
    'AppView._cardMenuInit();',
    'AppView._loadChatCardPreview();',
  ]) {
    assert.ok(APP_VIEW.includes(call), `${call} still runs after the mount`);
  }
  // The plus menu's own idioms: `hidden` for desktop, an action sheet for touch.
  assert.match(APP_VIEW, /menu\.classList\.toggle\('hidden'\)/, 'desktop dropdown still toggles hidden');
  assert.match(APP_VIEW, /menu\.querySelectorAll\('button\[data-plus\], \[data-plus-group\]'\)/,
    'the touch action sheet still collects the rows in DOM order');
  // Which means the headings must stay non-buttons carrying data-plus-group.
  assert.match(FRAME, /data-plus-group=\{groupKey\}/, 'headings carry data-plus-group');
  assert.match(FRAME, /<div\s+data-plus-group=/, 'headings are divs, not buttons');
  // The delegated card-open handler is still bound on the stable #dev-body.
  assert.match(APP_VIEW, /const bodyEl = document\.getElementById\('dev-body'\);/,
    'the delegated handler still binds on #dev-body');
});

// ── the prerendered document is untouched ────────────────────────────────

test('no Dev-board id leaked into the prerendered shell', () => {
  // The whole point of an interim root is that these surfaces are NOT in the
  // document. If one appeared in <Shell/>, the frozen markup baseline would
  // need an ADDED_IDS entry — and the region would render before its data,
  // which is a hydration mismatch.
  for (const id of [
    'dev-forum-scroll', 'dev-body', 'dev-feed', 'gc-merged', 'dev-plus-menu',
    'dev-plus-btn', 'dev-chat-card', 'dev-locked-notice', 'dev-section',
    'dev-chat-body', 'dev-chat-back', 'dc-secrets-state',
  ]) {
    assert.ok(!SHELL.includes(`"${id}"`), `${id} is not in the prerendered shell`);
  }
  // #app-content is still the empty host the whole mechanism depends on.
  assert.match(SHELL, /id="app-content"/, '#app-content is still rendered by the shell');
});
