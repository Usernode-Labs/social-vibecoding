// Admin → Email delivery: the provider switch.
//
//   PUT /api/admin/mail/provider — full admin; saves which provider sends
//       platform mail (gmail, http or brevo) in platform_settings
//       `mail_provider`. A provider that is not ready is 409 with the names
//       of what is missing.
//
// What makes the switch safe to ship, and what this file holds:
//
//   1. THE SAVED CHOICE WINS, AND ONLY A KNOWN ONE. It beats
//      PLATFORM_MAIL_PROVIDER, the way the saved SMS provider beats its
//      variable; anything else in the row is ignored.
//   2. IT IS NEVER DOWNGRADED. A saved provider whose keys are gone sends
//      nothing and says so, exactly as a named PLATFORM_MAIL_PROVIDER does. It
//      does not quietly fall back to the transport resolved at boot.
//   3. A STAGING PREVIEW NEVER FOLLOWS IT. A preview is a copy of production
//      data, saved row included, and must go on logging.
//   4. A SEND FOLLOWS IT WITHOUT A REDEPLOY. config.js resolved a transport
//      at boot; send() swaps it when the saved provider is another one.
//
// The routes run over HTTP on a real express app, as in
// tests/admin-sms-console.test.js: the logger, the event recorder, the
// session gates and the pool are stubbed, and the one outbound call (Brevo's
// API) is caught at fetch.
//
// Run with: node --test tests/admin-mail-provider.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const recorded = [];
const logged = [];
stub(require.resolve('../src/services/logger'), {
  info: () => {}, debug: () => {},
  warn: (...args) => { logged.push(['warn', ...args]); },
  error: (...args) => { logged.push(['error', ...args]); },
});
stub(require.resolve('../src/services/events'), {
  EVENT_TYPES: { MAIL_PROVIDER_CHANGED: 'mail_provider_changed', MAIL_TEST_SENT: 'mail_test_sent' },
  record: (_pool, ev) => { recorded.push(ev); },
});
stub(require.resolve('../src/middleware/admin'), {
  adminMiddleware: (req, res, next) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
    return next();
  },
  requireAdminWrite: (req, res, next) => {
    if (!req.user?.canAdminWrite) return res.status(403).json({ error: 'View-only admin' });
    return next();
  },
});

// One pool for the whole file: platform_settings is a map, mail_deliveries a
// list of what was written, and every other read answers empty.
const settings = new Map();
let settingsReads = 0;
let settingsBroken = false;
const deliveries = [];
const pool = {
  async query(sql, params) {
    if (/FROM platform_settings/.test(sql)) {
      settingsReads += 1;
      if (settingsBroken) throw new Error('relation "platform_settings" does not exist');
      const row = settings.get(params[0]);
      return { rows: row ? [{ value: row.value }] : [] };
    }
    if (/INSERT INTO platform_settings/.test(sql)) {
      settings.set(params[0], { value: params[1], updatedBy: params[2] });
      return { rowCount: 1 };
    }
    if (/INSERT INTO mail_deliveries/.test(sql)) {
      deliveries.push({ kind: params[0], recipient: params[1], provider: params[2], status: params[3] });
      return { rows: [], rowCount: 1 };
    }
    if (/COUNT\(\*\)::int AS n FROM mail_deliveries/.test(sql)) return { rows: [{ n: 0 }] };
    return { rows: [], rowCount: 0 };
  },
  connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
};
require('../src/db/pool').getPool = () => pool;

const mail = require('../src/services/mail');
const select = require('../src/services/mail/select');
const { adminRoutes } = require('../src/routes/admin');
const express = require('express');

const GMAIL_ENV = {
  GMAIL_OAUTH_CLIENT_ID: 'cid',
  GMAIL_OAUTH_CLIENT_SECRET: 'csecret',
  GMAIL_OAUTH_REFRESH_TOKEN: 'rtoken',
};
const MAIL_KEYS = [
  ...Object.keys(GMAIL_ENV), 'BREVO_API_KEY', 'PLATFORM_MAIL_PROVIDER', 'USERNODE_ENV',
  'TOPOCHAIN_MAIL_API_URL', 'TOPOCHAIN_MAIL_API_KEY', 'PLATFORM_MAIL_FROM', 'TOPOCHAIN_MAIL_FROM',
];

