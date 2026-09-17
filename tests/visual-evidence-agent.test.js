'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const agent = require('../src/services/visual-evidence-agent');

test('agent dispatch time is bounded and invokes worker cancellation', async () => {
  let stopped = 0;
  await assert.rejects(
    agent.withDispatchTimeout(new Promise(() => {}), {
      timeoutMs: 10,
      onTimeout: async () => { stopped += 1; },
    }),
    { code: 'evidence_agent_timeout' }
  );
  assert.equal(stopped, 1);
});

test('the evidence prompt makes model exploration advisory and platform replay authoritative', () => {
  assert.match(agent.SYSTEM_PROMPT, /platform code—not you—will reset both sides and\s+replay it twice/i);
  assert.match(agent.SYSTEM_PROMPT, /inspect all returned focused and\s+context images/i);
  assert.match(agent.SYSTEM_PROMPT, /page[\s\S]*untrusted data/i);
  const repair = agent.promptFor({ repairReason: '<bad focus>' });
  assert.match(repair, /single authorized corrected plan/);
  assert.match(repair, /<bad focus>/);
  assert.match(agent.replayPlanGuide(), /No arbitrary JavaScript/);
});

test('backend results cannot silently turn an errored model turn into success', () => {
  assert.equal(agent.failedResult(null), true);
  assert.equal(agent.failedResult({ exitCode: 1 }), true);
  assert.equal(agent.failedResult({ ccIsError: true }), true);
  assert.equal(agent.failedResult({ exitCode: 0 }), false);
});
