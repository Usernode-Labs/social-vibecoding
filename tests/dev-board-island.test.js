// #1084 chunk G — the Dev board's React conversion — and #1085 chunk H, which
// folded it into the MAIN React tree.
//
// Chunks A–F converted regions that are present in the prerendered document, so
// `hydrateRoot(document.body, …)` adopts them and tests/shell-id-inventory.js
// can see their ids. The Dev surfaces are different: #app-content ships EMPTY
// and AppView.renderDevView() injects a surface at runtime, so chunk G mounted
// each one with its own createRoot, created by the still-legacy module. Chunk H
// replaced that with a PORTAL out of the one root main.tsx already owns
// (frontend/src/lib/legacy-portals.tsx) — which is what interim-root.ts's own
// header said chunk H would do. The mechanism keeps the same three invariants,
// and getting any of them wrong is a console.error or a leak rather than a
// visible bug, which is exactly why they are asserted here rather than left to
// review:
//
//   1. one portal per host, ever (two React owners of one container is a torn
//      tree; under chunk G the same mistake was a second createRoot on a live
//      container, i.e. a console.error, and a console error on any route fails
//      proposal checks);
//   2. the portal is torn down before anything replaces #app-content by hand;
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

const PORTALS = read('frontend/src/lib/legacy-portals.tsx');
const MOUNT = read('frontend/src/features/dev-board/mount.ts');
const FRAME = read('frontend/src/features/dev-board/board-frame.tsx');
const CHAT_FRAME = read('frontend/src/features/dev-board/chat-frame.tsx');
const SESSION_FRAME = read('frontend/src/features/dev-board/session-frame.tsx');
const STORE = read('frontend/src/features/dev-board/view-mode-store.ts');
// Streamlined Concept: the Board draws its own Kanban|Feed control now,
// inside the frame itself — there is no separate toggle module to read.
const MAIN = read('frontend/src/main.tsx');
const APP_VIEW = read('public/js/app-view.js');
const APP = read('public/js/app.js');
const SHELL = read('frontend/src/Shell.tsx');

// ── the mechanism's three invariants ─────────────────────────────────────

test('one portal per host: the registry is keyed by the host node', () => {
  assert.match(PORTALS, /const entries = new Map<Element, PortalEntry>\(\)/,
    'portals are held in a map keyed by the host element');
  // A second mount against a live host REPLACES that host's entry — never adds
  // a second one — so no container is ever rendered into twice.
  assert.match(
    PORTALS,
    /const existing = entries\.get\(host\);[\s\S]{0,1200}?entries\.set\(host, \{ host, node, seq: existing \? existing\.seq : \+\+seqCounter \}\);/,
    'mounting an already-mounted host updates its single entry'
  );
  // …and keeps its key, so React reconciles rather than remounting; a host that
  // comes back AFTER an unmount gets a new seq and therefore a fresh subtree.
  assert.match(PORTALS, /`legacy-portal-\$\{entry\.seq\}`/, 'seq is the portal key');
});

test('a FIRST mount replaces the host\'s existing content, like createRoot did', () => {
  // Chunk G's interim `createRoot(host).render()` cleared the container's
  // pre-existing children on its first render — documented React behaviour —
  // and the Dev surface swaps relied on it: the topic sub-view is still a
  // hand-written innerHTML template, so its markup is what sits in
  // #app-content when the user presses Back to the board. `createPortal`
  // APPENDS to its container instead, so without an explicit clear the board
  // mounts BELOW the stale topic markup and the Back button looks dead.
  const fn = PORTALS.slice(
    PORTALS.indexOf('export function mountLegacyPortal'),
    PORTALS.indexOf('export function unmountLegacyPortal')
  );
  assert.match(fn, /if \(!existing\) host\.replaceChildren\(\);/,
    'a first mount clears whatever the previous legacy surface left in the host');
  // …but ONLY a first mount: on a re-mount the children are React-owned, and
  // ripping them out from under the reconciler is the torn-tree failure the
  // whole mechanism exists to prevent.
  const clear = fn.indexOf('host.replaceChildren()');
  const set = fn.indexOf('entries.set(host,');
  assert.ok(clear !== -1 && set !== -1 && clear < set,
    'the clear happens before the entry is created, so the commit renders into an empty host');
});

