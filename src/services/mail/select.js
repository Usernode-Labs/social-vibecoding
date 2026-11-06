// Which transport actually sends, and what the admin console is told
// about it.
//
// Order of decisions, most binding first:
//
//  1. USERNODE_ENV=staging → ALWAYS the log transport. A staging preview
//     is a clone of production data (see the staging-privacy convention in
//     src/db/schema.sql), so it may hold real email addresses. Letting a
//     preview reach a real provider would mail real people from a branch
//     nobody voted on yet. This is the single-outbound-boundary use of the
//     staging gate — no feature is disabled, only delivery.
//  2. A provider an admin saved from Admin → Email delivery
//     (platform_settings `mail_provider`: gmail | http | brevo) → that one,
//     or null if it isn't configured. It wins over the deploy's variable, as
//     the saved SMS provider does (../sms/select.js).
//  3. An explicit PLATFORM_MAIL_PROVIDER (gmail | http | brevo | log) → that one,
//     or null if it isn't configured. An operator who names a provider
//     wants to know it's broken, not to be silently downgraded.
//     Brevo is only ever chosen by name, here or in step 2: BREVO_API_KEY
//     also sends SMS, so a deploy that has it has not thereby asked for its
//     mail to move.
//  4. auto (the default) → gmail, then http. If neither is configured:
//     null in production (so mailer's loud "NOT delivered" error fires and
//     Global Constraints #6 keeps the code out of the production log), and
//     the log transport outside production, so a developer can read codes
//     out of the console.
//
// A partially-configured provider is never a candidate: each transport's
// create() logs the missing keys and returns null, and selection falls
// through.
//
// config.js still resolves a transport once at boot, from the environment
// alone. The saved choice is read at send time (savedChoice, cached for ten
// seconds like the other platform settings), and ../index.js swaps the
// transport when it names a different provider (transportNamed), so a switch
// in the console needs no redeploy and reaches every process within seconds.
'use strict';

const log = require('../logger');
const gmail = require('./transports/gmail');
const httpApi = require('./transports/http-api');
const brevo = require('./transports/brevo');
const logTransport = require('./transports/log');

// The single sender address for all platform mail. Committed as the
// default so a fresh deploy has a correct From without an operator
// setting anything — but the mailbox behind it still has to be
// authorised with the provider before a send succeeds.
const DEFAULT_FROM = 'Homeroom <no-reply@onhomeroom.com>';

const PROVIDERS = ['gmail', 'http', 'brevo', 'log'];

// What an admin may save: the providers that put mail on the wire. `log` and
// `auto` stay the deploy's to name.
const SWITCHABLE = ['gmail', 'http', 'brevo'];
const LABELS = {
  gmail: 'Gmail API (OAuth2)',
  http: 'Generic HTTP mail API',
  brevo: 'Brevo email API',
};
const KEY = 'mail_provider';
const CACHE_MS = 10_000;

function isSwitchable(name) {
  return typeof name === 'string' && SWITCHABLE.includes(name);
}

function isStaging(env) {
  return (env && env.USERNODE_ENV) === 'staging';
}

function isProduction(env) {
  const e = env || {};
  return e.USERNODE_ENV === 'production' || e.NODE_ENV === 'production';
}

// PLATFORM_MAIL_FROM is the modern key; TOPOCHAIN_MAIL_FROM is honoured
// as a fallback so a deploy that configured mail before this refactor
// keeps its sender without an edit.
function resolveFrom(env) {
  const e = env || {};
  return (e.PLATFORM_MAIL_FROM || '').trim()
    || (e.TOPOCHAIN_MAIL_FROM || '').trim()
    || DEFAULT_FROM;
}

function requestedProvider(env) {
  const raw = ((env && env.PLATFORM_MAIL_PROVIDER) || '').trim().toLowerCase();
  if (!raw || raw === 'auto') return 'auto';
  if (PROVIDERS.includes(raw)) return raw;
  log.error('platform-mail',
    'PLATFORM_MAIL_PROVIDER is not a known provider — falling back to auto',
    { allowed: [...PROVIDERS, 'auto'] });
  return 'auto';
}

// Returns { transport, provider, from, stagingLogOnly, requested, source }.
// `transport` is null when nothing can send; every caller treats that as
// "log it, don't deliver it", never as an error. `saved` is an admin's saved
// provider, which is treated exactly as a named PLATFORM_MAIL_PROVIDER is;
// `source` says who named `requested`: 'admin', 'env', or 'default' (auto).
function chooseTransport(env, { saved = null } = {}) {
  const e = env || {};
  const from = resolveFrom(e);
  const fromEnv = requestedProvider(e);
  const requested = isSwitchable(saved) ? saved : fromEnv;
  const source = isSwitchable(saved) ? 'admin' : (fromEnv === 'auto' ? 'default' : 'env');
  const opts = { sender: from };

  if (isStaging(e)) {
    return {
      transport: logTransport.create(),
      provider: logTransport.PROVIDER,
      from,
      stagingLogOnly: true,
      requested,
      source,
    };
  }

  const build = {
    gmail: () => gmail.create(e, opts),
    http: () => httpApi.create(e, opts),
    brevo: () => brevo.create(e, opts),
    log: () => logTransport.create(),
  };

  if (requested !== 'auto') {
    const transport = build[requested]();
    if (!transport) {
      log.error('platform-mail',
        source === 'admin'
          ? `The mail provider saved in the admin console (${requested}) is not configured — email will NOT be delivered`
          : `PLATFORM_MAIL_PROVIDER=${requested} is not configured — email will NOT be delivered`,
        { missing: missingFor(requested, e) });
      return { transport: null, provider: null, from, stagingLogOnly: false, requested, source };
    }
    return { transport, provider: requested, from, stagingLogOnly: false, requested, source };
  }

  for (const name of ['gmail', 'http']) {
    const transport = build[name]();
    if (transport) {
      return { transport, provider: name, from, stagingLogOnly: false, requested, source };
    }
  }

  if (isProduction(e)) {
    // Production must NOT fall back to logging: that would print login
    // codes into the production log (Global Constraints #6). Null instead,
    // which is what makes the mailer's loud error fire.
    return { transport: null, provider: null, from, stagingLogOnly: false, requested, source };
  }

  return {
    transport: logTransport.create(),
    provider: logTransport.PROVIDER,
    from,
    stagingLogOnly: false,
    requested,
    source,
  };
}

