'use strict';

// Durable ownership proofs for external social accounts.
//
// The provider access token is intentionally absent from this module and
// from the schema. A token exists only long enough for the provider adapter
// to read the authenticated account's immutable id + current handle; this
// service persists that proof and nothing that can call the provider later.

const crypto = require('crypto');

const PROVIDERS = Object.freeze(['github', 'x']);
const PROVIDER_SET = new Set(PROVIDERS);
const OAUTH_INTENTS = Object.freeze(['connect', 'refresh', 'replace']);
const OAUTH_INTENT_SET = new Set(OAUTH_INTENTS);
const STATE_TTL_MS = 10 * 60 * 1000;
const REPLACEMENT_TTL_MS = 10 * 60 * 1000;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
const SUBJECT_RE = /^[1-9][0-9]{0,39}$/;
const HANDLE_RE = Object.freeze({
  github: /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/,
  x: /^[A-Za-z0-9_]{1,15}$/,
});

class SocialIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SocialIdentityError';
    this.code = code;
  }
}

function requireProvider(provider) {
  if (!PROVIDER_SET.has(provider)) {
    throw new SocialIdentityError('unsupported_provider', 'Unsupported social identity provider');
  }
  return provider;
}

function requireOauthIntent(intent) {
  if (!OAUTH_INTENT_SET.has(intent)) {
    throw new SocialIdentityError('invalid_intent', 'Invalid social identity action');
  }
  return intent;
}

function stateHash(state) {
  return crypto.createHash('sha256').update(state, 'utf8').digest('hex');
}

function codeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

// Replace any unfinished flow for this user+provider. Only a hash of the
// browser-visible state is stored; a database read cannot recover a usable
// callback value. The PKCE verifier stays server-side and is returned once
// by the atomic DELETE in consumeOauthState.
async function createOauthState(pool, { userId, provider, intent = 'connect' }) {
  requireProvider(provider);
  requireOauthIntent(intent);
  if (!Number.isInteger(Number(userId)) || Number(userId) <= 0) {
    throw new SocialIdentityError('invalid_user', 'Invalid user');
  }
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);

  // Clear expired states first (the expiry index keeps the global sweep
  // cheap), then replace this user's one pending state for the provider.
  await pool.query('DELETE FROM social_identity_oauth_states WHERE expires_at <= NOW()');
  await pool.query('DELETE FROM social_identity_pending_replacements WHERE expires_at <= NOW()');
  await pool.query(
    'DELETE FROM social_identity_pending_replacements WHERE user_id = $1 AND provider = $2',
    [Number(userId), provider]
  );
  await pool.query(
    `INSERT INTO social_identity_oauth_states
       (state_hash, user_id, provider, intent, pkce_verifier, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       state_hash = EXCLUDED.state_hash,
       intent = EXCLUDED.intent,
       pkce_verifier = EXCLUDED.pkce_verifier,
       created_at = NOW(),
       expires_at = EXCLUDED.expires_at`,
    [stateHash(state), Number(userId), provider, intent, verifier, expiresAt]
  );
  return { state, verifier, challenge: codeChallenge(verifier), expiresAt };
}

// Consume-before-exchange. A replay, expired state, cross-provider callback,
// or callback under a different signed-in Homeroom account deletes nothing
// and receives no verifier.
async function consumeOauthState(pool, { userId, provider, state }) {
  requireProvider(provider);
  if (typeof state !== 'string' || !STATE_RE.test(state)) return null;
  const { rows } = await pool.query(
    `DELETE FROM social_identity_oauth_states
      WHERE state_hash = $1
        AND user_id = $2
        AND provider = $3
        AND expires_at > NOW()
      RETURNING intent, pkce_verifier, expires_at`,
    [stateHash(state), Number(userId), provider]
  );
  if (!rows.length || typeof rows[0].pkce_verifier !== 'string') return null;
  return {
    intent: requireOauthIntent(rows[0].intent || 'connect'),
    verifier: rows[0].pkce_verifier,
    expiresAt: rows[0].expires_at,
  };
}

function normalizeIdentity(identity) {
  const provider = requireProvider(identity && identity.provider);
  const subject = String(identity && identity.subject || '');
  const handle = String(identity && identity.handle || '');
  if (!SUBJECT_RE.test(subject) || !HANDLE_RE[provider].test(handle)) {
    throw new SocialIdentityError('invalid_provider_identity', 'Provider returned an invalid identity');
  }
  return { provider, subject, handle };
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw err;
  } finally {
    client.release();
  }
}

async function lockUser(client, userId) {
  const { rows } = await client.query(
    'SELECT id FROM users WHERE id = $1 FOR UPDATE',
    [Number(userId)]
  );
  if (!rows.length) throw new SocialIdentityError('invalid_user', 'User no longer exists');
}

