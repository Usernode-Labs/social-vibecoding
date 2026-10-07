'use strict';

/**
 * Firebase Phone Auth sign-in and sign-up, beside the email code
 * (services/email-signup.js) and Apple/Google (services/sign-in-providers.js).
 *
 * Endpoints under routes/phone-auth.js. An invite link's Join sheet
 * (frontend/src/features/auth/sign-in-sheet.tsx, `phone`) starts with them
 * whenever they are offered, because an invite makes a private member and a
 * private member signs up with a phone (community-invites.js
 * joinAsPrivateMember). The answers are shaped exactly like the email
 * code's and the native OAuth endpoints' JSON.
 *
 * SET UP IN THE ENVIRONMENT, NOT THE DATABASE. Nothing lives in the admin
 * console: the two knobs are platform variables (dapp.json platform_env,
 * read through config below), OPTIONAL and default-off. Unset leaves every
 * /api/auth/phone/* endpoint answering 404 not_offered, exactly as before
 * this existed. The same Firebase project as mobile push is expected —
 * FIREBASE_SERVICE_ACCOUNT_JSON_B64 + FIREBASE_PROJECT_ID — plus that
 * project's own Identity Toolkit WEB API key, which the server needs for
 * the two REST legs below. Enabling in staging is fine for testing; the
 * endpoints are fail-closed (404) whenever any of the four values is
 * missing.
 *
 * THE TWO LEGS (routes/phone-auth.js):
 *
 *   1. Server-side REST against Firebase Identity Toolkit
 *      (https://identitytoolkit.googleapis.com/v1):
 *        accounts:sendVerificationCode  { phoneNumber, recaptchaToken? }
 *              → { sessionInfo }
 *        accounts:signInWithPhoneNumber { sessionInfo, code }
 *              → { idToken }
 *      This leg needs the WEB API KEY, never a service account, and
 *      a web caller's request carries an app-verification token, the
 *      answer to a reCAPTCHA whose site key GET recaptchaParams names
 *      (recaptchaSiteKey, served at GET /api/auth/phone/recaptcha; the
 *      shell earns it in frontend/src/features/auth/recaptcha.ts). A
 *      missing or refused one is recaptcha_required. The page's host must
 *      be one of the Firebase project's authorized domains for the answer
 *      to count. The server never sends the SMS itself — Firebase does, at
 *      the phone number's carrier.
 *   2. Verify an ID token with the Firebase Admin SDK
 *      (verifyIdToken), which leg 1 hands back and a client that did the
 *      whole exchange with its own Firebase SDK skips straight to. The
 *      same public service account is reused from
 *      services/mobile-push-provider.js's parser, and the token must be
 *      phone-issued: sign_in_provider === 'phone' and a phone_number
 *      claim. Firebase ID tokens are single-use here: the SHA-256 of the
 *      accepted token is spent once in phone_sign_in_tokens, the rule
 *      native_sign_in_tokens already pins for native OAuth.
 *
 * THE ACCOUNT (signIn) is the email code's account, one transaction:
 * the Firebase uid finds a linked account in user_phone_identities, or a
 * NEW one is made by email-signup.js's insertEmailUser (placeholder
 * username, needs_username_choice, no password) and linked. One account
 * per phone (the phone_e164 unique index) and one identity per account
 * (user_id) are the table's own invariants — NOT a reuse of
 * user_oauth_identities, whose contract is OAuth/email-shaped (provider +
 * subject + a verified address). Refusals are the email code's: an admin
 * signs in with a password, and a number another account already holds is
 * refused rather than silently re-pointed (a recycled number can belong to
 * the next owner of that number, never to the previous holder's account).
 * A brand-new account continues to the username step, the same
 * oauth_signup_sessions continuation Apple and Google ride, completed by
 * sign-in-providers.js's provider-agnostic completeUsername.
 *
 * TEST NUMBERS, for walking a newcomer's first run on a local stack
 * (PHONE_TEST_CODE, config.js). The fictional numbers the North American
 * plan sets aside, +1 <any area code> 555 0100 to 0199, sign in with that
 * one code. They stand in for Firebase's two legs only: no text is sent,
 * no reCAPTCHA is asked, and the ID token is minted and checked here. From
 * the claims on — the spent-once token, the account, the invite, the
 * private membership — it is the same code a real number runs. An account a
 * test number MAKES is a test account (test-accounts.js), so it stays out of
 * outcomes and Journey and retire_test_account removes it. Never in
 * production: config.js refuses the code there and testNumbersOn re-checks
 * the environment. With only the code set, phone sign-in is offered and any
 * other number is refused; with Firebase set up too, other numbers text.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const log = require('./logger');
const { parseServiceAccount } = require('./mobile-push-provider');
const emailSignup = require('./email-signup');

const IDENTITY_ENDPOINT = 'https://identitytoolkit.googleapis.com/v1';
const ADMIN_APP_NAME = 'social-phone-auth';

// Continuation TTL. 15 minutes, the same window oauth_signup_sessions runs
// on for Apple and Google (SIGNUP_TTL_MS there).
const SIGNUP_TTL_MS = 15 * 60 * 1000;

const ID_TOKEN_MAX = 8192;          // sign-in-providers.js ID_TOKEN_MAX
const SESSION_INFO_MAX = 4096;      // Firebase sessionInfo JWT
const CODE_MAX = 16;                // SMS codes are 6; leave headroom
const RECAPTCHA_TOKEN_MAX = 4096;
const UID_MAX = 128;                // the table's CHECK enforces the same

// E.164: '+' then 1–15 digits, first digit 1–9. Spaces, dashes and
// parentheses are display noise and are stripped before the test.
const PHONE_RE = /^\+[1-9][0-9]{1,14}$/;

const PROVIDER_TIMEOUT_MS = 10 * 1000; // sign-in-providers.js PROVIDER_TIMEOUT_MS

// Lost-race signal, the way routes/auth.js's CODE_TAKEN works for the
// email code: thrown so the transaction ROLLS BACK the users row the
// loser already inserted, then translated below into the 422.
const PHONE_TAKEN = Symbol('phone-taken');

class PhoneAuthError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = 'PhoneAuthError';
    this.code = code;
    this.status = status;
  }
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

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function notOfferedError() {
  return new PhoneAuthError('not_offered', 'That sign-in is not set up.', 404);
}

// Firebase's own gate. All four values must be present AND the flag true;
// the web API key travels in the request URL, so an empty one must never
// turn the endpoints into guaranteed-502s.
function firebaseOffered(config) {
  return !!(config
    && config.firebasePhoneAuthEnabled === true
    && typeof config.firebaseWebApiKey === 'string' && config.firebaseWebApiKey
    && typeof config.firebaseProjectId === 'string' && config.firebaseProjectId
    && typeof config.firebaseServiceAccountJsonB64 === 'string'
    && config.firebaseServiceAccountJsonB64);
}

// ── Test numbers (header) ───────────────────────────────────────────────

// +1, any area code, 555 0100–0199: reserved for fiction, so no person
// answers one, and a hundred per area code is a fresh account every round.
const TEST_NUMBER_RE = /^\+1[2-9][0-9]{2}55501[0-9]{2}$/;
const TEST_CODE_RE = /^[0-9]{6}$/;
const TEST_SESSION_PREFIX = 'hr-test-session.';
const TEST_TOKEN_PREFIX = 'hr-test-token.';
const TEST_UID_PREFIX = 'test-phone:';
const TEST_TOKEN_TTL_MS = 5 * 60 * 1000;
// Signs the test ID tokens. Per process and never stored: a token is minted
// and spent inside one verify request, so a restart loses nothing, and a
// client cannot forge one to skip the code on the idToken path.
const TEST_TOKEN_KEY = crypto.randomBytes(32);

// The same rule config.js applies when it reads PHONE_TEST_CODE, read again
// from the environment itself, so a config object built anywhere else still
// cannot turn test numbers on in production.
function productionEnv(env = process.env) {
  return env.NODE_ENV === 'production' || env.USERNODE_ENV === 'production';
}

function testNumbersOn(config) {
  return !!(config
    && typeof config.phoneTestCode === 'string'
    && TEST_CODE_RE.test(config.phoneTestCode)
    && !productionEnv());
}

function isTestNumber(phoneNumber) {
  return typeof phoneNumber === 'string' && TEST_NUMBER_RE.test(phoneNumber);
}

/** Whether this raw number is one of the test numbers, and they are on. */
function usesTestNumber(config, rawPhone) {
  return testNumbersOn(config) && isTestNumber(normalizePhone(rawPhone));
}