function missingFor(provider, env) {
  if (provider === 'gmail') return gmail.missingKeys(env);
  if (provider === 'http') return httpApi.missingKeys(env);
  if (provider === 'brevo') return brevo.missingKeys(env);
  return [];
}

// ─── the admin's saved choice ────────────────────────────────────────────

let cache = null; // { at, value }: the saved provider, or null when none is

/**
 * The provider an admin saved, or null. Cached for ten seconds, and never
 * throws: with no pool, no row or an unknown value the answer is null, which
 * leaves the deploy's own choice in force. A read that fails keeps the last
 * answer this process had (null before the first one), so a database hiccup
 * neither takes sign-in codes down nor moves mail back to another provider
 * for ten seconds.
 */
async function savedChoice(pool, { now = Date.now() } = {}) {
  if (!pool) return null;
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  let value = null;
  try {
    const { rows } = await pool.query('SELECT value FROM platform_settings WHERE key = $1', [KEY]);
    const saved = rows && rows[0] ? rows[0].value : null;
    if (isSwitchable(saved)) value = saved;
  } catch (err) {
    // platform_settings may not exist yet on a very first boot.
    log.warn('platform-mail', 'mail_provider read failed', { message: err.message });
    value = cache ? cache.value : null;
  }
  cache = { at: now, value };
  return value;
}

async function setProvider(pool, name, userId = null) {
  if (!isSwitchable(name)) throw new Error(`Unknown mail provider: ${name}`);
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [KEY, name, userId]
  );
  cache = { at: Date.now(), value: name };
  return name;
}

function invalidate() {
  cache = null;
  built = new WeakMap();
}

// One transport per provider and environment, built the first time a saved
// choice asks for it and kept: Gmail's holds the access token it refreshes,
// and building one per mail would spend a token exchange on every send.
let built = new WeakMap();

/** The transport for a named provider, or null when it is not configured. */
function transportNamed(name, env = process.env) {
  if (!isSwitchable(name)) return null;
  const e = env || {};
  let perEnv = built.get(e);
  if (!perEnv) { perEnv = new Map(); built.set(e, perEnv); }
  if (perEnv.has(name)) return perEnv.get(name);
  const opts = { sender: resolveFrom(e) };
  const transport = name === 'gmail' ? gmail.create(e, opts)
    : name === 'http' ? httpApi.create(e, opts)
      : brevo.create(e, opts);
  // Only a transport that could be built is kept: a provider whose keys are
  // missing is asked again, and reported again, on the next send.
  if (transport) perEnv.set(name, transport);
  return transport || null;
}

// What Admin → Email delivery and Admin → Topochain → Settings render.
// Presence only: never a key, never an endpoint. `from` IS returned — the
// sender address is public (it's in every mail we send) and an admin needs to
// see which address a deploy will send as. `saved` is the admin's saved
// provider (savedChoice), when the caller has read it.
function describe(env, { saved = null } = {}) {
  const e = env || {};
  const chosen = chooseTransport(e, { saved });
  const gmailMissing = gmail.missingKeys(e);
  const httpMissing = httpApi.missingKeys(e);
  const brevoMissing = brevo.missingKeys(e);
  const missingOf = { gmail: gmailMissing, http: httpMissing, brevo: brevoMissing };

  return {
    // "configured" means mail leaves the building. Staging is honestly
    // reported as NOT configured for delivery, with stagingLogOnly
    // explaining why, so nobody reads a green card and expects an inbox.
    configured: Boolean(chosen.transport) && chosen.provider !== 'log',
    provider: chosen.provider,
    requestedProvider: chosen.requested,
    // Who named requestedProvider: 'admin' (saved in the console), 'env'
    // (PLATFORM_MAIL_PROVIDER) or 'default' (auto).
    source: chosen.source,
    stagingLogOnly: chosen.stagingLogOnly,
    from: chosen.from,
    usingDefaultFrom: chosen.from === DEFAULT_FROM,
    // Per-provider readiness, so the card can say "Gmail needs these two
    // keys" instead of "mail is broken". `ready` is what the console's switch
    // goes by: configured, or a staging preview, which only ever logs and so
    // needs no provider's keys to try the switch.
    providers: SWITCHABLE.map((name) => ({
      name,
      label: LABELS[name],
      configured: missingOf[name].length === 0,
      ready: missingOf[name].length === 0 || chosen.stagingLogOnly,
      missing: missingOf[name],
    })),
    // What the admin has to fix: the provider that was named, else the
    // DEFAULT (gmail) path. This is what the amber card lists.
    missing: missingOf[chosen.requested] || gmailMissing,
    affectedFlows: [
      'Mobile email login (one-time codes)',
      'Onboarding waitlist confirmations',
      'Waitlist release notifications',
    ],
  };
}

module.exports = {
  chooseTransport,
  describe,
  resolveFrom,
  DEFAULT_FROM,
  PROVIDERS,
  SWITCHABLE,
  KEY,
  CACHE_MS,
  isSwitchable,
  savedChoice,
  setProvider,
  transportNamed,
  invalidate,
};
