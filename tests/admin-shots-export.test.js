// Before & after shots runs as one CSV: GET /api/admin/shots/export.csv.
//
// The route against a mocked pool, the way admin-homeroom-bot.test.js pins
// the bot's verdict export: a view-only admin is refused (a bulk download is
// write-gated like the other exports), the file is streamed with a filename
// that says what is in it, the columns are pinned in order, filters reach the
// query as parameters, an unusable filter is refused rather than dropped,
// the agent's private final responses never reach the file, and a failure
// after the first chunk aborts the download instead of ending it cleanly.
// Then the surface: the gallery offers the link to full admins only, and
// dapp.json exercises the panel.
//
// Run with: node --test tests/admin-shots-export.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const SECRET = 'PRIVATE-FINAL-ANSWER-TEXT';

// Three runs, newest first. The failed one carries every shape the CSV has
// to survive (a comma, a quote, a newline, a leading `=`) and a private
// final answer that must not reach the file.
const runs = [
  {
    id: 'c'.repeat(32), session_id: 12, app_slug: 'todo', app_name: 'Todo',
    created_cursor: '2026-09-29 10:00:00.000003+00',
    created_at: new Date('2026-09-29T10:00:00Z'), started_at: new Date('2026-09-29T10:00:05Z'),
    completed_at: new Date('2026-09-29T10:08:05Z'), updated_at: new Date('2026-09-29T10:08:05Z'),
    state: 'failed', trigger: 'submit', repair_attempt: 0, current_run: true,
    session_status: 'active', session_source: 'imported', session_title: 'Board: add a due date',
    pr_number: 3401, pr_url: 'https://github.com/Usernode-Labs/social-vibecoding/pull/3401',
    failure_code: 'agent_deadline', failure_reason: '=HYPERLINK("x"), then\n"stopped"',
    base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), plan_hash: null,
    intent: { version: 1, impact: 'ui', stories: [{ id: 'due-date', claim: 'A due date shows' }] },
    hard_verdict: null,
    trace_summary: {
      failure: { phase: 'explore', code: 'agent_deadline', message: 'The shots agent ran out of time.' },
      terminalFailureClass: 'agent_deadline',
      agentAttempts: 1,
      agentDispatches: [{ requestedBackend: 'claude_code', requestedModel: 'model-a', budgetMs: 480000 }],
      agentFinalResponse: { text: SECRET },
      agentFinalResponses: [{ dispatch: 1, text: SECRET }],
      tokenUsage: { inputTokens: 1200, outputTokens: 300, costCents: 4 },
      timingsMs: { provisioning: 60000, total: 485000 },
      planSource: 'shots_agent',
      artifactBytes: 0,
      agentActivity: {
        budgetMs: 480000, counts: { tool_start: 9 }, toolCounts: { browser_navigate: 4 },
        browserCallCounts: {}, events: Array.from({ length: 14 }, (_, i) => ({ kind: 'tool_end', at: i })),
        pendingProviderRequests: [{ stage: 'await_first_byte', ms: 90000 }],
        pendingTools: [], pendingBrowserCalls: [], pendingDocumentRequests: [],
      },
    },
    artifacts_retained: 0, artifact_bytes_retained: '0',
  },
  {
    id: 'b'.repeat(32), session_id: 12, app_slug: 'todo', app_name: 'Todo',
    created_cursor: '2026-09-28 09:00:00.000002+00',
    created_at: new Date('2026-09-28T09:00:00Z'), state: 'stale', current_run: false,
    base_sha: 'a'.repeat(40), head_sha: 'd'.repeat(40), intent: { version: 1, impact: 'ui', stories: [] },
    trace_summary: null, artifacts_retained: 0, artifact_bytes_retained: '0',
  },
  {
    id: 'a'.repeat(32), session_id: 7, app_slug: 'notes', app_name: 'Notes',
    created_cursor: '2026-09-27 08:00:00.000001+00',
    created_at: new Date('2026-09-27T08:00:00Z'), started_at: new Date('2026-09-27T08:00:00Z'),
    completed_at: new Date('2026-09-27T08:03:00Z'), state: 'verified', current_run: true,
    base_sha: 'e'.repeat(40), head_sha: 'f'.repeat(40), plan_hash: '1'.repeat(64),
    intent: { version: 1, impact: 'ui', stories: [{ id: 's1' }, { id: 's2' }] },
    hard_verdict: {
      mode: 'shots', passed: true, runs: 1,
      stories: [{ id: 's1', status: 'ready', files: 4 }, { id: 's2', status: 'skipped', reason: 'Not reachable' }],
    },
    trace_summary: { artifactBytes: 50000, planSource: 'shots_agent' },
    artifacts_retained: 4, artifact_bytes_retained: '50000',
  },
];

