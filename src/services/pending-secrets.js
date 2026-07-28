'use strict';

/**
 * DAO for `pending_secret_declarations` — the values that ride along
 * with a declaration PR while it is up for vote.
 *
 * WHY THIS EXISTS. Adding a brand-new env var needs two changes to land
 * together: the DECLARATION in `dapp.json` (only a merged PR can change
 * that file — services/rename-pr.js is its single writer) and the VALUE
 * in `app_secrets` / `platform_env_values`. Before this, those were two
 * separate governance acts: a dev session edited the manifest, and then
 * somebody remembered to set the value. This table lets ONE proposal
 * carry both, by parking the encrypted value here until
 * routes/votes.js finalizeMerge() writes it to the real store.
 *
 * Deliberately a sibling of `app-secrets.js` / `platform-env.js` rather
 * than an extension: it owns no deploy path at all. Nothing here is ever
 * read by mergeForDeploy() or dump-platform-env.js — the value only
 * becomes real when applyForSession() moves it into the scope's own
 * store, and from that moment the existing DAOs own it exclusively.
 *
 * The one exception is the staging preview (rawValuesForSession), which
 * injects NON-PRIVATE pending values into the proposal's OWN staging
 * build so a PR that adds a required secret can boot its own preview.
 * Private pending values are never propagated — same rule as
 * app-secrets.mergeForDeploy's private-in-staging branch.
 *
 * "Live" means the bound proposal is still in flight
 * (chat_sessions.status IN ('promoted','merging')). A row whose session
 * left those states is dead: it is lazily flipped to 'discarded' on
 * read, so no sweeper is required.
 */

const log = require('./logger');
const { encrypt, decrypt } = require('./secrets');

// Statuses a declaration PR can be in and still be considered "up for
// vote". Mirrors the findXPr() helpers in services/rename-pr.js.
const LIVE_SESSION_STATUSES = ['promoted', 'merging'];

/** Private values keep no last-4 — same rule as app-secrets/platform-env. */
function computeLast4(value, isPrivate) {
  if (isPrivate) return null;
  if (typeof value !== 'string' || !value.length) return null;
  return value.slice(-4);
}

/**
 * Normalize the declaration blob that gets written into the manifest AND
 * stored on the row. Keeping one normalizer means the JSONB column, the
 * PR diff, and the panel row can never disagree about what was proposed.
 *
 * `group` is platform-only (platform_env has a group; `secrets` doesn't)
 * and `staging_default` is app-only (nothing in platform_env reaches a
 * container, so a staging fallback would be meaningless) — but both are
 * simply carried as given; the caller decides which it fills.
 */
function normalizeDeclaration(input = {}) {
  const str = (v, max) => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (!t.length) return null;
    return t.slice(0, max);
  };
  return {
    description: typeof input.description === 'string' ? input.description.trim().slice(0, 400) : '',
    required: !!input.required,
    private: !!input.private,
    default: str(input.default, 2048),
    staging_default: str(input.staging_default, 2048),
    group: str(input.group, 48) || 'General',
  };
}

/**
 * Insert the pending row. `value` may be null (declaration-only, or an
 * admin-direct write that already landed — pass valueApplied: true for
 * that case so the panel can say "value set, declaration up for vote").
 */
async function create(pool, {
  appId, sessionId, scope, key, declaration,
  value = null, userId = null, dataKey, valueApplied = false,
} = {}) {
  const decl = normalizeDeclaration(declaration);
  const isPrivate = !!decl.private;
  const hasHeldValue = !valueApplied && typeof value === 'string' && value.length > 0;

  const { rows } = await pool.query(
    `INSERT INTO pending_secret_declarations
       (app_id, session_id, scope, key, declaration, value_enc, value_last4,
        value_applied_at, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     RETURNING id`,
    [
      appId, sessionId, scope === 'platform' ? 'platform' : 'app', key,
      JSON.stringify(decl),
      hasHeldValue ? encrypt(value, dataKey) : null,
      hasHeldValue ? computeLast4(value, isPrivate) : (valueApplied ? computeLast4(value, isPrivate) : null),
      valueApplied ? new Date() : null,
      userId,
    ]
  );
  return { id: rows[0].id, declaration: decl, private: isPrivate };
}

