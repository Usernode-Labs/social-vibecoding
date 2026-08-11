'use strict';
// Direct-transport proof test (review P0 + test-coverage gap #9): asserts
// that a codex_openrouter turn is dispatched CONFIGURED DIRECTLY at
// OpenRouter with the user's own key, with NO platform relay call and NO
// agent-proxy token, and that the per-turn secret env contains ONLY the
// credentials that backend needs (never Anthropic authority, and never a
// push token on scout).
//
// Run with: node --test tests/openrouter-direct-transport.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../src/services/worker');

// ── Secret-env isolation (the "no relay / no Anthropic authority" proof) ──
test('codex_openrouter scout env: OpenRouter key + narrow issues-read token only (no push, no Anthropic)', () => {
  const env = worker.buildTurnSecretEnv({
    mode: 'scout',
    workerSessionJwt: 'minted.worker.session.jwt',
    workerPushJwt: 'minted.worker.push.jwt',
    issuesReadJwt: 'minted.worker.issues-read.jwt',
    anthropicApiKey: null,
    prodDebugJwt: 'minted.proddebug.jwt',
    openrouterApiKey: 'sk-or-user-key',
    agentBackend: 'codex_openrouter',
  });
  assert.deepEqual(Object.keys(env).sort(), ['ISSUES_JWT', 'OPENROUTER_API_KEY']);
  assert.equal(env.OPENROUTER_API_KEY, 'sk-or-user-key');
  // Scout gets the narrow issues-read token (so it can read issues/
  // attachments) but NEVER push authority, and never the raw worker:session
  // token the Anthropic proxy would accept.
  assert.equal(env.ISSUES_JWT, 'minted.worker.issues-read.jwt');
  assert.ok(!('WORKER_JWT' in env), 'scout must not receive WORKER_JWT');
  assert.ok(!('USERNODE_AGENT_TOKEN' in env), 'scout must not receive a relay token');
  assert.ok(!('ANTHROPIC_API_KEY' in env));
  assert.ok(!('ANTHROPIC_BASE_URL' in env));
});

test('codex_openrouter build env: narrow push + issues tokens, no Anthropic/relay', () => {
  const env = worker.buildTurnSecretEnv({
    mode: 'build',
    workerSessionJwt: 'minted.worker.session.jwt',
    workerPushJwt: 'minted.worker.push.jwt',
    issuesReadJwt: 'minted.worker.issues-read.jwt',
    anthropicApiKey: null,
    prodDebugJwt: 'minted.proddebug.jwt',
    openrouterApiKey: 'sk-or-user-key',
    agentBackend: 'codex_openrouter',
  });
  assert.deepEqual(Object.keys(env).sort(), ['ISSUES_JWT', 'OPENROUTER_API_KEY', 'WORKER_JWT']);
  assert.equal(env.OPENROUTER_API_KEY, 'sk-or-user-key');
  // WORKER_JWT here is the narrow worker:push token, NOT worker:session —
  // so the Anthropic proxy must reject it.
  assert.equal(env.WORKER_JWT, 'minted.worker.push.jwt');
  assert.equal(env.ISSUES_JWT, 'minted.worker.issues-read.jwt');
  assert.ok(!('ANTHROPIC_API_KEY' in env));
  assert.ok(!('ANTHROPIC_BASE_URL' in env));
  assert.ok(!('USERNODE_AGENT_TOKEN' in env));
});

test('claude_code build env separates proxy, read, and mutation capabilities', () => {
  const env = worker.buildTurnSecretEnv({
    mode: 'build',
    workerSessionJwt: 'minted.worker.jwt',
    issuesReadJwt: 'minted.worker.issues-read.jwt',
    anthropicProxyJwt: 'minted.worker.anthropic-proxy.jwt',
    anthropicApiKey: null,
    prodDebugJwt: null,
    openrouterApiKey: null,
    agentBackend: 'claude_code',
  });
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'ISSUES_JWT', 'WORKER_JWT']);
  assert.equal(env.ANTHROPIC_API_KEY, 'minted.worker.anthropic-proxy.jwt');
  assert.equal(env.ISSUES_JWT, 'minted.worker.issues-read.jwt');
  assert.equal(env.WORKER_JWT, 'minted.worker.jwt');
  assert.ok(!('OPENROUTER_API_KEY' in env), 'Claude turns must not carry the OpenRouter key');
});

test('claude_code scout env contains no worker:session capability under any alias', () => {
  const env = worker.buildTurnSecretEnv({
    mode: 'scout',
    workerSessionJwt: 'must-not-travel',
    issuesReadJwt: 'minted.worker.issues-read.jwt',
    anthropicProxyJwt: 'minted.worker.anthropic-proxy.jwt',
    anthropicApiKey: null,
    prodDebugJwt: 'minted.worker.prod-debug.jwt',
    agentBackend: 'claude_code',
  });
  assert.deepEqual(env, {
    ANTHROPIC_API_KEY: 'minted.worker.anthropic-proxy.jwt',
    ISSUES_JWT: 'minted.worker.issues-read.jwt',
    PROD_DEBUG_JWT: 'minted.worker.prod-debug.jwt',
  });
  assert.ok(!Object.values(env).includes('must-not-travel'));
  assert.ok(!('WORKER_JWT' in env));
});

