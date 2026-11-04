// Undo several archives in a row, newest first (#6132).
//
// Archiving or withdrawing a proposal on a project's board (app-view.js
// _archiveSession / withdrawProposal) and archiving an agent session from
// Messages (agent-session/store.ts archiveCurrentSession) each push the
// session on a stack and show a priority toast with Undo. Each press of Undo
// brings back the newest one (POST .../unarchive) and re-toasts while entries
// remain; the last restore toasts with no action. A failure puts the entry
// back with Undo still attached, a 404 drops it, an entry for another project
// clears the board's stack, and the stacks hold 20 at most.
//
// app-view.js is loaded into a vm sandbox the way archive-proposal-card.test.js
// does; the store through tests/fixtures/agent-session-api.ts.
//
// Run with: node --test tests/archive-undo-stack.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { loadTsx } = require('./lib/render-tsx');
const { withStateRead } = require('./lib/agent-session-state-read');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');
const STORE = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'features', 'agent-session', 'store.ts'), 'utf8');

const ME = 42;

// The board, with a fetch that records POSTs and answers each by a table of
// status codes per URL (200 by default), a confirm that says yes, and a
// toast that keeps every call so a test can press its Undo.
function makeBoard({ slug = 'notes', answers = {} } = {}) {
  const posted = [];
  const toasts = [];
  const alerts = [];
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: ME }, currentSubTab: 'forum' },
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    PlatformUI: {
      toast: (msg, opts) => { toasts.push({ message: msg, opts: opts || {} }); },
      alert: (opts) => { alerts.push(opts); },
    },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async (url, init) => {
      posted.push({ url, method: init && init.method });
      const answer = answers[url];
      const status = typeof answer === 'function' ? answer() : (answer || 200);
      const body = status === 200 ? { ok: true } : { error: `HTTP ${status}` };
      return { ok: status === 200, status, json: async () => body };
    },
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug };
  AppView._proposalsCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  AppView.__sandbox = sandbox;
  const reloads = [];
  AppView._loadDevFeed = async () => { reloads.push(1); };
  AppView._renderTopicHead = () => {};
  const last = () => toasts[toasts.length - 1];
  const pressUndo = async () => {
    const t = last();
    assert.ok(t && t.opts.action && t.opts.action.label === message('changes:archiveUndo.undo'), 'the visible toast carries Undo');
    await t.opts.action.handler();
    // The handler is fire-and-forget from the kit's button: let the async
    // undo settle before the test reads the result.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { AppView, sandbox, posted, toasts, alerts, reloads, last, pressUndo };
}

const unarchives = (posted) => posted.filter((p) => /\/unarchive$/.test(p.url)).map((p) => p.url);
// Arrays made inside the vm context have its own Array prototype, which
// deepStrictEqual compares; read them as plain values.
const plain = (value) => JSON.parse(JSON.stringify(value));
const ids = (AppView) => plain(AppView._archiveUndo.map((e) => e.id));

