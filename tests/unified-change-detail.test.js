const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

function context(user = { id: 42, username: 'Builder' }) {
  const c = { console, App: { user, currentApp: 'example', currentTab: 'dev', _appUrl: (slug, tab, ref) => `#app/${slug}/${tab}/issues/${ref?.id}` },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null }, addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams };
  c.window = c;
  vm.createContext(c);
  for (const path of ['public/js/merge-status.js', 'public/js/app-view.js']) {
    vm.runInContext(fs.readFileSync(path, 'utf8'), c);
  }
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'example', can_collaborate: true };
  c.av._ghIssues = [{ number: 1993, title: 'Wait for authentication before opening previews' }];
  return c.av;
}

const failing = { id: 4073, user_id: 42, username: 'Builder', status: 'active',
  source: 'cli_handoff', proposal_state: 'failed', linked_issues: [1993],
  session_title: 'Authenticate previews', pr_title: 'Authenticate previews',
  staging_url: 'https://preview.example', check_state: 'failing',
  checks_commit_sha: 'a'.repeat(40), checks_base_sha: 'b'.repeat(40),
  test_results: [{ name: 'Preview login', path: '/preview', status: 'fail', failureReason: 'Expected app, received login' }],
  created_at: '2026-09-11T12:00:00Z' };
const row = (v, key) => v.body.details.ledger.find((r) => r.key === key);

test('underway and review share context, sections and check explanations', () => {
  const av = context();
  for (const status of ['active', 'promoted']) {
    const v = av._topicViewFor(status === 'active' ? 'session' : 'proposal', { ...failing, status });
    assert.equal(v.body.issues[0].title, av._ghIssues[0].title);
    assert.match(v.body.issues[0].href, /dev\/issues\/1993$/);
    assert.equal(row(v, 'checks').fails[0].reason, 'Expected app, received login');
    assert.ok(row(v, 'checks').actions.some((a) => /re-run/i.test(a.label)));
    assert.ok(v.body.testing);
    assert.equal(v.body.workspace, failing.id);
    assert.ok(v.body.activity.length);
  }
});

test('promotion remains blocked while checks fail, run, or belong to an unready handoff', () => {
  const av = context();
  for (const patch of [{}, { check_state: 'pending' }, { check_state: 'passing' }, { status: 'paused' }, { check_state: 'passing', proposal_state: 'ready', busy: true }, { check_state: 'passing', proposal_state: 'ready', checks_base_verdict: 'superseded' }]) {
    const v = av._topicViewFor('session', { ...failing, ...patch });
    assert.equal(row(v, 'review').actions[0].disabled, true);
  }
  const ready = av._topicViewFor('session', { ...failing, check_state: 'passing', proposal_state: 'ready' });
  assert.equal(row(ready, 'review').actions[0].disabled, false);
  const review = av._topicViewFor('proposal', { ...failing, status: 'promoted' });
  assert.equal(row(review, 'review'), undefined);
  assert.ok(review.card.actions.some((a) => a.key === 'yes'));
});

test('readers cannot promote, sync, or open the private workspace', () => {
  const av = context({ id: 99 });
  const v = av._topicViewFor('session', { ...failing, shared_at: '2026-09-11' });
  assert.equal(v.body.workspace, null);
  assert.equal(row(v, 'review').actions.length, 0);
  assert.ok(!v.body.details.ledger.some((r) => r.actions?.some((a) => a.key === 'sync-main')));
  assert.equal(v.body.transcript, null);
});

test('owner can sync before review, with busy and fork capabilities respected', () => {
  const av = context();
  const sync = (v) => v.body.details.ledger.flatMap((r) => r.actions || []).find((a) => a.key === 'sync-main');
  assert.ok(sync(av._topicViewFor('session', failing)));
  av._changeActions.set(failing.id, 'sync-main');
  assert.equal(sync(av._topicViewFor('session', failing)).disabled, true);
  assert.equal(sync(av._topicViewFor('session', { ...failing, source: 'imported', imported_pr_head_repo: 'someone/fork', repo_url: 'https://github.com/org/app' })), undefined);
});

