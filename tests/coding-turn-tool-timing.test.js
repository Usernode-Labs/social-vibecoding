'use strict';

// Where a coding turn's time went (2026-10-07). A first-version build that
// day (session 6937) took 27.9 minutes over 226 model requests, 94 browser
// calls, 70 commands and 38 edits, and its metrics held only those totals.
// The OpenRouter request listener now stamps each request's start and end
// with atMs, ms since it started; the worker splits the turn into model time
// and the gaps between requests, each gap credited to the kinds of tool that
// ran in it, and notes when the first edit, the first app boot and the
// browser calls happened. These tests feed journals through the same parser
// a turn's journal goes through (worker.parseLine).

const test = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../src/services/worker');
const agentTurn = require('../src/services/agent-turn');
const llmTelemetry = require('../src/services/llm-telemetry');

const TIMING_FIELDS = [
  'modelRequestMs', 'browserToolMs', 'shellToolMs', 'editToolMs', 'readToolMs', 'otherToolMs',
  'firstFileChangeMs', 'firstAppBootMs', 'firstBrowserCallMs', 'lastBrowserCallMs',
];
const TIMING_METRICS = [
  'model_request_ms', 'browser_tool_ms', 'shell_tool_ms', 'edit_tool_ms', 'read_tool_ms',
  'other_tool_ms', 'first_file_change_ms', 'first_app_boot_ms', 'first_browser_call_ms',
  'last_browser_call_ms',
];

function openRouterState(harness) {
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  state.agentHarness = harness;
  state.telemetryDiagnosticsEnabled = true;
  return state;
}

const provider = (event) => `__USERNODE_CODING_PROVIDER__ ${JSON.stringify(event)}`;
// What the listener writes, with or without its clock (an older worker image
// sends none).
const start = (requestOrdinal, atMs) => provider({
  kind: 'provider_request_start', requestOrdinal, ...(atMs == null ? {} : { atMs }),
  payloadBytes: 100, inputBytes: 80, instructionBytes: 10, inputItems: 2,
  previousResponseLinked: false, maxOutputTokens: 64000,
});
const end = (requestOrdinal, atMs, durationMs) => provider({
  kind: 'provider_request_end', requestOrdinal, ...(atMs == null ? {} : { atMs }),
  outcome: 'ok', stage: 'streaming', httpStatus: 200, durationMs, responseBytes: 10, chunkCount: 2,
});
const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const assistant = (...content) => JSON.stringify({ type: 'assistant', message: { content } });
const results = (...ids) => JSON.stringify({ type: 'user', message: {
  content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })),
} });

// A Claude Code build, request by request (ms since the listener started):
//   1   1000 -  5000  asks for a Write; the tool_use lands before the end line
//   gap 5000 -  7000  edit 2000
//   2   7000 -  9000  asks for the app boot and a navigate at once
//   gap 9000 - 12001  3001 split: browser 1501, shell 1500
//   3  12001 - 15000  asks for a Read and a Grep
//   gap 15000 - 16000 read 1000
//   4  16000 - 17000  asks for nothing
//   gap 17000 - 17500 other 500, since no tool was seen
//   5  17500 - 20000  asks for a click
//   gap 20000 - 26000 browser 6000
//   6  26000 - 27000  and a side request 7, 26500 - 28000, overlapping it
//   gap 28000 - 29000 other 1000 (TodoWrite)
//   8  29000 - 30000  the answer
function claudeJournal({ clock = true } = {}) {
  const at = (ms) => (clock ? ms : null);
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cc-timing' }),
    start(1, at(1000)),
    assistant(toolUse('t-write', 'Write', { file_path: 'server.js', content: 'x' })),
    end(1, at(5000), 4000),
    results('t-write'),
    start(2, at(7000)),
    end(2, at(9000), 2000),
    assistant(
      toolUse('t-boot', 'Bash', { command: 'cd /home/node/app && usernode-run-inloop', run_in_background: true }),
      toolUse('t-nav', 'mcp__playwright__browser_navigate', { url: 'http://localhost:3000' }),
    ),
    results('t-boot', 't-nav'),
    start(3, at(12001)),
    end(3, at(15000), 2999),
    assistant(toolUse('t-read', 'Read', { file_path: 'server.js' }), toolUse('t-grep', 'Grep', { pattern: 'x' })),
    results('t-read', 't-grep'),
    start(4, at(16000)),
    end(4, at(17000), 1000),
    start(5, at(17500)),
    end(5, at(20000), 2500),
    assistant(toolUse('t-click', 'mcp__playwright__browser_click', { ref: 'e1' })),
    results('t-click'),
    start(6, at(26000)),
    start(7, at(26500)),
    end(6, at(27000), 1000),
    end(7, at(28000), 1500),
    assistant(toolUse('t-todo', 'TodoWrite', { todos: [] })),
    results('t-todo'),
    start(8, at(29000)),
    assistant({ type: 'text', text: 'Built it.' }),
    end(8, at(30000), 1000),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'Built it.', session_id: 'cc-timing' }),
  ];
}

