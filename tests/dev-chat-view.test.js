// `#dc-view` — the dev chat's whole screen, as a React island.
//
// This was the LAST string in dev-chat.js: `renderChatView` assigned
// `#dc-view.innerHTML` and then mounted five portals into the hosts that
// assignment had just written — the session header, the four banners, the
// transcript, the composer, and (on the other branch) the app's session
// list. Each of those was a host-is-mine, children-are-React's seam, and
// each existed only because the SKELETON around it was still a string.
//
// Two things follow, and this file pins both:
//
//   1. The five are ordinary children now, so their `mount*` bridge methods
//      are gone and only `publish*` crosses the seam.
//   2. A re-render is a RECONCILE. `renderChatView` runs on every status
//      poll and used to throw the entire screen away and rebuild it — which
//      is why so much of that module is written to survive it.
//
// Run with: node --test tests/dev-chat-view.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const DEV_CHAT_SRC = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');
const VIEW_TSX = read('frontend', 'src', 'features', 'dev-chat', 'view.tsx');
const MOUNT_TS = read('frontend', 'src', 'features', 'dev-chat', 'mount.ts');
const APP_VIEW = read('public', 'js', 'app-view.js');

let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/dev-view-api.ts')));

const SESSION = {
  kind: 'session', launchpadHtml: '', barEmpty: false,
  spec: { open: false, width: null }, staging: { open: false, width: null },
  proposalHint: false,
};

const html = (s) => renderToHtml(createElement(mod().DevChatViewView, {
  s: JSON.parse(JSON.stringify(s)),
}));

