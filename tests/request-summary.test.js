'use strict';

// Homeroom bot's summary at the top of a request's page
// (src/services/request-summary.js, llm.js generateRequestSummary, the
// request_summaries table). These tests hold what it is written from, when
// it is written again, and that a reader never waits on it, against a pool
// that plays the table; tests/request-summary-postgres.test.js runs the same
// service on a real database.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const summary = require('../src/services/request-summary');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const change = (over = {}) => ({ id: 51, title: 'A moon button beside the bell', summary: 'Adds a moon button to the header.', by: 'sam', state: 'vote', ...over });
const inputs = (over = {}) => ({ title: 'Dark mode switch', body: 'Settings is three taps away.', asker: 'maya', plan: null, changes: [], ...over });

test('a summary is written only once there is a plan or a change, and says which it drew on', () => {
  assert.equal(summary.basisOf(inputs()), null, 'the asker\'s own words are all there is');
  assert.equal(summary.basisOf(inputs({ plan: 'A moon button.' })), 'plan');
  assert.equal(summary.basisOf(inputs({ plan: 'A moon button.', changes: [change()] })), 'change');
  assert.equal(summary.basisOf(inputs({ changes: [change(), change({ id: 52 })] })), 'changes');
});

test('the key names everything the summary is written from, and nothing else', () => {
  const base = summary.inputKey(inputs({ plan: 'A moon button.', changes: [change()] }));
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(summary.inputKey(inputs({ plan: 'A moon button.', changes: [change()] })), base, 'the same inputs, the same key');
  const moved = [
    inputs({ title: 'Dark mode toggle', plan: 'A moon button.', changes: [change()] }),
    inputs({ body: 'Edited.', plan: 'A moon button.', changes: [change()] }),
    inputs({ plan: 'A moon button, v2.', changes: [change()] }),
    inputs({ plan: 'A moon button.', changes: [change({ summary: 'Reworded.' })] }),
    inputs({ plan: 'A moon button.', changes: [change({ state: 'merging' })] }),
    inputs({ plan: 'A moon button.', changes: [change(), change({ id: 52 })] }),
  ];
  for (const next of moved) assert.notEqual(summary.inputKey(next), base);
});

test('the model is given the request, the plan and each change, labelled and clipped', () => {
  const text = summary.promptInput(inputs({
    body: 'x'.repeat(9000),
    plan: 'A moon button in the header.',
    changes: [change(), change({ id: 52, title: 'In the account menu', by: 'evan', state: 'merged' })],
  }));
  assert.match(text, /^ASKED BY: maya\nREQUEST TITLE: Dark mode switch\nREQUEST, AS WRITTEN:\n/);
  assert.ok(text.length < 9000, 'a long request is clipped');
  assert.match(text, /THE PLAN POSTED FOR IT:\nA moon button in the header\./);
  assert.match(text, /CHANGE A \(up for a vote\), by sam: A moon button beside the bell\nAdds a moon button to the header\./);
  assert.match(text, /CHANGE B \(merged\), by evan: In the account menu/);
  const planOnly = summary.promptInput(inputs({ plan: 'A plan.' }));
  assert.doesNotMatch(planOnly, /CHANGES BUILT FOR IT|none yet/, 'the model is not asked where things stand, so it is told nothing about it');
});

