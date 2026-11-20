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
// T1.4: hours a pause may stand before the admins are told again.
const KEY_STALE_HOURS = 'homeroom_bot_credit_stale_hours';
const DEFAULT_STALE_HOURS = 6;

// $500, then $200.
const DEFAULT_WARN_CENTS = 50000;
const DEFAULT_URGENT_CENTS = 20000;
// Credit is back when the read shows this much, and only once the outage has
// stood a little while: a 402 and the read are minutes apart, and the read
// that still shows a few cents must not lift the pause.
const BACK_CENTS = 2500;
const BACK_AFTER_MS = 5 * 60 * 1000;
// T1.4: an outage the balance read cannot lift (no figure: an unlimited bot
// key and no management key, or a read that failed) is probed with one tiny
// request on the bot's key, the first time once it has stood PROBE_BASE_MS,
// then doubling to PROBE_CEILING_MS. A probe that gets through lifts it.
const PROBE_BASE_MS = 15 * 60 * 1000;
const PROBE_CEILING_MS = 2 * 60 * 60 * 1000;

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
      [[KEY_WARN, KEY_URGENT, KEY_STATE, KEY_STALE_HOURS]],
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
  const stale = num(map.get(KEY_STALE_HOURS), DEFAULT_STALE_HOURS);
  return {
    warnCents: num(map.get(KEY_WARN), DEFAULT_WARN_CENTS),
    urgentCents: num(map.get(KEY_URGENT), DEFAULT_URGENT_CENTS),
    staleHours: stale > 0 ? stale : DEFAULT_STALE_HOURS,
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

// The bot's own OpenRouter key, or null (none stored, or not valid).
async function botApiKey(pool, config) {
  const { rows: [botRow] = [] } = await pool.query(
    'SELECT id FROM users WHERE username = $1 AND is_synthetic = TRUE', [BOT_USERNAME],
  );
  if (!botRow) return null;
  const credentialStore = require('./credential-store');
  const key = { provider: 'openrouter', purpose: 'coding_agent' };
  const meta = await credentialStore.readMetadata({ pool, userId: botRow.id, ...key });
  if (!meta || meta.status !== 'valid') return null;
  return (await credentialStore.readSecret({
    pool, userId: botRow.id, ...key, dataKey: config.dataEncryptionKey, expectedRevision: meta.revision,
  })) || null;
}

// T1.4: how long the probe's one request may take.
const PROBE_TIMEOUT_MS = 20000;

/**
 * T1.4: one tiny request on the bot's key (one token of the helper model,
 * through the platform's chat client, openrouter-mayor.js, which carries the
 * no-training rule every model request does): 'ok' (it got through: credit
 * is back), 'credit' (still OpenRouter's 402 for credit) or 'unknown' (no
 * key, or any other answer). Never throws.
 */
async function probe(pool, config, deps = {}) {
  try {
    const apiKey = await botApiKey(pool, config);
    if (!apiKey) return 'unknown';
    const model = await require('./helper-model').current(config, { pool });
    const client = (deps.mayor || require('./openrouter-mayor')).createClient({
      apiKey, apiBase: config.openrouterApiBase, origin: config.openrouterOrigin, model,
      billingPath: 'platform', timeoutMs: PROBE_TIMEOUT_MS, imageFallback: false,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    try {
      await client.streamChat({ chatMessages: [{ role: 'user', content: 'ok' }], maxTokens: 1 });
      return 'ok';
    } catch (err) {
      return err?.code === 'credit_out' ? 'credit' : 'unknown';
    }
  } catch (err) {
    log.warn('openrouter-credit', 'The credit probe failed', { err: err.message });
    return 'unknown';
  }
}

/** Pure: whether an outage the balance read did not lift is due a probe now. */
function probeDue(outage, now = Date.now()) {
  if (!outage?.since) return false;
  const since = Date.parse(outage.since);
  if (!Number.isFinite(since) || now - since < PROBE_BASE_MS) return false;
  const probes = Math.max(0, Number(outage.probes) || 0);
  const last = outage.probedAt ? Date.parse(outage.probedAt) : NaN;
  if (!Number.isFinite(last)) return true;
  return now - last >= Math.min(PROBE_CEILING_MS, PROBE_BASE_MS * 2 ** Math.max(0, probes - 1));
}

/** Pure: whether an outage has stood `staleHours` since it began or was last said to be. */
function staleDue(outage, staleHours = DEFAULT_STALE_HOURS, now = Date.now()) {
  if (!outage?.since) return false;
  const from = Date.parse(outage.staleAt || outage.since);
  return Number.isFinite(from) && now - from >= Math.max(1, Number(staleHours) || DEFAULT_STALE_HOURS) * 60 * 60 * 1000;
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
    const apiKey = await botApiKey(pool, config);
    if (apiKey) {
      const info = await require('./openrouter-client').validateKey(apiKey, {
        baseUrl: config.openrouterApiBase, origin: config.openrouterOrigin,
      });
      // An unlimited key has no figure of its own: the account's counts.
      if (Number.isFinite(info?.limitRemaining)) out.keyCents = Math.max(0, Math.round(info.limitRemaining * 100));
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

// One text's verdict: OpenRouter's out of credit ('credit'), its refusal
// that asks only for a shorter reply ('max_tokens'), or neither (null).
function textVerdict(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  const { classifyProviderError } = require('../agents/codex-openrouter');
  const code = classifyProviderError(t).code;
  if (code === 'insufficient_credits_max_tokens') return 'max_tokens';
  if (code === 'insufficient_credits') return 'credit';
  return null;
}

// The runtime's own error notice where an answer should be (Claude Code
// writes "API Error: 402 ..." as its final message): only that line is read,
// never the model's own words, so a plan about a 402 page is no outage.
function noticeOf(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    return require('./agent-result-text').agentApiFailure(text)?.line || null;
  } catch {
    return null;
  }
}

const TEXT_FIELDS = ['error', 'agentError', 'body', 'detail', 'message', 'providerError', 'words'];
const STATUS_FIELDS = ['status', 'statusCode', 'httpStatus', 'providerErrorStatus'];

function verdictOf(what, depth) {
  if (what == null || depth > 3) return null;
  if (typeof what === 'string') return textVerdict(what);
  if (typeof what !== 'object') return null;
  // The Codex harness's own classification (agents/codex-openrouter.js
  // emitError), which a 402 with an empty reply carries and nothing else.
  for (const code of [what.agentErrorCode, what.errorCode, what.code]) {
    if (code === 'insufficient_credits') return 'credit';
    if (code === 'insufficient_credits_max_tokens') return 'max_tokens';
  }
  const verdicts = [];
  for (const k of TEXT_FIELDS) {
    const v = what[k];
    if (typeof v === 'string') verdicts.push(textVerdict(v));
    else if (v && typeof v === 'object') verdicts.push(verdictOf(v, depth + 1));
  }
  const notice = noticeOf(what.lastResultText);
  if (notice) verdicts.push(textVerdict(notice));
  // A routed turn ({ error, result }), a turn's own result.
  for (const k of ['result', 'routed']) {
    if (what[k] && typeof what[k] === 'object') verdicts.push(verdictOf(what[k], depth + 1));
  }
  if (verdicts.includes('max_tokens')) return 'max_tokens';
  if (verdicts.includes('credit')) return 'credit';
  const statuses = [
    ...STATUS_FIELDS.map((k) => what[k]),
    what.providerRequest?.providerErrorStatus, what.providerRequest?.httpStatus, what.response?.status,
  ];
  return statuses.some((v) => Number(v) === 402) ? 'credit' : null;
}

/**
 * T1.3: the one test of "OpenRouter's credit ran out", for every turn the
 * bot runs (a read, a plan, a build, a revise, a checks fix, the chat, the
 * voice, look_into). Pure. `what` may be:
 *   - a provider's error text ("API Error: 402 ...", an HTTP body);
 *   - an HTTP failure ({ status: 402, body }, or an error a client threw);
 *   - a turn's result ({ agentErrorCode, agentError, error, lastResultText,
 *     providerErrorStatus, providerRequest }), or a routed turn
 *     ({ error, result }).
 * The 402 that asks only for a shorter reply ("requires more credits, or
 * fewer max_tokens") is not an outage: a smaller request gets through. A
 * model's own reply is read only where the runtime wrote its error notice.
 */
function creditOut(what) {
  return verdictOf(what, 0) === 'credit';
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

// The admins' alert for an outage (mobile-push-policy.js and the drawer
// read it back).
const OUT_DETAIL = 'credit:out';

async function tellAdmins(pool, deps, detail, { since = null } = {}) {
  const notifications = deps.notifications ? deps.notifications() : require('./notifications');
  const created = await notifications.createPlatformIncidentNotifications(pool, {
    detail, dedupePrefix: detail, since: since || new Date(Date.now() - 24 * 60 * 60 * 1000),
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
    const { warnCents, urgentCents, staleHours, state } = await readSettings(pool);
    const read = deps.readBalance ? await deps.readBalance() : await readBalance(pool, config);
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
    }
    // T1.4: an outage the read did not lift (no figure at all: the read
    // failed, or the bot's key is unlimited and no management key is set) is
    // probed, after a back-off, with one tiny request; one that gets through
    // lifts it. A figure below BACK_CENTS is believed: no probe then.
    const now = deps.now ? deps.now() : Date.now();
    if (next.outage && read.balanceCents == null && probeDue(next.outage, now)) {
      const probed = deps.probe ? await deps.probe() : await probe(pool, config);
      out.probe = probed;
      if (probed === 'ok') {
        next = { ...next, outage: null };
        out.events = [...out.events, { type: 'back' }];
      } else {
        next = { ...next, outage: { ...next.outage, probedAt: new Date(now).toISOString(), probes: (Number(next.outage.probes) || 0) + 1 } };
      }
    }
    // T1.4: a pause that has stood `staleHours` (a setting, 6 by default) is
    // told again: one incident and one alert each time it does.
    if (next.outage && staleDue(next.outage, staleHours, now)) {
      const hours = Math.round((now - Date.parse(next.outage.since)) / 3600000);
      next = { ...next, outage: { ...next.outage, staleAt: new Date(now).toISOString() } };
      out.stale = hours;
      await require('./platform-incidents').record(pool, {
        kind: require('./platform-incidents').KINDS.CREDIT_OUT,
        detail: { why: `Homeroom bot has been paused for credit for ${hours} hours`, outcome: 'still_out' },
      }).catch(() => {});
      if (!out.staging) {
        await tellAdmins(pool, deps, OUT_DETAIL, { since: new Date(now - 60 * 60 * 1000) }).catch((err) =>
          log.warn('openrouter-credit', 'Could not tell the admins the credit pause goes on', { err: err.message }));
      }
    }
    await writeSetting(pool, KEY_STATE, JSON.stringify(next));
    remember(pool, next);
    out.state = next;
    // The admin limits area (services/platform-limits-view.js) shows this
    // credit: when its row would change (low, out, unknown, gone), an open
    // sheet and the bell's dot read it again.
    (deps.creditMoved || require('./platform-limits-view').creditMoved)(
      stateOf(state), next, { warnCents, urgentCents },
    );
    // Told only once the cleared state is stored: the lane's pause is that
    // stored outage, read on its every pass (bot-lane facts), so a wake-up
    // sent before the write would find it still standing. And a wake-up
    // that cannot be sent costs minutes, never the pause: the lane's own
    // clock finds the outage gone (review A5).
    if (out.events.some((e) => e.type === 'back')) {
      await (deps.platform ? deps.platform() : require('../workflow/platform.ts')).botCreditBack()
        .catch((err) => log.warn('openrouter-credit', 'Could not tell the bot\'s lane credit is back', { err: err.message }));
    }
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

// ── The one question: is credit out? ───────────────────────────────────
//
// Review B1 (19 Nov 2026): the outage was held in three places and nobody
// asked before calling a model, so during an outage every turn outside the
// lane (the chat, the thread voice, look_into, an investigation, a
// takeover) made its own failing request and read the refusal its own way.
// The stored state above is the one holder. `creditState` is how a turn
// asks before it calls, and `noteOutage` how it reports a call that met the
// 402. The lane reads the same row inside its transitions (bot-lane facts).

// How long an answer is believed. Another process's note or sweep is seen
// within this long; this process's own are seen at once (remember).
const STATE_CACHE_MS = 5000;
// Per pool, so a test's pool never answers for another's.
const stateCache = new WeakMap();

function remember(pool, state, now = Date.now()) {
  if (!pool || typeof pool !== 'object') return;
  const outage = stateOf(state).outage;
  stateCache.set(pool, {
    at: now,
    value: outage ? { out: true, since: outage.since, words: outage.words || null } : { out: false, since: null, words: null },
  });
}

/** Forget what was last read for `pool`, so the next ask reads the store (a test that changes the row itself). */
function forgetState(pool) {
  if (pool && typeof pool === 'object') stateCache.delete(pool);
}

/**
 * Whether OpenRouter's credit is out right now, as last recorded:
 * { out, since, words }. Cached a few seconds. A read that fails says "not
 * out": a settings error must never stop the bot answering.
 */
async function creditState(pool, { maxAgeMs = STATE_CACHE_MS, now = Date.now() } = {}) {
  const hit = pool && typeof pool === 'object' ? stateCache.get(pool) : null;
  if (hit && now - hit.at < maxAgeMs) return hit.value;
  try {
    const { rows } = await pool.query('SELECT value FROM platform_settings WHERE key = $1', [KEY_STATE]);
    let state = null;
    try { state = JSON.parse(rows?.[0]?.value || 'null'); } catch { state = null; }
    remember(pool, state, now);
    return stateCache.get(pool)?.value || { out: false, since: null, words: null };
  } catch (err) {
    log.warn('openrouter-credit', 'Could not read whether credit is out', { err: err.message });
    return { out: false, since: null, words: null };
  }
}

/**
 * Record that a turn found credit gone: one outage in the state, one
 * incident, and (T1.5) the full admins told at once, as the low and urgent
 * warnings are, never in the next day's digest. Resolves the outage
 * ({ since, fresh }), or null when it could not be recorded.
 */
async function noteOutage(pool, { words = null } = {}, deps = {}) {
  try {
    const { state } = await readSettings(pool);
    const before = stateOf(state);
    const next = outageSet(before, { words });
    if (next !== before) await writeSetting(pool, KEY_STATE, JSON.stringify(next));
    remember(pool, next);
    if (!before.outage) {
      // Out of credit is a row in the admin limits area: show it now.
      (deps.limitsChanged || (() => require('./platform-limits-view').changed()))();
      await require('./platform-incidents').record(pool, {
        kind: require('./platform-incidents').KINDS.CREDIT_OUT,
        detail: { why: words ? String(words).slice(0, 300) : 'OpenRouter credit ran out' },
      });
      if (!(deps.staging ?? isStaging())) {
        await tellAdmins(pool, deps, OUT_DETAIL).catch((err) =>
          log.warn('openrouter-credit', 'Could not tell the admins credit ran out', { err: err.message }));
      }
    }
    return { since: next.outage?.since || null, fresh: !before.outage };
  } catch (err) {
    log.warn('openrouter-credit', 'Could not record the credit outage', { err: err.message });
    return null;
  }
}

module.exports = {
  KEY_WARN, KEY_URGENT, KEY_STATE, KEY_STALE_HOURS,
  DEFAULT_WARN_CENTS, DEFAULT_URGENT_CENTS, DEFAULT_STALE_HOURS, BACK_CENTS, BACK_AFTER_MS,
  PROBE_BASE_MS, PROBE_CEILING_MS, OUT_DETAIL,
  decide, creditOut, daysLeft, outageSet, detailToken, probeDue, staleDue,
  STATE_CACHE_MS,
  readBalance, probe, sweep, status, noteOutage, creditState, forgetState, isStaging,
};
