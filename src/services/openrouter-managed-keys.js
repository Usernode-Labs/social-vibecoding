'use strict';

const log = require('./logger');
const credentialStore = require('./credential-store');
const managementClient = require('./openrouter-management-client');
const agentModels = require('./agent-models');
const agentPreferences = require('./agent-preferences');
const notifications = require('./notifications');
const limits = require('./limits');

const OPENROUTER = { provider: 'openrouter', purpose: 'coding_agent' };

// The reset cadence every company-funded key is issued with (#2119). Keys
// issued earlier were daily; syncAllowance brings them up to this.
const LIMIT_RESET = 'weekly';

// The `metadata.source` provisioning stamps on a company-funded credential,
// and the one value usesIncludedKey() below treats as company-funded.
const MANAGED_SOURCE = 'usernode_managed';

// #2119: the included key carries the platform's weekly allowance, the same
// figure the Claude side enforces as its weekly cap (limits.resolveCaps: an
// admin's per-user override, else the platform default).
//
// #2571 makes the two backends share one POOL, not just the number. The
// platform's own accounting is what enforces it: a turn run on this key is
// debited into the same `llm_usage` week-to-date total Claude spend lands in
// (src/routes/sessions.js), and checkBudget refuses the next turn on either
// backend once that total reaches the weekly cap. The remote limit set on
// the child key stays at the same figure and reset cadence, where it is now
// a provider-side backstop. It can refuse a request while the platform still
// shows room: OpenRouter checks its own spending limit and request budget,
// while the platform gate checks recorded spend at the start of a turn.
//
// #2568 removed the identity gate this used to apply on top: every account
// gets its included key when the account is created, so an account whose
// identity tier grants it nothing is no longer refused a key here. Zero is
// still a refusal, because minting an unlimited or zero-limit key is worse
// than not minting one — but it now means only what it says: an admin
// switched this account's weekly cap off.
async function resolveAllowance(pool, userId) {
  const cents = Math.max(0, Math.round(
    Number(await limits.getEffectiveUserWeeklyLimitCents(pool, userId)) || 0,
  ));
  return { cents, limitUsd: cents / 100, limitReset: LIMIT_RESET };
}

// #2571: is this account's OpenRouter coding-agent credential the COMPANY-
// FUNDED one? Only that key draws on the platform's shared weekly pool — a
// personal key the user pasted in is their own money and is metered by
// nobody here, exactly as a BYOK Anthropic key is. Provisioning stamps
// `source: 'usernode_managed'` on the credential's metadata (see
// provisionKey below), which is the authority; a read failure answers false,
// the non-punitive direction (no gate, no debit).
async function usesIncludedKey(pool, userId) {
  if (!userId) return false;
  try {
    const { rows } = await pool.query(
      `SELECT metadata->>'source' AS source
         FROM credentials.user_ai_credentials
        WHERE user_id = $1 AND provider = 'openrouter' AND purpose = 'coding_agent'
          AND status = 'valid'`,
      [userId],
    );
    return rows[0]?.source === MANAGED_SOURCE;
  } catch (err) {
    log.warn('openrouter-managed', 'included-key check failed; treating as personal', {
      userId, err: err.message,
    });
    return false;
  }
}

// QA 2026-09-24: what a PERSON is told when managed keys are not configured.
// The error's own message names the environment variable an operator has to
// set, which is exactly right in the server log and the admin console and
// meaningless in a toast over "Start work". The user-facing routes answer
// with this instead and log the original.
const NOT_CONFIGURED_USER_MESSAGE = "AI builds aren't available on this server yet. Ask an admin to finish setting them up.";

class ManagedOpenRouterError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'ManagedOpenRouterError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function managementOptions(config) {
  return {
    apiKey: config.openrouterManagementApiKey,
    baseUrl: config.openrouterApiBase,
    origin: config.openrouterOrigin,
  };
}

function publicState(row) {
  if (!row?.managed_key_id) return null;
  return {
    id: row.managed_key_id,
    status: row.managed_status,
    label: row.remote_label || null,
    // The column kept its pre-#2119 name; limitReset says what period the
    // amount covers.
    limitUsd: row.daily_limit_usd == null ? null : Number(row.daily_limit_usd),
    limitReset: row.limit_reset || null,
    issuedAt: row.issued_at || null,
    disabledAt: row.disabled_at || null,
    deletedAt: row.deleted_at || null,
  };
}