test('#1085 chunk H: there is exactly ONE React root in the bundle', () => {
  // The whole reason the interim roots went away. `createRoot` on a container
  // that already has a root is a console.error, and a console error on any
  // route fails proposal checks — unreachable if nothing but main.tsx ever
  // creates a root, and main.tsx hydrates the one it is given.
  // Comment-stripped: both files explain in prose WHY createRoot is gone, which
  // is the point of those comments. What must be absent is the code.
  const portalCode = PORTALS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!portalCode.includes('createRoot'), 'the portal helper creates no root');
  assert.ok(!MOUNT.includes('createRoot'), 'mount.ts creates no root of its own');
  // `entry.node` reaches the host wrapped in an error boundary — see
  // lib/island-boundary.tsx: without one, a throw in ANY portalled region
  // unmounts the root, and the root is `document.body`.
  assert.match(PORTALS, /createPortal\(\s*\/\/[\s\S]*?createElement\(Island, \{ name: `portal:[\s\S]*?\}, entry\.node\),\s*\n\s*entry\.host,/,
    'the subtree is portalled into the host instead, inside its own boundary');
  assert.equal(MAIN.split('hydrateRoot(').length - 1, 1, 'main.tsx has the only root');
  // The retired helper is gone, not merely unused.
  assert.ok(!fs.existsSync(path.join(root, 'frontend/src/lib/interim-root.ts')),
    'lib/interim-root.ts is deleted');
  assert.ok(!MOUNT.includes('InterimRoot'), 'no caller still reaches for the old helper');
});

test('tear-down drops the registry entry, then republishes', () => {
  // Order matters: the entry must be gone from the snapshot React renders from
  // before that render runs, or the portal survives the flush.
  const fn = PORTALS.slice(PORTALS.indexOf('export function unmountLegacyPortal'));
  const del = fn.indexOf('entries.delete(host)');
  const commit = fn.indexOf('commit()');
  assert.ok(del !== -1 && commit !== -1 && del < commit, 'the entry is deleted before the commit');
  assert.match(PORTALS, /export function unmountAllLegacyPortals/,
    'a sweep exists for the surface-swap case');
  assert.match(PORTALS, /entries\.clear\(\);\s*\n\s*commit\(\);/,
    'the sweep clears every entry in one commit');
  // A no-op unmount must not schedule a render.
  assert.match(PORTALS, /if \(!entries\.delete\(host\)\) return;/, 'unknown hosts are a no-op');
  assert.match(PORTALS, /if \(!entries\.size\) return;/, 'an empty sweep is a no-op');
});

test('the mount is synchronous, because the legacy caller reads the DOM next', () => {
  assert.match(PORTALS, /function commit\(\): void \{\s*\n\s*flushSync\(publish\);/,
    'every publish runs inside flushSync');
  assert.match(PORTALS, /const live = useSyncExternalStore\(/,
    'the anchor component subscribes to the registry');
  // The anchor is in the main tree, and renders nothing itself.
  assert.match(SHELL, /<LegacyPortals \/>/, 'the anchor is rendered by <Shell/>');
  assert.match(SHELL, /import \{ LegacyPortals \} from '\.\/lib\/legacy-portals';/,
    'imported by the shell, so it is part of the prerendered tree');
});

test('no portal outlives its surface', () => {
  // Every hand-written replacement of #app-content retires the root first.
  // Three of them left after the topic sub-view stopped being one (below).
  const teardowns = APP_VIEW.split('AppView._teardownDevRoots();').length - 1;
  assert.ok(teardowns >= 3,
    `every #app-content writer retires the portal (found ${teardowns} call sites)`);
  assert.match(APP_VIEW, /_teardownDevRoots\(\) \{[\s\S]{0,600}?AppView\._reactDevBoard\(\)\?\.unmountAll\(\);/,
    'the teardown helper sweeps every live portal');
  // Two things the sweep alone cannot do, both added with the surfaces that
  // needed them: a body-mounted dialog's SCRIM is not a portal, so emptying
  // its card would leave an opaque overlay with no way out; and the App
  // tab's placeholder store would still hold the view its swept portal was
  // rendering.
  const teardown = APP_VIEW.slice(APP_VIEW.indexOf('_teardownDevRoots() {'));
  assert.match(teardown.slice(0, 700), /AppView\._dismissDevModals\(\);/,
    'an open dialog is dismissed, not left as an empty scrim');
  assert.match(teardown.slice(0, 700), /AppView\._reactAppStatus\(\)\?\.clear\(\);/,
    'and the placeholder view is forgotten with its portal');
  // Including closing the app screen entirely, which blanks #app-content.
  const close = APP.indexOf('AppView._teardownDevRoots();');
  assert.ok(close !== -1, 'closeApp retires the root before blanking #app-content');
  assert.ok(
    close < APP.indexOf("content.innerHTML = ''", close),
    'the teardown runs BEFORE the node is blanked'
  );
  // The topic sub-view USED to be the one Dev branch that had to retire the
  // root rather than re-render it, because it was still an innerHTML template.
  // It is features/dev-board/topic-frame.tsx now, so that branch is gone —
  // and with it the one Dev navigation that threw the board frame's state
  // away.
  assert.doesNotMatch(APP_VIEW, /subTab === 'topic' && ref && ref\.kind && ref\.id\) AppView\._teardownDevRoots/);
  assert.match(APP_VIEW, /mountTopicSubView\(content, \{/, 'the topic sub-view is mounted');

  // What replaces it for every host a caller is NOT in a position to know
  // about: a sub-view swap re-renders `#app-content`'s portal, and React
  // discards `#dev-chat-body` / `#dev-topic-thread` and everything under them
  // without telling their owners. Before this sweep, walking board → topic →
  // board → chat left two dead entries per hop and the count climbed without
  // bound.
  assert.match(PORTALS, /export function pruneDetachedLegacyPortals\(keep\?: Element \| null\): boolean \{/);
  assert.match(PORTALS, /if \(host === keep \|\| host\.isConnected\) continue;/,
    'an entry is dropped only when its host has genuinely left the document');
  assert.match(PORTALS, /pruneDetachedLegacyPortals\(host\);\n\s*const existing = entries\.get\(host\);/,
    'every mount sweeps first — a mount IS a surface swap');
  // …and a leak assertion is reachable from the bridge. The name kept its
  // chunk-G spelling because app-view.js calls it; it counts live portals now.
  assert.match(MOUNT, /rootCount\(\): number/, 'the bridge exposes a live-portal count');
  assert.match(MOUNT, /rootCount: legacyPortalCount,/, 'wired to the portal registry');
  assert.match(PORTALS, /export function legacyPortalCount\(\): number \{\s*\n\s*return entries\.size;/,
    'the count is the registry size — zero means nothing leaked');
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
  // AppView._repaintDevBody() replaces its innerHTML on every tab switch, so
  // rendering #dev-feed as a JSX child would make each view-mode re-render
  // reconcile against nodes the module has replaced.
  //
  // The WRAPPER OBJECT must be a module-level constant too, not an inline
  // `{{ __html: … }}` literal. React 19 diffs host props by REFERENCE and its
  // dangerouslySetInnerHTML setter assigns innerHTML unconditionally (the
  // __html string comparison React 18 did in diffProperties is gone), so an
  // inline literal — a fresh object every render — makes EVERY re-render of
  // the frame rewrite #dev-body back to the placeholder. The view-mode store
  // re-renders the frame on every tab click, which turned each switch into
  // "Loading…" forever: _repaintDevBody() painted, then React's commit
  // clobbered the paint.
  assert.match(
    FRAME,
    /id="dev-body"[\s\S]{0,200}dangerouslySetInnerHTML=\{DEV_BODY_INITIAL\}/,
    '#dev-body is filled from a module-constant {__html} object, not an inline literal'
  );
  assert.match(
    FRAME,
    /^const DEV_BODY_INITIAL = \{ __html: DEV_BODY_INITIAL_HTML \};$/m,
    'the wrapper object is module-level, so its identity is stable across renders'
  );
  // Constant means constant: the string is a module-level const with no
  // interpolation, so React writes it once and never looks inside again.
  const decl = /^const DEV_BODY_INITIAL_HTML =\n([\s\S]*?);$/m.exec(FRAME);
  assert.ok(decl, 'DEV_BODY_INITIAL_HTML is a module-level constant');
  assert.ok(!decl[1].includes('${'), 'no interpolation — the string never changes');
  // Byte-for-byte what the template put there.
  assert.ok(decl[1].includes('<div id="dev-feed">'), 'still ships #dev-feed');
  // The placeholder is a SKELETON now, not the word "Loading…". Eleven
  // characters of grey in the corner of an empty screen is not a state a
  // reader notices, and the blank beside it reads as an empty board rather
  // than a pending one — which is the report this answers. The rows are built
  // by card/skeleton.tsx so the string here and the components the board
  // paints a moment later cannot drift apart.
  assert.ok(decl[1].includes('skeletonListHtml('),
    'the placeholder rows come from the shared builder');
  assert.ok(!decl[1].includes('Loading…'),
    'the bare "Loading…" text is not what stands in for the feed any more');
  const SKELETON = read('frontend/src/features/dev-board/card/skeleton.tsx');
  assert.match(SKELETON, /role="status"/,
    'the skeleton carries one live-region label for the decorative rows');
  assert.match(SKELETON, /aria-hidden="true"/,
    'the bars themselves are hidden from assistive tech');
  // #gc-merged is NOT here any more: THE UI OVERHAUL folded completed work
  // into the Feed's own stream (AppView._feedItems), so the second node the
  // template used to ship — the "Completed" block parked below the feed — is
  // gone. The kanban Done column renders its own.
  assert.ok(!decl[1].includes('gc-merged'),
    'the retired Completed block must not come back as a second host');
  // The module still owns it.
  assert.match(APP_VIEW, /_repaintDevBody\(\)/, '_repaintDevBody is still the swap owner');
});

test('the other legacy-owned leaves render empty or constant, never live', () => {
  // #dev-locked-notice is NOT on this list any more. It was the fragile member
  // of it — the module wrote its innerHTML and toggled `hidden`, and that only
  // worked because React rendered the className as a constant it never
  // rewrote. #1191 made it a one-boolean store instead, so the node has one
  // writer; the banner's own coverage is below.
  assert.doesNotMatch(FRAME, /<div id="dev-locked-notice" className="px-3 pt-2 hidden"><\/div>/);
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

test('the locked-app banner has one writer', () => {
  // The module publishes server truth (`_proposalsCtx.locked`, loaded with the
  // feed) and the frame draws the banner or does not — including its `hidden`,
  // which used to be the module's `classList.toggle` over React's constant.
  assert.match(FRAME, /const \{ locked \} = useStoreState<LockedNoticeState>\(lockedNoticeStore\);/);
  assert.match(FRAME, /id="dev-locked-notice" className=\{locked \? 'px-3 pt-2' : 'px-3 pt-2 hidden'\}/);
  assert.match(FRAME, /App is locked — an admin must approve any proposal before it applies\./);
  const code = APP_VIEW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const fn = code.match(/_renderLockedNotice\(\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(fn, '_renderLockedNotice() found');
  assert.doesNotMatch(fn[1], /innerHTML|classList/, 'the module writes neither the markup nor the class');
  assert.match(fn[1], /publishLockedNotice\(\s*!!\(AppView\._proposalsCtx && AppView\._proposalsCtx\.locked\)\)/);
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
  // Streamlined Concept: the Board draws its own Kanban|Feed control again
  // (see BoardViewToggle in the frame), so the FRAME is the store's reader.
  assert.match(FRAME, /useDevViewMode\(\)/, 'the board control reads the store');
  // The click still runs the module's behaviour, unchanged.
  assert.match(APP_VIEW, /_selectViewMode\(v\) \{/, 'the click handler lives in the module');
  assert.match(APP_VIEW, /AppView\._setViewMode\(mode\);\s*\n\s*\/\/[^\n]*\n\s*AppView\._repaintDevBody\(\);/,
    'a mode change still persists and repaints, in that order');
  // THE UI OVERHAUL cut four icon buttons down to two labelled tabs; the
  // follow-up to #1367 removed the strip entirely, because the header's
  // App/Feed/Kanban toggle offers the same two destinations plus the app
  // itself. Every id it drew must be really gone rather than merely unstyled.
  for (const id of ['dev-view-feed', 'dev-view-kanban', 'dev-view-tabs',
    'dev-view-list', 'dev-view-pm', 'dev-view-report']) {
    assert.ok(!FRAME.includes(`id: '${id}'`) && !FRAME.includes(`id="${id}"`),
      `${id} was retired with the dev-screen tab strip`);
  }
  // The control is still a tablist reflecting the live mode, so the active
  // view reaches the a11y tree exactly as the strip did.
  assert.match(FRAME, /role="tablist"/, 'the board control is a tablist');
  assert.match(FRAME, /aria-selected=\{mode === '(feed|kanban)' \? 'true' : 'false'\}/,
    'aria-selected reflects the active segment');
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
    // _loadChatCardPreview left this list with the General-chat card
    // (Streamlined Concept): Activity is an app-context sheet row and a
    // first-class hash, so the board offers no second door to it.
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
  // #app-content is still the empty host the whole mechanism depends on. Since
  // #1085 chunk H it is rendered by the #app-view island rather than inline in
  // Shell.tsx — same markup, same emptiness, one level of indirection.
  const APP_VIEW_ISLAND = read('frontend/src/features/app-frame/app-view-island.tsx');
  assert.match(SHELL, /<AppViewIsland \/>/, '#app-view is rendered by the shell');
  assert.match(APP_VIEW_ISLAND, /id="app-content"/, '#app-content is still rendered');
  assert.match(APP_VIEW_ISLAND, /id="app-content"[\s\S]{0,220}?\{\/\* Tab content renders here \*\/\}/,
    '#app-content is still EMPTY — the interim roots and every innerHTML render fill it');
});
