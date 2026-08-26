// Topochain v4 — partner API (SPEC §4.3, lines 834-840 for the group,
// 1320-1453 for the api.key middleware + each endpoint's exact contract,
// 883-895 for the §4.8 contract deltas that apply to every one of them).
//
// Mounted in server.js BEFORE authMiddleware: partner callers authenticate
// with a per-deployment shared secret (X-API-Key), never a platform
// session — every route in this group applies `partnerApiKey(config)`
// (src/middleware/topochain-auth.js) itself, so a 500 (unconfigured) or
// 401 (bad/missing key) happens before any route body runs.
//
// Judgment calls made here where the spec text was ambiguous (documented
// inline at the point of use, flagged again in the task report):
//   1. Naming/fallback deltas for POST /user-activities (SPEC §4.8 rule 7's
//      "bug fixes required, not optional" spirit, extended by the task
//      brief): v1's `phase_available_activity_id` (+ deprecated
//      `offchain_activity_type_id` alias, + literal fallback to challenge
//      id `1`) collapses to ONE v4 param, `challenge_id`, with NO fallback
//      chain at all. Since the stored activity_type is read off the
//      resolved challenge, an absent/invalid/wrong-event challenge_id
//      always 422s with the same "not available" message the source used
//      for a bad phase_available_activity_id — there is nothing left to
//      fall back to in v4.
//   2. Identifier resolution for POST /user-activities is taken literally
//      from SPEC 1330-1339's own request table: `identifier_type` is
//      REQUIRED (`in:email,telegram,discord`) and is "used directly as a
//      column name" — i.e. `WHERE <identifier_type> = $1` against `users`.
//      This is deliberately narrower than public.js's GET
//      /leaderboard/user-activities identifier resolution (SPEC 1108),
//      which also matches an onchain account address and has no
//      identifier_type param at all — that endpoint's broader semantics do
//      NOT apply here; this endpoint's own table wins (SPEC 1330-1339
//      exactly, per the task brief).
//   3. Enrollment check (400 "Participant is not registered for this
//      event.") accepts either an event-scoped `user_enrollments` row
//      (season_event_id = the given event) OR a season-wide one
//      (season_event_id IS NULL, season_id = the event's season) — the
//      same two-partial-unique shape `user_enrollments` itself is built
//      around (schema.sql) and the same fallback `onchain_accounts` and
//      public.js's leaderboard reads already use for season-wide grants.
//      SPEC 1330-1453 doesn't re-litigate this nuance for this endpoint;
//      it's the natural generalization of the enrollment model used
//      everywhere else in this migration.
//   4. `account_delegation_periods` is a HISTORY table: the partial
//      unique index `uq_account_delegation_periods_open` enforces SPEC
//      1451's real invariant — at most one OPEN period per account, any
//      number of closed ones. (Judgment call #4 originally shipped the
//      table spec's FULL unique on `account`, which forced PUT
//      /delegations/:account to overwrite the one row and made SPEC
//      1451's "full audit trail" unrepresentable; that constraint was
//      dropped when the admin console grew a per-account timeline.)
//      Turning delegation on INSERTS a fresh period; turning it off sets
//      `ended_at = NOW()` on the open one; closed rows are immutable.
//      Note history only accumulates from the schema change forward —
//      periods overwritten before it are gone.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../db/pool');
const log = require('../../services/logger');
const { partnerApiKey } = require('../../middleware/topochain-auth');
const {
  ok, fail, iso, num, paginate, meta, ValidationError,
} = require('./helpers');
const { readDelegationState, setDelegationState } = require('../../services/topochain/delegations');
const { managedEpochDelegationRoutes } = require('./epoch-delegation');

// ─── Small shared formatters ─────────────────────────────────────────────

// Path/query/body param -> positive integer id, or null (malformed/absent).
// Same strict round-trip-through-String() contract as public.js's toIntId.
function toIntId(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && String(n) === String(v).trim() ? n : null;
}

// `identifier_type` is validated against this exact allow-list (SPEC
// 1330-1339's `in:email,telegram,discord` rule) and then used only as a
// map lookup — never interpolated from the raw request value — before it
// ever reaches a SQL string, even though the three possible outputs here
// happen to equal their own keys.
const IDENTIFIER_COLUMNS = { email: 'email', telegram: 'telegram', discord: 'discord' };

// Laravel-style `boolean` rule (SPEC 1424: "accepts true, false, 1, 0,
// '1', '0'"). Anything else is not a valid boolean -> undefined (caller
// treats that as a validation failure).
function toBool(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return undefined;
}

function topochainPartnerRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.use(managedEpochDelegationRoutes(config));

  // Mount-order probe (plan Task 3). Deliberately NOT gated by
  // partnerApiKey — it exists only to prove this router sits ahead of
  // authMiddleware; every real endpoint below applies the key check
  // itself via `partnerApiKey(config)`.
  router.get('/api/v4/partner/__ping', (_req, res) => ok(res, {}));

  // ── POST /user-activities (SPEC 1322-1358, v1 POST /activities) ────
  //
  // NON-IDEMPOTENT BY CONTRACT (SPEC 1350, §4.8 rule 8 "carried quirks"):
  // every call inserts a new user_activities row, so a retried request
  // awards the points twice. v4 keeps this behavior verbatim; there is no
  // client-supplied idempotency key in this task's scope.
  router.post('/api/v4/user-activities', partnerApiKey(config), async (req, res) => {
    try {
      const body = req.body || {};
      const details = {};

      const participantIdentifier = typeof body.participant_identifier === 'string'
        ? body.participant_identifier.trim() : '';
      if (!participantIdentifier) details.participant_identifier = ['The participant_identifier field is required.'];

      const identifierType = body.identifier_type;
      if (!IDENTIFIER_COLUMNS[identifierType]) {
        details.identifier_type = ['The identifier_type field must be one of: email, telegram, discord.'];
      }

      const seasonEventId = toIntId(body.season_event_id);
      if (!seasonEventId) details.season_event_id = ['The season_event_id field is required.'];

      const activityType = body.activity_type;
      if (typeof activityType !== 'string' || activityType.length === 0 || activityType.length > 100) {
        details.activity_type = ['The activity_type field is required and must be a string of at most 100 characters.'];
      }

      // `points` is numeric and negatives are accepted (SPEC 1330) — only
      // reject non-numeric input, not sign or magnitude.
      const points = Number(body.points);
      if (body.points === undefined || body.points === null || body.points === '' || Number.isNaN(points)) {
        details.points = ['The points field is required and must be numeric.'];
      }

      const description = body.description == null ? null : String(body.description);

      let metadata = null;
      if (body.metadata !== undefined && body.metadata !== null) {
        if (typeof body.metadata !== 'object') {
          details.metadata = ['The metadata field must be an object.'];
        } else {
          metadata = body.metadata;
        }
      }

      let activityAt = null;
      if (body.activity_at === undefined || body.activity_at === null || body.activity_at === '') {
        details.activity_at = ['The activity_at field is required and must be a valid date.'];
      } else {
        const parsed = new Date(body.activity_at);
        if (Number.isNaN(parsed.getTime())) {
          details.activity_at = ['The activity_at field is required and must be a valid date.'];
        } else {
          activityAt = parsed;
        }
      }

      // `challenge_id` (renamed from v1's `phase_available_activity_id` —
      // see judgment call #1 above) is structurally optional but, per that
      // same judgment call, is functionally required in practice: an
      // absent value always falls into the 422 "not available" branch
      // below rather than any fallback.
      const challengeId = toIntId(body.challenge_id);

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      // SPEC 1330: `season_event_id` must `exists:season_events,id`.
      const { rows: eventRows } = await pool.query(
        'SELECT id, season_id FROM season_events WHERE id = $1',
        [seasonEventId]
      );
      const event = eventRows[0];
      if (!event) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { season_event_id: ['The selected season_event_id is invalid.'] },
        });
      }

      // Judgment call #2: identifier_type used directly as the column
      // name, no onchain-address fallback for this endpoint.
      const column = IDENTIFIER_COLUMNS[identifierType];
      const { rows: userRows } = await pool.query(
        `SELECT id FROM users WHERE ${column} = $1 LIMIT 1`,
        [participantIdentifier]
      );
      if (!userRows.length) {
        return fail(res, 404, 'Participant not found with the given identifier.');
      }
      const userId = Number(userRows[0].id);

      // Judgment call #3: event-scoped OR season-wide enrollment.
      const { rows: enrollRows } = await pool.query(
        `SELECT id FROM user_enrollments
          WHERE user_id = $1
            AND (season_event_id = $2 OR (season_event_id IS NULL AND season_id = $3))
          LIMIT 1`,
        [userId, seasonEventId, event.season_id]
      );
      if (!enrollRows.length) {
        return fail(res, 400, 'Participant is not registered for this event.');
      }

      // SPEC 1349's 422 ("challenge missing or belongs to another event")
      // is a BARE error object (no `details` key) — `fail()` already omits
      // `details`/`code` when not passed, so this one call produces that
      // exact shape. Judgment call #1: an absent challengeId lands here
      // too (nothing left to fall back to in v4).
      let challenge = null;
      if (challengeId) {
        const { rows: challengeRows } = await pool.query(
          `SELECT c.id, c.season_event_id, ct.category
             FROM challenges c
             LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
            WHERE c.id = $1`,
          [challengeId]
        );
        challenge = challengeRows[0] || null;
      }
      if (!challenge || Number(challenge.season_event_id) !== seasonEventId) {
        return fail(res, 422, 'Activity type is not available for the specified event.');
      }

      // The stored activity_type comes from the challenge's template
      // category; the submitted value is only a fallback for the (FK-
      // guarded, effectively unreachable) case where the template join
      // came back empty — mirrors public.js's own guard comment on the
      // same LEFT JOIN shape.
      const storedActivityType = challenge.category || activityType;

      const { rows: insertRows } = await pool.query(
        `INSERT INTO user_activities
           (user_id, season_event_id, activity_type, points, description, metadata,
            activity_at, source, challenge_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'api', $8, NOW(), NOW())
         RETURNING id, user_id, season_event_id, activity_type, points`,
        [userId, seasonEventId, storedActivityType, points, description,
          metadata ? JSON.stringify(metadata) : null, activityAt, challengeId]
      );
      const row = insertRows[0];

      return res.status(201).json({
        success: true,
        data: {
          id: Number(row.id),
          user_id: Number(row.user_id),
          season_event_id: Number(row.season_event_id),
          activity_type: row.activity_type,
          // SPEC 1358: v4 returns points as a number (source: string, from
          // the decimal cast).
          points: num(row.points),
        },
      });
    } catch (err) {
      log.error('topochain-partner', 'POST /user-activities failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /delegations (SPEC 1360-1389, v1 GET /delegations) ─────────
  //
  // v4 addition: pagination (SPEC 1389 "v4 should paginate" + §4.8 rule 6).
  // Still lists open periods only (ended_at IS NULL), oldest first.
  router.get('/api/v4/delegations', partnerApiKey(config), async (req, res) => {
    try {
      const { page, perPage } = paginate(req); // may throw ValidationError (422)

      const { rows: countRows } = await pool.query(
        'SELECT COUNT(*)::int AS c FROM account_delegation_periods WHERE ended_at IS NULL'
      );
      const total = countRows[0].c;

      const { rows } = await pool.query(
        `SELECT account, started_at FROM account_delegation_periods
          WHERE ended_at IS NULL
          ORDER BY started_at ASC, id ASC
          LIMIT $1 OFFSET $2`,
        [perPage, (page - 1) * perPage]
      );

      const data = rows.map((r) => ({ account: r.account, delegated_since: iso(r.started_at) }));

      // v1's bare `count` (SPEC 1379) is kept alongside the new `meta`
      // envelope rather than dropped — it's cheap to keep and some
      // partner client might already read it; `count` reflects THIS
      // page's row count (matches the source's behavior of `data.length`,
      // now capped by per_page instead of being unbounded).
      return ok(res, { data, count: data.length }, { meta: meta(page, perPage, total) });
    } catch (err) {
      if (err instanceof ValidationError) {
        return fail(res, err.status, err.message, { details: err.details, code: err.code });
      }
      log.error('topochain-partner', 'GET /delegations failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /delegations/{account} (SPEC 1391-1416) ─────────────────────
  router.get('/api/v4/delegations/:account', partnerApiKey(config), async (req, res) => {
    try {
      const account = req.params.account;

      const { rows: acctRows } = await pool.query(
        'SELECT address FROM onchain_accounts WHERE address = $1 LIMIT 1',
        [account]
      );
      if (!acctRows.length) return fail(res, 404, 'Unknown account address.');

      // Task 10 extracted this read into services/topochain/delegations.js
      // (readDelegationState) — same query, now shared with the mobile
      // group's GET /delegation.
      const state = await readDelegationState(pool, account);

      return ok(res, {
        data: {
          account,
          delegated: state.delegated,
          delegated_since: iso(state.delegatedSince),
        },
      });
    } catch (err) {
      log.error('topochain-partner', 'GET /delegations/:account failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── PUT /delegations/{account} (SPEC 1418-1453) ──────────────────────
  //
  // Idempotent, transactional, row-locked (SPEC 1449). Validation runs
  // BEFORE the account lookup (SPEC 1447: "a bad body on an unknown
  // account returns 422, not 404"). Judgment call #4 above explains why
  // this upserts a single row per account instead of inserting a new
  // history row on every re-assertion.
  router.put('/api/v4/delegations/:account', partnerApiKey(config), async (req, res) => {
    const account = req.params.account;
    const body = req.body || {};

    const delegated = toBool(body.delegated);
    if (body.delegated === undefined || delegated === undefined) {
      return fail(res, 422, 'The given data was invalid.', {
        details: { delegated: ['The delegated field is required and must be a boolean.'] },
      });
    }

    const client = await pool.connect();
    try {
      const { rows: acctRows } = await client.query(
        'SELECT address FROM onchain_accounts WHERE address = $1 LIMIT 1',
        [account]
      );
      if (!acctRows.length) return fail(res, 404, 'Unknown account address.');

      await client.query('BEGIN');
      try {
        // Task 10 extracted the toggle state machine itself into
        // services/topochain/delegations.js (setDelegationState) — same
        // queries as before, now shared with the mobile group's POST
        // /delegation. Only the transaction boundary + response/message
        // shaping stay here (they differ slightly between the two callers).
        const result = await setDelegationState(client, account, delegated);
        await client.query('COMMIT');

        return ok(res, {
          data: {
            account,
            delegated: result.delegated,
            changed: result.changed,
            delegated_since: iso(result.delegatedSince),
          },
          message: result.changed
            ? (delegated ? 'Account marked as delegated.' : 'Account unmarked as delegated.')
            : 'Delegation flag unchanged.',
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } catch (err) {
      log.error('topochain-partner', 'PUT /delegations/:account failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = { topochainPartnerRoutes };
