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
  const html = renderToHtml(createElement(ChangeDetail, { ...v, item: failing, owner: true }));
  for (const label of ['Where it stands', 'Addresses', 'Testing instructions', 'Screenshots', 'Activity', 'Discussion', 'Expected app, received login']) assert.ok(html.includes(label), label);
  assert.ok(html.includes('&lt;script&gt;issue&lt;/script&gt;'));
  assert.ok(!html.includes('<script>issue</script>'));
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
