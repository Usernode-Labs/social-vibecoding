'use strict';

// Profile customization (issue #982) — the write half of the #profile
// screen plus the read that backs its "Completed challenges" section.
//
//   PATCH  /api/me/profile             display name / bio / github / x
//   POST   /api/me/avatar              raw image bytes -> user_avatars
//   DELETE /api/me/avatar              remove the picture
//   GET    /api/me/challenges/completed  the viewer's OWN completions
//
// Every route is me-scoped and 401s without a session, so this router is
// mounted AFTER authMiddleware in server.js. The public read side of an
// avatar is a separate, deliberately unauthenticated router
// (src/routes/avatars.js) — an <img> can't carry a session dance.
//
// WHAT IS NOT HERE: a username change. `users.username` is the login
// identifier, the address of the public builder page
// (#leaderboard/users/<username>), the resolution key for the seeded
// service identities, and is denormalized into `apps.admin_usernames`
// from repo dapp.json files — nothing on the platform can rename a user,
// not even an admin (routes/topochain/admin/users.js restricts its own
// writable set to email/telegram/discord/display_name/accept_logs). The
// display name is the supported way to change how your name appears.

const crypto = require('crypto');
const express = require('express');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { sniffImageType } = require('../services/attachments');
const { profileWriteLimiter } = require('../middleware/rate-limits');
const {
  buildChallengeRow,
  DONE_EXPR,
  MY_COUNT_SQL,
  MY_BLOCKS_SQL,
  ALL_CHALLENGE_WHERE,
} = require('./home-panels');
const { TEMPLATE_JOIN_COLUMNS_SQL } = require('./topochain/challenge-view');

// ─── Field limits ──────────────────────────────────────────────────────
//
// `display_name` is VARCHAR(255) in the schema (it predates this feature —
// the topochain merge added it). 40 is the LAYOUT budget, not the storage
// one: the same string renders in the standings row and the profile header,
// and neither truncates at 40 on a phone.
const MAX_DISPLAY_NAME = 40;
const MAX_BIO = 280;
// One leading '@' is stripped before this runs. Deliberately permissive
// enough for both GitHub and X handle rules without trying to be either
// vendor's exact validator — a handle that doesn't exist upstream is a
// dead link, not a security problem.
const HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/;

// Avatar bytes. The express.raw() limit below must sit ABOVE this so an
// over-size body gets the friendly 400 from validateAvatarUpload rather
// than the parser's opaque 413 — same reasoning as the feedback-screenshot
// route. GIF is rejected on purpose: nothing here decodes frames, and an
// animated avatar is not wanted on a shared surface.
const MAX_AVATAR_BYTES = 1024 * 1024;
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

// How many completed challenges the profile section renders. Production's
// whole Season 1 is 34 enabled challenges, so this never bites today; it
// exists so a season that accumulates hundreds can't turn one screen into
// an unbounded response.
const COMPLETED_LIMIT = 60;

// Pure (exported for tests): validate an uploaded avatar body.
// Returns { ok: true, contentType } or { ok: false, error }.
function validateAvatarUpload(data) {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    return { ok: false, error: 'Empty upload' };
  }
  if (data.length > MAX_AVATAR_BYTES) {
    return {
      ok: false,
      error: `Image too large (max ${Math.round(MAX_AVATAR_BYTES / 1024)} KB) — try a smaller photo`,
    };
  }
  const contentType = sniffImageType(data);
  if (!AVATAR_TYPES.has(contentType)) {
    return { ok: false, error: 'Profile picture must be a PNG, JPEG or WebP image' };
  }
  return { ok: true, contentType };
}

