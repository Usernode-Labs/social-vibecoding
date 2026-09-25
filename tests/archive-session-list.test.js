// Regression guard for the "Archive button disappeared on cold proposals"
// fix. The Archive button must be gated on a dedicated archivable
// predicate (status active/promoted/paused) — NOT on the same condition as
// Pause/Free/Resume, which excludes a promoted session whose worker has
// gone cold (warm:false):
//
//   1. A promoted session with warm:false still renders Archive
//      (the regression — it used to vanish once the worker cooled).
//   2. merged / archived rows do NOT (they fall outside the archivable
//      set; the backend would 404 them).
//
// #1367 split the list into `DevChat._sessionRow` (which decides) and
// features/dev-chat/session-list.tsx (which draws), so the assertions read
// the row MODEL — strictly more precise than the markup match was, since
// `/dc-archive-btn/` also matched the class on a button that was disabled
// or mislabelled. The rendered markup is asserted once, at the bottom, to
// pin that the model's buttons reach the DOM at all.
//
// dev-chat.js is a plain browser script (`const DevChat = {…}`), so we
// load its source into a vm context, stub the globals it touches, expose
// DevChat, and drive it.
//
// Run with: node --test tests/archive-session-list.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8'
);

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/dev-session-list-api.ts')));

// Captures what `renderSessionList` publishes for the #dc-session-list host.
function makeHarness() {
  const container = { querySelectorAll: () => ({ forEach: () => {} }) };
  const document = {
    getElementById: (id) => (id === 'dc-session-list' ? container : null),
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} }, appendChild: () => {}, setAttribute: () => {} }),
    body: { appendChild: () => {}, addEventListener: () => {} },
  };
  const sandbox = {
    console,
    document,
    escapeHtml: (s) => String(s == null ? '' : s),
    requestAnimationFrame: () => {},
    alert: () => {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  let published = null;
  sandbox.UsernodeReact = {
    devChat: {
      mountSessionList: (_host, state) => { published = state; },
      publishSessionList: (state) => { published = state; },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  // AppView is referenced by the row actions; the builder itself only reads
  // DevChat.sessions, but keep a stub so a stray read cannot throw.
  sandbox.AppView = { appData: null };
  return {
    DevChat,
    container,
    /** The published rows, as plain data across the vm boundary. */
    rows: () => JSON.parse(JSON.stringify(published)).rows,
    /** Every action key on the first row. */
    keys: () => JSON.parse(JSON.stringify(published)).rows[0].actions.map((a) => a.key),
    html: () => {
      const m = mod();
      m.sessionListStore.set(JSON.parse(JSON.stringify(published)));
      return renderToHtml(createElement(m.SessionList));
    },
  };
}

test('promoted session with a cold worker (warm:false) still renders Archive', () => {
  const h = makeHarness();
  const { DevChat } = h;
  DevChat.sessions = [
    { id: 1, status: 'promoted', warm: false, session_title: 'Cold proposal',
      created_at: '2026-06-01T00:00:00Z' },
  ];
  DevChat.renderSessionList();
  assert.ok(h.keys().includes('archive'),
    'cold promoted proposal must keep its Archive button');
  // And it must NOT offer Free worker (nothing to free when cold).
  assert.ok(!h.keys().includes('free'),
    'a cold promoted session has no warm worker to free');
});

test('warm promoted session renders both Free worker and Archive', () => {
  const h = makeHarness();
  h.DevChat.sessions = [
    { id: 2, status: 'promoted', warm: true, session_title: 'Warm proposal',
      created_at: '2026-06-01T00:00:00Z' },
  ];
  h.DevChat.renderSessionList();
  assert.deepEqual(h.keys(), ['free', 'archive']);
  // A promoted session is never pausable — its PR has to stay votable.
  assert.ok(!h.keys().includes('pause'));
});

test('active and paused sessions render Archive alone: pausing is the platform\'s, never a button', () => {
  // #2779 follow-up: the platform pauses an idle session by itself and
  // resumes it when it is opened or messaged, so neither is offered.
  for (const status of ['active', 'paused']) {
    const h = makeHarness();
    h.DevChat.sessions = [
      { id: 3, status, warm: false, session_title: `${status} session`,
        created_at: '2026-06-01T00:00:00Z' },
    ];
    h.DevChat.renderSessionList();
    assert.deepEqual(h.keys(), ['archive'], `${status} should be archivable`);
  }
});

test('merged and archived rows do NOT render Archive', () => {
  for (const status of ['merged', 'merging', 'archived']) {
    const h = makeHarness();
    h.DevChat.sessions = [
      { id: 4, status, warm: false, session_title: `${status} session`,
        created_at: '2026-06-01T00:00:00Z' },
    ];
    h.DevChat.renderSessionList();
    assert.ok(!h.keys().includes('archive'),
      `${status} must not be archivable from the session list`);
  }
});

test('archived row renders Unarchive instead', () => {
  const h = makeHarness();
  h.DevChat.sessions = [
    { id: 5, status: 'archived', warm: false, session_title: 'Archived',
      created_at: '2026-06-01T00:00:00Z' },
  ];
  h.DevChat.renderSessionList();
  assert.deepEqual(h.keys(), ['unarchive']);
});

// ── …and the model's buttons reach the DOM ─────────────────────────────

test('the rows the model describes are what the list draws', () => {
  const h = makeHarness();
  h.DevChat.sessions = [
    { id: 7, status: 'promoted', warm: true, session_title: 'Warm proposal',
      branch_name: 'feat/warm', pr_url: 'https://gh/pr/9', pr_number: 9,
      created_at: '2026-06-01T00:00:00Z' },
    { id: 8, status: 'paused', warm: false, session_title: 'Paused one',
      created_at: '2026-06-01T00:00:00Z' },
  ];
  h.DevChat.renderSessionList();
  const html = h.html();
  assert.match(html, /class="dc-session-item[^"]*" data-id="7"/);
  assert.match(html, /dc-pause-btn[^>]*>Free worker</);
  assert.match(html, /dc-archive-btn[^>]*>Archive</);
  assert.doesNotMatch(html, />Resume</, 'no Resume: opening the session resumes it');
  assert.match(html, /data-id="8"><span class="[^"]*">active</, 'a paused session reads as the active one it is');
  assert.match(html, /title="feat\/warm"/, 'the branch is the row tooltip');
  assert.match(html, /PR#9/);
  assert.match(html, /title="Frees the AI worker\. The PR stays up for voting\."/);
});

test('an empty list is the pitch; an unpublished one is nothing at all', () => {
  const m = mod();
  m.sessionListStore.set({ rows: [] });
  const pitch = renderToHtml(createElement(m.SessionList));
  assert.match(pitch, /Want to change this app\? Just ask\./);
  assert.match(pitch, /\+ New Session/);

  m.sessionListStore.set({ rows: null });
  assert.equal(renderToHtml(createElement(m.SessionList)), '',
    'a chat-view render must not flash the pitch before the rows arrive');
});

// ── #2989: a row that opens a session is a button (#1918) ──────────────

const ROW = {
  id: 7, status: 'active', statusTone: 'active', title: 'Warm proposal',
  branch: 'feat/warm', busy: false, pr: { url: 'https://gh/pr/9', number: 9 },
  createdAt: '2026-06-01T00:00:00Z', actions: [],
};

test('#2989: a session row is a focusable, named button', () => {
  const m = mod();
  const html = renderToHtml(createElement(m.SessionListView, { rows: [ROW] }));
  assert.match(html, /<div role="button" tabindex="0" aria-label="Open session: Warm proposal \(active\)" class="dc-session-item/);
  assert.match(html, /class="dc-session-item[^"]*" data-id="7">/, 'data-id stays the last attribute');
});

test('#2989: Enter and Space on the row open the session; keys from a child do not', async () => {
  const m = mod();
  const list = m.SessionListView({ rows: [ROW] });
  const rowEl = list.props.children[0];
  const div = rowEl.type(rowEl.props);
  const opened = [];
  const prev = globalThis.window;
  globalThis.window = { DevChat: { openSessionFromList: (id) => { opened.push(id); } } };
  try {
    const key = (k, own = true) => {
      const target = {};
      let prevented = false;
      div.props.onKeyDown({
        key: k, target, currentTarget: own ? target : {},
        preventDefault: () => { prevented = true; },
      });
      return prevented;
    };
    assert.equal(key('Enter'), true, 'Enter is consumed');
    assert.equal(key(' '), true, 'Space is consumed (no page scroll)');
    assert.equal(key('a'), false, 'other keys pass through');
    assert.equal(key('Enter', false), false, 'the nested PR link keeps its own Enter');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(opened, [7, 7]);
  } finally {
    if (prev === undefined) delete globalThis.window; else globalThis.window = prev;
  }
});