async function stateForUser(pool, userId) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
              SELECT 1 FROM user_social_identities identity
               WHERE identity.user_id = $1
            ) AS verified,
            managed.id AS managed_key_id,
            managed.status AS managed_status,
            managed.remote_key_hash,
            managed.remote_label,
            managed.workspace_id,
            managed.daily_limit_usd,
            managed.limit_reset,
            managed.last_error_code,
            managed.issued_at,
            managed.disabled_at,
            managed.deleted_at,
            managed.created_at,
            managed.updated_at,
            credential.status AS credential_status,
            credential.secret_last4
       FROM (SELECT 1) anchor
       LEFT JOIN credentials.managed_openrouter_keys managed
         ON managed.user_id = $1
       LEFT JOIN credentials.user_ai_credentials credential
         ON credential.id = managed.credential_id`,
    [userId],
  );
  return rows[0] || { verified: false };
}

async function notifyReviewAdmins(pool, args) {
  try {
    await notifications.notifyManagedOpenRouterReviewAdmins(pool, args);
  } catch (err) {
    log.warn('openrouter-managed', 'admin review notification failed', {
      sourceUserId: args.sourceUserId, managedKeyId: args.managedKeyId,
      err: err.message,
    });
  }
}

async function markNeedsReview(pool, id, userId, err) {
  const code = String(err?.code || 'provision_failed').slice(0, 64);
  await pool.query(
    `UPDATE credentials.managed_openrouter_keys
        SET status = 'needs_review', last_error_code = $2, updated_at = NOW()
      WHERE id = $1`,
    [id, code],
  ).catch(() => {});
  await notifyReviewAdmins(pool, {
    sourceUserId: userId, managedKeyId: id,
  });
}

async function chooseDefaultModel({ pool, userId, apiKey, config }) {
  try {
    const catalog = await agentModels.listOpenRouterModels({
      pool,
      userId,
      credentialRevision: 'managed-provision',
      apiKey,
      config,
      forceRefresh: true,
    });
    return catalog.recommendedModelId || config.openrouterDefaultCodexModel || null;
  } catch (err) {
    log.warn('openrouter-managed', 'model catalog unavailable during provisioning', {
      userId, err: err.message,
    });
    return config.openrouterDefaultCodexModel || null;
  }
}

async function provision({ pool, userId, config }) {
  if (!config.openrouterManagementApiKey) {
    throw new ManagedOpenRouterError(
      503,
      'not_configured',
      'Company OpenRouter keys are not configured yet. Ask an administrator to check USERNODE_OPENROUTER_MANAGEMENT_API_KEY.',
    );
  }
  // Resolved before the reservation so an account with nothing to draw on
  // does not spend its one lifetime issuance on a refusal.
  const allowance = await resolveAllowance(pool, userId);
  if (allowance.cents <= 0) {
    throw new ManagedOpenRouterError(
      403,
      'no_allowance',
      'This account has no included weekly allowance, so there is no company OpenRouter key to create. Add a personal OpenRouter key in Settings instead.',
    );
  }

  // Reserve the user's one lifetime issuance before the provider call. The
  // user row serializes concurrent claims. #2568 removed the optional
  // verified-identity policy that used to lock identity proofs here too: a
  // key is part of creating an account now, not something an account earns.
  const reservation = await credentialStore.withTransaction(pool, async (client) => {
    const owner = await client.query('SELECT id FROM users WHERE id = $1 AND anonymised_at IS NULL FOR UPDATE', [userId]);
    if (!owner.rows.length) throw new ManagedOpenRouterError(404, 'account_deleted', 'Account no longer exists.');
    const existingCredential = await credentialStore.readMetadata({
      pool: client, userId, ...OPENROUTER,
    });
    if (existingCredential?.status === 'valid') {
      throw new ManagedOpenRouterError(409, 'byok_configured', 'Remove your personal OpenRouter key before claiming the included key.');
    }
    const { rows } = await client.query(
      `INSERT INTO credentials.managed_openrouter_keys
         (user_id, workspace_id, daily_limit_usd, limit_reset, status)
       VALUES ($1, $2, $3, $4, 'provisioning')
       ON CONFLICT (user_id) DO NOTHING
       RETURNING id`,
      [userId, config.openrouterManagedWorkspaceId || null, allowance.limitUsd, LIMIT_RESET],
    );
    if (!rows.length) {
      throw new ManagedOpenRouterError(409, 'already_issued', 'This account has already received its company OpenRouter key.');
    }
    return rows[0];
  });

  let remote;
  try {
    remote = await managementClient.createKey({
      ...managementOptions(config),
      name: `usernode-user-${userId}`,
      limit: allowance.limitUsd,
      limitReset: LIMIT_RESET,
      workspaceId: config.openrouterManagedWorkspaceId || undefined,
    });
  } catch (err) {
    await markNeedsReview(pool, reservation.id, userId, err);
    throw new ManagedOpenRouterError(
      502,
      'provisioning_needs_review',
      'OpenRouter provisioning could not be confirmed. An admin has been notified; the request was not retried to avoid creating a duplicate key.',
    );
  }

  try {
    const { rows: recordedRows } = await pool.query(
      `UPDATE credentials.managed_openrouter_keys
          SET remote_key_hash = $2, remote_label = $3, updated_at = NOW()
        WHERE id = $1 AND status = 'provisioning'
        RETURNING id`,
      [reservation.id, remote.hash, remote.label],
    );
    if (!recordedRows.length) throw new Error('managed reservation unavailable after provider creation');
    const modelId = await chooseDefaultModel({ pool, userId, apiKey: remote.key, config });
    const saved = await credentialStore.withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM credentials.managed_openrouter_keys
          WHERE id = $1 AND user_id = $2 AND status = 'provisioning'
          FOR UPDATE`,
        [reservation.id, userId],
      );
      if (!rows.length) throw new Error('managed reservation changed during provisioning');
      const credential = await credentialStore.writeOpenRouterCodingAgentOnClient({
        client,
        userId,
        apiKey: remote.key,
        dataKey: config.dataEncryptionKey,
        metadata: {
          source: MANAGED_SOURCE,
          managedKeyId: reservation.id,
          keyInfo: {
            label: remote.label,
            limit: remote.limit,
            limitRemaining: remote.limitRemaining,
            limitReset: remote.limitReset,
          },
        },
      });
      await client.query(
        `UPDATE credentials.managed_openrouter_keys
            SET credential_id = $2, status = 'active', issued_at = NOW(),
                last_error_code = NULL, updated_at = NOW()
          WHERE id = $1`,
        [reservation.id, credential.id],
      );
      await agentPreferences.setDefaultBackend(client, userId, {
        backend: 'codex_openrouter', model: modelId, reasoningEffort: null,
      });
      return { credential, modelId };
    });

    agentModels.invalidateUser(userId);
    log.info('openrouter-managed', 'managed child key provisioned', {
      userId, managedKeyId: reservation.id, remoteHash: remote.hash,
    });
    return {
      revision: saved.credential.revision,
      defaultModel: saved.modelId,
      keyInfo: {
        label: remote.label,
        limit: remote.limit,
        limitRemaining: remote.limitRemaining,
        limitReset: remote.limitReset,
      },
      managed: { id: reservation.id, status: 'active' },
    };
  } catch (err) {
    const erased = await require('./account-deletion').recordLateManagedKey(pool, userId, remote.hash);
    if (!erased) await markNeedsReview(pool, reservation.id, userId, err);
    throw new ManagedOpenRouterError(
      500,
      'provisioning_needs_review',
      'The OpenRouter key was created but could not be saved safely. An admin has been notified to reconcile it.',
    );
  }
}

