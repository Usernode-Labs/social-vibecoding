'use strict';

// The translation step, run by Homeroom on its own catalogs
// (frontend/locales/README.md, "Translations").
//
// A leader-only sweep. Each pass reads what the RUNNING build says (its
// English and committed translations, public/locales/.source.json) with the
// translation cache laid over it (services/language-cache.js). When a
// configured language lacks messages (English that is new or reworded, or a
// language just added to config.json), it translates them with the platform's
// key (services/language-sync.js), checks every answer as the build would,
// and keeps what passes in the cache. The server serves the shell's packs
// from the cache at once (GET /api/languages, /locales/live/...): no proposal
// and no deploy per translation. A language is offered once the committed
// catalogs and the cache together cover config.json's minimumCoverage.
//
// It used to open a proposal per batch of translations, for the group's
// vote; every change to the English then meant another one to approve. A
// person correcting a translation still commits it, marked "locked", and a
// committed entry always wins over the cache.
//
// A few messages go one request at a time, the same pass. More go as one
// Message Batch, half the price: the pass that submits it records it in
// platform_settings, and a later pass, on this leader or the next, keeps its
// answers once it has ended. A deploy in between can move the English, so a
// batch's answers are matched to messages by id, and only to a message whose
// English is the one it was asked about (`batch.english`).
//
// A pass whose English and committed catalogs are what the last finished pass
// read does nothing: what failed then is asked again once the English moves.
//
// A pass that wrote nothing because requests failed (a request the API
// refuses, a key out of credit, an outage, a batch the API would not take)
// opens nothing, so it is logged at warn with the reason and kept in the
// state, and main is not marked as read. The same requests are then not sent
// again for a day from the failure; a change to what a request is made of
// (language-sync.js requestShape) is tried on the next pass.
//
// Off with LANGUAGE_SYNC_ENABLED=false, and idle without an Anthropic key.
// Spend counts against the system budget (limits.checkSystemBudget).

const crypto = require('node:crypto');
const fs = require('node:fs');

const log = require('./logger');
const llm = require('./llm');
const limits = require('./limits');
const sync = require('./language-sync');
const packs = require('../../scripts/language-packs');
const languageCache = require('./language-cache');

const INTERVAL_MS = 3 * 60 * 60 * 1000;
// The first pass waits for the new leader to settle.
const FIRST_PASS_DELAY_MS = 10 * 60 * 1000;
// Up to this many messages are translated directly, in the pass that finds
// them; more go as a Message Batch.
const DIRECT_LIMIT = 400;
// After a pass that wrote nothing because requests failed, how long the
// same requests wait before they are sent again.
const RETRY_AFTER_FAILURE_MS = 24 * 60 * 60 * 1000;
const STATE_KEY = 'language_sync_state';

function isEnabled() {
  const v = String(process.env.LANGUAGE_SYNC_ENABLED ?? '1').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

// ── State (one platform_settings row, JSON) ────────────────────────────
//   checkedDigest  the build's catalogs (sourceDigest) the last finished pass read
//   batch       { id, sourceDigest, english: { id: hash }, shape, submittedAt, messages } while a batch runs
//   failure     { at, shape, requests, reasons, example, batch } the last
//               pass that wrote nothing because requests failed; gone once a
//               pass ends without one
//   lastPass    { at, requested, written, failed, problems } what the last
//               pass that translated anything got back (#4641: a pass that
//               wrote nothing used to leave no trace of why)

async function readState(pool) {
  try {
    const { rows } = await pool.query('SELECT value FROM platform_settings WHERE key = $1', [STATE_KEY]);
    const parsed = rows[0] ? JSON.parse(rows[0].value) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    log.warn('language-sync', 'State read failed', { err: err.message });
    return {};
  }
}

async function writeState(pool, state) {
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at, description)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [STATE_KEY, JSON.stringify(state), 'Where the translation step stands (services/language-sync-runner.js).'],
  );
}