// The offer gate: Firebase set up, or test numbers on.
function offered(config) {
  return firebaseOffered(config) || testNumbersOn(config);
}

function testNumbersOnlyError() {
  return new PhoneAuthError(
    'test_numbers_only',
    'This server signs in test numbers only: +1, any area code, then 555 0100 to 0199.'
  );
}

function sameCode(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function signTest(body) {
  return crypto.createHmac('sha256', TEST_TOKEN_KEY).update(body).digest('base64url');
}

function mintTestToken(phoneNumber, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({
    p: phoneNumber,
    n: crypto.randomBytes(12).toString('base64url'),
    e: now + TEST_TOKEN_TTL_MS,
  })).toString('base64url');
  return `${TEST_TOKEN_PREFIX}${body}.${signTest(body)}`;
}

// The claims a test token carries, or null for anything not minted here,
// out of date, or naming a number that is not a test number.
function readTestToken(token, now = Date.now()) {
  const rest = token.slice(TEST_TOKEN_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  const body = rest.slice(0, dot);
  if (!sameCode(rest.slice(dot + 1), signTest(body))) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || !isTestNumber(data.p) || !(Number(data.e) > now)) return null;
  return { phoneNumber: data.p, expiresAt: new Date(Number(data.e)) };
}

function assertOffered(config) {
  if (!offered(config)) throw notOfferedError();
}

