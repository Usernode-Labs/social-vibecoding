'use strict';

// "Are you 18 or older?" (#5095, compliance A-02).
//
//   - src/services/adult-attestation.js: the yes is recorded once
//     (users.adult_attested_at) and the wallet, staking, node and passport
//     writes refuse an account without it, 403 adult_attestation_required.
//   - src/routes/adult-attestation.js: POST /api/me/adult-attestation.
//   - frontend/src/features/auth/adult-gate.tsx: the sheet, the open-time
//     ask, and the fetch wrapper that turns the 403 into the question and
//     sends the write again on a yes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const adult = require('../src/services/adult-attestation');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const GATE = 'frontend/src/features/auth/adult-gate.tsx';

function fakePool(users, { fail = false } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      if (fail) throw new Error('db down');
      const u = users[params[0]];
      if (/SELECT adult_attested_at IS NOT NULL AS attested FROM users/.test(sql)) {
        return { rows: u ? [{ attested: !!u.adult_attested_at }] : [] };
      }
      if (/UPDATE users SET adult_attested_at = COALESCE\(adult_attested_at, NOW\(\)\)/.test(sql)) {
        if (!u) return { rows: [] };
        u.adult_attested_at = u.adult_attested_at || new Date('2026-10-19T10:00:00Z');
        return { rows: [{ adult_attested_at: u.adult_attested_at }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

function runGate(gate, user) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ next: false, status: this.statusCode, body }); return this; },
    };
    gate({ user }, res, () => resolve({ next: true }));
  });
}

// ─── Server ───────────────────────────────────────────────────────────

test('the gate refuses an account that has not said yes, in both envelopes', async () => {
  const users = { 1: { adult_attested_at: null }, 2: { adult_attested_at: new Date() } };
  const pool = fakePool(users);

  const plain = await runGate(adult.requireAdultAttestation(pool), { id: 1 });
  assert.equal(plain.status, 403);
  assert.equal(plain.body.code, 'adult_attestation_required');
  assert.match(plain.body.error, /18 or older/);

  const topo = await runGate(adult.requireAdultAttestation(pool, { shape: 'topochain' }), { id: 1 });
  assert.equal(topo.status, 403);
  assert.deepEqual(Object.keys(topo.body).sort(), ['code', 'error', 'success']);
  assert.equal(topo.body.success, false);
  assert.equal(topo.body.code, 'adult_attestation_required');

  assert.deepEqual(await runGate(adult.requireAdultAttestation(pool), { id: 2 }), { next: true });
});

test('the gate leaves a signed-out request to the route\'s own 401, and a failed read is a 500, not the question', async () => {
  const pool = fakePool({});
  assert.deepEqual(await runGate(adult.requireAdultAttestation(pool), null), { next: true });
  assert.equal(pool.queries.length, 0);

  const broken = await runGate(adult.requireAdultAttestation(fakePool({}, { fail: true })), { id: 1 });
  assert.equal(broken.status, 500);
  assert.notEqual(broken.body.code, 'adult_attestation_required');
});