// The routes and send() read process.env, so each test names the whole mail
// environment it runs in and gets the old one back.
async function withEnv(env, fn) {
  const before = {};
  for (const key of MAIL_KEYS) { before[key] = process.env[key]; delete process.env[key]; }
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const key of MAIL_KEYS) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

function reset() {
  settings.clear();
  settingsReads = 0;
  settingsBroken = false;
  deliveries.length = 0;
  recorded.length = 0;
  logged.length = 0;
  brevoCalls.length = 0;
  select.invalidate();
}

// Brevo's API is the one outbound call; the test's own requests to the local
// server go through the real fetch.
const realFetch = globalThis.fetch;
const brevoCalls = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.brevo.com/')) {
    brevoCalls.push({ url: String(url), key: opts.headers['api-key'], body: JSON.parse(opts.body) });
    return { ok: true, status: 201, text: async () => JSON.stringify({ messageId: '<m1@brevo>' }) };
  }
  return realFetch(url, opts);
};
test.after(() => { globalThis.fetch = realFetch; });

let currentUser = null;
async function startServer(config = { databaseUrl: 'postgres://fake/fake', env: 'test' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(adminRoutes(config));
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}

async function call(server, method, route, body) {
  const res = await realFetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const viewer = { id: 6, username: 'viewer', isAdmin: true, canAdminWrite: false };
const fullAdmin = { id: 7, username: 'admin', isAdmin: true, canAdminWrite: true };

// ── the saved choice ───────────────────────────────────────────────────

test('the saved provider is read from platform_settings, and only a provider that sends counts', async () => {
  reset();
  assert.equal(await select.savedChoice(pool), null, 'no row, no choice');

  for (const junk of ['log', 'auto', 'carrier-pigeon', '', 42, null]) {
    select.invalidate();
    settings.set('mail_provider', { value: junk });
    assert.equal(await select.savedChoice(pool), null, `${JSON.stringify(junk)} is not a choice`);
  }
  for (const name of ['gmail', 'http', 'brevo']) {
    select.invalidate();
    settings.set('mail_provider', { value: name });
    assert.equal(await select.savedChoice(pool), name);
  }
  assert.deepEqual(select.SWITCHABLE, ['gmail', 'http', 'brevo']);
});

test('the read is cached for ten seconds, and a save is seen at once', async () => {
  reset();
  settings.set('mail_provider', { value: 'gmail' });
  const t0 = 1_000_000;
  assert.equal(await select.savedChoice(pool, { now: t0 }), 'gmail');
  settings.set('mail_provider', { value: 'brevo' });
  assert.equal(await select.savedChoice(pool, { now: t0 + select.CACHE_MS - 1 }), 'gmail', 'still the cached answer');
  assert.equal(settingsReads, 1);
  assert.equal(await select.savedChoice(pool, { now: t0 + select.CACHE_MS }), 'brevo', 'read again once it is stale');

  // The process that saves does not wait out its own cache.
  await select.setProvider(pool, 'http', 7);
  assert.equal(await select.savedChoice(pool), 'http');
  assert.deepEqual(settings.get('mail_provider'), { value: 'http', updatedBy: 7 });
  await assert.rejects(() => select.setProvider(pool, 'log'), /Unknown mail provider/);
});

test('an unreadable setting, or no pool, leaves the deploy\'s choice in force', async () => {
  reset();
  settings.set('mail_provider', { value: 'brevo' });
  settingsBroken = true;
  assert.equal(await select.savedChoice(pool), null, 'a broken table is no choice, and no throw');
  select.invalidate();
  settingsBroken = false;
  assert.equal(await select.savedChoice(pool), 'brevo');
  assert.equal(await select.savedChoice(null), null, 'a caller with no pool never sees a cached choice');
});

// ── selection ──────────────────────────────────────────────────────────

test('the saved provider wins over PLATFORM_MAIL_PROVIDER and is never downgraded', () => {
  const env = { ...GMAIL_ENV, BREVO_API_KEY: 'k', PLATFORM_MAIL_PROVIDER: 'gmail', USERNODE_ENV: 'production' };
  const chosen = select.chooseTransport(env, { saved: 'brevo' });
  assert.equal(chosen.provider, 'brevo');
  assert.equal(chosen.source, 'admin');

  // Saved, but its key is gone: broken, not Gmail, though Gmail is set up
  // and the deploy names it.
  const broken = select.chooseTransport({ ...GMAIL_ENV, PLATFORM_MAIL_PROVIDER: 'gmail', USERNODE_ENV: 'production' },
    { saved: 'brevo' });
  assert.equal(broken.transport, null);
  assert.equal(broken.provider, null);
  assert.equal(broken.requested, 'brevo');

  assert.equal(select.chooseTransport(env).source, 'env');
  assert.equal(select.chooseTransport({ ...GMAIL_ENV, USERNODE_ENV: 'production' }).source, 'default');
  assert.equal(select.chooseTransport(env, { saved: 'carrier-pigeon' }).provider, 'gmail',
    'a saved value that is no provider is ignored');
});

test('a staging preview logs whatever was saved, and may try the switch without keys', () => {
  const chosen = select.chooseTransport({ BREVO_API_KEY: 'k', USERNODE_ENV: 'staging' }, { saved: 'brevo' });
  assert.equal(chosen.provider, 'log');
  assert.equal(chosen.stagingLogOnly, true);

  const preview = select.describe({ USERNODE_ENV: 'staging' }, { saved: 'brevo' });
  assert.equal(preview.configured, false, 'a preview never reports mail as deliverable');
  assert.deepEqual(preview.providers.map((p) => [p.name, p.configured, p.ready]),
    [['gmail', false, true], ['http', false, true], ['brevo', false, true]]);

  const live = select.describe({ ...GMAIL_ENV, USERNODE_ENV: 'production' });
  assert.deepEqual(live.providers.map((p) => [p.name, p.ready]),
    [['gmail', true], ['http', false], ['brevo', false]], 'outside a preview, ready is configured');
});

test('the status names who chose the provider and what the chosen one lacks, never a value', () => {
  const env = { ...GMAIL_ENV, BREVO_API_KEY: 'secret-key-value', USERNODE_ENV: 'production' };
  const status = select.describe(env, { saved: 'brevo' });
  assert.equal(status.provider, 'brevo');
  assert.equal(status.requestedProvider, 'brevo');
  assert.equal(status.source, 'admin');
  assert.equal(status.configured, true);
  assert.ok(!JSON.stringify(status).includes('secret-key-value'));
  assert.ok(!JSON.stringify(status).includes('rtoken'));

  const lacking = select.describe({ ...GMAIL_ENV, USERNODE_ENV: 'production' }, { saved: 'brevo' });
  assert.equal(lacking.configured, false);
  assert.deepEqual(lacking.missing, ['BREVO_API_KEY']);
});

// ── a send follows the saved provider ──────────────────────────────────

const cfg = (extra = {}) => ({ databaseUrl: 'postgres://fake/fake', env: 'test', ...extra });
const bootGmail = (sent) => ({ provider: 'gmail', send: async (m) => { sent.push(m); } });

test('a send goes out through the saved provider, not the transport resolved at boot', async () => {
  reset();
  settings.set('mail_provider', { value: 'brevo' });
  const viaBoot = [];
  await withEnv({ BREVO_API_KEY: 'brevo-key', USERNODE_ENV: 'production' }, () => mail.send(
    cfg({ mailTransport: bootGmail(viaBoot), mailProvider: 'gmail', mailStagingLogOnly: false }),
    { kind: 'otp', to: 'a@b.invalid', code: '424242' }
  ));
  assert.equal(viaBoot.length, 0, 'the boot transport is not used');
  assert.equal(brevoCalls.length, 1);
  assert.equal(brevoCalls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(brevoCalls[0].key, 'brevo-key');
  assert.deepEqual(brevoCalls[0].body.to, [{ email: 'a@b.invalid' }]);
  assert.deepEqual(deliveries.map((d) => [d.provider, d.status]), [['brevo', 'sent']],
    'the ledger names the provider that sent');
});

test('with nothing saved, or the boot provider saved, the boot transport sends', async () => {
  reset();
  const viaBoot = [];
  const config = cfg({ mailTransport: bootGmail(viaBoot), mailProvider: 'gmail', mailStagingLogOnly: false });
  await withEnv({ BREVO_API_KEY: 'brevo-key', USERNODE_ENV: 'production' }, async () => {
    await mail.send(config, { kind: 'otp', to: 'a@b.invalid', code: '424242' });
    await select.setProvider(pool, 'gmail', 7);
    await mail.send(config, { kind: 'otp', to: 'c@d.invalid', code: '424242' });
  });
  assert.equal(viaBoot.length, 2);
  assert.equal(brevoCalls.length, 0);
});

test('a saved provider that is not configured sends nothing; it does not fall back', async () => {
  reset();
  settings.set('mail_provider', { value: 'brevo' });
  const viaBoot = [];
  await withEnv({ USERNODE_ENV: 'production' }, () => mail.send(
    cfg({ mailTransport: bootGmail(viaBoot), mailProvider: 'gmail', mailStagingLogOnly: false }),
    { kind: 'otp', to: 'a@b.invalid', code: '424242' }
  ));
  assert.equal(viaBoot.length, 0, 'Gmail is not a quiet stand-in for the provider that was chosen');
  assert.equal(brevoCalls.length, 0);
  assert.deepEqual(deliveries.map((d) => [d.provider, d.status]), [[null, 'no_transport']]);
  assert.ok(logged.some(([level, , message]) => level === 'error' && /saved in the admin console is not configured/.test(message)),
    'and it is loud about it');
});

test('a staging preview never follows the saved provider', async () => {
  reset();
  settings.set('mail_provider', { value: 'brevo' });
  const viaLog = [];
  await withEnv({ BREVO_API_KEY: 'brevo-key', USERNODE_ENV: 'staging' }, () => mail.send(
    cfg({ mailTransport: { provider: 'log', send: async (m) => { viaLog.push(m); } }, mailProvider: 'log', mailStagingLogOnly: true }),
    { kind: 'otp', to: 'a@b.invalid', code: '424242' }
  ));
  assert.equal(brevoCalls.length, 0, 'a copy of production\'s saved row reaches no provider');
  assert.equal(viaLog.length, 1);
  assert.equal(settingsReads, 0, 'the preview does not even ask');
  assert.deepEqual(deliveries.map((d) => [d.provider, d.status]), [['log', 'skipped_staging']]);
});

test('the test send goes out through the saved provider too', async () => {
  reset();
  settings.set('mail_provider', { value: 'brevo' });
  const viaBoot = [];
  const outcome = await withEnv({ ...GMAIL_ENV, BREVO_API_KEY: 'brevo-key', USERNODE_ENV: 'production' }, () => mail.sendTest(
    cfg({ mailTransport: bootGmail(viaBoot), mailProvider: 'gmail', mailStagingLogOnly: false }),
    { to: 'ops@example.invalid' }
  ));
  assert.equal(outcome.provider, 'brevo');
  assert.equal(outcome.requestedProvider, 'brevo');
  assert.equal(viaBoot.length, 0);
});

// ── the route ──────────────────────────────────────────────────────────

test('any admin reads who sends; only a full admin changes it', async () => {
  reset();
  const server = await startServer();
  try {
    await withEnv({ ...GMAIL_ENV, BREVO_API_KEY: 'brevo-key', USERNODE_ENV: 'production' }, async () => {
      currentUser = viewer;
      const status = await call(server, 'GET', '/api/admin/mail/status');
      assert.equal(status.status, 200);
      assert.equal(status.body.provider, 'gmail');
      assert.equal(status.body.source, 'default');
      assert.deepEqual(status.body.providers.map((p) => [p.name, p.ready]),
        [['gmail', true], ['http', false], ['brevo', true]]);
      assert.ok(!JSON.stringify(status.body).includes('brevo-key'), 'the key never leaves the server');

      const denied = await call(server, 'PUT', '/api/admin/mail/provider', { provider: 'brevo' });
      assert.equal(denied.status, 403);
      assert.equal(settings.has('mail_provider'), false, 'a view-only admin changes nothing');

      currentUser = fullAdmin;
      const unknown = await call(server, 'PUT', '/api/admin/mail/provider', { provider: 'log' });
      assert.equal(unknown.status, 400);
      assert.equal(unknown.body.code, 'unknown_provider');

      const switched = await call(server, 'PUT', '/api/admin/mail/provider', { provider: ' Brevo ' });
      assert.equal(switched.status, 200);
      assert.equal(switched.body.status.provider, 'brevo');
      assert.equal(switched.body.status.source, 'admin');
      assert.deepEqual(settings.get('mail_provider'), { value: 'brevo', updatedBy: 7 });
      assert.deepEqual(recorded, [{
        type: 'mail_provider_changed', userId: 7, metadata: { from: 'gmail', to: 'brevo' },
      }]);

      currentUser = viewer;
      const after = await call(server, 'GET', '/api/admin/mail/status');
      assert.equal(after.body.provider, 'brevo', 'the status follows the saved choice');
      assert.equal(after.body.source, 'admin');
    });
  } finally { server.close(); }
});

test('choosing a provider that is not ready answers 409 with what is missing', async () => {
  reset();
  const server = await startServer();
  try {
    await withEnv({ ...GMAIL_ENV, USERNODE_ENV: 'production' }, async () => {
      currentUser = fullAdmin;
      const res = await call(server, 'PUT', '/api/admin/mail/provider', { provider: 'brevo' });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'not_ready');
      assert.deepEqual(res.body.missing, ['BREVO_API_KEY']);
      assert.equal(settings.has('mail_provider'), false);
      assert.equal(recorded.length, 0);
    });
  } finally { server.close(); }
});

test('the delivery reports follow the provider in force', async () => {
  reset();
  const server = await startServer({
    databaseUrl: 'postgres://fake/fake', env: 'test',
    mailTransport: { provider: 'gmail', send: async () => {} }, mailProvider: 'gmail', mailStagingLogOnly: false,
  });
  const token = process.env.BREVO_MAIL_WEBHOOK_TOKEN;
  process.env.BREVO_MAIL_WEBHOOK_TOKEN = 'webhook-token';
  try {
    await withEnv({ ...GMAIL_ENV, BREVO_API_KEY: 'brevo-key', USERNODE_ENV: 'production' }, async () => {
      currentUser = viewer;
      const gmail = await call(server, 'GET', '/api/admin/mail/activity');
      assert.equal(gmail.body.reports.deliveryEvents, false, 'Gmail has no delivery webhook');
      await select.setProvider(pool, 'brevo', 7);
      const brevo = await call(server, 'GET', '/api/admin/mail/activity');
      assert.equal(brevo.body.reports.deliveryEvents, true, 'Brevo\'s webhook reports them once it sends');
    });
  } finally {
    if (token === undefined) delete process.env.BREVO_MAIL_WEBHOOK_TOKEN;
    else process.env.BREVO_MAIL_WEBHOOK_TOKEN = token;
    server.close();
  }
});

// ── wiring ─────────────────────────────────────────────────────────────

test('the switch is full-admin-only on the server, and the console draws it', () => {
  const adminJs = read('src/routes/admin.js');
  assert.match(adminJs, /router\.put\('\/api\/admin\/mail\/provider', requireAdminWrite, /);
  assert.match(read('src/services/events.js'), /MAIL_PROVIDER_CHANGED: 'mail_provider_changed'/);

  const src = read('frontend/src/features/admin/admin-mail.tsx');
  assert.match(src, /id="admin-mail-provider"/);
  assert.match(src, /id="admin-mail-provider-save"/);
  assert.match(src, /'\/api\/admin\/mail\/provider'/);
  assert.match(src, /disabled=\{!write \|\| !o\.ready\}/, 'a provider that is not ready cannot be picked');
  assert.match(src, /Changing who sends email needs full admin access\./,
    'a view-only admin is told why there is no Save');
  assert.match(src, /<ProviderCard status=\{status\} write=\{write\} onSaved=\{providerSaved\} \/>/);

  // The Topochain settings card reads the same answer, so the two never name
  // two different senders.
  assert.match(read('src/routes/topochain/admin/settings.js'),
    /mail\.describe\(process\.env, \{ saved \}\)/);
});
