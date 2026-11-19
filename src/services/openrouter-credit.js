'use strict';

// #6867: how much Homeroom bot's building credit is left, told to the full
// admins before it runs out, and what to do when it does.
//
// On 19 Nov 2026 OpenRouter's credit ran out and the bot stopped writing
// plans. Nobody was warned: plan turns just began ending on an API error,
// the error's text was thrown away, and people were told "something went
// wrong during the build" and asked to reply. This module is the warning
// and the pause:
//
//   read    the account's remaining credit (GET /credits, the management
//           key) and the bot key's own limit_remaining (GET /key). The
//           lower of the two counts; either may be missing.
//   decide  a pure policy over that number and what it has already said:
//           one warning below the warn level, one more urgent below the
//           urgent level, each said once per crossing and re-armed when the
//           balance goes back above the level. An outage is cleared once the
//           read shows credit again, at least BACK_AFTER_MS after it began.
//   detect  `creditOut` reads a turn's result: OpenRouter's 402 for credit
//           is an outage, not a failed build.
//
// The thresholds are platform settings, so an admin can move them without a
// change. The state (the last read, which warnings are armed, the outage) is
// one platform setting too; there is no table of its own.

const log = require('./logger');

const KEY_WARN = 'homeroom_bot_credit_warn_cents';
const KEY_URGENT = 'homeroom_bot_credit_urgent_cents';
const KEY_STATE = 'homeroom_bot_credit_state';

// $500, then $200.
const DEFAULT_WARN_CENTS = 50000;
const DEFAULT_URGENT_CENTS = 20000;
// Credit is back when the read shows this much, and only once the outage has
// stood a little while: a 402 and the read are minutes apart, and the read
// that still shows a few cents must not lift the pause.
const BACK_CENTS = 2500;
const BACK_AFTER_MS = 5 * 60 * 1000;

const BOT_USERNAME = 'homeroom_bot';

function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

// ── Reading ────────────────────────────────────────────────────────────

async function readSettings(pool) {
  let rows = [];
  try {
    ({ rows } = await pool.query(
      'SELECT key, value FROM platform_settings WHERE key = ANY($1)',
      [[KEY_WARN, KEY_URGENT, KEY_STATE]],
    ));
  } catch (err) {
    log.warn('openrouter-credit', 'platform_settings read failed', { err: err.message });
  }
  const map = new Map((rows || []).map((r) => [r.key, r.value]));
  const num = (v, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  let state = null;
  try {
    const parsed = JSON.parse(map.get(KEY_STATE) || 'null');
    if (parsed && typeof parsed === 'object') state = parsed;
  } catch {}
  return {
    warnCents: num(map.get(KEY_WARN), DEFAULT_WARN_CENTS),
    urgentCents: num(map.get(KEY_URGENT), DEFAULT_URGENT_CENTS),
    state,
  };
}

async function writeSetting(pool, key, value) {
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value],
  );
}

/**
 * The numbers the console shows and the sweep decides from:
 * { accountCents, keyCents, balanceCents, at }. Any of the first three may be
 * null when its read failed. Never throws.
 */
async function readBalance(pool, config) {
  const out = { accountCents: null, keyCents: null, at: new Date().toISOString() };
  const management = require('./openrouter-management-client');
  if (config?.openrouterManagementApiKey) {
    try {
      const credits = await management.getCredits({
        apiKey: config.openrouterManagementApiKey,
        baseUrl: config.openrouterApiBase,
        origin: config.openrouterOrigin,
      });
      if (Number.isFinite(credits?.remainingCents)) out.accountCents = Math.max(0, Math.round(credits.remainingCents));
    } catch (err) {
      log.warn('openrouter-credit', 'Could not read the account credit', { err: err.message });
    }
  }
  try {
    const { rows: [botRow] = [] } = await pool.query(
      'SELECT id FROM users WHERE username = $1 AND is_synthetic = TRUE', [BOT_USERNAME],
    );
    if (botRow) {
      const credentialStore = require('./credential-store');
      const key = { provider: 'openrouter', purpose: 'coding_agent' };
      const meta = await credentialStore.readMetadata({ pool, userId: botRow.id, ...key });
      if (meta && meta.status === 'valid') {
        const apiKey = await credentialStore.readSecret({
          pool, userId: botRow.id, ...key, dataKey: config.dataEncryptionKey, expectedRevision: meta.revision,
        });
        if (apiKey) {
          const info = await require('./openrouter-client').validateKey(apiKey, {
            baseUrl: config.openrouterApiBase, origin: config.openrouterOrigin,
          });
          // An unlimited key has no figure of its own: the account's counts.
          if (Number.isFinite(info?.limitRemaining)) out.keyCents = Math.max(0, Math.round(info.limitRemaining * 100));
        }
      }
    }
  } catch (err) {
    log.warn('openrouter-credit', 'Could not read the bot key\'s remaining credit', { err: err.message });
  }
  const reads = [out.accountCents, out.keyCents].filter((v) => Number.isFinite(v));
  out.balanceCents = reads.length ? Math.min(...reads) : null;
  return out;
}

