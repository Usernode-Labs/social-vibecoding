'use strict';

// The bell after a change is decided, against the full schema (5 October,
// Page Turners). In that run-through Mo opened his bell 36 minutes after the
// first version went live and it still said "Ready to try" about it, unread,
// beside "Waiting for your approval · 1 change"; and Alex's bell called
// Priya's first message, a request Homeroom bot filed, "Said hi".
//
//   - settleDecidedChange: live or closed, every ask and "ready to try"
//     about the change is read; digests it was the last one waiting in are
//     read; everyone touched hears it. #4795: on a merge the asks leave the
//     list as well (listForUser hides them for a merged change, and
//     countUnread leaves them out). #5487: the rows that say it went live —
//     pr_merged to the author, voted_change_merged to the voters — leave the
//     list too, unread or read (MERGED_HIDDEN_KINDS): they only ever opened
//     a merged page, and the phone push announced the merge.
//     Nothing is re-opened unread: the news rides its own rows.
//     #5482: the remaining kinds that name a change are not asks, but
//     tapping one hours later only opens the merged page, so they leave the
//     list on a merge too (proposal_vote, check_failed, session_done,
//     session_stalled, auto_solve_done, connector_submitted, spec_shared),
//     while a row with no change behind it and a message people wrote stay.
//     A closed change keeps every row.
//   - The bell reads the change's status, a digest's live count and the
//     request a first message became, with the row (listForUser, getForUser).
//   - #4778: a decided change's asks (the vote nudge, the re-confirm ask, a
//     going-quiet warning, a digest of one) are settled live off the change's
//     status even when settleDecidedChange never ran. On a merge they leave
//     the list and stop counting with or without the settle, and read as
//     read when one is opened from a push; on a close they stay listed,
//     shown read. Its "ready to try" row still waits for the settle; a
//     change still up for approval asks as before.
//   - homeroom-bot-chat record() pushes the maker's row again once the first
//     message is filed, and the rest of a small group's discussion rows
//     about a message once it is filed (Mo's, the same day).
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/bell-live-ready-saidhi-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const notifications = require('../src/services/notifications');
const ws = require('../src/services/ws');

