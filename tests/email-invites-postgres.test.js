'use strict';

// Invites into a project by EMAIL (src/services/email-invites.js), against
// the REAL schema in a throwaway PostgreSQL database: an address that waits
// in app_email_invites turns into an ordinary pending collaborator invite
// the moment it is confirmed on an account, once, and never for an address
// nobody confirmed. Skipped when no server is reachable, required when
// TEST_DATABASE_URL is set, like tests/create-audience-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('a waiting email invite becomes a project invite when its address is confirmed', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'email_invites_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  await pool.query(read('src/db/schema.sql'));
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  require('../src/services/ws').pushNotificationToUser = () => {};
  require('../src/services/events').record = async () => {};
  const mailed = [];
  require('../src/services/mail').sendProjectInviteMail = async (_config, email) => { mailed.push(email); };
  const emailInvites = require('../src/services/email-invites');

  const { rows: people } = await pool.query(
    `INSERT INTO users (username, password) VALUES ('maker', 'x'), ('newcomer', 'x') RETURNING id, username`
  );
  const [maker, newcomer] = people;
  const { rows: apps } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, status) VALUES ('Book club', 'book-club', $1, 'running') RETURNING id, slug, name`,
    [maker.id]
  );
  const app = apps[0];

  await t.test('an address nobody has is stored once and mailed once', async () => {
    const first = await emailInvites.inviteByEmail(pool, {}, { app, emails: ['Sam@Example.com'], inviter: maker });
    const again = await emailInvites.inviteByEmail(pool, {}, { app, emails: ['sam@example.com'], inviter: maker });
    assert.deepEqual([first, again], [{ invited: 0, mailed: 1 }, { invited: 0, mailed: 0 }]);
    assert.deepEqual(mailed, ['sam@example.com']);
  });

  await t.test('confirming the address on an account turns it into a pending invite, once', async () => {
    const claimed = await emailInvites.claimEmailInvites(pool, { userId: newcomer.id, email: 'SAM@example.com' });
    assert.equal(claimed, 1);
    const collab = await pool.query('SELECT status, invited_by FROM app_collaborators WHERE app_id = $1 AND user_id = $2', [app.id, newcomer.id]);
    assert.deepEqual(collab.rows, [{ status: 'invited', invited_by: maker.id }]);
    const row = await pool.query('SELECT claimed_by, claimed_at IS NOT NULL AS claimed FROM app_email_invites WHERE app_id = $1', [app.id]);
    assert.deepEqual(row.rows, [{ claimed_by: newcomer.id, claimed: true }]);
    assert.equal(await emailInvites.claimEmailInvites(pool, { userId: newcomer.id, email: 'sam@example.com' }), 0, 'never twice');
    assert.equal(await emailInvites.claimEmailInvites(pool, { userId: newcomer.id, email: 'other@example.com' }), 0);
  });

  await t.test('your own confirmed address invites nobody', async () => {
    await pool.query(`UPDATE users SET email = 'maker@example.com', email_confirmed = TRUE WHERE id = $1`, [maker.id]);
    const own = await emailInvites.inviteByEmail(pool, {}, { app, emails: ['maker@example.com'], inviter: maker });
    assert.deepEqual(own, { invited: 0, mailed: 0 });
  });

  await t.test('both places an address is confirmed claim what waits on it, and deletion removes it', () => {
    assert.match(read('src/services/email-signup.js'),
      /if \(result\.next === 'set-password'\) \{\s*await require\('\.\/email-invites'\)\.claimEmailInvites\(pool, \{ userId: result\.userId, email \}\);/);
    assert.match(read('src/services/account-email.js'),
      /await require\('\.\/email-invites'\)\.claimEmailInvites\(pool, \{ userId, email: result\.email \}\);/);
    const deletion = read('src/services/account-deletion.js');
    assert.match(deletion, /'app_email_invites'\]\)/, 'invites waiting on the deleted person’s confirmed address');
    assert.match(deletion, /DELETE FROM app_email_invites WHERE invited_by = \$1 AND claimed_at IS NULL/, 'and the ones they typed');
    assert.match(read('src/db/schema.sql'), /COMMENT ON TABLE app_email_invites IS 'staging:private';/, 'addresses are not copied to staging');
  });
});