test('three archives then three Undos bring them back newest first; the last restore toasts with no action', async () => {
  const b = makeBoard();
  for (const [id, title] of [[1, 'First'], [2, 'Second'], [3, 'Third']]) {
    assert.equal(await b.AppView._archiveSession(id, title), true);
  }
  assert.deepEqual(ids(b.AppView), [1, 2, 3], 'newest last');
  assert.deepEqual(plain(b.AppView._archiveUndo.map((e) => e.slug)), ['notes', 'notes', 'notes'], 'each entry remembers its project');
  assert.equal(b.toasts.length, 3);
  assert.equal(b.toasts[0].message, message('changes:archiveUndo.archived', { title: 'First', count: 1 }));
  assert.equal(b.toasts[0].message, 'Archived “First”');
  assert.equal(b.last().message, message('changes:archiveUndo.archived', { title: 'Third', count: 3 }));
  assert.equal(b.last().message, 'Archived “Third”. 3 to undo');
  for (const t of b.toasts) {
    assert.equal(t.opts.priority, true, 'a priority toast: ordinary toasts queue behind it');
    assert.equal(t.opts.duration, 8000);
    assert.equal(t.opts.action.label, 'Undo');
  }

  await b.pressUndo();
  assert.deepEqual(unarchives(b.posted), ['/api/sessions/3/unarchive']);
  assert.equal(b.reloads.length, 1, 'the feed reloads as Unarchive does');
  assert.equal(b.last().message, message('changes:archiveUndo.restored', { title: 'Third', count: 2 }));
  assert.equal(b.last().message, 'Brought back “Third”. 2 more to undo');
  assert.ok(b.last().opts.action, 'Undo stays while entries remain');

  await b.pressUndo();
  assert.deepEqual(unarchives(b.posted), ['/api/sessions/3/unarchive', '/api/sessions/2/unarchive']);
  assert.equal(b.last().message, 'Brought back “Second”. 1 more to undo');

  await b.pressUndo();
  assert.deepEqual(unarchives(b.posted), ['/api/sessions/3/unarchive', '/api/sessions/2/unarchive', '/api/sessions/1/unarchive']);
  assert.equal(b.last().message, message('changes:archiveUndo.restoredLast', { title: 'First' }));
  assert.equal(b.last().message, 'Brought back “First”');
  assert.equal(b.last().opts.action, undefined, 'nothing left: no Undo on the last notice');
  assert.equal(b.last().opts.priority, true);
  assert.deepEqual(plain(b.AppView._archiveUndo), []);
  assert.equal(b.reloads.length, 3);
});

test('a failed archive POST pushes nothing and shows no Undo', async () => {
  const b = makeBoard({ answers: { '/api/sessions/9/archive': 500 } });
  assert.equal(await b.AppView._archiveSession(9, 'Broken'), false);
  assert.deepEqual(plain(b.AppView._archiveUndo), []);
  assert.equal(b.toasts.length, 1, 'the failure toast only');
  assert.equal(b.toasts[0].opts.action, undefined);
});

test('withdrawing a proposal pushes a withdrawn entry under its PR title, and Undo brings it back', async () => {
  const b = makeBoard();
  b.AppView._proposals = [{ id: 7, pr_number: 700, pr_title: 'Tidy the header', user_id: ME, status: 'promoted' }];
  await b.AppView.withdrawProposal(7);
  assert.deepEqual(plain(b.AppView._archiveUndo), [{ id: 7, title: 'Tidy the header', verb: 'withdrawn', slug: 'notes' }]);
  assert.equal(b.last().message, message('changes:archiveUndo.withdrawn', { title: 'Tidy the header', count: 1 }));
  assert.equal(b.last().message, 'Withdrew “Tidy the header”');
  // A second withdrawal counts both.
  b.AppView._proposals.push({ id: 8, pr_number: 800, pr_title: null, user_id: ME, status: 'promoted' });
  await b.AppView.withdrawProposal(8);
  assert.equal(b.AppView._archiveUndo[1].title, message('changes:session.prFallbackTitle', { number: 800 }), 'no title: the PR number stands in');
  assert.equal(b.last().message, 'Withdrew “PR 800”. 2 to undo');
  await b.pressUndo();
  assert.deepEqual(unarchives(b.posted), ['/api/sessions/8/unarchive']);
  assert.equal(b.last().message, 'Brought back “PR 800”. 1 more to undo');
});

test('Undo repaints the opened topic head, as withdrawProposal does', async () => {
  const b = makeBoard();
  let painted = 0;
  b.AppView._renderTopicHead = () => { painted += 1; };
  b.sandbox.App.currentSubTab = 'topic';
  b.sandbox.document.getElementById = (id) => (id === 'gc-thread-head' ? {} : null);
  await b.AppView._archiveSession(4, 'Four');
  await b.pressUndo();
  assert.equal(painted, 1);
});