test('underway freshness does not claim an automatic sync or scheduled merge is running', () => {
  const av = context();
  const v = av._topicViewFor('session', { ...failing, freshness_behind_by: 2, freshness_checked_at: failing.created_at });
  assert.equal(row(v, 'checks').label, 'Checks');
  assert.ok(v.body.details.ledger.some((r) => r.text.includes('2 commits behind main.')));
  assert.doesNotMatch(JSON.stringify(v.body.details.ledger), /automatic, now|automatic, after|retries the merge/);
});

test('private changes retain sharing controls and do not pretend to have a public discussion', () => {
  const av = context();
  const v = av._topicViewFor('session', failing);
  assert.ok(v.card.actions.some((a) => a.label === 'Make visible'));
  assert.match(v.body.discussion, /workspace stays private/);
});

test('actual shared component renders the entire card and escapes the issue title', () => {
  const av = context();
  av._ghIssues[0].title = '<script>issue</script>';
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const v = av._topicViewFor('session', failing);
  const html = renderToHtml(createElement(ChangeDetail, { ...v, item: failing, conversation: true }));
  for (const label of ['Where it stands', 'Addresses', 'Testing instructions', 'Screenshots', 'Activity', 'Discussion', 'Expected app, received login']) assert.ok(html.includes(label), label);
  assert.ok(html.includes('&lt;script&gt;issue&lt;/script&gt;'));
  assert.ok(!html.includes('<script>issue</script>'));
  assert.match(html, /role="tablist" aria-label="Conversation"/);
  assert.match(html, /role="tab"[^>]+aria-selected="true"[^>]*>Discussion/);
  assert.ok(html.includes('Agent workspace'));
  assert.ok(!html.includes('Open discussion'));
  assert.equal((html.match(/>Activity</g) || []).length, 1, 'Activity is a tab, not a duplicate disclosure');
});

