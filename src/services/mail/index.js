// Platform outbound mail — the one door every send goes through.
//
// THE CONTRACT, which predates this module and must not change: a send
// never throws and never returns a value the caller must check.
// POST /api/v4/mobile/auth/otp/request is always-200 by contract (SPEC
// 1667) precisely so it can't be used to enumerate accounts, and the
// waitlist join has the same shape. So a provider outage, a missing
// credential, a throttled recipient and a successful delivery must all
// look identical from outside. The compensating visibility is the
// `mail_deliveries` table and the Admin → Topochain → Settings card: the
// operator can see what happened even though the user can't.
//
// What this module owns, in order:
//   1. rendering is delegated to ./templates
//   2. the throttle decision (./rate-limit, fed from mail_deliveries)
//   3. picking the transport (./select, resolved once at boot in config.js)
//   4. recording the outcome in mail_deliveries
//   5. swallowing absolutely everything
//
// The three named senders at the bottom (sendOtpMail /
// sendWaitlistJoinMail / sendWaitlistReleaseMail) are the caller-facing
// API and keep the signatures they had when they lived in
// src/services/topochain/mailer.js, which is now a re-export shim.
'use strict';

const log = require('../logger');
const { PRODUCTION_ORIGIN } = require('../cli-auth-constants');
const { buildMessage, KINDS } = require('./templates');
const rateLimit = require('./rate-limit');
const select = require('./select');

// How long a delivery record is kept. Long enough to answer "did that
// user ever get their code last week", short enough that the table is not
// a growing archive of who signed up when.
const RETENTION_DAYS = 30;
// Bound on one opportunistic prune, so the cleanup can never turn into a
// long lock on the request that happens to trigger it.
const PRUNE_LIMIT = 2000;

// Resolve a pool WITHOUT assuming there is one. Several suites construct
// a config with only a mail transport in it (no databaseUrl), and asking
// src/db/pool.js for a pool in that case would build a Pool pointed at
// nothing. No pool simply means no throttling and no delivery record —
// the send itself still happens.
function poolFor(config) {
  if (!config || !config.databaseUrl) return null;
  try {
    return require('../../db/pool').getPool(config);
  } catch (err) {
    log.error('platform-mail', 'Could not resolve a database pool for mail bookkeeping',
      { message: err.message });
    return null;
  }
}

function stagingLogOnly(config) {
  if (config && typeof config.mailStagingLogOnly === 'boolean') {
    return config.mailStagingLogOnly;
  }
  return process.env.USERNODE_ENV === 'staging';
}

function maxPerHour(config) {
  const fromConfig = Number(config && config.mailMaxPerHour);
  if (Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig;
  const fromEnv = Number(process.env.PLATFORM_MAIL_MAX_PER_HOUR);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return rateLimit.DEFAULT_MAX_PER_HOUR;
}

// ─── mail_deliveries bookkeeping ────────────────────────────────────────

async function record(pool, { kind, to, provider, status, error }) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO mail_deliveries (kind, recipient, provider, status, error)
       VALUES ($1, $2, $3, $4, $5)`,
      [String(kind || '').slice(0, 64), String(to || '').slice(0, 255),
        provider ? String(provider).slice(0, 32) : null,
        String(status).slice(0, 24),
        error ? String(error).slice(0, 500) : null]
    );
  } catch (err) {
    // Bookkeeping must never be able to fail a send.
    log.error('platform-mail', 'Could not record a mail delivery', { message: err.message });
  }
}

async function readHistory(pool, { kind, to }) {
  if (!pool) return { recipientHistory: [], globalCount: 0 };
  try {
    const [recipient, global] = await Promise.all([
      pool.query(
        `SELECT status, created_at FROM mail_deliveries
          WHERE recipient = $1 AND kind = $2
            AND created_at > NOW() - INTERVAL '24 hours'
          ORDER BY created_at DESC
          LIMIT 50`,
        [to, kind]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM mail_deliveries
          WHERE status IN ('sent', 'skipped_staging')
            AND created_at > NOW() - INTERVAL '1 hour'`
      ),
    ]);
    return {
      recipientHistory: recipient.rows,
      globalCount: (global.rows[0] && global.rows[0].n) || 0,
    };
  } catch (err) {
    // A read failure must not block mail. Fail OPEN on the throttle: a
    // missed rate-limit is a smaller problem than login codes stopping
    // because a query broke.
    log.error('platform-mail', 'Could not read mail history — throttle skipped',
      { message: err.message });
    return { recipientHistory: [], globalCount: 0 };
  }
}

