'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const referrals = require('../src/services/referrals');
const { consentPage } = require('../src/routes/referrals');

const ROOT = path.join(__dirname, '..');
const CODE = '0123456789abcdef0123456789abcdef';

function req(headers = {}, protocol = 'https') {
  const lowered = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { protocol, get: (name) => lowered[name.toLowerCase()] };
}

test('consent tokens are short-lived, signed, scoped to code and app, and tamper evident', () => {
  const config = { sessionSecret: 'test-only-secret-value' };
  const now = Date.UTC(2026, 7, 5);
  const token = referrals.signConsent(config, CODE, 'echo-123', now);
  const value = referrals.verifyConsent(config, token, now + 1);
  assert.equal(value.code, CODE);
  assert.equal(value.app, 'echo-123');
  assert.equal(referrals.verifyConsent(config, token + 'x', now + 1), null);
  assert.equal(referrals.verifyConsent(config, token, now + referrals.CONSENT_TTL_MS + 1), null);
  assert.equal(referrals.verifyConsent({ sessionSecret: 'other' }, token, now + 1), null);
});

test('same-origin consent rejects cross-site and missing provenance', () => {
  assert.equal(referrals.sameOriginRequest(req({
    host: 'social-vibecoding.usernodelabs.org',
    origin: 'https://social-vibecoding.usernodelabs.org',
  })), true);
  assert.equal(referrals.sameOriginRequest(req({
    host: 'social-vibecoding.usernodelabs.org',
    origin: 'https://attacker.example',
  })), false);
  assert.equal(referrals.sameOriginRequest(req({ host: 'social-vibecoding.usernodelabs.org' })), false);
  assert.equal(referrals.sameOriginRequest(req({
    host: 'social-vibecoding.usernodelabs.org',
    referer: 'https://social-vibecoding.usernodelabs.org/r/example',
  })), true);
});

test('platform origin never reflects an arbitrary Host header', () => {
  assert.equal(
    referrals.platformOrigin(req({ host: 'evil.example' })),
    'https://social-vibecoding.usernodelabs.org'
  );
  assert.equal(
    referrals.platformOrigin(req({ host: 'usernode-2d5619--s2997.social-vibecoding.usernodelabs.org' })),
    'https://usernode-2d5619--s2997.social-vibecoding.usernodelabs.org'
  );
});

test('public destination lookup is closed to private, stopped, self-hosted and malformed apps', async () => {
  const calls = [];
  const pool = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: values[0] === 'public-app' ? [{ slug: 'public-app', name: 'Public' }] : [] };
  } };
  assert.equal(await referrals.publicAppDestination(pool, '../private'), null);
  const found = await referrals.publicAppDestination(pool, 'public-app');
  assert.deepEqual(found, {
    slug: 'public-app', name: 'Public',
    url: 'https://public-app.social-vibecoding.usernodelabs.org',
  });
  assert.match(calls[0].sql, /status = 'running'/);
  assert.match(calls[0].sql, /view_visibility = 'public'/);
  assert.match(calls[0].sql, /self_hosted = FALSE/);
});

test('attribution insert is unique, active-only and excludes self-referrals in SQL', async () => {
  const queries = [];
  const pool = { query: async (sql, values) => {
    queries.push({ sql, values });
    if (sql.startsWith('DELETE')) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [] };
  } };
  assert.equal(await referrals.recordAttributionByCodeId(pool, 4, 9), true);
  const insert = queries.find((q) => q.sql.includes('INSERT INTO referral_attributions'));
  assert.ok(insert);
  assert.match(insert.sql, /owner_user_id <> \$2/);
  assert.match(insert.sql, /revoked_at IS NULL/);
  assert.match(insert.sql, /expires_at > NOW\(\)/);
  assert.match(insert.sql, /ON CONFLICT \(invitee_user_id\) DO NOTHING/);
  assert.deepEqual(insert.values.slice(0, 2), [4, 9]);
});

