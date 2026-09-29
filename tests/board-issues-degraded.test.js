// #2261: a degraded answer from GET /github-issues must not empty the board.
//
// AppView._fetchDevData stores that answer as _ghIssues, and _bucketDevItems
// derives BOTH the Issues column and the issue cards in the Underway column
// from it. It used to store whatever came back — `[]` for an HTTP failure,
// and the server's own empty list when it could not read GitHub — so one
// refused answer, on any of the WS-driven refreshes, painted both columns as
// "0 items" until the next successful one. Now a degraded answer (the
// request failed, its body did not parse, or an empty list arrived beside a
// `note` naming a failure) keeps the list the board already has and marks
// the metadata stale; a clean empty list still clears it, and nothing is
// kept before the first successful load.
//
// app-view.js is loaded into a vm context with a fetch stub whose
// /github-issues answer each test sets, the way board-pagination-refresh
// does for /merged.
//
// Run with: node --test tests/board-issues-degraded.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/app-view.js'), 'utf8');

const issue = (number, over = {}) => ({
  number, title: `Issue ${number}`, updatedAt: '2026-09-15T10:00:00Z', lastMessageAt: null,
  headless: null, in_progress: null, ...over,
});

function fixture() {
  // What the next /github-issues request answers. `body` undefined = a body
  // that does not parse.
  const state = { answer: { status: 200, body: { issues: [] } }, calls: [] };
  const sandbox = {
    console, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    App: { user: { id: 3 }, currentApp: 'demo', currentTab: 'dev', currentSubTab: 'forum' },
    location: { search: '', hash: '' }, localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {},
    document: { getElementById: () => null },
    fetch: async (address) => {
      const url = new URL(address, 'https://example.test');
      state.calls.push(url.pathname);
      if (url.pathname.endsWith('/github-issues')) {
        const a = state.answer;
        return {
          ok: a.status >= 200 && a.status < 300,
          status: a.status,
          json: async () => {
            if (a.body === undefined) throw new SyntaxError('Unexpected token < in JSON');
            return JSON.parse(JSON.stringify(a.body));
          },
        };
      }
      let data = {};
      if (url.pathname.endsWith('/merged')) data = { merged: [], hasMore: false, total: 0 };
      else if (url.pathname.endsWith('/promoted')) data = { promoted: [] };
      else if (url.pathname.endsWith('/issues')) data = { issues: [] };
      return { ok: true, json: async () => data };
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nglobalThis.subject = AppView;`, sandbox);
  const av = sandbox.subject;
  av.appData = { slug: 'demo', repo_url: 'https://github.com/o/r' };
  av._repaintDevBody = () => {};
  av._loadWorkshopThemes = () => {};
  av._syncChecksPoll = () => {};
  const load = async () => av._loadDevData();
  // Array.from lands the numbers in the host realm: arrays the vm's code
  // built fail strict deep-equality against host literals otherwise.
  const numbers = () => Array.from(av._ghIssues, (i) => i.number);
  return { av, state, load, numbers };
}

const GOOD = { status: 200, body: { issues: [issue(1), issue(2, { in_progress: { count: 1, users: [] } })], myRemaining: 3 } };

test('a refused refresh keeps the list the board already has, and says so', async () => {
  const { av, state, load, numbers } = fixture();
  state.answer = GOOD;
  assert.equal(await load(), true);
  assert.deepEqual(numbers(), [1, 2]);
  assert.equal(av._ghIssuesMeta.stale, false);
  assert.equal(av._ghIssuesMeta.note, null);

  state.answer = { status: 502, body: {} };
  assert.equal(await load(), true, 'the load as a whole still succeeds');
  assert.deepEqual(numbers(), [1, 2], 'the list is kept');
  assert.equal(av._ghIssuesMeta.note, 'fetch failed');
  assert.equal(av._ghIssuesMeta.stale, true);
  assert.equal(av._ghIssuesMeta.myRemaining, 3, 'the rest of the metadata is kept with it');

  // And the board still places them: #1 in Issues, #2 (in progress) in Underway.
  const b = av._bucketDevItems({ issues: av._ghIssues, proposals: [], gov: [], merged: [] });
  assert.deepEqual(Array.from(b.issues, (i) => i.number), [1]);
  assert.deepEqual(Array.from(b.inProgress, (e) => `${e.kind}:${e.item.number}`), ['issue:2']);
});

test('an empty list beside a failure note is a degraded answer, not "no open issues"', async () => {
  const { av, state, load, numbers } = fixture();
  state.answer = GOOD;
  await load();
  for (const note of ['rate limited', 'fetch failed', 'unavailable']) {
    state.answer = { status: 200, body: { issues: [], note, myRemaining: 3 } };
    assert.equal(await load(), true);
    assert.deepEqual(numbers(), [1, 2], `kept on note "${note}"`);
    assert.equal(av._ghIssuesMeta.note, note);
    assert.equal(av._ghIssuesMeta.stale, true);
  }
});

test('a body that does not parse keeps the list', async () => {
  const { av, state, load, numbers } = fixture();
  state.answer = GOOD;
  await load();
  state.answer = { status: 200, body: undefined };
  assert.equal(await load(), true);
  assert.deepEqual(numbers(), [1, 2]);
  assert.equal(av._ghIssuesMeta.note, 'fetch failed');
  assert.equal(av._ghIssuesMeta.stale, true);
});

test('a clean empty list still clears the board: GitHub says there are none', async () => {
  const { av, state, load, numbers } = fixture();
  state.answer = GOOD;
  await load();
  state.answer = { status: 200, body: { issues: [], myRemaining: 3 } };
  assert.equal(await load(), true);
  assert.deepEqual(numbers(), []);
  assert.equal(av._ghIssuesMeta.note, null);
  assert.equal(av._ghIssuesMeta.stale, false);
});

test("the server's own fallback list is stored as the list, flagged stale", async () => {
  const { av, state, load, numbers } = fixture();
  state.answer = GOOD;
  await load();
  state.answer = { status: 200, body: { issues: [issue(1)], note: 'fetch failed', stale: true, myRemaining: 3 } };
  assert.equal(await load(), true);
  assert.deepEqual(numbers(), [1], 'the server already chose the fallback; take it');
  assert.equal(av._ghIssuesMeta.note, 'fetch failed');
  assert.equal(av._ghIssuesMeta.stale, true);
});

test('nothing is kept before the first successful load', async () => {
  const { av, state, load, numbers } = fixture();
  state.answer = { status: 500, body: {} };
  assert.equal(await load(), true);
  assert.deepEqual(numbers(), []);
  assert.equal(av._ghIssuesMeta.note, 'fetch failed');
  assert.equal(av._ghIssuesMeta.stale, false, 'no list to be stale relative to');
});

test('a later good answer replaces the kept list and clears the flag', async () => {
  const { av, state, load, numbers } = fixture();
  state.answer = GOOD;
  await load();
  state.answer = { status: 503, body: {} };
  await load();
  assert.equal(av._ghIssuesMeta.stale, true);
  state.answer = { status: 200, body: { issues: [issue(3)], myRemaining: 2 } };
  assert.equal(await load(), true);
  assert.deepEqual(numbers(), [3]);
  assert.equal(av._ghIssuesMeta.note, null);
  assert.equal(av._ghIssuesMeta.stale, false);
  assert.equal(av._ghIssuesMeta.myRemaining, 2);
});