test('a 503 puts the entry back with Undo still attached; a 404 drops it and the rest stay in line', async () => {
  let busy = 1;
  const b = makeBoard({ answers: {
    '/api/sessions/2/unarchive': () => (busy-- > 0 ? 503 : 200),
    '/api/sessions/3/unarchive': 404,
  } });
  await b.AppView._archiveSession(1, 'One');
  await b.AppView._archiveSession(2, 'Two');
  await b.AppView._archiveSession(3, 'Three');

  // 404: three is gone (not archived any more); the notice names the next.
  await b.pressUndo();
  assert.deepEqual(unarchives(b.posted), ['/api/sessions/3/unarchive']);
  assert.deepEqual(ids(b.AppView), [1, 2]);
  assert.equal(b.last().message, 'Archived “Two”. 2 to undo', 'the rest re-toast');
  assert.ok(b.last().opts.action);
  assert.equal(b.reloads.length, 0, 'nothing came back: no reload');

  // 503: two stays in line, the server's sentence shows, Undo retries it.
  await b.pressUndo();
  assert.deepEqual(unarchives(b.posted), ['/api/sessions/3/unarchive', '/api/sessions/2/unarchive']);
  assert.deepEqual(ids(b.AppView), [1, 2], 'put back on top');
  assert.equal(b.last().message, 'HTTP 503', "the server's error");
  assert.equal(b.last().opts.action.label, 'Undo');
  assert.equal(b.last().opts.priority, true);

  await b.pressUndo();
  assert.deepEqual(unarchives(b.posted).slice(-1), ['/api/sessions/2/unarchive'], 'the retry');
  assert.equal(b.last().message, 'Brought back “Two”. 1 more to undo');
  assert.deepEqual(ids(b.AppView), [1]);
});

test('a network failure puts the entry back with Undo, with the unarchive wording', async () => {
  const b = makeBoard();
  await b.AppView._archiveSession(5, 'Five');
  b.sandbox.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await b.pressUndo();
  assert.deepEqual(ids(b.AppView), [5]);
  assert.equal(b.last().message, message('changes:session.unarchive.failedWith', { error: 'Failed to fetch' }));
  assert.ok(b.last().opts.action);
});

test('Undo on a restore whose memory was purged shows the same notice as Unarchive', async () => {
  const b = makeBoard();
  b.sandbox.fetch = async (url, init) => {
    b.posted.push({ url, method: init && init.method });
    return { ok: true, status: 200, json: async () => ({ ok: true, ccPurged: /unarchive/.test(url) }) };
  };
  await b.AppView._archiveSession(6, 'Six');
  await b.pressUndo();
  assert.equal(b.alerts.length, 1);
  assert.equal(b.alerts[0].title, message('changes:session.unarchive.restoredTitle'));
  assert.equal(b.alerts[0].message, message('changes:session.unarchive.restoredMessage'));
});

test("an entry for another project's slug clears the stack first, on push and on undo", async () => {
  const b = makeBoard({ slug: 'notes' });
  await b.AppView._archiveSession(1, 'One');
  await b.AppView._archiveSession(2, 'Two');
  // Another project opens; archiving there starts afresh.
  b.AppView.appData = { slug: 'recipes' };
  await b.AppView._archiveSession(3, 'Three');
  assert.deepEqual(plain(b.AppView._archiveUndo), [{ id: 3, title: 'Three', verb: 'archived', slug: 'recipes' }]);
  assert.equal(b.last().message, 'Archived “Three”', 'counts this project only');
  // Pressing a notice left over from the other project undoes nothing there.
  b.AppView.appData = { slug: 'notes' };
  await b.pressUndo();
  assert.deepEqual(unarchives(b.posted), [], 'no POST for the other project');
  assert.deepEqual(plain(b.AppView._archiveUndo), [], 'cleared');
});

test('a 21st push drops the oldest', async () => {
  const b = makeBoard();
  assert.equal(b.AppView.ARCHIVE_UNDO_MAX, 20);
  for (let id = 1; id <= 21; id += 1) await b.AppView._archiveSession(id, `S${id}`);
  assert.equal(b.AppView._archiveUndo.length, 20);
  assert.equal(b.AppView._archiveUndo[0].id, 2, 'the oldest went');
  assert.equal(b.AppView._archiveUndo[19].id, 21);
  assert.equal(b.last().message, 'Archived “S21”. 20 to undo');
});

