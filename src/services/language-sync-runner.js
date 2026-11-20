'use strict';

// The translation step, run by Homeroom on its own catalogs
// (frontend/locales/README.md, "Translations").
//
// The language-sync clock's (src/workflow/clock/), which only the newest
// build runs. Each pass reads what the RUNNING build says (its
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
// Every message goes as a direct request, a few at a time, in the pass that
// finds it, on the platform's OpenRouter key (task 2275). Large passes went
// as one Anthropic Message Batch at half the price before; OpenRouter has no
// batches, and this build has no Anthropic key to collect one with. So a
// batch an older build submitted (recorded on the state, or only in the
// target's steps when the write that recorded it failed, as can happen
// during the rolling release) is let go on purpose: noted on the state as
// `droppedBatch`, never collected, and the pass that finds it translates
// directly from the English as it is now. Its answers are paid for and lost;
// that is the cost of having no key, and production had none pending at the
// move. The clock looks every ten minutes (look): a catalog it has not
// translated is a target of its own, one pass at a time.
//
// A pass whose English and committed catalogs are what the last finished pass
// read does nothing: what failed then is asked again once the English moves.
//
// Off with LANGUAGE_SYNC_ENABLED=false, and idle while the platform cannot
// make model calls (llm.isEnabled()).
// Spend counts against the system budget (limits.checkSystemBudget).

const crypto = require('node:crypto');
const fs = require('node:fs');

const log = require('./logger');
const llm = require('./llm');
const limits = require('./limits');
const sync = require('./language-sync');
const languageCache = require('./language-cache');

// How often the clock looks: a new build's English is translated at most
// this long after it runs.
const LOOK_MS = 10 * 60 * 1000;
// A round whose failures would take more than this many requests to retry
// one by one (a model refusing everything) is not retried in the pass: those
// messages stay English and the next pass asks again.
const DIRECT_LIMIT = 400;
const STATE_KEY = 'language_sync_state';

