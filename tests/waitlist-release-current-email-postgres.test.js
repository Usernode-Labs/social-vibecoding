'use strict';

// #6480: the "you're in" mail's RECIPIENT is the account's current address.
//
// A waitlist row keeps the address it was joined with, and an account may
// change its address afterwards (Settings). The release therefore answers
// `recipient_email` — the linked account's confirmed address, read at release
// time — separately from the row's own `email`, and never falls back to the
// row's old address when the account has none confirmed. A row with no
// account keeps its own address. Against the full schema: skipped when no
// server is reachable, required when TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a release mails the account\'s current address', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'waitlist_current_email_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const waitlist = require('../src/services/waitlist');

  let seq = 0;
  async function account({ email, confirmed = true } = {}) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, email, email_confirmed)
       VALUES ($1, 'x', FALSE, $2::varchar, $2::varchar IS NOT NULL AND $3::boolean)
       RETURNING id`,
      [`person_${n}`, email, confirmed]
    );
    return rows[0].id;
  }
  async function signup({ email = null, linkedUserId = null } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO waitlist_signups (email, linked_user_id, confirmed_at)
       VALUES ($1, $2, NOW()) RETURNING id`,
      [email, linkedUserId]
    );
    return rows[0].id;
  }
  const access = async (id) => (await pool.query(
    'SELECT has_platform_access FROM users WHERE id = $1', [id])).rows[0].has_platform_access;
  const rowEmail = async (id) => (await pool.query(
    'SELECT email FROM waitlist_signups WHERE id = $1', [id])).rows[0].email;

  // ── A changed, confirmed address is the recipient ─────────────────────
  {
    const userId = await account({ email: 'old@example.invalid' });
    const signupId = await signup({ email: 'old@example.invalid', linkedUserId: userId });
    await pool.query(
      'UPDATE users SET email = $2, email_confirmed = TRUE WHERE id = $1',
      [userId, 'new@example.invalid']
    );

    const released = await waitlist.releaseWaitlistSignup(pool, signupId);
    assert.equal(released.recipient_email, 'new@example.invalid');
    assert.equal(released.email, 'old@example.invalid', 'the row field stays as it was');
    assert.equal(await rowEmail(signupId), 'old@example.invalid', 'the row itself is not rewritten');
    assert.equal(await access(userId), true, 'the release still lets them in');
  }

  // ── An unconfirmed or cleared address mails nothing at the old one ────
  {
    const userId = await account({ email: 'old-unconfirmed@example.invalid' });
    const signupId = await signup({ email: 'old-unconfirmed@example.invalid', linkedUserId: userId });
    await pool.query(
      'UPDATE users SET email = $2, email_confirmed = FALSE WHERE id = $1',
      [userId, 'new-unconfirmed@example.invalid']
    );

    const released = await waitlist.releaseWaitlistSignup(pool, signupId);
    assert.equal(released.recipient_email, null, 'no fallback to the row\'s old address');
    assert.equal(await access(userId), true);

    const clearedId = await account({ email: 'cleared@example.invalid' });
    const clearedSignup = await signup({ email: 'cleared@example.invalid', linkedUserId: clearedId });
    await pool.query(
      'UPDATE users SET email = NULL, email_confirmed = FALSE WHERE id = $1',
      [clearedId]
    );
    const cleared = await waitlist.releaseWaitlistSignup(pool, clearedSignup);
    assert.equal(cleared.recipient_email, null);
    assert.equal(await access(clearedId), true);
  }

  // ── A row with no account keeps its own address ───────────────────────
  {
    const signupId = await signup({ email: 'only-by-email@example.invalid' });
    const released = await waitlist.releaseWaitlistSignup(pool, signupId);
    assert.equal(released.recipient_email, 'only-by-email@example.invalid');
    assert.equal(released.linked_user_id, null);
  }

  // ── A direct grant follows the same rule ──────────────────────────────
  {
    const userId = await account({ email: 'grant-old@example.invalid' });
    await signup({ email: 'grant-old@example.invalid', linkedUserId: userId });
    await pool.query(
      'UPDATE users SET email = $2, email_confirmed = TRUE WHERE id = $1',
      [userId, 'grant-new@example.invalid']
    );
    const release = await waitlist.releaseRowsForGrant(pool, userId);
    assert.equal(release.recipient_email, 'grant-new@example.invalid');

    const noConfirm = await account({ email: 'grant-unconfirmed@example.invalid', confirmed: false });
    await signup({ email: 'grant-unconfirmed@example.invalid', linkedUserId: noConfirm });
    const none = await waitlist.releaseRowsForGrant(pool, noConfirm);
    assert.equal(none.recipient_email, null, 'never the row\'s address');
  }
});