// A pool that plays request_summaries, the shared plan, the changes, and the
// request rows `refresh` reads.
function fakePool({ plan = null, changes = [], request = null, attached = [] } = {}) {
  const state = { row: null, plan, changes, request, attached, queries: [] };
  const query = async (sql, args) => {
    state.queries.push(sql);
    if (/FROM chat_session_specs/.test(sql)) return { rows: state.plan ? [{ content: state.plan }] : [] };
    if (/FROM chat_sessions cs/.test(sql)) {
      return { rows: state.changes.map((c) => ({ id: c.id, pr_title: c.title, pr_summary_md: c.summary, status: c.state === 'merged' ? 'merged' : c.state === 'merging' ? 'merging' : 'promoted', username: c.by })) };
    }
    if (/SELECT DISTINCT r\.number/.test(sql)) return { rows: state.attached.map((number) => ({ number })) };
    if (/FROM requests r\s+LEFT JOIN users/.test(sql)) {
      const r = state.request;
      return { rows: r ? [{
        title: r.title ?? 'Dark mode switch',
        body: r.body ?? 'Settings is three taps away.',
        state: r.state ?? 'open',
        author_login: r.author_login ?? null,
        created_by_username: r.created_by_username ?? 'maya',
        issue_username: r.issue_username ?? null,
      }] : [] };
    }
    if (/^SELECT input_key/.test(sql.trim())) return { rows: state.row ? [state.row] : [] };
    if (/^INSERT INTO request_summaries/.test(sql.trim())) {
      const key = args[2];
      const held = state.row && state.row.generating_until && state.row.generating_until > Date.now();
      const current = state.row && state.row.input_key === key && state.row.summary;
      const failedLately = state.row && state.row.failed_at && state.row.failed_at > Date.now() - summary.RETRY_MS;
      if (held || current || failedLately) return { rows: [] };
      state.row = state.row
        ? { ...state.row, generating_until: Date.now() + 60000 }
        : { input_key: key, summary: null, basis: null, failed_at: null, generating_until: Date.now() + 60000 };
      return { rows: [{ generating_until: new Date() }] };
    }
    if (/^UPDATE request_summaries/.test(sql.trim())) {
      const [, , key, text, basis, , failed] = args;
      state.row = failed
        ? { ...state.row, failed_at: Date.now(), generating_until: null }
        : { ...state.row, input_key: key, summary: text, basis, failed_at: null, generating_until: null };
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  };
  return { state, query };
}

const issue = { title: 'Dark mode switch', body: 'Settings is three taps away.' };
const ask = (pool, deps) => summary.forRequest(pool, { appId: 7, number: 12, issue, asker: 'maya' }, deps);

test('with only the asker\'s words there is no summary, and the model is never asked', async () => {
  const pool = fakePool();
  let calls = 0;
  assert.equal(await ask(pool, { enabled: true, wait: true, generate: async () => { calls += 1; return { summary: 'x' }; } }), null);
  assert.equal(calls, 0);
  assert.ok(!pool.state.queries.some((sql) => /request_summaries/.test(sql)), 'and its row is not even read');
});

test('written once for what it draws on, reused while that stands, written again when it moves', async () => {
  const pool = fakePool({ plan: 'A moon button.' });
  let calls = 0;
  const deps = { enabled: true, wait: true, generate: async ({ input }) => { calls += 1; assert.match(input, /THE PLAN POSTED FOR IT/); return { summary: `Summary ${calls}.`, model: 'stub' }; } };
  assert.deepEqual(await ask(pool, deps), { text: 'Summary 1. There is a plan for it; nothing is built yet.', basis: 'plan' });
  assert.deepEqual(await ask(pool, deps), { text: 'Summary 1. There is a plan for it; nothing is built yet.', basis: 'plan' });
  assert.equal(calls, 1, 'the second read is the stored one');
  pool.state.changes = [change()];
  assert.deepEqual(await ask(pool, deps), { text: 'Summary 2. A change for it is up for a vote.', basis: 'change' }, 'a change built for it is new to say');
  assert.equal(calls, 2);
});

test('a reader never waits: the write runs behind the read, which returns what was there', async () => {
  const pool = fakePool({ plan: 'A moon button.' });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = await ask(pool, { enabled: true, generate: async () => { await gate; return { summary: 'Written later.' }; } });
  assert.equal(first, null, 'nothing was written yet, so the page shows the asker\'s words');
  const second = await ask(pool, { enabled: true, generate: async () => { assert.fail('one writer at a time'); } });
  assert.equal(second, null);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await ask(pool, { enabled: true, generate: async () => { assert.fail('it is current'); } }), { text: 'Written later. There is a plan for it; nothing is built yet.', basis: 'plan' });
});

test('a write that fails keeps the summary it had, holds off, then tries again', async () => {
  const pool = fakePool({ plan: 'A moon button.' });
  const ok = { enabled: true, wait: true, generate: async () => ({ summary: 'The first.' }) };
  assert.deepEqual(await ask(pool, ok), { text: 'The first. There is a plan for it; nothing is built yet.', basis: 'plan' });
  pool.state.plan = 'A moon button, v2.';
  const failing = { enabled: true, wait: true, generate: async () => { throw new Error('model down'); } };
  assert.deepEqual(await ask(pool, failing), { text: 'The first. There is a plan for it; nothing is built yet.', basis: 'plan' }, 'the page keeps what it showed');
  let calls = 0;
  const again = { enabled: true, wait: true, generate: async () => { calls += 1; return { summary: 'The second.' }; } };
  assert.deepEqual(await ask(pool, again), { text: 'The first. There is a plan for it; nothing is built yet.', basis: 'plan' });
  assert.equal(calls, 0, 'not asked again inside the hold');
  pool.state.row.failed_at = Date.now() - summary.RETRY_MS - 1000;
  assert.deepEqual(await ask(pool, again), { text: 'The second. There is a plan for it; nothing is built yet.', basis: 'plan' });
  assert.equal(calls, 1);
});

