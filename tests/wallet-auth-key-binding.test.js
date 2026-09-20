// Regression tests for issue #2502 — "wallet sign-in verifies the signature
// against a caller-supplied key, then logs in a different account".
//
// The reported attack, reproduced at the handler level by snait in the
// issue's Discussion thread, needs no forged signature. The attacker asks
// wallet-check for a challenge on the VICTIM's published `ut1…` address,
// signs that challenge with their OWN key, and posts both: `pubkey` names
// the victim, `publicKey` names the attacker's key. The pre-fix handler
// verified the signature against `publicKey` (genuinely valid) and then
// resolved the account from `pubkey`, minting a session for the victim.
//
// So the fake node below answers `{ valid: true }` unconditionally, which is
// faithful rather than a cheat: the attacker's signature over the challenge
// really is valid for the attacker's key. What must stop the login is the
// server refusing to ask about a key that is not the account's.
//
// Harness mirrors tests/password-reset.test.js: override getPool BEFORE
// requiring the route module, mount the router on a real express app, and
// capture every query so "no session was minted" can be asserted from the
// SQL, not just from the response body.
//
// Run with: node --test tests/wallet-auth-key-binding.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

// ── Pool stub ──────────────────────────────────────────────────────
const poolMod = require('../src/db/pool');
let capturedQueries = [];
let usersByPubkey = [];        // rows for SELECT ... WHERE usernode_pubkey = $1
let userLinkedPubkeyRow = null; // row for SELECT usernode_pubkey FROM users WHERE id

poolMod.getPool = () => ({
  query: async (sql, params) => {
    capturedQueries.push({ sql, params });
    if (/SELECT usernode_pubkey FROM users WHERE id/.test(sql)) {
      return { rows: userLinkedPubkeyRow ? [userLinkedPubkeyRow] : [] };
    }
    if (/SELECT .*usernode_pubkey = \$1/s.test(sql)) {
      return { rows: usersByPubkey };
    }
    return { rows: [], rowCount: 0 };
  },
});

// ── Silence the logger ─────────────────────────────────────────────
const logger = require('../src/services/logger');
for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = () => {};

const { verificationKeyFor } = require('../src/services/wallet-signing-key');
const { authRoutes } = require('../src/routes/auth');
const express = require('express');

const VICTIM_ADDRESS = 'ut1rr7y8pkk2tt4lmw2rfscr3qgsm0s7g4m603ey03dhnuh9kqsfe7quxxlru';
const ATTACKER_KEY = 'ut1zjasv3n33ntph9da6w9hh3geu26xwmmjx2gqrwd3lw3k4a797u3sprxf00';
const VICTIM_ROW = {
  id: 42,
  username: 'victim_admin',
  is_admin: true,
  admin_readonly: false,
  usernode_pubkey: VICTIM_ADDRESS,
};

// Fake node RPC. Records what key it was asked about, and always answers
// valid — see the header note on why that is faithful to the attack.
let verifyCalls = [];
function startRpc() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { verifyCalls.push(JSON.parse(body)); } catch { verifyCalls.push(null); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ valid: true }));
    });
  });
  return new Promise((resolve) => srv.listen(0, () => resolve(srv)));
}

let currentUser = null;
function startApp(config) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (currentUser) req.user = currentUser; next(); });
  app.use(authRoutes(config));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function post(server, path, body) {
  const port = server.address().port;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(async (res) => ({
    res,
    body: await res.json().catch(() => ({})),
    setCookie: res.headers.get('set-cookie'),
  }));
}

async function challengeFor(server, pubkey) {
  const { body } = await post(server, '/api/auth/wallet-check', { pubkey });
  return body.challenge;
}

function sessionInserts() {
  return capturedQueries.filter((q) => /INSERT INTO sessions/i.test(q.sql));
}

function reset() {
  capturedQueries = [];
  verifyCalls = [];
  usersByPubkey = [];
  userLinkedPubkeyRow = null;
  currentUser = null;
}

