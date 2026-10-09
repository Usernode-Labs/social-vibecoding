'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const worker = require('../src/services/worker');

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
      browserGuestToolCount: 0, browserPhoneToolCount: 0 },
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
    browserGuestToolCount: 2, browserPhoneToolCount: 3,
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
  const names = ['get_brief', 'save_shot', 'save_clip', 'skip_change', 'fail_request',
    'evidence_get_context', 'evidence_run_plan', 'evidence_finish', 'evidence_capture', 'evidence_report_blocker'];
  worker.parseLine(JSON.stringify({
    type: 'assistant', message: { content: names.map((name, index) => ({
      type: 'tool_use', id: `call-${index}`, name: `mcp__shots__${name}`, input: { change: 'private-change' },
    })) },
  }), () => {}, state);
  assert.deepEqual(events.filter((event) => event.kind === 'tool_start').map(({ tool }) => tool), [
    'get_brief', 'save_shot', 'save_clip', 'skip_change', 'fail_request',
    'other', 'other', 'other', 'other', 'other',
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private-change/);
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
