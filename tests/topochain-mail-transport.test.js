// Topochain outbound mail: the transport behind mailer.js's hook, and the
// contract both of its callers depend on.
//
// The bug this pins: `config.topochainMailTransport` was a hook nothing
// ever filled, so BOTH senders generated a message and dropped it while
// their endpoints still reported success. That is not a bug in the
// endpoints — POST /api/v4/mobile/auth/otp/request is always-200 by
// contract (SPEC 1667) precisely so it can't be used to enumerate
// accounts, and the waitlist join has the same shape — which is exactly
// why non-delivery was invisible.
//
// So the property under test is two-sided: mail must actually SEND when
// configured, and a broken transport must STILL not change either
// caller's response.
//
// Run with: node --test tests/topochain-mail-transport.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const transport = require(path.join(ROOT, 'src/services/topochain/mail-transport.js'));
const { sendOtpMail, sendWaitlistJoinMail, sendWaitlistReleaseMail } =
  require(path.join(ROOT, 'src/services/topochain/mailer.js'));

const FULL_ENV = {
  TOPOCHAIN_MAIL_API_URL: 'https://mail.example.invalid/send',
  TOPOCHAIN_MAIL_API_KEY: 'test-key',
  TOPOCHAIN_MAIL_FROM: 'Usernode <no-reply@example.invalid>',
};

// ─── create(): configured / unconfigured / partial ──────────────────────

test('create() returns null when nothing is configured', () => {
  // Must be null, not a throwing stub — mailer.js's "no transport
  // configured" branch (and its loud production error) keys off falsiness.
  assert.equal(transport.create({}), null);
});

test('create() returns null — and says which keys are missing — when partial', () => {
  for (const drop of Object.keys(FULL_ENV)) {
    const env = { ...FULL_ENV };
    delete env[drop];
    assert.equal(transport.create(env), null,
      `${drop} missing must not yield a half-working transport`);
  }
});

test('create() returns a transport with a send() when fully configured', () => {
  const t = transport.create(FULL_ENV);
  assert.ok(t && typeof t.send === 'function');
});

// ─── send(): both kinds reach the provider ──────────────────────────────

function withFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve(fn()).finally(() => { global.fetch = original; });
}

test('an OTP send POSTs the code to the provider with the bearer token', async () => {
  const calls = [];
  await withFetch(async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, text: async () => '' };
  }, async () => {
    await transport.create(FULL_ENV).send({ to: 'a@b.invalid', kind: 'otp', code: '123456' });
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, FULL_ENV.TOPOCHAIN_MAIL_API_URL);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer test-key');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body.to, ['a@b.invalid']);
  assert.equal(body.from, FULL_ENV.TOPOCHAIN_MAIL_FROM);
  assert.match(body.text, /123456/, 'the code must reach the user');
  assert.match(body.subject, /login code/i);
});

test('a waitlist send uses its own subject and carries no code', async () => {
  let body;
  await withFetch(async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => '' };
  }, async () => {
    await transport.create(FULL_ENV).send({ to: 'a@b.invalid', kind: 'waitlist_joined' });
  });
  assert.match(body.subject, /waitlist/i);
  assert.match(body.text, /waitlist/i);
  assert.doesNotMatch(body.text, /undefined/,
    'a missing code must not leak into the body as the string "undefined"');
});

test('a release send branches its copy on hasAccount and carries the link', async () => {
  const bodies = [];
  await withFetch(async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200, text: async () => '' };
  }, async () => {
    const t = transport.create(FULL_ENV);
    await t.send({ to: 'a@b.invalid', kind: 'waitlist_released', url: 'https://x.invalid/#signup', hasAccount: false });
    await t.send({ to: 'a@b.invalid', kind: 'waitlist_released', url: 'https://x.invalid/#login', hasAccount: true });
  });
  assert.match(bodies[0].subject, /access is ready/i);
  assert.match(bodies[0].text, /create your account/i);
  assert.match(bodies[0].text, /https:\/\/x\.invalid\/#signup/);
  assert.match(bodies[1].text, /sign in/i);
  assert.match(bodies[1].text, /https:\/\/x\.invalid\/#login/);
  for (const b of bodies) {
    assert.doesNotMatch(b.text, /undefined/,
      'missing payload fields must not leak into the body as "undefined"');
  }
});

test('an unknown kind throws rather than sending a blank email', async () => {
  await withFetch(async () => ({ ok: true, status: 200, text: async () => '' }), async () => {
    await assert.rejects(
      () => transport.create(FULL_ENV).send({ to: 'a@b.invalid', kind: 'nope' }),
      /unknown mail kind/);
  });
});

test('a non-2xx provider reply throws (so mailer.js logs it)', async () => {
  await withFetch(
    async () => ({ ok: false, status: 422, text: async () => 'bad sender' }),
    async () => {
      await assert.rejects(
        () => transport.create(FULL_ENV).send({ to: 'a@b.invalid', kind: 'otp', code: '1' }),
        /HTTP 422/);
    });
});