// ── What the build says ───────────────────────────────────────────────

/** A digest of the build's catalogs (English and committed translations): what a pass read. */
function sourceDigest(source) {
  const hash = crypto.createHash('sha256');
  for (const name of Object.keys(source?.files || {}).sort()) {
    hash.update(name).update('\0').update(JSON.stringify(source.files[name])).update('\0');
  }
  return hash.digest('hex');
}

/** The English one planned message was asked about, short: a batch's answer is used only for that English. */
function englishOf(item) {
  return packs.hash(JSON.stringify([item.english, item.forms || null])).slice(0, 16);
}

/**
 * The answers to a batch, matched to the messages planned NOW: by message id,
 * whatever request carried it, and only where its English is still what the
 * batch asked about. Resolves the same Map (customId -> { text }) that
 * syncTranslations reads, for the requests prepareSync made now.
 */
function batchAnswersFor(requests, answers, english = {}) {
  const byLanguage = new Map();
  for (const [customId, answer] of answers) {
    if (!answer || answer.error) continue;
    const language = String(customId).replace(/-\d+(?:-retry-\d+)?$/, '');
    const index = byLanguage.get(language) || new Map();
    for (const [id, entry] of sync.parseAnswer(answer.text)) if (!index.has(id)) index.set(id, entry);
    byLanguage.set(language, index);
  }
  const out = new Map();
  for (const request of requests) {
    const index = byLanguage.get(request.language) || new Map();
    const translations = request.items
      .filter((item) => english[item.id] === englishOf(item) && index.has(item.id))
      .map((item) => index.get(item.id));
    out.set(request.customId, translations.length ? { text: JSON.stringify({ translations }) } : { error: 'no answer' });
  }
  return out;
}

/**
 * What one pass got back, for the state and the log: how many messages it
 * asked for, how many it could use, and the commonest reasons the rest stay
 * English (at most three, each with its count).
 */
function passOutcome(summary, now = new Date()) {
  let requested = 0;
  let written = 0;
  let failed = 0;
  const reasons = new Map();
  for (const language of Object.values(summary.languages || {})) {
    requested += language.requested;
    written += language.written;
    failed += language.failed.length;
    for (const { problem } of language.failed) reasons.set(problem, (reasons.get(problem) || 0) + 1);
  }
  const problems = [...reasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([problem, count]) => ({ problem: String(problem).slice(0, 300), count }));
  return { at: now.toISOString(), requested, written, failed, problems };
}

/** A pass that asked for translations and could use none of them is a fault to see, not an info line. */
function logOutcome(outcome, extra = {}) {
  if (outcome.requested > 0 && outcome.written === 0) {
    log.warn('language-sync', 'Translation pass wrote nothing', { ...extra, ...outcome });
  }
}

/** What the answers cost, in cents, at the batch discount when they came as one. */
function spendCents(answers, { batch = false } = {}) {
  let cents = 0;
  for (const answer of answers.values()) {
    if (answer && answer.usage) cents += llm.estimateCostCents(answer.usage, sync.MODEL);
  }
  return batch ? cents / 2 : cents;
}

// ── A pass that produced nothing, or less than it asked for ───────────

const MAX_REASONS = 6;

/**
 * An error's wording as the step logs, keeps and returns it: one line,
 * masked for secrets, at most 300 characters, and unchanged by the logger's
 * own masking (llm.boundedErrorText).
 */
function bounded(text) {
  return llm.boundedErrorText(text);
}

/** The commonest entries of a { reason: count } tally. */
function commonest(tally) {
  return Object.fromEntries(Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, MAX_REASONS));
}

/**
 * Why a pass wrote less than it asked for, for the log: how many requests
 * failed and for what reason, one error message as the API worded it, and
 * what the checks refused. Counts and the API's own words only: no message
 * text, no translation.
 */
