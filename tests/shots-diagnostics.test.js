'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const worker = require('../src/services/worker');
const shotsDiagnosis = require('../src/services/shots-diagnosis');

test('shots worker reports the last browser tool without retaining its inputs or results', () => {
  const events = [];
  const state = worker.newWatchState();
  state.shotsDiagnosticObserver = (event) => events.push(event);
  const progress = () => {};
  const privateUrl = 'https://example.invalid/?token=private-token';
  worker.parseLine('__USERNODE_PHASE__ shots_browser_bootstrap', progress, state);
  worker.parseLine(JSON.stringify({
    type: 'system', subtype: 'init', session_id: 'private-session',
    mcp_servers: [
      { name: 'shots' }, { name: 'browser_member' }, { name: 'browser_admin' },
      { name: 'browser_full_admin' }, { name: 'browser_guest' },
    ],
    tools: ['mcp__shots__get_brief', 'mcp__shots__save_shot',
      'mcp__shots__skip_change', 'private-tool-definition'],
  }), progress, state);
  worker.parseLine(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', private: 'private-token' } }), progress, state);
  worker.parseLine(JSON.stringify({
    type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'private-tool-id',
      name: 'mcp__browser_member__browser_navigate', input: { url: privateUrl },
    }] },
  }), progress, state);
  worker.parseLine(JSON.stringify({
    type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: 'private-tool-id', is_error: true,
      content: `Page said private-token at ${privateUrl}`,
    }] },
  }), progress, state);

  assert.deepEqual(events, [
    { kind: 'runner_phase', phase: 'shots_browser_bootstrap' },
    { kind: 'provider_init', mcpServerCount: 5, toolDefinitionCount: 4,
      briefToolAvailable: true, saveShotToolAvailable: true,
      skipChangeToolAvailable: true,
      browserMemberToolCount: 0, browserAdminToolCount: 0, browserFullAdminToolCount: 0,
      browserGuestToolCount: 0, browserPhoneToolCount: 0, browserInvitedToolCount: 0 },
    { kind: 'first_stream' },
    { kind: 'first_output' },
    { kind: 'tool_start', sequence: 1, tool: 'browser_navigate', persona: 'member' },
    { kind: 'tool_end', sequence: 1, tool: 'browser_navigate', persona: 'member', outcome: 'error' },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private|example\.invalid|session|url/i);
});

test('provider init distinguishes unavailable shots tools from absent tool metadata', () => {
  const events = [];
  const state = worker.newWatchState();
  state.shotsDiagnosticObserver = (event) => events.push(event);
  // The retired shots tools do not count as the shots tools.
  // A phone browser's tools are counted as the phone browsers', not the persona's.
  worker.parseLine(JSON.stringify({
    type: 'system', subtype: 'init', tools: ['mcp__browser_member__browser_navigate',
      'mcp__browser_guest__browser_navigate', 'mcp__browser_guest__browser_snapshot',
      'mcp__browser_member_phone__browser_navigate', 'mcp__browser_admin_phone__browser_resize',
      'mcp__browser_admin_phone__browser_snapshot',
      'mcp__evidence__evidence_get_context', 'mcp__evidence__evidence_capture'],
  }), () => {}, state);
  assert.deepEqual(events, [{
    kind: 'provider_init', mcpServerCount: null, toolDefinitionCount: 8,
    briefToolAvailable: false, saveShotToolAvailable: false,
    skipChangeToolAvailable: false,
    browserMemberToolCount: 1, browserAdminToolCount: 0, browserFullAdminToolCount: 0,
    browserGuestToolCount: 2, browserPhoneToolCount: 3, browserInvitedToolCount: 0,
  }]);

  const missing = [];
  const missingState = worker.newWatchState();
  missingState.shotsDiagnosticObserver = (event) => missing.push(event);
  worker.parseLine(JSON.stringify({ type: 'system', subtype: 'init' }), () => {}, missingState);
  assert.deepEqual(missing, [{
    kind: 'provider_init', mcpServerCount: null, toolDefinitionCount: null,
    briefToolAvailable: null, saveShotToolAvailable: null,
    skipChangeToolAvailable: null,
    browserMemberToolCount: null, browserAdminToolCount: null,
    browserFullAdminToolCount: null, browserGuestToolCount: null, browserPhoneToolCount: null,
    browserInvitedToolCount: null,
  }]);
});

