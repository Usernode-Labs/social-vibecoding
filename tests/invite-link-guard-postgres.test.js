'use strict';

// Invite links without a cap, and the leaked-link guard, against the full
// schema (services/community-invites.js GUARD, the invite-link-guard
// migrations).
//
//   - A new link has no use limit and no end date: it lets in more than the
//     25 people a link used to stop at, and never expires. A link made with
//     a limit and an end date keeps them, and the migration changes no link
//     that was there before it.
//   - Joins through one link are counted over a rolling 24 hours. At 20 its
//     maker is told once in that window, with Turn off; at 100 the link
//     pauses: new joins are refused, while somebody already queued on it
//     still joins when let in. Two joins at once cannot both get past 100.
//   - Its maker opens it again, which restarts the count, or turns it off
//     from the notice. The full admins see both as unexpected events.
//
// Skipped when no server is reachable, and required when TEST_DATABASE_URL
// is set.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/invite-link-guard-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { waitFor } = require('./lib/wait-for');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const invites = require('../src/services/community-invites');
const notifications = require('../src/services/notifications');

test('invite links without a cap, and the leaked-link guard, against the full schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 10000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `invite_guard_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8, connectionTimeoutMillis: 10000 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);

  let seq = 0;
  async function account({ access = true, email = null } = {}) {
    seq += 1;
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, email, email_confirmed)
       VALUES ($1, 'x', $2, $3::varchar, $3::varchar IS NOT NULL) RETURNING id, username`,
      [`guest_${seq}`, access, email]);
    return { id: u.id, username: u.username, isAdmin: false, hasPlatformAccess: access };
  }
  // `n` accounts with access at once, for the joins that drive a link up.
  async function crowd(n) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access)
       SELECT 'crowd_' || $1::text || '_' || g, 'x', TRUE FROM generate_series(1, $2::int) g
       RETURNING id, username`,
      [String(++seq), n]);
    return rows.map((u) => ({ id: u.id, username: u.username, isAdmin: false, hasPlatformAccess: true }));
  }

  const maya = await account();
  const outsider = await account();
  let projects = 0;
  // A public project of Maya's (its community is the insert trigger's).
  async function project() {
    projects += 1;
    await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
       VALUES ($1, $2, 'running', $3, 'public', 'public')`,
      [`Run Club ${projects}`, `run-club-${projects}`, maya.id]);
    const { rows: [app] } = await pool.query(
      `SELECT id, slug, name, created_by, self_hosted, collab_visibility, view_visibility, community_id
         FROM apps WHERE slug = $1`, [`run-club-${projects}`]);
    await pool.query(
      'INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [app.community_id, maya.id]);
    return app;
  }
  const link = async (id) => (await pool.query(
    `SELECT max_uses, uses, expires_at, paused_at, reopened_at, busy_noticed_at FROM community_invites WHERE id = $1`,
    [id])).rows[0];
  const noticesOf = async (kind) => (await pool.query(
    `SELECT id, user_id, app_id, detail FROM notifications WHERE kind = $1 ORDER BY id`, [kind])).rows;
  const incidentsOf = async (kind) => (await pool.query(
    `SELECT app_id, metadata FROM events WHERE event_type = 'platform_incident' AND metadata->>'kind' = $1 ORDER BY id`,
    [kind])).rows;
  async function joinAll(token, people) {
    const out = [];
    for (const person of people) out.push(await invites.redeem(pool, { token, user: person }));
    return out;
  }

  await t.test('schema: no default limit, the guard\'s columns, and its two push kinds', async () => {
    const { rows: cols } = await pool.query(
      `SELECT column_name, column_default, is_nullable FROM information_schema.columns
        WHERE table_name = 'community_invites'
          AND column_name IN ('max_uses', 'expires_at', 'paused_at', 'reopened_at', 'busy_noticed_at')
        ORDER BY column_name`);
    assert.deepEqual(cols.map((c) => [c.column_name, c.column_default, c.is_nullable]), [
      ['busy_noticed_at', null, 'YES'], ['expires_at', null, 'YES'], ['max_uses', null, 'YES'],
      ['paused_at', null, 'YES'], ['reopened_at', null, 'YES'],
    ]);
    const { rows: kinds } = await pool.query(
      `SELECT kind, category, default_enabled FROM mobile_push_kind_categories
        WHERE kind IN ('invite_link_busy', 'invite_link_paused') ORDER BY kind`);
    assert.deepEqual(kinds.map((k) => `${k.kind}:${k.category}:${k.default_enabled}`),
      ['invite_link_busy:invite_activity:true', 'invite_link_paused:invite_activity:true']);
  });

  await t.test('a link made before keeps its limit and end date; the migration again changes nothing', async () => {
    const app = await project();
    // As the baseline made a link: a week and 25 people, written out.
    const { rows: [old] } = await pool.query(
      `INSERT INTO community_invites (token, community_id, app_id, created_by, max_uses, uses, expires_at)
       VALUES ($1, $2, $3, $4, 25, 3, NOW() + INTERVAL '5 days') RETURNING id`,
      [crypto.randomBytes(16).toString('base64url'), app.community_id, app.id, maya.id]);
    const before = await link(old.id);
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrations', 'invite-link-guard.sql'), 'utf8'));
    assert.deepEqual(await link(old.id), before);
    assert.equal(before.max_uses, 25);
    assert.ok(before.expires_at instanceof Date);
    // A maker who picks a limit and an end date still gets them.
    const chosen = await invites.createInvite(pool, { app, user: maya, days: 7, maxUses: 25 });
    assert.ok(chosen.ok);
    assert.equal(chosen.link.maxUses, 25);
    assert.ok(Date.parse(chosen.link.expiresAt) > Date.now() + 6 * 24 * 3600 * 1000);
    // And a used-up one is still used up.
    await pool.query('UPDATE community_invites SET uses = 25 WHERE id = $1', [chosen.link.id]);
    const [late] = await crowd(1);
    const refused = await invites.redeem(pool, { token: chosen.link.token, user: late });
    assert.deepEqual([refused.ok, refused.status, refused.reason], [false, 410, 'used_up']);
  });

  let busyApp;
  let busy;
  await t.test('a new link has no limit and no end: 30 join, past the 25 a link used to stop at', async () => {
    busyApp = await project();
    const made = await invites.createInvite(pool, { app: busyApp, user: maya });
    assert.ok(made.ok);
    assert.deepEqual([made.link.maxUses, made.link.expiresAt], [null, null], 'nothing asked: no limit, no end');
    busy = made.link;
    const results = await joinAll(busy.token, await crowd(30));
    assert.deepEqual([...new Set(results.map((r) => r.status))], ['joined']);
    const row = await link(busy.id);
    assert.deepEqual([row.max_uses, row.uses, row.expires_at, row.paused_at], [null, 30, null, null]);
    // An end date of NULL never comes: made a year ago, it still works.
    await pool.query(`UPDATE community_invites SET created_at = NOW() - INTERVAL '400 days' WHERE id = $1`, [busy.id]);
    const preview = await invites.preview(pool, busy.token);
    assert.deepEqual([preview.live, preview.reason, preview.expiresAt], [true, null, null]);
    assert.equal(invites.deadReason({ ...row, maker_holds: true }, new Date('2099-01-01T00:00:00Z')), null);
  });

  await t.test('at 20 in a day its maker is told once, with Turn off; the admins see it', async () => {
    const rows = await waitFor(async () => {
      const found = (await noticesOf('invite_link_busy')).filter((n) => n.app_id === busyApp.id);
      return found.length ? found : null;
    }, { label: 'the busy notice' });
    assert.equal(rows.length, 1, 'once for the window, not at 21 or 30');
    assert.deepEqual([rows[0].user_id, rows[0].detail], [maya.id, `${busy.id}:20`]);
    assert.ok((await link(busy.id)).busy_noticed_at, 'kept, so the window hears it once');
    // The bell reads the link's state with the row: live, so Turn off.
    const shown = await notifications.hydrateNotification(pool, rows[0].id);
    assert.equal(shown.userId, maya.id);
    assert.equal(shown.notification.inviteLinkState, 'live');
    assert.equal(shown.notification.appName, busyApp.name);
    // The full admins' unexpected events: the app and the count, never the token.
    const seen = await waitFor(async () => {
      const found = (await incidentsOf('invite_link_busy')).filter((e) => e.app_id === busyApp.id);
      return found.length ? found : null;
    }, { label: 'the busy incident' });
    assert.equal(seen.length, 1);
    assert.deepEqual([seen[0].metadata.inviteId, seen[0].metadata.joins], [busy.id, 20]);
    assert.doesNotMatch(JSON.stringify(seen[0].metadata), new RegExp(busy.token));
  });

  await t.test('the next day it is told again: the window rolls', async () => {
    // A day on: the joins and the notice are past the 24 hours.
    await pool.query(
      `UPDATE community_invite_redemptions SET created_at = created_at - INTERVAL '25 hours' WHERE invite_id = $1`, [busy.id]);
    await pool.query(
      `UPDATE community_invites SET busy_noticed_at = busy_noticed_at - INTERVAL '25 hours' WHERE id = $1`, [busy.id]);
    await joinAll(busy.token, await crowd(19));
    assert.equal((await noticesOf('invite_link_busy')).filter((n) => n.app_id === busyApp.id).length, 1, '19 today: nothing yet');
    await joinAll(busy.token, await crowd(1));
    const rows = await waitFor(async () => {
      const found = (await noticesOf('invite_link_busy')).filter((n) => n.app_id === busyApp.id);
      return found.length === 2 ? found : null;
    }, { label: 'the next day\'s busy notice' });
    assert.equal(rows[1].detail, `${busy.id}:20`);
  });

  await t.test('turned off from the notice: the row stops offering it, and the link is off', async () => {
    const [notice] = (await noticesOf('invite_link_busy')).filter((n) => n.app_id === busyApp.id);
    // The row's Turn off is the pane's DELETE /api/invite-links/:id.
    assert.deepEqual(await invites.revokeInvite(pool, { inviteId: busy.id, user: { id: maya.id } }), { ok: true, cancelled: 0 });
    const shown = await notifications.hydrateNotification(pool, notice.id);
    assert.equal(shown.notification.inviteLinkState, 'ended');
    const [late] = await crowd(1);
    const refused = await invites.redeem(pool, { token: busy.token, user: late });
    assert.deepEqual([refused.ok, refused.reason], [false, 'revoked']);
  });

  let pausedApp;
  let paused;
  let queued;
  await t.test('at 100 in a day the link pauses: the 100th is let in, the 101st refused', async () => {
    pausedApp = await project();
    paused = (await invites.createInvite(pool, { app: pausedApp, user: maya })).link;
    // Somebody still waiting, with no way to reach them yet: queued, and
    // counted as somebody who followed it.
    queued = await account({ access: false });
    const waiting = await invites.redeem(pool, { token: paused.token, user: queued, requirePhone: true });
    assert.equal(waiting.status, 'queued');
    // 96 more, one by one; then the last four at once, and one over: two joins
    // at once cannot both get past the line.
    await joinAll(paused.token, await crowd(95));
    assert.equal((await link(paused.id)).paused_at, null, '96: still open');
    const rush = await crowd(5);
    const results = await Promise.all(rush.map((person) => invites.redeem(pool, { token: paused.token, user: person })));
    const joined = results.filter((r) => r.ok && r.status === 'joined');
    const refused = results.filter((r) => !r.ok);
    assert.equal(joined.length, 4, 'up to the 100th');
    assert.equal(refused.length, 1, 'the 101st');
    assert.deepEqual([refused[0].status, refused[0].reason], [410, 'paused']);
    const row = await link(paused.id);
    assert.ok(row.paused_at, 'paused');
    assert.equal(row.uses, 100, 'nothing spent on the refused join');
    const { rows: [{ n }] } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM community_invite_redemptions WHERE invite_id = $1', [paused.id]);
    assert.equal(n, 100);
    // Somebody new is refused too, and the page says why.
    const [later] = await crowd(1);
    assert.deepEqual(await invites.redeem(pool, { token: paused.token, user: later }),
      { ok: false, status: 410, reason: 'paused' });
    const preview = await invites.preview(pool, paused.token);
    assert.deepEqual([preview.live, preview.reason, preview.project], [false, 'paused', undefined]);
    // Its maker's list keeps it with the live ones, said to be paused.
    const { links } = await invites.listInvites(pool, { app: pausedApp, user: { id: maya.id } });
    assert.equal(links.find((l) => l.id === paused.id).status, 'paused');
    // And opening the pane makes no second link beside it: it still counts as out.
    assert.equal(await invites.hasLiveLink(pool, pausedApp.id, maya.id), true);
  });

  await t.test('its maker is told it paused, and the admins see it', async () => {
    const rows = await waitFor(async () => {
      const found = (await noticesOf('invite_link_paused')).filter((n) => n.app_id === pausedApp.id);
      return found.length ? found : null;
    }, { label: 'the paused notice' });
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].user_id, rows[0].detail], [maya.id, `${paused.id}:100`]);
    const shown = await notifications.hydrateNotification(pool, rows[0].id);
    assert.equal(shown.notification.inviteLinkState, 'paused', 'Open it again and Turn off');
    // At 20 it was busy first, as any link is.
    assert.equal((await noticesOf('invite_link_busy')).filter((n) => n.app_id === pausedApp.id).length, 1);
    const seen = await waitFor(async () => {
      const found = (await incidentsOf('invite_link_paused')).filter((e) => e.app_id === pausedApp.id);
      return found.length ? found : null;
    }, { label: 'the paused incident' });
    assert.deepEqual([seen[0].metadata.inviteId, seen[0].metadata.joins], [paused.id, 100]);
  });

  await t.test('somebody queued on a paused link still joins when let in', async () => {
    const inIt = async (id) => (await pool.query(
      'SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2', [pausedApp.community_id, id])).rows.length === 1;
    assert.equal(await inIt(queued.id), false);
    // Let in off the waitlist: the trigger applies what they queued.
    await pool.query('UPDATE users SET has_platform_access = TRUE WHERE id = $1', [queued.id]);
    assert.equal(await inIt(queued.id), true);
    const { rows: [r] } = await pool.query(
      'SELECT status FROM community_invite_redemptions WHERE invite_id = $1 AND user_id = $2', [paused.id, queued.id]);
    assert.equal(r.status, 'joined');
    // And somebody queued who follows it again joins on the use they spent.
    const second = await account({ access: false });
    await pool.query(
      `INSERT INTO community_invite_redemptions (invite_id, user_id, status) VALUES ($1, $2, 'queued')`, [paused.id, second.id]);
    const again = await invites.redeem(pool, { token: paused.token, user: second });
    assert.deepEqual([again.ok, again.status, again.privateMember], [true, 'joined', true]);
    assert.equal((await link(paused.id)).uses, 100, 'no use spent');
  });

  await t.test('only whoever may turn it off opens it again; that restarts the count', async () => {
    assert.equal((await invites.reopenInvite(pool, { inviteId: paused.id, user: outsider })).status, 404);
    assert.ok((await link(paused.id)).paused_at, 'still paused');
    assert.deepEqual(await invites.reopenInvite(pool, { inviteId: paused.id, user: { id: maya.id } }), { ok: true, reopened: true });
    const row = await link(paused.id);
    assert.equal(row.paused_at, null);
    assert.ok(row.reopened_at);
    assert.deepEqual(await invites.reopenInvite(pool, { inviteId: paused.id, user: { id: maya.id } }), { ok: true, reopened: false },
      'not paused: nothing to do');
    const [next] = await crowd(1);
    assert.equal((await invites.redeem(pool, { token: paused.token, user: next })).status, 'joined');
    const { links } = await invites.listInvites(pool, { app: pausedApp, user: { id: maya.id } });
    assert.equal(links.find((l) => l.id === paused.id).status, 'live');
    const notice = (await noticesOf('invite_link_paused')).find((n) => n.app_id === pausedApp.id);
    assert.equal((await notifications.hydrateNotification(pool, notice.id)).notification.inviteLinkState, 'live');
    // Counted from the reopening: 99 more in the same day is not 100.
    await joinAll(paused.token, await crowd(98));
    assert.equal((await link(paused.id)).paused_at, null, '99 since it opened again');
    await joinAll(paused.token, await crowd(1));
    assert.ok((await link(paused.id)).paused_at, 'the 100th since it opened again pauses it again');
    const { rows: [{ n }] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM events WHERE event_type = 'invite_link_reopened' AND (metadata->>'inviteId')::int = $1`,
      [paused.id]);
    assert.equal(n, 1);
  });
});
