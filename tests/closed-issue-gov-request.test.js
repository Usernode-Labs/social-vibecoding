// #5999: a proposal that closes a request shows the request itself.
//
// Once a request is closed you reach it through the proposal that closed it,
// and that page said only why. The gov topic now fetches the targeted
// request (GET /github-issues/:number, the same single-request fetch a
// closed issue's own page uses) into `_govRequest`, after paint, and
// publishes it as `body.closesRequest` for the About sheet to draw above the
// closer's reason. This file covers:
//   1. The builder loads nothing: an empty cache gives no closesRequest and
//      the reason is still the note.
//   2. `_loadGovRequest` fetches once, republishes the head, and the view
//      then carries the title, the asker, the link and the words WITHOUT the
//      "Source:" line.
//   3. A second call makes no fetch; a 404 is remembered as missing and is
//      not retried.
//   4. Only a close_issue row targets a request — a rename fetches nothing.
//   5. The React side draws the block (with RequestWords) above the reason,
//      under a label that exists in the catalog.
//
// Same vm harness as closed-issue-topic.test.js.
//
// Run with: node --test tests/closed-issue-gov-request.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
// renderComponent resolves an entry relative to the repository root.
const HEAD_REL = 'frontend/src/features/dev-board/topic/topic-head.tsx';
const HEAD_TSX = path.join(ROOT, HEAD_REL);
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app-view.js'), 'utf8');

function makeAppView({ fetchImpl } = {}) {
  const sandbox = {
    console,
    URLSearchParams,
    location: { search: '' },
    App: { user: { id: 1, username: 'me' }, currentApp: 'demo', switchTab() {} },
    Kudos: { renderButton: () => '' },
    PlatformUI: { toast() {} },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach() {} }),
      addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} },
    },
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({}) })),
    requestAnimationFrame: (fn) => fn(),
    alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo' };
  AppView._ghIssues = [];
  AppView._govProposals = [];
  return { AppView, sandbox };
}

// A settled close-issue governance row, as /merged answers it.
const closeRow = (over) => ({
  id: 42,
  kind: 'close_issue',
  row_type: 'close_issue',
  status: 'closed',
  title: 'Close issue #1069',
  description: '',
  up_count: 1,
  down_count: 0,
  created_at: '2026-06-02T00:00:00Z',
  created_by_username: 'snait',
  payload: {
    issueNumber: 1069,
    issueTitle: 'Toggle resets after refresh',
    reason: 'Exact duplicate of request #1068.',
  },
  ...over,
});

// Shaped like GET /api/apps/:slug/github-issues/:number answers it.
const closedIssue = (over) => ({
  number: 1069,
  title: 'Toggle resets after refresh',
  body: '**Source:** Homeroom user (maya)\n\nIt used to stay on after a refresh.',
  labels: [],
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-09T00:00:00Z',
  htmlUrl: 'https://github.com/o/r/issues/1069',
  user: 'someone',
  state: 'closed',
  closedAt: '2026-06-09T00:00:00Z',
  bounty_count: 0,
  my_bounty: false,
  created_by_username: 'maya',
  headless: null,
  in_progress: null,
  ...over,
});

test('the builder loads nothing: an empty cache draws no request and keeps the reason', () => {
  const { AppView } = makeAppView();
  const view = AppView._topicViewFor('gov', closeRow());
  assert.equal(view.body.closesRequest, null);
  assert.equal(view.body.note, 'Exact duplicate of request #1068.');
});

test('_loadGovRequest fetches the request once and republishes the head', async () => {
  const calls = [];
  const respond = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ issue: closedIssue() }) };
  };
  const { AppView } = makeAppView({ fetchImpl: (url) => respond(url) });
  let repaints = 0;
  AppView._renderTopicHead = () => { repaints += 1; };
  const row = closeRow();

  await AppView._loadGovRequest(AppView._govRequestNumber(row));

  assert.equal(calls.length, 1, 'one fetch');
  assert.match(calls[0], /^\/api\/apps\/demo\/github-issues\/1069/);
  assert.equal(repaints, 1, 'the head repaints when the answer lands');

  const view = AppView._topicViewFor('gov', row);
  const closes = view.body.closesRequest;
  assert.ok(closes, 'the request is drawn');
  assert.equal(closes.number, 1069);
  assert.equal(closes.title, 'Toggle resets after refresh');
  assert.equal(closes.asker, 'maya');
  assert.equal(closes.href, '#app/demo/dev/issues/1069');
  assert.equal(closes.label, 'The request');
  assert.ok(closes.askedTime, 'when it was asked');
  assert.match(closes.bodyHtml, /stay on after a refresh/, 'the words');
  assert.ok(!/Source:/.test(closes.bodyHtml), 'the Source line is dropped, as on the request page');
  // The reason for closing is still there, below it.
  assert.equal(view.body.note, 'Exact duplicate of request #1068.');
});