async function withServers(run) {
  const rpc = await startRpc();
  const config = {
    nodeRpcUrl: `http://127.0.0.1:${rpc.address().port}`,
    sessionCookieName: 'session',
  };
  const server = await startApp(config);
  try {
    await run(server);
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => rpc.close(r));
  }
}

// ── The helper, in isolation ───────────────────────────────────────
test('verificationKeyFor: only the account key is ever returned', () => {
  assert.strictEqual(verificationKeyFor(VICTIM_ADDRESS, undefined), VICTIM_ADDRESS);
  assert.strictEqual(verificationKeyFor(VICTIM_ADDRESS, ''), VICTIM_ADDRESS);
  assert.strictEqual(verificationKeyFor(VICTIM_ADDRESS, `  ${VICTIM_ADDRESS} `), VICTIM_ADDRESS);
  assert.strictEqual(verificationKeyFor(VICTIM_ADDRESS, ATTACKER_KEY), null);
  assert.strictEqual(verificationKeyFor(null, ATTACKER_KEY), null);
  assert.strictEqual(verificationKeyFor('', ''), null);
});

// ── The reported attack ────────────────────────────────────────────
test('wallet-verify: a signature by a key the account never linked mints no session', async () => {
  reset();
  usersByPubkey = [VICTIM_ROW];
  await withServers(async (server) => {
    const challenge = await challengeFor(server, VICTIM_ADDRESS);
    assert.ok(challenge, 'wallet-check issues a challenge for a linked address');

    const { res, body, setCookie } = await post(server, '/api/auth/wallet-verify', {
      pubkey: VICTIM_ADDRESS,                 // the account the attacker wants
      publicKey: 'ATTACKER_OWN_PUBLIC_KEY_not_the_victims',
      challenge,
      signature: 'attacker-signature-over-the-server-challenge',
    });

    assert.strictEqual(res.status, 401, 'login is refused');
    assert.ok(!body.user, 'no account is returned');
    assert.ok(!setCookie, 'no session cookie is set');
    assert.strictEqual(sessionInserts().length, 0, 'no session row is written');
    assert.deepStrictEqual(
      verifyCalls.filter((c) => c && c.public_key !== VICTIM_ADDRESS),
      [],
      'the verifier is never asked about a caller-supplied key'
    );
    assert.strictEqual(verifyCalls.length, 0, 'the refusal happens before the node is called');
  });
});

test('wallet-verify: the legitimate wallet login still works', async () => {
  reset();
  usersByPubkey = [VICTIM_ROW];
  await withServers(async (server) => {
    const challenge = await challengeFor(server, VICTIM_ADDRESS);
    const { res, body, setCookie } = await post(server, '/api/auth/wallet-verify', {
      pubkey: VICTIM_ADDRESS,
      publicKey: VICTIM_ADDRESS,
      challenge,
      signature: 'a-real-signature-by-the-linked-wallet',
    });

    assert.strictEqual(res.status, 200, 'login succeeds');
    assert.strictEqual(body.user.id, 42);
    assert.strictEqual(body.user.username, 'victim_admin');
    assert.ok(setCookie && /session=/.test(setCookie), 'a session cookie is set');
    assert.strictEqual(sessionInserts().length, 1, 'exactly one session row is written');
    assert.strictEqual(verifyCalls.length, 1);
    assert.strictEqual(verifyCalls[0].public_key, VICTIM_ADDRESS,
      'the verifier is asked about the account key');
    assert.strictEqual(verifyCalls[0].message, challenge);
  });
});