async function writeGithubCompatibility(client, userId, identity) {
  if (identity.provider !== 'github') return;
  // Preserve the established authorization-grade GitHub attribution readers
  // while the generic identity table remains the ownership source.
  await client.query(
    `UPDATE users
        SET github_login = $2,
            github_oauth_token_enc = NULL,
            github_linked_at = NOW()
      WHERE id = $1`,
    [Number(userId), identity.handle]
  );
}

async function writeIdentity(client, userId, identity, options = {}) {
  const replace = options.replace === true;
  const publicVisible = options.publicVisible !== false;
  let result;
  if (replace) {
    result = await client.query(
      `INSERT INTO user_social_identities
         (user_id, provider, provider_subject, handle, linked_at, last_verified_at, public_visible)
       VALUES ($1, $2, $3, $4, NOW(), NOW(), $5)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         provider_subject = EXCLUDED.provider_subject,
         handle = EXCLUDED.handle,
         linked_at = NOW(),
         last_verified_at = NOW(),
         public_visible = EXCLUDED.public_visible
       RETURNING provider, handle, linked_at, last_verified_at, public_visible`,
      [Number(userId), identity.provider, identity.subject, identity.handle, publicVisible]
    );
  } else {
    result = await client.query(
      `INSERT INTO user_social_identities
         (user_id, provider, provider_subject, handle, linked_at, last_verified_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (user_id, provider) DO UPDATE SET
         handle = EXCLUDED.handle,
         last_verified_at = NOW()
       RETURNING provider, handle, linked_at, last_verified_at, public_visible`,
      [Number(userId), identity.provider, identity.subject, identity.handle]
    );
  }
  await writeGithubCompatibility(client, userId, identity);
  return result.rows[0];
}

function identityInUseError() {
  return new SocialIdentityError(
    'identity_in_use',
    'That social account is already linked to another Homeroom account'
  );
}

// Complete an OAuth proof without weakening the immutable-subject boundary.
// A matching subject is a safe handle refresh. A different subject is never
// written from the callback: only an explicit replace flow may stage it for a
// second, same-origin confirmation while the old row remains authoritative.
async function finishIdentityVerification(pool, userId, rawIdentity, rawIntent = 'connect') {
  const identity = normalizeIdentity(rawIdentity);
  const intent = requireOauthIntent(rawIntent);
  try {
    return await withTransaction(pool, async (client) => {
      await lockUser(client, userId);
      const { rows: existingRows } = await client.query(
        `SELECT provider_subject, handle, public_visible
           FROM user_social_identities
          WHERE user_id = $1 AND provider = $2`,
        [Number(userId), identity.provider]
      );
      const existing = existingRows[0] || null;

      if (!existing) {
        if (intent !== 'connect') {
          throw new SocialIdentityError('not_linked', 'There is no connected account to change');
        }
        const row = await writeIdentity(client, userId, identity);
        return { outcome: 'linked', identity: row };
      }

      if (String(existing.provider_subject) === identity.subject) {
        const row = await writeIdentity(client, userId, identity);
        await client.query(
          'DELETE FROM social_identity_pending_replacements WHERE user_id = $1 AND provider = $2',
          [Number(userId), identity.provider]
        );
        return { outcome: 'refreshed', identity: row };
      }

      if (intent !== 'replace') {
        throw new SocialIdentityError(
          'different_account',
          'Use Change account to replace the currently connected identity'
        );
      }

      const { rows: owners } = await client.query(
        `SELECT user_id
           FROM user_social_identities
          WHERE provider = $1 AND provider_subject = $2 AND user_id <> $3
          LIMIT 1`,
        [identity.provider, identity.subject, Number(userId)]
      );
      if (owners.length) throw identityInUseError();

      const expiresAt = new Date(Date.now() + REPLACEMENT_TTL_MS);
      await client.query(
        `INSERT INTO social_identity_pending_replacements
           (user_id, provider, provider_subject, handle, created_at, expires_at)
         VALUES ($1, $2, $3, $4, NOW(), $5)
         ON CONFLICT (user_id, provider) DO UPDATE SET
           provider_subject = EXCLUDED.provider_subject,
           handle = EXCLUDED.handle,
           created_at = NOW(),
           expires_at = EXCLUDED.expires_at`,
        [Number(userId), identity.provider, identity.subject, identity.handle, expiresAt]
      );
      return {
        outcome: 'pending_replacement',
        provider: identity.provider,
        currentHandle: existing.handle,
        replacementHandle: identity.handle,
        expiresAt,
      };
    });
  } catch (err) {
    if (err && err.code === '23505') throw identityInUseError();
    throw err;
  }
}