// Every parameter list the runs query is called with, so a filter is
// checked where it is applied rather than by reading the rows back.
const queries = [];
let failOnPage = null;

const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  async query(sql, params) {
    const s = String(sql);
    if (/FROM shot_runs r/.test(s)) {
      queries.push(params);
      if (failOnPage != null && queries.length >= failOnPage) throw new Error('connection lost');
      // [app, states, since, cursorCreatedAt, cursorId, limit]
      const [app, states, since, cursorAt, cursorId, limit] = params;
      const rows = runs
        .filter((r) => !app || r.app_slug === app)
        .filter((r) => !states || states.includes(r.state))
        .filter((r) => !since || r.created_at >= new Date(since))
        .filter((r) => cursorAt == null
          || r.created_cursor < cursorAt || (r.created_cursor === cursorAt && r.id < cursorId))
        .slice(0, limit);
      return { rows };
    }
    return { rows: [] };
  },
});

const { adminRoutes } = require('../src/routes/admin');
const shotsExport = require('../src/services/shots-export');
const express = require('express');

const NORMAL = { id: 2, username: 'pat', isAdmin: false, canAdminWrite: false };
const VIEW_ADMIN = { id: 3, username: 'viewer', isAdmin: true, canAdminWrite: false };
const FULL_ADMIN = { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true };