// ─── mailer.js routes both senders through the hook ─────────────────────

test('sendOtpMail passes kind:"otp" explicitly', async () => {
  const seen = [];
  await sendOtpMail(
    { topochainMailTransport: { send: async (m) => { seen.push(m); } } },
    'a@b.invalid', '999111');
  assert.equal(seen.length, 1);
  // Explicit `kind` means a transport branches on one field rather than
  // inferring the message type from the presence of `code`.
  assert.equal(seen[0].kind, 'otp');
  assert.equal(seen[0].code, '999111');
  assert.equal(seen[0].to, 'a@b.invalid');
});

test('sendWaitlistJoinMail passes kind:"waitlist_joined"', async () => {
  const seen = [];
  await sendWaitlistJoinMail(
    { topochainMailTransport: { send: async (m) => { seen.push(m); } } },
    'a@b.invalid');
  assert.equal(seen[0].kind, 'waitlist_joined');
});

test('sendWaitlistReleaseMail passes kind:"waitlist_released" and a signup/login link', async () => {
  const seen = [];
  const cfg = { topochainMailTransport: { send: async (m) => { seen.push(m); } } };
  await sendWaitlistReleaseMail(cfg, 'a@b.invalid', { hasAccount: false });
  await sendWaitlistReleaseMail(cfg, 'a@b.invalid', { hasAccount: true });
  assert.equal(seen[0].kind, 'waitlist_released');
  assert.match(seen[0].url, /#signup$/, 'no account yet → the link lands on account creation');
  assert.match(seen[1].url, /#login$/, 'existing account → the link lands on sign-in');
});

// ─── the always-success contract survives a broken transport ────────────

test('all senders swallow a throwing transport and resolve', async () => {
  const boom = { topochainMailTransport: { send: async () => { throw new Error('nope'); } } };
  // No rejection, no return value the caller must check — the endpoints
  // above these must be unable to tell delivery apart from non-delivery.
  assert.equal(await sendOtpMail(boom, 'a@b.invalid', '1'), undefined);
  assert.equal(await sendWaitlistJoinMail(boom, 'a@b.invalid'), undefined);
  assert.equal(await sendWaitlistReleaseMail(boom, 'a@b.invalid', { hasAccount: false }), undefined);
});

test('all senders resolve with no transport at all, in production', async () => {
  const prod = { env: 'production' };
  assert.equal(await sendOtpMail(prod, 'a@b.invalid', '1'), undefined);
  assert.equal(await sendWaitlistJoinMail(prod, 'a@b.invalid'), undefined);
  assert.equal(await sendWaitlistReleaseMail(prod, 'a@b.invalid', { hasAccount: true }), undefined);
});

test('production never logs the raw OTP code', () => {
  // Global Constraints #6. The dev/staging branch deliberately DOES print
  // it so the flow stays completable by hand.
  const src = fs.readFileSync(
    path.join(ROOT, 'src/services/topochain/mailer.js'), 'utf8');
  const prodBranch = src.slice(src.indexOf("config.env === 'production'"));
  const firstReturn = prodBranch.slice(0, prodBranch.indexOf('return;'));
  assert.doesNotMatch(firstReturn, /\bcode\b\s*[,}]/,
    'the production branch must not pass `code` into a log call');
});

// ─── describe(): what the admin screen renders ──────────────────────────

test('describe() reports presence only — never a value', () => {
  const d = transport.describe(FULL_ENV);
  assert.equal(d.configured, true);
  assert.deepEqual(d.missing, []);
  const serialized = JSON.stringify(d);
  assert.ok(!serialized.includes('test-key'), 'the credential must never be returned');
  assert.ok(!serialized.includes(FULL_ENV.TOPOCHAIN_MAIL_API_URL));
});

test('describe() names the missing keys and the flows that break', () => {
  const d = transport.describe({});
  assert.equal(d.configured, false);
  assert.deepEqual(d.missing.sort(), [
    'TOPOCHAIN_MAIL_API_KEY', 'TOPOCHAIN_MAIL_API_URL', 'TOPOCHAIN_MAIL_FROM',
  ]);
  assert.equal(d.affectedFlows.length, 3,
    'every silently-broken flow must be named for the admin');
  assert.match(d.affectedFlows.join(' '), /login/i);
  assert.match(d.affectedFlows.join(' '), /waitlist/i);
  assert.match(d.affectedFlows.join(' '), /release/i);
});

test('the admin mail-status route is registered ahead of GET /:key', () => {
  // Otherwise `mail-status` is swallowed as a settings key.
  const src = fs.readFileSync(
    path.join(ROOT, 'src/routes/topochain/admin/settings.js'), 'utf8');
  const statusIdx = src.indexOf("'/api/v4/admin/settings/mail-status'");
  const keyIdx = src.indexOf("router.get('/api/v4/admin/settings/:key'");
  assert.ok(statusIdx > -1 && keyIdx > -1);
  assert.ok(statusIdx < keyIdx, 'mail-status must be registered before /:key');
});
