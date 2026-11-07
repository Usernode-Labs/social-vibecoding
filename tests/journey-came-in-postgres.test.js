'use strict';

// Admin › Journey: how people came in, against the real schema in a
// throwaway database (required when TEST_DATABASE_URL is set, skipped when no
// server is reachable). The waitlist row's facts, the "You're in" mail's own
// page, which send led in, how the account signed up, and the "Invited, not
// let in yet" cohort. The pure rules are pinned in
// tests/journey-came-in.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const journey = require('../src/services/journey');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('how they came in, and the people invited and not let in yet',
  { timeout: 120000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
    try { await admin.query('SELECT 1'); } catch (err) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw err;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
    }
    const name = 'journey_came_in_' + crypto.randomBytes(6).toString('hex');
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = '/' + name;
    const pool = new Pool({ connectionString: String(url), max: 4 });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    });
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

    const D = '2026-11-02';
    const at = (time) => `${D}T${time}Z`;
    const now = new Date('2026-11-05T12:00:00Z');
    const user = async (username, cols = {}) => {
      const base = { has_platform_access: true, password_set: false, needs_username_choice: false,
        needs_communities_choice: false, ...cols };
      const keys = Object.keys(base);
      const { rows } = await pool.query(
        `INSERT INTO users (username, password, ${keys.join(', ')})
         VALUES ($1, 'x', ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
        [username, ...keys.map((k) => base[k])]
      );
      return rows[0].id;
    };
    const signup = (cols) => {
      const keys = Object.keys(cols);
      return pool.query(
        `INSERT INTO waitlist_signups (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        keys.map((k) => cols[k]));
    };
    const mail = (kind, recipient, createdAt) => pool.query(
      "INSERT INTO mail_deliveries (kind, recipient, status, created_at) VALUES ($1, $2, 'sent', $3)",
      [kind, recipient, createdAt]);
    const phone = (userId, createdAt, n) => pool.query(
      'INSERT INTO user_phone_identities (user_id, firebase_uid, phone_e164, created_at) VALUES ($1, $2, $3, $4)',
      [userId, `uid-${n}`, `+1555000${String(n).padStart(4, '0')}`, createdAt]);

    // pia: joined from the waitlist page, answered the follow-up, let in,
    // mailed twice, opened the mail's page and signed in by its link.
    const pia = await user('pia', { email: 'pia@example.test', created_at: at('10:00:00'),
      platform_access_granted_at: at('09:00:00') });
    await signup({ email: 'pia@example.test', submitted_at: '2026-10-01T12:00:00Z', source: 'form',
      answers: JSON.stringify({ discovery: { source: 'friend' }, made_url: 'https://example.test' }),
      released_at: at('09:00:00'), linked_user_id: pia, release_link_followed_at: at('10:00:00'),
      release_page_opened_at: at('09:58:00'), release_page_outcome: 'signed_in' });
    await mail('waitlist_released', 'pia@example.test', at('09:00:05'));
    await mail('waitlist_released', 'pia@example.test', at('09:30:00'));
    // quinn: from a partner's form, let in later, never opened the page,
    // signed up by phone.
    const quinn = await user('quinn', { email: 'quinn@example.test', created_at: at('13:00:00'),
      platform_access_granted_at: at('12:00:00') });
    await signup({ email: 'quinn@example.test', submitted_at: '2026-10-20T12:00:00Z', source: 'partner:landing',
      released_at: at('12:00:00'), linked_user_id: quinn });
    await mail('waitlist_released', 'quinn@example.test', at('12:00:05'));
    await phone(quinn, at('13:00:30'), 1);
    // rae: had an account before she was let in, so her mail opens plain
    // sign-in and its page says nothing.
    const rae = await user('rae', { email: 'rae@example.test', created_at: '2026-10-01T09:00:00Z',
      password_set: true, platform_access_granted_at: at('14:00:00') });
    await signup({ email: 'rae@example.test', submitted_at: '2026-10-01T09:00:00Z', source: 'account',
      released_at: at('14:00:00'), linked_user_id: rae });
    await mail('waitlist_released', 'rae@example.test', at('14:00:05'));

    const mile = await journey.firstMile(pool, { day: D, now, leftOutIds: [] });
    const by = Object.fromEntries(mile.people.map((p) => [p.name, p]));
    assert.deepEqual(Object.keys(by).sort(), ['pia', 'quinn', 'rae']);
    const page = (p) => p.steps.find((s) => s.key === 'mail_page');

    assert.equal(by.pia.signupMethod, 'mail_link');
    assert.deepEqual(by.pia.waitlist, {
      joinedAt: new Date('2026-10-01T12:00:00Z'), waitedDays: 31, source: 'form', discovery: 'friend',
      answeredFollowUp: true, referred: false, projectInvite: false,
    });
    assert.deepEqual([page(by.pia).state, page(by.pia).note], ['done', 'signed in']);
    assert.deepEqual(by.pia.mailPage, { at: new Date(at('09:58:00')), outcome: 'signed_in' });
    assert.equal(by.pia.fromEmail, 2, 'the second send led in');

    assert.equal(by.quinn.signupMethod, 'phone');
    assert.equal(by.quinn.waitlist.source, 'partner:landing');
    assert.equal(by.quinn.waitlist.answeredFollowUp, false);
    assert.equal(page(by.quinn).state, 'skipped', 'never opened, but signed up another way: behind them');
    assert.equal(by.quinn.mailPage, null);

    assert.equal(by.rae.signupMethod, 'password');
    assert.deepEqual([page(by.rae).state, page(by.rae).note], ['unknown', 'Had an account: the mail opens sign-in']);
    const counts = mile.steps.find((s) => s.key === 'mail_page');
    assert.deepEqual([counts.passed, counts.unrecorded, counts.stuck.length], [2, 1, 0]);

    // The invited cohort: sol joined a project by its link and is not let in;
    // tai waits on the link for access; uma's was cancelled; vic was let in
    // after joining and is in no cohort here.
    const host = await user('host', { platform_access_granted_at: '2026-06-01T00:00:00Z' });
    const { rows: [app] } = await pool.query(
      "INSERT INTO apps (name, slug, created_by, status) VALUES ('Space Shooter', 'space-shooter', $1, 'running') RETURNING id",
      [host]);
    const { rows: [invite] } = await pool.query(
      `INSERT INTO community_invites (token, community_id, app_id, created_by, expires_at)
       VALUES ('tok_came_in_0001', (SELECT community_id FROM apps WHERE id = $1), $1, $2, NOW() + INTERVAL '30 days')
       RETURNING id`,
      [app.id, host]);
    const redeem = (userId, status, createdAt, appliedAt = null) => pool.query(
      `INSERT INTO community_invite_redemptions (invite_id, user_id, status, created_at, applied_at)
       VALUES ($1, $2, $3, $4, $5)`, [invite.id, userId, status, createdAt, appliedAt]);
    const noInvitedAccess = { has_platform_access: false };
    const sol = await user('sol', { ...noInvitedAccess, created_at: at('15:00:00') });
    await phone(sol, at('15:00:10'), 2);
    await redeem(sol, 'joined', at('15:00:00'), at('15:00:05'));
    await pool.query(
      `INSERT INTO community_invite_opens (maker_id, app_id, user_id, browser, opened_at)
       VALUES ($1, $2, $3, 'b-sol', $4)`, [host, app.id, sol, at('14:59:00')]);
    await pool.query(
      `INSERT INTO events (user_id, event_type, metadata, created_at)
       VALUES ($1, 'invite_signed_in', jsonb_build_object('inviteId', $2::text, 'how', 'signed_up'), $3)`,
      [sol, invite.id, at('15:00:00')]);
    const tai = await user('tai', { ...noInvitedAccess, created_at: at('16:00:00') });
    await redeem(tai, 'queued', at('16:00:00'));
    const uma = await user('uma', { ...noInvitedAccess, created_at: at('17:00:00') });
    await redeem(uma, 'cancelled', at('17:00:00'));
    const vic = await user('vic', { platform_access_granted_at: at('19:00:00'), created_at: at('18:00:00') });
    await redeem(vic, 'joined', at('18:00:00'), at('18:00:05'));

    const list = await journey.cohorts(pool, { now, leftOutIds: [] });
    assert.deepEqual(list.invited, { people: 2 });

    const invited = await journey.firstMile(pool, { day: 'invited', now, leftOutIds: [] });
    assert.deepEqual(invited.people.map((p) => p.name), ['sol', 'tai']);
    const [s, ta] = invited.people;
    assert.equal(s.door, 'invite_link');
    assert.deepEqual(s.steps.map((x) => [x.key, x.state]), [
      ['invite_opened', 'done'], ['signed_up', 'done'], ['joined', 'done'],
      ['opened', 'stuck'], ['first_act', 'not_yet'], ['let_in', 'not_yet'],
    ]);
    assert.equal(s.steps[1].note, 'from the invite');
    assert.equal(s.signupMethod, 'phone');
    assert.deepEqual(s.invite, {
      by: 'host', project: 'Space Shooter', slug: 'space-shooter', openedAt: new Date(at('14:59:00')),
      how: 'signed_up', status: 'joined',
    });
    assert.equal(ta.steps[0].state, 'unknown', 'no open seen in the browser they signed up in');
    assert.equal(ta.stuckAt, 'joined');
    assert.equal(ta.stuckReason, 'Waiting for access to join');
    assert.deepEqual(invited.steps.map((x) => x.key), journey.INVITED_MILE_STEPS);

    const solPerson = await journey.person(pool, { userId: sol, now });
    assert.equal(solPerson.cohort, 'invited');
    assert.equal(solPerson.cameIn.door, 'invite_link');
    assert.equal(solPerson.cameIn.invite.project, 'Space Shooter');
    const piaPerson = await journey.person(pool, { userId: pia, now });
    assert.equal(piaPerson.cameIn.door, 'admitted');
    assert.equal(piaPerson.cameIn.signupMethod, 'mail_link');
    assert.equal(piaPerson.cameIn.waitlist.source, 'form');
  });