test('a guest browser tool is reported as the guest\'s', () => {
  const events = [];
  const state = worker.newWatchState();
  state.shotsDiagnosticObserver = (event) => events.push(event);
  worker.parseLine(JSON.stringify({
    type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'guest-tool-id', name: 'mcp__browser_guest__browser_snapshot', input: {},
    }] },
  }), () => {}, state);
  assert.deepEqual(events.filter((event) => event.kind === 'tool_start'),
    [{ kind: 'tool_start', sequence: 1, tool: 'browser_snapshot', persona: 'guest' }]);
});

test('a phone browser tool is reported as its persona\'s, marked as the phone', () => {
  const events = [];
  const state = worker.newWatchState();
  state.shotsDiagnosticObserver = (event) => events.push(event);
  for (const [id, name] of [
    ['phone-call', 'mcp__browser_admin_phone__browser_resize'],
    ['desktop-call', 'mcp__browser_admin__browser_resize'],
  ]) {
    worker.parseLine(JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] },
    }), () => {}, state);
    worker.parseLine(JSON.stringify({
      type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'ok' }] },
    }), () => {}, state);
  }
  assert.deepEqual(events.filter((event) => event.kind === 'tool_start' || event.kind === 'tool_end'), [
    { kind: 'tool_start', sequence: 1, tool: 'browser_resize', persona: 'admin', phone: true },
    { kind: 'tool_end', sequence: 1, tool: 'browser_resize', persona: 'admin', phone: true, outcome: 'ok' },
    { kind: 'tool_start', sequence: 2, tool: 'browser_resize', persona: 'admin' },
    { kind: 'tool_end', sequence: 2, tool: 'browser_resize', persona: 'admin', outcome: 'ok' },
  ]);
});

test('the brief result reports its shape and normal model exit without retaining content', () => {
  const events = [];
  const state = worker.newWatchState();
  state.shotsDiagnosticObserver = (event) => events.push(event);
  const progress = () => {};
  worker.parseLine(JSON.stringify({
    type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'context-call', name: 'mcp__shots__get_brief', input: {},
    }] },
  }), progress, state);
  const context = {
    declaredChanges: [{ id: 'one' }, { id: 'two' }],
    addresses: { before: 'http://base.invalid', after: 'http://head.invalid' },
    revisions: { before: 'a'.repeat(12), after: 'b'.repeat(12) },
    secret: 'private-token',
  };
  worker.parseLine(JSON.stringify({
    type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: 'context-call', is_error: false,
      content: [{ type: 'text', text: JSON.stringify(context) }],
    }] },
  }), progress, state);
  worker.parseLine(JSON.stringify({
    type: 'result', subtype: 'success', stop_reason: 'end_turn',
    result: 'No browser steps were performed. private-token', is_error: false,
  }), progress, state);
  assert.deepEqual(events, [
    { kind: 'first_output' },
    { kind: 'tool_start', sequence: 1, tool: 'get_brief' },
    { kind: 'context_result', outcome: 'ok', responseCharacters: JSON.stringify(context).length,
      jsonValid: true, declaredChangesPresent: true, addressesPresent: true,
      revisionsPresent: true, storyCount: 2 },
    { kind: 'tool_end', sequence: 1, tool: 'get_brief', outcome: 'ok' },
    { kind: 'provider_result', outcome: 'ok', resultSubtype: 'success', providerStopReason: 'end_turn' },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private-token|base\.invalid|head\.invalid/);
});