// Retention sweep, called opportunistically (never on a timer of its
// own). Bounded by PRUNE_LIMIT so it stays a small, predictable delete.
async function pruneDeliveries(pool) {
  if (!pool) return 0;
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM mail_deliveries
        WHERE id IN (
          SELECT id FROM mail_deliveries
           WHERE created_at < NOW() - INTERVAL '${RETENTION_DAYS} days'
           LIMIT ${PRUNE_LIMIT}
        )`
    );
    return rowCount || 0;
  } catch (err) {
    log.error('platform-mail', 'mail_deliveries prune failed', { message: err.message });
    return 0;
  }
}

// ─── the send door ──────────────────────────────────────────────────────

// send(config, { kind, to, ...payload }) → always resolves undefined.
async function send(config, { kind, to, ...payload } = {}) {
  try {
    if (!to || !kind) {
      log.error('platform-mail', 'Refusing a mail with no recipient or kind', { kind });
      return;
    }
    // Render first: an unknown kind is a programming error and there is
    // no point consulting a throttle or a provider for it.
    buildMessage(kind, payload);

    // `mailTransport` is what config.js resolves today;
    // `topochainMailTransport` is the original hook name, still honoured
    // so an injected test transport and any older caller keep working.
    const transport = (config && (config.mailTransport || config.topochainMailTransport)) || null;
    const provider = (transport && transport.provider)
      || (config && config.mailProvider)
      || (transport ? 'injected' : null);
    const pool = poolFor(config);

    if (!transport) {
      await record(pool, { kind, to, provider: null, status: 'no_transport' });
      if (config && (config.env === 'production' || process.env.USERNODE_ENV === 'production')) {
        // Global Constraints #6: NEVER log the raw code in production. An
        // unconfigured transport in prod is an operational failure — log it
        // loudly as an error so it gets noticed — but the caller still gets
        // its normal success response (no enumeration, no user-visible
        // difference between "sent" and "mailer is unconfigured").
        log.error('platform-mail',
          'No mail transport configured — mail NOT delivered', { kind, to });
        return;
      }
      // Dev convenience only, and only outside production: print the
      // payload so a developer can complete the flow by hand.
      log.info('platform-mail', 'Mail not delivered (no transport configured)',
        { kind, to, ...payload });
      return;
    }

    const { recipientHistory, globalCount } = await readHistory(pool, { kind, to });
    const decision = rateLimit.decide({
      kind,
      now: Date.now(),
      recipientHistory,
      globalCount,
      maxPerHour: maxPerHour(config),
    });
    if (!decision.allowed) {
      await record(pool, {
        kind, to, provider, status: 'suppressed_rate_limit', error: decision.reason,
      });
      // Not an error: the throttle firing is the system working. The
      // caller's response is unchanged either way.
      log.warn('platform-mail', 'Mail suppressed by the outbound throttle',
        { kind, to, reason: decision.reason });
      return;
    }

    try {
      await transport.send({ to, kind, ...payload });
      await record(pool, {
        kind, to, provider,
        status: stagingLogOnly(config) ? 'skipped_staging' : 'sent',
      });
    } catch (err) {
      await record(pool, { kind, to, provider, status: 'failed', error: err.message });
      log.error('platform-mail', 'Mail transport failed to send',
        { kind, to, provider, message: err.message });
    }
  } catch (err) {
    // The outermost net. Nothing below here may reach a caller.
    log.error('platform-mail', 'Mail send failed before reaching a provider',
      { kind, message: err.message });
  }
}

// ─── the named senders (the caller-facing API) ──────────────────────────

async function sendOtpMail(config, email, code) {
  await send(config, { kind: 'otp', to: email, code });
}

// `moreToken` (two-stage waitlist survey) turns into two links: the
// one-click confirm link, which stamps confirmed_at and lands on the
// survey, and the bare survey link, which stays the durable "Want in
// sooner?" home for anyone who stopped at the join. An idempotent re-join
// mints no token and so carries neither.
async function sendWaitlistJoinMail(config, email, { moreToken = null } = {}) {
  await send(config, {
    kind: 'waitlist_joined',
    to: email,
    url: moreToken ? `${PRODUCTION_ORIGIN}/#more/${moreToken}` : null,
    confirmUrl: moreToken
      ? `${PRODUCTION_ORIGIN}/api/public/waitlist/confirm/${moreToken}`
      : null,
  });
}

async function sendWaitlistReleaseMail(config, email, { hasAccount = false } = {}) {
  await send(config, {
    kind: 'waitlist_released',
    to: email,
    url: `${PRODUCTION_ORIGIN}/#${hasAccount ? 'login' : 'signup'}`,
    hasAccount,
  });
}

module.exports = {
  send,
  sendOtpMail,
  sendWaitlistJoinMail,
  sendWaitlistReleaseMail,
  pruneDeliveries,
  buildMessage,
  KINDS,
  chooseTransport: select.chooseTransport,
  describe: select.describe,
  RETENTION_DAYS,
  PRUNE_LIMIT,
};