function isEnabled() {
  const v = String(process.env.LANGUAGE_SYNC_ENABLED ?? '1').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

// ── State (one platform_settings row, JSON) ────────────────────────────
//   checkedDigest  the build's catalogs (sourceDigest) the last finished pass read
//   batch       { id, sourceDigest, english: { id: hash }, submittedAt, messages }
//               a batch an older build submitted, until a pass lets it go
//   droppedBatch { id, submittedAt, messages, droppedAt } the batch a pass let
//               go (task 2275), kept for an admin to read
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

/** What the answers cost, in cents. */
function spendCents(answers) {
  let cents = 0;
  for (const answer of answers.values()) {
    if (answer && answer.usage) cents += llm.estimateCostCents(answer.usage, sync.MODEL);
  }
  return cents;
}

// ── One pass ───────────────────────────────────────────────────────────

/** Keeps what a pass accepted, and says so in the state. Returns what to log. */
async function finishPass(pool, { summary, spent, checkedDigest, deps, kept = {}, extra = {} }) {
  const cache = deps.cache || languageCache;
  await limits.recordSystemSpend(pool, spent);
  const cached = await cache.saveTranslations(pool, summary.entries, { model: sync.MODEL });
  const lastPass = passOutcome(summary);
  logOutcome(lastPass, extra);
  await writeState(pool, { checkedDigest, lastPass, ...kept });
  return cached
    ? { cached, spentCents: spent, ...(lastPass.failed ? { failed: lastPass.failed } : {}) }
    : { nothingUsable: true, spentCents: spent, failed: lastPass.failed };
}

/**
 * The clock's look: nothing, or the one pass owed, as a target (an older
 * build's batch to let go, keyed by the batch; the build's catalogs not yet
 * translated, `catalog`). The catalog is one target whatever its English
 * (the clock carries a target's checkpoint on). Reads, never spends.
 */
async function look({ pool, deps = {} }) {
  if (!isEnabled()) return { off: true };
  const model = deps.llm || llm;
  const cache = deps.cache || languageCache;
  if (!model.isEnabled()) return { skipped: 'no_key' };
  const source = deps.source !== undefined ? deps.source : cache.readSource();
  if (!source) return { skipped: 'no_source' };
  const state = await readState(pool);
  if (state.batch) return { items: [{ target: `batch:${state.batch.id}`, input: {} }] };
  const digest = sourceDigest(source);
  if (digest === state.checkedDigest) return { skipped: 'unchanged' };
  return { items: [{ target: 'catalog', input: {} }] };
}

/**
 * Translates what the running build's English is missing, beyond what the
 * cache already has, and keeps it in the cache. Returns what it did, for the
 * log. `deps.steps` (the clock's target, its work's steps) may hold a batch
 * an older build's try of this target submitted and never recorded.
 */
async function runOnce({ config, pool, deps = {} }) {
  void config;
  const model = deps.llm || llm;
  const cache = deps.cache || languageCache;
  if (!model.isEnabled()) return { skipped: 'no_key' };
  const source = deps.source !== undefined ? deps.source : cache.readSource();
  if (!source) return { skipped: 'no_source' };
  const digest = sourceDigest(source);
  let state = await readState(pool);

  // An older build's Message Batch (see the header): let go, noted, and
  // the pass run now, directly. Forgetting the digest the last pass read
  // is what makes this pass run: the batch was owed because the English
  // had moved.
  const older = state.batch || (deps.steps && deps.steps.has('batch') ? deps.steps.get('batch') : null);
  let dropped = null;
  if (older && typeof older === 'object' && older.id) {
    dropped = String(older.id);
    state = {
      lastPass: state.lastPass,
      droppedBatch: {
        id: dropped,
        submittedAt: older.submittedAt ?? null,
        messages: older.messages ?? null,
        droppedAt: new Date().toISOString(),
      },
    };
    await writeState(pool, state);
    log.warn('language-sync', 'Translation batch from an older build let go: no Anthropic key collects it (task 2275); its pass runs directly', {
      batchId: dropped, messages: older.messages ?? null,
    });
  }
  const kept = state.droppedBatch ? { droppedBatch: state.droppedBatch } : {};
  const said = (out) => (dropped ? { ...out, droppedBatch: dropped } : out);

  if (digest === state.checkedDigest) return said({ skipped: 'unchanged' });
  const root = await cache.liveRoot(pool, { source });
  try {
    const prepared = sync.prepareSync(root);
    const messages = [...prepared.plans.values()].reduce((sum, items) => sum + items.length, 0);
    if (!messages) {
      await writeState(pool, { checkedDigest: digest, lastPass: state.lastPass, ...kept });
      return said({ skipped: 'nothing_missing' });
    }
    const budget = await limits.checkSystemBudget(pool);
    if (budget.error) return said({ skipped: 'budget' });

    let spent = 0;
    const summary = await sync.syncTranslations({
      root,
      maxRetries: DIRECT_LIMIT,
      translate: async (requests) => {
        const answers = await model.translateCatalogDirect(requests, {
          telemetryContext: { component: 'language_sync' },
        });
        spent += spendCents(answers);
        return answers;
      },
    });
    return said({ ...(await finishPass(pool, { summary, spent, checkedDigest: digest, deps, kept, extra: { sourceDigest: digest } })), messages });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Where the step stands, for a full admin (get_browser_languages): whether it
 * is on, an older build's batch not yet let go, the one a pass let go, what
 * the last pass that translated anything got back (how many it could use,
 * and why the rest stayed English), and how much of each language the shell
 * has now, committed and cached together.
 */
async function status(pool, { deps = {} } = {}) {
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
    droppedBatch: state.droppedBatch || null,
    lastPass: state.lastPass || null,
    coverage,
  };
}

module.exports = {
  DIRECT_LIMIT,
  STATE_KEY,
  LOOK_MS,
  isEnabled,
  look,
  passOutcome,
  readState,
  runOnce,
  sourceDigest,
  status,
  writeState,
};