// #2568: the ONE place an account's included key is created. Every
// account-creation path calls it right after the user row is inserted, and
// the coding-agent preference read calls it again for anybody who arrived
// without one — an account created before this change, or one created while
// OpenRouter's management API was down.
//
// It never throws and it never blocks the caller's own success: signing up
// must not fail because a third-party key could not be minted. Every refusal
// is a named, logged skip, and the next lazy call tries again.
//
// Idempotence is provision()'s, not this function's: the reservation row is
// UNIQUE on user_id, so a second caller gets `already_issued` and a user who
// pasted a personal key gets `byok_configured`. Both are skips here.
async function ensureIncludedKey({ pool, userId, config, reason = 'signup' }) {
  if (!userId) return { created: false, skipped: 'no_user' };
  if (!config?.openrouterManagementApiKey) {
    return { created: false, skipped: 'not_configured' };
  }
  if (!config.codexOpenrouterEnabled) {
    return { created: false, skipped: 'backend_disabled' };
  }
  try {
    const meta = await credentialStore.readMetadata({ pool, userId, ...OPENROUTER });
    if (meta?.status === 'valid') return { created: false, skipped: 'already_configured' };
  } catch (err) {
    log.warn('openrouter-managed', 'included-key precheck failed; skipping', {
      userId, reason, err: err.message,
    });
    return { created: false, skipped: 'precheck_failed' };
  }
  try {
    const provisioned = await provision({ pool, userId, config });
    log.info('openrouter-managed', 'included key created for account', {
      userId, reason, managedKeyId: provisioned.managed?.id || null,
      model: provisioned.defaultModel || null,
    });
    return { created: true, provisioned };
  } catch (err) {
    const code = err instanceof ManagedOpenRouterError ? err.code : 'provision_failed';
    // `already_issued` and `byok_configured` are the concurrent-caller and
    // personal-key cases; everything else is a real failure this account will
    // retry the next time it opens the new-change screen.
    const expected = code === 'already_issued' || code === 'byok_configured';
    log[expected ? 'info' : 'warn'](
      'openrouter-managed',
      'included key not created',
      { userId, reason, code, err: err.message },
    );
    return { created: false, skipped: code };
  }
}