function feed(state, lines) {
  for (const line of lines) worker.parseLine(line, () => {}, state);
}

function timing(state) {
  return Object.fromEntries(TIMING_FIELDS.map((field) => [field, state[field]]));
}

const EXPECTED_CLAUDE = {
  modelRequestMs: 4000 + 2000 + 2999 + 1000 + 2500 + 2000 + 1000,
  browserToolMs: 1501 + 6000,
  shellToolMs: 1500,
  editToolMs: 2000,
  readToolMs: 1000,
  otherToolMs: 500 + 1000,
  firstFileChangeMs: 5000,
  firstAppBootMs: 9000,
  firstBrowserCallMs: 9000,
  lastBrowserCallMs: 20000,
};

test('a Claude Code turn splits its time between the model and the kinds of tool between requests', () => {
  const state = openRouterState('claude');
  feed(state, claudeJournal());
  assert.deepEqual(timing(state), EXPECTED_CLAUDE);
  // Model time and the gaps cover the turn from its first request to its last.
  const tools = ['browserToolMs', 'shellToolMs', 'editToolMs', 'readToolMs', 'otherToolMs']
    .reduce((sum, field) => sum + state[field], 0);
  assert.equal(state.modelRequestMs + tools, 30000 - 1000);
  // The workload counters are unchanged by it.
  assert.equal(state.toolCallCount, 7);
  assert.equal(state.commandCount, 1);
});

test('reading the same journal again counts nothing twice', () => {
  // A restarted platform replays the turn's journal from its first line. Into
  // a fresh state (resumeTurnFromJournal) it gets the same numbers, because
  // they come from the listener's stamps, not from when the lines are read.
  const lines = claudeJournal();
  const fresh = openRouterState('claude');
  feed(fresh, lines);
  assert.deepEqual(timing(fresh), EXPECTED_CLAUDE);
  // And read twice into one state, every request and tool is still one.
  const twice = openRouterState('claude');
  feed(twice, lines);
  feed(twice, lines);
  assert.deepEqual(timing(twice), EXPECTED_CLAUDE);
  // Even a single repeated line mid-turn, start or end.
  const repeated = openRouterState('claude');
  const doubled = lines.flatMap((line) => (line.includes('provider_request_') ? [line, line] : [line]));
  feed(repeated, doubled);
  assert.deepEqual(timing(repeated), EXPECTED_CLAUDE);
});

test('a worker image whose listener sends no clock records none of the timing, not zeros', () => {
  const state = openRouterState('claude');
  feed(state, claudeJournal({ clock: false }));
  for (const field of TIMING_FIELDS) assert.equal(state[field], null, field);
  assert.equal(state.toolCallCount, 7, 'the counts it always had are still there');
  const metrics = llmTelemetry.normalizeDiagnostics(state);
  for (const name of TIMING_METRICS) assert.equal(name in metrics, false, name);
  assert.equal(metrics.tool_call_count, 7);
});

test('a turn measured without diagnostics keeps no clock', () => {
  const state = openRouterState('claude');
  state.telemetryDiagnosticsEnabled = false;
  feed(state, claudeJournal());
  for (const field of TIMING_FIELDS) assert.equal(state[field], null, field);
});

test('a resume that fails and starts Claude Code again does not merge the two listeners', () => {
  // run-cc.sh retries fresh after a failed --resume: a second listener that
  // counts from request 1 and from 0 ms again. Its clock goes after the
  // first one's last stamp, and no gap spans the two.
  const state = openRouterState('claude');
  feed(state, [
    start(1, 1000),
    end(1, 3000, 2000),
    '__USERNODE_WARN__ resume failed (exit 1); retrying fresh',
    start(1, 400),
    end(1, 2400, 2000),
    assistant(toolUse('t-edit', 'Edit', { file_path: 'a.js', old_string: 'a', new_string: 'b' })),
    start(2, 3400),
    end(2, 4000, 600),
  ]);
  assert.equal(state.modelRequestMs, 2000 + 2000 + 600);
  assert.equal(state.editToolMs, 1000);
  assert.equal(state.otherToolMs, 0, 'the time between the listeners is not called a tool');
  assert.equal(state.firstFileChangeMs, 3000 + 2400);
});

