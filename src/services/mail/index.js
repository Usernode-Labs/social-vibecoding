// Platform outbound mail — the one door every send goes through.
//
// THE CONTRACT, which predates this module and must not change: a send
// never throws and never returns a value the caller must check.
// POST /api/auth/otp/request is always-200 by contract (SPEC
// 1667) precisely so it can't be used to enumerate accounts, and the
// waitlist join has the same shape. So a provider outage, a missing
// credential, a throttled recipient and a successful delivery must all
// look identical from outside. The compensating visibility is the
// `mail_deliveries` table and the Admin → Topochain → Settings card: the
// operator can see what happened even though the user can't.
//
// What this module owns, in order:
//   1. rendering: the stored templates (./template-store, read from memory)
//      rendered by ./templates buildMessage, or the owner's failure order when
//      there are none
//   2. the throttle decision (./rate-limit, fed from mail_deliveries)
//   3. picking the transport (./select: resolved at boot in config.js, and
//      swapped at send time when an admin saved another provider in
//      Admin → Email delivery)
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
const events = require('./events');
const tracking = require('./tracking');
const language = require('./language');
const store = require('./template-store');
const { actionFor } = require('./actions');

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

// Which transport this send goes out on: { transport, provider }.
//
// config.js resolved one at boot from the environment. An admin's saved
// provider (./select savedChoice, read through its ten-second cache) wins
// over it, so the switch in Admin → Email delivery needs no redeploy. A
// staging preview is never switched: its boot transport is the log, and a
// copy of production's saved row must not point a preview at a real provider.
// A saved provider that is not configured is null, the same loud
// "NOT delivered" a named PLATFORM_MAIL_PROVIDER gets, never a quiet
// fallback to another sender.
async function transportFor(config, pool) {
  // `mailTransport` is what config.js resolves today;
  // `topochainMailTransport` is the original hook name, still honoured
  // so an injected test transport and any older caller keep working.
  const boot = (config && (config.mailTransport || config.topochainMailTransport)) || null;
  const bootProvider = (boot && boot.provider)
    || (config && config.mailProvider)
    || (boot ? 'injected' : null);
  if (stagingLogOnly(config)) return { transport: boot, provider: bootProvider };
  const saved = await select.savedChoice(pool);
  if (!saved || saved === bootProvider) return { transport: boot, provider: bootProvider };
  const transport = select.transportNamed(saved, process.env);
  if (!transport) {
    log.error('platform-mail',
      'The mail provider saved in the admin console is not configured — email will NOT be delivered',
      { provider: saved });
  }
  return { transport, provider: transport ? saved : null };
}

