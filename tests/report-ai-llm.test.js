// generateReportSummary — the one Haiku call behind the Reporting tab's
// AI layer (narrative / critical risks / per-owner blurbs). Exercised
// through llm._setClientForTests, the same stub seam as
// tests/issue-title-multi.test.js. The properties locked in here:
//
//   * The output is sanitized BEFORE it is returned: caps on every field,
//     severity coerced to the enum, and owner blurbs for usernames that
//     never appeared in the input are dropped (hallucination guard) —
//     because the caller persists this into a SHARED per-app cache.
//   * Fenced / smart-quoted output still parses (same defensive posture
//     as estimateRunProgress).
//   * An empty narrative is an error, never an empty cached row.
//
// Run with: node --test tests/report-ai-llm.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/services/llm');

function makeStubClient(response) {
  const calls = [];
  return { calls, messages: { create: async (params) => { calls.push(params); return response; } } };
}

async function withStubClient(response, fn) {
  const stub = makeStubClient(response);
  const prev = llm._setClientForTests(stub);
  try { return await fn(stub); } finally { llm._setClientForTests(prev); }
}

const textResp = (obj) => ({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
  usage: { input_tokens: 1000, output_tokens: 200 },
});

test('generateReportSummary returns sanitized structured output', async () => {
  const out = await withStubClient(textResp({
    narrative: 'The project is healthy.\n\nMost work ships fast.',
    risks: [{ title: 'Stalled review', detail: 'PR #7 has waited 12 days.', severity: 'high' }],
    owners: [
      { username: 'alice', blurb: 'Shipped the auth work.' },
      { username: 'not-a-member', blurb: 'Hallucinated.' },
    ],
  }), (stub) => llm.generateReportSummary({
    inputJson: '{"issues":[]}', appName: 'Demo', knownUsernames: ['alice', 'bob'],
  }));
  assert.equal(out.narrative, 'The project is healthy.\n\nMost work ships fast.');
  assert.equal(out.risks.length, 1);
  assert.equal(out.risks[0].severity, 'high');
  assert.deepEqual(out.owners.map((o) => o.username), ['alice']);
  assert.equal(out.model, 'claude-haiku-4-5');
  assert.equal(out.usage.output_tokens, 200);
});

test('generateReportSummary passes the input as data and requests structured output', async () => {
  await withStubClient(textResp({ narrative: 'Fine.', risks: [], owners: [] }), async (stub) => {
    await llm.generateReportSummary({
      inputJson: '{"marker":"INPUT_MARKER"}', appName: 'Demo', knownUsernames: [],
    });
    assert.equal(stub.calls.length, 1);
    const params = stub.calls[0];
    assert.equal(params.model, 'claude-haiku-4-5');
    assert.ok(params.messages[0].content.includes('INPUT_MARKER'));
    assert.ok(params.output_config && params.output_config.format
      && params.output_config.format.type === 'json_schema');
  });
});

test('generateReportSummary survives code fences and caps output', async () => {
  const big = {
    narrative: 'x'.repeat(9000),
    risks: Array.from({ length: 20 }, (_, i) => ({ title: `r${i}`, detail: 'd', severity: 'weird' })),
    owners: [],
  };
  const out = await withStubClient({
    content: [{ type: 'text', text: '```json\n' + JSON.stringify(big) + '\n```' }],
    usage: { input_tokens: 10, output_tokens: 10 },
  }, () => llm.generateReportSummary({ inputJson: '{}', appName: 'Demo', knownUsernames: [] }));
  assert.ok(out.narrative.length <= 2500);
  assert.equal(out.risks.length, 8);
  assert.equal(out.risks[0].severity, 'medium');
});

test('generateReportSummary throws on empty narrative', async () => {
  await assert.rejects(
    withStubClient(textResp({ narrative: '   ', risks: [], owners: [] }),
      () => llm.generateReportSummary({ inputJson: '{}', appName: 'Demo', knownUsernames: [] })),
    /empty/i
  );
});

test('sanitizeReportSummary is pure and tolerant of junk', () => {
  const out = llm.sanitizeReportSummary({ narrative: 42, risks: 'no', owners: [{ username: 'a' }] }, ['a']);
  assert.equal(out.narrative, '');
  assert.deepEqual(out.risks, []);
  assert.deepEqual(out.owners, []); // blurb missing → dropped
});

test('sanitizeReportSummary drops title-less risks and clips fields', () => {
  const out = llm.sanitizeReportSummary({
    narrative: 'ok',
    risks: [
      { title: '', detail: 'no title', severity: 'high' },
      { title: 't'.repeat(500), detail: 'd'.repeat(1000), severity: 'low' },
    ],
    owners: [{ username: 'u'.repeat(200), blurb: 'b'.repeat(900) }],
  }, ['u'.repeat(60)]);
  assert.equal(out.risks.length, 1);
  assert.ok(out.risks[0].title.length <= 120);
  assert.ok(out.risks[0].detail.length <= 400);
  assert.equal(out.owners.length, 1);
  assert.ok(out.owners[0].username.length <= 60);
  assert.ok(out.owners[0].blurb.length <= 300);
});