test('a Codex turn attributes its commands, edits, reads and browser calls the same way', () => {
  const state = openRouterState('codex');
  const codex = (event) => JSON.stringify(event);
  feed(state, [
    codex({ type: 'thread.started', thread_id: 'th-timing' }),
    start(1, 500),
    end(1, 2500, 2000),
    // A long command whose 150-character label stops before the boot.
    codex({ type: 'item.started', item: { id: 'c1', type: 'command_execution',
      command: `bash -lc 'cd /home/node/app && ${'npm ci --no-audit --prefer-offline && '.repeat(4)}usernode-run-inloop'` } }),
    codex({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', aggregated_output: '', exit_code: 0 } }),
    start(2, 4500),
    end(2, 6000, 1500),
    codex({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [
      { kind: 'edit', path: 'server.js' }, { kind: 'add', path: 'public/app.js' },
    ] } }),
    codex({ type: 'item.started', item: { id: 'r1', type: 'file_read', path: 'server.js' } }),
    codex({ type: 'item.completed', item: { id: 'r1', type: 'file_read', path: 'server.js', status: 'completed' } }),
    start(3, 7000),
    end(3, 8000, 1000),
    codex({ type: 'item.started', item: { id: 'm1', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_navigate' } }),
    codex({ type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', status: 'completed' } }),
    codex({ type: 'item.started', item: { id: 'm2', type: 'mcp_tool_call', server: 'homeroom', tool: 'get_app' } }),
    codex({ type: 'item.completed', item: { id: 'm2', type: 'mcp_tool_call', status: 'completed' } }),
    start(4, 11000),
    end(4, 12000, 1000),
  ]);
  assert.deepEqual(timing(state), {
    modelRequestMs: 2000 + 1500 + 1000 + 1000,
    browserToolMs: 1500,
    shellToolMs: 2000,
    editToolMs: 500,
    readToolMs: 500,
    otherToolMs: 1500,
    firstFileChangeMs: 6000,
    firstAppBootMs: 2500,
    firstBrowserCallMs: 8000,
    lastBrowserCallMs: 8000,
  });
});

test("the turn's ledger row keeps the timing under its snake_case names", async () => {
  const state = openRouterState('claude');
  feed(state, claudeJournal());
  const metrics = llmTelemetry.normalizeDiagnostics(state);
  assert.deepEqual(Object.fromEntries(TIMING_METRICS.map((name) => [name, metrics[name]])), {
    model_request_ms: EXPECTED_CLAUDE.modelRequestMs,
    browser_tool_ms: EXPECTED_CLAUDE.browserToolMs,
    shell_tool_ms: EXPECTED_CLAUDE.shellToolMs,
    edit_tool_ms: EXPECTED_CLAUDE.editToolMs,
    read_tool_ms: EXPECTED_CLAUDE.readToolMs,
    other_tool_ms: EXPECTED_CLAUDE.otherToolMs,
    first_file_change_ms: EXPECTED_CLAUDE.firstFileChangeMs,
    first_app_boot_ms: EXPECTED_CLAUDE.firstAppBootMs,
    first_browser_call_ms: EXPECTED_CLAUDE.firstBrowserCallMs,
    last_browser_call_ms: EXPECTED_CLAUDE.lastBrowserCallMs,
  });
  // The usage report reads only the metric names it is handed.
  const reportParams = [];
  await llmTelemetry.aggregateReport({
    async query(_sql, params) { reportParams.push(params); return { rows: [] }; },
  }, { days: 14 });
  assert.ok(reportParams.length > 0);
  for (const params of reportParams) {
    for (const name of TIMING_METRICS) assert.ok(params[2].includes(name), `${name} is in the report`);
  }

  // Through the OpenRouter ledger completion, as a finished turn is recorded.
  const previousEnabled = llmTelemetry._setEnabledForTests(true);
  try {
    const row = {
      session_id: 8, status: 'running', agent_thread_id: null, reasoning_effort: null,
      metadata: {}, input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
      output_tokens: 0, reasoning_output_tokens: 0,
    };
    const client = {
      async query(text, params) {
        if (/FOR UPDATE/.test(text)) return { rows: [row] };
        if (/^\s*UPDATE agent_turns/.test(text)) { row.updateParams = params; return { rowCount: 1 }; }
        return { rows: [] };
      },
      release() {},
    };
    await agentTurn.completeCodexAttempt({
      pool: { async connect() { return client; } }, turnUuid: 'u-timing', status: 'completed', usageScope: 'run',
      telemetryComponent: 'coding_agent_build', telemetryMetrics: state,
    });
    const stored = JSON.parse(row.updateParams[18]).telemetry_metrics;
    assert.equal(stored.browser_tool_ms, 7501);
    assert.equal(stored.first_app_boot_ms, 9000);
    assert.equal(stored.model_request_ms, 15499);
    const serialized = JSON.stringify(stored);
    for (const content of ['usernode-run-inloop', 'server.js', 'localhost', 'playwright']) {
      assert.equal(serialized.includes(content), false, `no ${content} in the ledger`);
    }
  } finally {
    llmTelemetry._setEnabledForTests(previousEnabled);
  }
});