test('a second press while an undo is in flight does nothing', async () => {
  const b = makeBoard();
  await b.AppView._archiveSession(1, 'One');
  await b.AppView._archiveSession(2, 'Two');
  let release;
  b.sandbox.fetch = async (url, init) => {
    b.posted.push({ url, method: init && init.method });
    await new Promise((resolve) => { release = resolve; });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const first = b.AppView._undoLastArchive();
  await new Promise((resolve) => setImmediate(resolve));
  await b.AppView._undoLastArchive();
  assert.deepEqual(unarchives(b.posted), ['/api/sessions/2/unarchive'], 'one POST');
  release();
  await first;
  assert.deepEqual(ids(b.AppView), [1]);
});

test('the board pins the plan: push only after the POST, priority toast, newest popped, the topic head repainted', () => {
  const archive = SRC.slice(SRC.indexOf('  async _archiveSession('), SRC.indexOf('  _archiveUndo: []'));
  assert.ok(archive.indexOf('_pushArchiveUndo(') > archive.indexOf("fetch(`/api/sessions/${sessionId}/archive`"), 'pushed after the POST succeeded');
  assert.match(SRC, /priority: true, duration: 8000/);
  assert.match(SRC, /const entry = stack\.pop\(\);/);
  assert.match(SRC, /fetch\(`\/api\/sessions\/\$\{entry\.id\}\/unarchive`, \{ method: 'POST' \}\)/);
  const withdraw = SRC.slice(SRC.indexOf('  async withdrawProposal('), SRC.indexOf('  async withdrawProposal(') + 2500);
  assert.match(withdraw, /verb: 'withdrawn'/);
});

// ── Messages: the agent session's own stack ─────────────────────────────

function agentWorld({ unarchive = () => 200 } = {}) {
  const requests = [];
  const toasts = [];
  const sessions = {
    7: { id: 7, title: 'Dark mode', status: 'open', focusApp: null, focusContext: {}, busy: false, activeChange: null, changes: [] },
    8: { id: 8, title: 'Faster search', status: 'open', focusApp: null, focusContext: {}, busy: false, activeChange: null, changes: [] },
  };
  globalThis.window = {
    location: { hash: '' },
    App: { setHeaderTitle() {} },
    UsernodeReact: {},
    PlatformUI: {
      toast(msg, opts) { toasts.push({ message: msg, opts: opts || {} }); },
      confirm: async () => true,
    },
  };
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = withStateRead(async (url, init = {}) => {
    const method = init.method || 'GET';
    requests.push([method, url]);
    const m = /^\/api\/agent-sessions\/(\d+)/.exec(url);
    const id = m ? Number(m[1]) : null;
    if (/\/archive$/.test(url)) sessions[id] = { ...sessions[id], status: 'archived' };
    if (/\/unarchive$/.test(url)) {
      const status = unarchive(id);
      if (status !== 200) return { ok: false, status, json: async () => ({ error: `HTTP ${status}` }) };
      sessions[id] = { ...sessions[id], status: 'open' };
    }
    const body = /\/messages\?/.test(url) ? { messages: [], nextAfter: null }
      : /\/actions$/.test(url) ? { actions: [] }
        : /\/drafts$/.test(url) ? { drafts: [] }
          : /\/api\/agent-sessions(\?|$)/.test(url) ? { sessions: Object.values(sessions).filter((s) => s.status === 'open') }
            : { session: sessions[id], turn: null };
    return { ok: true, status: 200, json: async () => body };
  });
  const api = loadTsx('tests/fixtures/agent-session-api.ts');
  const last = () => toasts[toasts.length - 1];
  const pressUndo = async () => {
    const t = last();
    assert.equal(t.opts.action.label, message('agent:session.archiveUndo.undo'));
    t.opts.action.handler();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };
  const done = () => {
    delete globalThis.window;
    delete globalThis.fetch;
    delete globalThis.EventSource;
  };
  return { api, requests, toasts, last, pressUndo, done };
}

const agentUnarchives = (requests) => requests.filter(([m, u]) => m === 'POST' && /\/unarchive$/.test(u)).map(([, u]) => u);

test('archiving agent sessions from Messages toasts with Undo, and Undo calls /api/agent-sessions/:id/unarchive newest first', async () => {
  const w = agentWorld();
  try {
    await w.api.openAgentSession({ id: 7, host: 'messages' });
    await w.api.archiveCurrentSession();
    assert.equal(w.api.getAgentSessionState().session.status, 'archived');
    assert.equal(w.last().message, message('agent:session.archiveUndo.archived', { title: 'Dark mode', count: 1 }));
    assert.equal(w.last().message, 'Archived “Dark mode”');
    assert.equal(w.last().opts.priority, true);
    assert.equal(w.last().opts.duration, 8000);
    assert.equal(w.last().opts.action.label, 'Undo');

    await w.api.openAgentSession({ id: 8, host: 'messages' });
    await w.api.archiveCurrentSession();
    assert.deepEqual(w.api.archiveUndoEntries().map((e) => e.id), [7, 8], 'newest last');
    assert.equal(w.last().message, 'Archived “Faster search”. 2 to undo');

    await w.pressUndo();
    assert.deepEqual(agentUnarchives(w.requests), ['/api/agent-sessions/8/unarchive']);
    assert.equal(w.api.getAgentSessionState().session.status, 'open', 'the open conversation leaves its read-only state');
    assert.equal(w.last().message, message('agent:session.archiveUndo.restored', { title: 'Faster search', count: 1 }));
    assert.equal(w.last().message, 'Brought back “Faster search”. 1 more to undo');
    assert.ok(w.last().opts.action);

    await w.pressUndo();
    assert.deepEqual(agentUnarchives(w.requests), ['/api/agent-sessions/8/unarchive', '/api/agent-sessions/7/unarchive']);
    assert.equal(w.last().message, message('agent:session.archiveUndo.restoredLast', { title: 'Dark mode' }));
    assert.equal(w.last().opts.action, undefined, 'nothing left: no Undo');
    assert.deepEqual(w.api.archiveUndoEntries(), []);
    // The lists' read waits for the platform viewer, which this world has
    // none of (as agent-session-controls.test.js's archive case): pin the
    // call in the source instead.
    const undo = STORE.slice(STORE.indexOf('export async function undoLastArchive'), STORE.indexOf('export async function undoLastArchive') + 1200);
    assert.match(undo, /if \(state\.id === entry\.id\) publish\(\{ session \}\);\s*void loadAgentSessions\(\);/, 'the open conversation is published and the lists are read again');
  } finally {
    w.done();
  }
});

test('in Messages a 503 keeps the entry with Undo attached and a 404 drops it; the stack holds 20', async () => {
  let busy = 1;
  const w = agentWorld({ unarchive: (id) => (id === 8 ? 404 : busy-- > 0 ? 503 : 200) });
  try {
    await w.api.openAgentSession({ id: 7, host: 'messages' });
    await w.api.archiveCurrentSession();
    await w.api.openAgentSession({ id: 8, host: 'messages' });
    await w.api.archiveCurrentSession();

    await w.pressUndo();
    assert.deepEqual(w.api.archiveUndoEntries().map((e) => e.id), [7], '404: eight is gone');
    assert.equal(w.last().message, 'Archived “Dark mode”', 'the rest re-toast');

    await w.pressUndo();
    assert.deepEqual(w.api.archiveUndoEntries().map((e) => e.id), [7], '503: put back');
    assert.equal(w.last().message, 'HTTP 503');
    assert.equal(w.last().opts.action.label, 'Undo');

    await w.pressUndo();
    assert.deepEqual(w.api.archiveUndoEntries(), []);
    assert.equal(w.last().message, 'Brought back “Dark mode”');
    assert.equal(w.api.ARCHIVE_UNDO_MAX, 20);
    assert.match(STORE, /while \(archiveUndo\.length > ARCHIVE_UNDO_MAX\) archiveUndo\.shift\(\);/, 'a 21st push drops the oldest');
    assert.match(STORE, /pushArchiveUndo\(\{ id, title: session\.title/, 'pushed after api.archiveSession resolved');
  } finally {
    w.done();
  }
});
