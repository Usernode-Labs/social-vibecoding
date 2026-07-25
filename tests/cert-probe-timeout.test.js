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
