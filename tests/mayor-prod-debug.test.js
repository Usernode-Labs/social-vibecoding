// Mayor-side prod-debug awareness (#616 follow-up): the gated
// getMayorSystemPrompt block, the get_prod_status data tool's
// membership/shape/status line, and resolveProdStatusToolResult's
// eligibility re-check, failure shapes, and byte clipping.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'mayor-prod-debug-test-secret';

const sessions = require('../src/routes/sessions');
const debugAccess = require('../src/services/debug-access');
const statusSvc = require('../src/services/status');

const {
  getMayorSystemPrompt,
  DATA_TOOL_NAMES,
  GET_PROD_STATUS_TOOL,
  resolveDataToolResult,
  resolveProdStatusToolResult,
  dataToolStatusLine,
} = sessions;

// Stub the module-object methods the resolver calls through, restoring
// after each test (same monkey-patch pattern the route suites use for
// worker.isInFlight).
function withStubs(t, { eligibility, gather } = {}) {
  const origCheck = debugAccess.checkSessionEligibility;
  const origGather = statusSvc.gather;
  if (eligibility) debugAccess.checkSessionEligibility = eligibility;
  if (gather) statusSvc.gather = gather;
  t.after(() => {
    debugAccess.checkSessionEligibility = origCheck;
    statusSvc.gather = origGather;
  });
}

// ── getMayorSystemPrompt gating ────────────────────────────────────────

test('mayor prompt: prod-debug block present iff prodDebug is true', () => {
  const withBlock = getMayorSystemPrompt('App', false, '', true, null, '', '', true);
  assert.match(withBlock, /PRODUCTION DEBUG/);
  assert.match(withBlock, /get_prod_status/);
  assert.match(withBlock, /usernode-debug/);

  const without = getMayorSystemPrompt('App', false, '', true, null, '', '', false);
  assert.doesNotMatch(without, /PRODUCTION DEBUG/);
  assert.doesNotMatch(without, /get_prod_status/);
  assert.doesNotMatch(without, /usernode-debug/);
});

test('mayor prompt: prodDebug defaults to false (headless call shape stays clean)', () => {
  // Headless call sites pass at most the first five args.
  const prompt = getMayorSystemPrompt('App', false, '', true, null);
  assert.doesNotMatch(prompt, /PRODUCTION DEBUG/);
  assert.doesNotMatch(prompt, /get_prod_status/);
});

test('mayor prompt: block rides alongside the self-hosted guardrails, not instead of them', () => {
  const prompt = getMayorSystemPrompt('App', false, '', true, null, '', '', true);
  assert.match(prompt, /PLATFORM SELF-EDIT GUARDRAILS/);
  assert.match(prompt, /PRODUCTION DEBUG/);
});

// ── Tool membership / shape / status line ──────────────────────────────

test('get_prod_status is a registered data tool with a no-input schema', () => {
  assert.equal(DATA_TOOL_NAMES.has('get_prod_status'), true);
  assert.equal(GET_PROD_STATUS_TOOL.name, 'get_prod_status');
  assert.deepEqual(GET_PROD_STATUS_TOOL.input_schema, { type: 'object', properties: {} });
  assert.match(GET_PROD_STATUS_TOOL.description, /read-only/i);
  assert.match(GET_PROD_STATUS_TOOL.description, /dispatch/);
});

test('dataToolStatusLine: get_prod_status wins its own line, others keep theirs', () => {
  assert.equal(
    dataToolStatusLine([{ name: 'get_prod_status', input: {} }]),
    'Checking production status...'
  );
  assert.equal(
    dataToolStatusLine([{ name: 'list_github_issues', input: {} }]),
    "Reading the repo's GitHub issues..."
  );
});

// ── resolveProdStatusToolResult ────────────────────────────────────────

test('resolver: eligible session gets the status payload + log ring', async (t) => {
  withStubs(t, {
    eligibility: async () => ({ found: true, eligible: true, ownerId: 7 }),
    gather: async (_config, opts) => {
      assert.equal(opts.isAdmin, true);
      return { sessions: { stuck: 0 }, workers: { warm: 2 } };
    },
  });
  const out = JSON.parse(await resolveProdStatusToolResult({ pool: {}, config: {}, sessionId: 42 }));
  assert.deepEqual(out.status, { sessions: { stuck: 0 }, workers: { warm: 2 } });
  assert.ok(Array.isArray(out.recentLog));
});

test('resolver: ineligible session gets not_eligible, never a gather call', async (t) => {
  let gathered = false;
  withStubs(t, {
    eligibility: async () => ({ found: true, eligible: false }),
    gather: async () => { gathered = true; return {}; },
  });
  const out = JSON.parse(await resolveProdStatusToolResult({ pool: {}, config: {}, sessionId: 42 }));
  assert.deepEqual(out, { status: null, note: 'not_eligible' });
  assert.equal(gathered, false);
});

test('resolver: eligibility-check failure is a note, not a throw', async (t) => {
  withStubs(t, {
    eligibility: async () => { throw new Error('db down'); },
  });
  const out = JSON.parse(await resolveProdStatusToolResult({ pool: {}, config: {}, sessionId: 42 }));
  assert.equal(out.status, null);
  assert.match(out.note, /eligibility check failed/);
});

test('resolver: gather failure is a { status: null, note } shape', async (t) => {
  withStubs(t, {
    eligibility: async () => ({ found: true, eligible: true, ownerId: 7 }),
    gather: async () => { throw new Error('docker exploded'); },
  });
  const out = JSON.parse(await resolveProdStatusToolResult({ pool: {}, config: {}, sessionId: 42 }));
  assert.equal(out.status, null);
  assert.match(out.note, /status unavailable: docker exploded/);
});

test('resolver: oversized payload is clipped to the byte cap', async (t) => {
  withStubs(t, {
    eligibility: async () => ({ found: true, eligible: true, ownerId: 7 }),
    gather: async () => ({ blob: 'x'.repeat(100 * 1024) }),
  });
  const out = await resolveProdStatusToolResult({ pool: {}, config: {}, sessionId: 42 });
  assert.ok(out.length <= 24 * 1024 + 32, `payload not clipped: ${out.length} bytes`);
  assert.match(out, /\[truncated\]$/);
});

// ── resolveDataToolResult routing ──────────────────────────────────────

test('routing: get_prod_status without a prodCtx resolves to not_eligible', async () => {
  const out = JSON.parse(
    await resolveDataToolResult({ name: 'get_prod_status', input: {} }, 'owner', 'repo')
  );
  assert.deepEqual(out, { status: null, note: 'not_eligible' });
});

test('routing: get_prod_status with a prodCtx goes through the eligibility re-check', async (t) => {
  withStubs(t, {
    eligibility: async () => ({ found: true, eligible: true, ownerId: 7 }),
    gather: async () => ({ ok: true }),
  });
  const out = JSON.parse(await resolveDataToolResult(
    { name: 'get_prod_status', input: {} }, 'owner', 'repo', { pool: {}, config: {}, sessionId: 42 }
  ));
  assert.deepEqual(out.status, { ok: true });
});
