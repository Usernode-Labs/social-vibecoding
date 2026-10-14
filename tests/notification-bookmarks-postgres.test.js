'use strict';

// #4769: saving (bookmarking) an individual notification, against the FULL
// PostgreSQL schema in a throwaway database, through the real code —
// services/notification-bookmarks.js and the saved-section read in
// services/notifications.js.
//
// Pinned here:
//   * a save pins only the caller's OWN notification, and re-saving an
//     already-saved one keeps the original saved time (no section reorder);
//   * the saved list reads back through the feed's own row SELECT and
//     serializes to the shape the client renders (saved + savedAt);
//   * the feed page flags each row saved or not, so the bookmark button
//     renders filled after a reload;
//   * saving does not touch the notification's read state;
//   * deleting the notification (or the user) deletes the save — both FK
//     cascades — so the section never shows a row that is gone.
//
// Run with: node --test tests/notification-bookmarks-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('notification bookmarks against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `notif_bookmark_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  // Boot-idempotent, like every real deployment restart.
  await pool.query(schema);
  await pool.query(schema);

  const bookmarks = require('../src/services/notification-bookmarks');
  const notifications = require('../src/services/notifications');

  async function user(username) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`,
      [username]
    );
    return rows[0];
  }
  async function notify(userId, kind = 'mention') {
    const { rows } = await pool.query(
      `INSERT INTO notifications (user_id, kind) VALUES ($1, $2) RETURNING *`,
      [userId, kind]
    );
    return rows[0];
  }
  const bookmarkRows = async (notificationId) => (await pool.query(
    'SELECT * FROM notification_bookmarks WHERE notification_id = $1', [notificationId]
  )).rows;

  const evan = await user('evan');
  const snait = await user('snait');
  const mine = await notify(evan.id);
  const mineToo = await notify(evan.id, 'kudos');
  const theirs = await notify(snait.id);

  await t.test('saving pins the caller\'s own notification, and re-saving keeps the saved time', async () => {
    assert.equal(await bookmarks.save(pool, evan.id, mine.id), true);
    const [first] = await bookmarkRows(mine.id);
    assert.ok(first.created_at, 'a save time is recorded');

    // Idempotent: a double-tap or a second tab must answer success and not
    // reorder the section, so the original created_at survives.
    assert.equal(await bookmarks.save(pool, evan.id, mine.id), true);
    const [again] = await bookmarkRows(mine.id);
    assert.equal(again.created_at.getTime(), first.created_at.getTime(),
      're-saving keeps the original saved time');
    assert.equal((await bookmarkRows(mine.id)).length, 1, 'and there is still one row');
  });

  await t.test('another user\'s notification cannot be pinned', async () => {
    assert.equal(await bookmarks.save(pool, evan.id, theirs.id), false);
    assert.deepEqual(await bookmarkRows(theirs.id), [], 'and nothing was written');
  });

  await t.test('unsaving removes the save, and reports honestly when there was none', async () => {
    assert.equal(await bookmarks.remove(pool, evan.id, mine.id), 1);
    assert.deepEqual(await bookmarkRows(mine.id), []);
    assert.equal(await bookmarks.remove(pool, evan.id, mine.id), 0,
      'unsaving an id that was never saved removed nothing');
  });

  await t.test('the saved section reads back ordered by save time, in the client\'s shape', async () => {
    // Save in a deliberate order so the section's order is observable.
    await bookmarks.save(pool, evan.id, mine.id);
    await new Promise((r) => setTimeout(r, 5));
    await bookmarks.save(pool, evan.id, mineToo.id);

    const rows = await notifications.listSavedForUser(pool, evan.id);
    assert.deepEqual(rows.map((r) => r.id), [mineToo.id, mine.id],
      'newest SAVE first, not newest notification first');
    const views = rows.map(notifications.serialize);
    assert.deepEqual(views.map((v) => [v.id, v.saved]), [[mineToo.id, true], [mine.id, true]]);
    for (const v of views) {
      // serialize carries the raw pg value, exactly as it does for createdAt —
      // JSON.stringify dates it on the wire, so either shape parses.
      const when = v.savedAt instanceof Date ? v.savedAt.toISOString() : v.savedAt;
      assert.ok(!Number.isNaN(Date.parse(when)), 'the client orders the merged section on savedAt');
    }

    // The section is one person's: snait sees nothing of evan's saves.
    assert.deepEqual(await notifications.listSavedForUser(pool, snait.id), []);
  });

  await t.test('the feed page flags each row saved, so the button renders filled after a reload', async () => {
    const rows = await notifications.listForUser(pool, evan.id);
    const flags = Object.fromEntries(rows.map((r) => [r.id, notifications.serialize(r).saved]));
    assert.equal(flags[mine.id], true);
    assert.equal(flags[mineToo.id], true);
    const fresh = await notify(evan.id);
    const [freshRow] = await notifications.listForUser(pool, evan.id, { limit: 1 });
    assert.equal(freshRow.id, fresh.id);
    assert.equal(notifications.serialize(freshRow).saved, false, 'an unsaved row says so');

    // Saving did not touch read state: the rows saved above are still unread.
    const after = await pool.query('SELECT read_at FROM notifications WHERE id = $1', [mine.id]);
    assert.equal(after.rows[0].read_at, null);
  });

  await t.test('deleting the notification deletes the save', async () => {
    await bookmarks.save(pool, evan.id, mine.id);
    await pool.query('DELETE FROM notifications WHERE id = $1', [mine.id]);
    assert.deepEqual(await bookmarkRows(mine.id), [],
      'the FK cascade takes the save with the notification');
    // mineToo is still saved from the section test above, so the list is not
    // empty — the point is that the deleted notification leaves it at once.
    const stillSaved = (await notifications.listSavedForUser(pool, evan.id)).map((r) => r.id);
    assert.ok(!stillSaved.includes(mine.id),
      'and the section stops showing the deleted notification at once');
    assert.deepEqual(stillSaved, [mineToo.id], 'and only that one leaves');
  });

  await t.test('deleting the user deletes their saves', async () => {
    await bookmarks.save(pool, snait.id, theirs.id);
    await pool.query('DELETE FROM users WHERE id = $1', [snait.id]);
    const { rows } = await pool.query(
      'SELECT 1 FROM notification_bookmarks WHERE notification_id = $1', [theirs.id]
    );
    assert.deepEqual(rows, [], 'the user-side cascade holds too');
  });
});