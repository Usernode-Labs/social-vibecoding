'use strict';

/**
 * Sign in with Apple and Google, beside the email code.
 *
 * SET UP IN THE ADMIN CONSOLE, NOT IN THE ENVIRONMENT. An admin pastes each
 * provider's keys into Admin → Sign-in providers (sign_in_providers, one row
 * per provider), and a provider is offered on the sign-in sheet only once
 * its row is complete AND switched on, and the server knows its own
 * canonical origin (config.cliAuthOrigin), which is where the provider sends
 * people back to. Nothing is offered on a staging preview: it has no
 * canonical origin, the table is staging:private, and the data key a preview
 * runs with could not read production's secrets anyway.
 *
 *   Google  a Web OAuth client: client ID and client secret.
 *   Apple   a Services ID (the client ID), the team ID, and a Sign in with
 *           Apple key: its ID and the .p8 private key, which signs a
 *           short-lived client secret for each exchange (appleClientSecret).
 *
 * The secret (Google's client secret, Apple's private key) is encrypted with
 * the data key (services/secrets.js) and never leaves the server again: the
 * console sees only whether one is saved.
 *
 * THE ROUND TRIP (routes/sign-in-providers.js):
 *
 *   1. beginSignIn: a single-use state, a nonce, PKCE for Google, and a
 *      binder that the route puts in an HttpOnly cookie, so the callback
 *      only counts in the browser that started it.
 *   2. The provider asks the person, then sends them back to the callback
 *      with a code (Google by GET; Apple by a cross-site POST, which the
 *      route turns into the same GET).
 *   3. consumeState, exchangeCode (the code for an ID token, from the
 *      provider's token endpoint), verifyIdToken (signature against the
 *      provider's published keys, issuer, audience, nonce).
 *   4. signIn: the account. The provider's stable subject finds a linked
 *      one; otherwise an address the provider says it verified links the
 *      account that has it, or makes one, the same account an email code
 *      makes (email-signup.js insertEmailUser). The refusals are the email
 *      code's: an admin signs in with a password, and so does an account
 *      whose password was set before its address was ever confirmed.
 *   5. An account that has never chosen a username is not signed in yet:
 *      like the email code's username step (#3575), it gets a short
 *      continuation and the sheet asks for the handle (completeUsername).
 *
 * INSIDE THE HOMEROOM APP the providers' pages refuse its web view, so the
 * app asks with its own sheet instead (the bridge's signInWithProvider), and
 * the ID token it gets back is the same proof, issued to the app:
 *
 *   1. beginNativeSignIn: a single-use state and a nonce, bound to this web
 *      view by the same binder cookie. The app hands the nonce to the
 *      provider's sheet (Apple: its SHA-256, as Apple's docs ask).
 *   2. verifyNativeIdToken: signature, issuer, an audience among the app's
 *      client IDs (`app_client_ids`, set in the console beside the rest),
 *      the nonce, and spent once (native_sign_in_tokens). Google's sheet
 *      may not carry the nonce on every app build; a token without one is
 *      taken only within NATIVE_FRESH_S of being issued, and still only once.
 *   3. signIn and the username step, exactly as above.
 *
 * The app offers a provider only once the web sign-in for it is set up and
 * switched on and the app's client IDs are saved (offeredNativeProviders).
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const log = require('./logger');
const secrets = require('./secrets');
const usernames = require('./usernames');
const emailSignup = require('./email-signup');

const PROVIDERS = Object.freeze(['apple', 'google']);
const LABELS = Object.freeze({ apple: 'Apple', google: 'Google' });

const STATE_TTL_MS = 10 * 60 * 1000;
const SIGNUP_TTL_MS = 15 * 60 * 1000;
const CACHE_MS = 10 * 1000;
const PROVIDER_TIMEOUT_MS = 10 * 1000;
// Apple's client secret lives five minutes: it is made for one exchange.
const APPLE_SECRET_TTL_S = 5 * 60;
// A native ID token without the nonce is taken only this soon after it was issued.
const NATIVE_FRESH_S = 5 * 60;
const APP_CLIENT_IDS_MAX = 5;
const ID_TOKEN_MAX = 8192;

const ENDPOINTS = Object.freeze({
  google: Object.freeze({
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: Object.freeze(['https://accounts.google.com', 'accounts.google.com']),
  }),
  apple: Object.freeze({
    authorize: 'https://appleid.apple.com/auth/authorize',
    token: 'https://appleid.apple.com/auth/token',
    jwks: 'https://appleid.apple.com/auth/keys',
    issuers: Object.freeze(['https://appleid.apple.com']),
  }),
});

// Google's client IDs end in .apps.googleusercontent.com; an Apple Services
// ID is a reverse-DNS name. Both fit this.
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const APPLE_ID_RE = /^[A-Z0-9]{10}$/;
const GOOGLE_SECRET_RE = /^[A-Za-z0-9._~-]{8,200}$/;
const PRIVATE_KEY_MAX = 4000;

// Where the sheet was opened from, carried across the trip.
const STARTED_FROM = Object.freeze(['invite', 'story', 'signin']);
// Where the person comes back to: Home, or the invite link they were on.
const INVITE_PATH_RE = /^\/invite\/[A-Za-z0-9_-]{22}$/;

class SignInProviderError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = 'SignInProviderError';
    this.code = code;
    this.status = status;
  }
}

function isProvider(value) {
  return PROVIDERS.includes(value);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function safeReturnTo(value) {
  return typeof value === 'string' && INVITE_PATH_RE.test(value) ? value : '/';
}

function callbackPath(provider) {
  return `/api/auth/oauth/${provider}/callback`;
}

/** The address to register with the provider, or null when the server has no canonical origin. */
function callbackUrl(config, provider) {
  return config && config.cliAuthOrigin ? `${config.cliAuthOrigin}${callbackPath(provider)}` : null;
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

// ── The settings ────────────────────────────────────────────────────────

function emptyRow(provider) {
  return {
    provider, enabled: false, clientId: null, teamId: null, keyId: null,
    appClientIds: [],
    secret: null, secretSaved: false, secretUnreadable: false,
    updatedAt: null, updatedBy: null,
  };
}

function decryptSecret(payload, config) {
  if (!payload) return null;
  try {
    return secrets.decrypt(payload, config && config.dataEncryptionKey) || null;
  } catch {
    return null;
  }
}

const caches = new WeakMap();

/**
 * Every provider's row, decrypted: { apple, google }, each with `secret`
 * in the clear for the exchanges. Cached per pool for ten seconds; a save
 * forgets it. A read that fails offers nothing (and throws for the console,
 * with `strict`), so an outage never shows a button that cannot work.
 */
async function readProviders(pool, config, { fresh = false, strict = false } = {}) {
  const cached = caches.get(pool);
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.rows;
  const out = {};
  for (const provider of PROVIDERS) out[provider] = emptyRow(provider);
  try {
    const { rows } = await pool.query(
      `SELECT s.provider, s.enabled, s.client_id, s.team_id, s.key_id, s.app_client_ids, s.secret_enc,
              s.updated_at, u.username AS updated_by
         FROM sign_in_providers s
         LEFT JOIN users u ON u.id = s.updated_by`
    );
    for (const row of rows) {
      if (!isProvider(row.provider)) continue;
      const secret = decryptSecret(row.secret_enc, config);
      out[row.provider] = {
        provider: row.provider,
        enabled: row.enabled === true,
        clientId: row.client_id || null,
        teamId: row.team_id || null,
        keyId: row.key_id || null,
        appClientIds: Array.isArray(row.app_client_ids) ? row.app_client_ids.filter(Boolean) : [],
        secret,
        secretSaved: !!row.secret_enc,
        secretUnreadable: !!row.secret_enc && !secret,
        updatedAt: row.updated_at || null,
        updatedBy: row.updated_by || null,
      };
    }
  } catch (err) {
    if (strict) throw err;
    log.warn('sign-in-providers', 'Provider settings read failed; offering none', { err: err.message });
    return out;
  }
  caches.set(pool, { at: Date.now(), rows: out });
  return out;
}

/** What a row still needs before it can be switched on, in the console's words. */
function missing(row) {
  const gaps = [];
  if (!row.clientId) gaps.push(row.provider === 'apple' ? 'Services ID' : 'Client ID');
  if (row.provider === 'apple') {
    if (!row.teamId) gaps.push('Team ID');
    if (!row.keyId) gaps.push('Key ID');
  }
  if (!row.secret) {
    const name = row.provider === 'apple' ? 'Private key' : 'Client secret';
    gaps.push(row.secretUnreadable ? `${name} (saved, but this server cannot read it: paste it again)` : name);
  }
  return gaps;
}

function offeredFrom(rows, config) {
  if (!config || !config.cliAuthOrigin) return [];
  return PROVIDERS.filter((p) => rows[p].enabled && missing(rows[p]).length === 0);
}

/** The providers the sign-in sheet offers, Apple first. */
async function offeredProviders(pool, config) {
  return offeredFrom(await readProviders(pool, config), config);
}

function nativeOfferedFrom(rows, config) {
  return offeredFrom(rows, config).filter((p) => rows[p].appClientIds.length > 0);
}

/** The providers the Homeroom app's own sheets offer: set up, and the app's client IDs saved. */
async function offeredNativeProviders(pool, config) {
  return nativeOfferedFrom(await readProviders(pool, config), config);
}

/** The audiences a native ID token may carry. */
function nativeAudiences(provider, row) {
  return provider === 'google' && row.clientId
    ? [...row.appClientIds, row.clientId]
    : [...row.appClientIds];
}

/** The console's view: everything but the secrets. */
async function adminView(pool, config) {
  const rows = await readProviders(pool, config, { fresh: true, strict: true });
  const origin = (config && config.cliAuthOrigin) || null;
  return {
    callbackOrigin: origin,
    providers: PROVIDERS.map((provider) => {
      const row = rows[provider];
      const gaps = missing(row);
      return {
        provider,
        label: LABELS[provider],
        enabled: row.enabled,
        complete: gaps.length === 0,
        missing: gaps,
        offered: row.enabled && gaps.length === 0 && !!origin,
        nativeOffered: row.enabled && gaps.length === 0 && !!origin && row.appClientIds.length > 0,
        clientId: row.clientId,
        teamId: row.teamId,
        keyId: row.keyId,
        appClientIds: row.appClientIds,
        secretSaved: row.secretSaved,
        secretUnreadable: row.secretUnreadable,
        callbackUrl: callbackUrl(config, provider),
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      };
    }),
  };
}

/**
 * A .p8 key as Apple hands it out: PKCS#8 PEM, an EC key on P-256. Anything
 * else is refused here rather than at the first sign-in.
 */
function normalizePrivateKey(raw) {
  const text = String(raw).trim().replace(/\r\n/g, '\n');
  if (text.length > PRIVATE_KEY_MAX || !text.startsWith('-----BEGIN PRIVATE KEY-----')) {
    throw new SignInProviderError('invalid_private_key',
      'Paste the whole .p8 file, from -----BEGIN PRIVATE KEY----- to the END line.');
  }
  let key;
  try {
    key = crypto.createPrivateKey({ key: text, format: 'pem' });
  } catch {
    throw new SignInProviderError('invalid_private_key', 'That private key could not be read.');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new SignInProviderError('invalid_private_key',
      'That is not a Sign in with Apple key (an EC key on P-256).');
  }
  return text;
}

function trimmedField(value) {
  return typeof value === 'string' ? value.trim() : null;
}

/**
 * The app's client IDs as the console sends them: a list, or one string
 * split on commas, spaces and new lines. null when the field was left out.
 */
function appClientIdsFrom(provider, value) {
  if (value === undefined || value === null) return null;
  const list = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/[\s,]+/) : null);
  if (!list) throw new SignInProviderError('invalid_app_client_ids', 'Send the app client IDs as a list.');
  const ids = [...new Set(list.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean))];
  if (ids.length > APP_CLIENT_IDS_MAX) {
    throw new SignInProviderError('invalid_app_client_ids', `At most ${APP_CLIENT_IDS_MAX} app client IDs.`);
  }
  for (const id of ids) {
    if (!CLIENT_ID_RE.test(id)) {
      throw new SignInProviderError('invalid_app_client_ids',
        provider === 'apple' ? `"${id.slice(0, 60)}" does not look like a bundle ID.` : `"${id.slice(0, 60)}" does not look like a client ID.`);
    }
  }
  return ids;
}