/**
 * Pending rows for an app whose declaration PR is still in flight.
 * Returns UI-shaped rows (never any plaintext — only the last-4 of a
 * non-private held value, exactly like the other two DAOs).
 *
 * Rows whose session has moved on are flipped to 'discarded' here rather
 * than by a sweeper: the panel is the only consumer that cares, and a
 * withdrawn proposal's value must stop being offered the moment its
 * session dies even if archiveSession's own cleanup was missed.
 */
async function listLive(pool, appId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.key, p.scope, p.declaration, p.value_enc IS NOT NULL AS has_held_value,
            p.value_last4, p.value_applied_at, p.created_at, p.session_id,
            cs.status AS session_status, cs.pr_number, cs.pr_url,
            u.username AS created_by_username
       FROM pending_secret_declarations p
       JOIN chat_sessions cs ON cs.id = p.session_id
       LEFT JOIN users u ON u.id = p.created_by
      WHERE p.app_id = $1 AND p.status = 'pending'
      ORDER BY p.key ASC`,
    [appId]
  );

  const live = [];
  const deadIds = [];
  for (const r of rows) {
    if (!LIVE_SESSION_STATUSES.includes(r.session_status)) {
      deadIds.push(r.id);
      continue;
    }
    const decl = r.declaration || {};
    live.push({
      key: r.key,
      scope: r.scope,
      declaration: decl,
      description: decl.description || '',
      required: !!decl.required,
      private: !!decl.private,
      default: decl.default != null ? decl.default : null,
      stagingDefault: decl.staging_default != null ? decl.staging_default : null,
      group: decl.group || 'General',
      hasValue: !!r.has_held_value || !!r.value_applied_at,
      valueApplied: !!r.value_applied_at,
      valueLast4: decl.private ? null : (r.value_last4 || null),
      sessionId: r.session_id,
      prNumber: r.pr_number || null,
      prUrl: r.pr_url || null,
      createdAt: r.created_at,
      createdBy: r.created_by_username || null,
    });
  }

  if (deadIds.length) {
    await pool.query(
      `UPDATE pending_secret_declarations SET status = 'discarded'
        WHERE id = ANY($1::int[]) AND status = 'pending'`,
      [deadIds]
    ).catch((err) => log.warn('pending-secrets', 'Lazy discard failed', { err: err.message }));
  }
  return live;
}

/** The dedupe check for the declare route: is this key already proposed? */
async function findLiveByKey(pool, appId, key) {
  const rows = await listLive(pool, appId);
  return rows.find((r) => r.key === key) || null;
}

/**
 * Which keys does THIS session propose, and does each carry a value the
 * merge would apply? Used by the platform-env pre-merge check so a
 * proposal that brings its own value doesn't block itself.
 */
async function keysForSession(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT key, scope, declaration, value_enc IS NOT NULL AS has_held_value,
            value_applied_at
       FROM pending_secret_declarations
      WHERE session_id = $1 AND status = 'pending'
      ORDER BY key ASC`,
    [sessionId]
  );
  return rows.map((r) => ({
    key: r.key,
    scope: r.scope,
    declaration: r.declaration || {},
    hasValue: !!r.has_held_value || !!r.value_applied_at,
  }));
}

/**
 * { KEY: plaintext } for the staging build of the proposal that declares
 * them. PRIVATE entries are omitted unless explicitly asked for (nothing
 * asks): a value worth encrypting at rest is worth keeping out of an
 * unreviewed PR's container — the same reasoning as
 * app-secrets.mergeForDeploy({ forStaging: true }).
 */
async function rawValuesForSession(pool, sessionId, dataKey, { includePrivate = false } = {}) {
  const out = {};
  if (!sessionId || !dataKey) return out;
  const { rows } = await pool.query(
    `SELECT key, declaration, value_enc
       FROM pending_secret_declarations
      WHERE session_id = $1 AND status = 'pending' AND value_enc IS NOT NULL`,
    [sessionId]
  );
  for (const r of rows) {
    const decl = r.declaration || {};
    if (decl.private && !includePrivate) continue;
    const v = decrypt(r.value_enc, dataKey);
    if (v != null) out[r.key] = v;
    else log.warn('pending-secrets', 'Decrypt returned null (skipping)', { key: r.key });
  }
  return out;
}