test('with no model (a staging copy) nothing is written, and a broken read is a page without a summary', async () => {
  const pool = fakePool({ plan: 'A moon button.' });
  assert.equal(await ask(pool, { enabled: false, generate: async () => { assert.fail('no model'); } }), null);
  assert.equal(pool.state.row, null);
  assert.equal(await summary.forRequest({ query: async () => { throw new Error('db down'); } }, { appId: 7, number: 12, issue, asker: 'maya' }, { enabled: true }), null);
});

test('a plan is summarised first, and a change attached afterwards is written again', async () => {
  const pool = fakePool({ plan: 'A moon button.' });
  const seen = [];
  const deps = { enabled: true, wait: true, generate: async ({ input }) => { seen.push(input); return { summary: `Summary ${seen.length}.` }; } };
  assert.deepEqual(await ask(pool, deps), { text: 'Summary 1. There is a plan for it; nothing is built yet.', basis: 'plan' });
  assert.doesNotMatch(seen[0], /CHANGES BUILT FOR IT|none yet/, 'the model is told nothing about what is built');
  pool.state.changes = [change()];
  assert.deepEqual(await ask(pool, deps), { text: 'Summary 2. A change for it is up for a vote.', basis: 'change' }, 'a change built for it is new to say');
  assert.match(seen[1], /CHANGE\s+\(up for a vote\)/, 'the change is labelled for the model');
});

test('the key names the v3 inputs, so every earlier summary is written again', () => {
  const src = read('src/services/request-summary.js');
  assert.match(src, /'v3'/, 'every stored row mismatches and is rewritten on its next read');
  assert.doesNotMatch(src, /'v2'/);
  const v2 = crypto.createHash('sha256')
    .update(['v2', 'Dark mode switch', 'Settings is three taps away.', 'maya', '', '51:A moon button beside the bell:Adds a moon button to the header.:open'].join('\u0000'))
    .digest('hex');
  assert.notEqual(summary.inputKey(inputs({ changes: [change()] })), v2);
});

test('the status sentence is Homeroom\'s, written from the same list the page shows', () => {
  const s = summary.statusSentence;
  assert.equal(s({ plan: null, changes: [] }), 'Nothing is built yet.');
  assert.equal(s({ plan: 'A plan.', changes: [] }), 'There is a plan for it; nothing is built yet.');
  assert.equal(s({ changes: [change()] }), 'A change for it is up for a vote.');
  assert.equal(s({ changes: [change({ state: 'merging' })] }), 'A change for it is being merged.');
  assert.equal(s({ changes: [change({ state: 'merged' })] }), 'A change for it was merged.');
  assert.equal(s({ changes: [change(), change({ id: 52 })] }), 'Two changes for it are up for a vote.');
  assert.equal(s({ changes: [change({ state: 'merging' }), change({ id: 52, state: 'merging' })] }), 'Two changes for it are being merged.');
  assert.equal(s({ changes: [change({ state: 'merged' }), change({ id: 52, state: 'merged' })] }), 'Two changes for it were merged.');
  assert.equal(
    s({ changes: [change(), change({ id: 52, state: 'merging' }), change({ id: 53, state: 'merged' }), change({ id: 54, state: 'merged' })] }),
    'One change for it is up for a vote, one is being merged and two were merged.'
  );
  assert.equal(
    s({ changes: [change(), change({ id: 52, state: 'merged' })] }),
    'One change for it is up for a vote and one was merged.'
  );
  // At most four changes are read, so five are counted as four.
  assert.equal(
    s({ changes: [1, 2, 3, 4, 5].map((id) => change({ id })) }),
    'Four changes for it are up for a vote.'
  );
  assert.equal(s({ changes: [change(), change({ id: 52 })] }), s({ plan: 'A plan.', changes: [change(), change({ id: 52 })] }), 'a plan is not mentioned once a change exists');
});