/**
 * Save one provider's settings. Fields left out keep their value; an empty
 * ID clears it; a secret is replaced only when a new one is sent, never
 * echoed back. `clear: true` removes the provider's row altogether. A
 * provider is switched on only when it is complete.
 */
async function saveProvider(pool, config, provider, input, actorId = null) {
  if (!isProvider(provider)) throw new SignInProviderError('unknown_provider', 'Unknown provider.', 404);
  const body = input && typeof input === 'object' ? input : {};

  if (body.clear === true) {
    await pool.query('DELETE FROM sign_in_providers WHERE provider = $1', [provider]);
    caches.delete(pool);
    return adminView(pool, config);
  }

  const current = (await readProviders(pool, config, { fresh: true, strict: true }))[provider];
  const next = {
    provider,
    enabled: current.enabled,
    clientId: current.clientId,
    teamId: current.teamId,
    keyId: current.keyId,
    appClientIds: current.appClientIds,
    secret: current.secret,
    secretUnreadable: current.secretUnreadable,
  };
  let secretEnc = null;

  const appClientIds = appClientIdsFrom(provider, body.appClientIds);
  if (appClientIds !== null) next.appClientIds = appClientIds;

  const clientId = trimmedField(body.clientId);
  if (clientId !== null) {
    if (clientId && !CLIENT_ID_RE.test(clientId)) {
      throw new SignInProviderError('invalid_client_id',
        provider === 'apple' ? 'That does not look like a Services ID.' : 'That does not look like a client ID.');
    }
    next.clientId = clientId || null;
  }
  if (provider === 'apple') {
    for (const [field, label] of [['teamId', 'team ID'], ['keyId', 'key ID']]) {
      const value = trimmedField(body[field]);
      if (value === null) continue;
      const upper = value.toUpperCase();
      if (upper && !APPLE_ID_RE.test(upper)) {
        throw new SignInProviderError(`invalid_${field === 'teamId' ? 'team_id' : 'key_id'}`,
          `An Apple ${label} is ten letters and digits.`);
      }
      next[field] = upper || null;
    }
  }
  if (typeof body.secret === 'string' && body.secret.trim()) {
    let secret;
    if (provider === 'apple') {
      secret = normalizePrivateKey(body.secret);
    } else {
      secret = body.secret.trim();
      if (!GOOGLE_SECRET_RE.test(secret)) {
        throw new SignInProviderError('invalid_secret', 'That does not look like a client secret.');
      }
    }
    if (!config || !config.dataEncryptionKey) {
      throw new SignInProviderError('no_data_key',
        'This server has no data encryption key, so it cannot keep a secret.', 503);
    }
    secretEnc = secrets.encrypt(secret, config.dataEncryptionKey);
    next.secret = secret;
    next.secretUnreadable = false;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      throw new SignInProviderError('invalid_enabled', 'Provide enabled: true or false.');
    }
    next.enabled = body.enabled;
  }
  const gaps = missing(next);
  if (next.enabled && gaps.length) {
    throw new SignInProviderError('incomplete',
      `Fill in ${gaps.join(', ')} before switching ${LABELS[provider]} on.`);
  }

  await pool.query(
    `INSERT INTO sign_in_providers
       (provider, enabled, client_id, team_id, key_id, app_client_ids, secret_enc, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7, NOW(), $8)
     ON CONFLICT (provider) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           client_id = EXCLUDED.client_id,
           team_id = EXCLUDED.team_id,
           key_id = EXCLUDED.key_id,
           app_client_ids = EXCLUDED.app_client_ids,
           secret_enc = COALESCE(EXCLUDED.secret_enc, sign_in_providers.secret_enc),
           updated_at = NOW(),
           updated_by = EXCLUDED.updated_by`,
    [
      provider, next.enabled, next.clientId,
      provider === 'apple' ? next.teamId : null,
      provider === 'apple' ? next.keyId : null,
      next.appClientIds, secretEnc, actorId,
    ]
  );
  caches.delete(pool);
  return adminView(pool, config);
}