/**
 * Merge-time apply. Claims each pending row for this session with a
 * status flip so a re-run (recoverStuckMerges) can never double-apply,
 * then writes the held value into the scope's real store.
 *
 * Called from routes/votes.js finalizeMerge() BEFORE the production
 * rebuild: a newly `required` child-app secret whose value arrived with
 * the proposal must be stored before mergeForDeploy() looks for it, or
 * the merge would park the app in `awaiting_secrets` over its own change.
 *
 * Returns { applied: [{ key, scope, private, hadValue }] } — never the
 * value. Throws only on a DB failure; the caller logs and continues (a
 * GitHub merge has already happened and must not be rolled back).
 */
async function applyForSession(config, pool, sessionId) {
  const appSecrets = require('./app-secrets');
  const platformEnv = require('./platform-env');

  const { rows } = await pool.query(
    `UPDATE pending_secret_declarations
        SET status = 'applied'
      WHERE session_id = $1 AND status = 'pending'
      RETURNING id, app_id, scope, key, declaration, value_enc,
                value_applied_at, created_by`,
    [sessionId]
  );
  if (!rows.length) return { applied: [] };

  const applied = [];
  for (const r of rows) {
    const decl = r.declaration || {};
    const isPrivate = !!decl.private;
    let hadValue = !!r.value_applied_at;

    if (r.value_enc) {
      const plaintext = decrypt(r.value_enc, config.dataEncryptionKey);
      if (plaintext == null) {
        log.warn('pending-secrets', 'Pending value could not be decrypted (skipping write)', {
          key: r.key, sessionId,
        });
      } else if (r.scope === 'platform') {
        // Through the DAO so isWritableKey() is re-checked and the value
        // is re-encrypted with a fresh IV. `privateHint` is honoured only
        // when nothing declares the key yet, which is exactly the case
        // here: the declaration lands in platform_env_declarations on the
        // post-deploy boot's reconcile, not now.
        await platformEnv.setValue(pool, r.app_id, r.key, plaintext, {
          userId: r.created_by || null,
          dataKey: config.dataEncryptionKey,
          privateHint: isPrivate,
        });
        hadValue = true;
      } else {
        await appSecrets.setValue(pool, r.app_id, r.key, plaintext, {
          sensitive: isPrivate,
          userId: r.created_by || null,
          dataKey: config.dataEncryptionKey,
        });
        hadValue = true;
      }
      // Stamp the moment the value became real, and drop the ciphertext:
      // the row is an audit trail from here on, and keeping a second
      // encrypted copy of a live secret buys nothing.
      await pool.query(
        `UPDATE pending_secret_declarations
            SET value_enc = NULL, value_applied_at = COALESCE(value_applied_at, NOW())
          WHERE id = $1`,
        [r.id]
      );
    }

    applied.push({
      key: r.key,
      scope: r.scope,
      private: isPrivate,
      hadValue,
      appId: r.app_id,
      userId: r.created_by || null,
    });
  }

  log.info('pending-secrets', 'Applied pending declarations', {
    sessionId, keys: applied.map((a) => a.key),
  });
  return { applied };
}

/** Withdrawn / rejected proposal: the held value stops existing. */
async function discardForSession(pool, sessionId) {
  const { rowCount } = await pool.query(
    `UPDATE pending_secret_declarations
        SET status = 'discarded', value_enc = NULL
      WHERE session_id = $1 AND status = 'pending'`,
    [sessionId]
  );
  if (rowCount) {
    log.info('pending-secrets', 'Discarded pending declarations', { sessionId, count: rowCount });
  }
  return rowCount;
}

module.exports = {
  create,
  listLive,
  findLiveByKey,
  keysForSession,
  rawValuesForSession,
  applyForSession,
  discardForSession,
  normalizeDeclaration,
  computeLast4,
  LIVE_SESSION_STATUSES,
};