test('a change being merged is its own state, never up for a vote', async () => {
  const pool = fakePool({ changes: [change({ state: 'merging' })] });
  const seen = [];
  const deps = { enabled: true, wait: true, generate: async ({ input }) => { seen.push(input); return { summary: 'It adds a moon button.' }; } };
  assert.deepEqual(await ask(pool, deps), { text: 'It adds a moon button. A change for it is being merged.', basis: 'change' });
  assert.deepEqual(await summary.visibleChanges(pool, 7, 12), [{
    id: 51, title: 'A moon button beside the bell', summary: 'Adds a moon button to the header.', by: 'sam', state: 'merging',
  }]);
  assert.match(seen[0], /CHANGE\s+\(being merged\)/);
  assert.doesNotMatch(seen[0], /up for a vote/);
  const keys = ['vote', 'merging', 'merged'].map((state) => summary.inputKey(inputs({ changes: [change({ state })] })));
  assert.equal(new Set(keys).size, 3, 'a move from vote to merging to merged is written again');
});

test('an answer that claims what is built, voted on or merged is refused', () => {
  const llm = require('../src/services/llm');
  for (const text of [
    'Maya asked for X. Nothing is built yet.',
    'Nothing has been made yet.',
    'It is not built yet.',
    'No changes have been built.',
    'A change for it is up for a vote.',
    'It is being voted on.',
    'This was merged yesterday.',
    'Two buttons are built into the header.',
  ]) assert.equal(llm.requestSummaryClaimsStatus(text), true, text);
  assert.equal(llm.requestSummaryClaimsStatus('Maya asked for a moon button. The plan adds it beside the bell.'), false);
  const src = read('src/services/llm.js');
  const fn = src.slice(src.indexOf('async function generateRequestSummary'), src.indexOf('const REVISED_DESCRIPTION_SCHEMA'));
  assert.match(fn, /validate: \(a\) => typeof \(a && a\.summary\) === 'string'/, 'the helper call passes a validate');
  assert.match(fn, /summary = dropStatusClaims\(summary\);/, 'and a second answer that still claims it loses that sentence');
});

test('a sentence that claims the status is dropped, and the status sentence stands alone if nothing is left', () => {
  const llm = require('../src/services/llm');
  assert.equal(llm.dropStatusClaims('Maya asked for X. Nothing is built yet. It adds a button.'), 'Maya asked for X. It adds a button.');
  const text = summary.composeSummary('Maya asked for X. Nothing is built yet.', 'A change for it is up for a vote.');
  assert.equal(text, 'Maya asked for X. A change for it is up for a vote.');
  assert.doesNotMatch(text, /Nothing is built/);
  assert.equal(summary.composeSummary('Nothing is built yet.', 'A change for it is up for a vote.'), 'A change for it is up for a vote.');
});

test('the status sentence is kept whole and the model\'s words are cut to fit', () => {
  const words = `${'Word '.repeat(140)}.`;
  const text = summary.composeSummary(words, 'A change for it is up for a vote.');
  assert.ok(text.length <= 600, `the summary is ${text.length} characters`);
  assert.ok(text.endsWith('A change for it is up for a vote.'), 'the status sentence is whole');
  const sentences = summary.composeSummary(`${'A sentence that goes on. '.repeat(40)}`, 'Two changes for it are up for a vote.');
  assert.ok(sentences.length <= 600);
  assert.ok(sentences.endsWith('Two changes for it are up for a vote.'));
  assert.match(sentences, /\. Two changes for it are up for a vote\.$/, 'the words end at a sentence end');
});

test('a change put up for a vote rewrites the summary of the request it is attached to', async () => {
  const pool = fakePool({ plan: 'A moon button.', request: {}, attached: [12] });
  let calls = 0;
  const deps = { enabled: true, wait: true, generate: async () => { calls += 1; return { summary: 'The new words.' }; } };
  const listener = summary.onBoardChange(pool, deps);
  await listener({ appId: 7, appSlug: 'demo', sessionId: 51, action: 'promoted' });
  assert.equal(calls, 1, 'the summary is written without a page read');
  assert.deepEqual({ text: pool.state.row.summary, basis: pool.state.row.basis }, { text: 'The new words. There is a plan for it; nothing is built yet.', basis: 'plan' });
  assert.match(pool.state.queries.join('\n'), /SELECT DISTINCT r\.number/, 'the requests it is attached to are found first');

  const before = pool.state.queries.length;
  assert.deepEqual(await listener({ appId: 7, appSlug: 'demo', sessionId: 51, action: 'merged' }), []);
  assert.equal(pool.state.queries.length, before, 'any other action asks nothing');

  const closed = fakePool({ plan: 'A moon button.', request: { state: 'closed' }, attached: [12] });
  let closedCalls = 0;
  await summary.onBoardChange(closed, { enabled: true, wait: true, generate: async () => { closedCalls += 1; return { summary: 'x' }; } })({ appId: 7, sessionId: 51, action: 'promoted' });
  assert.equal(closedCalls, 0, 'a closed request is left alone');
});