function explain(summary, batch = null) {
  const problems = {};
  for (const result of Object.values(summary.languages)) {
    for (const { problem } of result.failed) problems[problem] = (problems[problem] || 0) + 1;
  }
  const out = {
    requests: summary.requests.sent,
    failedRequests: summary.requests.failed,
    reasons: commonest(summary.requests.reasons),
  };
  // The API's wording is free text: masked and cut before it is logged,
  // kept in the state or returned by status().
  if (summary.requests.example) out.example = bounded(summary.requests.example);
  if (Object.keys(problems).length) out.leftInEnglish = commonest(problems);
  if (batch) {
    out.batchId = batch.id;
    if (batch.counts) out.batchCounts = batch.counts;
  }
  return out;
}

/**
 * Logs a pass that wrote less than it asked for. When it wrote nothing and
 * messages are left that no request answered, returns what the state keeps:
 * the work is not done, and is held back. `at` is when the outcome was known.
 */
function reportFailures({ logger, summary, batch = null, shape = sync.requestShape(), at }) {
  const wrote = Object.values(summary.languages).some((result) => result.written > 0);
  const refused = Object.values(summary.languages).some((result) => result.failed.length > 0);
  if (wrote && !summary.requests.failed && !refused) return null;
  const detail = explain(summary, batch);
  if (wrote || !summary.unanswered) {
    logger.warn('language-sync', wrote
      ? 'Translation pass wrote less than it asked for'
      : 'Translation pass produced nothing', detail);
    return null;
  }
  return recordFailure({
    logger, detail, batch, shape, at, requests: summary.requests.sent,
    what: summary.nothingAnswered ? 'Every translation request failed' : 'Translation requests failed and nothing was written',
  });
}

/** Logs a failure that leaves the work undone, and returns what the state keeps of it. */
function recordFailure({ logger, what, detail, batch = null, shape = sync.requestShape(), at, requests }) {
  const held = shape === sync.requestShape();
  logger.warn('language-sync', held
    ? `${what}; not sending them again until the request changes or a day has passed`
    : `${what}; they were made by an earlier version, so the next pass sends them as this one makes them`,
  held ? { ...detail, retryAfter: new Date(at + RETRY_AFTER_FAILURE_MS).toISOString() } : detail);
  return {
    at: new Date(at).toISOString(),
    // What the failed requests were made of. A batch sent by an earlier
    // version keeps that version's shape, so it never holds this one back.
    shape,
    requests,
    reasons: detail.reasons,
    example: detail.example || null,
    batch: batch ? { id: batch.id, counts: batch.counts || null } : null,
  };
}

/** When the same requests are due again after `failure`, in ms, or null when nothing holds them. */
function heldUntil(failure, now) {
  if (!failure || failure.shape !== sync.requestShape()) return null;
  const at = Date.parse(failure.at);
  if (!Number.isFinite(at) || now - at >= RETRY_AFTER_FAILURE_MS) return null;
  return at + RETRY_AFTER_FAILURE_MS;
}

/**
 * A batch the API would not take for a reason that asking again does not
 * change: the request, the key, the account. Rate limits, timeouts and
 * server errors are left to the next pass.
 */
function submissionRefused(err) {
  const status = Number(err?.status);
  return status >= 400 && status < 500 && ![408, 409, 429].includes(status);
}

// ── One pass ───────────────────────────────────────────────────────────

/**
 * Keeps what a pass accepted, and says so in the state. Returns what to log.
 * A pass that wrote nothing because requests failed is not marked as read:
 * the same work is due again once the failure stops holding it back.
 */
