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
//           key) and the bot key's own limit, what is left of it and how
//           often it resets (GET /key). Either may be missing.
//   decide  a pure policy over those figures and what it has already said:
//           one warning below the warn level, one more urgent below the
//           urgent level, each said once per crossing and re-armed when the
//           credit goes back above the level. An outage is cleared once the
//           read shows the bot can spend again, at least BACK_AFTER_MS after
//           it began.
//   detect  `creditOut` reads a turn's result: OpenRouter's 402 for credit
//           is an outage, not a failed build.
//
// TWO FIGURES, KEPT APART (20 Nov 2026). The bot's key is a managed key
// (openrouter-managed-keys.js): its limit is the bot's WEEKLY BUDGET and it
// resets every Monday, so what is left of it is an allowance, not credit.
// This module used to take the lower of the account's credit and the key's
// remaining and call the result "OpenRouter credit". With $1,923 in the
// account and $500 left of an $800 week it said "credit: $500 left, about
// 12 days", and warned that credit was below $500: a false alarm due every
// week once the bot had spent $300. So:
//
//   credit     the ACCOUNT's credit. The warnings, the days estimate, the
//              limits area's row, the bell notice, the text and the console's
//              tile all read it. When the account cannot be read, the key's
//              remaining stands in only for a capped key that never resets
//              (prepaid credit in effect); an allowance never counts.
//   spendable  the lower of the account's credit and the key's remaining:
//              whether the bot can pay for a request. Only the lifting of an
//              outage reads it.
//   budget     the key's limit and what is used of it, beside Homeroom's own
//              count of the bot's week (limits.getWeeklySpentCents). Its own
//              limit in the limits area (`budget` below, the `bot_budget`
//              limit of platform-limit-alerts.js).
//
// An outage says which of the two ran out (`cause`: 'credit' or 'budget'),
// so "add credit" is never the advice for a spent weekly budget.
//
// The thresholds are platform settings, so an admin can move them without a
// change. The state (the last read, which warnings are armed, the outage, a
// short ring of the account's credit readings) is one platform setting too;
// there is no table of its own.

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

// A stored read older than this is not stood on (three missed sweeps).
const READ_FRESH_MS = 45 * 60 * 1000;
// The account's credit readings kept for the days estimate: at most one
// every READING_EVERY_MS, for READING_KEEP_MS. A day of them is the least an
// estimate is made from.
const READING_EVERY_MS = 3 * 60 * 60 * 1000;
const READING_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const BURN_MIN_SPAN_MS = 24 * 60 * 60 * 1000;
// How long the read that says which figure ran out may take when a turn
// meets the refusal: the turn's own ending waits on it.
const CAUSE_READ_TIMEOUT_MS = 8000;

const BOT_USERNAME = 'homeroom_bot';

// The platform's config, as ws.attach hands it over on every pod. Only
// `noteOutage` reads it (its callers have none): to ask OpenRouter, once an
// outage, which of the two figures ran out.
let sharedConfig = null;
function setConfig(config) { if (config) sharedConfig = config; }

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

const finite = (v) => (Number.isFinite(v) ? v : null);

/**
 * Pure: what counts as CREDIT in a read: { cents, source }. The account's
 * credit when it was read. Failing that, the key's remaining only for a
 * capped key that was read and never resets (`keyReset === null`: prepaid
 * credit in effect). A key that resets is an allowance and never counts, and
 * neither does one whose cadence is not known.
 */
function creditOf(figures) {
  const account = finite(figures?.accountCents);
  if (account != null) return { cents: account, source: 'account' };
  const key = finite(figures?.keyCents);
  if (key != null && figures.keyReset === null) return { cents: key, source: 'key' };
  return { cents: null, source: null };
}

/** Pure: what the bot can pay for a request with: the lower of the two figures read, or null. */
function spendableOf(figures) {
  const reads = [figures?.accountCents, figures?.keyCents].filter((v) => Number.isFinite(v));
  return reads.length ? Math.min(...reads) : null;
}

/**
 * Pure: which figure ran out, from a read: 'budget' (the key's own limit is
 * spent while the account has credit, or cannot be read and the key is an
 * allowance that resets), 'credit' (the account's credit is gone, or a
 * prepaid key's), or null when the figures do not say.
 */