let server;
let base;
let who = FULL_ADMIN;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = who; next(); });
  app.use(adminRoutes({ jwtSecret: 'test' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const get = (url) => fetch(`${base}${url}`, { redirect: 'manual' });
// Records by run id, not physical lines: a quoted field may hold a newline.
const recordIds = (body) => body.split('\n').filter((l) => /^[0-9a-f]{32},/.test(l)).map((l) => l.slice(0, 32));

test('the bulk download is write-gated like the other exports; a non-admin never reaches it', async () => {
  // adminMiddleware turns a non-admin away; under this harness's mount it
  // is a redirect (see the same note in admin-homeroom-bot.test.js).
  who = NORMAL;
  let res = await get('/api/admin/shots/export.csv');
  assert.ok(res.status === 302 || res.status === 403, `non-admin is turned away (${res.status})`);

  who = VIEW_ADMIN;
  queries.length = 0;
  res = await get('/api/admin/shots/export.csv');
  assert.equal(res.status, 403, 'a view-only admin reads the gallery but does not get the file');
  assert.equal(queries.length, 0, 'and nothing was queried for them');

  const admin = read('src/routes/admin.js');
  assert.match(admin, /router\.get\('\/api\/admin\/shots\/export\.csv', requireAdminWrite,/);
  who = FULL_ADMIN;
});

test('a full admin gets every run, newest first, as a named, uncached CSV', async () => {
  who = FULL_ADMIN;
  queries.length = 0;
  const res = await get('/api/admin/shots/export.csv');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.match(res.headers.get('content-disposition'),
    /^attachment; filename="shots-runs-all-apps-all-states-\d{4}-\d{2}-\d{2}\.csv"$/);
  const body = await res.text();
  assert.equal(body.split('\n')[0], shotsExport.EXPORT_COLUMNS.join(','));
  assert.deepEqual(recordIds(body), ['c'.repeat(32), 'b'.repeat(32), 'a'.repeat(32)],
    'one row per run: the stale run a newer commit replaced is in the file too');
  assert.deepEqual(queries[0], [null, null, null, null, null, shotsExport.EXPORT_CHUNK]);
});

test('the columns are pinned in order, so an analysis that reads them by position keeps working', () => {
  assert.deepEqual([...shotsExport.EXPORT_COLUMNS], [
    'run_id', 'created_at', 'started_at', 'completed_at', 'updated_at', 'duration_ms',
    'app_slug', 'app_name', 'session_id', 'session_title', 'session_status', 'session_source',
    'pr_number', 'pr_url', 'proposal_path',
    'trigger', 'repair_attempt', 'current_run', 'state',
    'failure_code', 'failure_reason', 'failure_phase', 'failure_message',
    'failure_tool', 'failure_tool_code', 'failure_tool_message', 'terminal_failure_class',
    'failure_detail_json',
    'impact', 'stories_declared', 'stories_ready', 'stories_skipped', 'story_results_json',
    'plan_source', 'agent_attempts', 'agent_backends', 'agent_models', 'agent_budget_ms',
    'agent_dispatches_json',
    'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
    'output_tokens', 'reasoning_output_tokens', 'cost_cents',
    'total_ms', 'timings_json',
    'agent_counts_json', 'agent_tool_counts_json', 'agent_browser_call_counts_json',
    'agent_last_events_json', 'agent_pending_json', 'control_json',
    'artifact_bytes_stored', 'artifacts_retained', 'artifact_bytes_retained',
    'base_sha', 'head_sha', 'plan_hash',
    'fixture_fingerprint', 'base_image_digest', 'head_image_digest',
    'overridden_by', 'overridden_at', 'override_reason',
    'intent_json', 'diagnostics_path',
    'interrupted_by',
    'agent_exit_code', 'agent_exit_cause',
    'worker_memory_limit_mb', 'worker_memory_peak_mb', 'worker_memory_last_mb',
    'worker_oom_kills', 'worker_memory_by_process_json',
    'egress_blocked_json',
  ]);
});

test('a shots agent that died says how, with the worker\'s memory and what the proxy refused', () => {
  const died = shotsExport.exportRecord({
    ...runs[1],
    state: 'failed',
    failure_code: 'shots_agent_failed',
    trace_summary: {
      failure: { code: 'shots_agent_failed', detail: { exit: 'exit -1', exitCode: -1, exitCause: 'oom_killed' } },
      agentDispatches: [
        { requestedBackend: 'claude_code', outcome: 'failed', code: 'shots_agent_failed', exitCode: -1, exitCause: 'oom_killed' },
      ],
      workerMemory: {
        samples: 14, limitMb: 2048, peakUsedMb: 2041, lastUsedMb: 2030, containerPeakMb: 2047,
        oomKillsDuringTurn: 1, peakRssMb: { browser: 1450, agent: 400, mcp: 110, proxy: 40, other: 30 },
      },
      agentActivity: { egressBlocked: { 'private_address:pair_host': 3, 'dns:other': 1 } },
    },
  });
  assert.equal(died.agent_exit_code, -1);
  assert.equal(died.agent_exit_cause, 'oom_killed');
  assert.equal(died.worker_memory_limit_mb, 2048);
  assert.equal(died.worker_memory_peak_mb, 2041);
  assert.equal(died.worker_memory_last_mb, 2030);
  assert.equal(died.worker_oom_kills, 1);
  assert.deepEqual(JSON.parse(died.worker_memory_by_process_json),
    { browser: 1450, agent: 400, mcp: 110, proxy: 40, other: 30 });
  assert.deepEqual(JSON.parse(died.egress_blocked_json), { 'private_address:pair_host': 3, 'dns:other': 1 });

  // A run from before these were recorded still gives its exit code.
  const older = shotsExport.exportRecord({ ...runs[1], trace_summary: { failure: { detail: 'exit -1' } } });
  assert.equal(older.agent_exit_code, -1);
  assert.equal(older.agent_exit_cause, null);
  // And a run with none of it leaves every new column blank.
  const quiet = shotsExport.exportRecord(runs[1]);
  for (const column of ['agent_exit_code', 'agent_exit_cause', 'worker_memory_limit_mb', 'worker_memory_peak_mb',
    'worker_memory_last_mb', 'worker_oom_kills', 'worker_memory_by_process_json', 'egress_blocked_json']) {
    assert.equal(quiet[column], null, column);
  }
  // Only a fixed word is copied out as the cause.
  const forged = shotsExport.exportRecord({ ...runs[1], trace_summary: {
    agentDispatches: [{ exitCode: -1, exitCause: '=HYPERLINK("x")' }] } });
  assert.equal(forged.agent_exit_cause, null);
});

test('a run a Homeroom restart interrupted says so; anything else leaves the column blank', () => {
  const restart = shotsExport.exportRecord({
    ...runs[1], failure_code: 'shots_run_interrupted', trace_summary: { interruptedBy: 'shutdown' },
  });
  assert.equal(restart.interrupted_by, 'shutdown');
  assert.equal(shotsExport.exportRecord(runs[0]).interrupted_by, null);
  assert.equal(shotsExport.exportRecord({ ...runs[1], trace_summary: { interruptedBy: '=cmd()' } }).interrupted_by,
    null, 'only a fixed tag is copied out');
});

test('a failed run carries what the diagnostics screen would say, and no private answer', () => {
  const rec = shotsExport.exportRecord(runs[0]);
  assert.equal(rec.duration_ms, 480000);
  assert.equal(rec.failure_code, 'agent_deadline');
  assert.equal(rec.failure_phase, 'explore');
  assert.equal(rec.terminal_failure_class, 'agent_deadline');
  assert.equal(rec.agent_backends, 'claude_code');
  assert.equal(rec.agent_models, 'model-a');
  assert.equal(rec.agent_budget_ms, 480000);
  assert.equal(rec.input_tokens, 1200);
  assert.equal(rec.cost_cents, 4);
  assert.equal(rec.total_ms, 485000);
  assert.equal(rec.current_run, true);
  assert.equal(rec.stories_declared, 1);
  assert.equal(rec.stories_ready, null, 'no verdict: nothing was judged ready or skipped');
  assert.equal(JSON.parse(rec.agent_last_events_json).length, 10, 'the tail of the event ring, not all of it');
  assert.deepEqual(JSON.parse(rec.agent_pending_json),
    { providerRequests: [{ stage: 'await_first_byte', ms: 90000 }] },
    'only the pending lists that hold something');
  assert.equal(rec.proposal_path, '/#app/todo/dev/proposals/12');
  assert.equal(rec.diagnostics_path,
    `/api/apps/todo/proposals/12/shots/diagnostics?runId=${'c'.repeat(32)}`);
  assert.ok(!JSON.stringify(rec).includes(SECRET), 'the final answer stays out of every column');
});

test('a verified run counts what its verdict judged and what it still retains', () => {
  const rec = shotsExport.exportRecord(runs[2]);
  assert.equal(rec.stories_declared, 2);
  assert.equal(rec.stories_ready, 1);
  assert.equal(rec.stories_skipped, 1);
  assert.deepEqual(JSON.parse(rec.story_results_json), [
    { id: 's1', status: 'ready' },
    { id: 's2', status: 'skipped', reason: 'Not reachable' },
  ]);
  assert.equal(rec.artifact_bytes_stored, 50000);
  assert.equal(rec.artifacts_retained, 4);
  assert.equal(rec.artifact_bytes_retained, 50000, 'a bigint arrives as a string and leaves as a number');
  assert.equal(rec.failure_detail_json, null);
});

test('the file quotes what a spreadsheet would otherwise eat, and never holds the private answer', async () => {
  who = FULL_ADMIN;
  const body = await (await get('/api/admin/shots/export.csv')).text();
  assert.ok(body.includes(`"'=HYPERLINK(""x""), then\n""stopped"""`),
    'a leading = is defused, the comma and newline keep the field quoted, the quotes are doubled');
  assert.ok(!body.includes(SECRET));
  assert.equal(recordIds(body).length, 3, 'the newline inside the quoted field did not start a record');
});

test('filters reach the query as parameters and name the file', async () => {
  who = FULL_ADMIN;
  queries.length = 0;
  let res = await get('/api/admin/shots/export.csv?app=todo&state=failed&since=2026-09-01');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /shots-runs-todo-failed-since-2026-09-01-/);
  assert.deepEqual(recordIds(await res.text()), ['c'.repeat(32)]);
  assert.deepEqual(queries[0].slice(0, 3), ['todo', ['failed'], '2026-09-01T00:00:00.000Z']);

  queries.length = 0;
  res = await get('/api/admin/shots/export.csv?state=in_progress');
  assert.equal(res.status, 200);
  await res.text();
  assert.deepEqual(queries[0][1], ['planned', 'provisioning', 'exploring', 'replaying', 'reviewing'],
    '"in progress" is every state a run is still under way in');
});

test('an unusable filter is refused rather than dropped into a bigger file', async () => {
  who = FULL_ADMIN;
  for (const qs of ['state=bogus', 'app=Not%20A%20Slug', 'since=yesterday', 'since=2026-13-45']) {
    queries.length = 0;
    // eslint-disable-next-line no-await-in-loop
    const res = await get(`/api/admin/shots/export.csv?${qs}`);
    assert.equal(res.status, 400, qs);
    // eslint-disable-next-line no-await-in-loop
    assert.ok((await res.json()).error, qs);
    assert.equal(queries.length, 0, `${qs}: nothing was queried`);
  }
});

test('the export walks every page: each asks for rows below the last (created_at, id) it saw', async () => {
  queries.length = 0;
  const seen = [];
  for await (const chunk of shotsExport.iterateRunsForExport(poolMod.getPool(), { chunk: 1 })) {
    seen.push(chunk.map((r) => r.id[0]));
  }
  assert.deepEqual(seen, [['c'], ['b'], ['a']]);
  assert.deepEqual(queries.map((p) => [p[3], p[4] && p[4][0]]), [
    [null, null],
    ['2026-09-29 10:00:00.000003+00', 'c'],
    ['2026-09-28 09:00:00.000002+00', 'b'],
    ['2026-09-27 08:00:00.000001+00', 'a'],
  ], 'the cursor is the text form Postgres gave, microseconds and all, never a JS Date');
});

test('a failure after the first chunk aborts the download instead of ending it as if complete', async () => {
  who = FULL_ADMIN;
  // One row per page so a second query exists to fail.
  const original = shotsExport.iterateRunsForExport;
  shotsExport.iterateRunsForExport = (pool, filters) => original(pool, { ...filters, chunk: 1 });
  queries.length = 0;
  failOnPage = 2;
  try {
    const res = await get('/api/admin/shots/export.csv');
    assert.equal(res.status, 200, 'the status line was already sent with the first chunk');
    await assert.rejects(res.text(), 'the body is cut off, so the browser reports a failed download');
  } finally {
    failOnPage = null;
    shotsExport.iterateRunsForExport = original;
  }
});

test('the gallery offers the link to full admins only, carrying its filters', () => {
  const tsx = read('frontend/src/features/admin/admin-gallery.tsx');
  const panel = tsx.slice(tsx.indexOf('function ExportRuns'), tsx.indexOf('function GallerySection'));
  assert.match(panel, /\/api\/admin\/shots\/export\.csv/);
  assert.match(panel, /AdminConsole\?\.canWrite\(\)/);
  assert.match(panel, /\{canWrite \? \(\s*<a id="admin-gallery-export"/, 'the link renders only for a full admin');
  assert.match(panel, /id="admin-gallery-export-readonly"/, 'a view-only admin is told why there is no link');
  for (const key of ["'app'", "'state'", "'since'"]) {
    assert.ok(panel.includes(`params.set(${key}`), `the link carries ${key}`);
  }
  // Every state the panel offers is one the server accepts.
  const states = [...tsx.slice(tsx.indexOf('const EXPORT_STATES'), tsx.indexOf('const DOT'))
    .matchAll(/\['([a-z_]*)', '/g)].map((m) => m[1]).filter(Boolean);
  assert.ok(states.length >= 5, 'the state list was found');
  for (const s of states) assert.ok(shotsExport.STATE_FILTERS.includes(s), `${s} is a state the export takes`);
  assert.match(tsx, /<ExportRuns app=\{app\} \/>/);
});

// Folded into the gallery's existing check with :has() rather than added as
// its own: the declared-check count is pinned (tests/dev-board-fold.test.js)
// and the panel renders on the same route in the same mount.
test('dapp.json exercises the export panel on ids the gallery renders', () => {
  const dapp = JSON.parse(read('dapp.json'));
  const check = dapp.tests.find((t) => /#admin-gallery-export-panel/.test(t.expectSelector || ''));
  assert.ok(check, 'a declared check selects the panel');
  assert.equal(check.path, '/?demo=1#admin/gallery');
  const tsx = read('frontend/src/features/admin/admin-gallery.tsx');
  for (const id of check.expectSelector.match(/#[a-z-]+/g)) {
    assert.ok(tsx.includes(`id="${id.slice(1)}"`), `${id} is rendered by the gallery`);
  }
});