function maxPerHour(config) {
  const fromConfig = Number(config && config.mailMaxPerHour);
  if (Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig;
  const fromEnv = Number(process.env.PLATFORM_MAIL_MAX_PER_HOUR);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return rateLimit.DEFAULT_MAX_PER_HOUR;
}

// ─── mail_deliveries bookkeeping ────────────────────────────────────────

// Returns the new row's id, or null when there was no pool or the insert
// failed. send() ignores the return value entirely — the id exists so
// sendTest() can point the admin console at the exact ledger row its
// attempt produced.
async function record(pool, { kind, to, provider, status, error, messageId = events.messageId(), providerMessageId = null, trackingLinks = [], engagementTracked = false }) {
  if (!pool) return null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO mail_deliveries (kind, recipient, provider, status, error, message_id, provider_message_id, tracking_links, engagement_tracked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       RETURNING id`,
      [String(kind || '').slice(0, 64), String(to || '').slice(0, 255),
        provider ? String(provider).slice(0, 32) : null,
        String(status).slice(0, 24),
        error ? String(error).slice(0, 500) : null, messageId,
        providerMessageId ? String(providerMessageId).slice(0, 128) : null, JSON.stringify(trackingLinks), engagementTracked]
    );
    return (rows[0] && rows[0].id) || null;
  } catch (err) {
    // Bookkeeping must never be able to fail a send.
    log.error('platform-mail', 'Could not record a mail delivery', { message: err.message });
    return null;
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
      // WP-E: activity mail and everything else are two budgets, each
      // counted on its own (rate-limit.js ACTIVITY_KINDS).
      pool.query(
        `SELECT COUNT(*)::int AS n FROM mail_deliveries
          WHERE status IN ('sent', 'skipped_staging')
            AND created_at > NOW() - INTERVAL '1 hour'
            AND (kind = ANY($1::text[])) = $2`,
        [[...rateLimit.ACTIVITY_KINDS], rateLimit.ACTIVITY_KINDS.has(kind)]
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

// The sweep below, in one statement. Before a batch of deliveries goes, a
// released waitlist row keeps what the admin Journey's first mile reads
// from them (services/journey.js PERSON_FACTS): its admit mail's first
// send, whether one was tracked, the first open and first followed link
// (never a scanner's or prefetcher's request), and the first sign-in code
// asked for after the admit. Each is the earliest seen, so batches and a
// second run keep the same values. Matched on the address exactly, as the
// first mile reads it. Every sub-statement reads the same snapshot, so the
// events are read before the delete cascades to them.
const PRUNE_SQL = `WITH doomed AS (
    SELECT id FROM mail_deliveries
     WHERE created_at < NOW() - INTERVAL '${RETENTION_DAYS} days'
     LIMIT ${PRUNE_LIMIT}
  ), seen AS (
    SELECT w.id,
           MIN(d.created_at) FILTER (WHERE d.kind = 'waitlist_released' AND d.status = 'sent') AS sent_at,
           bool_or(d.kind = 'waitlist_released' AND d.engagement_tracked) AS tracked,
           MIN(e.created_at) FILTER (WHERE e.type = 'opened') AS opened_at,
           MIN(e.created_at) FILTER (WHERE e.type = 'clicked') AS clicked_at,
           MIN(d.created_at) FILTER (WHERE d.kind = 'otp' AND d.created_at >= w.released_at) AS code_at
      FROM mail_deliveries d
      JOIN waitlist_signups w ON w.email = d.recipient AND w.released_at IS NOT NULL
      LEFT JOIN mail_events e ON e.delivery_id = d.id AND d.kind = 'waitlist_released'
       AND e.type IN ('opened', 'clicked')
       AND e.user_agent_class IS DISTINCT FROM 'scanner_or_prefetch'
     WHERE d.id IN (SELECT x.id FROM doomed x) AND d.kind IN ('waitlist_released', 'otp')
     GROUP BY w.id
  ), kept AS (
    UPDATE waitlist_signups w
       SET release_mail_sent_at = LEAST(w.release_mail_sent_at, s.sent_at),
           release_mail_tracked = (COALESCE(w.release_mail_tracked, FALSE) OR COALESCE(s.tracked, FALSE)),
           release_mail_opened_at = LEAST(w.release_mail_opened_at, s.opened_at),
           release_mail_clicked_at = LEAST(w.release_mail_clicked_at, s.clicked_at),
           release_code_asked_at = LEAST(w.release_code_asked_at, s.code_at)
      FROM seen s
     WHERE w.id = s.id
    RETURNING w.id
  )
  DELETE FROM mail_deliveries
   WHERE id IN (SELECT id FROM doomed)`;

// Events are deleted by the delivery FK’s ON DELETE CASCADE. Suppressions
// intentionally survive retention so blocked addresses stay blocked.
// Retention sweep, called opportunistically (never on a timer of its
// own). Bounded by PRUNE_LIMIT so it stays a small, predictable delete.
async function pruneDeliveries(pool) {
  if (!pool) return 0;
  try {
    const { rowCount } = await pool.query(PRUNE_SQL);
    return rowCount || 0;
  } catch (err) {
    log.error('platform-mail', 'mail_deliveries prune failed', { message: err.message });
    return 0;
  }
}

// The suppression list, read failing OPEN as readHistory does: an address
// that bounced getting one more mail during a database outage is a smaller
// problem than sign-in codes stopping because the read broke.
async function suppressionOf(pool, to) {
  try {
    return await events.suppression(pool, to);
  } catch (err) {
    log.warn('platform-mail', 'Could not read mail suppressions: sending anyway', { message: err.message });
    return null;
  }
}

// ─── the words ──────────────────────────────────────────────────────────

// What a send renders with: the stored template and layout for `kind`, each in
// the reader's language where that part is translated (./template-store
// resolve), the English of both, and the translator for the words an action
// builds in code. That translator is read only when it can matter: an action
// with such words, whose template is translated. `readerHasLanguage` is set for
// every reader with a language other than English, row or no row, because their
// subject is cleaned either way (render.js). A null template sends the owner's
// failure order (templates.js buildMessage).
// With no database configured at all, the first templates in memory
// (template-store seededSnapshot); a configured database that cannot be had is
// the failure order, never those.
async function resolvedFor(config, pool, kind, locale) {
  const action = actionFor(kind);
  const reader = action.englishOnly ? null : language.readerLanguage(locale);
  try {
    const snapshot = pool ? await store.getSnapshot(pool) : (config && config.databaseUrl ? null : store.seededSnapshot());
    const parts = store.resolve(snapshot, kind, reader);
    const bodyTranslated = !!parts.template && parts.template !== parts.english.template;
    const t = bodyTranslated && action.codeWords ? await language.translatorFor(pool, locale) : null;
    return { ...parts, t, readerHasLanguage: !!reader };
  } catch (err) {
    // A row shaped as nothing expected must not cost a sign-in code: it is the
    // same as having no template.
    log.error('platform-mail', 'Could not resolve an email template', { kind, message: err.message });
    return { template: null, layout: null, t: null, readerHasLanguage: !!reader };
  }
}

function unknownKind(kind) {
  return new Error(`unknown mail kind: ${kind}`);
}

// ─── the send door ──────────────────────────────────────────────────────

// send(config, { kind, to, locale, ...payload }) → always resolves undefined.
// `locale` is the language to word it in, when the caller knows one: the
// recipient's users.locale, or what a sender with no account behind the
// address knows (./language.js requestLanguage). No language, English, or
// anything going wrong is English, with nothing read.
async function send(config, { kind, to, locale, ...payload } = {}) {
  try {
    if (!to || !kind) {
      log.error('platform-mail', 'Refusing a mail with no recipient or kind', { kind });
      return;
    }
    const messageId = events.messageId();
    // First: an unknown kind is a programming error and there is no point
    // consulting a throttle, a provider or the templates for it.
    if (!actionFor(kind)) throw unknownKind(kind);

    const pool = poolFor(config);
    const { transport, provider } = await transportFor(config, pool);

    if (!transport) {
      await record(pool, { kind, to, messageId, provider: null, status: 'no_transport' });
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

    const blocked = await suppressionOf(pool, to);
    if (blocked) {
      await record(pool, { kind, to, messageId, provider, status: 'suppressed_bounce', error: blocked });
      return;
    }
    const { recipientHistory, globalCount } = await readHistory(pool, { kind, to });
    const decision = rateLimit.decide({
      kind,
      now: Date.now(),
      recipientHistory,
      globalCount,
      maxPerHour: rateLimit.ACTIVITY_KINDS.has(kind) ? rateLimit.ACTIVITY_MAX_PER_HOUR : maxPerHour(config),
    });
    if (!decision.allowed) {
      await record(pool, {
        kind, to, messageId, provider, status: 'suppressed_rate_limit', error: decision.reason,
      });
      // Not an error: the throttle firing is the system working. The
      // caller's response is unchanged either way.
      log.warn('platform-mail', 'Mail suppressed by the outbound throttle',
        { kind, to, reason: decision.reason });
      return;
    }

    // Store destinations before exposing a tracked link to any provider.
    // If persistence fails, deliver ordinary links with no pixel instead.
    // Asked for last, so a mail that is not going out reads nothing. A
    // transport renders from what it is handed, so the same words reach it:
    // `resolved` travels with the payload, and nothing logs or stores it.
    const worded = { ...payload, resolved: await resolvedFor(config, pool, kind, locale) };
    let rendered;
    try {
      rendered = buildMessage(kind, { ...worded, messageId, trackingEnabled: !!pool && !!tracking.secret() });
    } catch (err) {
      if (err.code !== 'no_template') throw err;
      // The owner's third rule: no template and nothing a plain mail could
      // carry, or a mail that must carry an unsubscribe link. Not sent.
      await record(pool, { kind, to, messageId, provider, status: 'no_template', error: err.message });
      log.error('platform-mail', 'No email template could be used: mail NOT sent', { kind, message: err.message });
      return;
    }
    if (rendered.plainBecause) {
      log.error('platform-mail', 'No email template could be used: sent a plain message with its code or link',
        { kind, reason: rendered.plainBecause });
    }
    const deliveryId = rendered.trackingLinks
      ? await record(pool, { kind, to, messageId, provider, status: 'sending', trackingLinks: rendered.trackingLinks, engagementTracked: true })
      : null;
    const finish = async (status, error = null, providerMessageId = null) => {
      if (!deliveryId) return record(pool, { kind, to, messageId, provider, status, error, providerMessageId });
      try {
        await pool.query(
          'UPDATE mail_deliveries SET status = $2, error = $3, provider_message_id = $4 WHERE id = $1',
          [deliveryId, status, error ? String(error).slice(0, 500) : null, providerMessageId ? String(providerMessageId).slice(0, 128) : null]
        );
      } catch (err) { log.error('platform-mail', 'Could not finalize mail delivery', { message: err.message }); }
    };
    try {
      const detail = await transport.send({ to, kind, ...worded, messageId, trackingEnabled: !!deliveryId });
      await finish(stagingLogOnly(config) ? 'skipped_staging' : 'sent', null, detail?.providerMessageId);
    } catch (err) {
      await finish('failed', err.message);
      log.error('platform-mail', 'Mail transport failed to send',
        { kind, to, provider, message: err.message });
    }
  } catch (err) {
    // The outermost net. Nothing below here may reach a caller.
    log.error('platform-mail', 'Mail send failed before reaching a provider',
      { kind, message: err.message });
  }
}

// ─── the diagnostic send (admin console only) ───────────────────────────

// sendTest(config, { to }) → a structured outcome, always.
//
// This is a SIBLING of send(), never a flag on it. send()'s always-200,
// never-throw, tells-you-nothing contract is load-bearing for the
// unauthenticated flows (SPEC 1667) and must stay exactly as it is. But
// an admin who just pasted a Gmail refresh token needs the opposite: they
// need to be told precisely what happened. The two audiences are
// irreconcilable in one function, so they are two functions that share
// every part underneath — same templates, same throttle, same transport,
// same ledger row.
//
// It still never throws. A caller gets an outcome object with a `status`
// drawn from the same vocabulary mail_deliveries uses:
//   sent | skipped_staging | failed | no_transport | suppressed_rate_limit | suppressed_bounce | no_template
// plus `invalid_recipient` for a request that never reached a provider.
//
// `preview`, from the email template editor, sends a template that is not
// saved: `{ kind, payload, resolved }`, the action's sample payload and the
// words to render it with (the shape send() resolves). It goes the same way as
// the diagnostic mail and is recorded as one (`admin_test` in the ledger), so a
// test of a sign-in template is not counted as a sign-in mail; the transport
// renders it as `kind`, as it would the real one.
async function sendTest(config, { to, preview = null } = {}) {
  const startedAt = Date.now();
  const outcome = {
    status: 'failed',
    provider: null,
    from: null,
    requestedProvider: null,
    stagingLogOnly: stagingLogOnly(config),
    error: null,
    providerMessageId: null,
    deliveryId: null,
    reference: null,
    durationMs: 0,
    message: null,
    missing: [],
  };

  try {
    const pool = poolFor(config);

    // Presence summary for the panel: which provider was ASKED for (an
    // admin's saved choice first, then the deploy's) and which keys are
    // absent. describe() never returns a value, so nothing here can carry a
    // credential.
    try {
      const described = select.describe(process.env, { saved: await select.savedChoice(pool) });
      outcome.requestedProvider = described.requestedProvider || null;
      outcome.missing = Array.isArray(described.missing) ? described.missing : [];
      outcome.from = described.from || null;
    } catch (err) {
      log.warn('platform-mail', 'Could not describe the mail configuration for a test send',
        { message: err.message });
    }

    if (!to) {
      outcome.status = 'invalid_recipient';
      outcome.error = 'No recipient address was given';
      return outcome;
    }

    const { transport, provider } = await transportFor(config, pool);
    outcome.provider = provider;
    if (transport && transport.from) outcome.from = transport.from;

    const messageId = events.messageId();

    // A short, non-secret handle that appears in the email body, in the
    // log line and in the outcome, so an operator can tie the message
    // that landed in their inbox to the attempt that produced it.
    const reference = require('crypto').randomBytes(4).toString('hex');
    outcome.reference = reference;
    const kind = preview ? preview.kind : 'admin_test';
    const payload = preview ? { ...(preview.payload || {}), messageId } : {
      provider: provider || 'none',
      from: outcome.from || '(unset)',
      sentAt: new Date().toISOString(),
      reference, messageId,
    };

    // Render before anything else, so the console can show the exact copy
    // that was (or would have been) delivered even on the failure paths. The
    // same stored template a send uses, and the same words reach the transport.
    const resolved = preview ? preview.resolved : await resolvedFor(config, pool, 'admin_test', null);
    let message;
    try {
      message = buildMessage(kind, { ...payload, resolved });
    } catch (err) {
      if (err.code !== 'no_template') throw err;
      outcome.status = 'no_template';
      outcome.error = String(err.message).slice(0, 500);
      outcome.deliveryId = await record(pool, {
        kind: 'admin_test', to, messageId, provider, status: 'no_template', error: outcome.error,
      });
      log.error('platform-mail', 'No email template could be used for the admin test mail', { message: outcome.error });
      return outcome;
    }
    // A template under test that does not render would go out as the plain
    // fallback, which is not what the admin asked to see.
    if (preview && message.plainBecause) {
      outcome.status = 'no_template';
      outcome.error = `The template could not be used: ${message.plainBecause}`.slice(0, 500);
      outcome.deliveryId = await record(pool, {
        kind: 'admin_test', to, messageId, provider, status: 'no_template', error: outcome.error,
      });
      return outcome;
    }
    outcome.message = { subject: message.subject, text: message.text };

    if (!transport) {
      outcome.status = 'no_transport';
      outcome.error = outcome.missing.length
        ? `No mail transport is configured (missing: ${outcome.missing.join(', ')})`
        : 'No mail transport is configured';
      outcome.deliveryId = await record(pool, {
        kind: 'admin_test', to, messageId, provider: null, status: 'no_transport',
      });
      return outcome;
    }

    const blocked = await suppressionOf(pool, to);
    if (blocked) {
      outcome.status = 'suppressed_bounce';
      outcome.error = blocked;
      outcome.deliveryId = await record(pool, { kind: 'admin_test', to, messageId, provider, status: outcome.status, error: blocked });
      return outcome;
    }
    const { recipientHistory, globalCount } = await readHistory(pool, { kind: 'admin_test', to });
    const decision = rateLimit.decide({
      kind: 'admin_test',
      now: Date.now(),
      recipientHistory,
      globalCount,
      maxPerHour: maxPerHour(config),
    });
    if (!decision.allowed) {
      outcome.status = 'suppressed_rate_limit';
      outcome.error = decision.reason;
      outcome.retryAfterMs = decision.retryAfterMs;
      outcome.deliveryId = await record(pool, {
        kind: 'admin_test', to, messageId, provider, status: 'suppressed_rate_limit', error: decision.reason,
      });
      return outcome;
    }

    try {
      const detail = await transport.send({ to, kind, ...payload, resolved });
      if (detail && detail.providerMessageId) {
        outcome.providerMessageId = String(detail.providerMessageId).slice(0, 128);
      }
      outcome.status = stagingLogOnly(config) ? 'skipped_staging' : 'sent';
      outcome.deliveryId = await record(pool, {
        kind: 'admin_test', to, messageId, provider, status: outcome.status, providerMessageId: outcome.providerMessageId,
      });
    } catch (err) {
      outcome.status = 'failed';
      // The provider's own bounded complaint. Transports already slice
      // their error bodies; slice again so a surprising one can't fill a
      // response.
      outcome.error = String(err.message || err).slice(0, 500);
      outcome.deliveryId = await record(pool, {
        kind: 'admin_test', to, messageId, provider, status: 'failed', error: outcome.error,
      });
      log.error('platform-mail', 'Admin test mail failed to send',
        { provider, reference, message: outcome.error });
    }
    return outcome;
  } catch (err) {
    // Same outermost net as send(): a diagnostic that crashes is worse
    // than one that reports its own crash.
    outcome.status = 'failed';
    outcome.error = String(err.message || err).slice(0, 500);
    log.error('platform-mail', 'Admin test mail failed before reaching a provider',
      { message: outcome.error });
    return outcome;
  } finally {
    outcome.durationMs = Date.now() - startedAt;
  }
}

// ─── the named senders (the caller-facing API) ──────────────────────────

async function sendOtpMail(config, email, code, { locale = null } = {}) {
  await send(config, { kind: 'otp', to: email, code, ...(locale ? { locale } : {}) });
}

// `moreToken` (two-stage waitlist survey) turns into two links: the
// one-click confirm link, which stamps confirmed_at and lands on the
// survey, and the bare survey link, which stays the durable "Want in
// sooner?" home for anyone who stopped at the join. An idempotent re-join
// mints no token and so carries neither.
async function sendWaitlistJoinMail(config, email, { moreToken = null, code = null, locale = null } = {}) {
  await send(config, {
    kind: 'waitlist_joined',
    to: email,
    ...(locale ? { locale } : {}),
    code,
    url: moreToken ? `${PRODUCTION_ORIGIN}/#more/${moreToken}` : null,
    confirmUrl: moreToken
      ? `${PRODUCTION_ORIGIN}/api/public/waitlist/confirm/${moreToken}`
      : null,
  });
}

