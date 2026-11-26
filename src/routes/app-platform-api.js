'use strict';

const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { appPlatformAuth } = require('../middleware/app-llm-auth');
const { getPool } = require('../db/pool');
const governance = require('../services/governance');
const userDirectory = require('../services/user-directory');
const communities = require('../services/communities');
const appAccess = require('../services/app-access');
const accessTokens = require('../services/app-access-tokens');
const appAgent = require('../services/app-agent-oauth');
const { listPublicApps } = require('../services/public-app-directory');
const log = require('../services/logger');
const { countedVotePredicateSql } = require('../services/pr-vote-revision');

// App-facing read-only platform API. `/v1` is the stable contract; every
// unversioned path remains an alias for apps deployed before issue #1908.
// New breaking contracts get a new major path instead of changing these.
//
//   GET /api/app-platform/v1/apps
//   GET /api/app-platform/v1/governance/feed
//   GET /api/app-platform/v1/users/{lookup,search}
//   GET /api/app-platform/v1/members
//   GET|POST /api/app-platform/v1/access-tokens, DELETE …/access-tokens/:id
//
// Returns the CALLING app's own recent proposal/vote/merge activity so
// apps can render live "what's changing" strips and changelogs instead
// of hand-maintained shadow tables. Auth is the app's opaque per-app
// credential (apps.llm_proxy_token, injected into production
// containers as USERNODE_LLM_PROXY_TOKEN) behind the same private-IP
// gate as the LLM proxy — see appPlatformAuth in
// middleware/app-llm-auth.js. No user token: the feed contains only
// what any viewer of the app can already see in its vote panel, and
// the token → app-id resolution is itself the scoping (no slug
// parameter exists to tamper with).
//
// Status vocabulary (mapped from the chat_sessions lifecycle):
//   proposed — DB 'promoted' with zero votes cast yet (promotion opens
//              voting immediately; this is just "no one has voted").
//   voting   — DB 'promoted' with at least one vote.
//   merging  — DB 'merging' (claimed by the GitHub merge pipeline).
//   merged   — DB 'merged' (merged_at carries the time).
// 'active' / 'paused' / 'archived' rows are NEVER returned — private
// in-progress sessions must not leak, and auto-rejected proposals drop
// out of the feed exactly as they do from the vote panel.
//
// `eta` is the governed gate's windowEndsAt — the earliest time the
// proposal can auto-merge while a visibility-window or lazy-consensus
// clock is armed. It is an "earliest possible merge time", not a
// guarantee; null when no clock is running (e.g. approvals_required
// mode, or not enough support yet) and for merging/merged rows.

const API_ROOT = '/api/app-platform';
const API_V1_ROOT = `${API_ROOT}/v1`;

// Express accepts an array of equivalent paths. Registering every handler
// once keeps the versioned contract and its permanent legacy alias on the
// exact same implementation rather than asking two copies to stay in sync.
function v1Paths(suffix) {
  return [`${API_V1_ROOT}${suffix}`, `${API_ROOT}${suffix}`];
}

// Feed page-size bounds — same defaults/clamps as GET /api/apps/:slug/merged.
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const OPEN_STATUSES = ['promoted', 'merging'];
const ALL_STATUSES = ['promoted', 'merging', 'merged'];

// ?status=open|merged|all → the DB statuses to query. Unknown values
// fall back to 'all' (defensive; the param is a convenience filter).
function dbStatusesFor(filter) {
  if (filter === 'open') return OPEN_STATUSES;
  if (filter === 'merged') return ['merged'];
  return ALL_STATUSES;
}

// Wire status from a row: see the vocabulary block above.
function feedStatus(row) {
  if (row.status === 'merged') return 'merged';
  if (row.status === 'merging') return 'merging';
  const votes = (parseInt(row.yes_count, 10) || 0) + (parseInt(row.no_count, 10) || 0);
  return votes === 0 ? 'proposed' : 'voting';
}

