'use strict';

// #6827: a change or request page starts its reads together instead of one
// after another. A change page asks ONE address for everything it shows —
// `GET /api/apps/:slug/changes/:number/page`, answering the change, its
// request home, its thread and its proposal row with the before/after
// picture addresses — and that answer seeds the reads the page's parts
// already make. The picture starts loading from the same answer.
//
// Run with: node --test tests/change-page-read.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const TOPIC = 'frontend/src/features/dev-board/topic';
const VOTES = 'src/routes/votes.js';
const THREADS = 'src/routes/threads.js';

// ── The server's half ─────────────────────────────────────────────────

test('S1: one read answers a change page, built from the pieces that already exist', () => {
  const src = read(VOTES);
  const route = src.slice(
    src.indexOf("router.get('/api/apps/:slug/changes/:number/page'"),
    src.indexOf("router.get('/api/apps/:slug/proposals/:id'"),
  );
  assert.ok(route, 'the page route exists');
  assert.match(route, /changeSessionIdFor\(gatedApp, req, number\)/, 'by the number in the address');
  assert.match(route, /threadsSvc\.requestHome\(/, 'where it lives');
  assert.match(route, /threadsSvc\.threadForNumber\(/, 'its thread');
  assert.match(route, /readProposalRow\(/, 'its proposal row');
  assert.match(route, /sessionId, prNumber: number, request, thread,/, 'the answer the client reads');
  assert.match(route, /proposal: row \? row\.proposal : null/);
  assert.match(route, /context: row \? row\.context : null/);
});

test('S2: the proposal page and a change page cannot drift in field names', () => {
  const src = read(VOTES);
  const proposalRoute = src.slice(
    src.indexOf("router.get('/api/apps/:slug/proposals/:id'"),
    src.indexOf("router.get('/api/apps/:slug/proposals/:id'") + 1600,
  );
  assert.match(proposalRoute, /readProposalRow\(/, 'the proposal route calls the shared read');
  assert.match(proposalRoute, /res\.json\(out\)/);
  const fn = src.slice(src.indexOf('async function readProposalRow('));
  assert.match(fn.slice(0, fn.indexOf('\n}\n')), /return \{ proposal: listTestResults\.forItem\(req, proposal\), context \};/,
    'the shared read answers the row and the vote context');
  assert.match(fn, /if \(!proposal\) return null;/, 'an unknown or hidden id is null, which the route answers 404');
});

test('S3: a thread can answer with its changes\' rows, and only when asked', () => {
  const src = read(THREADS);
  assert.match(src, /req\.query\.with === 'changes'/, 'opt-in');
  assert.match(src, /out\.changes = Object\.fromEntries\(rows\)/, 'keyed by session id');
  assert.match(src, /readProposalRow\(\s*\{ pool \}, reqFailing, found\.app, id/,
    'each row is the same shape ?results=failing answers');
  assert.match(src, /results: 'failing'/, 'and asks for failing checks only');
});

// ── The client's half ─────────────────────────────────────────────────

function withBrowser(bridge, run) {
  const previous = { window: global.window, fetch: global.fetch, Image: global.Image };
  const fetched = [];
  const preloaded = [];
  global.window = { AppView: { appData: { slug: 'demo' }, _demoQS: () => '', _changeHomes: new Map() } };
  global.fetch = async (url) => {
    fetched.push(String(url));
    return { ok: true, json: async () => bridge(url) };
  };
  global.Image = class {
    constructor() { this.decoding = ''; }
    set src(value) { preloaded.push(value); }
    get src() { return preloaded[preloaded.length - 1]; }
  };
  return Promise.resolve()
    .then(() => run({ fetched, preloaded }))
    .finally(() => {
      if (previous.window === undefined) delete global.window; else global.window = previous.window;
      if (previous.fetch === undefined) delete global.fetch; else global.fetch = previous.fetch;
      if (previous.Image === undefined) delete global.Image; else global.Image = previous.Image;
    });
}

const picture = {
  variant: 'context', theme: 'light', media: 'png', side: 'head',
  url: '/api/apps/demo/proposals/7/shots/shot-after',
};
const pageAnswer = (over = {}) => ({
  sessionId: 7,
  prNumber: 42,
  request: null,
  thread: {
    thread: { id: 3, number: 42, kind: 'work', title: null, state: 'open' },
    items: [{ type: 'change', id: 7, number: 42, title: 'A change', status: 'promoted', state: 'review', replies: 0 }],
    follow: null,
    moves: [],
  },
  proposal: { id: 7, status: 'promoted', shots: { state: 'verified', artifacts: [picture] } },
  context: { slug: 'demo', majority: 2, activeUsers: 4 },
  ...over,
});

test('C1: a change page\'s read is sent once per open and seeds every part', async () => {
  const { prefetchChangePage, peekChangePage, peekChangeProposal, peekThread, threadPath } = loadTsx(`${TOPIC}/thread-items.tsx`);
  await withBrowser(() => pageAnswer(), async ({ fetched, preloaded }) => {
    const first = prefetchChangePage('demo', 42);
    const second = prefetchChangePage('demo', 42);
    assert.equal(second, first, 'a second ask joins the first');
    await first;
    assert.equal(fetched.length, 1, 'one request for the whole page');
    assert.equal(fetched[0], '/api/apps/demo/changes/42/page');

    const page = peekChangePage('demo', 42);
    assert.equal(page.sessionId, 7, 'the change\'s id, so the address costs no /changes read');
    assert.equal(peekChangeProposal('demo', 7).proposal.id, 7, 'the proposal row the page already has');

    const thread = peekThread(threadPath('demo', 42) + '?as=change');
    assert.ok(thread && thread.items.length === 1, 'the change\'s own thread, seeded for its page');
    assert.deepEqual(preloaded, [picture.url], 'the main picture starts loading from the answer');
  });
});

test('C2: a change built for a request seeds the request\'s thread and home', async () => {
  const { prefetchChangePage, peekThread, threadPath } = loadTsx(`${TOPIC}/thread-items.tsx`);
  await withBrowser(() => pageAnswer({ request: 9 }), async () => {
    await prefetchChangePage('demo', 42);
    assert.ok(peekThread(threadPath('demo', 9)), 'the request\'s page takes this thread without reading again');
    const homes = global.window.AppView._changeHomes;
    assert.equal(await homes.get('demo:7'), 9, 'and the change\'s home, so the page forwards at once');
  });
});

test('C3: a page read that answers nothing (404) leaves every map empty', async () => {
  const { prefetchChangePage, peekChangePage } = loadTsx(`${TOPIC}/thread-items.tsx`);
  await withBrowser(() => ({ error: 'Change not found' }), async ({ fetched }) => {
    await prefetchChangePage('demo', 404);
    assert.equal(fetched.length, 1);
    assert.equal(peekChangePage('demo', 404), null, 'and the client falls back to its own reads');
  });
});

test('C4: a change\'s read that already answered is the page\'s read, not another request', async () => {
  const { seedPrefetchedChange, readChangeDetail } = loadTsx(`${TOPIC}/topic-head.tsx`);
  await withBrowser(() => ({ proposal: { id: 7, status: 'promoted' } }), async ({ fetched }) => {
    seedPrefetchedChange([{ id: 7, status: 'promoted' }]);
    global.window.AppView._loadVoteRoster = () => Promise.resolve();
    global.window.AppView._invalidateVoteRoster = () => {};
    const signal = new AbortController().signal;
    const row = await readChangeDetail({ id: 7, status: 'promoted' }, false, signal);
    assert.equal(row.id, 7);
    assert.equal(fetched.length, 0, 'no /proposals read for a row the page already carried');
    // #6827: a read that settled is shared for its 10 s too.
    await readChangeDetail({ id: 7, status: 'promoted' }, false, signal);
    assert.equal(fetched.length, 0);
    // A fresh read (after a gap or a vote) still goes to the server.
    await readChangeDetail({ id: 7, status: 'promoted' }, false, signal, { fresh: true });
    assert.equal(fetched.length, 1);
  });
});

test('C6: the address takes the page\'s answer for the change\'s id, and reads only when it is not there', async () => {
  const vm = require('node:vm');
  const { englishPlatformI18n } = require('./lib/platform-i18n');
  const fetched = [];
  const sandbox = {
    console,
    relTime: () => ({ text: '', title: '' }),
    relStamp: () => ({ text: '', title: '' }),
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentApp: 'demo', currentTab: 'dev' },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: () => {}, body: { appendChild: () => {} },
    },
    fetch: async (url) => {
      fetched.push(String(url));
      return { ok: true, json: async () => ({ sessionId: 7, prNumber: 42 }) };
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { search: '', hash: '', href: 'http://localhost/' },
    URLSearchParams,
    PlatformI18n: englishPlatformI18n(),
    UsernodeReact: { devBoard: { peekChangePage: () => ({ sessionId: 7, request: null, proposal: { id: 7 } }) } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${read('public/js/app-view.js')}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo' };
  AppView._renderTopicHead = () => {};
  assert.equal(await AppView._sessionIdForChange(42), 7, 'the prefetched answer');
  assert.deepEqual(fetched, [], 'and no /changes read on top of it');
  sandbox.UsernodeReact.devBoard.peekChangePage = () => null;
  assert.equal(await AppView._sessionIdForChange(42), 7);
  assert.deepEqual(fetched, ['/api/apps/demo/changes/42'], 'a page with no answer still resolves by its own read');
});

test('C5: the page\'s own read starts with the route, from a change\'s address', () => {
  const src = read('public/js/app.js');
  const open = src.slice(src.indexOf('const initialRoute = App._normalizeTab('), src.indexOf('promise: AppView.open('));
  assert.match(open, /prefetchChangePage\?\.\(slug, Number\(pre\.pr\)\)/,
    'the change\'s read starts beside the app\'s, not after it');
  assert.match(open, /prefetchThread\?\.\(slug, Number\(pre\.id\)\)/, 'and a request\'s thread read beside it');
  const view = read('public/js/app-view.js');
  assert.match(view, /peekChangePage\?\.\(slug, Number\(pr\)\)/, 'the address takes the prefetched session id');
  assert.match(view, /peekChangeProposal\?\.\(slug, Number\(id\)\)/, 'and the row, without a second proposal read');
});
