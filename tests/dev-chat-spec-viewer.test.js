// `#dc-spec-viewer` — the shared-spec reader, as a React island.
//
// It was the last CONTROLLER host on the dev chat's screen: when `#dc-view`
// converted, three hosts inside it stayed legacy-owned and this was the only
// one that a module actually FILLED. `_renderSpecViewer` assigned its
// `innerHTML` and then bound six listeners onto the nodes that assignment had
// just written.
//
// What that idiom cost is the thing this file is really about. Every piece of
// the panel's own state — the copy button's flash, the share popover's open
// flag, its typed username, its error line, its fetched suggestions — lived in
// closures over ONE render pass, so any repaint threw all of it away: a
// version switch, a `spec_updated` push, a frozen-version fetch landing. The
// module keeps the `specViewer` slot (five other places read it) and the
// fetches; the markup and every listener are the component's.
//
// Three layers:
//   1. `_specViewerView` — the decisions. Ownership gating, the version
//      sentinel, which content is on screen, and #233's fail-closed guard.
//   2. The component — the markup those decisions produce.
//   3. The seam — no innerHTML left, one publish per writer, and the lazy
//      frozen-version fetch sitting AFTER the publish rather than inside the
//      view builder.
//
// Run with: node --test tests/dev-chat-spec-viewer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { splitSpecSections } = require('../public/js/spec-sections.js');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const DEV_CHAT_SRC = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');
const MOUNT_TS = read('frontend', 'src', 'features', 'dev-chat', 'mount.ts');
const VIEWER_TSX = read('frontend', 'src', 'features', 'dev-chat', 'spec-viewer.tsx');
const AUDIT = read('scripts', 'audit-react-ownership.mjs');

let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/dev-spec-viewer-api.ts')));

/** Render a view model the way the pane does. */
const html = (s) => renderToHtml(createElement(mod().SpecViewerView, {
  s: JSON.parse(JSON.stringify(s)),
}));

// ── the module harness ─────────────────────────────────────────────────