function causeOf(figures) {
  const account = finite(figures?.accountCents);
  const key = finite(figures?.keyCents);
  if (key != null && key < BACK_CENTS) {
    if (account != null && account >= BACK_CENTS) return 'budget';
    if (account == null) return figures.keyReset ? 'budget' : 'credit';
  }
  if (account != null && account < BACK_CENTS) return 'credit';
  return null;
}

// OpenRouter's refusal of a key whose own spending limit is used up, as it
// writes it ("403 Key limit exceeded (weekly limit)"; bench run 196, and
// the Claude Code harness's "API Error: 403 Key limit exceeded").
const KEY_LIMIT_RE = /key limit exceeded/i;

/**
 * Pure: what a refusal itself says ran out: 'budget' when it names the key's
 * own limit (its words, the worker's `limitSource`, or the runtime's own
 * notice where a turn's answer should be: Claude Code's "Failed to
 * authenticate. API Error: 403 Key limit exceeded (weekly limit)"), else
 * null. A turn's answer is read only where it IS that notice (noticeOf),
 * never for what the model wrote.
 */
function refusalCause(what, depth = 0) {
  if (what == null || depth > 3) return null;
  if (typeof what === 'string') return KEY_LIMIT_RE.test(what) ? 'budget' : null;
  if (typeof what !== 'object') return null;
  if (what.limitSource === 'openrouter_key_limit' || what.providerRequest?.limitSource === 'openrouter_key_limit') return 'budget';
  for (const k of ['error', 'agentError', 'body', 'detail', 'message', 'providerError', 'words']) {
    if (typeof what[k] === 'string' && KEY_LIMIT_RE.test(what[k])) return 'budget';
  }
  const notice = noticeOf(what.lastResultText);
  if (notice && KEY_LIMIT_RE.test(notice)) return 'budget';
  // A routed turn ({ error, result }), a turn's own result.
  for (const k of ['result', 'routed']) {
    if (what[k] && typeof what[k] === 'object' && refusalCause(what[k], depth + 1)) return 'budget';
  }
  return null;
}

/**
 * The figures the sweep decides from and the console shows:
 * { accountCents, keyCents, keyLimitCents, keyReset, management, attempted,
 *   creditCents, creditSource, spendableCents, at }.
 *
 *   accountCents   the account's credit, or null (no management key, or its
 *                  read failed);
 *   keyCents       what is left of the bot key's limit, or null (no key, an
 *                  unlimited key, or its read failed);
 *   keyLimitCents  that limit; keyReset its cadence ('weekly', ...), null
 *                  for a key that never resets, undefined when not read;
 *   management     whether a management key is configured at all;
 *   attempted      whether anything could be asked (a management key or a
 *                  bot key exists): a deploy with neither has nothing to
 *                  read, and its stored state is left as it is;
 *   creditCents    creditOf(), spendableCents spendableOf().
 * Never throws.
 */
async function readBalance(pool, config) {
  const out = {
    accountCents: null, keyCents: null, keyLimitCents: null, keyReset: undefined,
    management: !!config?.openrouterManagementApiKey, attempted: !!config?.openrouterManagementApiKey,
    at: new Date().toISOString(),
  };
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
      out.attempted = true;
      const info = await require('./openrouter-client').validateKey(apiKey, {
        baseUrl: config.openrouterApiBase, origin: config.openrouterOrigin,
      });
      // An unlimited key has no figure of its own.
      if (Number.isFinite(info?.limitRemaining)) out.keyCents = Math.max(0, Math.round(info.limitRemaining * 100));
      if (Number.isFinite(info?.limit)) out.keyLimitCents = Math.max(0, Math.round(info.limit * 100));
      out.keyReset = info?.limitReset ? String(info.limitReset).slice(0, 16) : null;
    }
  } catch (err) {
    log.warn('openrouter-credit', 'Could not read the bot key\'s remaining budget', { err: err.message });
  }
  const credit = creditOf(out);
  out.creditCents = credit.cents;
  out.creditSource = credit.source;
  out.spendableCents = spendableOf(out);
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