test('the bell after a change is decided, against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bell_live_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent

  // Who heard `notifications_changed`, and what was pushed live.
  const pushed = [];
  const realPush = ws.pushNotificationToUser;
  ws.pushNotificationToUser = (userId, payload) => { pushed.push({ userId: Number(userId), payload }); };
  t.after(() => { ws.pushNotificationToUser = realPush; });
  const changedFor = () => pushed.filter((p) => p.payload.type === 'notifications_changed').map((p) => p.userId).sort();

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
    [username, synthetic],
  )).rows[0];
  const bot = await user('homeroom_bot', true);
  const alex = await user('alex');
  const priya = await user('priya');
  const mo = await user('mo');

  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Page Turners', 'page-turners', 'running', $1, 'private', 'private') RETURNING id`,
    [alex.id],
  );
  const app = (await pool.query('SELECT id, slug, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
  for (const person of [alex, priya, mo]) {
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, person.id]);
    await pool.query('INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.id, person.id]);
  }

  const change = async (title, promotedAgo = '1 hour') => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, pr_title, promoted_at)
     VALUES ($1, $2, $3, 'promoted', $4, $4, NOW() - $5::interval) RETURNING id`,
    [app.id, bot.id, `bot-${crypto.randomBytes(4).toString('hex')}`, title, promotedAgo],
  )).rows[0].id;
  const notify = async (userId, kind, { sessionId = null, detail = null, read = false, ago = '30 minutes', source = alex.id, message = null } = {}) => (
    await pool.query(
      `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind, detail, chat_message_id, read_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN NOW() ELSE NULL END, NOW() - $9::interval)
       RETURNING id`,
      [userId, app.id, sessionId, source, kind, detail, message, read, ago],
    )).rows[0].id;
  const row = async (id) => (await pool.query('SELECT id, user_id, kind, read_at FROM notifications WHERE id = $1', [id])).rows[0];
  const listed = async (userId, id) => {
    const rows = await notifications.listForUser(pool, userId);
    const found = rows.find((r) => r.id === id);
    return found ? notifications.serialize(found) : null;
  };

  await t.test('the first version goes live: every ask is read and leaves the list, and the went-live news leaves with it (#5487)', async () => {
    pushed.length = 0;
    const first = await change('Build the Page Turners club screen');
    // Mo: two versions asked about, the vote nudge, a re-confirm ask and the
    // digest that named this change alone.
    const moOlder = await notify(mo.id, 'change_ready', { sessionId: first, detail: 'epoch:0', ago: '50 minutes' });
    const moReady = await notify(mo.id, 'change_ready', { sessionId: first, detail: 'epoch:1', ago: '43 minutes' });
    const moNudge = await notify(mo.id, 'pr_proposed', { sessionId: first });
    const moRecheck = await notify(mo.id, 'revision_recheck', { sessionId: first, detail: '1' });
    const moDigest = await notify(mo.id, 'vote_digest', { sessionId: first, detail: '1', ago: '20 minutes', source: null });
    // Priya said yes: her ask was read by the vote and stays read.
    const priyaReady = await notify(priya.id, 'change_ready', { sessionId: first, detail: 'epoch:1', read: true });
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [first, priya.id]);

    const before = await listed(mo.id, moReady);
    assert.equal(before.sessionStatus, 'promoted', 'up for approval, it asks');
    assert.equal((await listed(mo.id, moDigest)).digestWaiting, 1);
    // The badge counts the asks while the change is up: two "ready to try"
    // rows, the nudge, the re-confirm ask and the digest of one.
    assert.equal(await notifications.countUnread(pool, mo.id), 5);
    assert.equal(await notifications.countUnread(pool, priya.id), 0, 'hers was read by her vote');

    // Still up for approval: nothing is settled.
    assert.deepEqual(await notifications.settleDecidedChange(pool, first), []);
    assert.equal((await row(moNudge)).read_at, null);

    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW(), live_at = NOW() WHERE id = $1`, [first]);
    const told = await notifications.settleDecidedChange(pool, first);
    assert.deepEqual(told, [mo.id], 'only Mo\'s bell changed');
    assert.deepEqual(changedFor(), [mo.id], 'and he hears it, which re-badges his phone');

    // #4795: every "ready to try" is read — none is re-opened as the news.
    for (const id of [moReady, moOlder, priyaReady]) {
      assert.notEqual((await row(id)).read_at, null, `${(await row(id)).kind} is put away`);
    }
    for (const id of [moNudge, moRecheck, moDigest]) {
      assert.notEqual((await row(id)).read_at, null, `${(await row(id)).kind} is answered by the decision`);
    }

    // ...and every row about the merged change leaves the list, read or
    // not — the asks and, since #5487, the news that it went live: pr_merged
    // to the author, voted_change_merged to the voter (#4787). The phone
    // push announced the merge; the row only ever opened a merged page.
    const moLive = await notify(mo.id, 'pr_merged', { sessionId: first, source: null });
    const priyaLive = await notify(priya.id, 'voted_change_merged', { sessionId: first, source: null });
    assert.equal(await listed(mo.id, moLive), null, 'the author\'s went-live news is off the list');
    assert.equal(await listed(priya.id, priyaLive), null, 'the voter\'s went-live news is off the list');
    for (const id of [moReady, moOlder, moNudge, moRecheck, moDigest]) {
      assert.equal(await listed(mo.id, id), null, `${(await row(id)).kind} is off the list`);
    }
    assert.equal(await listed(priya.id, priyaReady), null, 'hers too');
    assert.equal(await notifications.countUnread(pool, mo.id), 0, 'nothing about a merged change counts now');
    assert.equal(await notifications.countUnread(pool, priya.id), 0);

    // Opening a row from a push still resolves it: the exact lookup is not
    // filtered.
    const exact = notifications.serialize(await notifications.getForUser(pool, mo.id, moReady));
    assert.equal(exact.sessionStatus, 'merged', 'the exact lookup (a push opened) reads the same');

    // Settling again changes nothing and tells nobody.
    pushed.length = 0;
    assert.deepEqual(await notifications.settleDecidedChange(pool, first), []);
    assert.deepEqual(changedFor(), []);
  });

  // #5487: the news that a change went live leaves the bell's list with the
  // asks, unread or read — it only ever opened a merged page, and the phone
  // push announced the merge. The exact lookup (a push opened) still
  // resolves it; a saved row stays in Saved.
  await t.test('#5487: the news that a merged change went live is off the list, unread or read', async () => {
    const basePriya = await notifications.countUnread(pool, priya.id);
    const baseMo = await notifications.countUnread(pool, mo.id);

    // Unread, on a merged and live change: off the list, and not counted.
    const live = await change('A change that went live');
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW(), live_at = NOW() WHERE id = $1`, [live]);
    const priyaNews = await notify(priya.id, 'voted_change_merged', { sessionId: live, source: null });
    const moNews = await notify(mo.id, 'pr_merged', { sessionId: live, source: null });
    assert.equal(await listed(priya.id, priyaNews), null, 'the voter\'s went-live news is off the list');
    assert.equal(await listed(mo.id, moNews), null, 'the author\'s too');
    assert.equal(await notifications.countUnread(pool, priya.id), basePriya, 'and it does not count');
    assert.equal(await notifications.countUnread(pool, mo.id), baseMo);
    // The exact lookup (a push opened) still resolves it.
    const exact = notifications.serialize(await notifications.getForUser(pool, priya.id, priyaNews));
    assert.equal(exact.sessionStatus, 'merged');
    assert.equal(exact.readAt, null, 'the exact lookup still resolves the unread row');

    // A read row on another merged change: off the list too, and the count
    // is unchanged — a read row never counted.
    const readChange = await change('Another change that went live');
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW(), live_at = NOW() WHERE id = $1`, [readChange]);
    const priyaRead = await notify(priya.id, 'voted_change_merged', { sessionId: readChange, source: null, read: true });
    const moRead = await notify(mo.id, 'pr_merged', { sessionId: readChange, source: null, read: true });
    assert.equal(await listed(priya.id, priyaRead), null, 'a read note is off the list');
    assert.equal(await listed(mo.id, moRead), null);
    assert.equal(await notifications.countUnread(pool, priya.id), basePriya, 'the count is unchanged');
    assert.equal(await notifications.countUnread(pool, mo.id), baseMo);
    const exactRead = notifications.serialize(await notifications.getForUser(pool, priya.id, priyaRead));
    assert.equal(exactRead.sessionStatus, 'merged');
    assert.notEqual(exactRead.readAt, null, 'the exact lookup still resolves the read row');

    // A row on a merged change that is still going live is hidden too:
    // the clause reads the stored status, which is already 'merged'.
    const { rows: [home] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, self_hosted, main_sha)
       VALUES ('Homeroom', 'homeroom-5461', 'running', $1, 'public', 'public', TRUE, 'AAAA1111') RETURNING id`,
      [alex.id],
    );
    // The build that serves is the one main_sha names; the merge below is
    // newer, so the release has not carried it yet (#5064).
    await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, pr_title, merge_commit_sha, merged_at)
       VALUES ($1, $2, $3, 'merged', 'The running build', 'AAAA1111', NOW() - INTERVAL '1 hour')`,
      [home.id, bot.id, `b-${crypto.randomBytes(4).toString('hex')}`],
    );
    const merging = (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, pr_title, merge_commit_sha, merged_at)
       VALUES ($1, $2, $3, 'merged', 'Say going live', 'BBBB2222', NOW()) RETURNING id`,
      [home.id, bot.id, `b-${crypto.randomBytes(4).toString('hex')}`],
    )).rows[0].id;
    const mergingRow = (await pool.query(
      `INSERT INTO notifications (user_id, app_id, session_id, kind, read_at)
       VALUES ($1, $2, $3, 'voted_change_merged', NOW()) RETURNING id`,
      [priya.id, home.id, merging],
    )).rows[0].id;
    assert.equal(notifications.serialize(await notifications.getForUser(pool, priya.id, mergingRow)).sessionStatus,
      'merging', 'the change is still going live');
    assert.equal(await listed(priya.id, mergingRow), null, 'and the note about it is off the list');

    // A closed change keeps its news in the list, as it does today.
    const closed = await change('A change that was closed');
    await pool.query(`UPDATE chat_sessions SET status = 'archived', archived_at = NOW() WHERE id = $1`, [closed]);
    const closedNews = await notify(priya.id, 'voted_change_merged', { sessionId: closed, source: null, read: true });
    assert.ok(await listed(priya.id, closedNews), 'a closed change keeps its news in the list');

    // A row with no session behind it is never hidden (the NULL-safe
    // comparison).
    const noSession = await notify(mo.id, 'pr_merged', { sessionId: null, source: null, read: true });
    assert.ok(await listed(mo.id, noSession), 'a row with no session is never hidden');

    // A saved row stays in the Saved section, which skips the filter.
    await pool.query(`INSERT INTO notification_bookmarks (user_id, notification_id) VALUES ($1, $2)`, [priya.id, priyaRead]);
    const saved = await notifications.listSavedForUser(pool, priya.id);
    assert.ok(saved.some((r) => r.id === priyaRead), 'a saved row stays in Saved');
  });

  // #4778: settleDecidedChange runs best-effort at every call site, so the
  // bell also settles a decided change's asks live off the change's status.
  // Seeded WITHOUT calling it, the way a missed settle leaves the rows.
  const seedAsks = async (who, sessionId) => {
    const ids = [
      await notify(who.id, 'pr_proposed', { sessionId }),
      await notify(who.id, 'revision_recheck', { sessionId, detail: '1' }),
      await notify(who.id, 'stale_pr', { sessionId }),
      await notify(who.id, 'vote_digest', { sessionId, detail: '1', ago: '20 minutes', source: null }),
    ];
    const ready = await notify(who.id, 'change_ready', { sessionId, detail: 'epoch:1' });
    return { ids, ready };
  };
  const exact = async (userId, id) => notifications.serialize(await notifications.getForUser(pool, userId, id));

  await t.test('a decided change\'s asks read as read without the settle (#4778)', async () => {
    const sam = await user('sam');
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, sam.id]);
    const decided = await change('Show book covers on the shelf');
    const { ids, ready } = await seedAsks(sam, decided);
    assert.equal(await notifications.countUnread(pool, sam.id), 5, 'all five asks count');

    // The change merges; the best-effort settle never runs.
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW(), live_at = NOW() WHERE id = $1`, [decided]);

    // #4795: a merged change is decided, so its asks leave the list and stop
    // counting with or without the settle. Nothing here wrote the news rows
    // (pr_merged, voted_change_merged), so nothing about it counts at all.
    for (const id of ids) {
      assert.equal(await listed(sam.id, id), null, `${(await row(id)).kind} is off the list`);
    }
    assert.equal(await listed(sam.id, ready), null, 'its "ready to try" row leaves too');
    assert.equal(await notifications.countUnread(pool, sam.id), 0, 'nothing about a merged change asks anymore');

    // Opening a row from a push still resolves it, and the live read shows it
    // read off the merge (#4778), not as an unread ask about a decided page.
    for (const id of ids) {
      assert.notEqual((await exact(sam.id, id)).readAt, null, `${(await row(id)).kind} reads as read in the exact lookup`);
    }
    assert.ok((await notifications.hydrateNotification(pool, ids[0])).notification.readAt,
      'the live push read serializes a truthy readAt');
    const { rows: stored } = await pool.query(
      'SELECT read_at FROM notifications WHERE id = ANY($1::int[])', [ids],
    );
    assert.ok(stored.every((r) => r.read_at === null), 'nothing was written: the stored state is untouched');
  });

  await t.test('a closed change\'s asks read as read without the settle too', async () => {
    const tessa = await user('tessa');
    const closed = await change('Keep a reading list per shelf');
    const { ids, ready } = await seedAsks(tessa, closed);
    await pool.query(`UPDATE chat_sessions SET status = 'archived', archived_at = NOW() WHERE id = $1`, [closed]);
    for (const id of ids) {
      assert.notEqual((await listed(tessa.id, id)).readAt, null);
    }
    assert.equal((await listed(tessa.id, ready)).readAt, null);
    assert.equal(await notifications.countUnread(pool, tessa.id), 1);
  });

  await t.test('a change still up for approval asks as before (control)', async () => {
    const uma = await user('uma');
    const open = await change('Sort the reading list by date added');
    const { ids, ready } = await seedAsks(uma, open);
    for (const id of [...ids, ready]) {
      assert.equal((await listed(uma.id, id)).readAt, null);
    }
    assert.equal(await notifications.countUnread(pool, uma.id), 5, 'all five still count');
  });

  await t.test('a read "ready to try" is not brought back unread: the merge news rides its own rows (#4787)', async () => {
    const next = await change('Show whose place we meet at');
    const seen = await notify(mo.id, 'change_ready', { sessionId: next, detail: 'epoch:0', read: true });
    const noVote = await notify(priya.id, 'change_ready', { sessionId: next, detail: 'epoch:0', read: true });
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'no')`, [next, priya.id]);
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW(), live_at = NOW() WHERE id = $1`, [next]);
    const told = await notifications.settleDecidedChange(pool, next);
    assert.deepEqual(told, [], 'nobody\'s row is re-opened: the news arrives as pr_merged or voted_change_merged');
    assert.notEqual((await row(seen)).read_at, null, 'Mo looked: his read row stays read');
    assert.notEqual((await row(noVote)).read_at, null, 'a No is a say in it: her read row stays read');
    // Read or not, both are off the list once the change has merged.
    assert.equal(await listed(mo.id, seen), null);
    assert.equal(await listed(priya.id, noVote), null);
    // No second row, so nothing rang twice.
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE session_id = $1`, [next]);
    assert.equal(rows[0].n, 2);
  });

  await t.test('a closed change asks nobody anything: its "ready to try" is read, stays listed and says Closed', async () => {
    const closed = await change('Dark mode');
    const ask = await notify(mo.id, 'change_ready', { sessionId: closed, detail: 'epoch:0' });
    const nudge = await notify(mo.id, 'pr_proposed', { sessionId: closed });
    await pool.query(`UPDATE chat_sessions SET status = 'archived', archived_at = NOW() WHERE id = $1`, [closed]);
    assert.deepEqual(await notifications.settleDecidedChange(pool, closed), [mo.id]);
    assert.notEqual((await row(ask)).read_at, null);
    assert.notEqual((await row(nudge)).read_at, null);
    // Closed, not merged: its rows stay in the list, where "ready to try"
    // reads Closed off the change.
    assert.ok(await listed(mo.id, ask), 'a closed change keeps its rows in the list');
    assert.ok(await listed(mo.id, nudge));
    const shown = notifications.serialize(await notifications.getForUser(pool, mo.id, ask));
    assert.equal(shown.sessionStatus, 'archived');
  });

  // The kinds whose rows name a change but are not asks (#5482). Once the
  // change has merged, tapping any of them only opens the merged page, so
  // they leave the list with the asks do.
  const CHANGE_ROW_KINDS = ['proposal_vote', 'check_failed', 'session_done', 'session_stalled', 'auto_solve_done', 'connector_submitted', 'spec_shared'];
  const detailFor = (kind) => (kind === 'proposal_vote' ? 'yes' : kind === 'auto_solve_done' ? 'code' : null);

  await t.test('every row about a merged change leaves: a row with no change stays listed', async () => {
    const merged = await change('Sticky reading position');
    // A mention has no session behind it; a vote on a proposal names the
    // change but is not an ask. The first guards the NULL-safe comparison in
    // the list's filter.
    const mention = await notify(mo.id, 'mention', { sessionId: null });
    const vote = await notify(mo.id, 'proposal_vote', { sessionId: merged, detail: 'yes' });
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW(), live_at = NOW() WHERE id = $1`, [merged]);
    await notifications.settleDecidedChange(pool, merged);
    assert.ok(await listed(mo.id, mention), 'a row with no session is never hidden');
    assert.equal(await listed(mo.id, vote), null, 'a proposal_vote about a merged change leaves the list');
    // Opening it from a push still resolves it.
    const exact = notifications.serialize(await notifications.getForUser(pool, mo.id, vote));
    assert.equal(exact.kind, 'proposal_vote', 'the exact lookup (a push opened) still resolves it');
  });

  await t.test('every row about a merged change leaves the list, the went-live news included (#5487)', async () => {
    const base = await notifications.countUnread(pool, mo.id);
    const waiting = await change('Books read list');
    const ids = [];
    for (const kind of CHANGE_ROW_KINDS) {
      ids.push(await notify(mo.id, kind, { sessionId: waiting, detail: detailFor(kind), source: alex.id }));
    }
    // A message somebody wrote about the change: never hidden, whatever the
    // change does.
    const reply = await notify(mo.id, 'reply', { sessionId: waiting });
    assert.equal(await notifications.countUnread(pool, mo.id), base + ids.length + 1,
      'all of them count while the change still waits');

    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW(), live_at = NOW() WHERE id = $1`, [waiting]);

    for (const id of ids) {
      assert.equal(await listed(mo.id, id), null, `${(await row(id)).kind} is off the list once it has merged`);
    }
    assert.ok(await listed(mo.id, reply), 'a message people wrote stays');
    assert.equal(await notifications.countUnread(pool, mo.id), base + 1, 'only the message counts now');

    // The news that it went live leaves too (#5487): the phone push announced
    // the merge, and the row only ever opened a merged page.
    const live = await notify(mo.id, 'pr_merged', { sessionId: waiting, source: null });
    assert.equal(await listed(mo.id, live), null, 'the went-live news is off the list');
    assert.equal(await notifications.countUnread(pool, mo.id), base + 1);

    // Opening one of the hidden rows from a push still resolves it.
    const exact = notifications.serialize(await notifications.getForUser(pool, mo.id, ids[0]));
    assert.equal(exact.kind, CHANGE_ROW_KINDS[0], 'the exact lookup (a push opened) still resolves it');

    // A saved row of a kind that left the list stays in the Saved section.
    await pool.query(`INSERT INTO notification_bookmarks (user_id, notification_id) VALUES ($1, $2)`, [mo.id, ids[0]]);
    const saved = await notifications.listSavedForUser(pool, mo.id);
    assert.ok(saved.some((r) => r.id === ids[0]), 'a saved row stays in Saved');
  });

  await t.test('a closed change keeps every row about it (control)', async () => {
    const closed = await change('Star ratings');
    const ids = [];
    for (const kind of CHANGE_ROW_KINDS) {
      ids.push(await notify(mo.id, kind, { sessionId: closed, detail: detailFor(kind), source: alex.id }));
    }
    await pool.query(`UPDATE chat_sessions SET status = 'archived', archived_at = NOW() WHERE id = $1`, [closed]);
    for (const id of ids) {
      assert.ok(await listed(mo.id, id), `${(await row(id)).kind} stays listed on a closed change`);
    }
  });

  await t.test('a digest of several counts only what still waits, and is read when nothing does', async () => {
    const a = await change('Books read list', '3 hours');
    const b = await change('Star ratings', '2 hours');
    const later = await change('Sent after the digest', '1 minute');
    const digest = await notify(mo.id, 'vote_digest', { detail: '2', ago: '90 minutes', source: null });
    assert.equal((await listed(mo.id, digest)).digestWaiting, 2,
      'two up for approval when it was sent; one put up since is not what it counted');

    // Mo votes on one: that one stops waiting on him, the other still does.
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [a, mo.id]);
    assert.equal((await listed(mo.id, digest)).digestWaiting, 1);
    assert.deepEqual(await notifications.settleVoteDigests(pool, { userIds: [mo.id] }), [], 'one still waits: kept');
    assert.equal((await row(digest)).read_at, null);

    // The other goes live: nothing waits, and its decision settles the digest.
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW(), live_at = NOW() WHERE id = $1`, [b]);
    assert.equal((await listed(mo.id, digest)).digestWaiting, 0);
    assert.ok((await notifications.settleDecidedChange(pool, b)).includes(mo.id));
    assert.notEqual((await row(digest)).read_at, null);

    // Never more than it said, and never every digest on the platform.
    assert.deepEqual(await notifications.settleVoteDigests(pool, {}), []);
    await pool.query(`UPDATE chat_sessions SET status = 'archived', archived_at = NOW() WHERE id = $1`, [later]);
  });

  await t.test('a first message Homeroom bot filed as a request is "Asked for a change", pushed again when it is filed', async () => {
    const { rows: [message] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content)
       VALUES ($1, $2, 'Could it also keep a list of the books we''ve already read?') RETURNING id`,
      [app.id, priya.id],
    );
    const hello = await notify(alex.id, 'first_message', { message: message.id, source: priya.id, ago: '1 minute' });
    assert.equal((await listed(alex.id, hello)).requestNumber, null, 'just sent: what they said');

    const chat = require('../src/services/homeroom-bot-chat');
    // The newcomer's offer is not a request yet ("Suggest it" / "Not now").
    pushed.length = 0;
    await chat.record(pool, { messageId: message.id, appId: app.id, userId: priya.id, kind: 'offer', title: 'Books read list' });
    assert.equal((await listed(alex.id, hello)).requestNumber, null);
    assert.equal(pushed.length, 0, 'nothing to say again');

    // "Suggest it": filed as request #2. Alex's row is pushed again as it reads now.
    await chat.record(pool, {
      messageId: message.id, appId: app.id, userId: priya.id, kind: 'filed', issueNumber: 2, title: 'Books read list', replace: true,
    });
    const now = await listed(alex.id, hello);
    assert.equal(now.requestNumber, 2);
    const live = pushed.filter((p) => p.payload.type === 'notification_new');
    assert.equal(live.length, 1);
    assert.equal(live[0].userId, alex.id, 'to the maker, the one person told she said hi');
    assert.equal(live[0].payload.notification.id, hello);
    assert.equal(live[0].payload.notification.requestNumber, 2);

    // Other kinds' shape is unchanged: none of the three new fields.
    const mention = await notify(alex.id, 'mention', { message: message.id, source: priya.id });
    const plain = await listed(alex.id, mention);
    for (const field of ['sessionStatus', 'digestWaiting', 'requestNumber']) {
      assert.equal(Object.prototype.hasOwnProperty.call(plain, field), false, field);
    }
  });

  await t.test('a group discussion message the bot filed: the rest of the group\'s rows say it is a request, pushed again', async () => {
    // The real discussion path (services/group-channel-notify.js): a private
    // project of three, each a member collaborator, so Mo's message rings
    // Alex and Priya.
    const group = require('../src/services/group-channel-notify');
    for (const person of [alex, priya, mo]) {
      await pool.query(
        `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW())
         ON CONFLICT (app_id, user_id) DO UPDATE SET status = 'member'`,
        [app.id, person.id],
      );
    }
    const post = async (who, content) => (await pool.query(
      'INSERT INTO chat_messages (app_id, user_id, content) VALUES ($1, $2, $3) RETURNING id', [app.id, who.id, content],
    )).rows[0].id;
    const asked = await post(mo, 'Could it also show whose place we meet at next time?');
    pushed.length = 0;
    const rang = await group.notifyChannelMessage(pool, { appId: app.id, messageId: asked, senderId: mo.id });
    assert.deepEqual(rang.map((r) => Number(r.user_id)).sort(), [alex.id, priya.id].sort(), 'the rest of the group');
    const rowOf = (who) => rang.find((r) => Number(r.user_id) === who.id).id;
    assert.equal((await listed(alex.id, rowOf(alex))).requestNumber, null, 'just sent: what Mo said');

    // A read that is not a request (a question for the bot) changes nothing.
    pushed.length = 0;
    const chat = require('../src/services/homeroom-bot-chat');
    const question = await post(mo, 'What can the bot do?');
    await chat.record(pool, { messageId: question, appId: app.id, userId: mo.id, kind: 'question' });
    assert.equal(pushed.length, 0);

    // Filed as request #4 (the group files it; the bot does not build here).
    await chat.record(pool, {
      messageId: asked, appId: app.id, userId: mo.id, kind: 'group', issueNumber: 4, title: 'Show the host', replace: true,
    });
    for (const who of [alex, priya]) {
      assert.equal((await listed(who.id, rowOf(who))).requestNumber, 4, who.username);
      const exact = notifications.serialize(await notifications.getForUser(pool, who.id, rowOf(who)));
      assert.equal(exact.requestNumber, 4, 'the exact lookup (a push opened) reads the same');
    }
    const again = pushed.filter((p) => p.payload.type === 'notification_new');
    assert.deepEqual(again.map((p) => p.userId).sort(), [alex.id, priya.id].sort(), 'each row pushed again, to its reader');
    assert.ok(again.every((p) => p.payload.notification.requestNumber === 4 && p.payload.notification.kind === 'channel_message'));
    assert.ok(again.every((p) => p.payload.notification.readAt === null), 'unread as it was');

    // Priya answers before Alex reads: his row folds her message in, and is
    // about two messages now, not Mo's request.
    await group.notifyChannelMessage(pool, { appId: app.id, messageId: await post(priya, 'Good idea'), senderId: priya.id });
    const folded = await listed(alex.id, rowOf(alex));
    assert.equal(folded.detail, '2');
    assert.equal(folded.requestNumber, null, 'its newest message is not the request');
  });

  // #5064: "A change you voted on is live" while Homeroom's own release had
  // not shipped it. With the merge-followups flag off the merge stamps
  // live_at at once, so the bell also reads the running build
  // (apps.main_sha): a change merged after the one it was built from is
  // going live; once the build carries it, it is live. A child app's merge,
  // rebuilt before the row is written, stays live.
  await t.test('#5064: a merge of Homeroom itself is going live until the running build carries it', async () => {
    const { rows: [home] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, self_hosted, main_sha)
       VALUES ('Homeroom', 'homeroom-5064', 'running', $1, 'public', 'public', TRUE, 'AAAA1111') RETURNING id`,
      [alex.id],
    );
    const merged = async (sha, ago) => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, pr_title, merge_commit_sha, merged_at)
       VALUES ($1, $2, $3, 'merged', 'Say going live', $4, NOW() - $5::interval) RETURNING id, live_at`,
      [home.id, alex.id, `b-${crypto.randomBytes(4).toString('hex')}`, sha, ago],
    )).rows[0];
    const running = await merged('aaaa1111', '1 hour');
    const fresh = await merged('bbbb2222', '2 minutes');
    assert.notEqual(fresh.live_at, null, 'the legacy merge stamps live_at at once');
    const ring = async (sessionId, kind, userId) => (await pool.query(
      `INSERT INTO notifications (user_id, app_id, session_id, kind, detail)
       VALUES ($1, $2, $3, $4, 'yes') RETURNING id`, [userId, home.id, sessionId, kind])).rows[0].id;
    const voterRow = await ring(fresh.id, 'voted_change_merged', priya.id);
    const authorRow = await ring(fresh.id, 'pr_merged', alex.id);
    const olderRow = await ring(running.id, 'voted_change_merged', priya.id);

    // #5487: the went-live rows are off the list now, so their session status
    // is read through the exact lookup, which is what a push-opened row uses.
    const exactSessionStatus = async (userId, id) =>
      notifications.serialize(await notifications.getForUser(pool, userId, id)).sessionStatus;
    assert.equal(await exactSessionStatus(priya.id, voterRow), 'merging', 'not in the running build: going live');
    assert.equal(await exactSessionStatus(alex.id, authorRow), 'merging', 'the author\'s row too');
    assert.equal(await exactSessionStatus(priya.id, olderRow), 'merged', 'the build that serves: live');

    // The release ships it.
    await pool.query(`UPDATE apps SET main_sha = 'bbbb2222' WHERE id = $1`, [home.id]);
    assert.equal(await exactSessionStatus(priya.id, voterRow), 'merged');
    assert.equal(await exactSessionStatus(alex.id, authorRow), 'merged');

    // A running build no merged change matches proves nothing: live, as before.
    await pool.query(`UPDATE apps SET main_sha = 'cccc3333' WHERE id = $1`, [home.id]);
    assert.equal(await exactSessionStatus(priya.id, voterRow), 'merged');

    // A child app's merge is live with the row (the first test's app).
    const child = await change('A child app change');
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW(), live_at = NOW() WHERE id = $1`, [child]);
    const childRow = await notify(priya.id, 'voted_change_merged', { sessionId: child, source: null });
    assert.equal(await exactSessionStatus(priya.id, childRow), 'merged');
  });
});