// Pure (exported for tests): normalize + validate the PATCH body.
// Only keys PRESENT in the body are returned in `fields`, so a partial
// update never blanks a field the client didn't send. An empty string is
// an explicit "clear this" and maps to NULL.
//
// Returns { fields: { column: value }, details: { field: [msg] } }.
// A non-empty `details` means reject the whole request — nothing is saved
// partially, which is what lets the sheet show errors inline and keep the
// user's other edits in the form.
function parseProfileFields(body) {
  const fields = {};
  const details = {};
  const src = (body && typeof body === 'object') ? body : {};

  if ('displayName' in src) {
    const raw = src.displayName;
    if (raw !== null && typeof raw !== 'string') {
      details.displayName = ['Display name must be text.'];
    } else {
      const value = String(raw ?? '').trim();
      if (/[\r\n]/.test(value)) {
        details.displayName = ['Display name cannot contain line breaks.'];
      } else if (value.length > MAX_DISPLAY_NAME) {
        details.displayName = [`Display name must be ${MAX_DISPLAY_NAME} characters or fewer.`];
      } else {
        fields.display_name = value === '' ? null : value;
      }
    }
  }

  if ('bio' in src) {
    const raw = src.bio;
    if (raw !== null && typeof raw !== 'string') {
      details.bio = ['Bio must be text.'];
    } else {
      const value = String(raw ?? '').trim();
      if (value.length > MAX_BIO) {
        details.bio = [`Bio must be ${MAX_BIO} characters or fewer.`];
      } else {
        fields.bio = value === '' ? null : value;
      }
    }
  }

  for (const key of ['github', 'x']) {
    if (!(key in src)) continue;
    const raw = src[key];
    if (raw !== null && typeof raw !== 'string') {
      details[key] = ['Handle must be text.'];
      continue;
    }
    // Strip ONE leading '@' — people paste "@octocat" out of habit.
    const value = String(raw ?? '').trim().replace(/^@/, '');
    if (value === '') {
      fields[key] = null;
    } else if (!HANDLE_RE.test(value)) {
      details[key] = ['That doesn’t look like a valid handle.'];
    } else {
      fields[key] = value;
    }
  }

  return { fields, details };
}

// The profile object echoed by PATCH and embedded in GET /api/auth/me, so
// both surfaces speak one shape and the client can swap `App.user` wholesale.
function shapeProfile(row) {
  return {
    displayName: row?.display_name ?? null,
    bio: row?.bio ?? null,
    avatarUrl: row?.avatar_id ? `/avatars/${row.avatar_id}` : null,
    links: {
      github: row?.github ?? null,
      x: row?.x ?? null,
    },
  };
}

// The season the profile's completed list is scoped to.
//
// DELIBERATELY NOT home-panels' fetchCurrentSeason: that one additionally
// requires `starts_at <= NOW() AND ends_at >= NOW()`, which is right for a
// "what's open right now" widget and wrong here. Production's only season
// (Season 1, is_active = TRUE) ended 2026-06-30, so the strict resolver
// returns null and every profile would show an empty list of completions
// people genuinely earned. This mirrors what the profile screen itself has
// always done client-side: the active season, else the newest one.
async function fetchProfileSeason(pool) {
  const { rows } = await pool.query(
    `SELECT id, name FROM seasons
      WHERE internal = FALSE AND is_active = TRUE
      ORDER BY starts_at DESC, id DESC LIMIT 1`
  );
  if (rows[0]) return rows[0];
  const { rows: fallback } = await pool.query(
    `SELECT id, name FROM seasons
      WHERE internal = FALSE
      ORDER BY starts_at DESC, id DESC LIMIT 1`
  );
  return fallback[0] || null;
}

function profileRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Shared me-scope gate. These routes are mounted after authMiddleware,
  // which already redirects/401s an anonymous browser — this is the
  // belt-and-braces check every other /api/me/* route also carries.
  const requireUser = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    return next();
  };

  // Re-read the columns the client renders, in one statement, so PATCH and
  // the avatar writes can all echo the post-write truth rather than
  // reconstructing it from the request.
  async function readProfile(userId) {
    const { rows } = await pool.query(
      `SELECT u.display_name, u.bio, u.github, u.x, av.id AS avatar_id
         FROM users u
         LEFT JOIN user_avatars av ON av.user_id = u.id
        WHERE u.id = $1`,
      [userId]
    );
    return shapeProfile(rows[0]);
  }

  // ── PATCH /api/me/profile ────────────────────────────────────────────
  router.patch(
    '/api/me/profile',
    requireUser,
    profileWriteLimiter,
    express.json({ limit: '16kb' }),
    async (req, res) => {
      const { fields, details } = parseProfileFields(req.body);
      if (Object.keys(details).length) {
        return res.status(400).json({ error: 'Some fields need fixing', details });
      }
      const columns = Object.keys(fields);
      if (!columns.length) {
        // Nothing to write (an empty body, or only unknown keys) — not an
        // error; echo current state so the client repaints identically.
        return res.json({ profile: await readProfile(req.user.id) });
      }
      try {
        const setClauses = columns.map((col, i) => `${col} = $${i + 2}`);
        await pool.query(
          `UPDATE users SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1`,
          [req.user.id, ...columns.map((col) => fields[col])]
        );
        log.info('profile', 'Profile updated', {
          userId: req.user.id, fields: columns,
        });
        return res.json({ profile: await readProfile(req.user.id) });
      } catch (err) {
        log.error('profile', 'Profile update failed', {
          userId: req.user.id, err: err.message,
        });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  // ── POST /api/me/avatar ──────────────────────────────────────────────
  // Raw bytes (application/octet-stream) — deliberately sidesteps the
  // global express.json() parser, same reasoning as the feedback
  // screenshot and dev-chat attachment uploads. The 2mb parser ceiling
  // sits above the 1 MB cap so an over-size body reaches
  // validateAvatarUpload and gets a sentence a human can act on.
  router.post(
    '/api/me/avatar',
    requireUser,
    profileWriteLimiter,
    express.raw({ type: 'application/octet-stream', limit: '2mb' }),
    async (req, res) => {
      try {
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const verdict = validateAvatarUpload(data);
        if (!verdict.ok) return res.status(400).json({ error: verdict.error });

        // Fresh id per upload: the URL is content-addressed and served
        // with a year-long immutable header, so replacing the bytes MUST
        // replace the id or every cache keeps the old picture forever.
        const id = crypto.randomBytes(16).toString('hex');
        const sha256 = crypto.createHash('sha256').update(data).digest('hex');
        await pool.query(
          `INSERT INTO user_avatars (id, user_id, content_type, size_bytes, data, sha256)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id) DO UPDATE
             SET id = EXCLUDED.id,
                 content_type = EXCLUDED.content_type,
                 size_bytes = EXCLUDED.size_bytes,
                 data = EXCLUDED.data,
                 sha256 = EXCLUDED.sha256,
                 created_at = NOW()`,
          [id, req.user.id, verdict.contentType, data.length, data, sha256]
        );
        log.info('profile', 'Avatar uploaded', {
          userId: req.user.id, bytes: data.length, contentType: verdict.contentType,
        });
        return res.json({ avatarUrl: `/avatars/${id}` });
      } catch (err) {
        log.error('profile', 'Avatar upload failed', {
          userId: req.user.id, err: err.message,
        });
        return res.status(500).json({ error: 'Upload failed' });
      }
    }
  );

  // ── DELETE /api/me/avatar ────────────────────────────────────────────
  // Idempotent: deleting when there is nothing to delete is a 200, not a
  // 404 — the client's "Remove photo" should never fail for a user who
  // double-tapped it.
  router.delete(
    '/api/me/avatar',
    requireUser,
    profileWriteLimiter,
    async (req, res) => {
      try {
        await pool.query('DELETE FROM user_avatars WHERE user_id = $1', [req.user.id]);
        log.info('profile', 'Avatar removed', { userId: req.user.id });
        return res.json({ avatarUrl: null });
      } catch (err) {
        log.error('profile', 'Avatar delete failed', {
          userId: req.user.id, err: err.message,
        });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  // ── GET /api/me/challenges/completed ─────────────────────────────────
  //
  // The challenges the VIEWER completed — not the ones an organiser marked
  // finished. `challenges.completed` is an organiser flag about the
  // challenge ("this one is over"); the profile screen used to filter on it
  // client-side, which is why every signed-in person saw 28 of production's
  // 34 live challenges listed as their own completions.
  //
  // Done-ness comes from DONE_EXPR — the same rule the home Challenges
  // widget uses — so a numeric challenge at 3 of 8 is correctly NOT done.
  // Scope is ALL_CHALLENGE_WHERE (organiser-finished and out-of-window
  // challenges included): a challenge that is over and that you completed
  // is exactly what belongs in this list.
  router.get('/api/me/challenges/completed', requireUser, async (req, res) => {
    try {
      const season = await fetchProfileSeason(pool);
      if (!season) {
        return res.json({ season: null, total: 0, done: 0, completed: [] });
      }

      const { rows } = await pool.query(
        `SELECT c.id, c.season_event_id, c.goal, c.task, c.reward,
                c.schedule_start, c.schedule_end,
                c.cta_label, c.cta_link,
                c.metric_type, c.metric_target, c.metric_label,
                c.enabled, c.completed, c.display_order, c.featured, c.featured_order,
                se.name AS event_name,
                ${TEMPLATE_JOIN_COLUMNS_SQL},
                ${MY_COUNT_SQL} AS my_activity_count,
                (SELECT COALESCE(SUM(ua.points), 0) FROM user_activities ua
                  WHERE ua.user_id = $1 AND ua.challenge_id = c.id) AS my_points,
                (SELECT MAX(ua.activity_at) FROM user_activities ua
                  WHERE ua.user_id = $1 AND ua.challenge_id = c.id) AS my_last_activity_at,
                ${MY_BLOCKS_SQL} AS my_blocks,
                ${DONE_EXPR} AS my_done
           FROM challenges c
           JOIN season_events se ON se.id = c.season_event_id
           LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
          WHERE se.season_id = $2 AND ${ALL_CHALLENGE_WHERE} AND (${DONE_EXPR})
          ORDER BY my_last_activity_at DESC NULLS LAST, c.id DESC
          LIMIT $3`,
        [req.user.id, season.id, COMPLETED_LIMIT + 1]
      );

      // Totals over the WHOLE in-scope set so the header's "N of M done"
      // is honest even when the row list is capped.
      const { rows: totalRows } = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE ${DONE_EXPR})::int AS done
           FROM challenges c
           JOIN season_events se ON se.id = c.season_event_id
           LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
          WHERE se.season_id = $2 AND ${ALL_CHALLENGE_WHERE}`,
        [req.user.id, season.id]
      );

      const truncated = rows.length > COMPLETED_LIMIT;
      if (truncated) {
        // Never silently drop rows — a capped list that reads as complete
        // is worse than a shorter one that says so.
        log.info('profile', 'Completed-challenge list truncated', {
          userId: req.user.id, seasonId: season.id, limit: COMPLETED_LIMIT,
        });
      }

      // A challenge whose template row vanished is skipped rather than
      // 500ing the section — the same guard the panel and public.js apply.
      const completed = rows
        .slice(0, COMPLETED_LIMIT)
        .filter((r) => r.t_id != null)
        .map((r) => ({
          ...buildChallengeRow(r),
          season_event_id: Number(r.season_event_id),
          event_name: r.event_name || null,
          activity_count: Number(r.my_activity_count) || 0,
          last_activity_at: r.my_last_activity_at
            ? new Date(r.my_last_activity_at).toISOString()
            : null,
        }));

      return res.json({
        season: { id: Number(season.id), name: season.name },
        total: totalRows[0]?.total ?? 0,
        done: totalRows[0]?.done ?? completed.length,
        completed,
        ...(truncated ? { truncated: true } : {}),
      });
    } catch (err) {
      log.error('profile', 'Completed-challenge read failed', {
        userId: req.user.id, err: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  profileRoutes,
  // Exported for tests.
  validateAvatarUpload,
  parseProfileFields,
  shapeProfile,
  fetchProfileSeason,
  MAX_DISPLAY_NAME,
  MAX_BIO,
  MAX_AVATAR_BYTES,
  COMPLETED_LIMIT,
};