// A confirmation code the recipient asked for again: the resend endpoint,
// and the re-join branch of the join endpoint. Its own kind, so the join
// mail's one-per-day rule cannot swallow it and so the words are the ones
// somebody chasing a code needs rather than a second welcome.
//
// `confirmed: true` is the check-my-status shape (#1538): the address
// already has a confirmed_at, so the code proves the mailbox rather than
// confirming it, and the mail's one button goes to the code-entry screen
// carrying NO token. `code: null` is the degradation for that same
// address when minting failed — the template's "nothing left to do"
// shape, which is still true. The mail is the ONLY channel that discloses
// confirmation state: the HTTP response is identical either way.
//
// The status URL is a QUERY, not a fragment. Link rewriters drop
// fragments (#1545), and AuthScreens.enter() turns `?status=1` back into
// the code-entry route on arrival.
async function sendWaitlistCodeMail(
  config,
  email,
  { code = null, moreToken = null, confirmed = false, locale = null } = {}
) {
  await send(config, {
    kind: 'waitlist_code',
    to: email,
    ...(locale ? { locale } : {}),
    code,
    confirmed,
    confirmUrl: code && moreToken && !confirmed
      ? `${PRODUCTION_ORIGIN}/api/public/waitlist/confirm/${moreToken}`
      : null,
    statusUrl: confirmed
      ? `${PRODUCTION_ORIGIN}/?status=1`
      : (!code && moreToken ? `${PRODUCTION_ORIGIN}/#more/${moreToken}` : null),
  });
}