function makeDevChat(over = {}) {
  const noop = () => {};
  const published = [];
  const fetched = [];
  const el = () => ({
    id: '', value: '', style: {}, dataset: {}, innerHTML: '', textContent: '',
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, removeEventListener: noop, setAttribute: noop,
    getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [],
    appendChild: noop, focus: noop,
  });
  const sandbox = {
    console: { log: noop, warn: noop, error: noop },
    escapeHtml: (s) => String(s == null ? '' : s),
    splitSpecSections,
    App: { currentApp: 'demo-app', switchTab: noop, updateHash: noop },
    document: {
      getElementById: el, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, removeEventListener: noop,
      createElement: el, body: { appendChild: noop },
    },
    fetch: async (url) => {
      fetched.push(String(url));
      return { ok: true, json: async () => ({ spec: { content: 'frozen' } }) };
    },
    alert: noop,
    navigator: { sendBeacon: noop },
    PlatformUI: { isTouch: () => false, hasKit: () => false, toast: noop },
    setTimeout, clearTimeout, setInterval, clearInterval,
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
      publishSpecViewer: (s) => published.push(s),
      mountDevView: noop, publishDevView: noop, publishSessionHeader: noop,
      publishBanners: noop, publishTranscript: noop, publishComposer: noop,
      publishSessionList: noop, publishStream: noop, publishNow: noop,
      publishAttachStrip: noop, publishBudgetPill: noop, publishQuickReplies: noop,
      publishRunner: noop,
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${DEV_CHAT_SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  DevChat.currentSession = { id: 7, status: 'active' };
  DevChat._ownsSession = () => true;
  // The real one is marked + DOMPurify behind a cache, neither of which
  // exists in a vm. What matters here is that the MODEL carries rendered
  // html, so a recognisable stand-in is enough.
  DevChat.renderMarkdown = (md) => `<p>${md}</p>`;
  Object.assign(DevChat, over);
  return {
    DevChat, sandbox, published, fetched,
    // The module's bootstrap already fired `loadModels()`, so a test that
    // cares about the spec routes asks for those.
    specFetches: () => fetched.filter((u) => u.includes('/specs/')),
    view: () => JSON.parse(JSON.stringify(DevChat._specViewerView())),
  };
}

const V = (version, extra = {}) => ({
  version, built_at: null, pr_number: null, shared_to_group_at: null, ...extra,
});

function openViewer(h, over = {}) {
  Object.assign(h.DevChat.specViewer, {
    open: true, sessionId: 7, draftContent: 'latest doc', versions: [V(2), V(1)],
    viewVersion: 'latest', viewVersionContent: null, isLoading: false, activeTab: 'user',
  }, over);
  return h;
}

// ── 1. `_specViewerView` — the decisions ───────────────────────────────

test('a closed panel, a sessionless one and a mismatched one all say closed', () => {
  const h = makeDevChat();
  assert.deepEqual(h.view(), { kind: 'closed' }, 'closed by default');

  openViewer(h);
  assert.equal(h.view().kind, 'open');

  // #233's fail-closed guard. It has to SAY closed rather than decline to
  // speak: the pane reconciles now, so a bare `return` would leave the
  // previous session's panel standing inside it.
  h.DevChat.specViewer.sessionId = 9;
  assert.deepEqual(h.view(), { kind: 'closed' }, 'another session’s spec never renders');

  h.DevChat.specViewer.sessionId = 7;
  h.DevChat.currentSession = null;
  assert.deepEqual(h.view(), { kind: 'closed' });
});

test('the latest option carries the sentinel, older ones carry their number', () => {
  const h = openViewer(makeDevChat(), {
    versions: [V(3, { pr_number: 41 }), V(2), V(1)],
  });
  const s = h.view();
  assert.deepEqual(s.versions.map((o) => o.value), ['latest', '2', '1'],
    're-selecting the highest resumes FOLLOWING new versions');
  assert.equal(s.versions[0].label, 'v3 (latest) · PR #41');
  assert.equal(s.versions[1].label, 'v2');
  assert.equal(s.selected, 'latest');
  assert.equal(s.version, 3, 'the share buttons act on a NUMBER, never the sentinel');
});

test('an older selection reads its cached content, not spec_md', () => {
  const h = openViewer(makeDevChat(), { viewVersion: '1', viewVersionContent: 'frozen v1' });
  const s = h.view();
  assert.equal(s.selected, '1');
  assert.equal(s.raw, 'frozen v1');
  assert.equal(s.buildHint, false, 'an older version is not what a build would use');

  // Not yet fetched: an empty body, and the actions blank rather than live.
  const cold = openViewer(makeDevChat(), { viewVersion: '1', viewVersionContent: null });
  assert.equal(cold.view().raw, '');
  assert.equal(cold.view().copy.kind, 'blank');
});

test('an unresolvable selection falls back to the latest rather than to nothing', () => {
  const h = openViewer(makeDevChat(), { viewVersion: '99' });
  const s = h.view();
  assert.equal(s.version, 2);
  assert.equal(s.selected, 'latest');
});

test('a non-owner gets no share affordances, no build hint and its own empty copy', () => {
  const h = openViewer(makeDevChat({ _ownsSession: () => false }));
  const s = h.view();
  assert.equal(s.groupShare.kind, 'absent', 'both share routes are owner-scoped server-side');
  assert.equal(s.userShare.kind, 'absent');
  assert.equal(s.buildHint, false);
  assert.equal(s.copy.kind, 'live', 'copying what you can read is not owner-gated');

  const empty = openViewer(makeDevChat({ _ownsSession: () => false }), {
    draftContent: '', versions: [],
  });
  assert.deepEqual(empty.view().body,
    { kind: 'empty', copy: 'No spec has been shared for this session yet.' });

  const owner = openViewer(makeDevChat(), { draftContent: '', versions: [] });
  assert.deepEqual(owner.view().body,
    { kind: 'empty', copy: 'No spec yet. Ask the AI to draft one.' });
});

test('nothing to share is `blank`, already shared is `live` and spent', () => {
  const h = openViewer(makeDevChat(), { draftContent: '   ' });
  const s = h.view();
  assert.equal(s.copy.kind, 'blank', 'whitespace is not a spec');
  assert.equal(s.groupShare.kind, 'blank');
  assert.equal(s.userShare.kind, 'blank');
  assert.equal(s.buildHint, false);

  const shared = openViewer(makeDevChat(), {
    versions: [V(2, { shared_to_group_at: '2026-01-01T00:00:00Z' }), V(1)],
  });
  assert.deepEqual(shared.view().groupShare, { kind: 'live', shared: true });
  assert.deepEqual(shared.view().userShare, { kind: 'live' },
    'the private share is repeatable and independent of the group one');
});

test('a conforming spec splits into two halves and remembers which is open', () => {
  const doc = [
    '# Title', '', 'A summary.', '',
    '## User-facing changes', '', 'Plain language.', '',
    '## Technical implementation', '', 'Details.',
  ].join('\n');
  const split = splitSpecSections(doc);
  assert.ok(split, 'the fixture is a conforming two-section spec');

  const h = openViewer(makeDevChat(), { draftContent: doc });
  const user = h.view().body;
  assert.equal(user.kind, 'split');
  assert.equal(user.tab, 'user');
  assert.match(user.preambleHtml, /Title/);
  assert.match(user.halfHtml, /Plain language/);

  h.DevChat.specViewer.activeTab = 'tech';
  assert.match(h.view().body.halfHtml, /Details/);

  // #1012: the copy source is the WHOLE document, never the half on screen.
  assert.equal(h.view().raw, doc);
});

test('a legacy doc renders one untabbed body', () => {
  const h = openViewer(makeDevChat(), { draftContent: 'Just prose.' });
  assert.deepEqual(h.view().body, { kind: 'plain', html: '<p>Just prose.</p>' });
});

test('loading only shows while there is nothing to show', () => {
  const h = openViewer(makeDevChat(), { isLoading: true, draftContent: '', versions: [] });
  assert.deepEqual(h.view().body, { kind: 'loading' });
  // A refresh over content already on screen repaints in place instead of
  // blanking to a spinner.
  h.DevChat.specViewer.draftContent = 'still here';
  assert.equal(h.view().body.kind, 'plain');
});

// ── 2. The component — the markup those decisions produce ──────────────

const OPEN = {
  kind: 'open',
  versions: [{ value: 'latest', label: 'v2 (latest)' }, { value: '1', label: 'v1' }],
  selected: 'latest',
  version: 2,
  raw: '# doc',
  body: { kind: 'plain', html: '<p>doc</p>' },
  copy: { kind: 'live' },
  userShare: { kind: 'live' },
  groupShare: { kind: 'live', shared: false },
  buildHint: true,
};

test('a closed model draws nothing at all', () => {
  assert.equal(html({ kind: 'closed' }), '');
});

test('the header keeps its order: version, copy, share to user, share to group, close', () => {
  const out = html(OPEN);
  const at = (needle) => {
    const i = out.indexOf(needle);
    assert.ok(i !== -1, `${needle} is in the header`);
    return i;
  };
  assert.ok(
    at('id="dc-spec-viewer-version"') < at('id="dc-spec-viewer-copy"')
      && at('id="dc-spec-viewer-copy"') < at('id="dc-spec-viewer-share-user"')
      && at('id="dc-spec-viewer-share-user"') < at('id="dc-spec-viewer-share"')
      && at('id="dc-spec-viewer-share"') < at('id="dc-spec-viewer-close"')
      && at('id="dc-spec-viewer-close"') < at('id="dc-spec-share-pop"'),
    'the popover stays last, where the template put it',
  );
  assert.match(out, /class="dc-spec-viewer-header"/);
  assert.match(out, /class="dc-spec-viewer-body-wrap"/);
  assert.match(out, /<button id="dc-spec-viewer-close" class="dc-spec-viewer-close" aria-label="Close spec viewer">/);
});

test('the version picker renders its options and disables itself when empty', () => {
  const out = html(OPEN);
  // React drives the picker from the SELECT's value rather than from a
  // `selected` attribute the module wrote onto an option; the server
  // renderer spells the result the same way the template did.
  assert.match(out, /<option value="latest" selected="">v2 \(latest\)<\/option>/);
  assert.match(out, /<option value="1">v1<\/option>/);
  // The field box is the string app.css and Tailwind were written against.
  assert.match(out, /id="dc-spec-viewer-version" class="text-xs rounded bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1"/);

  const none = html({ ...OPEN, versions: [], selected: '', version: null });
  assert.match(none, /id="dc-spec-viewer-version"[^>]*disabled/);
  assert.match(none, /No versions yet/);
});

test('a disabled action renders WITHOUT the id its handler bound to', () => {
  const blank = html({
    ...OPEN,
    copy: { kind: 'blank' },
    userShare: { kind: 'blank' },
    groupShare: { kind: 'blank' },
    buildHint: false,
  });
  assert.match(blank, /<button class="dc-spec-action-btn dc-spec-copy-btn" disabled="" title="No spec to copy yet">Copy markdown<\/button>/);
  assert.equal(blank.includes('id="dc-spec-viewer-copy"'), false);
  assert.equal(blank.includes('id="dc-spec-viewer-share"'), false);
  assert.equal(blank.includes('id="dc-spec-viewer-share-user"'), false);
  assert.equal((blank.match(/disabled="" title="No spec version to share yet"/g) || []).length, 2,
    'both share buttons keep their placeholder');
  // A blank button is still the OWNER's, so the popover is still there.
  assert.ok(blank.includes('id="dc-spec-share-pop"'));
});

test('an already-shared version says so and stops', () => {
  const out = html({ ...OPEN, groupShare: { kind: 'live', shared: true } });
  assert.match(out, /id="dc-spec-viewer-share"[^>]*disabled/);
  assert.match(out, /title="Already shared to group chat"/);
  assert.ok(out.includes('>Shared</button>'));

  const fresh = html(OPEN);
  assert.match(fresh, /title="Post a card linking to this spec in the group chat"/);
  assert.ok(fresh.includes('>Share to group</button>'));
});

test('a non-owner sees neither share button nor the popover', () => {
  const out = html({
    ...OPEN,
    userShare: { kind: 'absent' },
    groupShare: { kind: 'absent' },
    buildHint: false,
  });
  assert.equal(out.includes('dc-spec-share-pop'), false, 'the card is the owner’s affordance');
  assert.equal(out.includes('Share to group'), false);
  assert.equal(out.includes('Share to user'), false);
  // Copy survives: reading the panel is what earns it.
  assert.ok(out.includes('id="dc-spec-viewer-copy"'));
});

test('the popover ships closed, with the hidden class on its two dismissable parts', () => {
  const out = html(OPEN);
  assert.match(out, /id="dc-spec-share-pop" class="dc-spec-share-pop hidden"/);
  assert.match(out, /id="dc-spec-share-error" class="dc-spec-share-error hidden"/);
  assert.match(out, /id="dc-spec-share-input" class="dc-spec-share-input" type="text" placeholder="Username/);
  // Spelled as React's props here; an HTML parser lowercases an attribute
  // name, so the rendered document carries the same three the template did.
  assert.match(out, /autoComplete="off"/i);
  assert.match(out, /spellCheck="false"/i);
  assert.match(out, /maxLength="32"/i);
  assert.match(out, /id="dc-spec-share-suggestions" class="dc-spec-share-suggestions"/);
  assert.match(out, /id="dc-spec-share-send" class="dc-spec-action-btn dc-spec-share-send">Send</);
});

test('the two halves render as tabs, and an empty half keeps its own', () => {
  const out = html({
    ...OPEN,
    body: {
      kind: 'split', preambleHtml: '<p>intro</p>', tab: 'tech', halfHtml: '<p>plan</p>',
    },
  });
  assert.match(out, /class="dc-spec-viewer-body dc-spec-viewer-preamble"><p>intro<\/p>/);
  assert.match(out, /class="dc-spec-viewer-tabs" role="tablist" aria-label="Spec sections"/);
  assert.match(out, /class="dc-spec-viewer-tab" role="tab" aria-selected="false" data-spec-tab="user">User-facing</);
  assert.match(out, /class="dc-spec-viewer-tab dc-spec-viewer-tab-active" role="tab" aria-selected="true" data-spec-tab="tech">Technical</);
  assert.match(out, /class="dc-spec-viewer-body" role="tabpanel"><p>plan<\/p>/);

  const empty = html({
    ...OPEN,
    body: { kind: 'split', preambleHtml: '', tab: 'user', halfHtml: '' },
  });
  assert.match(empty, /<p class="dc-spec-tab-empty">Nothing in this section\.<\/p>/);
  assert.ok(empty.includes('data-spec-tab="tech"'),
    'the toggle does not appear and disappear between versions');
  assert.equal(empty.includes('dc-spec-viewer-preamble'), false);
});

test('loading and empty bodies stay plain text, never markup', () => {
  const loading = html({ ...OPEN, body: { kind: 'loading' } });
  assert.match(loading, /<div class="p-4 text-sm text-zinc-500 dark:text-zinc-400">Loading spec/);
  const empty = html({ ...OPEN, body: { kind: 'empty', copy: 'No spec yet. <b>x</b>' } });
  assert.ok(empty.includes('&lt;b&gt;x&lt;/b&gt;'), 'an empty-state sentence is TEXT');
});

test('the build hint is the last thing on the panel, and only when asked for', () => {
  const out = html(OPEN);
  assert.match(out, /<div class="dc-spec-viewer-build-hint">This is a plan, not a built change\./);
  assert.ok(out.indexOf('dc-spec-viewer-build-hint') > out.indexOf('dc-spec-viewer-body-wrap'));
  assert.equal(html({ ...OPEN, buildHint: false }).includes('dc-spec-viewer-build-hint'), false);
});

// ── 3. The seam ────────────────────────────────────────────────────────

test('the module writes no markup for this pane any more', () => {
  assert.doesNotMatch(DEV_CHAT_SRC, /\n {2}_renderSpecViewer\(/,
    'the renderer is a view builder plus a publisher');
  assert.doesNotMatch(DEV_CHAT_SRC, /\n {2}_bindSpecSharePopover\(/,
    'the popover is the component’s, state and listeners both');
  for (const gone of ['dc-spec-viewer-header', 'dc-spec-share-pop', 'dc-spec-viewer-tab']) {
    assert.equal(DEV_CHAT_SRC.includes(gone), false, `${gone} is spelled in the component`);
  }
  assert.match(MOUNT_TS, /publishSpecViewer\(state\)/);
  assert.match(MOUNT_TS, /specViewerStore\.setFlush\(flushSync\);/);
});

test('every writer that rebuilt the pane is one publish now', () => {
  // Coarse but stable, same helper as tests/spec-viewer-session-reset.test.js:
  // from the method's declaration to the next one at the same indentation.
  const slice = (name) => {
    const start = DEV_CHAT_SRC.match(new RegExp(`\\n {2}(?:async )?${name}\\(`));
    assert.ok(start, `${name} is still in the module`);
    const from = start.index + start[0].length;
    const end = DEV_CHAT_SRC.slice(from).match(/\n {2}(?:async )?[_A-Za-z][\w]*\((?:[^)]*)\)\s*\{/);
    return DEV_CHAT_SRC.slice(start.index, end ? from + end.index : DEV_CHAT_SRC.length);
  };
  for (const name of [
    '_loadSpecViewer', '_loadSpecVersion', '_shareSpecVersion',
    '_switchSpecViewerVersion', '_setSpecTab',
  ]) {
    assert.match(slice(name), /DevChat\._publishSpecViewer\(\)/, `${name} publishes`);
  }
  // And the screen's own render publishes UNCONDITIONALLY — a close has to
  // reach the pane too, now that it is not rebuilt empty around it.
  const render = slice('renderChatView');
  assert.match(render, /\n {4}DevChat\._publishSpecViewer\(\);/);
  assert.doesNotMatch(render, /if \(DevChat\.specViewer\.open\) \{/,
    'no open-gate left in front of the publish');
});

test('the lazy frozen-version fetch runs after the publish, not inside the view', () => {
  // The rule the transcript's conversion wrote down: a loader a renderer
  // calls per paint must not re-enter that renderer.
  const viewAt = DEV_CHAT_SRC.indexOf('\n  _specViewerView() {');
  const pubAt = DEV_CHAT_SRC.indexOf('\n  _publishSpecViewer() {');
  const viewBody = DEV_CHAT_SRC.slice(viewAt, pubAt);
  assert.ok(viewAt !== -1 && pubAt > viewAt);
  assert.doesNotMatch(viewBody, /_loadSpecVersion\(/, 'the view builder fetches nothing');

  const h = openViewer(makeDevChat(), { viewVersion: '1', viewVersionContent: null });
  h.DevChat._publishSpecViewer();
  assert.equal(h.published.length, 1, 'one publish per call');
  assert.deepEqual(h.specFetches(), ['/api/sessions/7/specs/1'],
    'and the frozen fetch is kicked');

  // Cached, so it terminates.
  const warm = openViewer(makeDevChat(), { viewVersion: '1', viewVersionContent: 'frozen' });
  warm.DevChat._publishSpecViewer();
  assert.deepEqual(warm.specFetches(), []);

  // Following the latest never fetches a version.
  const live = openViewer(makeDevChat());
  live.DevChat._publishSpecViewer();
  assert.deepEqual(live.specFetches(), []);
});

test('a tab switch repaints from cache and does not re-enter on a no-op', () => {
  const h = openViewer(makeDevChat());
  h.DevChat._setSpecTab('tech');
  assert.equal(h.DevChat.specViewer.activeTab, 'tech');
  assert.equal(h.published.length, 1);
  h.DevChat._setSpecTab('tech');
  assert.equal(h.published.length, 1, 'the same tab is not a repaint');
  assert.deepEqual(h.specFetches(), [], 'and never a refetch');
});

test('mention suggestions are best-effort: a failure is an empty list', async () => {
  const h = makeDevChat();
  // The result crosses a vm realm boundary, so compare plain data.
  const names = async () => JSON.parse(
    JSON.stringify(await h.DevChat._loadSpecMentionSuggestions()),
  );
  // No AppView at all — the popover still works with an exact username.
  assert.deepEqual(await names(), []);

  h.sandbox.AppView = { appData: { slug: 'demo' } };
  h.sandbox.fetch = async () => ({ ok: true, json: async () => ({
    users: [{ username: 'ada' }, { username: '' }, null],
  }) });
  assert.deepEqual(await names(), ['ada']);

  h.sandbox.fetch = async () => { throw new Error('offline'); };
  assert.deepEqual(await names(), []);
});

test('the pane is in the ownership audit now', () => {
  assert.match(AUDIT, /except: \['#dc-staging-panel'\]/,
    '#dc-spec-viewer is no longer excepted from the #dc-view sweep');
});

test('the reader reaches the module by name, never by import', () => {
  // dev-chat.js is loaded as a classic script by a dozen vm-based tests, so
  // this bundle cannot import it — the same constraint mount.ts documents.
  assert.doesNotMatch(VIEWER_TSX, /from '\.\/dev-chat/);
  for (const fn of [
    '_switchSpecViewerVersion', 'closeSpecViewer', '_setSpecTab',
    '_shareSpecVersion', '_shareSpecToUser', '_loadSpecMentionSuggestions',
  ]) {
    assert.ok(VIEWER_TSX.includes(`?.${fn}?.(`), `${fn} is called through the controller`);
    assert.ok(DEV_CHAT_SRC.includes(`  ${fn}(`) || DEV_CHAT_SRC.includes(`  async ${fn}(`),
      `${fn} exists on DevChat`);
  }
});
