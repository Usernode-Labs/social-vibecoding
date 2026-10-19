'use strict';

// The admit mail's first-mile facts outlive the mail log's 30 days
// (services/mail/index.js pruneDeliveries, the waitlist row's release_*
// columns in schema.sql), and the mail's one-time sign-in link counts as
// the mail followed and clicked (services/release-links.js, journey.js
// followedMail). Against the real schema in a throwaway database: required
// when TEST_DATABASE_URL is set, skipped when no server is reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const journey = require('../src/services/journey');
const mail = require('../src/services/mail');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the sweep keeps the admit mail on the waitlist row, and the first mile reads it after the log is gone',
  { timeout: 120000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
    try { await admin.query('SELECT 1'); } catch (err) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw err;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
    }
    const name = 'journey_mail_kept_' + crypto.randomBytes(6).toString('hex');
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = '/' + name;
    const pool = new Pool({ connectionString: String(url), max: 4 });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    });
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

    // Admitted 40 days ago: everything in the log about them is past its 30.
    const day = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
    const admitAt = new Date(`${day}T09:00:00Z`);
    const at = (minutes) => new Date(admitAt.getTime() + minutes * 60000).toISOString();
    const signup = async (email, cols = {}) => {
      const { rows: [row] } = await pool.query(
        `INSERT INTO waitlist_signups (email, released_at, release_link_followed_at)
         VALUES ($1, $2, $3) RETURNING id`, [email, cols.released === false ? null : admitAt, cols.followed || null]);
      return row.id;
    };
    const delivery = async (kind, recipient, minutes, { status = 'sent', tracked = false } = {}) => {
      const { rows: [row] } = await pool.query(
        `INSERT INTO mail_deliveries (kind, recipient, status, created_at, engagement_tracked, message_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [kind, recipient, status, at(minutes), tracked, crypto.randomBytes(24).toString('hex')]);
      return row.id;
    };
    const engagement = (deliveryId, type, minutes, ua = 'unknown_client') => pool.query(
      'INSERT INTO mail_events (delivery_id, type, user_agent_class, created_at) VALUES ($1, $2, $3, $4)',
      [deliveryId, type, ua, at(minutes)]);

    // kim: tracked admit mail; a scanner's open before her own, then a
    // followed link; a code before the admit (not counted) and one after.
    const kim = await signup('kim@example.test');
    const kimMail = await delivery('waitlist_released', 'kim@example.test', 0, { tracked: true });
    await engagement(kimMail, 'opened', 1, 'scanner_or_prefetch');
    await engagement(kimMail, 'opened', 30);
    await engagement(kimMail, 'clicked', 31);
    await delivery('otp', 'kim@example.test', -60);
    await delivery('otp', 'kim@example.test', 32);
    // lou: an untracked admit mail, never followed.
    const lou = await signup('lou@example.test');
    await delivery('waitlist_released', 'lou@example.test', 0);
    // max: tracked, no open seen, but the one-time link was spent: the mail
    // was followed and clicked, whatever its pixel saw.
    const max = await signup('max@example.test', { followed: at(45) });
    await delivery('waitlist_released', 'max@example.test', 0, { tracked: true });
    // not released: its codes are nothing to keep.
    const waiting = await signup('waiting@example.test', { released: false });
    await delivery('otp', 'waiting@example.test', 10);
    // a newer delivery, inside the 30 days, stays in the log.
    const recent = await pool.query(
      `INSERT INTO mail_deliveries (kind, recipient, status, created_at) VALUES ('otp', 'kim@example.test', 'sent', NOW())
       RETURNING id`);

    const before = await journey.firstMile(pool, { day });
    const read = (mile) => Object.fromEntries(mile.people.map((p) => [p.name, p]));
    const live = read(before);

    assert.equal(await mail.pruneDeliveries(pool), 6, 'every delivery past 30 days goes');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM mail_events')).rows[0].n, 0, 'and its events with it');
    assert.deepEqual((await pool.query('SELECT id FROM mail_deliveries')).rows.map((r) => r.id), [recent.rows[0].id]);

    const kept = Object.fromEntries((await pool.query(
      `SELECT id, release_mail_sent_at, release_mail_tracked, release_mail_opened_at, release_mail_clicked_at,
              release_code_asked_at, release_link_followed_at FROM waitlist_signups`)).rows.map((r) => [r.id, r]));
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    assert.deepEqual([iso(kept[kim].release_mail_sent_at), kept[kim].release_mail_tracked,
      iso(kept[kim].release_mail_opened_at), iso(kept[kim].release_mail_clicked_at), iso(kept[kim].release_code_asked_at)],
    [at(0), true, at(30), at(31), at(32)], 'the first send, open, click and code after the admit; never the scanner\'s open');
    assert.deepEqual([iso(kept[lou].release_mail_sent_at), kept[lou].release_mail_tracked, kept[lou].release_mail_opened_at],
      [at(0), false, null], 'an untracked mail is kept as untracked');
    assert.equal(iso(kept[max].release_link_followed_at), at(45), 'the link\'s spend is untouched');
    assert.deepEqual([kept[waiting].release_mail_sent_at, kept[waiting].release_code_asked_at, kept[waiting].release_mail_tracked],
      [null, null, null], 'a row not released keeps nothing');

    // The first mile reads the same from the row as it read from the log.
    const after = read(await journey.firstMile(pool, { day }));
    for (const who of ['kim@example.test', 'lou@example.test', 'max@example.test']) {
      assert.deepEqual(after[who].mail, live[who].mail, `${who}: the same mail reading`);
      assert.deepEqual(after[who].steps.slice(0, 3).map((st) => [st.key, st.state, st.note]),
        live[who].steps.slice(0, 3).map((st) => [st.key, st.state, st.note]), `${who}: the same first steps`);
    }
    assert.deepEqual(after['kim@example.test'].mail, { opened: true, clicked: true });
    assert.deepEqual(after['kim@example.test'].steps.slice(1, 3).map((st) => [st.state, st.note]),
      [['done', 'clicked the link'], ['done', 'a sign-in code']]);
    assert.equal(after['lou@example.test'].mail, null, 'not tracked is a gap, not "no open"');
    assert.equal(after['lou@example.test'].stuckAt, 'code_asked');
    assert.equal(after['lou@example.test'].stuckReason, 'Admitted, never followed the mail');
    assert.deepEqual(after['max@example.test'].mail, { opened: true, clicked: true }, 'a spent link is a click');
    assert.deepEqual(after['max@example.test'].steps[2].note, 'its sign-in link');

    // A second sweep finds nothing past 30 days and changes nothing kept,
    // and a later fact never moves an earlier one.
    await pool.query("UPDATE mail_deliveries SET created_at = NOW() - INTERVAL '31 days'");
    assert.equal(await mail.pruneDeliveries(pool), 1);
    const again = (await pool.query('SELECT release_code_asked_at FROM waitlist_signups WHERE id = $1', [kim])).rows[0];
    assert.equal(iso(again.release_code_asked_at), at(32), 'the earliest code stands');
  });
