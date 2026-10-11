'use strict';

// The translation step, run by Homeroom on its own catalogs
// (frontend/locales/README.md, "Translations").
//
// A leader-only sweep on the fixed-check-sync pattern. Each pass reads the
// platform's catalogs on main. When English has messages a configured
// language lacks (text merged since the last pass, or a language just added
// to config.json), it translates them with the platform's key
// (services/language-sync.js) and opens ONE proposal carrying the
// translations, which the community votes on like any other change. Once it
// merges, the build packs them, and a language whose coverage reaches
// config.json's minimumCoverage is offered in Settings and matched to devices.
//
// Why a proposal of its own rather than a commit on each proposal's branch:
// the platform adding a commit to a proposal under review is an authored
// change to it (integration.classifyHeadMove), so it would clear the votes it
// had collected and restart its checks, and it would race the author's own
// agent pushing to the same branch. A translation proposal lags the English
// by one vote; until it merges, the new messages show in English, one at a
// time, which is the fallback the build already guarantees.
//
// A few messages (a proposal's worth) go one request at a time and are up for
// a vote the same pass. A whole language goes as one Message Batch, half the
// price: the pass that submits it records it in platform_settings, and a later
// pass, on this leader or the next, opens the proposal once it has ended.
//
// One translation proposal is open at a time. If the community closes one
// without merging it, the same English is not offered again: the sweep waits
// until the English changes.
//
// A pass in which every request failed (a request the API refuses, a key out
// of credit, an outage) opens nothing, so it is logged at warn with the
// reason and kept in the state. The same requests are then not sent again
// for a day; a change to what a request is made of (language-sync.js
// requestShape) is tried on the next pass.
//
// Off with LANGUAGE_SYNC_ENABLED=false, and idle without an Anthropic key.
// Spend counts against the system budget (limits.checkSystemBudget).

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const log = require('./logger');
const github = require('./github');
const llm = require('./llm');
const limits = require('./limits');
const sync = require('./language-sync');
const packs = require('../../scripts/language-packs');

const INTERVAL_MS = 3 * 60 * 60 * 1000;
// The first pass waits for the new leader to settle.
const FIRST_PASS_DELAY_MS = 10 * 60 * 1000;
// Up to this many messages are translated directly, in the pass that finds
// them; more go as a Message Batch.
const DIRECT_LIMIT = 400;
// After a pass in which every request failed, how long the same requests
// wait before they are sent again.
const RETRY_AFTER_FAILURE_MS = 24 * 60 * 60 * 1000;
const STATE_KEY = 'language_sync_state';
const SOURCE = 'translation';
const BRANCH_PREFIX = 'i18n/translations';
const LOCALES_PREFIX = 'frontend/locales/';
const OPEN_STATUSES = ['active', 'paused', 'promoted'];