/**
 * Normalize a caller-supplied phone number to E.164, or null. Display
 * punctuation is stripped first; anything that is not `+` plus 1–15
 * digits is refused rather than guessed at (no default country code —
 * guessing one would silently re-key somebody's identity).
 */
function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[\s()‐-―-]/g, '').trim();
  return PHONE_RE.test(trimmed) ? trimmed : null;
}

// ── Leg 1: Identity Toolkit REST ────────────────────────────────────────

// A web caller's code request needs an app-verification token, a reCAPTCHA
// answer for the site key recaptchaSiteKey() names. Firebase's own words for
// a missing, stale or refused one; the client earns a token and asks again.
const RECAPTCHA_REFUSALS = new Set([
  'MISSING_APP_CREDENTIAL',
  'INVALID_APP_CREDENTIAL',
  'MISSING_RECAPTCHA_TOKEN',
  'INVALID_RECAPTCHA_TOKEN',
  'CAPTCHA_CHECK_FAILED',
]);

/**
 * Map Identity Toolkit's error string to this API's codes. Unmapped
 * codes (an app-verification misconfiguration, a Firebase-side refusal)
 * log and answer 502: the caller cannot fix them by retrying differently,
 * and the message must not leak which config knob is missing.
 */
function identityToolkitError(data, status, path = null) {
  const raw = typeof data?.error?.message === 'string' ? data.error.message : '';
  // Firebase writes `CODE : detail` (its web SDK splits on ' : '), so the
  // code is trimmed: untrimmed, every detailed refusal read as unmapped.
  const code = raw.split(':')[0].trim();
  // The path is logged because an answer with no code at all (Google's HTML
  // 404 for a method that does not exist) is otherwise indistinguishable
  // from any other unmapped refusal.
  log.warn('phone-auth', 'Identity Toolkit refused', { path, status, code });
  if (code === 'INVALID_CODE' || code === 'SESSION_EXPIRED'
      || code === 'CODE_EXPIRED' || code === 'INVALID_SESSION_INFO') {
    return new PhoneAuthError('invalid_or_expired_code', 'Invalid or expired code.');
  }
  if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
    return new PhoneAuthError('too_many_attempts', 'Too many attempts. Try again later.', 429);
  }
  if (code === 'INVALID_PHONE_NUMBER') {
    return new PhoneAuthError('invalid_phone', 'Enter a valid phone number.');
  }
  if (RECAPTCHA_REFUSALS.has(code)) {
    return new PhoneAuthError('recaptcha_required', 'We could not check that you are a person. Try again.');
  }
  return new PhoneAuthError('firebase_unreachable', 'Could not reach the sign-in service. Try again.', 502);
}

