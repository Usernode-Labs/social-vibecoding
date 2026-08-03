// #767: the edge probe's timeout bound.
//
// This is the change that removes the reported "extra 1-2 minutes" from the
// preview reveal. warmCert's old default was 120000ms — sized for on-demand
// ZeroSSL issuance, where a first hit could block for minutes. With one
// pre-existing wildcard cert there is nothing to issue and production
// probes measure 10ms - 2.1s, but the 120s ceiling was still live and still
// awaited inside the open SSE turn that reveals the Preview button.
//
// The default constant is pinned deliberately (same stance as
// tests/caddy-deploy-grace.test.js): a silent revert to 120s reintroduces a
// two-minute stall with no other symptom.
//
// Run with: node --test tests/cert-probe-timeout.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const path = require('path');
const https = require('https');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// A plain TCP server that accepts the socket and then says nothing — the
// TLS handshake never completes, so only the timeout can end the probe.
async function withBlackHole(fn) {
  const sockets = [];
  const server = net.createServer((s) => { sockets.push(s); /* never respond */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const ids = {
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/caddy'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const logs = [];
  stub(ids.logger, {
    info: (cat, msg, data) => logs.push({ level: 'info', cat, msg, data }),
    warn: (cat, msg, data) => logs.push({ level: 'warn', cat, msg, data }),
    error: (cat, msg, data) => logs.push({ level: 'error', cat, msg, data }),
    debug() {},
  });

  const realRequest = https.request;
  https.request = (opts, cb) => realRequest({ ...opts, port }, cb);
  const prevHost = process.env.CADDY_HOST;
  process.env.CADDY_HOST = '127.0.0.1';

  delete require.cache[ids.subject];
  const caddy = require(ids.subject);

  try {
    return await fn(caddy, logs);
  } finally {
    https.request = realRequest;
    if (prevHost === undefined) delete process.env.CADDY_HOST;
    else process.env.CADDY_HOST = prevHost;
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
}

test('the default probe timeout is 15s, not the old 120s', () => {
  const caddy = require('../src/services/caddy');
  assert.equal(caddy.CERT_WARM_TIMEOUT_MS, 15000,
    'a revert to 120000 silently restores a two-minute stall on the preview reveal');
});

test('the 120000ms default is gone from the source', () => {
  // Belt and braces on the constant above: the old literal lived in the
  // warmCert signature's default parameter, which a partial revert could
  // reintroduce without touching CERT_WARM_TIMEOUT_MS.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'caddy.js'), 'utf8'
  );
  assert.ok(!/timeoutMs\s*=\s*120000/.test(src),
    'no code path may default to the 120s ZeroSSL-era bound');
});

test('a hung handshake resolves ok:false within the timeout, never rejects', async () => {
  const out = await withBlackHole(async (caddy) => {
    const startedAt = Date.now();
    // 300ms so the test is fast; the mechanism is identical at 15000.
    const r = await caddy.probeEdge('app.example.test', { timeoutMs: 300 });
    return { r, elapsed: Date.now() - startedAt };
  });

  assert.equal(out.r.ok, false);
  assert.ok(out.r.error instanceof Error);
  assert.match(out.r.error.message, /timeout after 300ms/);
  assert.equal(out.r.cert, null, 'a handshake that never completed yields no cert');
  assert.ok(out.elapsed < 3000, `probe must give up at its bound, took ${out.elapsed}ms`);
  assert.equal(typeof out.r.timings.totalMs, 'number');
});

test('warmCert also honours the bound and still resolves the old shape', async () => {
  const out = await withBlackHole(async (caddy) => {
    return caddy.warmCert('app.example.test', { timeoutMs: 300 });
  });
  assert.equal(out.ok, false);
  assert.ok(out.error instanceof Error);
  assert.equal(out.code, null);
});

test('a failed probe logs a warn, not an info', async () => {
  const out = await withBlackHole(async (caddy, logs) => {
    await caddy.probeEdge('app.example.test', { timeoutMs: 300 });
    return logs;
  });
  const warn = out.find((l) => l.msg === 'Edge probe failed');
  assert.ok(warn, 'a timeout must surface at warn level');
  assert.equal(warn.level, 'warn');
  assert.equal(warn.data.hostname, 'app.example.test');
  assert.equal(typeof warn.data.totalMs, 'number');
  assert.ok(!out.some((l) => l.msg === 'Edge probe'), 'a failure must not also log the happy line');
});

test('onResult fires exactly once on timeout', async () => {
  const out = await withBlackHole(async (caddy) => {
    const seen = [];
    await caddy.probeEdge('app.example.test', {
      timeoutMs: 300,
      onResult: (err, code) => seen.push({ err: err && err.message, code }),
    });
    // Give any late socket event a tick to (wrongly) re-fire.
    await new Promise((r) => setTimeout(r, 50));
    return seen;
  });
  assert.equal(out.length, 1, 'finish() must be idempotent under destroy-then-error');
});

// ── #816: the reveal path makes a REAL request, not just a handshake ─────
//
// A handshake proves TLS terminates. It does not prove Caddy can resolve
// the new container name, that the forward_auth gate passes, or that the
// app has done its lazy first-request work — all of which the FIRST
// visitor otherwise pays for. verifyStagingEdge runs one full GET at
// reveal time so the platform pays it instead, and so a preview the edge
// cannot actually route to shows up in the log rather than only to
// whoever clicks Preview.

// Same stub-every-collaborator shape as tests/staging-build-serialize.js —
// services/staging pulls in the db/github layers at require time, and this
// test cares only about which probe the reveal path makes.
function loadStaging(caddyStub) {
  const ids = {
    caddy: require.resolve('../src/services/caddy'),
    logger: require.resolve('../src/services/logger'),
    docker: require.resolve('../src/services/docker'),
    dbManager: require.resolve('../src/services/db-manager'),
    github: require.resolve('../src/services/github'),
    appManifest: require.resolve('../src/services/app-manifest'),
    appSecrets: require.resolve('../src/services/app-secrets'),
    appLlmEnv: require.resolve('../src/services/app-llm-env'),
    appStorageEnv: require.resolve('../src/services/app-storage-env'),
    events: require.resolve('../src/services/events'),
    pool: require.resolve('../src/db/pool'),
    subject: require.resolve('../src/services/staging'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const logs = [];
  stub(ids.caddy, { ...require('../src/services/caddy'), ...caddyStub });
  stub(ids.docker, { execFileAsync: async () => ({ stdout: '', stderr: '' }) });
  stub(ids.dbManager, {});
  stub(ids.github, { isEnabled: () => false });
  stub(ids.appManifest, { read: () => ({}) });
  stub(ids.appSecrets, {});
  stub(ids.appLlmEnv, {});
  stub(ids.appStorageEnv, {});
  stub(ids.events, { record() {}, EVENT_TYPES: {} });
  stub(ids.pool, { getPool: () => ({ query: async () => ({ rows: [] }) }) });
  stub(ids.logger, {
    info: (cat, msg, data) => logs.push({ level: 'info', cat, msg, data }),
    warn: (cat, msg, data) => logs.push({ level: 'warn', cat, msg, data }),
    error: (cat, msg, data) => logs.push({ level: 'error', cat, msg, data }),
    debug() {},
  });
  delete require.cache[ids.subject];
  const staging = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    delete require.cache[ids.subject];
  };
  return { staging, logs, restore };
}

test('#816 verifyStagingEdge probes end-to-end (handshakeOnly: false)', async () => {
  const calls = [];
  const { staging, restore } = loadStaging({
    probeEdge: async (hostname, opts) => {
      calls.push({ hostname, opts });
      return { ok: true, code: 200, error: null, timings: { ttfbMs: 42 }, cert: null };
    },
  });
  try {
    await staging.verifyStagingEdge(
      { id: 42 }, 'my-app--s42.example.test', 'https://my-app--s42.example.test'
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hostname, 'my-app--s42.example.test');
    assert.equal(calls[0].opts.handshakeOnly, false,
      'a handshake alone proves nothing about routing to the new container');
  } finally { restore(); }
});

test('#816 verifyStagingEdge never throws, and no-ops on a local-dev http url', async () => {
  const calls = [];
  const { staging, logs, restore } = loadStaging({
    probeEdge: async (hostname, opts) => {
      calls.push({ hostname, opts });
      return { ok: false, code: null, error: new Error('upstream refused'), timings: {}, cert: null };
    },
  });
  try {
    // A failed probe must degrade to a warn — a deploy is never failed or
    // blocked by it (the preview may simply be slow to accept its first
    // connection).
    await assert.doesNotReject(() => staging.verifyStagingEdge(
      { id: 42 }, 'my-app--s42.example.test', 'https://my-app--s42.example.test'
    ));
    const warn = logs.find((l) => l.level === 'warn');
    assert.ok(warn, 'a failed verification is visible in the platform log');

    // Local dev hands out http://localhost:<port> — there is no edge.
    await staging.verifyStagingEdge({ id: 42 }, 'my-app--s42.example.test', 'http://localhost:32770');
    assert.equal(calls.length, 1, 'no probe for a local-dev url');
  } finally { restore(); }
});

test('#816 warmStagingCert stays as an alias so no call site breaks', () => {
  const { staging, restore } = loadStaging({ probeEdge: async () => ({ ok: true }) });
  try {
    assert.equal(typeof staging.verifyStagingEdge, 'function');
    assert.equal(staging.warmStagingCert, staging.verifyStagingEdge,
      'the deprecated name must point at the same implementation, not a stale copy');
  } finally { restore(); }
});