function makeDevChat(over = {}) {
  const published = [];
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, value: '', style: {}, dataset: {}, innerHTML: '', textContent: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {}, setAttribute() {},
        getAttribute: () => null, removeAttribute() {},
        querySelector: () => null, querySelectorAll: () => [],
        appendChild() {}, focus() {}, scrollTo() {},
      });
    }
    return els.get(id);
  };
  const noop = () => {};
  const sandbox = {
    console,
    escapeHtml: (s) => String(s == null ? '' : s),
    App: { currentApp: 'demo-app', switchTab: noop, updateHash: noop },
    document: {
      getElementById: el, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, removeEventListener: noop,
      createElement: () => el('__created'), body: { appendChild: noop },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: noop,
    navigator: { sendBeacon: noop },
    PlatformUI: {
      isTouch: () => false, hasKit: () => false, toast: noop, transition: (fn) => fn(),
      attachScreenFx: noop, detachScreenFx: noop,
      pullToRefresh: () => ({ detach() {} }), swipeActions: () => ({ detach() {} }),
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    // `initScrollTracking` follows the transcript to the bottom with one of
    // these, and `_launchpadHtml` asks the two markup modules for their
    // panels — neither has anything to say in this harness.
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => fn(),
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { search: '' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = noop;
  sandbox.UsernodeReact = {
    devChat: {
      mountDevView: (_h, s) => published.push({ mounted: true, state: s }),
      publishDevView: (s) => published.push({ mounted: false, state: s }),
      publishSessionHeader: noop, publishBanners: noop, publishTranscript: noop,
      publishComposer: noop, publishSessionList: noop, publishStream: noop,
      publishNow: noop, publishAttachStrip: noop, publishBudgetPill: noop,
      publishQuickReplies: noop, publishRunner: noop,
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${DEV_CHAT_SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  DevChat.currentSession = { id: 7, status: 'active' };
  DevChat._currentVenueId = () => 'usernode-claude';
  DevChat._launchpadHtml = () => '';
  Object.assign(DevChat, over);
  return {
    DevChat, sandbox, published,
    view: () => JSON.parse(JSON.stringify(DevChat._devViewState())),
  };
}

// ── 1. One mount where there were five ─────────────────────────────────

test('the five regions inside it lost their hosts, not their stores', () => {
  for (const gone of [
    'mountSessionHeader', 'mountBanners', 'mountTranscript', 'mountComposer',
    'mountSessionList',
  ]) {
    assert.doesNotMatch(DEV_CHAT_SRC, new RegExp(`react\\.${gone}\\(`), `${gone} has no caller`);
    assert.doesNotMatch(MOUNT_TS, new RegExp(`\\b${gone}\\(`), `${gone} is retired from the bridge`);
  }
  for (const kept of [
    'publishSessionHeader', 'publishBanners', 'publishTranscript', 'publishComposer',
    'publishSessionList',
  ]) {
    assert.match(MOUNT_TS, new RegExp(`${kept}\\(state`), `${kept} still crosses the seam`);
  }
  // And `renderChatView` assigns no markup at all — this was the last
  // innerHTML in the module.
  const at = DEV_CHAT_SRC.indexOf('  renderChatView() {');
  const body = DEV_CHAT_SRC.slice(at, DEV_CHAT_SRC.indexOf('\n  },', at));
  assert.doesNotMatch(body, /innerHTML\s*=/, 'the skeleton is a component');
  assert.equal((body.match(/react\.mountDevView\(/g) || []).length, 2,
    'one mount per branch — the session view and the session list');
});

test('the screen flushes synchronously, because the next dozen lines read the DOM', () => {
  // `initScrollTracking`, `_setupAttachments`, `_restoreDraft`, the form's
  // submit listener, `attachScreenFx` and both resizers all resolve controls
  // by id right after the mount.
  assert.match(MOUNT_TS, /devViewStore\.setFlush\(flushSync\);/);
  const at = DEV_CHAT_SRC.indexOf('  renderChatView() {');
  const body = DEV_CHAT_SRC.slice(at, DEV_CHAT_SRC.indexOf('\n  },', at));
  const mount = body.lastIndexOf('react.mountDevView(');
  for (const after of ['initScrollTracking', '_setupAttachments', 'attachScreenFx']) {
    assert.ok(body.indexOf(after) > mount, `${after} runs after the mount`);
  }
});

// ── 2. The markup the template used to write ───────────────────────────

test('every id and class the skeleton emitted still renders', () => {
  const out = html(SESSION);
  for (const id of [
    'dc-session-header', 'dc-banners', 'dc-tab-chat', 'dc-launchpad-slot',
    'dc-messages', 'dc-composer-bar', 'dc-spec-resizer', 'dc-spec-viewer',
    'dc-staging-resizer', 'dc-staging-panel',
  ]) assert.ok(out.includes(`id="${id}"`), `${id} is still in the document`);
  assert.match(out, /class="dc-session-body flex-1 flex min-h-0"/);
  assert.match(out, /id="dc-tab-chat" class="dc-chat-pane flex-1 flex flex-col min-h-0"/);
  assert.match(out, /id="dc-messages" class="dc-messages-container flex-1 overflow-y-auto py-2"/);
  // `display: contents` — #dc-view is a flex column and each banner has to
  // stay exactly the flex child it was.
  assert.match(out, /id="dc-banners" class="contents"/);

  // The other branch is byte-identical to the string it replaces.
  assert.equal(
    html({ kind: 'none' }),
    '<div id="dc-session-list" class="divide-y divide-zinc-200 dark:divide-zinc-800'
    + ' platform-safe-scroll" style="flex:1;overflow-y:auto;min-height:0"></div>',
  );
});

test('the two panes carry their open class and their saved width', () => {
  const closed = html(SESSION);
  assert.match(closed, /id="dc-spec-viewer" class="dc-spec-viewer "/);
  assert.doesNotMatch(closed, /dc-spec-viewer-open/);
  assert.doesNotMatch(closed, /style="width/, 'a closed pane is width:0 in app.css');

  const open = html({ ...SESSION, spec: { open: true, width: 360 } });
  assert.match(open, /id="dc-spec-resizer" class="dc-spec-resizer dc-spec-resizer-open"/);
  assert.match(open, /id="dc-spec-viewer" class="dc-spec-viewer dc-spec-viewer-open" style="width:360px"/);

  const staging = html({ ...SESSION, staging: { open: true, width: 700 } });
  assert.match(staging, /class="dc-staging-resizer dc-staging-resizer-open"/);
  assert.match(staging, /class="dc-staging-panel dc-staging-panel-open" style="width:700px"/);
});

test('a pane with no saved width renders none, rather than a zero', () => {
  const open = html({ ...SESSION, spec: { open: true, width: null } });
  assert.match(open, /id="dc-spec-viewer" class="dc-spec-viewer dc-spec-viewer-open"><\/div>/);
});

test('the composer bar keeps the safe-area inset when it drops its border', () => {
  // #1348: in a launchpad the composer is hidden and the venue note is
  // usually absent, so the border and padding go — an empty bordered strip
  // reads as a broken composer. The INSET is not part of that: this is still
  // the bottom of the screen.
  assert.match(html(SESSION), /id="dc-composer-bar" class="shrink-0 platform-safe-bar border-t/);
  assert.match(html({ ...SESSION, barEmpty: true }),
    /id="dc-composer-bar" class="shrink-0 platform-safe-bar"/);
});

test('the launchpad slot draws NOTHING when empty, so :empty can collapse it', () => {
  assert.match(html(SESSION),
    /id="dc-launchpad-slot" class="dc-launchpad-slot"><\/div>/);
  assert.match(html({ ...SESSION, launchpadHtml: '<div data-launchpad="1">x</div>' }),
    /class="dc-launchpad-slot"><div data-launchpad="1">/);
});

// ── 3. The two hosts that stay legacy-owned ────────────────────────────

test('the spec viewer and the staging panel render EMPTY, and stay excepted', () => {
  const out = html({ ...SESSION, spec: { open: true, width: null }, staging: { open: true, width: null } });
  assert.match(out, /id="dc-spec-viewer"[^>]*><\/div>/, '_renderSpecViewer fills it');
  assert.match(out, /id="dc-staging-panel"[^>]*><\/div>/, 'the docked preview is positioned OVER it');
  const audit = read('scripts', 'audit-react-ownership.mjs');
  const at = audit.indexOf("sel: '#dc-view'");
  assert.ok(at > 0, '#dc-view is swept');
  assert.match(audit.slice(at, at + 160), /except: \['#dc-spec-viewer', '#dc-staging-panel'\]/);
});

test('the header ELEMENT keeps a constant className, because the kit writes one', () => {
  // `PlatformUI.attachScreenFx` adds a hairline/blur class once the chat
  // scrolls. React never rewrites a className whose prop has not changed, so
  // a literal is safe and an expression would not be.
  const at = VIEW_TSX.indexOf('id="dc-session-header"');
  const tag = VIEW_TSX.slice(at, VIEW_TSX.indexOf('>', at));
  assert.match(tag, /className="[^"{]*"/);
});

// ── 4. #194's hint, which used to be a second author ───────────────────

test('the proposal hint is a field, not an insertAdjacentHTML in front of the tree', () => {
  assert.doesNotMatch(APP_VIEW, /insertAdjacentHTML\('afterbegin'/,
    'app-view.js must not prepend into a subtree React reconciles');
  assert.match(APP_VIEW, /DevChat\.showProposalHint\(\)/);

  const { DevChat, view, published } = makeDevChat();
  assert.equal(view().proposalHint, false);
  DevChat.showProposalHint();
  assert.equal(view().proposalHint, true);
  assert.equal(published[published.length - 1].mounted, false, 'a publish, not a re-mount');
  assert.match(html({ ...SESSION, proposalHint: true }), /promoting this/);
  assert.doesNotMatch(html(SESSION), /promoting this/);

  // It is one-shot: the next full render drops it.
  DevChat.renderChatView();
  assert.equal(view().proposalHint, false);
});

// ── 5. The swap, which no longer needs the screen rebuilt ──────────────

test('#1281: both halves of the swap are published, from one predicate', () => {
  const { DevChat, view } = makeDevChat();
  assert.equal(view().barEmpty, false);
  DevChat._launchpadVenue = () => 'web-claude-code';
  DevChat._venueNoteForRender = '';
  assert.equal(view().barEmpty, true, 'nothing left in the bar to frame');
  DevChat._venueNoteForRender = '<span>note</span>';
  assert.equal(view().barEmpty, false, 'except the sentence, which is something');
  // The composer's `hidden` reads the same predicate, so they cannot
  // disagree about which of them is on screen.
  assert.equal(DevChat._composerView().hidden, true);
});

// ── 6. What a status poll costs now ────────────────────────────────────

test('re-rendering the same screen is a reconcile, not a rebuild', () => {
  // `renderChatView` runs on every status poll. It used to assign
  // `#dc-view.innerHTML`, which destroyed the transcript, the composer and
  // every listener bound on them — which is why this module is written to
  // survive that. Mounting the same host twice is a reconcile.
  const { DevChat, published } = makeDevChat();
  DevChat.renderChatView();
  DevChat.renderChatView();
  const mounts = published.filter((p) => p.mounted);
  assert.equal(mounts.length, 2, 'both calls hand the state to the same host');
  assert.equal(mounts[0].state.kind, 'session');
  // lib/legacy-portals.tsx reuses the entry for a host it already has, so
  // the second call reconciles rather than remounting — the seq only
  // changes after an unmount.
  const portals = read('frontend', 'src', 'lib', 'legacy-portals.tsx');
  assert.match(portals, /On a re-mount \(live entry\) the children are\n\s*\/\/ React-owned/);
});