test('wallet-verify: a client that sends no publicKey still logs in', async () => {
  reset();
  usersByPubkey = [VICTIM_ROW];
  await withServers(async (server) => {
    const challenge = await challengeFor(server, VICTIM_ADDRESS);
    const { res } = await post(server, '/api/auth/wallet-verify', {
      pubkey: VICTIM_ADDRESS,
      challenge,
      signature: 'a-real-signature-by-the-linked-wallet',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(verifyCalls[0].public_key, VICTIM_ADDRESS);
  });
});

// ── Challenge hygiene ──────────────────────────────────────────────
test('wallet-verify: a challenge is single-use and bound to one address', async () => {
  reset();
  usersByPubkey = [VICTIM_ROW];
  await withServers(async (server) => {
    const challenge = await challengeFor(server, VICTIM_ADDRESS);

    // Bound: the same challenge presented under another address is refused,
    // and refused without consuming anything on the victim's behalf.
    const other = await post(server, '/api/auth/wallet-verify', {
      pubkey: ATTACKER_KEY,
      challenge,
      signature: 'sig',
    });
    assert.strictEqual(other.res.status, 401);

    const first = await post(server, '/api/auth/wallet-verify', {
      pubkey: VICTIM_ADDRESS, challenge, signature: 'sig',
    });
    assert.strictEqual(first.res.status, 200);

    // Single-use: the same challenge cannot be replayed.
    const replay = await post(server, '/api/auth/wallet-verify', {
      pubkey: VICTIM_ADDRESS, challenge, signature: 'sig',
    });
    assert.strictEqual(replay.res.status, 401);
    assert.strictEqual(replay.body.error, 'Invalid or expired challenge');
    assert.strictEqual(sessionInserts().length, 1, 'only the first attempt minted a session');
  });
});

test('wallet-verify: an address linked to two accounts fails closed', async () => {
  reset();
  usersByPubkey = [VICTIM_ROW, { ...VICTIM_ROW, id: 43, username: 'other' }];
  await withServers(async (server) => {
    const challenge = await challengeFor(server, VICTIM_ADDRESS);
    const { res } = await post(server, '/api/auth/wallet-verify', {
      pubkey: VICTIM_ADDRESS, challenge, signature: 'sig',
    });
    assert.strictEqual(res.status, 401, 'an ambiguous address signs nobody in');
    assert.strictEqual(sessionInserts().length, 0);
  });
});

// ── The same hole on the two sibling endpoints ─────────────────────
test('wallet-reset-verify: a foreign key cannot reset an account password', async () => {
  reset();
  usersByPubkey = [VICTIM_ROW];
  await withServers(async (server) => {
    const challenge = await challengeFor(server, VICTIM_ADDRESS);
    const { res } = await post(server, '/api/auth/wallet-reset-verify', {
      pubkey: VICTIM_ADDRESS,
      publicKey: 'ATTACKER_OWN_PUBLIC_KEY_not_the_victims',
      challenge,
      signature: 'attacker-signature',
      newPassword: 'attacker-chosen-password',
    });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(verifyCalls.length, 0, 'the node is never asked about the attacker key');
    assert.strictEqual(
      capturedQueries.filter((q) => /UPDATE users SET password/i.test(q.sql)).length,
      0,
      'no password is written'
    );
    assert.strictEqual(sessionInserts().length, 0);
  });
});

test('wallet-change-password: a foreign key cannot change the session owner password', async () => {
  reset();
  currentUser = { id: 42, username: 'victim_admin' };
  usersByPubkey = [VICTIM_ROW];
  userLinkedPubkeyRow = { usernode_pubkey: VICTIM_ADDRESS };
  await withServers(async (server) => {
    const challenge = await challengeFor(server, VICTIM_ADDRESS);
    const { res } = await post(server, '/api/me/wallet-change-password', {
      publicKey: 'ATTACKER_OWN_PUBLIC_KEY_not_the_victims',
      challenge,
      signature: 'attacker-signature',
      newPassword: 'attacker-chosen-password',
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(verifyCalls.length, 0);
    assert.strictEqual(
      capturedQueries.filter((q) => /UPDATE users SET password/i.test(q.sql)).length,
      0,
      'no password is written'
    );
  });
});