// ── The exchanges ───────────────────────────────────────────────────────

/** Apple's client secret: a JWT the team's key signs for one exchange. */
async function appleClientSecret(row, now = Date.now()) {
  const { SignJWT, importPKCS8 } = await import('jose');
  const key = await importPKCS8(row.secret, 'ES256');
  const iat = Math.floor(now / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: row.keyId })
    .setIssuer(row.teamId)
    .setSubject(row.clientId)
    .setAudience('https://appleid.apple.com')
    .setIssuedAt(iat)
    .setExpirationTime(iat + APPLE_SECRET_TTL_S)
    .sign(key);
}

async function clientSecretFor(provider, row) {
  return provider === 'apple' ? appleClientSecret(row) : row.secret;
}

async function postToken(provider, body, fetchImpl) {
  return (fetchImpl || fetch)(ENDPOINTS[provider].token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
}

async function cleanupExpired(pool) {
  try {
    await pool.query("DELETE FROM oauth_sign_in_states WHERE expires_at < NOW() - INTERVAL '1 hour'");
    await pool.query("DELETE FROM oauth_signup_sessions WHERE expires_at < NOW() - INTERVAL '1 hour'");
    await pool.query("DELETE FROM native_sign_in_tokens WHERE expires_at < NOW() - INTERVAL '1 hour'");
  } catch (err) {
    log.warn('sign-in-providers', 'Expired sign-in state cleanup failed', { err: err.message });
  }
}

/**
 * Start a round trip: { url, binder }. The route sends the person to `url`
 * and keeps `binder` in an HttpOnly cookie.
 */
async function beginSignIn(pool, config, provider, { from = null, followInvite = false, returnTo = '/' } = {}) {
  const rows = await readProviders(pool, config);
  if (!isProvider(provider) || !offeredFrom(rows, config).includes(provider)) {
    throw new SignInProviderError('not_offered', 'That sign-in is not set up.', 404);
  }
  const row = rows[provider];
  const state = randomToken();
  const binder = randomToken();
  const nonce = randomToken(16);
  const verifier = provider === 'google' ? randomToken(48) : null;
  await cleanupExpired(pool);
  await pool.query(
    `INSERT INTO oauth_sign_in_states
       (state_hash, provider, binder_hash, nonce, code_verifier, follow_invite,
        started_from, return_to, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      sha256Hex(state), provider, sha256Hex(binder), nonce, verifier, followInvite === true,
      STARTED_FROM.includes(from) ? from : null, safeReturnTo(returnTo),
      new Date(Date.now() + STATE_TTL_MS),
    ]
  );
  const params = new URLSearchParams({
    client_id: row.clientId,
    redirect_uri: callbackUrl(config, provider),
    response_type: 'code',
    state,
    nonce,
  });
  if (provider === 'google') {
    params.set('scope', 'openid email profile');
    params.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url'));
    params.set('code_challenge_method', 'S256');
    params.set('prompt', 'select_account');
  } else {
    // Asking for the address means Apple answers by form POST.
    params.set('scope', 'name email');
    params.set('response_mode', 'form_post');
  }
  return { url: `${ENDPOINTS[provider].authorize}?${params.toString()}`, binder };
}

/**
 * Start a native sign-in in the Homeroom app: { state, nonce, binder }. The
 * page keeps `state`, the app's sheet gets `nonce`, and the route keeps
 * `binder` in the same HttpOnly cookie as a round trip's.
 */
async function beginNativeSignIn(pool, config, provider, { from = null, followInvite = false } = {}) {
  const rows = await readProviders(pool, config);
  if (!isProvider(provider) || !nativeOfferedFrom(rows, config).includes(provider)) {
    throw new SignInProviderError('not_offered', 'That sign-in is not set up in the app.', 404);
  }
  const state = randomToken();
  const binder = randomToken();
  const nonce = randomToken(16);
  await cleanupExpired(pool);
  await pool.query(
    `INSERT INTO oauth_sign_in_states
       (state_hash, provider, binder_hash, nonce, follow_invite, started_from, native, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)`,
    [
      sha256Hex(state), provider, sha256Hex(binder), nonce, followInvite === true,
      STARTED_FROM.includes(from) ? from : null,
      new Date(Date.now() + STATE_TTL_MS),
    ]
  );
  return { state, nonce, binder };
}

/**
 * Spend the state the callback came back with. null when it is unknown or
 * expired; `{ mismatch: true, return_to }` when it was started in another
 * browser (spent all the same, so it cannot be tried again). A native
 * sign-in's state is spent only by the native route, and the other way round.
 */
async function consumeState(pool, provider, state, binder, { native = false } = {}) {
  if (!isProvider(provider) || typeof state !== 'string' || !state || state.length > 200) return null;
  const { rows } = await pool.query(
    `DELETE FROM oauth_sign_in_states
      WHERE state_hash = $1 AND provider = $2 AND native = $3
      RETURNING binder_hash, nonce, code_verifier, follow_invite, started_from, return_to, expires_at`,
    [sha256Hex(state), provider, native === true]
  );
  const row = rows[0];
  if (!row || new Date(row.expires_at) <= new Date()) return null;
  if (typeof binder !== 'string' || !sameHash(sha256Hex(binder), row.binder_hash)) {
    return { mismatch: true, return_to: safeReturnTo(row.return_to) };
  }
  return { ...row, return_to: safeReturnTo(row.return_to) };
}

const jwksCache = new Map();

async function providerKeys(provider) {
  let keys = jwksCache.get(provider);
  if (!keys) {
    const { createRemoteJWKSet } = await import('jose');
    keys = createRemoteJWKSet(new URL(ENDPOINTS[provider].jwks));
    jwksCache.set(provider, keys);
  }
  return keys;
}

/**
 * The ID token's claims, once its signature, issuer, audience and nonce all
 * check out: { subject, email, emailVerified, name }.
 */
async function verifyIdToken(provider, clientId, idToken, nonce, deps = {}) {
  const { jwtVerify } = await import('jose');
  const keys = deps.jwks || await providerKeys(provider);
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, keys, {
      issuer: [...ENDPOINTS[provider].issuers],
      audience: clientId,
      clockTolerance: 60,
    }));
  } catch (err) {
    log.warn('sign-in-providers', 'ID token refused', { provider, err: err.code || err.message });
    throw new SignInProviderError('bad_token', `${LABELS[provider]} sign-in could not be confirmed. Try again.`, 502);
  }
  if (typeof payload.nonce !== 'string' || payload.nonce !== nonce) {
    throw new SignInProviderError('bad_token', `${LABELS[provider]} sign-in could not be confirmed. Try again.`, 502);
  }
  return claimsFrom(provider, payload);
}

function claimsFrom(provider, payload) {
  const subject = typeof payload.sub === 'string' ? payload.sub : '';
  if (!subject || subject.length > 255) {
    throw new SignInProviderError('bad_token', `${LABELS[provider]} sign-in could not be confirmed. Try again.`, 502);
  }
  return {
    subject,
    email: emailSignup.normalizeEmail(payload.email),
    // Apple sends the flag as a string.
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name: typeof payload.name === 'string' ? payload.name.slice(0, 100) : null,
  };
}

/**
 * A native sign-in's ID token, as the app's own sheet returned it: its
 * claims, once the signature, issuer, an app audience and the nonce check
 * out and the token has not been spent before. `state` is consumeState's
 * row (native). The nonce may come back as given or as its SHA-256 (hex).
 */
async function verifyNativeIdToken(pool, config, provider, idToken, state, deps = {}) {
  const rows = await readProviders(pool, config);
  if (!isProvider(provider) || !nativeOfferedFrom(rows, config).includes(provider)) {
    throw new SignInProviderError('not_offered', 'That sign-in is not set up in the app.', 404);
  }
  const row = rows[provider];
  const refused = () => new SignInProviderError('bad_token', `${LABELS[provider]} sign-in could not be confirmed. Try again.`, 502);
  if (typeof idToken !== 'string' || !idToken || idToken.length > ID_TOKEN_MAX) throw refused();
  const { jwtVerify } = await import('jose');
  const keys = deps.jwks || await providerKeys(provider);
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, keys, {
      issuer: [...ENDPOINTS[provider].issuers],
      audience: nativeAudiences(provider, row),
      clockTolerance: 60,
    }));
  } catch (err) {
    log.warn('sign-in-providers', 'Native ID token refused', { provider, err: err.code || err.message });
    throw refused();
  }
  const nonce = state && typeof state.nonce === 'string' ? state.nonce : '';
  if (typeof payload.nonce === 'string') {
    if (!nonce || (payload.nonce !== nonce && payload.nonce !== sha256Hex(nonce))) throw refused();
  } else {
    // Apple's sheet always carries it. Google's may not, on an older app
    // build: such a token counts only while it is fresh.
    const now = Math.floor((deps.now || Date.now()) / 1000);
    if (provider !== 'google' || typeof payload.iat !== 'number' || now - payload.iat > NATIVE_FRESH_S) throw refused();
  }
  const claims = claimsFrom(provider, payload);
  const expiresAt = new Date((typeof payload.exp === 'number' ? payload.exp : Math.floor(Date.now() / 1000) + 3600) * 1000);
  const { rows: spent } = await pool.query(
    `INSERT INTO native_sign_in_tokens (token_hash, provider, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (token_hash) DO NOTHING
     RETURNING token_hash`,
    [sha256Hex(idToken), provider, expiresAt]
  );
  if (!spent.length) {
    log.warn('sign-in-providers', 'Native ID token used twice', { provider });
    throw refused();
  }
  return claims;
}

/** The code for the person's verified claims. `state` is consumeState's row. */
async function exchangeCode(pool, config, provider, { code, state }, deps = {}) {
  const row = (await readProviders(pool, config))[provider];
  if (!row || missing(row).length || !config || !config.cliAuthOrigin) {
    throw new SignInProviderError('not_offered', 'That sign-in is not set up.', 404);
  }
  if (typeof code !== 'string' || !code || code.length > 2048) {
    throw new SignInProviderError('provider_refused', `${LABELS[provider]} did not send a sign-in back.`, 400);
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl(config, provider),
    client_id: row.clientId,
    client_secret: await clientSecretFor(provider, row),
  });
  if (state.code_verifier) body.set('code_verifier', state.code_verifier);
  let res;
  try {
    res = await postToken(provider, body, deps.fetch);
  } catch (err) {
    log.warn('sign-in-providers', 'Token exchange unreachable', { provider, err: err.message });
    throw new SignInProviderError('provider_unreachable', `Could not reach ${LABELS[provider]}. Try again.`, 502);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.id_token !== 'string') {
    log.warn('sign-in-providers', 'Token exchange refused', {
      provider, status: res.status, error: typeof data.error === 'string' ? data.error.slice(0, 60) : null,
    });
    throw new SignInProviderError('provider_refused', `${LABELS[provider]} did not confirm the sign-in. Try again.`, 502);
  }
  return verifyIdToken(provider, row.clientId, data.id_token, state.nonce, deps);
}

// ── The account ─────────────────────────────────────────────────────────

/**
 * The account for these claims, in one transaction. Returns one of
 *   { refuse: 'admin_password_required' | 'password_required'
 *             | 'no_verified_email' | 'linked_elsewhere' }
 *   { next: 'signed-in', session, user, userId, created, email }
 *   { next: 'username', signupToken, expiresAt, userId, created, email }
 */
async function signIn(pool, provider, claims, { createSession }) {
  if (typeof createSession !== 'function') throw new Error('signIn requires createSession');
  await cleanupExpired(pool);
  return withTransaction(pool, async (client) => {
    const { rows: linked } = await client.query(
      `SELECT u.id, u.username, u.is_admin, u.admin_readonly, u.needs_username_choice
         FROM user_oauth_identities i
         JOIN users u ON u.id = i.user_id
        WHERE i.provider = $1 AND i.subject = $2
        FOR UPDATE OF i, u`,
      [provider, claims.subject]
    );
    let user = linked[0] || null;
    let created = false;

    if (user) {
      if (user.is_admin) return { refuse: 'admin_password_required' };
      await client.query(
        `UPDATE user_oauth_identities
            SET last_used_at = NOW(), email = COALESCE($3, email)
          WHERE provider = $1 AND subject = $2`,
        [provider, claims.subject, claims.email]
      );
    } else {
      // Linking by address needs an address the provider itself verified.
      if (!claims.email || !claims.emailVerified) return { refuse: 'no_verified_email' };
      const { rows } = await client.query(
        `SELECT id, username, is_admin, admin_readonly, password_set, email_confirmed,
                needs_username_choice
           FROM users
          WHERE lower(email) = lower($1)
          FOR UPDATE`,
        [claims.email]
      );
      user = rows[0] || null;
      if (user) {
        // The email code's refusals, for the same reasons (email-signup.js).
        if (user.is_admin) return { refuse: 'admin_password_required' };
        if (user.password_set && !user.email_confirmed) return { refuse: 'password_required' };
        // One identity per provider per account: a second, different one
        // with the same address is somebody's other account at the provider,
        // and is not quietly swapped in.
        const { rows: other } = await client.query(
          'SELECT 1 FROM user_oauth_identities WHERE user_id = $1 AND provider = $2',
          [user.id, provider]
        );
        if (other.length) return { refuse: 'linked_elsewhere' };
        if (!user.email_confirmed) {
          await client.query(
            'UPDATE users SET email_confirmed = TRUE, email_confirmed_at = NOW() WHERE id = $1',
            [user.id]
          );
        }
      } else {
        const unusablePasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
        user = await emailSignup.insertEmailUser(client, claims.email, unusablePasswordHash);
        created = true;
      }
      await client.query(
        `INSERT INTO user_oauth_identities (user_id, provider, subject, email, last_used_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [user.id, provider, claims.subject, claims.email]
      );
    }

    if (user.needs_username_choice === true) {
      const signupToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + SIGNUP_TTL_MS);
      await client.query(
        `INSERT INTO oauth_signup_sessions (token_hash, user_id, provider, expires_at, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET token_hash = EXCLUDED.token_hash,
               provider = EXCLUDED.provider,
               expires_at = EXCLUDED.expires_at,
               created_at = NOW()`,
        [sha256Hex(signupToken), user.id, provider, expiresAt]
      );
      return { next: 'username', signupToken, expiresAt, userId: user.id, created, email: claims.email };
    }

    const session = await createSession(client, user.id);
    return {
      next: 'signed-in',
      session,
      userId: user.id,
      created,
      email: claims.email,
      user: {
        id: user.id,
        username: user.username,
        isAdmin: !!user.is_admin,
        adminReadonly: !!user.admin_readonly,
      },
    };
  });
}