test('POST /api/me/adult-attestation records the yes once and keeps its first time', async () => {
  const users = { 7: { adult_attested_at: null } };
  const pool = fakePool(users);
  const { adultAttestationRoutes } = require('../src/routes/adult-attestation');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = req.headers['x-user'] ? { id: Number(req.headers['x-user']) } : null; next(); });
  app.use(adultAttestationRoutes({}, { pool }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const anon = await fetch(`${base}/api/me/adult-attestation`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{}' });
    assert.equal(anon.status, 401);

    const first = await fetch(`${base}/api/me/adult-attestation`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-user': '7' }, body: '{}' });
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.adultAttested, true);
    const stamped = users[7].adult_attested_at;
    assert.ok(stamped);

    const again = await fetch(`${base}/api/me/adult-attestation`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-user': '7' }, body: '{}' });
    assert.equal(again.status, 200);
    assert.equal(users[7].adult_attested_at, stamped, 'answering again changes nothing');

    const crossSite = await fetch(`${base}/api/me/adult-attestation`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', 'x-user': '7' }, body: '{}' });
    assert.equal(crossSite.status, 403, 'a page on another site cannot answer for the person');
  } finally {
    server.close();
  }
});

test('the wallet, staking, node and passport writes are behind the gate; their reads are not', () => {
  const mobile = read('src/routes/topochain/mobile.js');
  assert.match(mobile, /router\.post\('\/challenges-api\/bp\/request', webSessionAuth, requireSessionUser, sameOriginBrowserOnly,\s*requireAdultAttestation\(pool, \{ shape: 'topochain' \}\), bpRequestHandler\);/);
  assert.match(mobile, /router\.post\('\/api\/v4\/mobile\/zkpassport\/complete', mobileTokenAuth\(config\),\s*requireAdultAttestation\(pool, \{ shape: 'topochain' \}\), async/);
  assert.match(mobile, /'\/api\/v4\/mobile\/wallet\/claim',[\s\S]{0,400}mobileWalletClaimLimiter,\s*\/\/[^\n]*\n\s*requireAdultAttestation\(pool, \{ shape: 'topochain' \}\),/);
  assert.match(mobile, /router\.get\('\/challenges-api\/bp\/state', webSessionAuth, requireSessionUser, bpStateHandler\);/);

  const delegation = read('src/routes/topochain/epoch-delegation.js');
  assert.match(delegation, /router\.post\(NATIVE_DELEGATION_PATH, auth, requireAdultAttestation\(pool, \{ shape: 'topochain' \}\), async/);
  assert.match(delegation, /router\.get\(NATIVE_DELEGATION_PATH, auth, async/);

  const auth = read('src/routes/auth.js');
  assert.match(auth, /router\.post\('\/api\/me\/wallet-link', sameOriginBrowserOnly, requireAdultAttestation\(pool\), async/);
  // Unlinking is never refused.
  assert.match(auth, /router\.delete\('\/api\/me\/wallet-link', sameOriginBrowserOnly, async/);
  // The shell reads the answer from the session.
  assert.match(auth, /\(u\.adult_attested_at IS NOT NULL\) AS adult_attested,/);
  assert.match(auth, /\n {8}adultAttested,\n/);

  assert.match(read('server.js'), /app\.use\(adultAttestationRoutes\(config\)\);/);
  assert.match(read('src/db/schema.sql'), /\nALTER TABLE users ADD COLUMN IF NOT EXISTS adult_attested_at TIMESTAMPTZ;\n/);
});

// ─── Client ───────────────────────────────────────────────────────────

function response(status, body) {
  const text = JSON.stringify(body);
  const make = () => ({ status, ok: status < 400, json: async () => JSON.parse(text), clone: () => make() });
  return make();
}

const REFUSED = { success: false, code: 'adult_attestation_required', error: adult.MESSAGE };

function harness({ answers, yes = true }) {
  const mod = loadTsx(GATE);
  const calls = [];
  let asked = 0;
  const win = {
    fetch: async (url, init) => {
      calls.push({ url, method: (init && init.method) || 'GET', body: init && init.body });
      return answers.shift() || response(200, { ok: true });
    },
  };
  mod.installAdultGate(win, async () => { asked++; return yes; });
  return { mod, win, calls, asked: () => asked };
}

test('a write refused for the 18+ answer asks, and on a yes is sent again', async () => {
  const h = harness({ answers: [response(403, REFUSED), response(200, { success: true, data: { bp_requested: true } })] });
  const res = await h.win.fetch('/challenges-api/bp/request', { method: 'POST', body: '{}' });
  assert.equal(res.status, 200);
  assert.equal(h.asked(), 1);
  assert.deepEqual(h.calls.map((c) => [c.url, c.method]), [
    ['/challenges-api/bp/request', 'POST'],
    ['/challenges-api/bp/request', 'POST'],
  ]);
  assert.equal(typeof h.win.UsernodeReact.adultGate.require, 'function');
});

test('"I\'m under 18" returns the original refusal, readable, and sends nothing more', async () => {
  const h = harness({ answers: [response(403, REFUSED)], yes: false });
  const res = await h.win.fetch('/api/me/wallet-link', { method: 'POST' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'adult_attestation_required');
  assert.equal(h.calls.length, 1);
});

test('reads and other refusals pass through without a question', async () => {
  const h = harness({ answers: [response(403, REFUSED), response(403, { code: 'join_required' })] });
  const get = await h.win.fetch('/api/me/staking/context');
  assert.equal(get.status, 403);
  const other = await h.win.fetch('/api/apps/x/issues', { method: 'POST' });
  assert.equal(other.status, 403);
  assert.equal(h.asked(), 0);
});

test('the sheet asks one question with two answers, and keeps no birthdate', () => {
  const mod = loadTsx(GATE);
  const html = renderToHtml(createElement(mod.AdultGateBody, { onYes: async () => true, onUnder() {} }));
  assert.match(html, /data-adult-gate=""/);
  assert.match(html, />Are you 18 or older\?</);
  assert.match(html, /<button type="button" data-adult-gate-yes=""[^>]*>I&#x27;m 18 or older<\/button>/);
  assert.match(html, /<button type="button" data-adult-gate-under=""[^>]*>I&#x27;m under 18<\/button>/);
  assert.match(html, /never your date of birth/);
  assert.doesNotMatch(html, /<input/, 'nothing to type: no birthdate is collected');
});

test('requireAdult: signed out or already yes goes straight on; otherwise it asks (no kit: no)', async () => {
  const mod = loadTsx(GATE);
  const prior = global.window;
  try {
    global.window = { App: { user: null } };
    assert.equal(await mod.requireAdult(), true);
    global.window = { App: { user: { id: 1, adultAttested: true } } };
    assert.equal(await mod.requireAdult(), true);
    global.window = { App: { user: { id: 1, adultAttested: false } } };
    assert.equal(await mod.requireAdult(), false, 'with no sheet kit to ask in, the feature stays closed');
  } finally {
    if (prior === undefined) delete global.window; else global.window = prior;
  }
});

test('the wallet, node and staking sheets ask before they open; their previews do not', () => {
  assert.match(read('frontend/src/main.tsx'), /bootStep\('installAdultGate', \(\) => installAdultGate\(\)\);/);
  const wallet = read('frontend/src/features/header/wallet-sheet.js');
  assert.match(wallet, /openFromRow\(\) \{\n\s+if \(WalletSheet\._demo\) \{ WalletSheet\._openSheet\(\); return; \}\n\s+requireAdult\(\)\.then\(\(ok\) => \{ if \(ok\) WalletSheet\._openSheet\(\); \}\);/);
  const node = read('frontend/src/features/header/node-pill.js');
  assert.match(node, /openFromRow\(\) \{\n\s+if \(demoShot\(\)\) \{ NodePill\._openSheet\(\); return; \}\n\s+requireAdult\(\)\.then\(\(ok\) => \{ if \(ok\) NodePill\._openSheet\(\); \}\);/);
  const staking = read('frontend/src/features/profile/staking-sheet.tsx');
  assert.match(staking, /if \(preview\) \{ setOpen\(true\); return; \}\n\s+void requireAdult\(\)\.then\(\(ok\) => \{ if \(ok\) setOpen\(true\); \}\);/);
});
