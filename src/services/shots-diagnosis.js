'use strict';

// Why a change's before & after shots failed, reduced to the few fixed values
// the run itself recorded (shot_runs.trace_summary), so its owner, the
// project's managers and Homeroom bot on its own change can read the step it
// stopped at without a production database query (#6779). Nothing free-form is
// copied: only codes, sides, personas, counts, timings and the shots agent's
// last words, which the orchestrator already redacted when the run stored them
// and which are redacted again here.

const { redactDiagnosticText } = require('./shots-orchestrator');

const CODE_RE = /^[a-z0-9_]{1,48}$/;
const SIDES = new Set(['base', 'head', 'hosted', 'outside']);
const PERSONAS = new Set(['member', 'admin', 'full_admin', 'guest', 'invited_member', 'invited_member_listed']);
const OUTCOMES = new Set([
  'ok', 'error', 'tool_error', 'rpc_error', 'unparsed', 'server_exit', 'loaded',
  'invalid', 'request_error', 'invalid_catalog', 'http_error', 'network_error',
  'stream_error', 'cancelled', 'timeout', 'browser_gone',
]);
const FAILURE_STAGES = new Set([
  'configure', 'launch', 'exchange', 'navigate', 'cookie', 'hosted_catalog',
  'storage_state', 'allowlist',
]);
const TOOLS = new Set([
  'get_brief', 'save_shot', 'save_clip', 'skip_change', 'note_change', 'note_problem', 'fail_request',
  'control_request', 'upload_file', 'browser_navigate', 'browser_navigate_back', 'browser_snapshot',
  'browser_take_screenshot', 'browser_click', 'browser_type', 'browser_fill_form',
  'browser_press_key', 'browser_select_option', 'browser_hover', 'browser_mouse_move_xy',
  'browser_drag', 'browser_resize', 'browser_wait_for', 'browser_console_messages',
  'browser_network_requests', 'browser_tabs', 'browser_close', 'other',
]);
const PHASES = new Set(['refresh', 'shots_proxy', 'shots_browser_bootstrap', 'shots_mcp_ready', 'claude', 'agent', 'done']);
const ERROR_CLASSES = new Set(['timeout', 'network', 'browser_closed', 'locator_ambiguous', 'other']);
// An outcome that says the step went wrong. The first of these is what a run
// stopped at when it did not even reach the agent.
const ERROR_OUTCOMES = new Set([
  'error', 'tool_error', 'rpc_error', 'http_error', 'network_error', 'stream_error',
  'timeout', 'browser_gone', 'server_exit', 'invalid', 'request_error',
]);
// The timings worth reading to a person. Anything else the trace stores is
// left out rather than passed through.
const TIMING_KEYS = ['provisioning', 'agentExploration', 'artifactPersist', 'cleanup', 'idleWait', 'total'];

const code = (value) => (CODE_RE.test(String(value || '')) ? String(value) : null);
const integer = (value, max = Number.MAX_SAFE_INTEGER) => (
  Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null
);

function eventOf(value) {
  if (!value || typeof value !== 'object') return null;
  return value;
}

// The last event the run recorded that says where it stopped: a failed
// sign-in first (auth_bootstrap is recorded even when the agent never
// started), else the last event with an error outcome, else the very last
// event.
function stoppingEvent(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = eventOf(events[i]);
    if (event && event.kind === 'auth_bootstrap' && event.outcome === 'error') return event;
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = eventOf(events[i]);
    if (event && ERROR_OUTCOMES.has(event.outcome)) return event;
  }
  return eventOf(events[events.length - 1]);
}