// ── How fast the account's credit goes down (pure) ─────────────────────
//
// The days estimate used to divide by the bot's own spend this week. The
// account pays for more than the bot: everyone's included keys, and (task
// 2275) before & after shots, Sync with main, translation and the apps' AI
// calls. So the rate is read off the account's own credit instead: a short
// ring of its readings, kept in the stored state.

/** Pure: `readings` with one more, at most one every READING_EVERY_MS, none older than READING_KEEP_MS. */
function pushReading(readings, { at, cents }) {
  const now = Date.parse(at);
  const kept = (Array.isArray(readings) ? readings : [])
    .filter((r) => r && Number.isFinite(r.cents) && Number.isFinite(Date.parse(r.at))
      && Date.parse(r.at) <= now && now - Date.parse(r.at) <= READING_KEEP_MS);
  if (!Number.isFinite(now) || !Number.isFinite(cents)) return kept;
  const last = kept[kept.length - 1];
  if (last && now - Date.parse(last.at) < READING_EVERY_MS) return kept;
  return [...kept, { at: new Date(now).toISOString(), cents: Math.round(cents) }];
}

/**
 * Pure: what the account's credit went down by a day, over its readings:
 * { dailyCents, days } (the span the rate was measured over, in days), or
 * null when they cover less than a day. A stretch in which the credit ROSE
 * is a top-up: it is left out, the time and the money both, so adding credit
 * never reads as negative spend.
 */
function burnOf(readings, now = Date.now()) {
  const list = (Array.isArray(readings) ? readings : [])
    .map((r) => ({ at: Date.parse(r?.at), cents: Number(r?.cents) }))
    .filter((r) => Number.isFinite(r.at) && Number.isFinite(r.cents) && r.at <= now && now - r.at <= READING_KEEP_MS)
    .sort((a, b) => a.at - b.at);
  let spent = 0;
  let elapsed = 0;
  for (let i = 1; i < list.length; i += 1) {
    const drop = list[i - 1].cents - list[i].cents;
    if (drop < 0) continue;
    spent += drop;
    elapsed += list[i].at - list[i - 1].at;
  }
  if (elapsed < BURN_MIN_SPAN_MS) return null;
  return { dailyCents: spent / (elapsed / (24 * 60 * 60 * 1000)), days: Math.round(elapsed / (24 * 60 * 60 * 1000)) };
}

/**
 * What to do with a new read. `state` is the stored one (or null).
 * `figures` is { creditCents, spendableCents } (a bare number is both):
 * the warnings read the credit, the lifting of an outage reads what the bot
 * can spend, and a figure that is null (its read failed) changes nothing of
 * its own. Returns { state, events }, `events` being what to say, in order:
 * { type: 'low' | 'urgent', thresholdCents, balanceCents } and
 * { type: 'back' }. Pure: no I/O, no clock but `now`.
 */
function decide(state, figures, { warnCents = DEFAULT_WARN_CENTS, urgentCents = DEFAULT_URGENT_CENTS, now = Date.now() } = {}) {
  const s = stateOf(state);
  const events = [];
  const both = figures == null || typeof figures === 'number';
  const credit = finite(both ? figures : figures.creditCents);
  const spendable = finite(both ? figures : figures.spendableCents);
  if (credit == null && spendable == null) return { state: s, events };
  let armed = { ...s.armed };
  if (credit != null) {
    const warn = Math.max(0, Number(warnCents) || 0);
    const urgent = Math.max(0, Math.min(Number(urgentCents) || 0, warn));
    if (credit >= warn) {
      // Back above the warn level: both warnings may be said again on the
      // way down.
      armed = { low: true, urgent: true };
    } else {
      if (credit >= urgent) armed.urgent = true;
      if (armed.low) {
        armed.low = false;
        events.push({ type: 'low', thresholdCents: warn, balanceCents: credit });
      }
      if (credit < urgent && armed.urgent) {
        armed.urgent = false;
        events.push({ type: 'urgent', thresholdCents: urgent, balanceCents: credit });
      }
    }
  }
  let outage = s.outage;
  if (outage && spendable != null) {
    const since = Date.parse(outage.since);
    const waited = Number.isFinite(since) ? now - since >= BACK_AFTER_MS : true;
    if (waited && spendable >= BACK_CENTS) {
      outage = null;
      events.push({ type: 'back' });
    }
  }
  const at = new Date(now).toISOString();
  return {
    state: {
      ...s, at, armed, outage, spendableCents: spendable,
      ...(credit != null ? { creditCents: credit, creditAt: at } : {}),
    },
    events,
  };
}

