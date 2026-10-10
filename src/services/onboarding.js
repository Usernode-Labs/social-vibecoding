'use strict';

/**
 * Communities, stage 5: a new account's first run.
 *
 *   sign in → username → terms → "What communities do you want to join?"
 *           → Home.
 *
 * The first two steps were already there (frontend/src/features/auth/
 * username-first-run.js, frontend/src/features/settings/terms-first-run.js).
 * This module is the server half of the other two: which communities the
 * join screen offers and what answering it does. (Home's Getting started
 * card, which this module also served, left in #4635: a new account lands
 * on ordinary Home, and the season's First challenges render there as
 * ordinary challenge cards. The card's endpoints, its payload and the
 * `/api/auth/me` flag are gone with it; the columns in src/db/schema.sql
 * stay, because the Challenges tab's gate still reads them and admin
 * "Reset first run" still sets them.)
 *
 * ── Who is asked ────────────────────────────────────────────────────────
 *
 * `users.needs_communities_choice`, set TRUE wherever an account is made by
 * a person signing up (email, an activation code, a wallet) and FALSE for
 * everyone else, including every account that existed before the column and
 * every account the boot seeds: the join screen is for newcomers,
 * and a member who has been here a year has already found their
 * communities. See the note beside the column in src/db/schema.sql.
 *
 * ── What the screen offers ─────────────────────────────────────────────
 *
 * Homeroom first: the platform's own project, where the platform itself is
 * built. A new account with platform access is already in it (the
 * users_join_platform_community trigger), so it arrives ticked; unticking it
 * is how a newcomer says "not this one", and answering leaves it. Then any
 * group the person has been invited into, which is the reason somebody
 * signs up more often than not. Then the communities an admin has featured
 * (featured_apps, in its order: the same curated set Discover leads with),
 * and after them the open communities with the most members. Solo projects
 * and view-private apps are never offered: nobody can join those from
 * outside.
 *
 * "Skip for now" is an answer too: it joins and leaves nothing, and the
 * screen does not come back. Discover is where to join later.
 *
 * ── The tour ───────────────────────────────────────────────────────────
 *
 * Only whether it is done (`users.tour_done_at`) is recorded here, by
 * markTourDone below; the tour itself is all client
 * (frontend/src/features/home/tour). Home shows it from Settings' "Replay
 * the tour" and on a new account's first visit.
 */

const communities = require('./communities');

// How many communities the join screen lists. Homeroom and the invites come
// first, so this is the room left for the open communities.
const SUGGESTION_LIMIT = 8;
// The most the screen can join in one answer. It lists eight; the cap is
// only there so the endpoint is not a bulk-join API.
const MAX_JOIN = 20;

function iconUrl(row) {
  return row.icon_image_id ? `/app-icons/${row.icon_image_id}` : null;
}

// The longest description the join screen shows under a name: two lines on
// a phone. dapp.json's own field has no limit of its own.
const DETAIL_MAX = 100;

// A few words for the communities people are most likely to be offered,
// until each says what it is itself. When this was written none of the live
// apps' dapp.json had a `description`, so the join screen would have been a
// column of bare names. Keyed by slug, which a rename leaves alone (Game
// Corner is still puzzlechain-6cf8ff). A community's own line always wins:
// once its dapp.json says something, its entry here is never read, and can
// be dropped.
const STARTER_DETAILS = Object.freeze({
  'puzzlechain-6cf8ff': 'Daily puzzles and games',
  'mypage-777ed2': 'Decorate your own page',
  'community-tier-lists-57ce6a': 'Rank anything together',
  'recipebot-33b169': 'AI recipe helper',
  'todo-list-b91765': 'Shared to-do lists',
  'supply-line-rts-6408b2': 'Slow-paced strategy game',
  'gym-tracker-9de81f': 'Log your workouts',
});