// The plaintext reset token exists only here (in the link) and in the
// requester's response path — the DB holds its sha256. The caller mints and
// hashes; this just carries it.
async function sendPasswordResetMail(config, email, token, { locale = null } = {}) {
  await send(config, {
    kind: 'password_reset',
    to: email,
    ...(locale ? { locale } : {}),
    // Segment style (like #more/<token>): AuthScreens.routeFromHash splits
    // hash routes on '/', so a ?token= query would never parse.
    url: `${PRODUCTION_ORIGIN}/#reset-password/${token}`,
  });
}

/**
 * The "you're in" welcome on release from the waitlist. Its one action is a link.
 *
 * #1545: the destination is a QUERY, not a fragment. It was
 * `/#signup`, and the report was that following it from a desktop mail client
 * landed on the home page while the same mail worked from a phone. That is
 * the signature of a link rewriter: a fragment is client-side only, so a
 * scanner or tracker that rebuilds the URL has nothing to lose by dropping
 * `#signup`, and what arrives is a bare `/`. Query strings survive that,
 * because a rewriter has to carry them to reconstruct the address at all.
 *
 * `AuthScreens.enter()` already honoured `?signup=1` as "a pre-SPA link
 * form"; it now honours `?login=1` the same way, and rewrites either to its
 * hash route on arrival, so the address bar ends up exactly where the old
 * link pointed. The fragment spelling still works for anything that already
 * has one.
 */