// The bare POST: { ok, status, data }, throwing only when no answer came
// back at all. identityToolkit below maps a refusal to this API's codes;
// the admin test send (sendTestCode) reads Firebase's own code instead.
async function identityToolkitRaw(config, path, body, deps = {}) {
  const res = await (deps.fetch || fetch)(
    `${IDENTITY_ENDPOINT}/${path}?key=${encodeURIComponent(config.firebaseWebApiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    }
  );
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function identityToolkit(config, path, body, deps = {}) {
  let answer;
  try {
    answer = await identityToolkitRaw(config, path, body, deps);
  } catch (err) {
    log.warn('phone-auth', 'Identity Toolkit unreachable', { path, err: err.message });
    throw new PhoneAuthError('firebase_unreachable', 'Could not reach the sign-in service. Try again.', 502);
  }
  if (!answer.ok) throw identityToolkitError(answer.data, answer.status, path);
  return answer.data;
}

/**
 * Ask Firebase to text a code. Returns { phoneNumber, sessionInfo } — the
 * sessionInfo goes back to the same client for the verify leg, and is
 * meaningless to anyone else (routes/phone-auth.js mints nothing here).
 */
async function requestCode(config, rawPhone, recaptchaToken, deps = {}) {
  assertOffered(config);
  const phoneNumber = normalizePhone(rawPhone);
  if (!phoneNumber) {
    throw new PhoneAuthError('invalid_phone', 'Enter a valid phone number.');
  }
  if (testNumbersOn(config) && isTestNumber(phoneNumber)) {
    // No text: the test code is the code. The sessionInfo names the number
    // so the verify leg can mint its token; it grants nothing without the
    // code, and the number in it must still be a test number there.
    log.info('phone-auth', 'Test number: no text sent, sign in with PHONE_TEST_CODE', {
      phone: `…${phoneNumber.slice(-4)}`,
    });
    const tag = Buffer.from(phoneNumber).toString('base64url');
    return {
      phoneNumber,
      sessionInfo: `${TEST_SESSION_PREFIX}${tag}.${crypto.randomBytes(12).toString('base64url')}`,
    };
  }
  if (!firebaseOffered(config)) throw testNumbersOnlyError();
  const body = { phoneNumber };
  if (typeof recaptchaToken === 'string' && recaptchaToken
      && recaptchaToken.length <= RECAPTCHA_TOKEN_MAX) {
    body.recaptchaToken = recaptchaToken;
  }
  const data = await identityToolkit(config, 'accounts:sendVerificationCode', body, deps);
  if (typeof data.sessionInfo !== 'string' || !data.sessionInfo
      || data.sessionInfo.length > SESSION_INFO_MAX) {
    log.warn('phone-auth', 'Identity Toolkit sent no sessionInfo');
    throw new PhoneAuthError('firebase_unreachable', 'Could not reach the sign-in service. Try again.', 502);
  }
  return { phoneNumber, sessionInfo: data.sessionInfo };
}

// Firebase's code for a refusal, the part before ' : '. Only ever the
// upper-case code itself: the free-text detail after it is dropped, and
// anything that does not look like a code is not echoed back.
function providerCodeOf(data) {
  const raw = typeof data?.error?.message === 'string' ? data.error.message : '';
  const code = raw.split(':')[0].trim();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null;
}

/**
 * Admin → SMS delivery's test send (routes/admin.js POST /api/admin/sms/test):
 * the same Identity Toolkit call requestCode makes, so the same text goes
 * out by the same path, but answered as a diagnostic rather than a user
 * error. Never throws for anything Firebase did:
 *
 *   { status: 'sent' | 'refused' | 'unreachable' | 'not_offered',
 *     phoneNumber, providerCode, httpStatus, durationMs }
 *
 * `providerCode` is Firebase's own code (INVALID_PHONE_NUMBER, QUOTA_EXCEEDED
 * …), which identityToolkitError deliberately hides from users and an
 * operator needs. The sessionInfo is dropped: nobody enters the code. A
 * malformed number is the one PhoneAuthError (invalid_phone), thrown
 * before anything is sent, so the route can answer 400.
 */
async function sendTestCode(config, rawPhone, recaptchaToken, deps = {}) {
  const phoneNumber = normalizePhone(rawPhone);
  if (!phoneNumber) {
    throw new PhoneAuthError('invalid_phone', 'Enter a valid phone number, starting with + and the country code.', 400);
  }
  const base = { phoneNumber, providerCode: null, httpStatus: null, durationMs: 0 };
  // The test is a real text, so it needs Firebase; test numbers send none.
  if (!firebaseOffered(config)) return { ...base, status: 'not_offered' };
  const body = { phoneNumber };
  if (typeof recaptchaToken === 'string' && recaptchaToken
      && recaptchaToken.length <= RECAPTCHA_TOKEN_MAX) {
    body.recaptchaToken = recaptchaToken;
  }
  const now = deps.now || Date.now;
  const started = now();
  let answer;
  try {
    answer = await identityToolkitRaw(config, 'accounts:sendVerificationCode', body, deps);
  } catch (err) {
    log.warn('phone-auth', 'Identity Toolkit unreachable', { path: 'test send', err: err.message });
    return { ...base, status: 'unreachable', durationMs: now() - started };
  }
  const durationMs = now() - started;
  if (!answer.ok) {
    return { ...base, status: 'refused', providerCode: providerCodeOf(answer.data), httpStatus: answer.status, durationMs };
  }
  if (typeof answer.data.sessionInfo !== 'string' || !answer.data.sessionInfo) {
    return { ...base, status: 'refused', providerCode: 'NO_SESSION_INFO', httpStatus: answer.status, durationMs };
  }
  return { ...base, status: 'sent', httpStatus: answer.status, durationMs };
}

// The site key for the reCAPTCHA a web caller answers before a code is
// sent: the Firebase project's own (GET recaptchaParams, what Firebase's web
// SDK asks for), never configured here. Kept for an hour, per API key; a
// failed read is not kept.
const SITE_KEY_TTL_MS = 60 * 60 * 1000;
const siteKeyCache = new Map();

async function recaptchaSiteKey(config, deps = {}) {
  assertOffered(config);
  // Test numbers only: nothing is texted, so there is no check to answer.
  // The sheet reads the empty key as "send the request without a token".
  if (!firebaseOffered(config)) return '';
  const now = (deps.now || Date.now)();
  const cached = siteKeyCache.get(config.firebaseWebApiKey);
  if (cached && cached.until > now) return cached.siteKey;
  let res;
  try {
    res = await (deps.fetch || fetch)(
      `${IDENTITY_ENDPOINT}/recaptchaParams?key=${encodeURIComponent(config.firebaseWebApiKey)}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) }
    );
  } catch (err) {
    log.warn('phone-auth', 'Identity Toolkit unreachable', { path: 'recaptchaParams', err: err.message });
    throw new PhoneAuthError('firebase_unreachable', 'Could not reach the sign-in service. Try again.', 502);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw identityToolkitError(data, res.status);
  const siteKey = typeof data.recaptchaSiteKey === 'string' ? data.recaptchaSiteKey : '';
  if (!siteKey || siteKey.length > 256) {
    log.warn('phone-auth', 'Identity Toolkit sent no reCAPTCHA site key');
    throw new PhoneAuthError('firebase_unreachable', 'Could not reach the sign-in service. Try again.', 502);
  }
  siteKeyCache.set(config.firebaseWebApiKey, { siteKey, until: now + SITE_KEY_TTL_MS });
  return siteKey;
}

