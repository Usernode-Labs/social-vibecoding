'use strict';

// What a build's own look-and-fix loop changed (newcomer run five, 13 Oct
// 2026): a build turn's telemetry_metrics said when it first and last used
// the in-loop browser (first_browser_call_ms, last_browser_call_ms) and how
// many files it changed, but not which of those changes came after it had
// looked at the app. Now its edits after its first browser call are counted
// (file_change_after_first_browser_count,
// distinct_file_change_after_first_browser_count), and the first 20 of their
// paths kept on the turn's own agent_turns row
// (files_changed_after_first_browser): paths, never what was in them, and
// never in the content-free llm_invocation ledger. These feed journals
// through the parser a turn's journal goes through (worker.parseLine).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const worker = require('../src/services/worker');
const agentTurn = require('../src/services/agent-turn');
const llmTelemetry = require('../src/services/llm-telemetry');

function openRouterState(harness) {
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  state.agentHarness = harness;
  state.telemetryDiagnosticsEnabled = true;
  return state;
}

const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const assistant = (...content) => JSON.stringify({ type: 'assistant', message: { content } });
const feed = (state, lines) => { for (const line of lines) worker.parseLine(line, () => {}, state); };
const WS = '/home/node/workspace';

test('a Claude Code build: the edits after its first look at the app, counted, with their paths', () => {
  const state = openRouterState('claude');
  feed(state, [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cc-after' }),
    // Built first, before any look: not the loop's.
    assistant(toolUse('w1', 'Write', { file_path: `${WS}/server.js`, content: 'SECRET CONTENT' })),
    assistant(toolUse('e1', 'Edit', { file_path: `${WS}/public/app.js`, old_string: 'a', new_string: 'b' })),
    // Then it looks, and fixes what it saw.
    assistant(toolUse('n1', 'mcp__playwright__browser_navigate', { url: 'http://localhost:3000' })),
    assistant(toolUse('e2', 'Edit', { file_path: `${WS}/public/app.js`, old_string: 'b', new_string: 'c' })),
    assistant(toolUse('e3', 'MultiEdit', { file_path: `${WS}/public/style.css`, edits: [] })),
    assistant(toolUse('s1', 'mcp__playwright__browser_take_screenshot', {})),
    assistant(toolUse('e4', 'Edit', { file_path: `${WS}/public/app.js`, old_string: 'c', new_string: 'd' })),
    assistant(toolUse('e5', 'Write', { file_path: '/tmp/usernode-screens/1.html', content: '<p>x</p>' })),
  ]);
  assert.equal(state.fileChangeCount, 6);
  assert.equal(state.fileChangeAfterFirstBrowserCount, 4);
  assert.deepEqual(state.filesChangedAfterFirstBrowser, ['public/app.js', 'public/style.css', '/tmp/usernode-screens/1.html'],
    'repository-relative, each once, in the order first changed');
  const metrics = llmTelemetry.normalizeDiagnostics(state);
  assert.equal(metrics.file_change_count, 6);
  assert.equal(metrics.distinct_file_change_count, 4);
  assert.equal(metrics.file_change_after_first_browser_count, 4);
  assert.equal(metrics.distinct_file_change_after_first_browser_count, 3);
  // The ledger normalizeDiagnostics also feeds keeps no path and no content.
  const serialized = JSON.stringify(metrics);
  for (const secret of ['public/app.js', 'style.css', 'SECRET CONTENT', 'usernode-screens']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('a turn that looked and changed nothing after says 0; one that never looked says nothing', () => {
  const looked = openRouterState('claude');
  feed(looked, [
    assistant(toolUse('w1', 'Write', { file_path: `${WS}/server.js`, content: 'x' })),
    assistant(toolUse('n1', 'mcp__playwright__browser_navigate', { url: 'http://localhost:3000' })),
  ]);
  const lookedMetrics = llmTelemetry.normalizeDiagnostics(looked);
  assert.equal(lookedMetrics.file_change_after_first_browser_count, 0);
  assert.equal(lookedMetrics.distinct_file_change_after_first_browser_count, 0);
  assert.equal(looked.filesChangedAfterFirstBrowser, null);

  const never = openRouterState('claude');
  feed(never, [assistant(toolUse('w1', 'Write', { file_path: `${WS}/server.js`, content: 'x' }))]);
  const neverMetrics = llmTelemetry.normalizeDiagnostics(never);
  assert.equal('file_change_after_first_browser_count' in neverMetrics, false);
  assert.equal('distinct_file_change_after_first_browser_count' in neverMetrics, false);
});

test('at most 20 paths are kept, whatever the count', () => {
  const state = openRouterState('claude');
  const lines = [assistant(toolUse('n1', 'mcp__playwright__browser_snapshot', {}))];
  for (let i = 0; i < 30; i += 1) lines.push(assistant(toolUse(`e${i}`, 'Write', { file_path: `${WS}/src/file-${i}.js`, content: 'x' })));
  feed(state, lines);
  assert.equal(state.fileChangeAfterFirstBrowserCount, 30);
  assert.equal(state.filesChangedAfterFirstBrowser.length, 20);
  assert.equal(llmTelemetry.normalizeDiagnostics(state).distinct_file_change_after_first_browser_count, 30);
});

test('a Codex build counts the same way, its browser being an MCP tool', () => {
  const state = openRouterState('codex');
  feed(state, [
    JSON.stringify({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ kind: 'edit', path: `${WS}/index.html` }] } }),
    JSON.stringify({ type: 'item.started', item: { id: 'm1', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_navigate' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'playwright', tool: 'browser_navigate', status: 'completed' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'f2', type: 'file_change', changes: [
      { kind: 'edit', path: `${WS}/index.html` }, { kind: 'write', path: `${WS}/app.css` },
    ] } }),
  ]);
  assert.equal(state.fileChangeCount, 3);
  assert.equal(state.fileChangeAfterFirstBrowserCount, 2);
  assert.deepEqual(state.filesChangedAfterFirstBrowser, ['index.html', 'app.css']);
});