test('the shots tools are named in diagnostics; the retired shots tools are not', () => {
  const events = [];
  const state = worker.newWatchState();
  state.shotsDiagnosticObserver = (event) => events.push(event);
  const names = ['get_brief', 'save_shot', 'save_clip', 'skip_change', 'fail_request', 'control_request', 'upload_file',
    'evidence_get_context', 'evidence_run_plan', 'evidence_finish', 'evidence_capture', 'evidence_report_blocker'];
  worker.parseLine(JSON.stringify({
    type: 'assistant', message: { content: names.map((name, index) => ({
      type: 'tool_use', id: `call-${index}`, name: `mcp__shots__${name}`, input: { change: 'private-change' },
    })) },
  }), () => {}, state);
  assert.deepEqual(events.filter((event) => event.kind === 'tool_start').map(({ tool }) => tool), [
    'get_brief', 'save_shot', 'save_clip', 'skip_change', 'fail_request', 'control_request', 'upload_file',
    'other', 'other', 'other', 'other', 'other',
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private-change/);
});

// What the proxy did to a request (held or failed) and how a sample upload
// went reach the trace as fixed words and numbers, never a path or a name.
test('a held or failed request and a sample upload reach the trace as fixed words only', () => {
  const orchestrator = require('../src/services/shots-orchestrator');
  const metrics = orchestrator.newRunMetrics();
  for (const raw of [
    { kind: 'controlled_failure_set', enabled: true, mode: 'hold', path: '/api/private' },
    { kind: 'controlled_failure_hit', mode: 'hold', side: 'head', hitOrdinal: 2 },
    { kind: 'controlled_failure_hit', mode: 'evaluate', side: 'base', hitOrdinal: 3 },
    { kind: 'sample_upload', persona: 'member', phone: true, outcome: 'timeout', count: 2, files: ['landscape.png'] },
  ]) orchestrator.recordAgentDiagnostic(metrics, raw);
  const events = metrics.agentActivity.events.map(({ atMs: _atMs, ...event }) => event);
  assert.deepEqual(events, [
    { kind: 'controlled_failure_set', enabled: true, mode: 'hold' },
    { kind: 'controlled_failure_hit', hitOrdinal: 2, mode: 'hold', side: 'head' },
    { kind: 'controlled_failure_hit', hitOrdinal: 3, side: 'base' },
    { kind: 'sample_upload', outcome: 'timeout', count: 2, persona: 'member', phone: true },
  ]);
});

test('shots diagnostics classify unknown tools and phases without copying their names', () => {
  const events = [];
  const state = worker.newWatchState();
  state.shotsDiagnosticObserver = (event) => events.push(event);
  worker.parseLine('__USERNODE_PHASE__ secret-phase private-token', () => {}, state);
  worker.parseLine(JSON.stringify({
    type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'x', name: 'private-token', input: { password: 'private-token' },
    }] },
  }), () => {}, state);
  assert.deepEqual(events, [
    { kind: 'first_output' },
    { kind: 'tool_start', sequence: 1, tool: 'other' },
  ]);
});

test('navigation diagnostics identify paired sides and repeated routes without storing URLs', () => {
  const events = [];
  const state = worker.newWatchState();
  state.shotsOrigins = { base: 'http://base.internal:3000', head: 'http://head.internal:3000' };
  state.shotsNavigationHints = {
    intentPaths: ['/'], declaredPaths: ['/?token=private#app/private-route'],
  };
  state.shotsDiagnosticObserver = (event) => events.push(event);
  const navigate = (id, url) => {
    worker.parseLine(JSON.stringify({
      type: 'assistant', message: { content: [{
        type: 'tool_use', id, name: 'mcp__browser_member__browser_navigate', input: { url },
      }] },
    }), () => {}, state);
    worker.parseLine(JSON.stringify({
      type: 'user', message: { content: [{
        type: 'tool_result', tool_use_id: id, is_error: false, content: 'navigated',
      }] },
    }), () => {}, state);
  };
  navigate('base', 'http://base.internal:3000/?token=private#app/private-route');
  navigate('head', 'http://head.internal:3000/?token=private#app/private-route');
  navigate('other', 'https://outside.invalid/secret');
  const calls = events.filter((event) => event.kind === 'tool_start');
  assert.deepEqual(calls.map(({ side, routeOrdinal }) => ({ side, routeOrdinal })), [
    { side: 'base', routeOrdinal: 1 },
    { side: 'head', routeOrdinal: 1 },
    { side: 'outside', routeOrdinal: undefined },
  ]);
  assert.equal(events.filter((event) => event.kind === 'tool_end')[1].routeOrdinal, 1);
  assert.equal(calls[0].routeHint, 'declared_check');
  assert.equal(calls[0].checkRank, 1);
  assert.doesNotMatch(JSON.stringify(events), /private|outside\.invalid|token|secret/i);
});

// ── The failed run's diagnosis (#6779) ─────────────────────────────────