// ── The policy (pure) ──────────────────────────────────────────────────

function stateOf(state) {
  const s = state && typeof state === 'object' ? state : {};
  const armed = s.armed && typeof s.armed === 'object' ? s.armed : {};
  return {
    ...s,
    armed: { low: armed.low !== false, urgent: armed.urgent !== false },
    outage: s.outage && typeof s.outage === 'object' && s.outage.since ? s.outage : null,
  };
}

/** Days a balance lasts at `dailyCents`, one decimal; null when unknown. */
function daysLeft(balanceCents, dailyCents) {
  if (!(dailyCents > 0) || !Number.isFinite(balanceCents)) return null;
  const days = balanceCents / dailyCents;
  return Math.max(0, Math.round(days * 10) / 10);
}

/**
 * What to do with a new read. `state` is the stored one (or null),
 * `balanceCents` the lower of the two reads (null: the read failed, and
 * nothing changes). Returns { state, events }, `events` being what to say,
 * in order: { type: 'low' | 'urgent', thresholdCents, balanceCents } and
 * { type: 'back' }. Pure: no I/O, no clock but `now`.
 */
function decide(state, balanceCents, { warnCents = DEFAULT_WARN_CENTS, urgentCents = DEFAULT_URGENT_CENTS, now = Date.now() } = {}) {
  const s = stateOf(state);
  const events = [];
  if (!Number.isFinite(balanceCents)) return { state: s, events };
  let armed = { ...s.armed };
  const warn = Math.max(0, Number(warnCents) || 0);
  const urgent = Math.max(0, Math.min(Number(urgentCents) || 0, warn));
  if (balanceCents >= warn) {
    // Back above the warn level: both warnings may be said again on the way
    // down.
    armed = { low: true, urgent: true };
  } else {
    if (balanceCents >= urgent) armed.urgent = true;
    if (armed.low) {
      armed.low = false;
      events.push({ type: 'low', thresholdCents: warn, balanceCents });
    }
    if (balanceCents < urgent && armed.urgent) {
      armed.urgent = false;
      events.push({ type: 'urgent', thresholdCents: urgent, balanceCents });
    }
  }
  let outage = s.outage;
  if (outage) {
    const since = Date.parse(outage.since);
    const waited = Number.isFinite(since) ? now - since >= BACK_AFTER_MS : true;
    if (waited && balanceCents >= BACK_CENTS) {
      outage = null;
      events.push({ type: 'back' });
    }
  }
  return {
    state: { ...s, balanceCents, at: new Date(now).toISOString(), armed, outage },
    events,
  };
}

/** Mark an outage in the state (the 402's own words), once per outage. */
function outageSet(state, { words = null, now = Date.now() } = {}) {
  const s = stateOf(state);
  if (s.outage) return s;
  return { ...s, outage: { since: new Date(now).toISOString(), words: words ? String(words).slice(0, 300) : null } };
}

/**
 * Whether a turn ended on OpenRouter's 402 for credit (an outage), rather
 * than on the refusal that asks only for a smaller reply. Pure. `result` is
 * a turn's result, as the bot's turns return it.
 */
function creditOut(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.agentErrorCode === 'insufficient_credits') return true;
  if (result.agentErrorCode === 'insufficient_credits_max_tokens') return false;
  const { classifyProviderError } = require('../agents/codex-openrouter');
  const texts = [result.error, result.lastResultText]
    .map((t) => String(t || '')).filter(Boolean);
  for (const text of texts) {
    if (classifyProviderError(text).code === 'insufficient_credits') return true;
  }
  return result.providerRequest?.providerErrorStatus === 402
    || result.providerErrorStatus === 402;
}

// ── What admins are told ───────────────────────────────────────────────

// "credit:low:500:480:6" — the level, the level's dollars, the balance's,
// and how many days it lasts at this week's rate (0: not known). Under the
// notifications table's 32 characters.
function detailToken(event, days = 0) {
  const dollars = (cents) => String(Math.round(cents / 100));
  if (event.type === 'back') return null;
  const balance = dollars(event.balanceCents);
  const threshold = dollars(event.thresholdCents);
  const d = Number.isFinite(days) && days > 0 ? Math.round(days) : 0;
  return `credit:${event.type}:${threshold}:${balance}:${d}`;
}