/**
 * Trade the sessionInfo and the texted code for the ID token leg 2
 * verifies. Returns { idToken }.
 */
async function exchangeCode(config, rawSessionInfo, rawCode, deps = {}) {
  assertOffered(config);
  const sessionInfo = typeof rawSessionInfo === 'string' ? rawSessionInfo : '';
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!sessionInfo || sessionInfo.length > SESSION_INFO_MAX
      || !code || code.length > CODE_MAX) {
    throw new PhoneAuthError('invalid_or_expired_code', 'Invalid or expired code.');
  }
  if (sessionInfo.startsWith(TEST_SESSION_PREFIX)) {
    const tag = sessionInfo.slice(TEST_SESSION_PREFIX.length).split('.')[0];
    const phoneNumber = Buffer.from(tag, 'base64url').toString('utf8');
    if (!testNumbersOn(config) || !isTestNumber(phoneNumber)
        || !sameCode(code, config.phoneTestCode)) {
      throw new PhoneAuthError('invalid_or_expired_code', 'Invalid or expired code.');
    }
    return { idToken: mintTestToken(phoneNumber) };
  }
  if (!firebaseOffered(config)) {
    throw new PhoneAuthError('invalid_or_expired_code', 'Invalid or expired code.');
  }
  const data = await identityToolkit(config, 'accounts:signInWithPhoneNumber', { sessionInfo, code }, deps);
  if (typeof data.idToken !== 'string' || !data.idToken
      || data.idToken.length > ID_TOKEN_MAX) {
    log.warn('phone-auth', 'Identity Toolkit sent no idToken');
    throw new PhoneAuthError('firebase_unreachable', 'Could not reach the sign-in service. Try again.', 502);
  }
  return { idToken: data.idToken };
}

// ── Leg 2: the Admin SDK and the ID token ───────────────────────────────

/**
 * The Admin SDK auth handle for this process, built once from the same
 * service account mobile push uses. A malformed service account is a
 * config fault, not a caller fault: 503.
 */