async function managedRowById(pool, id) {
  const { rows } = await pool.query(
    `SELECT managed.*, credential.status AS credential_status
       FROM credentials.managed_openrouter_keys managed
       LEFT JOIN credentials.user_ai_credentials credential
         ON credential.id = managed.credential_id
      WHERE managed.id = $1`,
    [id],
  );
  return rows[0] || null;
}

async function setDisabled({ pool, id, disabled, config, actorId }) {
  if (!config.openrouterManagementApiKey) {
    throw new ManagedOpenRouterError(503, 'not_configured', 'OpenRouter management is not configured.');
  }
  const row = await managedRowById(pool, id);
  if (!row) throw new ManagedOpenRouterError(404, 'not_found', 'Managed OpenRouter key not found.');
  if (row.status === 'deleted') throw new ManagedOpenRouterError(409, 'deleted', 'This managed key has already been deleted.');
  if (!row.remote_key_hash) throw new ManagedOpenRouterError(409, 'needs_review', 'This key has no confirmed OpenRouter hash and needs manual review.');

  await managementClient.setDisabled({
    ...managementOptions(config), hash: row.remote_key_hash, disabled,
  });
  try {
    await credentialStore.withTransaction(pool, async (client) => {
      const changed = await credentialStore.setStatusOnClient({
        client, userId: row.user_id, ...OPENROUTER,
        status: disabled ? 'disabled' : 'valid',
      });
      if (!changed) throw new Error('managed credential material is unavailable');
      await client.query(
        `UPDATE credentials.managed_openrouter_keys
            SET status = $2::varchar(24),
                disabled_at = CASE WHEN $2::varchar(24) = 'disabled' THEN NOW() ELSE NULL END,
                last_error_code = NULL, updated_at = NOW()
          WHERE id = $1`,
        [id, disabled ? 'disabled' : 'active'],
      );
    });
  } catch (err) {
    await markNeedsReview(pool, id, row.user_id, err);
    throw new ManagedOpenRouterError(500, 'needs_review', 'OpenRouter changed the key, but local state needs manual review.');
  }
  agentModels.invalidateUser(row.user_id);
  log.warn('openrouter-managed', disabled ? 'managed key disabled' : 'managed key enabled', {
    actorId, userId: row.user_id, managedKeyId: id, remoteHash: row.remote_key_hash,
  });
  return { id: Number(id), status: disabled ? 'disabled' : 'active' };
}

async function remove({ pool, id, config, actorId }) {
  if (!config.openrouterManagementApiKey) {
    throw new ManagedOpenRouterError(503, 'not_configured', 'OpenRouter management is not configured.');
  }
  const row = await managedRowById(pool, id);
  if (!row) throw new ManagedOpenRouterError(404, 'not_found', 'Managed OpenRouter key not found.');
  if (row.status === 'deleted') return { id: Number(id), status: 'deleted' };
  if (!row.remote_key_hash) throw new ManagedOpenRouterError(409, 'needs_review', 'This key has no confirmed OpenRouter hash and needs manual review.');

  await managementClient.deleteKey({
    ...managementOptions(config), hash: row.remote_key_hash,
  });
  try {
    await credentialStore.withTransaction(pool, async (client) => {
      await credentialStore.revokeOnClient({ client, userId: row.user_id, ...OPENROUTER });
      await client.query(
        `UPDATE credentials.managed_openrouter_keys
            SET status = 'deleted', deleted_at = NOW(), disabled_at = NULL,
                last_error_code = NULL, updated_at = NOW()
          WHERE id = $1`,
        [id],
      );
      await agentPreferences.setDefaultBackend(client, row.user_id, {
        backend: 'claude_code', model: null, reasoningEffort: null,
      });
    });
  } catch (err) {
    await markNeedsReview(pool, id, row.user_id, err);
    throw new ManagedOpenRouterError(500, 'needs_review', 'OpenRouter deleted the key, but local state needs manual review.');
  }
  agentModels.invalidateUser(row.user_id);
  log.warn('openrouter-managed', 'managed key deleted', {
    actorId, userId: row.user_id, managedKeyId: id, remoteHash: row.remote_key_hash,
  });
  return { id: Number(id), status: 'deleted' };
}