test('a second call makes no fetch, and a 404 is remembered as missing', async () => {
  let calls = 0;
  let status = 200;
  const fetchImpl = async () => {
    calls += 1;
    if (status !== 200) return { ok: false, status, json: async () => ({ error: 'Issue not found' }) };
    return { ok: true, json: async () => ({ issue: closedIssue() }) };
  };
  const { AppView } = makeAppView({ fetchImpl });
  AppView._renderTopicHead = () => {};
  const row = closeRow();

  await AppView._loadGovRequest(1069);
  await AppView._loadGovRequest(1069);
  assert.equal(calls, 1, 'a second paint reads the cache');

  status = 404;
  await AppView._loadGovRequest(1070);
  await AppView._loadGovRequest(1070);
  assert.equal(calls, 2, 'a miss is not refetched');
  assert.equal(AppView._govRequest['demo:1070'].phase, 'missing');
  assert.equal(AppView._topicViewFor('gov', closeRow({
    payload: { issueNumber: 1070, issueTitle: 'Gone', reason: 'Duplicate.' },
  })).body.closesRequest, null);
});

test('only a close_issue row targets a request', async () => {
  let calls = 0;
  const { AppView } = makeAppView({ fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({}) }; } });
  AppView._renderTopicHead = () => {};
  const rename = closeRow({
    id: 43, kind: 'rename', row_type: 'rename', status: 'open',
    payload: { newName: 'Something else' },
  });
  assert.equal(AppView._govRequestNumber(rename), null);
  assert.equal(AppView._topicViewFor('gov', rename).body.closesRequest, null);
  // Nor does a close row whose payload carries no usable number.
  assert.equal(AppView._govRequestNumber(closeRow({ payload: { issueNumber: 'x' } })), null);
  assert.equal(AppView._govRequestNumber(closeRow({ payload: { issueNumber: 0 } })), null);
  assert.equal(calls, 0);
});

test('TopicBodySections draws the request above the reason, and nothing without one', () => {
  const body = {
    aboutTitle: 'About this proposal',
    note: 'Exact duplicate of request #1068.',
    closesRequest: {
      number: 1069,
      label: 'The request',
      title: 'Toggle resets after refresh',
      asker: 'maya',
      askedAt: '2026-06-01T00:00:00Z',
      askedTime: '2h ago',
      askedTitle: 'June 1',
      bodyHtml: '<div class="dev-issue-body"><p class="dc-p">It used to stay on after a refresh.</p></div>',
      href: '#app/demo/dev/issues/1069',
    },
  };
  const html = renderComponent(HEAD_REL, 'TopicBodySections', { body });
  const at = html.indexOf('data-closes-request="1069"');
  assert.ok(at > 0, 'the block is drawn');
  assert.ok(html.indexOf('The request') > 0, 'under its label');
  assert.ok(html.indexOf('>maya<') > at, 'who asked');
  assert.match(html, /<a class="dev-topic-closes-title" href="#app\/demo\/dev\/issues\/1069">Toggle resets after refresh<\/a>/,
    'the title links to the request’s own page');
  assert.ok(html.indexOf('stay on after a refresh') > at, 'its words');
  assert.ok(html.indexOf('dev-request-ask') > at, 'as the request page’s quote, with its fold');
  assert.ok(html.indexOf('dev-topic-note') > at, 'above the reason for closing');

  // Without one, the sheet is exactly the reason — no placeholder, no error.
  const plain = renderComponent(HEAD_REL, 'TopicBodySections', {
    body: { aboutTitle: 'About this proposal', note: 'Exact duplicate.' },
  });
  assert.ok(!plain.includes('data-closes-request'), 'nothing in its place');
  assert.match(plain, /dev-topic-note">Exact duplicate\./);
});

test('the About sheet draws the request above the reason, under a catalogued label', () => {
  const tsx = fs.readFileSync(
    path.join(ROOT, 'frontend', 'src', 'features', 'dev-board', 'topic', 'topic-head.tsx'),
    'utf8'
  );
  const closesAt = tsx.indexOf('data-closes-request');
  const reasonAt = tsx.indexOf('{body.note ?');
  assert.ok(closesAt > 0, 'the close-proposal block is drawn');
  assert.ok(reasonAt > closesAt, 'above the reason for closing');
  assert.ok(tsx.slice(closesAt).includes('<RequestWords html={closes.bodyHtml} />'), 'the words use the request page’s quote');
  assert.ok(tsx.includes("from './request-head'"), 'RequestWords comes from the request page');

  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend', 'locales', 'en', 'changes.json'), 'utf8'));
  assert.equal(catalog['governance.closes.title'].text, 'The request');
  assert.ok(catalog['governance.closes.title'].description);
});