function adminAuth(config, deps = {}) {
  const appSdk = deps.appSdk || require('firebase-admin/app');
  const authSdk = deps.authSdk || require('firebase-admin/auth');
  let account;
  try {
    account = parseServiceAccount(config.firebaseServiceAccountJsonB64, config.firebaseProjectId);
  } catch (err) {
    log.error('phone-auth', 'Service account unusable', { err: err.message });
    throw new PhoneAuthError('firebase_unconfigured', 'Phone sign-in is not configured correctly.', 503);
  }
  let app;
  try {
    app = appSdk.initializeApp(
      { credential: appSdk.cert(account), projectId: config.firebaseProjectId },
      ADMIN_APP_NAME
    );
  } catch (err) {
    if (err && err.code === 'app/duplicate-app') {
      app = appSdk.getApp(ADMIN_APP_NAME);
    } else {
      log.error('phone-auth', 'Admin SDK init failed', { err: err.message });
      throw new PhoneAuthError('firebase_unconfigured', 'Phone sign-in is not configured correctly.', 503);
    }
  }
  return authSdk.getAuth(app);
}

/**
 * The claims a phone ID token must carry, checked BEFORE anything touches
 * the database. Anything else (another provider's token, an access token,
 * a replayed one) is the same refusal: 502 bad_token, no detail to steer
 * a forger by.
 */
function badToken() {
  return new PhoneAuthError('bad_token', 'That sign-in did not confirm. Try again.', 502);
}

/**
 * Verify a Firebase ID token and spend it once. Returns
 * { uid, phoneNumber } with the number re-normalized through the same
 * E.164 test the request leg runs, so the table stores one shape however
 * the token spelled it.
 */
async function verifyIdToken(pool, config, rawToken, deps = {}) {
  assertOffered(config);
  if (typeof rawToken !== 'string' || !rawToken || rawToken.length > ID_TOKEN_MAX) {
    throw badToken();
  }
  let uid;
  let phoneNumber;
  let expiresAt;
  let test = false;
  if (rawToken.startsWith(TEST_TOKEN_PREFIX)) {
    // Minted by exchangeCode above for a test number and its code. The uid's
    // prefix keeps it apart from every Firebase uid.
    const claims = testNumbersOn(config) ? readTestToken(rawToken) : null;
    if (!claims) throw badToken();
    ({ phoneNumber, expiresAt } = claims);
    uid = `${TEST_UID_PREFIX}${phoneNumber}`;
    test = true;
  } else {
    if (!firebaseOffered(config)) throw badToken();
    let payload;
    try {
      const verifier = deps.auth || adminAuth(config, deps);
      payload = await verifier.verifyIdToken(rawToken);
    } catch (err) {
      log.warn('phone-auth', 'ID token verification failed', { err: err.message });
      throw badToken();
    }
    if (payload?.firebase?.sign_in_provider !== 'phone') throw badToken();
    phoneNumber = normalizePhone(payload.phone_number);
    if (!phoneNumber) throw badToken();
    uid = typeof payload.uid === 'string' && payload.uid ? payload.uid
      : (typeof payload.sub === 'string' ? payload.sub : '');
    if (!uid || uid.length > UID_MAX) throw badToken();
    expiresAt = new Date((Number(payload.exp) || Math.floor(Date.now() / 1000) + 3600) * 1000);
  }

  // Spent once, exactly like native_sign_in_tokens: the insert is the
  // claim, the conflict is the replay. The winner's expiry bounds the
  // row's life; cleanupExpired reaps the rest.
  let spent;
  try {
    const { rows } = await pool.query(
      `INSERT INTO phone_sign_in_tokens (token_hash, expires_at)
       VALUES ($1, $2)
       ON CONFLICT (token_hash) DO NOTHING
       RETURNING token_hash`,
      [sha256Hex(rawToken), expiresAt]
    );
    spent = rows;
  } catch (err) {
    log.error('phone-auth', 'Token spend check failed', { err: err.message });
    throw badToken();
  }
  if (!spent.length) {
    log.warn('phone-auth', 'ID token used twice');
    throw badToken();
  }
  return test ? { uid, phoneNumber, test: true } : { uid, phoneNumber };
}

/**
 * Expired state cleanup, the way sign-in-providers.js reaps its own.
 * Failures are logged and swallowed: a stuck cleanup row must never stop
 * a sign-in.
 */
async function cleanupExpired(pool) {
  try {
    await pool.query("DELETE FROM phone_sign_in_tokens WHERE expires_at < NOW() - INTERVAL '1 hour'");
    await pool.query("DELETE FROM oauth_signup_sessions WHERE expires_at < NOW() - INTERVAL '1 hour'");
  } catch (err) {
    log.warn('phone-auth', 'Expired phone sign-in state cleanup failed', { err: err.message });
  }
}