test('a failed run stopped signing in to the before copy says so, fixed fields only', () => {
  const run = {
    id: 'a'.repeat(32),
    state: 'failed',
    failure_code: 'shots_agent_failed',
    trace_summary: {
      terminalFailureClass: 'agent_never_started',
      agentActivity: {
        firstAtMs: {},
        toolCounts: {},
        events: [
          { atMs: 10, kind: 'worker_prepare_end', outcome: 'ok' },
          {
            atMs: 1300, kind: 'auth_bootstrap', side: 'base', persona: 'member',
            outcome: 'error', failureCode: 'invalid_session_cookie', failureStage: 'exchange',
            responseStatus: 200,
          },
        ],
      },
      timingsMs: { provisioning: 900, total: 1400, bogus: 'not a number' },
      workerMemory: { oomKillsDuringTurn: 0 },
      agentFinalResponse: { excerpt: 'I could not sign in.' },
    },
  };
  const diagnosis = shotsDiagnosis.fromRun(run);
  assert.equal(diagnosis.runId, run.id);
  assert.equal(diagnosis.state, 'failed');
  assert.equal(diagnosis.failureCode, 'shots_agent_failed');
  assert.equal(diagnosis.terminalClass, 'agent_never_started');
  assert.deepEqual(diagnosis.stoppedAt, {
    kind: 'auth_bootstrap', side: 'base', persona: 'member', outcome: 'error',
    failureCode: 'invalid_session_cookie', failureStage: 'exchange', responseStatus: 200,
    atMs: 1300,
  });
  assert.equal(diagnosis.agentStarted, false);
  assert.equal(diagnosis.toolsUsed, 0);
  assert.deepEqual(diagnosis.timingsMs, { provisioning: 900, total: 1400 });
  assert.equal(diagnosis.workerOutOfMemory, false);
  assert.equal(diagnosis.lastWords, 'I could not sign in.');

  // Only a failed run has a diagnosis.
  for (const state of ['planned', 'provisioning', 'exploring', 'reviewing', 'verified', 'stale', 'cancelled']) {
    assert.equal(shotsDiagnosis.fromRun({ ...run, state }), null, state);
  }
  assert.equal(shotsDiagnosis.fromRun(null), null);
});

test('a diagnosis carries no secret: no cookie, token, JWT, URL query or header', () => {
  const run = {
    id: 'b'.repeat(32),
    state: 'failed',
    // Not an enum, so it is dropped rather than passed through.
    failure_code: 'session=abc123secret',
    trace_summary: {
      terminalClass: 'Bearer abcdefghijklmnop',
      agentActivity: {
        firstAtMs: { first_output: 40 },
        toolCounts: { browser_navigate: 2, other: 1 },
        events: [{
          atMs: 50, kind: 'auth_bootstrap',
          side: 'base', persona: 'member', outcome: 'error',
          failureCode: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIz',
          failureStage: 'https://example.invalid/callback?token=abc123secret',
          responseStatus: 200,
          cookie: 'session=abc123secret',
          url: 'https://example.invalid/?token=abc123secret',
          headers: { authorization: 'Bearer abc123secret' },
        }],
      },
      timingsMs: { provisioning: 10 },
      agentFinalResponse: {
        excerpt: 'Sign-in failed: session=abc123secret from https://example.invalid/?token=abc123secret '
          + 'with Bearer abc123secret and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIz',
      },
    },
  };
  const serialized = JSON.stringify(shotsDiagnosis.fromRun(run));
  for (const secret of [
    'abc123secret', 'abcdefghijklmnop', 'eyJhbGciOiJIUzI1NiJ9',
    'authorization', 'cookie',
  ]) {
    assert.equal(serialized.includes(secret), false, `${secret} must not survive`);
  }
  assert.equal(shotsDiagnosis.fromRun(run).failureCode, null, 'a non-enum code is dropped');
  assert.equal(shotsDiagnosis.fromRun(run).terminalClass, null, 'a non-enum class is dropped');
  assert.equal(shotsDiagnosis.fromRun(run).stoppedAt.failureCode, undefined);
  assert.equal(shotsDiagnosis.fromRun(run).stoppedAt.failureStage, undefined);
  assert.equal(shotsDiagnosis.fromRun(run).agentStarted, true);
  assert.equal(shotsDiagnosis.fromRun(run).toolsUsed, 3);
});

test('the bot reads no last words, but keeps the step', () => {
  const run = {
    id: 'c'.repeat(32),
    state: 'failed',
    failure_code: 'shots_agent_failed',
    trace_summary: {
      agentActivity: { events: [{ atMs: 1, kind: 'auth_bootstrap', outcome: 'error', failureCode: 'invalid_session_cookie' }] },
      agentFinalResponse: { excerpt: 'Only I should see this.' },
    },
  };
  const diagnosis = shotsDiagnosis.fromRun(run, { lastWords: false });
  assert.equal('lastWords' in diagnosis, false);
  assert.equal(diagnosis.stoppedAt.failureCode, 'invalid_session_cookie');
});