test('only what every member can read reaches the model: shared plans, and changes up for a vote or merged', () => {
  const src = read('src/services/request-summary.js');
  assert.match(src, /AND s\.shared_to_group_at IS NOT NULL/, 'a draft plan is not read');
  assert.match(src, /AND cs\.is_headless = FALSE\s+AND cs\.status IN \('promoted', 'merging', 'merged'\)/, 'a change still in somebody\'s workspace is not read');
  assert.match(src, /\$2::int = ANY\(cs\.linked_issues\)/, 'a change that names the request is read');
  assert.match(src, /cs\.created_from_issue_number = \$2/, 'a change started from the request is read');
  assert.match(src, /cs\.thread_id IN \(SELECT t\.id FROM requests r JOIN threads t ON t\.id = r\.thread_id/, 'a change on the request\'s thread is read');
  assert.match(src, /SELECT t\.merged_into FROM requests/, 'and one on the thread it merged into');
  assert.doesNotMatch(src, /request_summaries WHERE app_id = \$1 AND issue_number = \$2 AND input_key/, 'never a backfill sweep of every row');
  const sql = read('src/db/migrations/request-summaries.sql');
  assert.match(sql, /COMMENT ON TABLE request_summaries IS 'staging:private';/, 'a staging copy gets none of the rows');
  assert.match(sql, /PRIMARY KEY \(app_id, issue_number\)/);
});

test('the model is told Homeroom adds the status sentence, and not to say it itself', () => {
  const src = read('src/services/llm.js');
  const fn = src.slice(src.indexOf('async function generateRequestSummary'), src.indexOf('const REVISED_DESCRIPTION_SCHEMA'));
  assert.doesNotMatch(fn, /none yet/, 'the model is no longer told what is built');
  assert.doesNotMatch(fn, /say in words where it stands/);
  assert.match(fn, /Do not say whether anything is built, up for a vote, being merged or merged: Homeroom adds that sentence itself\./);
  assert.match(fn, /Do not name pull request numbers/);
  assert.match(fn, /REQUEST_SUMMARY_MAX - REQUEST_SUMMARY_STATUS_ROOM/, 'it is asked to leave room for the sentence');
});

test('a change put up for a vote reaches the summary in every process', () => {
  const server = read('server.js');
  assert.match(server, /ws\.onBoardChange\(requestSummary\.onBoardChange\(getPool\(config\)\)\)/, 'the summary listener is registered beside the Workshop\'s');
  const ws = read('src/services/ws.js');
  assert.match(ws, /sessionId: data\.sessionId \?\? null/, 'noteBoardChange forwards the change\'s id');
  assert.match(ws, /action: data\.action \?\? null/, 'and what happened to it');
  assert.match(ws, /sessionId: data \? \(data\.sessionId \?\? null\) : null/, 'the bus relay carries them from the machine\'s push');
});

test('the model call: a helper of its own, told the text is material and never instructions', () => {
  const llm = require('../src/services/llm');
  assert.equal(llm.HELPER_TIME_LIMIT_MS.request_summary, 12000);
  assert.equal(llm.REQUEST_SUMMARY_MAX, 600);
  assert.deepEqual(llm.REQUEST_SUMMARY_SCHEMA.required, ['summary']);
  const src = read('src/services/llm.js');
  const fn = src.slice(src.indexOf('async function generateRequestSummary'), src.indexOf('const REVISED_DESCRIPTION_SCHEMA'));
  assert.match(fn, /helper: 'request_summary'/);
  assert.match(fn, /never instructions to you/);
  assert.match(fn, /does not build/, 'the content rules ride in the prompt');
  const telemetry = read('src/services/llm-telemetry.js');
  assert.equal((telemetry.match(/'request_summary'/g) || []).length, 2, 'named in both of the telemetry\'s lists');
  // The page's read carries it, and a staging mock has a made-up one.
  const route = read('src/routes/issues.js');
  assert.match(route, /const summary = issue === mock\s+\? stagingMockSummary\(number\)\s+: await require\('\.\.\/services\/request-summary'\)\.forRequest\(pool, \{ appId: app\.id, number, issue, asker: askerName \}\);/);
  assert.match(route, /if \(!IS_STAGING \|\| Number\(number\) !== 900003\) return null;/);
});