/**
 * The username step: choose the handle and sign in. Every refusal comes
 * before the continuation is spent, so the person fixes the field and
 * submits again.
 */
async function completeUsername(pool, { signupToken, username, createSession }) {
  if (typeof signupToken !== 'string' || !/^[a-f0-9]{64}$/.test(signupToken)) {
    throw new SignInProviderError('invalid_signup_session', 'Your sign-in expired. Start again.');
  }
  const check = usernames.validateUsername(typeof username === 'string' ? username : '');
  if (!check.ok) throw new SignInProviderError('invalid_username', check.error);

  let result;
  try {
    result = await withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT s.user_id, s.expires_at, u.username, u.is_admin, u.admin_readonly,
                u.needs_username_choice
           FROM oauth_signup_sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1
          FOR UPDATE OF s, u`,
        [sha256Hex(signupToken)]
      );
      const signup = rows[0];
      if (!signup || new Date(signup.expires_at) < new Date() || signup.is_admin) return { invalid: true };
      let handle = signup.username;
      if (signup.needs_username_choice === true) {
        const free = await usernames.checkAvailability(client, check.value, signup.user_id);
        if (!free.available) return { usernameTaken: free.error };
        const chosen = await usernames.chooseFirstUsername(client, signup.user_id, check.value);
        if (chosen) handle = chosen.username;
      }
      await client.query('DELETE FROM oauth_signup_sessions WHERE token_hash = $1', [sha256Hex(signupToken)]);
      const session = await createSession(client, signup.user_id);
      return {
        session,
        user: {
          id: signup.user_id,
          username: handle,
          isAdmin: !!signup.is_admin,
          adminReadonly: !!signup.admin_readonly,
        },
      };
    });
  } catch (error) {
    // The unique index behind checkAvailability: somebody took the name in the gap.
    if (error && error.code === '23505') throw new SignInProviderError('username_taken', 'That username is taken.');
    throw error;
  }
  if (result.usernameTaken) throw new SignInProviderError('username_taken', result.usernameTaken);
  if (result.invalid) throw new SignInProviderError('invalid_signup_session', 'Your sign-in expired. Start again.');
  return result;
}

// ── The console's check ─────────────────────────────────────────────────

/**
 * Ask the provider whether it accepts these credentials, by exchanging a
 * code that cannot exist: a provider that knows the client answers
 * invalid_grant (the code), one that does not answers invalid_client.
 * Nobody is signed in and nothing is stored. { ok, message }.
 */
async function checkSetup(pool, config, provider, deps = {}) {
  if (!isProvider(provider)) throw new SignInProviderError('unknown_provider', 'Unknown provider.', 404);
  const row = (await readProviders(pool, config, { fresh: true, strict: true }))[provider];
  const gaps = missing(row);
  if (gaps.length) return { ok: false, message: `Still missing: ${gaps.join(', ')}.` };
  if (!config || !config.cliAuthOrigin) {
    return { ok: false, message: 'This server has no canonical origin (CLI_CANONICAL_ORIGIN), so there is no address for the provider to send people back to.' };
  }
  let clientSecret;
  try {
    clientSecret = await clientSecretFor(provider, row);
  } catch {
    return { ok: false, message: 'The private key could not sign a client secret.' };
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: 'homeroom-setup-check',
    redirect_uri: callbackUrl(config, provider),
    client_id: row.clientId,
    client_secret: clientSecret,
  });
  let res;
  try {
    res = await postToken(provider, body, deps.fetch);
  } catch (err) {
    return { ok: false, message: `Could not reach ${LABELS[provider]}: ${err.message}` };
  }
  const data = await res.json().catch(() => ({}));
  const error = typeof data.error === 'string' ? data.error.slice(0, 60) : '';
  if (error === 'invalid_grant') {
    return { ok: true, message: `${LABELS[provider]} accepts these credentials.` };
  }
  if (error === 'invalid_client' || error === 'unauthorized_client' || res.status === 401) {
    return { ok: false, message: `${LABELS[provider]} does not accept these credentials (${error || res.status}).` };
  }
  return { ok: false, message: `${LABELS[provider]} answered ${res.status}${error ? ` (${error})` : ''}.` };
}

module.exports = {
  PROVIDERS,
  LABELS,
  ENDPOINTS,
  STATE_TTL_MS,
  SIGNUP_TTL_MS,
  SignInProviderError,
  isProvider,
  safeReturnTo,
  callbackPath,
  callbackUrl,
  readProviders,
  missing,
  offeredProviders,
  offeredNativeProviders,
  nativeAudiences,
  NATIVE_FRESH_S,
  adminView,
  saveProvider,
  normalizePrivateKey,
  appleClientSecret,
  beginSignIn,
  beginNativeSignIn,
  consumeState,
  verifyIdToken,
  verifyNativeIdToken,
  exchangeCode,
  signIn,
  completeUsername,
  checkSetup,
};