// ISO-serialize a timestamp column (pg returns Date objects; mocked
// pools in tests may return strings) — null-safe.
function iso(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function appPlatformApiRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  const feedLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `app:${req.appPlatform?.appId || 'anon'}`,
    handler: (req, res) => {
      log.warn('app-platform-api', 'Rate-limited', { appId: req.appPlatform?.appId });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  const auth = appPlatformAuth(pool);

  const appsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `app:${req.appPlatform?.appId || 'anon'}`,
    handler: (req, res) => {
      log.warn('app-platform-api', 'App directory rate-limited', {
        appId: req.appPlatform?.appId,
      });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  // ── Public app directory (issue #1908) ─────────────────────────────
  //
  // Server-side replacement for apps that hard-coded the old public
  // platform hostname. The projection is shared with GET /api/public/apps:
  // view-private, self-hosted, and unusable deployments never appear, and
  // contributors use the platform's one canonical definition.
  //
  // The data is public, so no user token or grant is required. The app token
  // still makes the read attributable/rate-limitable and the private-IP gate
  // keeps this server-to-server API off the public edge. Staging has no app
  // token and must use deterministic fixtures, like other token-gated APIs.
  router.get(v1Paths('/apps'), auth, appsLimiter, async (req, res) => {
    const { appId } = req.appPlatform;
    try {
      const includeWallets = req.query.include_wallets !== '0';
      res.json({ apps: await listPublicApps(pool, { includeWallets }) });
    } catch (err) {
      log.error('app-platform-api', 'App directory failed', {
        appId, message: err.message,
      });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  // ── User directory (issue #1195) ──────────────────────────────────
  //
  //   GET /api/app-platform/users/lookup?username=<handle>
  //   GET /api/app-platform/users/search?q=<prefix>[&limit=]
  //
  // "Does this Homeroom handle exist?", so an app can validate an invite
  // or @-mention against the real platform roster instead of guessing
  // from the users it has already seen.
  //
  // Unlike the governance feed these read PLATFORM-WIDE state rather than
  // the calling app's own row, so they take the user-token variant of the
  // auth middleware: every lookup is attributable to a signed-in user of
  // this app, and the limiter keys on (app, user) so one app's chatty
  // user can't exhaust the budget for the rest.
  //
  // The reply is `{ id, username }` and nothing else — see the projection
  // note in services/user-directory.js. Existence of a handle is already
  // public (every username is a route key at /u/<username>); no profile
  // data, no email, no app-membership signal is inferable from either
  // endpoint.
  //
  // allowUserTokenOnly (#1213): staging previews hold the API's base URL
  // but no app token, so these two routes — and ONLY these — also accept
  // the caller's forwarded iframe token on its own. The token's audience
  // names the app it was minted for and the signature is verified against
  // that audience, so a preview gains exactly what its reviewer's browser
  // already has through the shell relay (/api/app-directory/users/*): a
  // per-user, ~1h, app-pinned read. The governance feed keeps the plain
  // app-token auth below.
  const directoryAuth = appPlatformAuth(pool, {
    requireUser: true,
    allowUserTokenOnly: true,
  });

  const directoryLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Per (app, user): a typeahead fires per keystroke, and one app's
    // heavy user must not rate-limit that app's other users.
    keyGenerator: (req) => `app:${req.appPlatform?.appId || 'anon'}` +
      `:user:${req.appPlatform?.userId || 'anon'}`,
    handler: (req, res) => {
      log.warn('app-platform-api', 'Directory rate-limited', {
        appId: req.appPlatform?.appId, userId: req.appPlatform?.userId,
      });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  router.get(v1Paths('/users/lookup'), directoryAuth, directoryLimiter,
    async (req, res) => {
      const { appId } = req.appPlatform;
      const username = userDirectory.normalizeUsername(req.query.username);
      if (username === null) {
        // Distinct from a miss: a miss is a 200 with found:false, so an
        // app can tell "no such handle" from "you sent nonsense".
        return res.status(400).json({
          ok: false,
          code: 'bad_request',
          message: 'username is required (1-255 characters).',
        });
      }
      try {
        const result = await userDirectory.lookupExact(pool, username);
        const body = { found: result.found, user: result.user };
        // Only present when it's true — a case-collided pair matched and
        // the caller should ask which one they meant.
        if (result.ambiguous) body.ambiguous = true;
        res.json(body);
      } catch (err) {
        log.error('app-platform-api', 'User lookup failed', { appId, message: err.message });
        res.status(500).json({ ok: false, error: 'Internal server error' });
      }
    });

  router.get(v1Paths('/users/search'), directoryAuth, directoryLimiter,
    async (req, res) => {
      const { appId } = req.appPlatform;
      try {
        const { users, hasMore } = await userDirectory.searchPrefix(
          pool, req.query.q, req.query.limit, { viewerId: req.appPlatform.userId ?? null }
        );
        res.json({ users, has_more: hasMore });
      } catch (err) {
        log.error('app-platform-api', 'User search failed', { appId, message: err.message });
        res.status(500).json({ ok: false, error: 'Internal server error' });
      }
    });

  // ── Members: who is in this project ───────────────────────────────
  //
  //   GET /api/app-platform/members[?limit=]
  //
  // "Everyone in the group", for a chore rota, a turn order, a "who's
  // coming" list. Without it an app guessed from the users it had seen,
  // plus a staging fixture of fake people, and a preview showed the fixture
  // and the check runner instead of the group (services/user-directory.js
  // listAppMembers has the case).
  //
  // Same auth as /users/*, user-token-only included, so a staging preview
  // asks with its reviewer's token and gets the project's REAL members: the
  // thing a member opening a preview wants to check. That is not preview
  // code reaching app data the reviewer cannot see. The token names the app
  // it was minted for, and only a MEMBER of that app gets an answer: people
  // the project's page already shows them as fellow members (its community
  // card names them). Anyone else (an admin looking in, the check runner)
  // gets 403 `not_a_member`, and the app shows its screen without the
  // roster.
  router.get(v1Paths('/members'), directoryAuth, directoryLimiter,
    async (req, res) => {
      const { appId, userId } = req.appPlatform;
      try {
        if (!(await communities.isMember(pool, appId, userId))) {
          return res.status(403).json({
            ok: false,
            code: 'not_a_member',
            message: 'Only members of this project can see who is in it.',
          });
        }
        const { members, hasMore } = await userDirectory.listAppMembers(
          pool, appId, req.query.limit
        );
        res.json({ members, has_more: hasMore });
      } catch (err) {
        log.error('app-platform-api', 'Member list failed', { appId, message: err.message });
        res.status(500).json({ ok: false, error: 'Internal server error' });
      }
    });

  // ── Personal access tokens: a member's own assistant ──────────────
  //
  //   GET    /api/app-platform/access-tokens        the caller's live tokens
  //   POST   /api/app-platform/access-tokens        { name } -> { token, … }
  //   DELETE /api/app-platform/access-tokens/:id    revoke one of them
  //
  // services/app-access-tokens.js has the whole rule; the door that checks
  // a token is services/edge-gate.js. The app's server asks on behalf of
  // the member who is using it, so these need BOTH credentials: the app's
  // own (production only, so a preview's unmerged code can never make a
  // token good for the live app) and that member's identity. A token only
  // ever acts as its own member on its own app's declared paths, which is
  // no more than the app already holds while that member has it open.
  const tokenAuth = appPlatformAuth(pool, { requireUser: true });
  const tokenLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `app:${req.appPlatform?.appId || 'anon'}` +
      `:user:${req.appPlatform?.userId || 'anon'}`,
    handler: (req, res) => res.status(429).json({ ok: false, code: 'rate_limited' }),
  });
  // Only a member of the project who may see the app holds tokens for it.
  const tokenMember = async (req, res, next) => {
    const { appId, userId } = req.appPlatform;
    try {
      if (!(await communities.isMember(pool, appId, userId))
          || !(await appAccess.isViewMember(pool, appId, userId))) {
        return res.status(403).json({
          ok: false,
          code: 'not_a_member',
          message: 'Only members of this project can use access tokens.',
        });
      }
      return next();
    } catch (err) {
      log.error('app-platform-api', 'Access token member check failed', { appId, message: err.message });
      return res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  };
  const tokenFail = (res, appId, what, err) => {
    log.error('app-platform-api', what, { appId, message: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  };

  router.get(v1Paths('/access-tokens'), tokenAuth, tokenLimiter, tokenMember,
    async (req, res) => {
      const { appId, userId, appSlug } = req.appPlatform;
      try {
        const vis = await appAccess.getHostVisibility(pool, appSlug);
        res.json({
          tokens: await accessTokens.list(pool, { appId, userId }),
          // Assistants this member approved in a browser
          // (services/app-agent-oauth.js): no token to show, only who.
          connections: await appAgent.list(pool, { appId, userId }),
          paths: vis?.agentPaths || [],
          max: accessTokens.MAX_PER_MEMBER,
        });
      } catch (err) { tokenFail(res, appId, 'Access token list failed', err); }
    });

  router.post(v1Paths('/access-tokens'), tokenAuth, tokenLimiter, tokenMember,
    require('express').json({ limit: '2kb' }),
    async (req, res) => {
      const { appId, userId, appSlug } = req.appPlatform;
      try {
        const vis = await appAccess.getHostVisibility(pool, appSlug);
        if (!vis?.agentPaths?.length) {
          return res.status(409).json({
            ok: false,
            code: 'no_agent_paths',
            message: 'This app declares no agentPaths in dapp.json, so a token would open nothing.',
          });
        }
        const made = await accessTokens.create(pool, { appId, userId, name: req.body?.name });
        if (made.error === 'name_required') {
          return res.status(400).json({ ok: false, code: 'name_required', message: 'Give the token a name.' });
        }
        if (made.error) {
          return res.status(409).json({
            ok: false,
            code: made.error,
            message: `A member can hold ${accessTokens.MAX_PER_MEMBER} tokens for one app. Revoke one first.`,
          });
        }
        res.set('Cache-Control', 'no-store');
        return res.status(201).json({ token: made.token, ...made.row, paths: vis.agentPaths });
      } catch (err) { return tokenFail(res, appId, 'Access token create failed', err); }
    });

  // Disconnect an assistant this member approved. Like a token's revoke, it
  // needs no member check: somebody who has left can still end their own.
  router.delete(v1Paths('/access-tokens/connections/:id'), tokenAuth, tokenLimiter,
    async (req, res) => {
      const { appId, userId } = req.appPlatform;
      try {
        const done = await appAgent.revoke(pool, { appId, userId, id: req.params.id });
        if (!done) return res.status(404).json({ ok: false, code: 'not_found' });
        return res.json({ ok: true });
      } catch (err) { return tokenFail(res, appId, 'Assistant disconnect failed', err); }
    });

  router.delete(v1Paths('/access-tokens/:id'), tokenAuth, tokenLimiter,
    async (req, res) => {
      // No member check: somebody who has left can still take their own
      // tokens away.
      const { appId, userId } = req.appPlatform;
      try {
        const done = await accessTokens.revoke(pool, { appId, userId, id: req.params.id });
        if (!done) return res.status(404).json({ ok: false, code: 'not_found' });
        return res.json({ ok: true });
      } catch (err) { return tokenFail(res, appId, 'Access token revoke failed', err); }
    });

  router.get(v1Paths('/governance/feed'), auth, feedLimiter, async (req, res) => {
    const { appId } = req.appPlatform;
    try {
      let limit = parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
      if (limit > MAX_LIMIT) limit = MAX_LIMIT;

      const statuses = dbStatusesFor(req.query.status);

      // Keyset cursor over (activity_at, id), same scheme as
      // /api/apps/:slug/merged: activity_at is COALESCE(merged_at,
      // promoted_at, created_at) — merged rows sort by merge time, open
      // rows by promotion time — with id as the tiebreaker. A cursor only
      // applies when BOTH parts parse cleanly; otherwise it's ignored and
      // the newest page is returned (defensive against malformed query
      // strings). Keyset (not OFFSET) because new activity inserts at the
      // top and would drift an offset between pages.
      const beforeRaw = req.query.before;
      const beforeIdRaw = parseInt(req.query.before_id, 10);
      const before = new Date(beforeRaw);
      const hasCursor = beforeRaw != null && !Number.isNaN(before.getTime())
        && Number.isFinite(beforeIdRaw);

      const activityExpr = 'COALESCE(cs.merged_at, cs.promoted_at, cs.created_at)';
      const params = [appId, statuses];
      let cursorClause = '';
      if (hasCursor) {
        cursorClause = `AND (${activityExpr}, cs.id) < ($3, $4)`;
        params.push(before.toISOString(), beforeIdRaw);
      }
      // Fetch limit+1 so an extra row signals there's another page.
      params.push(limit + 1);

      const { rows } = await pool.query(
        `SELECT cs.id, cs.pr_number, cs.pr_title, cs.pr_summary_md, cs.status,
                cs.promoted_at, cs.created_at, cs.merged_at, cs.votes_required,
                u.username AS author,
                ${activityExpr} AS activity_at,
                (SELECT COUNT(*)::int FROM pr_votes pv
                  WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                    AND ${countedVotePredicateSql('pv', 'cs')}) AS yes_count,
                (SELECT COUNT(*)::int FROM pr_votes pv
                  WHERE pv.session_id = cs.id AND pv.vote = 'no'
                    AND ${countedVotePredicateSql('pv', 'cs')}) AS no_count
           FROM chat_sessions cs
           LEFT JOIN users u ON u.id = cs.user_id
          WHERE cs.app_id = $1 AND cs.status = ANY($2::text[])
            ${cursorClause}
          ORDER BY ${activityExpr} DESC, cs.id DESC
          LIMIT $${params.length}`,
        params
      );

      let hasMore = false;
      if (rows.length > limit) {
        hasMore = true;
        rows.length = limit;
      }

      // Governed merge gate for the open rows — the exact pattern of the
      // /promoted serializer (routes/votes.js): under the default
      // settings this is the per-row mergeGate over the raw tallies;
      // under approver_policy='invited' the qualifying counts are
      // batch-fetched and the electorate is the approver roster; under
      // approvals_required=N the gate is the clock-free "at least N"
      // check (windowEndsAt null — no eta). All lookups are TTL-cached
      // in services/governance.js.
      const gates = new Map(); // session id -> gate
      const openRows = rows.filter((r) => r.status !== 'merged');
      if (openRows.length) {
        const gov = await governance.getGovernance(pool, appId);
        const electorate = await governance.getElectorate(pool, appId, gov);
        let qualifiedByRow = null;
        if (electorate.approverIds) {
          qualifiedByRow = await governance.qualifiedCountsBatch(
            pool, 'pr', openRows.map((r) => r.id), electorate.approverIds
          );
        }
        for (const row of openRows) {
          const q = qualifiedByRow
            ? (qualifiedByRow.get(row.id) || { yes: 0, no: 0 })
            : { yes: row.yes_count, no: row.no_count };
          gates.set(row.id, governance.computeGate(
            gov, electorate.active, q.yes, q.no,
            row.promoted_at || row.created_at
          ));
        }
      }

      const items = rows.map((row) => {
        const gate = gates.get(row.id) || null;
        const status = feedStatus(row);
        return {
          id: row.id,
          pr_number: row.pr_number ?? null,
          title: row.pr_title || `PR #${row.pr_number ?? row.id}`,
          summary_md: row.pr_summary_md || null,
          status,
          votes_for: parseInt(row.yes_count, 10) || 0,
          votes_against: parseInt(row.no_count, 10) || 0,
          // Open rows: the live governed threshold. Merged rows: the
          // at-merge snapshot (nullable for pre-#58 merges).
          votes_required: gate
            ? gate.required
            : (row.votes_required != null ? parseInt(row.votes_required, 10) : null),
          contested: gate ? !!gate.contested : false,
          // Earliest possible auto-merge time while a clock is armed —
          // only meaningful pre-pipeline ('merging' is imminent).
          eta: status === 'proposed' || status === 'voting'
            ? (gate?.windowEndsAt ?? null)
            : null,
          author: row.author || null,
          proposed_at: iso(row.promoted_at || row.created_at),
          merged_at: iso(row.merged_at),
        };
      });

      const last = rows[rows.length - 1];
      res.json({
        items,
        has_more: hasMore,
        next_cursor: hasMore && last
          ? { before: iso(last.activity_at), before_id: last.id }
          : null,
      });
    } catch (err) {
      log.error('app-platform-api', 'Governance feed failed', { appId, message: err.message });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = appPlatformApiRoutes;
// Exposed for tests (status mapping + filter resolution).
module.exports.feedStatus = feedStatus;
module.exports.dbStatusesFor = dbStatusesFor;
module.exports.v1Paths = v1Paths;
