// #555: the admin credit-balance endpoints.
//
// The permission split is the load-bearing part: the GET is a pure read
// and view-only admins are squarely its audience (they can see the figure
// in the console's Spend limits section), while the PUT is a mutation and
// must be full-admin only. A regression that chains requireAdminWrite
// onto the GET would silently blank the figure for exactly the moderation
// audience it was built for.
//
// Stubbed-pool + real-express pattern, cf. tests/admin-limits-system.test.js.
//
// Run with: node --test tests/anthropic-credits-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// Stateful platform_settings so a PUT is observable by the recomputed
// read the same handler performs.
const poolMod = require('../src/db/pool');
const store = new Map();
poolMod.getPool = () => ({
  async query(sql, params) {
    if (/FROM platform_settings WHERE key = ANY/.test(sql)) {
      const wanted = params[0];
      return {
        rows: [...store.entries()]
          .filter(([k]) => wanted.includes(k))
          .map(([key, value]) => ({ key, value })),
      };
    }
    if (/SELECT value FROM platform_settings WHERE key/.test(sql)) {
      const v = store.get(params[0]);
      return { rows: v == null ? [] : [{ value: v }] };
    }
    if (/INSERT INTO platform_settings/.test(sql)) {
      store.set(params[0], params[1]);
      return { rows: [] };
    }
    // Local-ledger fallback (no admin key is configured in these tests).
    if (/FROM llm_usage/.test(sql)) return { rows: [{ cents: 12345 }] };
    if (/FROM system_token_usage/.test(sql)) return { rows: [{ cents: 655 }] };
    return { rows: [] };
  },
});

const anthropicCredits = require('../src/services/anthropic-credits');
const { adminRoutes } = require('../src/routes/admin');
const express = require('express');

// One app per role, so each test can pick its caller.
const servers = {};
const bases = {};

function mount(name, user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(adminRoutes({ jwtSecret: 'test' }));
  const server = app.listen(0);
  servers[name] = server;
  return new Promise((r) => server.once('listening', () => {
    bases[name] = `http://127.0.0.1:${server.address().port}`;
    r();
  }));
}

test.before(async () => {
  await mount('full', { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true });
  await mount('viewonly', { id: 2, username: 'mod', isAdmin: true, canAdminWrite: false });
  await mount('user', { id: 3, username: 'nobody', isAdmin: false, canAdminWrite: false });
});

test.after(() => Object.values(servers).forEach((s) => s && s.close()));

test.beforeEach(() => {
  store.clear();
  anthropicCredits.invalidate();
});

// ─── Reads ───────────────────────────────────────────────────────────────

test('GET reports "not configured" until a balance is recorded', async () => {
  const r = await fetch(`${bases.full}/api/admin/anthropic-credits`).then((x) => x.json());
  assert.deepEqual(r, { configured: false });
});

test('a view-only admin CAN read the credits (the figure is shown to them)', async () => {
  store.set('anthropic_credit_balance_cents', '500000');
  store.set('anthropic_credit_as_of', '2026-07-01');
  const res = await fetch(`${bases.viewonly}/api/admin/anthropic-credits`);
  assert.equal(res.status, 200, 'the GET must NOT chain requireAdminWrite');
  const body = await res.json();
  assert.equal(body.configured, true);
  assert.equal(body.remainingCents, 500000 - 13000, 'llm_usage + system_token_usage');
  assert.equal(body.source, 'local-estimate');
});

test('a non-admin is blocked on both verbs and sees no figures', async () => {
  store.set('anthropic_credit_balance_cents', '500000');
  store.set('anthropic_credit_as_of', '2026-07-01');
  // adminMiddleware bounces a non-admin before either handler runs. Note
  // it answers with a redirect rather than a 403 here: it branches on
  // `req.path`, which Express has already stripped of the `/api/admin`
  // mount prefix — a long-standing quirk shared by every route on this
  // router, so don't pin the exact status, pin "not served".
  for (const init of [
    { redirect: 'manual' },
    {
      method: 'PUT',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ balanceCents: 1000, asOf: '2026-07-01' }),
    },
  ]) {
    const res = await fetch(`${bases.user}/api/admin/anthropic-credits`, init);
    assert.ok(res.status >= 300, `non-admin blocked (got ${res.status})`);
    const body = await res.text();
    assert.ok(!/balanceCents|remainingCents|500000/.test(body),
      'no credit figures reach a non-admin');
  }
  assert.equal(store.get('anthropic_credit_balance_cents'), '500000',
    'the blocked PUT wrote nothing');
});

// ─── Writes ──────────────────────────────────────────────────────────────

test('a view-only admin cannot record a balance', async () => {
  const res = await fetch(`${bases.viewonly}/api/admin/anthropic-credits`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ balanceCents: 500000, asOf: '2026-07-01' }),
  });
  assert.equal(res.status, 403);
  assert.equal(store.size, 0, 'nothing was written');
});

test('a full admin records both keys and gets the recomputed snapshot back', async () => {
  const res = await fetch(`${bases.full}/api/admin/anthropic-credits`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ balanceCents: 500000, asOf: '2026-07-01' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(store.get('anthropic_credit_balance_cents'), '500000');
  assert.equal(store.get('anthropic_credit_as_of'), '2026-07-01');
  assert.equal(body.configured, true);
  assert.equal(body.balanceCents, 500000);
  assert.equal(body.spentCents, 13000);
  assert.equal(body.remainingCents, 487000);
});

test('dollars are accepted and rounded to cents', async () => {
  const body = await fetch(`${bases.full}/api/admin/anthropic-credits`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ balanceDollars: '5000.005', asOf: '2026-07-01' }),
  }).then((x) => x.json());
  assert.equal(body.balanceCents, 500001);
});

test('the PUT busts the service cache so the new balance shows at once', async () => {
  store.set('anthropic_credit_balance_cents', '100000');
  store.set('anthropic_credit_as_of', '2026-07-01');
  const before = await fetch(`${bases.full}/api/admin/anthropic-credits`).then((x) => x.json());
  assert.equal(before.remainingCents, 100000 - 13000);

  const after = await fetch(`${bases.full}/api/admin/anthropic-credits`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ balanceCents: 900000, asOf: '2026-07-01' }),
  }).then((x) => x.json());
  assert.equal(after.remainingCents, 900000 - 13000);
});

// ─── Validation ──────────────────────────────────────────────────────────

const bad = [
  ['a negative balance', { balanceCents: -1, asOf: '2026-07-01' }, /non-negative/],
  ['a non-numeric balance', { balanceCents: 'lots', asOf: '2026-07-01' }, /non-negative/],
  ['no balance at all', { asOf: '2026-07-01' }, /required/],
  ['a malformed date', { balanceCents: 1000, asOf: '01/07/2026' }, /YYYY-MM-DD/],
  ['a missing date', { balanceCents: 1000 }, /YYYY-MM-DD/],
  ['a date that is not real', { balanceCents: 1000, asOf: '2026-02-31' }, /real calendar date/],
];

for (const [label, body, re] of bad) {
  test(`PUT rejects ${label}`, async () => {
    const res = await fetch(`${bases.full}/api/admin/anthropic-credits`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, re);
    assert.equal(store.size, 0, 'a rejected write persists nothing');
  });
}

test('PUT rejects a future as-of date', async () => {
  const tomorrow = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const res = await fetch(`${bases.full}/api/admin/anthropic-credits`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ balanceCents: 1000, asOf: tomorrow }),
  });
  assert.equal(res.status, 400);
  // A future window would subtract nothing and read as "full balance"
  // forever.
  assert.match((await res.json()).error, /future/);
});