async function sendWaitlistReleaseMail(config, email, { hasAccount = false, moreToken = null, signInToken = null, mobile = null, locale = null } = {}) {
  const { CREDENTIAL_PARAM } = require('./tracking');
  await send(config, {
    kind: 'waitlist_released',
    to: email,
    ...(locale ? { locale } : {}),
    // #1548: carry a TOKEN so the signup screen can prefill the address and
    // send the code without a second step.
    //
    // Not the address itself, and not a fragment, which were the two obvious
    // options and are both wrong here:
    //
    //   A FRAGMENT is client-side only, so a link rewriter reconstructing the
    //   URL drops it. That is exactly the bug #1545 fixed on this same mail:
    //   it landed on the home page from a desktop client and worked from a
    //   phone. A prefill carried in `#signup/<address>` would silently vanish
    //   for the very people that fix was for.
    //
    //   THE ADDRESS IN A QUERY survives rewriters but puts an email in a URL,
    //   which means server logs and referrers. For a waitlist, membership is
    //   the fact people would least want landing there.
    //
    // `more_token` is already an unguessable capability delivered to this
    // address, and GET /api/public/waitlist/more/:token already resolves it
    // (rate-limited, scan-limited) and already returns the email. So this
    // needs no new endpoint and no new secret: the query survives the
    // rewriter, and what travels is a token the recipient already holds.
    //
    // #4594: `key` is a SEPARATE one-time sign-in link (services/
    // release-links.js): random, stored hashed, single use, 7 days, bound to
    // this row and address. The page spends it with a POST, so opening the
    // link (a scanner's prefetch included) spends nothing, and the mail
    // leaves it out of click tracking (./tracking.js). `t` stays alongside
    // it as the prefill for when the key no longer works.
    url: hasAccount
      ? `${PRODUCTION_ORIGIN}/?login=1`
      : `${PRODUCTION_ORIGIN}/?signup=1${moreToken ? `&t=${encodeURIComponent(moreToken)}` : ''}`
        + (signInToken ? `&${CREDENTIAL_PARAM}=${encodeURIComponent(signInToken)}` : ''),
    hasAccount,
    // Which note goes under the button: the one-time link's, or the code's.
    signInLink: !hasAccount && !!signInToken,
    // { ios, android } store listings from services/mobile-store-links.js; a
    // platform with no published link gets no install steps.
    mobile,
  });
}

/**
 * A project invite to an address that is not on Homeroom yet
 * (services/email-invites.js). The link is the waitlist: the invited person
 * joins it like anyone else, and the invite waits on their account.
 */
async function sendProjectInviteMail(config, email, { inviter = null, project = null, locale = null } = {}) {
  const { waitlistUrl } = require('../marketing-links');
  await send(config, { kind: 'project_invite', to: email, ...(locale ? { locale } : {}), inviter, project, url: waitlistUrl(config) });
}

module.exports = {
  send,
  sendProjectInviteMail,
  sendTest,
  sendOtpMail,
  sendPasswordResetMail,
  sendWaitlistJoinMail,
  sendWaitlistCodeMail,
  sendWaitlistReleaseMail,
  pruneDeliveries,
  PRUNE_SQL,
  buildMessage,
  KINDS,
  chooseTransport: select.chooseTransport,
  describe: select.describe,
  savedChoice: select.savedChoice,
  setProvider: select.setProvider,
  transportFor,
  RETENTION_DAYS,
  PRUNE_LIMIT,
};