/**
 * Mark an outage in the state (the refusal's own words), once per outage.
 * `cause` is which figure ran out ('budget': the bot's weekly budget;
 * 'credit', the default: the account's credit); `causeFrom` where that was
 * learnt ('refusal': the provider said so; 'figures': a read; 'default':
 * nothing said), which a later read may only correct when the provider did
 * not say.
 */
function outageSet(state, { words = null, cause = null, causeFrom = null, now = Date.now() } = {}) {
  const s = stateOf(state);
  if (s.outage) return s;
  return {
    ...s,
    outage: {
      since: new Date(now).toISOString(),
      words: words ? String(words).slice(0, 300) : null,
      cause: cause === 'budget' ? 'budget' : 'credit',
      causeFrom: ['refusal', 'figures'].includes(causeFrom) ? causeFrom : 'default',
    },
  };
}

/** Pure: which figure an outage says ran out: 'budget' or 'credit' (an outage from before causes were kept is credit). */
function outageCause(outage) {
  return outage && outage.cause === 'budget' ? 'budget' : 'credit';
}

// One text's verdict: OpenRouter's out of credit ('credit'), its refusal
// that asks only for a shorter reply ('max_tokens'), or neither (null).
function textVerdict(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  // The key's own limit, used up: the bot's weekly budget. As much an outage
  // as the account's credit (nothing its key asks gets through until the
  // week turns or the budget is raised), and said as its own cause.
  if (KEY_LIMIT_RE.test(t)) return 'credit';
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

// "credit:low:500:480:6" — the level, the level's dollars, the account's
// credit, and how many days it lasts at the rate it has been going down (0:
// not known). Under the notifications table's 32 characters.
function detailToken(event, days = 0) {
  const dollars = (cents) => String(Math.round(cents / 100));
  if (event.type === 'back') return null;
  const balance = dollars(event.balanceCents);
  const threshold = dollars(event.thresholdCents);
  const d = Number.isFinite(days) && days > 0 ? Math.round(days) : 0;
  return `credit:${event.type}:${threshold}:${balance}:${d}`;
}

// The admins' alert for an outage whose cause is the account's credit
// (mobile-push-policy.js and the drawer read it back). An outage whose cause
// is the bot's weekly budget is told as that limit's own notice
// (`bot_budget_full`, platform-limit-alerts.js), once a crossing.
const OUT_DETAIL = 'credit:out';

async function tellAdmins(pool, deps, detail, { since = null } = {}) {
  const notifications = deps.notifications ? deps.notifications() : require('./notifications');
  const created = await notifications.createPlatformIncidentNotifications(pool, {
    detail, dedupePrefix: detail, since: since || new Date(Date.now() - 24 * 60 * 60 * 1000),
  });
  await Promise.all((created || []).map((r) => notifications.hydrateAndPush(pool, r)));
}

// ── The sweep ──────────────────────────────────────────────────────────

// Evaluate the bot's weekly budget as a platform limit now (its stored
// level, its bell notice, an open limits area), rather than at its next
// five-minute sweep. Never throws.
function nudgeBudget(pool, config, deps = {}) {
  if (deps.budgetNudge) return Promise.resolve(deps.budgetNudge()).catch(() => {});
  return Promise.resolve()
    .then(() => require('./platform-limit-alerts').evaluate(pool, config || sharedConfig || {}, 'bot_budget'))
    .catch((err) => log.warn('openrouter-credit', 'Could not evaluate the bot\'s weekly budget', { err: err.message }));
}

/**
 * Read the figures, warn about the account's credit, and lift an outage once
 * the bot can spend again. Run by the clock every 15 minutes and by "Check
 * again". Returns { creditCents, spendableCents, events, staging }. Never
 * throws.
 */
async function sweep(pool, config, deps = {}) {
  const out = { creditCents: null, spendableCents: null, events: [], staging: deps.staging ?? isStaging() };
  try {
    const { warnCents, urgentCents, staleHours, state } = await readSettings(pool);
    const read = deps.readBalance ? await deps.readBalance() : await readBalance(pool, config);
    const now = deps.now ? deps.now() : Date.now();
    // Derived here, from the figures read, whatever else the read carries.
    const credit = creditOf(read);
    const spendable = spendableOf(read);
    out.creditCents = credit.cents;
    out.spendableCents = spendable;
    let next = stateOf(state);
    // Nothing could even be asked (no management key and no bot key): there
    // is no read to remember, and what is stored stands as it is.
    if (read.attempted === false && !next.outage) {
      out.state = next;
      return out;
    }
    const figures = {
      accountCents: read.accountCents ?? null, keyCents: read.keyCents ?? null,
      keyLimitCents: read.keyLimitCents ?? null,
      ...(read.keyReset !== undefined ? { keyReset: read.keyReset } : {}),
      management: read.management !== false,
    };
    // The key's cadence is this pass's or unknown, never the last pass's.
    delete next.keyReset;
    // What a state from before the two figures were kept apart held: the
    // lower of the two as `balanceCents`, and the bot's own daily spend.
    delete next.balanceCents;
    delete next.dailyCents;
    if (credit.cents == null && spendable == null) {
      // Nothing read: keep what was said, but remember the attempt.
      next = { ...next, ...figures, spendableCents: null, at: read.at };
    } else {
      const decided = decide(next, { creditCents: credit.cents, spendableCents: spendable }, { warnCents, urgentCents, now });
      next = {
        ...decided.state, ...figures, creditSource: credit.source || decided.state.creditSource || null,
        readings: credit.source === 'account'
          ? pushReading(decided.state.readings, { at: decided.state.at, cents: credit.cents })
          : pushReading(decided.state.readings, { at: decided.state.at, cents: NaN }),
      };
      out.events = decided.events;
      const burn = burnOf(next.readings, now);
      for (const event of decided.events) {
        if (event.type === 'back') continue;
        if (!out.staging) {
          const detail = detailToken(event, daysLeft(event.balanceCents, burn?.dailyCents));
          await tellAdmins(pool, deps, detail).catch((err) =>
            log.warn('openrouter-credit', 'Could not warn the admins about credit', { err: err.message }));
        }
      }
    }
    // The figures say which of the two ran out, where the refusal itself
    // did not: a first guess made from an older read is corrected here.
    if (next.outage && next.outage.causeFrom !== 'refusal') {
      const cause = causeOf(read);
      if (cause && cause !== outageCause(next.outage)) {
        next = { ...next, outage: { ...next.outage, cause, causeFrom: 'figures' } };
        out.cause = cause;
      }
    }
    // T1.4: an outage the read did not lift (no figure at all: the read
    // failed, or the bot's key is unlimited and no management key is set) is
    // probed, after a back-off, with one tiny request; one that gets through
    // lifts it. A figure below BACK_CENTS is believed: no probe then.
    if (next.outage && spendable == null && probeDue(next.outage, now)) {
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
    // told again: one incident and, for the account's credit, one alert each
    // time it does. A spent weekly budget lifts by itself when the week
    // turns and stays at the top of the limits area meanwhile: its alert is
    // its limit's own, once.
    if (next.outage && staleDue(next.outage, staleHours, now)) {
      const hours = Math.round((now - Date.parse(next.outage.since)) / 3600000);
      const budget = outageCause(next.outage) === 'budget';
      next = { ...next, outage: { ...next.outage, staleAt: new Date(now).toISOString() } };
      out.stale = hours;
      await require('./platform-incidents').record(pool, {
        kind: require('./platform-incidents').KINDS.CREDIT_OUT,
        detail: {
          why: budget
            ? `Homeroom bot has been paused on its weekly budget for ${hours} hours`
            : `Homeroom bot has been paused for credit for ${hours} hours`,
          outcome: 'still_out',
        },
      }).catch(() => {});
      if (!out.staging && !budget) {
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
    // The weekly budget's level follows a budget outage (budget()): told
    // now, when one is found, corrected or lifted, not at its next sweep.
    const wasBudget = !!stateOf(state).outage && outageCause(stateOf(state).outage) === 'budget';
    const isBudget = !!next.outage && outageCause(next.outage) === 'budget';
    if (wasBudget !== isBudget) await nudgeBudget(pool, config, deps);
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

// The bot's own account: its id, or null before it exists.
async function botId(pool) {
  const { rows: [botRow] = [] } = await pool.query(
    'SELECT id FROM users WHERE username = $1 AND is_synthetic = TRUE', [BOT_USERNAME],
  );
  return botRow ? botRow.id : null;
}

/**
 * Pure: the stored state as the figures every reader shows, with the two
 * warning levels beside them:
 *
 *   creditCents     the account's credit as last read (creditOf), with
 *                   creditAt (when) and creditSource ('account', or 'key'
 *                   for a prepaid key standing in);
 *   creditRead      whether the last pass read it;
 *   management      whether a management key is configured, so the account's
 *                   credit can be read at all;
 *   spendableCents  what the bot could pay with at the last pass;
 *   accountCents, keyCents, keyLimitCents, keyReset: the last pass's reads;
 *   keyUsedCents    OpenRouter's own count of the key's period (its limit
 *                   less what is left), or null;
 *   daysLeft        how long the credit lasts at the rate it has gone down
 *                   over `burnDays` days of readings, or null with under a
 *                   day of them;
 *   at              the last pass; outage: the stored outage, with its cause.
 *
 * A state from before the two figures were kept apart has no `creditCents`:
 * its `accountCents` is the credit, and its key's cadence is not known.
 */
function statusOf(state, { warnCents = DEFAULT_WARN_CENTS, urgentCents = DEFAULT_URGENT_CENTS } = {}, now = Date.now()) {
  const s = stateOf(state);
  const legacy = s.creditCents === undefined;
  const creditCents = legacy ? finite(s.accountCents) : finite(s.creditCents);
  const creditAt = legacy ? (creditCents != null ? s.at || null : null) : s.creditAt || null;
  const keyCents = finite(s.keyCents);
  const keyLimitCents = finite(s.keyLimitCents);
  const burn = burnOf(s.readings, now);
  return {
    creditCents,
    creditAt,
    creditSource: creditCents == null ? null : (legacy ? 'account' : s.creditSource || 'account'),
    creditRead: creditCents != null && !!creditAt && creditAt === (s.at || null),
    management: s.management !== false,
    spendableCents: finite(s.spendableCents),
    accountCents: finite(s.accountCents),
    keyCents,
    keyLimitCents,
    keyReset: s.keyReset === undefined ? null : s.keyReset,
    keyUsedCents: keyCents != null && keyLimitCents != null ? Math.max(0, keyLimitCents - keyCents) : null,
    daysLeft: burn && creditCents != null ? daysLeft(creditCents, burn.dailyCents) : null,
    burnDays: burn ? burn.days : null,
    at: s.at || null,
    warnCents,
    urgentCents,
    outage: s.outage ? { ...s.outage, cause: outageCause(s.outage) } : null,
  };
}

/** The figures the console and the limits area show (statusOf of the stored state). */
async function status(pool) {
  const { warnCents, urgentCents, state } = await readSettings(pool);
  return statusOf(state, { warnCents, urgentCents });
}

// ── The bot's weekly budget, as a platform limit ───────────────────────
//
// Two counts of one week, each against its own cap, and either can refuse
// first:
//
//   Homeroom's   what the bot's turns were charged (limits.getWeeklySpentCents)
//                against its weekly limit; at it, the bot's own gate
//                (limits.checkBudget) starts nothing.
//   OpenRouter's the key's limit less what is left of it, as the last sweep
//                read them; at it, OpenRouter refuses the key. It runs ahead
//                of Homeroom's: the same key pays for the platform's helper
//                calls, before & after shots, Sync with main and the apps'
//                AI calls (openrouter-messages.js), which Homeroom charges to
//                nobody or to somebody else.
//
// The limit is whichever is further along. Both weeks turn on Monday 00:00
// UTC (limits.weeklyResetAt; a managed key's `weekly` reset).

/**
 * The bot's weekly budget as platform-limit-alerts.js measures it:
 * { used, cap, detail }, in cents. While an outage stands whose cause is
 * the budget, `used` is the cap: OpenRouter is refusing the key, whatever a
 * few cents its count still shows. `detail`:
 * { usedCents, capCents, source: 'openrouter' | 'homeroom',
 *   openrouterUsedCents, homeroomUsedCents, resetsAt, refused }.
 *
 * Null when it could not be measured (no bot account yet, or neither count
 * could be read): nothing is recorded, and a figure left to grow old says
 * so. A bot with no weekly cap and no key that resets has no budget: that is
 * measured, as nothing of nothing, so a level it once had is cleared.
 */
async function budget(pool, deps = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const { state } = await readSettings(pool);
  const s = statusOf(state, {}, now);
  // Either count stands without the other: a ledger that cannot be read
  // leaves OpenRouter's, and the other way about.
  let own = null;
  let ledgerRead = false;
  try {
    const id = await botId(pool);
    if (id != null) {
      const limits = deps.limits || require('./limits');
      const cap = Math.round(Number(await limits.getEffectiveUserWeeklyLimitCents(pool, id)) || 0);
      if (cap > 0) own = { usedCents: Math.max(0, Math.round(Number(await limits.getWeeklySpentCents(pool, id)) || 0)), capCents: cap };
      ledgerRead = true;
    }
  } catch (err) {
    log.warn('openrouter-credit', 'Could not read Homeroom\'s count of the bot\'s week', { err: err.message });
  }
  let theirs = null;
  const readAt = Date.parse(s.at || '');
  if (s.keyReset && s.keyUsedCents != null && s.keyLimitCents > 0
      && Number.isFinite(readAt) && now - readAt <= READ_FRESH_MS) {
    theirs = { usedCents: s.keyUsedCents, capCents: s.keyLimitCents };
  }
  if (!own && !theirs) return ledgerRead ? { used: 0, cap: 0, detail: null } : null;
  const share = (side) => (side ? side.usedCents / side.capCents : -1);
  const refused = !!s.outage && s.outage.cause === 'budget';
  // While OpenRouter refuses the key, its count is the one that is used up.
  const tight = (refused && theirs) || (share(theirs) >= share(own) ? theirs : own);
  const cadence = tight === theirs ? s.keyReset : 'weekly';
  let resetsAt = null;
  if (cadence === 'weekly') resetsAt = require('./limits').weeklyResetAt(new Date(now));
  else if (cadence === 'daily') {
    const d = new Date(now);
    resetsAt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
  }
  return {
    used: refused ? Math.max(tight.usedCents, tight.capCents) : tight.usedCents,
    cap: tight.capCents,
    detail: {
      // Refused with only Homeroom's count at hand: OpenRouter's own, which
      // is what ran out, is not known, so the budget is said as all used.
      usedCents: refused && tight !== theirs ? Math.max(tight.usedCents, tight.capCents) : tight.usedCents,
      capCents: tight.capCents,
      source: tight === theirs ? 'openrouter' : 'homeroom',
      openrouterUsedCents: theirs ? theirs.usedCents : null,
      homeroomUsedCents: own ? own.usedCents : null,
      resetsAt,
      refused,
    },
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
    value: outage
      ? { out: true, since: outage.since, words: outage.words || null, cause: outageCause(outage) }
      : { out: false, since: null, words: null, cause: null },
  });
}

/** Forget what was last read for `pool`, so the next ask reads the store (a test that changes the row itself). */
function forgetState(pool) {
  if (pool && typeof pool === 'object') stateCache.delete(pool);
}

/**
 * Whether the bot's key cannot pay right now, as last recorded:
 * { out, since, words, cause } (`cause`: 'credit', the account's credit ran
 * out, or 'budget', the bot's weekly budget did). Cached a few seconds. A
 * read that fails says "not out": a settings error must never stop the bot
 * answering.
 */
async function creditState(pool, { maxAgeMs = STATE_CACHE_MS, now = Date.now() } = {}) {
  const hit = pool && typeof pool === 'object' ? stateCache.get(pool) : null;
  if (hit && now - hit.at < maxAgeMs) return hit.value;
  try {
    const { rows } = await pool.query('SELECT value FROM platform_settings WHERE key = $1', [KEY_STATE]);
    let state = null;
    try { state = JSON.parse(rows?.[0]?.value || 'null'); } catch { state = null; }
    remember(pool, state, now);
    return stateCache.get(pool)?.value || { out: false, since: null, words: null, cause: null };
  } catch (err) {
    log.warn('openrouter-credit', 'Could not read whether credit is out', { err: err.message });
    return { out: false, since: null, words: null, cause: null };
  }
}

// The figures a new outage's cause is judged from: a read made now, where a
// config is at hand (ws.attach's, or a test's), else the last sweep's when
// it is fresh. The refusal and the last sweep are up to fifteen minutes
// apart, which is long enough for the last of a budget to go.
async function causeFigures(pool, stored, deps) {
  const config = deps.config || sharedConfig;
  try {
    let read = null;
    if (deps.readBalance) read = await deps.readBalance();
    else if (config) {
      let timer;
      read = await Promise.race([
        readBalance(pool, config),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), CAUSE_READ_TIMEOUT_MS); timer.unref?.(); }),
      ]).finally(() => clearTimeout(timer));
    }
    if (read && (finite(read.accountCents) != null || finite(read.keyCents) != null)) return read;
  } catch (err) {
    log.warn('openrouter-credit', 'Could not read which figure ran out', { err: err.message });
  }
  const at = Date.parse(stored.at || '');
  return Number.isFinite(at) && Date.now() - at <= READ_FRESH_MS ? stored : null;
}

/**
 * Record that a turn found the bot's key could not pay: one outage in the
 * state, with which figure ran out, and one incident. The full admins are
 * told at once (T1.5), never in the next day's digest: for the account's
 * credit, the `credit:out` alert; for the bot's weekly budget, that limit's
 * own notice (the budget is evaluated now, and its level says "used up").
 * `words` are the refusal's own; `cause` is given only by a caller that
 * knows it. Resolves the outage ({ since, fresh, cause }), or null when it
 * could not be recorded.
 */
async function noteOutage(pool, { words = null, cause = null } = {}, deps = {}) {
  try {
    const { state } = await readSettings(pool);
    const before = stateOf(state);
    let next = before;
    if (!before.outage) {
      const said = cause === 'budget' || cause === 'credit' ? cause : refusalCause(words);
      const judged = said || causeOf(await causeFigures(pool, before, deps));
      next = outageSet(before, { words, cause: judged, causeFrom: said ? 'refusal' : (judged ? 'figures' : 'default') });
      await writeSetting(pool, KEY_STATE, JSON.stringify(next));
    }
    remember(pool, next);
    const budget = outageCause(next.outage) === 'budget';
    if (!before.outage) {
      // Out of credit, or of budget, is a row in the admin limits area: show it now.
      (deps.limitsChanged || (() => require('./platform-limits-view').changed()))();
      await require('./platform-incidents').record(pool, {
        kind: require('./platform-incidents').KINDS.CREDIT_OUT,
        detail: {
          why: words ? String(words).slice(0, 300) : (budget ? 'Homeroom bot\'s weekly budget ran out' : 'OpenRouter credit ran out'),
          cause: budget ? 'budget' : 'credit',
        },
      });
      if (budget) await nudgeBudget(pool, deps.config || null, deps);
      else if (!(deps.staging ?? isStaging())) {
        await tellAdmins(pool, deps, OUT_DETAIL).catch((err) =>
          log.warn('openrouter-credit', 'Could not tell the admins credit ran out', { err: err.message }));
      }
    }
    return { since: next.outage?.since || null, fresh: !before.outage, cause: budget ? 'budget' : 'credit' };
  } catch (err) {
    log.warn('openrouter-credit', 'Could not record the credit outage', { err: err.message });
    return null;
  }
}

module.exports = {
  KEY_WARN, KEY_URGENT, KEY_STATE, KEY_STALE_HOURS,
  DEFAULT_WARN_CENTS, DEFAULT_URGENT_CENTS, DEFAULT_STALE_HOURS, BACK_CENTS, BACK_AFTER_MS,
  PROBE_BASE_MS, PROBE_CEILING_MS, OUT_DETAIL,
  READ_FRESH_MS, READING_EVERY_MS, READING_KEEP_MS,
  decide, creditOut, daysLeft, outageSet, detailToken, probeDue, staleDue,
  creditOf, spendableOf, causeOf, refusalCause, outageCause, pushReading, burnOf, statusOf,
  STATE_CACHE_MS,
  setConfig, readBalance, probe, sweep, status, budget, noteOutage, creditState, forgetState, isStaging,
};
