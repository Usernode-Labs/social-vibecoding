'use strict';

// The waitlist reminders (src/services/waitlist-reminders.js) against the real
// schema in a throwaway database: who is owed which reminder and when, the
// claim that keeps each to once across two processes, "Send a reminder now",
// the stop link's stamp, an older sign-in link staying good beside a newer
// one, and the template version a real send records. Required when
// TEST_DATABASE_URL is set, skipped when no server is reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const DAY = 24 * 60 * 60 * 1000;

test('who is owed a reminder, the claim, the stop link and the template version, on the real schema',
  { timeout: 180000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
    try { await admin.query('SELECT 1'); } catch (err) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw err;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
    }
    const name = 'waitlist_reminders_' + crypto.randomBytes(6).toString('hex');
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = '/' + name;
    const pool = new Pool({ connectionString: String(url), max: 6 });
    const second = new Pool({ connectionString: String(url), max: 2 });
    const poolPath = require.resolve('../src/db/pool');
    const originalPool = require.cache[poolPath];
    t.after(async () => {
      if (originalPool) require.cache[poolPath] = originalPool;
      else delete require.cache[poolPath];
      await pool.end();
      await second.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    });
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
    // The mailer's bookkeeping finds this database through db/pool.
    require.cache[poolPath] = {
      exports: { getPool: () => pool },
      loaded: true, id: poolPath, filename: poolPath, paths: originalPool ? originalPool.paths : [],
    };
    const reminders = require('../src/services/waitlist-reminders');
    const releaseLinks = require('../src/services/release-links');
    await require('../src/db/email-template-seeds').seedEmailTemplates(pool);

    const sent = [];
    const config = {
      databaseUrl: String(url),
      sessionSecret: 'test-only-secret',
      mailReplyTo: 'support@usernodelabs.org',
      mailTransport: { provider: 'test', send: async (m) => { sent.push(m); } },
      mailStagingLogOnly: false,
    };

    const ago = (days) => new Date(Date.now() - days * DAY);
    let n = 0;
    const signup = async ({ email = `p${++n}@example.test`, released = ago(3), r1 = null, r2 = null, stopped = null,
      linked = null, followed = null, codeAsked = null } = {}) => (await pool.query(
      `INSERT INTO waitlist_signups (email, released_at, reminder_1_sent_at, reminder_2_sent_at, reminders_stopped_at,
                                     linked_user_id, release_link_followed_at, release_code_asked_at, more_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [email, released, r1, r2, stopped, linked, followed, codeAsked, crypto.randomBytes(8).toString('hex')]
    )).rows.map((r) => Number(r.id))[0];
    const user = async (username, email) => (await pool.query(
      "INSERT INTO users (username, password, email, email_confirmed) VALUES ($1, 'x', $2, TRUE) RETURNING id",
      [username, email]
    )).rows[0].id;
    const session = (userId, createdAt, lastSeenAt = null) => pool.query(
      'INSERT INTO sessions (token, user_id, expires_at, created_at, last_seen_at) VALUES ($1, $2, NOW() + INTERVAL \'30 days\', $3, $4)',
      [crypto.randomBytes(32).toString('hex'), userId, createdAt, lastSeenAt]
    );
    const otp = (recipient, at) => pool.query(
      "INSERT INTO mail_deliveries (kind, recipient, status, created_at) VALUES ('otp', $1, 'sent', $2)", [recipient, at]);

    // ── Eligibility and spacing ──
    const owedFirst = await signup({ email: 'owed.first@example.test', released: ago(2.1) });
    const tooSoon = await signup({ released: ago(1.9) });
    const ancient = await signup({ email: 'ancient@example.test', released: ago(90) });
    const notAdmitted = await signup({ released: null });
    const followed = await signup({ followed: ago(1) });
    const coded = await signup({ email: 'coded@example.test' });
    await otp('coded@example.test', ago(1));
    const codedBefore = await signup({ email: 'coded.before@example.test' });
    await otp('coded.before@example.test', ago(5));
    const keptCode = await signup({ codeAsked: ago(2.5) });
    const sessionUser = await user('in_since', 'in.since@example.test');
    const signedIn = await signup({ email: 'in.since@example.test', linked: sessionUser });
    await session(sessionUser, ago(1));
    const oldSessionUser = await user('old_session', 'old.session@example.test');
    const oldSession = await signup({ email: 'old.session@example.test', linked: oldSessionUser });
    await session(oldSessionUser, ago(10));
    const usingUser = await user('still_using', 'still.using@example.test');
    const stillUsing = await signup({ email: 'still.using@example.test', linked: usingUser });
    await session(usingUser, ago(10), ago(0.5));
    const stopped = await signup({ stopped: ago(1) });
    const bounced = await signup({ email: 'bounced@example.test' });
    await pool.query("INSERT INTO mail_suppressions (recipient, reason) VALUES ('bounced@example.test', 'bounce')");
    const phoneUser = await user('phone_only', null);
    const phone = (await pool.query(
      'INSERT INTO waitlist_signups (email, released_at, linked_user_id) VALUES (NULL, $1, $2) RETURNING id', [ago(5), phoneUser])).rows.map((r) => Number(r.id))[0];
    const testRelease = await signup();
    await pool.query('INSERT INTO test_waitlist_releases (signup_id) VALUES ($1)', [testRelease]);
    // The last: six days after the admit AND four after the first.
    const lastOwed = await signup({ released: ago(7), r1: ago(4.1) });
    const lastGap = await signup({ released: ago(7), r1: ago(3.9) });
    const lastEarly = await signup({ released: ago(5.9), r1: ago(4.5) });
    const lastOld = await signup({ released: ago(60), r1: ago(4.01) });
    const both = await signup({ released: ago(30), r1: ago(20), r2: ago(10) });

    const owed = await pool.query(reminders.OWED_SQL.replace('LIMIT $1', 'LIMIT 1000'));
    const by = new Map(owed.rows.map((r) => [Number(r.id), Number(r.reminder)]));
    assert.equal(by.get(owedFirst), 1, 'two days after the admit');
    assert.equal(by.get(ancient), 1, 'no age limit: an old admit gets its first now');
    assert.equal(by.get(codedBefore), 1, 'a code asked for before the admit is not a sign-in since');
    assert.equal(by.get(oldSession), 1, 'a session from before the admit, unused since, is not either');
    assert.equal(by.get(lastOwed), 2);
    assert.equal(by.get(lastOld), 2);
    for (const [id, why] of [
      [tooSoon, 'under two days'], [notAdmitted, 'not admitted'], [followed, 'followed its link'],
      [coded, 'asked for a code since'], [keptCode, 'a code kept by the sweep'], [signedIn, 'a session since'],
      [stillUsing, 'a session used since'], [stopped, 'stopped them'], [bounced, 'a bounced address'],
      [phone, 'no email'], [testRelease, 'a test release'], [lastGap, 'under four days after the first'],
      [lastEarly, 'under six days after the admit'], [both, 'had both'],
    ]) assert.ok(!by.has(Number(id)), why);
    assert.deepEqual(owed.rows.map((r) => Number(r.id)).slice(0, 2), [ancient, lastOld], 'oldest admit first');

    // ── Dry run, the default: the clock counts them and sends none, and the
    // list shows exactly what On would send. Then On. ──
    const reminderSetting = require('../src/services/release-mail-setting');
    assert.equal(await reminderSetting.reminderMode(pool), 'dry_run', 'no row: dry run');
    const dry = await reminders.owedTargets(config, pool);
    assert.equal(dry.off, 'dry_run');
    assert.deepEqual(dry.items, []);
    assert.equal(dry.owed, by.size);
    const due = await reminders.dueNow(pool);
    assert.equal(due.first + due.last, by.size, 'the list counts what the clock owes');
    assert.equal(due.last, [...by.values()].filter((r) => r === 2).length);
    assert.deepEqual(due.rows.slice(0, 2).map((r) => [r.id, r.reminder]), [[ancient, 1], [lastOld, 2]], 'oldest admit first, as the clock');
    assert.ok(due.rows.every((r) => typeof r.email === 'string' && r.released_at), 'each row says who and when');
    assert.deepEqual(await reminders.remindItem(config, pool, { signupId: ancient, reminder: 1 }), { said: 'off' }, 'a dry run item sends nothing');
    await reminderSetting.setReminderMail(pool, { mode: 'on' });

    const listed = await reminders.owedTargets(config, pool);
    assert.equal(listed.items.length, Math.min(reminders.PER_RUN, by.size));
    assert.equal(listed.items[0].target, `waitlist-reminder:${ancient}:1`);

    // ── The claim: once, even from two processes ──
    const claims = await Promise.all([
      reminders.claim(pool, owedFirst, 1), reminders.claim(second, owedFirst, 1),
      reminders.claim(pool, owedFirst, 1), reminders.claim(second, owedFirst, 1),
    ]);
    assert.equal(claims.filter(Boolean).length, 1, 'exactly one claim wins');
    const winner = claims.find(Boolean);
    assert.equal(winner.email, 'owed.first@example.test');
    assert.equal(winner.has_account, false);
    assert.equal(await reminders.claim(pool, owedFirst, 1), null);
    assert.equal(await reminders.claim(pool, owedFirst, 2), null, 'the last is not due yet');
    assert.equal(await reminders.claim(pool, tooSoon, 1), null, 'not due');
    assert.ok(await reminders.claim(pool, tooSoon, 1, { manual: true }), 'an admin skips the spacing');
    assert.equal(await reminders.claim(pool, stopped, 1, { manual: true }), null, 'but never the other rules');

    // ── A clock item: the reminder goes, stamped, with its own sign-in link ──
    const said = await reminders.remindItem(config, pool, { signupId: ancient, reminder: 1 });
    assert.deepEqual(said, { said: 'sent' });
    assert.equal(sent.length, 1);
    const mail = sent[0];
    assert.equal(mail.kind, 'waitlist_reminder');
    assert.equal(mail.to, 'ancient@example.test');
    const key = new URL(mail.url).searchParams.get('key');
    assert.match(key, releaseLinks.TOKEN_RE);
    const { rows: [stamp] } = await pool.query('SELECT reminder_1_sent_at FROM waitlist_signups WHERE id = $1', [ancient]);
    assert.ok(stamp.reminder_1_sent_at);
    assert.deepEqual(await reminders.remindItem(config, pool, { signupId: ancient, reminder: 1 }), { said: 'settled' });
    assert.equal(sent.length, 1, 'never the same one twice');

    // ── The template version on its delivery row ──
    const { rows: [delivery] } = await pool.query(
      "SELECT status, template_version, template_digest FROM mail_deliveries WHERE kind = 'waitlist_reminder' AND recipient = 'ancient@example.test'");
    assert.equal(delivery.status, 'sent');
    assert.equal(delivery.template_version, 1, 'the seeded template\'s version');
    assert.match(delivery.template_digest, /^[0-9a-f]{16}$/);

    // ── Older links stay good: the admit mail's, beside the reminder's ──
    const earlier = await releaseLinks.mintLink(pool, { signupId: lastOwed, email: (await pool.query('SELECT email FROM waitlist_signups WHERE id = $1', [lastOwed])).rows[0].email });
    await reminders.remindItem(config, pool, { signupId: lastOwed, reminder: 2 });
    const { rows: links } = await pool.query(
      'SELECT token_hash, consumed_at, expires_at FROM waitlist_release_links WHERE signup_id = $1 ORDER BY created_at', [lastOwed]);
    assert.equal(links.length, 2, 'minting kept the older unspent link');
    assert.equal(links[0].token_hash, releaseLinks.hashToken(earlier.token));
    assert.ok(new Date(links[0].expires_at) > new Date(), 'still good until its own expiry');
    assert.equal(sent.at(-1).kind, 'waitlist_reminder_last');
    assert.equal(sent.at(-1).replyTo, 'support@usernodelabs.org', 'the last one\'s replies reach a person');
    assert.ok(new Date(earlier.expiresAt) - Date.now() > 6.9 * DAY);

    // ── A refused send gives its claim back ──
    const budget = await signup({ email: 'budget@example.test', released: ago(3) });
    for (let i = 0; i < 60; i += 1) {
      await pool.query("INSERT INTO mail_deliveries (kind, recipient, status) VALUES ('waitlist_reminder', $1, 'sent')", [`x${i}@example.test`]);
    }
    assert.deepEqual(await reminders.remindItem(config, pool, { signupId: budget, reminder: 1 }), { said: 'suppressed_rate_limit' });
    const { rows: [given] } = await pool.query('SELECT reminder_1_sent_at FROM waitlist_signups WHERE id = $1', [budget]);
    assert.equal(given.reminder_1_sent_at, null, 'owed again');
    await pool.query("DELETE FROM mail_deliveries WHERE kind = 'waitlist_reminder' AND recipient LIKE 'x%@example.test'");

    // ── Send a reminder now ──
    await assert.rejects(reminders.remindNow(config, pool, signedIn), { code: 'signed_in' });
    await assert.rejects(reminders.remindNow(config, pool, stopped), { code: 'stopped' });
    await assert.rejects(reminders.remindNow(config, pool, both), { code: 'had_both' });
    await assert.rejects(reminders.remindNow(config, pool, notAdmitted), { code: 'not_admitted' });
    await assert.rejects(reminders.remindNow(config, pool, testRelease), { code: 'not_found' });
    await assert.rejects(reminders.remindNow(config, pool, bounced), { code: 'suppressed' });
    const now = await reminders.remindNow(config, pool, lastGap);
    assert.deepEqual(now, { reminder: 2, kind: 'waitlist_reminder_last', status: 'sent', error: null, owed_again: false }, 'the next one, whatever the spacing');
    await assert.rejects(reminders.remindNow(config, pool, lastGap), { code: 'had_both' });
    const account = await reminders.remindNow(config, pool, oldSession);
    assert.equal(account.reminder, 1);
    assert.equal(sent.at(-1).url, 'https://app.onhomeroom.com/?login=1', 'an account gets the sign-in form');

    // ── The stop link ──
    const stopRow = (await pool.query('SELECT id, email FROM waitlist_signups WHERE id = $1', [codedBefore])).rows[0];
    const token = reminders.stopToken(stopRow.id, stopRow.email, config.sessionSecret);
    assert.equal(await reminders.stop(config, pool, { signupId: codedBefore, token: 'x'.repeat(32) }), false);
    assert.equal(await reminders.stop(config, pool, { signupId: codedBefore, token }), true);
    const { rows: [after] } = await pool.query('SELECT reminders_stopped_at FROM waitlist_signups WHERE id = $1', [codedBefore]);
    assert.ok(after.reminders_stopped_at);
    const again = await pool.query(reminders.OWED_SQL.replace('LIMIT $1', 'LIMIT 1000'));
    assert.ok(!again.rows.some((r) => Number(r.id) === codedBefore), 'stopped: owed nothing');
    await pool.query("UPDATE waitlist_signups SET email = 'moved@example.test' WHERE id = $1", [codedBefore]);
    assert.equal(await reminders.stopLinkWorks(config, pool, { signupId: codedBefore, token }), false, 'bound to the address');

    // ── Off and Dry run stop the clock, and only the clock ──
    await require('../src/services/release-mail-setting').setReminderMail(pool, { mode: 'off' });
    assert.deepEqual(await reminders.owedTargets(config, pool), { off: 'switched_off', items: [] });
    await require('../src/services/release-mail-setting').setReminderMail(pool, { mode: 'dry_run' });
    assert.deepEqual((await reminders.owedTargets(config, pool)).items, []);
    assert.equal(await require('../src/services/release-mail-setting').releaseMailEnabled(pool), true, 'the release email is its own switch');
  });