// ── Runner config (direct transport proof) ──────────────────────────────
test('runner script points Codex directly at OpenRouter, never a relay', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const script = fs.readFileSync(path.join(__dirname, '..', 'worker', 'run-codex-agent.sh'), 'utf8');
  // Codex is configured with OpenRouter as base_url and OPENROUTER_API_KEY
  // as the provider env key (direct transport).
  assert.match(script, /printf 'base_url = "%s"\\n' "\$ESCAPED_BASE"/);
  assert.match(script, /env_key = "OPENROUTER_API_KEY"/);
  assert.match(script, /model_catalog_json/);
  assert.match(script, /SANDBOX_MODE=danger-full-access/);
  assert.match(script, /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(script, /OPENROUTER_API_KEY/);
  assert.match(script, /grep -Fq -- "\$OPENROUTER_API_KEY" "\$CONFIG_TMP"/,
    'runner refuses to launch if the generated config ever persists the key');
  // No platform relay / proxy token wiring remains.
  assert.ok(!/USERNODE_AGENT_TOKEN/.test(script), 'runner must not use a relay token');
  assert.ok(!/internal\/openrouter/.test(script), 'runner must not point at a platform relay');
  assert.ok(!/OPENROUTER_PROXY_ENABLED/.test(script));
});

// ── Narrow-purpose worker tokens (review #2 / #6) ────────────────────
test('codex push/issues tokens are narrow purposes, NOT worker:session', () => {
  const platformJwt = require('../src/services/platform-jwt');
  process.env.WORKER_JWT_SECRET = 'test-worker-secret-codex';
  const pushTok = platformJwt.signWorkerPushToken({ sessionId: 7 });
  const issuesTok = platformJwt.signIssuesReadToken({ sessionId: 7 });
  // Each round-trips only under its own purpose...
  assert.equal(platformJwt.verifyWorkerPushToken(pushTok).session_id, 7);
  assert.equal(platformJwt.verifyIssuesReadToken(issuesTok).session_id, 7);
  // ...and crucially, the general worker:session verifier (what the
  // Anthropic proxy accepts) rejects both, so a Codex turn that only holds
  // these narrow tokens cannot spend Anthropic funds through the proxy.
  assert.throws(() => platformJwt.verifyWorkerToken(pushTok), /purpose|scope/);
  assert.throws(() => platformJwt.verifyWorkerToken(issuesTok), /purpose|scope/);
  // A general worker:session token does NOT satisfy the narrow verifiers.
  const sessionTok = platformJwt.signWorkerToken({ sessionId: 7 });
  assert.throws(() => platformJwt.verifyWorkerPushToken(sessionTok), /purpose|scope/);
  assert.throws(() => platformJwt.verifyIssuesReadToken(sessionTok), /purpose|scope/);
});

test('Claude scout proxy/debug tokens are narrow purposes, NOT worker:session', () => {
  const platformJwt = require('../src/services/platform-jwt');
  process.env.WORKER_JWT_SECRET = 'test-worker-secret-claude-scout';
  const proxyTok = platformJwt.signAnthropicProxyToken({ sessionId: 8 });
  const debugTok = platformJwt.signProdDebugToken({ sessionId: 8 });
  assert.equal(platformJwt.verifyAnthropicProxyToken(proxyTok).session_id, 8);
  assert.equal(platformJwt.verifyProdDebugToken(debugTok).session_id, 8);
  assert.throws(() => platformJwt.verifyWorkerToken(proxyTok), /purpose|scope/);
  assert.throws(() => platformJwt.verifyWorkerToken(debugTok), /purpose|scope/);
});

test('Anthropic proxy accepts only proxy or rolling-deploy general purpose', () => {
  const platformJwt = require('../src/services/platform-jwt');
  const { anthropicProxyAuth } = require('../src/middleware/anthropic-proxy-auth');
  process.env.WORKER_JWT_SECRET = 'test-worker-secret-proxy-middleware';
  const run = (token) => {
    const req = {
      headers: { 'x-api-key': token },
      socket: { remoteAddress: '172.18.0.2' },
      path: '/api/internal/anthropic/v1/messages',
    };
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    let nexted = false;
    anthropicProxyAuth(req, res, () => { nexted = true; });
    return { req, res, nexted };
  };

  const proxy = run(platformJwt.signAnthropicProxyToken({ sessionId: 9 }));
  assert.equal(proxy.nexted, true);
  assert.equal(proxy.req.workerSession.purpose, 'worker:anthropic-proxy');
  const general = run(platformJwt.signWorkerToken({ sessionId: 9 }));
  assert.equal(general.nexted, true, 'old in-flight Claude turns survive a rolling deploy');

  for (const token of [
    platformJwt.signIssuesReadToken({ sessionId: 9 }),
    platformJwt.signWorkerPushToken({ sessionId: 9 }),
    platformJwt.signProdDebugToken({ sessionId: 9 }),
  ]) {
    const rejected = run(token);
    assert.equal(rejected.nexted, false);
    assert.equal(rejected.res.statusCode, 401);
  }
});