/**
 * An account a test number just made is a test account, fenced the way
 * test-accounts.js fences the ones an admin makes: marked for good (votes on
 * a real person's app shown but not counted, no welcome DM, retire_test_account
 * removes it), off the leaderboards, and left out of Journey. Nobody made it
 * on anyone's behalf, so test_account_created_by stays NULL.
 */
async function markTestAccount(client, userId, phoneNumber) {
  await client.query(
    `UPDATE users
        SET test_account_created_at = NOW(), exclude_podium = TRUE, updated_at = NOW()
      WHERE id = $1`,
    [userId]
  );
  const journeyLeftOut = require('./journey-left-out');
  await journeyLeftOut.addTestInTransaction(client, {
    userId, note: `Phone test number …${phoneNumber.slice(-4)}`,
  });
}

/**
 * The account for these claims, in one transaction. Returns one of
 *   { refuse: 'admin_password_required' }
 *   { next: 'signed-in', session, user, userId, created }
 *   { next: 'username', signupToken, expiresAt, userId, created }
 * and throws PhoneAuthError('phone_in_use') when the number already
 * belongs to a different account.
 */
async function signIn(pool, claims, { createSession } = {}) {
  if (typeof createSession !== 'function') throw new Error('signIn requires createSession');
  if (!claims || typeof claims.uid !== 'string' || !claims.uid
      || typeof claims.phoneNumber !== 'string' || !claims.phoneNumber) {
    throw badToken();
  }
  await cleanupExpired(pool);
  let result;
  try {
    result = await withTransaction(pool, async (client) => {
      const { rows: linked } = await client.query(
        `SELECT u.id, u.username, u.is_admin, u.admin_readonly, u.needs_username_choice
           FROM user_phone_identities i
           JOIN users u ON u.id = i.user_id
          WHERE i.firebase_uid = $1
          FOR UPDATE OF i, u`,
        [claims.uid]
      );
      let user = linked[0] || null;
      let created = false;

      if (user) {
        // The email code's refusal, for the same reason (email-signup.js):
        // an admin account signs in with its password, never a phone.
        if (user.is_admin) return { refuse: 'admin_password_required' };
        await client.query(
          'UPDATE user_phone_identities SET last_used_at = NOW() WHERE firebase_uid = $1',
          [claims.uid]
        );
      } else {
        const unusablePasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
        user = await emailSignup.insertEmailUser(client, null, unusablePasswordHash);
        created = true;
        try {
          await client.query(
            `INSERT INTO user_phone_identities (user_id, firebase_uid, phone_e164, last_used_at)
             VALUES ($1, $2, $3, NOW())`,
            [user.id, claims.uid, claims.phoneNumber]
          );
        } catch (error) {
          if (error && error.code === '23505'
              && typeof error.constraint === 'string'
              && error.constraint.includes('phone_e164')) {
            // One account per number: another identity (a different Firebase
            // uid, or a recycled number already linked) holds this one.
            throw PHONE_TAKEN;
          }
          throw error;
        }
        if (claims.test === true) await markTestAccount(client, user.id, claims.phoneNumber);
      }

      if (user.needs_username_choice === true) {
        // A brand-new account continues to the username step, the same
        // continuation Apple and Google mint; sign-in-providers.js's
        // provider-agnostic completeUsername spends it.
        const signupToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + SIGNUP_TTL_MS);
        await client.query(
          `INSERT INTO oauth_signup_sessions (token_hash, user_id, provider, expires_at, created_at)
           VALUES ($1, $2, 'phone', $3, NOW())
           ON CONFLICT (user_id) DO UPDATE
             SET token_hash = EXCLUDED.token_hash,
                 provider = EXCLUDED.provider,
                 expires_at = EXCLUDED.expires_at,
                 created_at = NOW()`,
          [sha256Hex(signupToken), user.id, expiresAt]
        );
        return { next: 'username', signupToken, expiresAt, userId: user.id, created };
      }

      const session = await createSession(client, user.id);
      return {
        next: 'signed-in',
        session,
        userId: user.id,
        created,
        user: {
          id: user.id,
          username: user.username,
          isAdmin: !!user.is_admin,
          adminReadonly: !!user.admin_readonly,
        },
      };
    });
  } catch (error) {
    if (error === PHONE_TAKEN) {
      throw new PhoneAuthError('phone_in_use', 'That phone number already has an account.');
    }
    throw error;
  }
  // The Journey list is cached per pool; its new entry committed above.
  if (result.created && claims.test === true) require('./journey-left-out').forget(pool);
  return result;
}