test('code rotation serializes per owner and revokes the immutable prior row', async () => {
  const queries = [];
  const client = {
    query: async (sql, values) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO referral_codes')) {
        return { rows: [{ id: 22, code: CODE, expires_at: new Date() }] };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => { queries.push({ sql: 'RELEASE' }); },
  };
  const pool = { connect: async () => client };
  const value = await referrals.getOrCreateCode(pool, 17, { rotate: true });
  assert.equal(value.id, 22);
  assert.ok(queries.some((q) => q.sql.includes('pg_advisory_xact_lock')));
  const revoke = queries.find((q) => q.sql.includes('UPDATE referral_codes'));
  assert.ok(revoke);
  assert.match(revoke.sql, /revoked_at = COALESCE/);
  const insert = queries.find((q) => q.sql.includes('INSERT INTO referral_codes'));
  assert.ok(insert);
  assert.doesNotMatch(insert.sql, /ON CONFLICT/);
  assert.ok(queries.some((q) => q.sql === 'COMMIT'));
  assert.equal(queries.at(-1).sql, 'RELEASE');
});

test('opening share reuses a still-live code instead of rotating it', async () => {
  const live = { id: 2, code: CODE, expires_at: new Date(Date.now() + 1000) };
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(sql);
      if (sql.includes('SELECT id, code, expires_at')) return { rows: [live] };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  assert.equal(await referrals.getOrCreateCode({ connect: async () => client }, 4), live);
  assert.equal(queries.some((sql) => sql.includes('INSERT INTO referral_codes')), false);
  assert.equal(queries.some((sql) => sql.includes('UPDATE referral_codes')), false);
});

test('pending cookie is HttpOnly, bounded, SameSite=Lax, and always cleared after consume', async () => {
  let set;
  let cleared;
  const res = {
    cookie: (name, value, options) => { set = { name, value, options }; },
    clearCookie: (name, options) => { cleared = { name, options }; },
  };
  referrals.setPendingCookie(res, CODE);
  assert.equal(set.name, referrals.COOKIE);
  assert.equal(set.options.httpOnly, true);
  assert.equal(set.options.sameSite, 'lax');
  assert.equal(set.options.maxAge, referrals.PENDING_TTL_MS);

  const pool = { query: async (sql) => {
    if (sql.includes('FROM referral_codes')) return { rows: [] };
    return { rows: [], rowCount: 0 };
  } };
  assert.equal(await referrals.consumeCookie(pool, { cookies: { [referrals.COOKIE]: CODE } }, res, 7), false);
  assert.equal(cleared.name, referrals.COOKIE);
  assert.equal(cleared.options.path, '/');
});

test('consent page is explicit, accessible, and never identifies the inviter', () => {
  const html = consentPage(
    { name: '<Public & App>', url: 'https://public-app.example' },
    'signed-token'
  );
  assert.match(html, /Continue with attribution/);
  assert.match(html, /Continue without attribution/);
  assert.match(html, /no access, reward, credits, tokens, or notifications/);
  assert.match(html, /&lt;Public &amp; App&gt;/);
  assert.doesNotMatch(html, /inviter|username|email/i);
  assert.match(html, /method="post" action="\/r\/accept"/);
});

test('schema separates referrals from invites, enforces deletion, retention and staging privacy', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS referral_codes/);
  assert.match(schema, /owner_user_id BIGINT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(schema, /idx_referral_codes_one_active_owner[\s\S]*?WHERE revoked_at IS NULL/);
  assert.match(schema, /COMMENT ON COLUMN referral_codes\.code IS 'staging:private'/);
  assert.match(schema, /COMMENT ON TABLE referral_attributions IS 'staging:private'/);
  assert.match(schema, /COMMENT ON COLUMN waitlist_signups\.referral_code_id IS 'staging:private'/);
  assert.match(schema, /invitee_user_id\s+BIGINT PRIMARY KEY REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(schema, /inviter_user_id\s+BIGINT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(schema, /CHECK \(invitee_user_id <> inviter_user_id\)/);
  assert.match(schema, /waitlist_signups ADD COLUMN IF NOT EXISTS referral_code_id/);
  assert.doesNotMatch(schema.match(/CREATE TABLE IF NOT EXISTS referral_attributions[\s\S]*?\);/)[0], /reward|token_amount|access_grant/);
});

test('share modal keeps plain sharing and makes referral attribution an explicit action', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public/js/app-view.js'), 'utf8');
  assert.match(html, /id="share-referral-btn"[^>]*>Create referral link/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /never grants app access or gives rewards, credits, or tokens/);
  assert.match(js, /view_visibility === 'public'/);
  assert.match(js, /!AppView\.appData\?\.self_hosted/);
  assert.match(js, /body: JSON\.stringify\(\{ appSlug: app\.slug, rotate \}\)/);
});