test('issue and governance topic bodies are not rebuilt as proposals without a session', () => {
  const av = context();
  const v = av._topicViewFor('session', failing);
  const previousWindow = global.window;
  global.window = { AppView: { _topicViewFor() { throw new Error('Non-session topic rebuilt as proposal'); } } };
  try {
    const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
    const html = renderToHtml(createElement(ChangeDetail, { card: v.card, body: { ...v.body, comments: true }, item: null }));
    assert.match(html, /id="dev-issue-comments"/);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('detail refresh uses the lifecycle endpoint and preserves demo context', async () => {
  const { readChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const previousWindow = global.window;
  const previousFetch = global.fetch;
  const requests = [];
  let roster = 0;
  global.window = { AppView: { appData: { slug: 'example' }, _demoQS: () => '?demo=1',
    _invalidateVoteRoster() {}, _loadVoteRoster() { roster++; } } };
  const signal = new AbortController().signal;
  try {
    for (const status of ['active', 'paused', 'promoted', 'merging', 'merged']) {
      const session = { id: 123, status };
      const review = ['promoted', 'merging', 'merged'].includes(status);
      global.fetch = async (url, options) => {
        requests.push(url);
        assert.equal(options.signal, signal);
        return { ok: true, json: async () => review ? { proposal: session } : { session } };
      };
      assert.deepEqual(await readChangeDetail(session, true, signal), session);
      assert.equal(requests.at(-1), review ? '/api/apps/example/proposals/123?demo=1' : '/api/sessions/123/details?demo=1');
    }
    assert.equal(requests.length, 5, 'one authoritative detail request per refresh');
    assert.equal(roster, 3);
    global.fetch = async () => ({ ok: false, json: async () => ({ error: 'Unavailable' }) });
    await assert.rejects(readChangeDetail({ id: 123, status: 'active' }, true, signal), /Unavailable/);
  } finally {
    global.fetch = previousFetch;
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('Open card links use one detail route regardless of ownership or origin', () => {
  const { openHref } = loadTsx('frontend/src/features/dev-board/card/fold.tsx');
  for (const hook of ['data-session-chip', 'data-shared-session-row', 'data-proposal-row']) {
    assert.equal(openHref('example', { attrs: { [hook]: '4073' } }), '#app/example/dev/proposals/4073');
  }
});

test('the same detail URL resolves native/imported underway work and changes lifecycle after promotion', () => {
  const av = context();
  av._mySessions = [{ ...failing }];
  av._sharedSessions = [{ ...failing, id: 4074, user_id: 99, source: 'imported', shared_at: '2026-09-11' }];
  for (const id of [4073, 4074]) {
    const item = av._findItem('proposal', id);
    assert.equal(item.id, id);
    assert.ok(row(av._topicViewFor('proposal', item), 'review'), 'underway readiness, not review voting');
  }
  av._proposals = [{ ...failing, status: 'promoted' }];
  assert.equal(av._findItem('proposal', 4073).status, 'promoted');
  assert.equal(row(av._topicViewFor('proposal', av._findItem('proposal', 4073)), 'review'), undefined);
  av._mySessions = [];
  assert.equal(av._findItem('session', 4073).status, 'promoted', 'legacy shared link still resolves');
});

test('all change routes mount the full card, leaving discussion loading to its privacy-aware tab', () => {
  const av = context();
  av._devTopic = { kind: 'proposal', id: failing.id };
  av._mySessions = [{ ...failing }];
  const source = fs.readFileSync('public/js/app-view.js', 'utf8');
  const calls = [];
  const c = { AppView: av, document: { getElementById: () => ({}) },
    GroupChat: { mountThread: () => calls.push('public'), unmountThread: () => calls.push('detach') } };
  av._reactDevBoard = () => ({ publishTopicHead() {}, mountChangePage: () => calls.push('change') });
  const method = source.slice(source.indexOf('  _mountTopicThread() {'), source.indexOf('\n  // Open a topic full-screen.', source.indexOf('  _mountTopicThread() {'))).trim().replace(/,$/, '');
  vm.runInNewContext(`({ ${method} })._mountTopicThread()`, c);
  assert.deepEqual(calls, ['detach', 'change']);
  av._mySessions[0].shared_at = '2026-09-11';
  calls.length = 0;
  vm.runInNewContext(`({ ${method} })._mountTopicThread()`, c);
  assert.deepEqual(calls, ['detach', 'change']);
});

test('workspace capabilities distinguish owners, published transcripts, private chats and imports', () => {
  const { workspaceKind, ChangeConversation } = loadTsx('frontend/src/features/dev-board/topic/conversation.tsx');
  const av = context();
  const own = av._topicViewFor('session', failing).body;
  assert.equal(workspaceKind(failing, own), 'owner');
  assert.equal(workspaceKind({ ...failing, source: 'imported' }, own), 'imported');
  const other = context({ id: 99 })._topicViewFor('session', { ...failing, shared_at: '2026-09-11' }).body;
  assert.equal(workspaceKind(failing, other), 'private');
  assert.equal(workspaceKind(failing, { ...other, transcript: { id: failing.id } }), 'published');
  const privateHtml = renderToHtml(createElement(ChangeConversation, { item: failing, body: own }));
  assert.match(privateHtml, /Make this change visible/);
  assert.doesNotMatch(privateHtml, /data-change-discussion|id="dc-view"/, 'neither controller loads private messages just to display the card');
});

test('Continue building selects the embedded workspace without navigating away from the card', () => {
  const av = context();
  const source = fs.readFileSync('public/js/app-view.js', 'utf8');
  const method = source.slice(source.indexOf('  openChangeWorkspace(id) {'), source.indexOf('\n  _showExplorePill', source.indexOf('  openChangeWorkspace(id) {'))).trim().replace(/,$/, '');
  let present = true;
  const events = [], routes = [];
  av.openProposalSession = (id) => routes.push(id);
  const c = { AppView: av, document: { querySelector: () => present ? {} : null },
    window: { dispatchEvent: (event) => events.push(event) }, CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts.detail; } } };
  const open = vm.runInNewContext(`({ ${method} }).openChangeWorkspace`, c);
  open(4073);
  assert.equal(events[0].type, 'change-workspace-open');
  assert.equal(events[0].detail, 4073);
  assert.deepEqual(routes, []);
  present = false;
  open(4073);
  assert.deepEqual(routes, [4073], 'callers outside the card retain the session route');
});

test('Workshop native underway inline details resolve the owner card key', () => {
  const av = context(); av._mySessions = [failing];
  assert.equal(av._workshopCardBody('my-session:4073').changeId, 4073);
});
