const { Router } = require('express');
const { getPool } = require('../db/pool');
const { socialWriteLimiter } = require('../middleware/rate-limits');
const { drainGuard } = require('../services/lifecycle');
const log = require('../services/logger');

const MAX_GROUP_PARTICIPANTS = 100;
const MAX_PAGE = 50;

function positiveId(value) {
  const raw = String(value ?? '');
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id <= 2147483647 ? id : null;
}

function pageArgs(query) {
  const rawLimit = Number(query.limit);
  const limit = Number.isSafeInteger(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_PAGE) : 25;
  const after = query.after == null || query.after === ''
    ? 0 : positiveId(query.after);
  return after === null ? null : { limit, after };
}

function groupName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || Array.from(name).length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

function pair(a, b) {
  return a < b ? [a, b] : [b, a];
}

async function lockPair(db, a, b) {
  const [low, high] = pair(a, b);
  await db.query('SELECT pg_advisory_xact_lock($1, $2)', [low, high]);
  return [low, high];
}

async function blockedEitherWay(db, a, b) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM user_blocks
      WHERE (blocker_id = $1 AND blocked_id = $2)
         OR (blocker_id = $2 AND blocked_id = $1)
      LIMIT 1`, [a, b]
  );
  return rowCount > 0;
}

async function notify(db, { userId, sourceUserId, kind, detail = null }) {
  if (!userId || userId === sourceUserId) return;
  await db.query(
    `INSERT INTO notifications (user_id, source_user_id, kind, detail)
     SELECT $1, $2, $3, $4
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications
         WHERE user_id = $1 AND source_user_id = $2 AND kind = $3
           AND COALESCE(detail, '') = COALESCE($4, '') AND read_at IS NULL
      )`,
    [userId, sourceUserId || null, kind, detail == null ? null : String(detail).slice(0, 32)]
  );
}

function pushChanged(userId) {
  if (!userId) return;
  try {
    const { pushNotificationToUser } = require('../services/ws');
    pushNotificationToUser(userId, { type: 'notifications_changed' });
  } catch {}
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function socialRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  router.use('/api/social', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });

  router.get('/api/social/contacts', async (req, res) => {
    const page = pageArgs(req.query);
    if (!page) return res.status(400).json({ error: 'Invalid cursor' });
    try {
      const { rows } = await pool.query(
        `SELECT cr.user_low_id, cr.user_high_id, cr.requested_by, cr.status,
                cr.created_at, cr.accepted_at, u.id AS other_id, u.username
           FROM contact_relationships cr
           JOIN users u ON u.id = CASE WHEN cr.user_low_id = $1
                                       THEN cr.user_high_id ELSE cr.user_low_id END
          WHERE (cr.user_low_id = $1 OR cr.user_high_id = $1)
            AND u.id > $2
            AND NOT EXISTS (
              SELECT 1 FROM user_blocks b
               WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                  OR (b.blocker_id = u.id AND b.blocked_id = $1)
            )
          ORDER BY u.id ASC LIMIT $3`,
        [req.user.id, page.after, page.limit + 1]
      );
      const hasMore = rows.length > page.limit;
      const items = rows.slice(0, page.limit).map((r) => ({
        userId: r.other_id,
        username: r.username,
        status: r.status,
        direction: r.status === 'accepted' ? 'mutual'
          : (r.requested_by === req.user.id ? 'outgoing' : 'incoming'),
        createdAt: r.created_at,
        acceptedAt: r.accepted_at,
      }));
      res.json({ contacts: items, hasMore, nextAfter: hasMore ? items.at(-1).userId : null });
    } catch (err) {
      log.error('social', 'contact list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/social/contacts/requests', socialWriteLimiter, drainGuard, async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    if (!username || username.length > 255) return res.status(400).json({ error: 'username is required' });
    try {
      const result = await withTransaction(pool, async (db) => {
        const { rows } = await db.query(
          'SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)', [username]
        );
        const target = rows[0];
        // Same response for absent and blocked identities prevents block enumeration.
        if (!target || target.id === req.user.id || await blockedEitherWay(db, req.user.id, target.id)) {
          return { status: 404, body: { error: 'User unavailable' } };
        }
        const [low, high] = await lockPair(db, req.user.id, target.id);
        if (await blockedEitherWay(db, req.user.id, target.id)) {
          return { status: 404, body: { error: 'User unavailable' } };
        }
        const { rows: existingRows } = await db.query(
          `SELECT requested_by, status FROM contact_relationships
            WHERE user_low_id = $1 AND user_high_id = $2 FOR UPDATE`, [low, high]
        );
        const existing = existingRows[0];
        if (existing?.status === 'accepted') {
          return { status: 200, body: { ok: true, status: 'accepted', userId: target.id, username: target.username } };
        }
        if (existing) {
          if (existing.requested_by === req.user.id) {
            return { status: 200, body: { ok: true, status: 'pending', userId: target.id, username: target.username } };
          }
          // Crossed requests are explicit consent from both users: accept atomically.
          await db.query(
            `UPDATE contact_relationships SET status = 'accepted', accepted_at = NOW()
              WHERE user_low_id = $1 AND user_high_id = $2`, [low, high]
          );
          await notify(db, { userId: target.id, sourceUserId: req.user.id, kind: 'contact_accepted' });
          return { status: 200, body: { ok: true, status: 'accepted', userId: target.id, username: target.username } };
        }
        await db.query(
          `INSERT INTO contact_relationships
             (user_low_id, user_high_id, requested_by, status)
           VALUES ($1, $2, $3, 'pending')`, [low, high, req.user.id]
        );
        await notify(db, { userId: target.id, sourceUserId: req.user.id, kind: 'contact_request' });
        return { status: 201, body: { ok: true, status: 'pending', userId: target.id, username: target.username } };
      });
      if (result.status < 300) pushChanged(result.body.userId);
      log.info('social', 'Contact request resolved', {
        by: req.user.id, target: result.body.userId || null, status: result.body.status || 'unavailable',
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      log.error('social', 'contact request failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/social/contacts/requests/:userId/accept', socialWriteLimiter, drainGuard, async (req, res) => {
    const other = positiveId(req.params.userId);
    if (!other || other === req.user.id) return res.status(404).json({ error: 'Request not found' });
    try {
      const result = await withTransaction(pool, async (db) => {
        const [low, high] = await lockPair(db, req.user.id, other);
        if (await blockedEitherWay(db, req.user.id, other)) {
          await db.query('DELETE FROM contact_relationships WHERE user_low_id = $1 AND user_high_id = $2', [low, high]);
          return null;
        }
        const { rows } = await db.query(
          `UPDATE contact_relationships SET status = 'accepted', accepted_at = NOW()
            WHERE user_low_id = $1 AND user_high_id = $2
              AND status = 'pending' AND requested_by = $3
          RETURNING status`, [low, high, other]
        );
        if (!rows.length) {
          const { rows: accepted } = await db.query(
            `SELECT 1 FROM contact_relationships WHERE user_low_id = $1 AND user_high_id = $2
              AND status = 'accepted'`, [low, high]
          );
          return accepted.length ? { alreadyAccepted: true } : null;
        }
        await notify(db, { userId: other, sourceUserId: req.user.id, kind: 'contact_accepted' });
        return { alreadyAccepted: false };
      });
      if (!result) return res.status(404).json({ error: 'Request not found' });
      pushChanged(other);
      log.info('social', 'Contact accepted', { by: req.user.id, target: other });
      res.json({ ok: true, status: 'accepted', ...result });
    } catch (err) {
      log.error('social', 'contact accept failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  async function deleteRelationship(req, res, requiredStatus) {
    const other = positiveId(req.params.userId);
    if (!other || other === req.user.id) return res.status(400).json({ error: 'Invalid user id' });
    try {
      await withTransaction(pool, async (db) => {
        const [low, high] = await lockPair(db, req.user.id, other);
        let condition = '';
        if (requiredStatus === 'pending') condition = " AND status = 'pending'";
        else if (requiredStatus === 'accepted') condition = " AND status = 'accepted'";
        await db.query(
          `DELETE FROM contact_relationships WHERE user_low_id = $1 AND user_high_id = $2${condition}`,
          [low, high]
        );
        if (requiredStatus === 'pending') {
          await db.query(
            `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
              WHERE kind = 'contact_request'
                AND ((user_id = $1 AND source_user_id = $2)
                  OR (user_id = $2 AND source_user_id = $1))`, [req.user.id, other]
          );
        }
      });
      res.json({ ok: true });
    } catch (err) {
      log.error('social', 'contact delete failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
  router.delete('/api/social/contacts/requests/:userId', socialWriteLimiter, drainGuard,
    (req, res) => deleteRelationship(req, res, 'pending'));
  router.delete('/api/social/contacts/:userId', socialWriteLimiter, drainGuard,
    (req, res) => deleteRelationship(req, res, 'accepted'));

  router.get('/api/social/blocks', async (req, res) => {
    const page = pageArgs(req.query);
    if (!page) return res.status(400).json({ error: 'Invalid cursor' });
    try {
      const { rows } = await pool.query(
        `SELECT b.blocked_id, b.created_at, u.username
           FROM user_blocks b JOIN users u ON u.id = b.blocked_id
          WHERE b.blocker_id = $1 AND b.blocked_id > $2
          ORDER BY b.blocked_id ASC LIMIT $3`, [req.user.id, page.after, page.limit + 1]
      );
      const hasMore = rows.length > page.limit;
      const blocks = rows.slice(0, page.limit).map((r) => ({
        userId: r.blocked_id, username: r.username, createdAt: r.created_at,
      }));
      res.json({ blocks, hasMore, nextAfter: hasMore ? blocks.at(-1).userId : null });
    } catch (err) {
      log.error('social', 'block list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/social/blocks/:userId', socialWriteLimiter, drainGuard, async (req, res) => {
    const other = positiveId(req.params.userId);
    if (!other || other === req.user.id) return res.status(400).json({ error: 'Invalid user id' });
    try {
      const ok = await withTransaction(pool, async (db) => {
        const [low, high] = await lockPair(db, req.user.id, other);
        const { rows } = await db.query('SELECT id FROM users WHERE id = $1', [other]);
        if (!rows.length) return false;
        await db.query(
          `INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)
           ON CONFLICT (blocker_id, blocked_id) DO NOTHING`, [req.user.id, other]
        );
        await db.query('DELETE FROM contact_relationships WHERE user_low_id = $1 AND user_high_id = $2', [low, high]);
        await db.query(
          `DELETE FROM social_group_members gm
            USING social_groups g
           WHERE gm.group_id = g.id AND gm.status = 'invited'
             AND ((g.owner_user_id = $1 AND gm.user_id = $2)
               OR (g.owner_user_id = $2 AND gm.user_id = $1))`, [req.user.id, other]
        );
        await db.query(
          `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
            WHERE kind = ANY($3)
              AND ((user_id = $1 AND source_user_id = $2)
                OR (user_id = $2 AND source_user_id = $1))`,
          [req.user.id, other, ['contact_request', 'contact_accepted', 'social_group_invite']]
        );
        return true;
      });
      if (ok) pushChanged(other);
      // Unknown and existing numeric ids intentionally share the same
      // retry-safe response so this endpoint cannot enumerate accounts.
      log.info('social', 'User blocked', { by: req.user.id, target: other });
      res.json({ ok: true });
    } catch (err) {
      log.error('social', 'block failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/social/blocks/:userId', socialWriteLimiter, drainGuard, async (req, res) => {
    const other = positiveId(req.params.userId);
    if (!other || other === req.user.id) return res.status(400).json({ error: 'Invalid user id' });
    try {
      await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.user.id, other]);
      res.json({ ok: true });
    } catch (err) {
      log.error('social', 'unblock failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/social/groups', async (req, res) => {
    const page = pageArgs(req.query);
    if (!page) return res.status(400).json({ error: 'Invalid cursor' });
    try {
      const { rows } = await pool.query(
        `SELECT g.id, g.name, g.owner_user_id, owner.username AS owner_username,
                gm.status, gm.created_at
           FROM social_group_members gm
           JOIN social_groups g ON g.id = gm.group_id
           JOIN users owner ON owner.id = g.owner_user_id
          WHERE gm.user_id = $1 AND g.id > $2
          ORDER BY g.id ASC LIMIT $3`, [req.user.id, page.after, page.limit + 1]
      );
      const hasMore = rows.length > page.limit;
      const groups = rows.slice(0, page.limit).map((r) => ({
        id: r.id, name: r.name, ownerUserId: r.owner_user_id,
        ownerUsername: r.owner_username, status: r.status,
        role: r.owner_user_id === req.user.id ? 'owner' : 'member', createdAt: r.created_at,
      }));
      res.json({ groups, hasMore, nextAfter: hasMore ? groups.at(-1).id : null });
    } catch (err) {
      log.error('social', 'group list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/social/groups', socialWriteLimiter, drainGuard, async (req, res) => {
    const name = groupName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Group name must be 1–80 characters' });
    try {
      const group = await withTransaction(pool, async (db) => {
        const { rows } = await db.query(
          `INSERT INTO social_groups (name, owner_user_id) VALUES ($1, $2)
           RETURNING id, name, owner_user_id, created_at`, [name, req.user.id]
        );
        await db.query(
          `INSERT INTO social_group_members (group_id, user_id, status, accepted_at)
           VALUES ($1, $2, 'member', NOW())`, [rows[0].id, req.user.id]
        );
        return rows[0];
      });
      log.info('social', 'Group created', { groupId: group.id, by: req.user.id });
      res.status(201).json({ group: {
        id: group.id, name: group.name, ownerUserId: group.owner_user_id,
        role: 'owner', status: 'member', createdAt: group.created_at,
      } });
    } catch (err) {
      log.error('social', 'group create failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/social/groups/:id', async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Group not found' });
    try {
      const { rows: accessRows } = await pool.query(
        `SELECT g.id, g.name, g.owner_user_id, g.created_at, g.updated_at,
                owner.username AS owner_username, me.status
           FROM social_groups g
           JOIN users owner ON owner.id = g.owner_user_id
           JOIN social_group_members me ON me.group_id = g.id AND me.user_id = $2
          WHERE g.id = $1`, [id, req.user.id]
      );
      const group = accessRows[0];
      if (!group) return res.status(404).json({ error: 'Group not found' });
      const base = {
        id: group.id, name: group.name, ownerUserId: group.owner_user_id,
        ownerUsername: group.owner_username, status: group.status,
        role: group.owner_user_id === req.user.id ? 'owner' : 'member',
        createdAt: group.created_at, updatedAt: group.updated_at,
      };
      if (group.status !== 'member') return res.json({ group: base, members: null });
      const { rows } = await pool.query(
        `SELECT gm.user_id, u.username, gm.status, gm.created_at, gm.accepted_at
           FROM social_group_members gm JOIN users u ON u.id = gm.user_id
          WHERE gm.group_id = $1 AND (gm.status = 'member' OR $3 = TRUE)
          ORDER BY (gm.user_id = $2) DESC, (gm.status = 'member') DESC, LOWER(u.username)
          LIMIT $4`, [id, group.owner_user_id, group.owner_user_id === req.user.id,
            MAX_GROUP_PARTICIPANTS]
      );
      res.json({ group: base, members: rows.map((r) => ({
        userId: r.user_id, username: r.username, status: r.status,
        role: r.user_id === group.owner_user_id ? 'owner' : 'member',
        createdAt: r.created_at, acceptedAt: r.accepted_at,
      })) });
    } catch (err) {
      log.error('social', 'group detail failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/social/groups/:id', socialWriteLimiter, drainGuard, async (req, res) => {
    const id = positiveId(req.params.id);
    const name = groupName(req.body?.name);
    if (!id || !name) return res.status(400).json({ error: 'Invalid group or name' });
    try {
      const { rows } = await pool.query(
        `UPDATE social_groups SET name = $1, updated_at = NOW()
          WHERE id = $2 AND owner_user_id = $3 RETURNING id, name, updated_at`,
        [name, id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Group not found' });
      res.json({ group: { id: rows[0].id, name: rows[0].name, updatedAt: rows[0].updated_at } });
    } catch (err) {
      log.error('social', 'group rename failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/social/groups/:id', socialWriteLimiter, drainGuard, async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Group not found' });
    try {
      const { rowCount } = await pool.query(
        'DELETE FROM social_groups WHERE id = $1 AND owner_user_id = $2', [id, req.user.id]
      );
      if (!rowCount) return res.status(404).json({ error: 'Group not found' });
      res.json({ ok: true });
    } catch (err) {
      log.error('social', 'group delete failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/social/groups/:id/invites', socialWriteLimiter, drainGuard, async (req, res) => {
    const id = positiveId(req.params.id);
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    if (!id || !username || username.length > 255) return res.status(400).json({ error: 'Invalid group or username' });
    try {
      const result = await withTransaction(pool, async (db) => {
        const { rows: groups } = await db.query(
          'SELECT id, name, owner_user_id FROM social_groups WHERE id = $1 FOR UPDATE', [id]
        );
        const group = groups[0];
        if (!group || group.owner_user_id !== req.user.id) return null;
        const { rows: users } = await db.query(
          'SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)', [username]
        );
        const target = users[0];
        if (!target || target.id === req.user.id) {
          return { unavailable: true };
        }
        await lockPair(db, req.user.id, target.id);
        if (await blockedEitherWay(db, req.user.id, target.id)) return { unavailable: true };
        const { rows: counts } = await db.query(
          'SELECT COUNT(*)::int AS n FROM social_group_members WHERE group_id = $1', [id]
        );
        if (counts[0].n >= MAX_GROUP_PARTICIPANTS) return { full: true };
        const { rows: existing } = await db.query(
          'SELECT status FROM social_group_members WHERE group_id = $1 AND user_id = $2',
          [id, target.id]
        );
        if (existing.length) return { target, existing: true, status: existing[0].status };
        const { rows: inserted } = await db.query(
          `INSERT INTO social_group_members (group_id, user_id, status, invited_by)
           VALUES ($1, $2, 'invited', $3)
           ON CONFLICT (group_id, user_id) DO NOTHING RETURNING user_id`,
          [id, target.id, req.user.id]
        );
        if (inserted.length) {
          await notify(db, { userId: target.id, sourceUserId: req.user.id, kind: 'social_group_invite', detail: String(id) });
        }
        return { target, existing: !inserted.length, status: 'invited' };
      });
      if (!result) return res.status(404).json({ error: 'Group not found' });
      if (result.unavailable) return res.status(404).json({ error: 'User unavailable' });
      if (result.full) return res.status(409).json({ error: 'Group participant limit reached' });
      pushChanged(result.target.id);
      log.info('social', 'Group invite resolved', {
        groupId: id, by: req.user.id, target: result.target.id, status: result.status,
      });
      res.status(result.existing ? 200 : 201).json({
        ok: true, status: result.status, userId: result.target.id, username: result.target.username,
        alreadyInvited: result.existing,
      });
    } catch (err) {
      log.error('social', 'group invite failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/social/groups/:id/invites/accept', socialWriteLimiter, drainGuard, async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Invite not found' });
    try {
      const result = await withTransaction(pool, async (db) => {
        const { rows: groups } = await db.query(
          `SELECT g.owner_user_id FROM social_groups g
           JOIN social_group_members gm ON gm.group_id = g.id AND gm.user_id = $2
           WHERE g.id = $1 FOR UPDATE OF g`, [id, req.user.id]
        );
        const group = groups[0];
        if (!group) return null;
        await lockPair(db, req.user.id, group.owner_user_id);
        if (await blockedEitherWay(db, req.user.id, group.owner_user_id)) {
          await db.query(
            `DELETE FROM social_group_members WHERE group_id = $1 AND user_id = $2 AND status = 'invited'`,
            [id, req.user.id]
          );
          return null;
        }
        const { rows } = await db.query(
          `UPDATE social_group_members SET status = 'member', accepted_at = NOW()
            WHERE group_id = $1 AND user_id = $2 AND status = 'invited'
          RETURNING user_id`, [id, req.user.id]
        );
        if (rows.length) return { alreadyMember: false };
        const { rows: member } = await db.query(
          `SELECT 1 FROM social_group_members WHERE group_id = $1 AND user_id = $2 AND status = 'member'`,
          [id, req.user.id]
        );
        return member.length ? { alreadyMember: true } : null;
      });
      if (!result) return res.status(404).json({ error: 'Invite not found' });
      await pool.query(
        `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
          WHERE user_id = $1 AND kind = 'social_group_invite' AND detail = $2`,
        [req.user.id, String(id)]
      ).catch(() => {});
      log.info('social', 'Group invite accepted', { groupId: id, by: req.user.id });
      res.json({ ok: true, status: 'member', ...result });
    } catch (err) {
      log.error('social', 'group accept failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/social/groups/:id/invites/decline', socialWriteLimiter, drainGuard, async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Invite not found' });
    try {
      await pool.query(
        `DELETE FROM social_group_members WHERE group_id = $1 AND user_id = $2 AND status = 'invited'`,
        [id, req.user.id]
      );
      await pool.query(
        `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
          WHERE user_id = $1 AND kind = 'social_group_invite' AND detail = $2`,
        [req.user.id, String(id)]
      );
      res.json({ ok: true });
    } catch (err) {
      log.error('social', 'group decline failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/social/groups/:id/members/:userId', socialWriteLimiter, drainGuard, async (req, res) => {
    const id = positiveId(req.params.id);
    const target = positiveId(req.params.userId);
    if (!id || !target) return res.status(400).json({ error: 'Invalid group or user id' });
    try {
      const result = await withTransaction(pool, async (db) => {
        const { rows } = await db.query(
          `SELECT g.owner_user_id,
                  EXISTS (SELECT 1 FROM social_group_members me
                           WHERE me.group_id = g.id AND me.user_id = $2
                             AND me.status = 'member') AS requester_is_member
             FROM social_groups g WHERE g.id = $1 FOR UPDATE`, [id, req.user.id]
        );
        const group = rows[0];
        if (!group || (!group.requester_is_member && req.user.id !== group.owner_user_id)) {
          return { missing: true };
        }
        if (target === group.owner_user_id) return { owner: true };
        if (req.user.id !== group.owner_user_id && req.user.id !== target) return { denied: true };
        await db.query('DELETE FROM social_group_members WHERE group_id = $1 AND user_id = $2', [id, target]);
        return { ok: true };
      });
      if (result.missing) return res.status(404).json({ error: 'Group not found' });
      if (result.owner) return res.status(409).json({ error: 'Transfer ownership or delete the group first' });
      if (result.denied) return res.status(403).json({ error: 'Not allowed' });
      res.json({ ok: true });
    } catch (err) {
      log.error('social', 'group member removal failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/social/groups/:id/transfer', socialWriteLimiter, drainGuard, async (req, res) => {
    const id = positiveId(req.params.id);
    const target = positiveId(req.body?.userId);
    if (!id || !target || target === req.user.id) return res.status(400).json({ error: 'Invalid transfer target' });
    try {
      const result = await withTransaction(pool, async (db) => {
        const { rows } = await db.query(
          'SELECT owner_user_id FROM social_groups WHERE id = $1 FOR UPDATE', [id]
        );
        if (!rows.length || rows[0].owner_user_id !== req.user.id) return false;
        await lockPair(db, req.user.id, target);
        const { rows: members } = await db.query(
          `SELECT 1 FROM social_group_members
            WHERE group_id = $1 AND user_id = $2 AND status = 'member' FOR UPDATE`, [id, target]
        );
        if (!members.length || await blockedEitherWay(db, req.user.id, target)) return false;
        await db.query(
          'UPDATE social_groups SET owner_user_id = $1, updated_at = NOW() WHERE id = $2', [target, id]
        );
        return true;
      });
      if (!result) return res.status(404).json({ error: 'Group or eligible member not found' });
      pushChanged(target);
      log.info('social', 'Group ownership transferred', {
        groupId: id, by: req.user.id, target,
      });
      res.json({ ok: true, ownerUserId: target });
    } catch (err) {
      log.error('social', 'group transfer failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { socialRoutes, positiveId, pageArgs, groupName, pair, lockPair, MAX_GROUP_PARTICIPANTS };
