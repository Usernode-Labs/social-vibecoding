'use strict';

/**
 * The first session for somebody who arrives on their own, rather than by
 * an invite link (that path is services/community-invites.js and
 * frontend/src/features/first-session): the signed-out landing tells the
 * story ("On Homeroom, communities make apps together.") and asks them to
 * get started, instead of pitching the waitlist.
 *
 * THE STORY LANDING IS A SWITCH, off unless an admin turns it on (Admin →
 * Waitlist), stored as the `first_session_story` platform setting and read
 * through a short cache like the invite tree's. It belongs with the
 * waitlist: "Get started" makes an account here, and while the waitlist is
 * the valve that account waits in the queue, so the landing should only
 * stop pointing at the waitlist when the waitlist stops being the way in.
 * The setting's value reaches the landing through
 * GET /api/public/waitlist/options (`story_landing`).
 */

const log = require('./logger');

const STORY_KEY = 'first_session_story';
const CACHE_MS = 10 * 1000;
const STORY_DESCRIPTION = 'Whether the signed-out landing tells the first-session story and asks '
  + 'people to get started, instead of pointing at the waitlist (services/first-session.js). '
  + 'Switched from Admin → Waitlist.';
const caches = new WeakMap();

/** The stored switch: { enabled, updatedAt, updatedBy }. Cached per pool; off when unreadable. */
async function readStorySetting(pool) {
  const cached = caches.get(pool);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.setting;
  try {
    const { rows } = await pool.query(
      `SELECT s.value, s.updated_at, u.username AS updated_by
         FROM platform_settings s
         LEFT JOIN users u ON u.id = s.updated_by
        WHERE s.key = $1`,
      [STORY_KEY]
    );
    const row = rows[0];
    const setting = {
      enabled: row ? row.value === 'true' : false,
      updatedAt: row ? row.updated_at || null : null,
      updatedBy: row ? row.updated_by || null : null,
    };
    caches.set(pool, { at: Date.now(), setting });
    return setting;
  } catch (err) {
    log.warn('first-session', 'Story landing setting read failed; showing the waitlist landing', { err: err.message });
    return { enabled: false, updatedAt: null, updatedBy: null };
  }
}

async function storyLandingEnabled(pool) {
  return (await readStorySetting(pool)).enabled;
}

/** Switch the story landing on or off as admin `actorId`. */
async function setStoryLanding(pool, { enabled, actorId = null }) {
  await pool.query(
    `INSERT INTO platform_settings (key, value, description, updated_at, updated_by)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [STORY_KEY, enabled ? 'true' : 'false', STORY_DESCRIPTION, actorId]
  );
  caches.delete(pool);
}

/**
 * A person who started from the story is not asked the join screen ("What
 * communities do you want to join?", services/onboarding.js): the first
 * thing they are asked is what to make. Their account answers it as
 * 'story' the moment it is made from the story's sheet, and a project made
 * from the first session's question answers it as 'made' for anyone who
 * still had it; communities_onboarded_at stays unset either way, so the
 * Getting started card stays out of their first session too. A no-op for
 * anyone who already answered it.
 */
async function answerJoinScreen(pool, userId, answer) {
  await pool.query(
    `UPDATE users
        SET needs_communities_choice = FALSE,
            getting_started_seen = COALESCE(getting_started_seen, '{}'::jsonb)
                                   || jsonb_build_object('join_answer', $2::text)
      WHERE id = $1 AND needs_communities_choice = TRUE`,
    [userId, answer]
  );
}
const answerJoinScreenByMaking = (pool, userId) => answerJoinScreen(pool, userId, 'made');

module.exports = {
  STORY_KEY,
  readStorySetting,
  storyLandingEnabled,
  setStoryLanding,
  answerJoinScreen,
  answerJoinScreenByMaking,
};