test('the paths are kept on the turn\'s own agent_turns row, cleaned, and the counts beside them', async () => {
  assert.deepEqual(agentTurn.changedPaths(['a.js', 'a.js', '', 7, 'bad\u0000path', 'x'.repeat(300)]), ['a.js', 'x'.repeat(200)]);
  assert.equal(agentTurn.changedPaths([]), null);
  assert.equal(agentTurn.changedPaths('a.js'), null);
  assert.equal(agentTurn.changedPaths(Array.from({ length: 30 }, (_, i) => `f${i}.js`)).length, 20);

  const previous = llmTelemetry._setEnabledForTests(true);
  try {
    let written = null;
    const row = { id: 'turn-1', session_id: 9, status: 'running', metadata: {}, reasoning_effort: null, agent_thread_id: null };
    const client = {
      async query(sql, params) {
        if (/FOR UPDATE/.test(sql)) return { rows: [row] };
        if (/UPDATE agent_turns SET/.test(sql)) { written = JSON.parse(params[18]); return { rows: [{ id: row.id }] }; }
        return { rows: [] };
      },
      release() {},
    };
    const state = openRouterState('claude');
    feed(state, [
      assistant(toolUse('n1', 'mcp__playwright__browser_navigate', { url: 'http://localhost:3000' })),
      assistant(toolUse('e1', 'Edit', { file_path: `${WS}/public/app.js`, old_string: 'a', new_string: 'b' })),
    ]);
    await agentTurn.completeCodexAttempt({
      pool: { connect: async () => client, query: client.query },
      turnUuid: 'turn-1', status: 'completed', telemetryComponent: 'coding_agent_build', telemetryMetrics: state,
    });
    assert.equal(written.telemetry_metrics.file_change_after_first_browser_count, 1);
    assert.equal(written.telemetry_metrics.distinct_file_change_after_first_browser_count, 1);
    assert.deepEqual(written.telemetry_metrics.files_changed_after_first_browser, ['public/app.js']);
  } finally {
    llmTelemetry._setEnabledForTests(previous);
  }
  // Only there: the ledger's own normalizer never names a path.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/llm-telemetry.js'), 'utf8');
  assert.doesNotMatch(src, /files_changed_after_first_browser/);
});