async function finishPass(pool, { summary, spent, checkedDigest, deps, extra = {}, shape = sync.requestShape(), batch = null }) {
  const cache = deps.cache || languageCache;
  const logger = deps.log || log;
  const clock = deps.now || Date.now;
  await limits.recordSystemSpend(pool, spent);
  const cached = await cache.saveTranslations(pool, summary.entries, { model: sync.MODEL });
  const lastPass = passOutcome(summary);
  logOutcome(lastPass, extra);
  const failure = reportFailures({ logger, summary, at: clock(), shape, batch });
  if (failure) {
    await writeState(pool, { checkedDigest: null, failure, lastPass });
    return { failed: true, reasons: failure.reasons, spentCents: spent };
  }
  await writeState(pool, { checkedDigest, lastPass });
  return cached
    ? { cached, spentCents: spent, ...(lastPass.failed ? { failed: lastPass.failed } : {}) }
    : { nothingUsable: true, spentCents: spent, failed: lastPass.failed };
}

/**
 * Translates what the running build's English is missing, beyond what the
 * cache already has, and keeps it in the cache; or submits a batch, or keeps
 * the answers of a batch that has ended. Returns what it did, for the log.
 */
async function runOnce({ config, pool, deps = {} }) {
  void config;
  const model = deps.llm || llm;
  const cache = deps.cache || languageCache;
  const logger = deps.log || log;
  const clock = deps.now || Date.now;
  if (!model.isEnabled()) return { skipped: 'no_key' };
  const source = deps.source !== undefined ? deps.source : cache.readSource();
  if (!source) return { skipped: 'no_source' };
  const digest = sourceDigest(source);
  const state = await readState(pool);

  if (state.batch) {
    let status;
    try {
      status = await model.catalogBatchStatus(state.batch.id);
    } catch (err) {
      // A batch Anthropic no longer knows (its results are kept 29 days) is
      // let go; the next pass plans again.
      if (err && err.status === 404) {
        await writeState(pool, { failure: state.failure, lastPass: state.lastPass });
        return { dropped: state.batch.id };
      }
      throw err;
    }
    if (status.status !== 'ended') return { waiting: state.batch.id };
    const root = await cache.liveRoot(pool, { source });
    try {
      const answers = await model.catalogBatchAnswers(state.batch.id);
      let spent = spendCents(answers, { batch: true });
      const summary = await sync.syncTranslations({
        root,
        maxRetries: DIRECT_LIMIT,
        translate: async (requests, { round }) => {
          if (round === 0) return batchAnswersFor(requests, answers, state.batch.english || {});
          const retried = await model.translateCatalogDirect(requests);
          spent += spendCents(retried);
          return retried;
        },
      });
      // What the batch was asked from: when a deploy moved the English since,
      // the next pass plans again from the new English.
      return await finishPass(pool, {
        summary,
        spent,
        checkedDigest: state.batch.sourceDigest || null,
        deps,
        extra: { batchId: state.batch.id },
        shape: state.batch.shape || null,
        batch: { id: state.batch.id, counts: status.counts || null },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // Requests failed lately and a request is still made the same way.
  if (heldUntil(state.failure, clock()) !== null) return { skipped: 'failed_before' };

  if (digest === state.checkedDigest) return { skipped: 'unchanged' };
  const root = await cache.liveRoot(pool, { source });
  try {
    const prepared = sync.prepareSync(root);
    const messages = [...prepared.plans.values()].reduce((sum, items) => sum + items.length, 0);
    if (!messages) {
      await writeState(pool, { checkedDigest: digest, failure: state.failure, lastPass: state.lastPass });
      return { skipped: 'nothing_missing' };
    }
    const budget = await limits.checkSystemBudget(pool);
    if (budget.error) return { skipped: 'budget' };

    if (messages > DIRECT_LIMIT) {
      let batch;
      try {
        batch = await model.submitCatalogBatch(prepared.requests);
      } catch (err) {
        if (!submissionRefused(err)) throw err;
        // Refused before it ran: no batch exists to report on later, so this
        // is the failure, kept and held back like any other.
        const refusal = llm.catalogFailure('submit', err.error, err.message, err.status);
        const reason = [refusal.kind, refusal.type].filter(Boolean).join(': ');
        const detail = { requests: prepared.requests.length, failedRequests: prepared.requests.length, reasons: { [reason]: 1 } };
        if (refusal.message) detail.example = bounded(refusal.message);
        const failure = recordFailure({
          logger, detail, at: clock(), requests: prepared.requests.length,
          what: 'The translation batch was refused',
        });
        await writeState(pool, { checkedDigest: null, failure });
        return { failed: true, reasons: failure.reasons, messages, spentCents: 0 };
      }
      const english = {};
      for (const items of prepared.plans.values()) for (const item of items) english[item.id] = englishOf(item);
      await writeState(pool, {
        lastPass: state.lastPass,
        batch: {
          id: batch.id, sourceDigest: digest, english, shape: sync.requestShape(),
          submittedAt: new Date(clock()).toISOString(), messages,
        },
      });
      log.info('language-sync', 'Translation batch submitted', { batchId: batch.id, messages, requests: prepared.requests.length });
      return { submitted: batch.id, messages };
    }

    let spent = 0;
    const summary = await sync.syncTranslations({
      root,
      translate: async (requests) => {
        const answers = await model.translateCatalogDirect(requests);
        spent += spendCents(answers);
        return answers;
      },
    });
    return { ...(await finishPass(pool, { summary, spent, checkedDigest: digest, deps, extra: { sourceDigest: digest } })), messages };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Where the step stands, for a full admin (get_browser_languages): whether it
 * is on, a batch still running, what the last pass that translated anything
 * got back (how many it could use, and why the rest stayed English), the last
 * pass that wrote nothing because requests failed (when, how many requests,
 * why, and when they are due again: null when the next pass sends them), and
 * how much of each language the shell has now, committed and cached together.
 */
async function status(pool, { deps = {}, now = Date.now() } = {}) {
  const state = await readState(pool);
  let coverage = null;
  try {
    coverage = (await (deps.cache || languageCache).live(pool))?.coverage || null;
  } catch (err) {
    log.warn('language-sync', 'Could not read the languages offered', { err: err.message });
  }
  return {
    enabled: isEnabled(),
    batch: state.batch ? { submittedAt: state.batch.submittedAt, messages: state.batch.messages } : null,
    failure: state.failure ? {
      at: state.failure.at,
      requests: state.failure.requests ?? null,
      reasons: state.failure.reasons || {},
      example: state.failure.example || null,
      batchCounts: state.failure.batch?.counts || null,
      // Null once a request is made differently or the day has passed: the
      // next pass sends again.
      retryAfter: heldUntil(state.failure, now) === null ? null : new Date(heldUntil(state.failure, now)).toISOString(),
    } : null,
    lastPass: state.lastPass || null,
    coverage,
  };
}

let timer = null;
let firstPass = null;
let inFlight = null;
function start(config, pool) {
  if (timer || !isEnabled() || !pool) return;
  const run = () => {
    if (inFlight) return inFlight;
    inFlight = runOnce({ config, pool })
      .then((result) => { if (!result.skipped) log.info('language-sync', 'Translation pass', result); })
      .catch((err) => log.warn('language-sync', 'Translation pass stopped', { err: bounded(err?.message || err) }))
      .finally(() => { inFlight = null; });
    return inFlight;
  };
  timer = setInterval(run, INTERVAL_MS);
  timer.unref();
  firstPass = setTimeout(run, FIRST_PASS_DELAY_MS);
  firstPass.unref();
}

async function stop() {
  clearInterval(timer);
  clearTimeout(firstPass);
  timer = null;
  firstPass = null;
  await inFlight;
}

module.exports = {
  DIRECT_LIMIT,
  RETRY_AFTER_FAILURE_MS,
  STATE_KEY,
  batchAnswersFor,
  bounded,
  englishOf,
  explain,
  isEnabled,
  passOutcome,
  readState,
  runOnce,
  sourceDigest,
  start,
  status,
  stop,
  writeState,
};