// Only the fixed fields the orchestrator records (recordAgentDiagnostic), each
// checked again against its own enum or range. An event from an older or
// newer worker therefore contributes only what this reader understands.
function shapeStoppedAt(event) {
  if (!event || typeof event.kind !== 'string' || !CODE_RE.test(event.kind)) return null;
  const out = { kind: event.kind };
  if (SIDES.has(event.side)) out.side = event.side;
  if (PERSONAS.has(event.persona)) out.persona = event.persona;
  if (OUTCOMES.has(event.outcome)) out.outcome = event.outcome;
  if (code(event.failureCode)) out.failureCode = code(event.failureCode);
  if (FAILURE_STAGES.has(event.failureStage)) out.failureStage = event.failureStage;
  const status = integer(event.responseStatus, 599);
  if (status != null && status >= 100) out.responseStatus = status;
  if (TOOLS.has(event.tool)) out.tool = event.tool;
  if (PHASES.has(event.phase)) out.phase = event.phase;
  if (ERROR_CLASSES.has(event.errorClass)) out.errorClass = event.errorClass;
  const atMs = integer(event.atMs);
  if (atMs != null) out.atMs = atMs;
  return out;
}

function toolsUsed(activity) {
  const counts = activity?.toolCounts && typeof activity.toolCounts === 'object'
    ? activity.toolCounts : {};
  return Object.values(counts).reduce((sum, value) => sum + (integer(value) ?? 0), 0);
}

function timings(trace) {
  const stored = trace?.timingsMs && typeof trace.timingsMs === 'object' ? trace.timingsMs : {};
  const out = {};
  for (const key of TIMING_KEYS) {
    const value = integer(stored[key]);
    if (value != null) out[key] = value;
  }
  return out;
}

/**
 * The diagnosis of one failed shots run, from its shot_runs row. Pure.
 * Returns null for any run that did not fail. `lastWords: false` leaves the
 * shots agent's final words out entirely: they are free text, and the bot's
 * reply is read by everyone in the thread.
 */
function fromRun(run, { lastWords = true } = {}) {
  if (!run || typeof run !== 'object' || run.state !== 'failed') return null;
  const trace = run.trace_summary && typeof run.trace_summary === 'object' ? run.trace_summary : {};
  const activity = trace.agentActivity && typeof trace.agentActivity === 'object' ? trace.agentActivity : {};
  const events = Array.isArray(activity.events) ? activity.events : [];
  const firstAt = activity.firstAtMs && typeof activity.firstAtMs === 'object' ? activity.firstAtMs : {};
  const oom = trace.workerMemory && typeof trace.workerMemory === 'object'
    ? integer(trace.workerMemory.oomKillsDuringTurn) : null;
  const excerpt = trace.agentFinalResponse && typeof trace.agentFinalResponse.excerpt === 'string'
    ? trace.agentFinalResponse.excerpt.trim() : '';

  const diagnosis = {
    runId: String(run.id || ''),
    state: run.state,
    failureCode: code(run.failure_code),
    terminalClass: code(trace.terminalFailureClass),
    stoppedAt: shapeStoppedAt(stoppingEvent(events)),
    agentStarted: integer(firstAt.first_output) != null || integer(firstAt.tool_start) != null,
    toolsUsed: toolsUsed(activity),
    timingsMs: timings(trace),
    workerOutOfMemory: oom == null ? null : oom > 0,
  };
  if (lastWords) diagnosis.lastWords = excerpt ? redactDiagnosticText(excerpt, 600) : null;
  return diagnosis;
}

/**
 * The diagnosis of the change's latest shots run, or null when it has no run
 * or that run did not fail. `sessionId` is the chat_sessions id.
 */
async function forSession(pool, sessionId, opts = {}) {
  const id = Number(sessionId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const { rows: [session] } = await pool.query(
    'SELECT shots_run_id FROM chat_sessions WHERE id = $1', [id],
  );
  const runId = session?.shots_run_id;
  if (!runId) return null;
  const { rows: [run] } = await pool.query(
    `SELECT id, state, failure_code, trace_summary
       FROM shot_runs
      WHERE id = $1 AND session_id = $2`,
    [runId, id],
  );
  return fromRun(run, opts);
}

module.exports = { fromRun, forSession };