// #2119: the key mirrors an allowance that can change under it: a key issued
// before the weekly policy still resets daily at OpenRouter, an admin can
// change the user's weekly cap, the platform default can move. Rather than a
// boot-time sweep that talks to the provider for every row, each key is
// brought in line lazily, the next time its owner's credential status is
// read (the settings screen and the first-use build flow both read it), and
// eagerly when an admin sets that user's weekly cap or a coding turn starts.
// Best-effort with a short failure backoff: an outage must not strand an old
// limit until the next deployment. Successful targets are never memoized —
// lowering a cap and later restoring it must issue both changes. Concurrent
// reads of the same target share one PATCH. PATCH is idempotent, including
// when the provider succeeded but the local transaction failed.
// A zero allowance is never written to an issued key (neither zero nor
// unlimited is a limit this code will set): the key keeps its last amount,
// and an admin blocks or deletes it from Admin > Users.
const ALLOWANCE_SYNC_RETRY_MS = 60_000;
const allowanceSyncAttempts = new Map();

function syncable(state, config) {
  return Boolean(state?.managed_key_id
    && ['active', 'disabled'].includes(state.managed_status)
    && state.remote_key_hash
    && config?.openrouterManagementApiKey);
}

async function syncAllowance({ pool, userId, state, config, allowance }) {
  if (!syncable(state, config)) return state;
  const target = allowance || await resolveAllowance(pool, userId);
  const id = state.managed_key_id;
  const currentCents = Math.round(Number(state.daily_limit_usd) * 100);
  if (currentCents === target.cents && state.limit_reset === LIMIT_RESET) return state;
  if (target.cents <= 0) {
    log.warn('openrouter-managed', 'managed key keeps its last limit: the platform weekly allowance is zero', {
      userId, managedKeyId: id, remoteHash: state.remote_key_hash,
    });
    return state;
  }
  const now = Date.now();
  for (const [key, entry] of allowanceSyncAttempts) {
    if (!entry.pending && entry.retryAfter <= now) allowanceSyncAttempts.delete(key);
  }
  const attempt = `${id}:${target.cents}:${LIMIT_RESET}`;
  const previous = allowanceSyncAttempts.get(attempt);
  if (previous?.pending) return previous.pending;
  if (previous?.retryAfter > now) return state;

  const entry = {};
  allowanceSyncAttempts.set(attempt, entry);
  entry.pending = Promise.resolve().then(async () => {
    const synced = await applyAllowance({ pool, userId, state, config, target });
    if (synced === state) {
      entry.pending = null;
      entry.retryAfter = Date.now() + ALLOWANCE_SYNC_RETRY_MS;
    } else {
      allowanceSyncAttempts.delete(attempt);
    }
    return synced;
  });
  return entry.pending;
}

async function applyAllowance({ pool, userId, state, config, target }) {
  const id = state.managed_key_id;
  try {
    const remote = await managementClient.setLimit({
      ...managementOptions(config), hash: state.remote_key_hash,
      limit: target.limitUsd, limitReset: LIMIT_RESET,
    });
    await credentialStore.withTransaction(pool, async (client) => {
      await client.query(
        `UPDATE credentials.managed_openrouter_keys
            SET daily_limit_usd = $2, limit_reset = $3, updated_at = NOW()
          WHERE id = $1`,
        [id, target.limitUsd, LIMIT_RESET],
      );
      await credentialStore.mergeKeyInfoOnClient({
        client, userId, ...OPENROUTER,
        keyInfo: {
          limit: remote.limit,
          limitReset: remote.limitReset,
          ...(remote.limitRemaining == null ? {} : { limitRemaining: remote.limitRemaining }),
        },
      });
    });
    log.info('openrouter-managed', 'managed key limit synced to the platform weekly allowance', {
      userId, managedKeyId: id, remoteHash: state.remote_key_hash, limit: target.limitUsd,
    });
    return { ...state, daily_limit_usd: target.limitUsd, limit_reset: LIMIT_RESET };
  } catch (err) {
    log.warn('openrouter-managed', 'managed key allowance sync failed; the key keeps its current limit', {
      userId, managedKeyId: id, remoteHash: state.remote_key_hash, err: err.message,
    });
    return state;
  }
}

module.exports = {
  ManagedOpenRouterError,
  NOT_CONFIGURED_USER_MESSAGE,
  OPENROUTER,
  LIMIT_RESET,
  publicState,
  stateForUser,
  provision,
  resolveAllowance,
  ensureIncludedKey,
  usesIncludedKey,
  MANAGED_SOURCE,
  syncAllowance,
  setDisabled,
  remove,
};