// ── A name, not a username ──────────────────────────────────────────────
//
// An invite's Join asks a newcomer for "Your name" and a phone number, and
// no username (frontend/src/features/auth/sign-in-sheet.tsx). The name is
// the account's display name, as the profile keeps it (routes/profile.js
// MAX_DISPLAY_NAME), and a PROVISIONAL handle is picked from it
// (usernames.handlesFromName, users.username_provisional_since) for the
// private group to see, so a phone sign-up never stops at "Pick a
// username". Public places ask for a real one first. An invite to a public
// community, or a client that sends no name, gets the username step.

const MAX_NAME = 40;

/** A typed name as the profile would keep it, or null. */
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.replace(/\s+/g, ' ').trim();
  if (!value || value.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

/**
 * Finish a new phone account (signIn's `next: 'username'`) with the name
 * its person typed: the first free handle handlesFromName offers, through
 * sign-in-providers.js's completeUsername (the same continuation, spent the
 * same way, the session minted the same way), and the name as the display
 * name. Returns completeUsername's { session, user }, or null when every
 * handle tried was taken, which leaves the username step as it was.
 */
async function finishWithName(pool, { signupToken, name, createSession }) {
  const providers = require('./sign-in-providers');
  const usernames = require('./usernames');
  for (const handle of usernames.handlesFromName(name)) {
    let done;
    try {
      done = await providers.completeUsername(pool, { signupToken, username: handle, createSession });
    } catch (error) {
      if (error instanceof providers.SignInProviderError
          && (error.code === 'username_taken' || error.code === 'invalid_username')) continue;
      throw error;
    }
    await pool.query(
      `UPDATE users
          SET display_name = CASE WHEN display_name IS NULL OR display_name = '' THEN $2 ELSE display_name END,
              username_provisional_since = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [done.user.id, name]
    );
    return done;
  }
  return null;
}

// ── A phone for an account that has none ────────────────────────────────

/**
 * Link verified phone claims to `userId`, an account that is signed in
 * already (routes/phone-auth.js /api/auth/phone-link/*): somebody who made
 * their account by email, still waiting, adds the phone a private member
 * needs (community-invites.js joinAsPrivateMember). The table's own rules
 * hold: one account per number, one number per account. Returns
 * { linked: true, already } and refuses with
 *   phone_in_use          the number, or its Firebase identity, is another
 *                         account's;
 *   phone_already_linked  this account has a different number (409).
 */
async function linkPhone(pool, claims, userId) {
  if (!claims || typeof claims.uid !== 'string' || !claims.uid
      || typeof claims.phoneNumber !== 'string' || !claims.phoneNumber) {
    throw badToken();
  }
  const inUse = () => new PhoneAuthError('phone_in_use', 'That phone number already has an account.');
  return withTransaction(pool, async (client) => {
    const { rows: mine } = await client.query(
      'SELECT firebase_uid FROM user_phone_identities WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (mine[0]) {
      if (mine[0].firebase_uid === claims.uid) return { linked: true, already: true };
      throw new PhoneAuthError('phone_already_linked', 'This account already has a phone number.', 409);
    }
    const { rows: theirs } = await client.query(
      'SELECT 1 FROM user_phone_identities WHERE firebase_uid = $1 OR phone_e164 = $2',
      [claims.uid, claims.phoneNumber]
    );
    if (theirs.length) throw inUse();
    try {
      await client.query(
        `INSERT INTO user_phone_identities (user_id, firebase_uid, phone_e164, last_used_at)
         VALUES ($1, $2, $3, NOW())`,
        [userId, claims.uid, claims.phoneNumber]
      );
    } catch (error) {
      // Lost a race for the number or the identity.
      if (error && error.code === '23505') throw inUse();
      throw error;
    }
    return { linked: true, already: false };
  });
}

module.exports = {
  SIGNUP_TTL_MS,
  PhoneAuthError,
  offered,
  firebaseOffered,
  testNumbersOn,
  isTestNumber,
  usesTestNumber,
  normalizePhone,
  requestCode,
  sendTestCode,
  recaptchaSiteKey,
  exchangeCode,
  verifyIdToken,
  cleanupExpired,
  signIn,
  MAX_NAME,
  cleanName,
  finishWithName,
  linkPhone,
};