// Backward-compatible adapter seam. Direct saves may connect a new identity
// or refresh the same subject; replacing a different subject still requires
// the explicit OAuth + confirmation path above.
async function saveIdentity(pool, userId, rawIdentity) {
  const result = await finishIdentityVerification(pool, userId, rawIdentity, 'connect');
  return result.identity;
}

async function confirmIdentityReplacement(pool, userId, provider, publicVisible) {
  requireProvider(provider);
  if (typeof publicVisible !== 'boolean') {
    throw new SocialIdentityError('invalid_visibility', 'Profile visibility must be true or false');
  }
  try {
    return await withTransaction(pool, async (client) => {
      await lockUser(client, userId);
      const { rows: currentRows } = await client.query(
        `SELECT provider_subject
           FROM user_social_identities
          WHERE user_id = $1 AND provider = $2
          FOR UPDATE`,
        [Number(userId), provider]
      );
      if (!currentRows.length) {
        throw new SocialIdentityError('not_linked', 'That account is no longer connected');
      }
      const { rows } = await client.query(
        `SELECT provider_subject, handle
           FROM social_identity_pending_replacements
          WHERE user_id = $1 AND provider = $2 AND expires_at > NOW()
          FOR UPDATE`,
        [Number(userId), provider]
      );
      if (!rows.length) {
        throw new SocialIdentityError(
          'replacement_expired',
          'That verified replacement expired. Start Change account again'
        );
      }
      const identity = normalizeIdentity({
        provider,
        subject: rows[0].provider_subject,
        handle: rows[0].handle,
      });
      const { rows: owners } = await client.query(
        `SELECT user_id
           FROM user_social_identities
          WHERE provider = $1 AND provider_subject = $2 AND user_id <> $3
          LIMIT 1`,
        [provider, identity.subject, Number(userId)]
      );
      if (owners.length) throw identityInUseError();
      const row = await writeIdentity(client, userId, identity, {
        replace: true,
        publicVisible,
      });
      await client.query(
        'DELETE FROM social_identity_pending_replacements WHERE user_id = $1 AND provider = $2',
        [Number(userId), provider]
      );
      return row;
    });
  } catch (err) {
    if (err && err.code === '23505') throw identityInUseError();
    throw err;
  }
}

async function discardIdentityReplacement(pool, userId, provider) {
  requireProvider(provider);
  const result = await pool.query(
    'DELETE FROM social_identity_pending_replacements WHERE user_id = $1 AND provider = $2',
    [Number(userId), provider]
  );
  return result.rowCount > 0;
}

async function setProfileVisibility(pool, userId, provider, publicVisible) {
  requireProvider(provider);
  if (typeof publicVisible !== 'boolean') {
    throw new SocialIdentityError('invalid_visibility', 'Profile visibility must be true or false');
  }
  const { rows } = await pool.query(
    `UPDATE user_social_identities
        SET public_visible = $3
      WHERE user_id = $1 AND provider = $2
      RETURNING provider, handle, linked_at, last_verified_at, public_visible`,
    [Number(userId), provider, publicVisible]
  );
  if (!rows.length) throw new SocialIdentityError('not_linked', 'That account is not connected');
  return rows[0];
}

async function clearIdentity(pool, userId, provider) {
  requireProvider(provider);
  return withTransaction(pool, async (client) => {
    // Match saveIdentity's user-row lock so a callback completing at the
    // same moment as a disconnect has one deterministic winner. Also
    // invalidate any unfinished flow: "Disconnect" must not leave a
    // browser callback capable of silently restoring the proof later.
    const { rows: users } = await client.query(
      'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      [Number(userId)]
    );
    if (!users.length) throw new SocialIdentityError('invalid_user', 'User no longer exists');
    await client.query(
      'DELETE FROM social_identity_oauth_states WHERE user_id = $1 AND provider = $2',
      [Number(userId), provider]
    );
    await client.query(
      'DELETE FROM social_identity_pending_replacements WHERE user_id = $1 AND provider = $2',
      [Number(userId), provider]
    );
    const result = await client.query(
      'DELETE FROM user_social_identities WHERE user_id = $1 AND provider = $2',
      [Number(userId), provider]
    );
    if (provider === 'github') {
      await client.query(
        `UPDATE users
            SET github_login = NULL,
                github_oauth_token_enc = NULL,
                github_linked_at = NULL
          WHERE id = $1`,
        [Number(userId)]
      );
    }
    return result.rowCount > 0;
  });
}