function isEnabled() {
  const v = String(process.env.LANGUAGE_SYNC_ENABLED ?? '1').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

function parseRepo(url) {
  const match = String(url || '').match(/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

// ── State (one platform_settings row, JSON) ────────────────────────────
//   checkedSha  the main commit the last finished pass looked at
//   batch       { id, baseSha, submittedAt, messages } while a batch runs
//   proposal    { sessionId, englishDigest } the last proposal opened
//   failure     { at, shape, baseSha, requests, reasons, example, batch } the
//               last pass in which every request failed; gone once one answers

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

// ── The catalogs at a commit, on disk ─────────────────────────────────

/**
 * Writes frontend/locales at `sha` into a fresh temporary directory and
 * returns its path. The runtime image carries no frontend/, so the catalogs
 * are read from GitHub, through the blob API, which has no 1 MB limit.
 */
async function materialize({ owner, repo, sha, deps = {} }) {
  const gh = deps.github || github;
  const listing = await gh.listRepoFiles(owner, repo, sha);
  if (!listing || listing.truncated) throw new Error('Could not list the repository at that commit');
  const files = listing.files.filter((file) => file.path.startsWith(LOCALES_PREFIX) && file.path.endsWith('.json'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'language-sync-'));
  let next = 0;
  const lane = async () => {
    while (next < files.length) {
      const file = files[next++];
      const content = await gh.getBlobContent(owner, repo, file.sha);
      const target = path.join(root, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, lane));
  return root;
}

/** A digest of the English source: what a closed proposal declined. */
function englishDigest(root) {
  const directory = path.join(root, LOCALES_PREFIX, 'en');
  const hash = crypto.createHash('sha256');
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort()) {
    hash.update(file).update('\0').update(fs.readFileSync(path.join(directory, file))).update('\0');
  }
  return hash.digest('hex');
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
  if (summary.requests.example) out.example = summary.requests.example;
  if (Object.keys(problems).length) out.leftInEnglish = commonest(problems);
  if (batch) {
    out.batchId = batch.id;
    if (batch.counts) out.batchCounts = batch.counts;
  }
  return out;
}

/** Logs a pass that failed in part or whole, and returns what the state keeps of a whole failure. */
function reportFailures({ logger, summary, baseSha, batch = null, shape = sync.requestShape(), now }) {
  const wrote = summary.files.length > 0;
  if (wrote && !summary.requests.failed) return null;
  const detail = explain(summary, batch);
  if (!summary.nothingAnswered) {
    logger.warn('language-sync', wrote ? 'Some translation requests failed' : 'Translation pass produced nothing', detail);
    return null;
  }
  const held = shape === sync.requestShape();
  logger.warn('language-sync', held
    ? 'Every translation request failed; not sending them again until the request changes or a day has passed'
    : 'Every translation request failed; they were made by an earlier version, so the next pass sends them as this one makes them',
  held ? { ...detail, retryAfter: new Date(now + RETRY_AFTER_FAILURE_MS).toISOString() } : detail);
  return {
    at: new Date(now).toISOString(),
    // What the failed requests were made of. A batch sent by an earlier
    // version keeps that version's shape, so it never holds this one back.
    shape,
    baseSha,
    requests: summary.requests.sent,
    reasons: detail.reasons,
    example: detail.example || null,
    batch: batch ? { id: batch.id, counts: batch.counts || null } : null,
  };
}

/** True while the last whole failure still holds the same requests back. */
function heldBack(failure, now) {
  if (!failure || failure.shape !== sync.requestShape()) return false;
  const at = Date.parse(failure.at);
  return Number.isFinite(at) && now - at < RETRY_AFTER_FAILURE_MS;
}

// ── The proposal ───────────────────────────────────────────────────────

function proposalTitle(config, summary) {
  const names = Object.entries(summary.languages)
    .filter(([, result]) => result.written > 0)
    .map(([language]) => config.languages[language] || language);
  const messages = Math.max(0, ...Object.values(summary.languages).map((result) => result.written));
  return `Translations: ${messages} interface message${messages === 1 ? '' : 's'} in ${names.join(', ')}`.slice(0, 250);
}

function proposalBody(config, summary, baseSha) {
  const lines = [
    'Homeroom\'s translation step found interface text that one or more of its languages did not have yet, '
      + 'and translated it. Nothing here changes the English: only `frontend/locales/<language>/*.json`.',
    '',
    '| Language | Translated | Left in English |',
    '| --- | --- | --- |',
  ];
  for (const [language, result] of Object.entries(summary.languages)) {
    lines.push(`| ${config.languages[language] || language} (\`${language}\`) | ${result.written} of ${result.requested} | ${result.failed.length} |`);
  }
  lines.push(
    '',
    `Translated from the English at ${baseSha.slice(0, 7)} by ${sync.MODEL}, each message with its description, `
      + 'the glossary and the language\'s style note (`frontend/locales/glossary.json`). Every answer was checked '
      + 'for its parameters, tags, plural forms, line breaks and untranslated names; one that failed twice is left '
      + 'out and shows in English.',
    '',
    'Each entry records the digest of the English it was translated from, so a later change to the English shows '
      + 'it as out of date. To correct one by hand, edit its text and add `"locked": true`, and the step will leave '
      + 'it alone. A language is offered in Settings once it covers '
      + `${Math.round((config.minimumCoverage ?? 0) * 100)}% of the English.`,
  );
  return lines.join('\n');
}

function proposalSummary(config, summary) {
  const names = Object.entries(summary.languages)
    .filter(([, result]) => result.written > 0)
    .map(([language]) => config.languages[language] || language);
  return `Homeroom's screens get their newest text in ${names.join(', ')}. People who use Homeroom in one of these `
    + 'languages see it in their language instead of English once this merges. Nothing changes in English.';
}

/** Opens the translation proposal: branch at baseSha, the files, a PR, a promoted session, its checks. */
async function openProposal({ config, pool, app, repo, baseSha, root, summary, deps = {} }) {
  const gh = deps.github || github;
  const maintenance = deps.maintenance || require('./fleet-maintenance');
  const locales = packs.readConfig(path.join(root, LOCALES_PREFIX));
  const files = summary.files.map((file) => ({
    path: file.split(path.sep).join('/'),
    content: fs.readFileSync(path.join(root, file), 'utf8'),
  }));
  const branch = `${BRANCH_PREFIX}-${Date.now()}`;
  // At the commit the English was read from: a hand correction merged to
  // main since is never overwritten with an older file.
  await gh.ensureBranchAtSha(repo.owner, repo.repo, branch, baseSha);
  const prTitle = proposalTitle(locales, summary);
  await gh.pushFiles(repo.owner, repo.repo, files, { branch, message: prTitle });
  const prData = await gh.createPR(repo.owner, repo.repo, { branch, title: prTitle, body: proposalBody(locales, summary, baseSha) });
  const platformUserId = await maintenance.ensurePlatformUser(pool);
  const { rows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_number, pr_url, pr_title, status, promoted_at, source,
        pr_summary_md, pr_summary_source)
     VALUES ($1, $2, $3, $4, $5, $6, 'promoted', NOW(), $7, $8, 'author')
     RETURNING id`,
    [app.id, platformUserId, branch, prData.number, prData.html_url, prTitle, SOURCE, proposalSummary(locales, summary)],
  );
  const sessionId = rows[0].id;

  // The promote path's side effects, as every platform-opened proposal has
  // them (services/fleet-maintenance.js openCampaignProposal).
  const { pushVoteUpdate, pushNotificationToUser } = deps.ws || require('./ws');
  const notifications = deps.notifications || require('./notifications');
  const events = require('./events');
  pushVoteUpdate({ sessionId, appSlug: app.slug, merged: false });
  events.record(pool, {
    type: events.EVENT_TYPES.PR_PROMOTED,
    userId: platformUserId,
    appId: app.id,
    sessionId,
    metadata: { prNumber: prData.number, translation: true },
  });
  try {
    const notifRows = await notifications.createPrProposedNotifications(pool, {
      appId: app.id, sessionId, proposerId: platformUserId,
    });
    for (const row of notifRows) {
      pushNotificationToUser(row.user_id, {
        type: 'notification_new',
        notification: notifications.serialize({
          ...row,
          app_slug: app.slug,
          app_name: app.name,
          pr_title: prTitle,
          pr_number: prData.number,
          source_username: maintenance.PLATFORM_USERNAME,
        }),
      });
    }
  } catch (err) {
    log.warn('language-sync', 'pr_proposed notify failed', { sessionId, err: err.message });
  }
  maintenance.kickChecks(config, pool, { id: sessionId, branch_name: branch, pr_number: prData.number }, app);
  log.info('language-sync', 'Translation proposal opened', { prNumber: prData.number, sessionId, files: files.length });
  return { sessionId, prNumber: prData.number, prUrl: prData.html_url };
}

// ── One pass ───────────────────────────────────────────────────────────

async function platformApp(pool) {
  const { rows } = await pool.query(
    'SELECT id, slug, name, repo_url FROM apps WHERE self_hosted = TRUE ORDER BY id ASC LIMIT 1',
  );
  return rows[0] || null;
}

async function sessionStatus(pool, sessionId) {
  if (!sessionId) return null;
  const { rows } = await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [sessionId]);
  return rows[0] ? rows[0].status : null;
}

/**
 * Translates what main is missing and opens the proposal, or submits the
 * batch, or opens the proposal for a batch that has ended. Returns what it
 * did, for the log.
 */
async function runOnce({ config, pool, deps = {} }) {
  const model = deps.llm || llm;
  const gh = deps.github || github;
  const logger = deps.log || log;
  const now = deps.now ? deps.now() : Date.now();
  if (!model.isEnabled()) return { skipped: 'no_key' };
  const app = await platformApp(pool);
  const repo = app && parseRepo(app.repo_url);
  if (!repo) return { skipped: 'no_platform_app' };

  const state = await readState(pool);
  const lastStatus = await sessionStatus(pool, state.proposal?.sessionId);
  if (lastStatus && OPEN_STATUSES.includes(lastStatus)) return { skipped: 'proposal_open' };

  if (state.batch) {
    let status;
    try {
      status = await model.catalogBatchStatus(state.batch.id);
    } catch (err) {
      // A batch Anthropic no longer knows (its results are kept 29 days) is
      // let go; the next pass plans again from main.
      if (err && err.status === 404) {
        await writeState(pool, { checkedSha: null, proposal: state.proposal, failure: state.failure });
        return { dropped: state.batch.id };
      }
      throw err;
    }
    if (status.status !== 'ended') return { waiting: state.batch.id };
    const root = await materialize({ owner: repo.owner, repo: repo.repo, sha: state.batch.baseSha, deps });
    try {
      const answers = await model.catalogBatchAnswers(state.batch.id);
      let spent = spendCents(answers, { batch: true });
      const summary = await sync.syncTranslations({
        root,
        maxRetries: DIRECT_LIMIT,
        translate: async (requests, { round }) => {
          if (round === 0) return answers;
          const retried = await model.translateCatalogDirect(requests);
          spent += spendCents(retried);
          return retried;
        },
      });
      await limits.recordSystemSpend(pool, spent);
      const digest = englishDigest(root);
      const failure = reportFailures({
        logger, summary, baseSha: state.batch.baseSha, now, shape: state.batch.shape || null,
        batch: { id: state.batch.id, counts: status.counts || null },
      });
      if (failure) {
        // Nothing was translated, so main is not marked as read: the same
        // work is due again once the failure stops holding it back.
        await writeState(pool, { checkedSha: null, proposal: state.proposal, failure });
        return { failed: true, reasons: failure.reasons, spentCents: spent };
      }
      const next = { checkedSha: state.batch.baseSha, proposal: state.proposal };
      if (summary.files.length) {
        const opened = await openProposal({ config, pool, app, repo, baseSha: state.batch.baseSha, root, summary, deps });
        next.proposal = { sessionId: opened.sessionId, englishDigest: digest };
        await writeState(pool, next);
        return { opened: opened.prNumber, spentCents: spent };
      }
      await writeState(pool, next);
      return { nothingUsable: true, spentCents: spent };
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // Every request failed lately and a request is still made the same way.
  if (heldBack(state.failure, now)) return { skipped: 'failed_before' };

  const mainSha = await gh.getBranchSha(repo.owner, repo.repo, 'main');
  if (!mainSha || mainSha === state.checkedSha) return { skipped: 'unchanged' };
  const root = await materialize({ owner: repo.owner, repo: repo.repo, sha: mainSha, deps });
  try {
    const digest = englishDigest(root);
    // The community closed the last proposal for this very English.
    if (lastStatus && lastStatus !== 'merged' && state.proposal?.englishDigest === digest) {
      await writeState(pool, { ...state, checkedSha: mainSha });
      return { skipped: 'declined' };
    }
    const prepared = sync.prepareSync(root);
    const messages = [...prepared.plans.values()].reduce((sum, items) => sum + items.length, 0);
    if (!messages) {
      await writeState(pool, { checkedSha: mainSha, proposal: state.proposal, failure: state.failure });
      return { skipped: 'nothing_missing' };
    }
    const budget = await limits.checkSystemBudget(pool);
    if (budget.error) return { skipped: 'budget' };

    if (messages > DIRECT_LIMIT) {
      const batch = await model.submitCatalogBatch(prepared.requests);
      await writeState(pool, {
        ...state,
        batch: { id: batch.id, baseSha: mainSha, submittedAt: new Date(now).toISOString(), messages, shape: sync.requestShape() },
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
    await limits.recordSystemSpend(pool, spent);
    const failure = reportFailures({ logger, summary, baseSha: mainSha, now });
    if (failure) {
      await writeState(pool, { checkedSha: null, proposal: state.proposal, failure });
      return { failed: true, reasons: failure.reasons, messages, spentCents: spent };
    }
    const next = { checkedSha: mainSha, proposal: state.proposal };
    if (summary.files.length) {
      const opened = await openProposal({ config, pool, app, repo, baseSha: mainSha, root, summary, deps });
      next.proposal = { sessionId: opened.sessionId, englishDigest: digest };
      await writeState(pool, next);
      return { opened: opened.prNumber, messages, spentCents: spent };
    }
    await writeState(pool, next);
    return { nothingUsable: true, messages, spentCents: spent };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Where the step stands, for a full admin (get_browser_languages): the main
 * commit it last read, a batch still running, the last proposal it opened
 * with that proposal's status, and the last pass in which every request
 * failed (when, how many requests, why, and when they are due again).
 */
async function status(pool) {
  const state = await readState(pool);
  let proposal = null;
  if (state.proposal?.sessionId) {
    const { rows } = await pool.query('SELECT pr_number, status FROM chat_sessions WHERE id = $1', [state.proposal.sessionId]);
    proposal = rows[0] ? { prNumber: rows[0].pr_number, status: rows[0].status } : null;
  }
  return {
    enabled: isEnabled(),
    checkedSha: state.checkedSha || null,
    batch: state.batch ? { submittedAt: state.batch.submittedAt, messages: state.batch.messages } : null,
    proposal,
    failure: state.failure ? {
      at: state.failure.at,
      requests: state.failure.requests ?? null,
      reasons: state.failure.reasons || {},
      example: state.failure.example || null,
      batchCounts: state.failure.batch?.counts || null,
      // Null once a request is made differently: the next pass sends again.
      retryAfter: state.failure.shape === sync.requestShape() && Number.isFinite(Date.parse(state.failure.at))
        ? new Date(Date.parse(state.failure.at) + RETRY_AFTER_FAILURE_MS).toISOString()
        : null,
    } : null,
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
      .catch((err) => log.warn('language-sync', 'Translation pass stopped', { err: err.message }))
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
  SOURCE,
  STATE_KEY,
  englishDigest,
  explain,
  isEnabled,
  materialize,
  openProposal,
  proposalBody,
  proposalTitle,
  readState,
  runOnce,
  start,
  status,
  stop,
  writeState,
};
