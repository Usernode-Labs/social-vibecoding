'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const agent = require('../src/services/visual-evidence-agent');
const worker = require('../src/services/worker');
const fs = require('node:fs');
const path = require('node:path');

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

test('agent exploration timeout excludes time spent in platform replay', async () => {
  const started = Date.now();
  let pauseStarted = started;
  let completedPause = 0;
  let stopped = 0;
  const suspendedMs = () => completedPause + (pauseStarted == null ? 0 : Date.now() - pauseStarted);
  const result = await agent.withDispatchTimeout(
    new Promise((resolve) => setTimeout(() => {
      completedPause += Date.now() - pauseStarted;
      pauseStarted = null;
      resolve('replay complete');
    }, 90)),
    {
      timeoutMs: 20,
      suspendedMs,
      onTimeout: () => { stopped += 1; },
    }
  );
  assert.equal(result, 'replay complete');
  assert.equal(stopped, 0, 'the replay has its own bounded lifetime');
});

test('the evidence prompt asks for a replay plan and leaves visual judgement to people', () => {
  assert.match(agent.SYSTEM_PROMPT, /platform code—not you—will reset both sides and\s+replay it twice/i);
  assert.match(agent.SYSTEM_PROMPT, /human reviewers, who decide whether it proves the claim/i);
  assert.match(agent.SYSTEM_PROMPT, /do not need image understanding or to issue a relevance verdict/i);
  assert.doesNotMatch(agent.SYSTEM_PROMPT, /evidence_finish/);
  assert.match(agent.SYSTEM_PROMPT, /page[\s\S]*untrusted data/i);
  assert.doesNotMatch(agent.promptFor(), /review was rejected|corrected plan/i);
  assert.match(agent.promptFor({ repair: true }), /rejected plan and the exact replay failure/i);
  assert.match(agent.promptFor({ repair: true }), /BOTH exact revisions/i);
  assert.match(agent.replayPlanGuide(), /No arbitrary JavaScript/);
});

test('a second hosted dispatch receives an explicit repair task through the normal worker', async () => {
  const prompts = [];
  const workerService = {
    ensureWorker: async () => 'warm-worker',
    execInWorker: async (_sessionId, options) => {
      prompts.push(options.prompt);
      assert.equal(options.resumeSessionId, 'evidence-thread');
      assert.equal(options.evidenceRunId, '1'.repeat(32));
      return { exitCode: 0, sessionId: 'evidence-thread' };
    },
  };
  await agent.dispatch({ visualEvidence: { maxAgentMs: 500 } }, {
    pool: {}, session: {
      id: 42, repo_url: 'https://github.com/acme/demo.git',
      branch_name: 'proposal', agent_backend: 'claude_code',
    },
    runId: '1'.repeat(32), origins: { base: 'http://base.test/', head: 'http://head.test/' },
    authTokens: { member: 'private-token', read_only_admin: 'private-token' },
    resumeThreadId: 'evidence-thread', repairAttempt: 1,
  }, { workerService });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /first submitted plan failed deterministic replay/i);
  assert.match(prompts[0], /evidence_run_plan/);
});

test('backend results cannot silently turn an errored model turn into success', () => {
  assert.equal(agent.failedResult(null), true);
  assert.equal(agent.failedResult({ exitCode: 1 }), true);
  assert.equal(agent.failedResult({ ccIsError: true }), true);
  assert.equal(agent.failedResult({ exitCode: 0 }), false);
});

test('Kubernetes evidence tools call the Pod that owns their in-memory replay control', () => {
  assert.equal(worker.evidenceControlUrl({ podIp: '10.20.30.40', port: '3000', fallback: 'http://service:3000' }),
    'http://10.20.30.40:3000');
  assert.equal(worker.evidenceControlUrl({ podIp: '2001:db8::7', port: '3000', fallback: 'http://service:3000' }),
    'http://[2001:db8::7]:3000');
  assert.equal(worker.evidenceControlUrl({ podIp: 'not-an-ip', fallback: 'http://service:3000' }),
    'http://service:3000');
  const source = fs.readFileSync(require.resolve('../src/services/worker'), 'utf8');
  const chart = fs.readFileSync(path.join(__dirname, '../deploy/helm/social-vibecoding-platform/templates/platform.yaml'), 'utf8');
  assert.match(source, /PLATFORM_URL: mode === 'evidence' \? evidenceControlUrl\(\) : PLATFORM_INTERNAL_URL/);
  assert.match(chart, /name: POD_IP\s+valueFrom: \{fieldRef: \{fieldPath: status\.podIP\}\}/);
});