// When did this user last start an OAuth round-trip that never came back?
// Providers reject a misregistered redirect_uri on their own page and never
// call us back, so the unconsumed state row is the only server-side trace
// of that failure (#1291). Timestamps only — hashes and verifiers stay put.
async function pendingStateInfo(pool, userId) {
  const { rows } = await pool.query(
    `SELECT provider, created_at
       FROM social_identity_oauth_states
      WHERE user_id = $1 AND expires_at > NOW()`,
    [Number(userId)]
  );
  const pending = {};
  for (const row of rows) {
    if (PROVIDER_SET.has(row.provider) && row.created_at) {
      pending[row.provider] = new Date(row.created_at).toISOString();
    }
  }
  return pending;
}

async function pendingReplacementInfo(pool, userId) {
  const { rows } = await pool.query(
    `SELECT provider, handle, created_at, expires_at
       FROM social_identity_pending_replacements
      WHERE user_id = $1 AND expires_at > NOW()`,
    [Number(userId)]
  );
  const pending = {};
  for (const row of rows) {
    if (!PROVIDER_SET.has(row.provider)
        || !HANDLE_RE[row.provider].test(String(row.handle || ''))) continue;
    pending[row.provider] = {
      handle: row.handle,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    };
  }
  return pending;
}

function serializeIdentity(row) {
  return {
    provider: row.provider,
    linked: true,
    handle: row.handle,
    linkedAt: row.linked_at ? new Date(row.linked_at).toISOString() : null,
    lastVerifiedAt: row.last_verified_at
      ? new Date(row.last_verified_at).toISOString()
      : null,
    creditEligible: true,
    reconnectRequired: false,
    access: 'identity',
    publicVisible: row.public_visible !== false,
  };
}

// The old users.github_login link remains valid for GitHub attribution, but
// it has no immutable subject. Report it honestly and require one reconnect
// before it can unlock a social-identity credit tier.
async function identityStatus(pool, userId) {
  const [{ rows: identityRows }, { rows: userRows }] = await Promise.all([
    pool.query(
      `SELECT provider, handle, linked_at, last_verified_at, public_visible
         FROM user_social_identities
        WHERE user_id = $1
        ORDER BY provider`,
      [Number(userId)]
    ),
    pool.query(
      'SELECT github_login, github_linked_at FROM users WHERE id = $1',
      [Number(userId)]
    ),
  ]);

  const statuses = {
    github: {
      provider: 'github', linked: false, handle: null, linkedAt: null,
      lastVerifiedAt: null, creditEligible: false, reconnectRequired: false,
      access: 'identity', publicVisible: false,
    },
    x: {
      provider: 'x', linked: false, handle: null, linkedAt: null,
      lastVerifiedAt: null, creditEligible: false, reconnectRequired: false,
      access: 'identity', publicVisible: false,
    },
  };
  for (const row of identityRows) statuses[row.provider] = serializeIdentity(row);

  const legacy = userRows[0];
  if (!statuses.github.linked && legacy && legacy.github_login) {
    statuses.github = {
      provider: 'github',
      linked: true,
      handle: legacy.github_login,
      linkedAt: legacy.github_linked_at
        ? new Date(legacy.github_linked_at).toISOString()
        : null,
      lastVerifiedAt: null,
      creditEligible: false,
      reconnectRequired: true,
      access: 'identity',
      publicVisible: false,
    };
  }
  return statuses;
}

// The public-profile boundary deliberately has its own, narrower reader.
// identityStatus also reports a legacy GitHub attribution as "linked" so the
// settings screen can ask its owner to reconnect. That legacy row has no
// immutable provider subject and is therefore NOT an ownership proof. Public
// profile links come only from user_social_identities, which is written by the
// provider OAuth callbacks above.
async function verifiedProfileLinks(pool, userId) {
  const { rows } = await pool.query(
    `SELECT provider, handle
       FROM user_social_identities
      WHERE user_id = $1 AND public_visible = TRUE
      ORDER BY provider`,
    [Number(userId)]
  );
  const links = { github: null, x: null };
  for (const row of rows) {
    if (PROVIDER_SET.has(row.provider) && HANDLE_RE[row.provider].test(String(row.handle || ''))) {
      links[row.provider] = row.handle;
    }
  }
  return links;
}

module.exports = {
  PROVIDERS,
  OAUTH_INTENTS,
  STATE_TTL_MS,
  REPLACEMENT_TTL_MS,
  STATE_RE,
  SUBJECT_RE,
  HANDLE_RE,
  SocialIdentityError,
  stateHash,
  codeChallenge,
  createOauthState,
  consumeOauthState,
  pendingStateInfo,
  pendingReplacementInfo,
  normalizeIdentity,
  saveIdentity,
  finishIdentityVerification,
  confirmIdentityReplacement,
  discardIdentityReplacement,
  setProfileVisibility,
  clearIdentity,
  identityStatus,
  verifiedProfileLinks,
};