async function tellAdmins(pool, deps, detail) {
  const notifications = deps.notifications ? deps.notifications() : require('./notifications');
  const created = await notifications.createPlatformIncidentNotifications(pool, {
    detail, dedupePrefix: detail, since: new Date(Date.now() - 24 * 60 * 60 * 1000),
  });
  await Promise.all((created || []).map((r) => notifications.hydrateAndPush(pool, r)));
}

// ── The sweep ──────────────────────────────────────────────────────────

/**
 * Read the balance, warn, and lift an outage once credit is back. Run by the
 * clock every 15 minutes and after a build finishes. Returns
 * { balanceCents, events, staging }. Never throws.
 */
async function sweep(pool, config, deps = {}) {
  const out = { balanceCents: null, events: [], staging: deps.staging ?? isStaging() };
  try {
    const { warnCents, urgentCents, state } = await readSettings(pool);
    const read = await readBalance(pool, config);
    out.balanceCents = read.balanceCents;
    const dailyCents = await dailySpendCents(pool, deps);
    let next = stateOf(state);
    if (read.balanceCents == null) {
      // Nothing read: keep what was said, but remember the attempt.
      next = { ...next, accountCents: read.accountCents, keyCents: read.keyCents, at: read.at };
    } else {
      const decided = decide(next, read.balanceCents, { warnCents, urgentCents, now: Date.now() });
      next = {
        ...decided.state, accountCents: read.accountCents, keyCents: read.keyCents,
        dailyCents: dailyCents ?? decided.state.dailyCents ?? null,
      };
      out.events = decided.events;
      for (const event of decided.events) {
        if (event.type === 'back') continue;
        if (!out.staging) {
          const detail = detailToken(event, daysLeft(event.balanceCents, dailyCents));
          await tellAdmins(pool, deps, detail).catch((err) =>
            log.warn('openrouter-credit', 'Could not warn the admins about credit', { err: err.message }));
        }
      }
      if (decided.events.some((e) => e.type === 'back')) {
        await require('../workflow/platform.ts').botCreditBack()
          .catch((err) => log.warn('openrouter-credit', 'Could not tell the bot\'s lane credit is back', { err: err.message }));
      }
    }
    await writeSetting(pool, KEY_STATE, JSON.stringify(next));
    out.state = next;
  } catch (err) {
    log.warn('openrouter-credit', 'The credit sweep failed', { err: err.message });
  }
  return out;
}

// This week's spend, divided by seven: what a day of building costs.
async function dailySpendCents(pool, deps) {
  try {
    const limits = require('./limits');
    const { rows: [botRow] = [] } = await pool.query(
      'SELECT id FROM users WHERE username = $1 AND is_synthetic = TRUE', [BOT_USERNAME],
    );
    if (!botRow) return null;
    const weekly = await limits.getWeeklySpentCents(pool, botRow.id);
    return Number.isFinite(weekly) && weekly > 0 ? weekly / 7 : null;
  } catch {
    return null;
  }
}

/** The figures the console shows beside this week's spend. */
async function status(pool) {
  const { warnCents, urgentCents, state } = await readSettings(pool);
  const s = stateOf(state);
  return {
    balanceCents: Number.isFinite(s.balanceCents) ? s.balanceCents : null,
    accountCents: Number.isFinite(s.accountCents) ? s.accountCents : null,
    keyCents: Number.isFinite(s.keyCents) ? s.keyCents : null,
    daysLeft: daysLeft(s.balanceCents, s.dailyCents),
    at: s.at || null,
    warnCents,
    urgentCents,
    outage: s.outage || null,
  };
}

/** Record that a turn found credit gone: one outage in the state, one incident. */
async function noteOutage(pool, { words = null } = {}) {
  try {
    const { state } = await readSettings(pool);
    const before = stateOf(state);
    const next = outageSet(before, { words });
    if (next !== before) await writeSetting(pool, KEY_STATE, JSON.stringify(next));
    if (!before.outage) {
      await require('./platform-incidents').record(pool, {
        kind: require('./platform-incidents').KINDS.CREDIT_OUT,
        detail: { why: words ? String(words).slice(0, 300) : 'OpenRouter credit ran out' },
      });
    }
  } catch (err) {
    log.warn('openrouter-credit', 'Could not record the credit outage', { err: err.message });
  }
}

module.exports = {
  KEY_WARN, KEY_URGENT, KEY_STATE,
  DEFAULT_WARN_CENTS, DEFAULT_URGENT_CENTS, BACK_CENTS, BACK_AFTER_MS,
  decide, creditOut, daysLeft, outageSet, detailToken,
  readBalance, sweep, status, noteOutage, isStaging,
};