// What the join screen says under a community's name. Homeroom says what
// joining it means; an invite says who sent it; anything else says what it
// is, in its own words: dapp.json's top-level `description`, the line
// Homeroom's About pane already shows (routes/platform-about.js), which a
// community sets and changes by a voted change like any other line there.
// Without one, its starter line if it has one, else nothing at all.
// "Community · N members" was the same words on every row, and the count
// said little about what the thing is. The count is back since, as a figure
// of its own at the row's end (`member_count`, drawn by
// frontend/src/features/auth/communities-first-run.js): beside these words,
// never instead of them.
function suggestionDetail(row) {
  if (row.self_hosted) return 'Contribute to the Homeroom platform';
  if (row.invited_by) return `Invited by @${row.invited_by}`;
  const own = typeof row.description === 'string' ? row.description.replace(/\s+/g, ' ').trim() : '';
  const text = own || STARTER_DETAILS[row.slug] || '';
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1).trimEnd()}…` : text;
}

/**
 * The communities the join screen lists, in its order. `showSelfHosted` is
 * the same rule every listing of the platform's own row applies (admins, or
 * the deployment's selfAppPublicVoting): where Homeroom is not listed
 * anywhere else, it is not offered here either.
 */
async function joinSuggestions(pool, userId, { showSelfHosted = false } = {}) {
  const members = '(SELECT COUNT(*) FROM community_members cm WHERE cm.community_id = a.community_id)';
  const { rows } = await pool.query(
    `SELECT a.id, a.slug, a.name, a.icon_emoji, a.icon_image_id, a.self_hosted,
            ${members}::int AS member_count,
            ${communities.audienceSql('a', members)} AS audience,
            EXISTS (SELECT 1 FROM community_members me
                     WHERE me.community_id = a.community_id AND me.user_id = $1) AS is_member,
            a.manifest_snapshot->>'description' AS description,
            inv.invited_by
       FROM apps a
       LEFT JOIN (
         SELECT c.app_id, u.username AS invited_by
           FROM app_collaborators c
           LEFT JOIN users u ON u.id = c.invited_by
          WHERE c.user_id = $1 AND c.status = 'invited'
       ) inv ON inv.app_id = a.id
       LEFT JOIN featured_apps fa ON fa.app_id = a.id
      WHERE a.community_id IS NOT NULL
        AND (
          (a.self_hosted AND $2::boolean)
          OR (NOT a.self_hosted AND inv.app_id IS NOT NULL)
          OR (NOT a.self_hosted AND a.status = 'running' AND a.view_visibility = 'public')
        )
      ORDER BY a.self_hosted DESC, (inv.app_id IS NOT NULL) DESC,
               (fa.app_id IS NOT NULL) DESC, fa.sort_order ASC NULLS LAST,
               member_count DESC, a.id ASC
      LIMIT $3`,
    [userId, !!showSelfHosted, SUGGESTION_LIMIT]
  );
  return rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    icon_url: iconUrl(row),
    icon_emoji: row.icon_emoji || null,
    self_hosted: !!row.self_hosted,
    audience: row.audience,
    member_count: Number(row.member_count) || 0,
    invited_by: row.invited_by || null,
    is_member: !!row.is_member,
    detail: suggestionDetail(row),
    // Ticked on arrival: what the person is already in (Homeroom, for any
    // account with platform access) and what they were invited into.
    checked: !!row.is_member || !!row.invited_by,
  }));
}

function parseJoin(raw) {
  if (!Array.isArray(raw)) return { error: 'join must be a list of project slugs' };
  const slugs = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) return { error: 'join must be a list of project slugs' };
    if (!slugs.includes(entry.trim())) slugs.push(entry.trim());
  }
  if (slugs.length > MAX_JOIN) return { error: `Pick at most ${MAX_JOIN}.` };
  return { slugs };
}

/**
 * Answer the join screen: join what was ticked, leave Homeroom if it was
 * unticked, and record the answer. Only what the screen could have offered
 * is honoured — an open community, an invite (accepted through the same
 * function the notification's Accept uses), Homeroom — and anything else in
 * the list is skipped rather than refused, because a community that closed
 * between the screen loading and the answer is not the person's mistake.
 *
 * `acceptInvite(appId)` is injected: the invite path lives with the
 * collaborator routes (services/collab-invites.js) and needs the caller.
 *
 * Every community joined here ends up pinned to Home, whichever branch
 * joins it: communities.join pins Homeroom and an open community, and the
 * accepted invite pins its project inside acceptInvite, as an invite link
 * does. The pin is how the vote digest and a proposal's notification find
 * a member, so an invite accepted here must not be the one join without it.
 *
 * `{ skip: true }` is "Skip for now": the answer is recorded and nothing is
 * joined or left.
 *
 * Returns `{ ok, joined: [slug], left: [slug] }`, or `{ ok: false, status,
 * error }`. A second answer is a 409 with `alreadyDone`, like the username
 * step's.
 */
async function answerJoin(pool, user, body, { showSelfHosted = false, acceptInvite } = {}) {
  const skip = !!(body && body.skip === true);
  const parsed = skip ? { slugs: [] } : parseJoin(body && body.join);
  if (parsed.error) return { ok: false, status: 400, error: parsed.error };

  const { rows: flag } = await pool.query(
    'SELECT needs_communities_choice FROM users WHERE id = $1', [user.id]);
  if (!flag[0] || flag[0].needs_communities_choice !== true) {
    return { ok: false, status: 409, error: 'You have already picked your communities.', alreadyDone: true };
  }

  const offered = await joinSuggestions(pool, user.id, { showSelfHosted });
  const bySlug = new Map(offered.map((c) => [c.slug, c]));
  // A community can be answered for that fell off the first eight (it was
  // listed when the screen loaded, and a new one has since overtaken it),
  // so an open community is re-checked on its own rather than only by
  // membership of the list.
  const { rows: found } = parsed.slugs.length ? await pool.query(
    `SELECT id, slug, name, community_id, created_by, self_hosted, status, view_visibility, collab_visibility
       FROM apps WHERE slug = ANY($1::text[])`,
    [parsed.slugs]
  ) : { rows: [] };

  // In the order the screen listed them, so the joined list reads the same
  // way the screen did.
  found.sort((a, b) => parsed.slugs.indexOf(a.slug) - parsed.slugs.indexOf(b.slug));
  const joined = [];
  const left = [];
  for (const app of found) {
    if (app.community_id == null) continue;
    const listed = bySlug.get(app.slug);
    if (app.self_hosted) {
      if (!showSelfHosted) continue;
      await communities.join(pool, app, user.id);
      joined.push(app.slug);
    } else if (listed && listed.invited_by && typeof acceptInvite === 'function') {
      // The same accept as the notification's, Home pin included.
      const result = await acceptInvite(app);
      if (result && result.ok) joined.push(app.slug);
    } else if (app.status === 'running' && app.view_visibility === 'public') {
      await communities.join(pool, app, user.id);
      joined.push(app.slug);
    }
  }

  // Homeroom unticked: the person is in it by default, and this screen is
  // where they said no.
  // Not on a skip: "not now" leaves everything as it was, Homeroom included.
  const self = offered.find((c) => c.self_hosted);
  if (!skip && self && self.is_member && !parsed.slugs.includes(self.slug)) {
    const { rows: selfRows } = await pool.query(
      'SELECT id, slug, created_by FROM apps WHERE slug = $1', [self.slug]);
    if (selfRows[0]) {
      const result = await communities.leave(pool, selfRows[0], user.id);
      if (result.ok) left.push(self.slug);
    }
  }

  // Joined or skipped is kept for the admin Journey page (#3369): the
  // memberships alone cannot tell "Skip for now" from a Join that kept only
  // what was already ticked.
  await pool.query(
    `UPDATE users
        SET needs_communities_choice = FALSE, communities_onboarded_at = NOW(),
            getting_started_seen = COALESCE(getting_started_seen, '{}'::jsonb)
                                   || jsonb_build_object('join_answer', $2::text)
      WHERE id = $1 AND needs_communities_choice = TRUE`,
    [user.id, skip ? 'skipped' : 'joined']
  );
  return { ok: true, joined, left };
}

/**
 * An admin's "Reset first run" (Admin → Users → ⋯): put an account back to a
 * new account's first run, so its next load shows the join screen, then the
 * tour. The tour's "done" is cleared here too (`tour_done_at`), so it
 * follows the join screen on every device, not just in the browser that
 * shows the screen (frontend/src/features/home/tour).
 *
 * It resets the first run and nothing the account owns: its communities,
 * Home tiles, username and terms answer stay as they are. The join screen
 * shows what it is already in, ticked. Returns `{ id, username }`, or null
 * when there is no such account.
 *
 * It also puts the account back behind the season's First-challenges gate
 * (`getting_started_gate`, and the gate closed again: `_unlocked_at`), as a
 * new account is, so the Challenges tab's locked state comes back whatever
 * the account was made before. That is how an admin tries the first run on
 * an existing account. Credits it already earned stay: a First challenge it
 * has done is still ticked.
 */
async function resetFirstRun(pool, userId) {
  const { rows } = await pool.query(
    `UPDATE users
        SET needs_communities_choice = TRUE,
            communities_onboarded_at = NULL,
            getting_started_closed_at = NULL,
            getting_started_seen = NULL,
            tour_done_at = NULL,
            getting_started_gate = TRUE,
            getting_started_unlocked_at = NULL
      WHERE id = $1
      RETURNING id, username`,
    [userId]
  );
  return rows[0] || null;
}

/**
 * The welcome tour's Finish and Skip, and a browser that finished it before
 * the account kept the answer copying its own flag here once. Idempotent: the
 * first finish is the one recorded, and a replay finished later changes
 * nothing.
 */
// How the tour ended, for the admin Journey page (#3369): Next on the last
// step, Skip, or a browser copying an older local "done" onto the account.
// Kept with the furthest step, the first time only, beside tour_done_at.
const TOUR_ENDS = Object.freeze(new Set(['finish', 'skip', 'backfill']));
const TOUR_MAX_STEP = 20;

function parseTourEnd(body) {
  const ended = body && TOUR_ENDS.has(body.ended) ? body.ended : null;
  const step = body && Number.isInteger(body.step) && body.step >= 0 && body.step <= TOUR_MAX_STEP
    ? body.step : null;
  return { ended, step };
}

async function markTourDone(pool, userId, body) {
  const { ended, step } = parseTourEnd(body);
  const marked = await pool.query(
    `UPDATE users
        SET tour_done_at = NOW(),
            getting_started_seen = CASE WHEN $2::text IS NULL THEN getting_started_seen
              ELSE COALESCE(getting_started_seen, '{}'::jsonb)
                   || jsonb_build_object('tour_ended', $2::text, 'tour_step', $3::int) END
      WHERE id = $1 AND tour_done_at IS NULL`,
    [userId, ended, step]
  );
  // #4604: the tour's last stop but one points at Messages, where Homeroom
  // bot says hello, once. Only on the first end (a replay greets nobody),
  // and not on a backfill, which is a browser reporting a tour ended long
  // ago. greetTourFinisher keeps the once-ever rule and never throws.
  if (marked && marked.rowCount > 0 && ended !== 'backfill') {
    void require('./homeroom-bot-dm').greetTourFinisher(pool, { userId });
  }
  return { ok: true };
}

module.exports = {
  SUGGESTION_LIMIT,
  MAX_JOIN,
  STARTER_DETAILS,
  joinSuggestions,
  suggestionDetail,
  parseJoin,
  answerJoin,
  markTourDone,
  resetFirstRun,
};
