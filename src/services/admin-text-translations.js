'use strict';

// Text an admin writes in the console and a phone shows (#6152), translated.
//
// The shell's own text has its translation step (language-sync-runner.js),
// which reads catalogs in the build. An admin's words are data, written after
// the build, so they get their own table and their own pass of the same step:
// the same model and prompt, the same checks on every answer, the same
// languages and the same system budget.
//
// English is the source and the fallback. A translation belongs to the digest
// of the English it was made from, so changing the words retires it at once
// and the phone shows the new English until a new one is ready. Nothing here
// can delay or fail the answer it is part of.
//
// A must-update message stands between someone and the app, so its translation
// waits for an admin's review before it is shown. Everything else shows as soon
// as it has passed the checks. What a person wrote or approved is never
// overwritten while its English stands.
//
// Update prompts are the first text here. A new kind of text is one more entry
// in sources().

const log = require('./logger');
const packs = require('../../scripts/language-packs');
const languageCache = require('./language-cache');

// An answer the checks refused is asked for again after this long, not on
// every look: each ask is paid for and would most likely be refused again.
const RETRY_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT = 5000;
const MODEL_ERRORS_PAID_FOR = new Set(['refusal', 'max_tokens']);

const DEFAULT_MUST = 'A required update is available. Please update the app to continue.';
const DEFAULT_SHOULD = 'A new version is available. We recommend updating.';

const OS_NAME = { ios: 'iOS', android: 'Android' };
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

function languagesOf(source) {
  const languages = source?.files?.['config.json']?.languages;
  return isObject(languages) ? languages : {};
}

function translatedLanguages(source) {
  return Object.keys(languagesOf(source)).filter((language) => language !== 'en');
}

function glossaryOf(source) {
  const glossary = source?.files?.['glossary.json'];
  return {
    doNotTranslate: Array.isArray(glossary?.doNotTranslate) ? glossary.doNotTranslate.filter((term) => typeof term === 'string') : [],
    terms: isObject(glossary?.terms) ? glossary.terms : {},
    style: isObject(glossary?.style) ? glossary.style : {},
  };
}

const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/;
const baseOf = (tag) => tag.split('-')[0];

/** The language in `languages` closest to one tag; '' for English; null for none. */
function matchTag(raw, languages) {
  if (typeof raw !== 'string' || raw.length > 35 || !LANGUAGE_TAG.test(raw)) return null;
  const tag = raw.replace(/_/g, '-').toLowerCase();
  if (baseOf(tag) === 'en') return '';
  const exact = languages.find((language) => language.toLowerCase() === tag);
  if (exact) return exact;
  return languages.find((language) => baseOf(language.toLowerCase()) === baseOf(tag)) || null;
}

/**
 * The language to answer in, or null for English: the language a phone names,
 * else the first of its Accept-Language that Homeroom has. English needs no
 * read, so a caller that gets null goes straight on.
 */
function languageFor(asked, acceptLanguage, { source = languageCache.readSource() } = {}) {
  const languages = translatedLanguages(source);
  if (!languages.length) return null;
  if (typeof asked === 'string') return matchTag(asked.trim(), languages) || null;
  if (typeof acceptLanguage !== 'string') return null;
  for (const part of acceptLanguage.slice(0, 200).split(',')) {
    const match = matchTag(part.split(';')[0].trim(), languages);
    if (match === '') return null;
    if (match) return match;
  }
  return null;
}

// ── What is translated ─────────────────────────────────────────────────

function mustMessage(os, config) {
  const own = config?.must_update_message;
  return own
    ? { key: `app-version:${os}:must`, english: own, reviewRequired: true }
    : { key: 'app-version:default:must', english: DEFAULT_MUST, reviewRequired: true };
}

function shouldMessage(os, config) {
  const own = config?.should_update_message;
  return own
    ? { key: `app-version:${os}:should`, english: own, reviewRequired: false }
    : { key: 'app-version:default:should', english: DEFAULT_SHOULD, reviewRequired: false };
}

/** The message an update check answers with: upgrade 2 must, 1 should, 0 none. */
function updateMessage(os, upgrade, config) {
  if (upgrade === 2) return mustMessage(os, config);
  if (upgrade === 1) return shouldMessage(os, config);
  return null;
}

/** Everything there is to translate, as it stands now. */
async function sources(pool) {
  const { rows } = await pool.query(
    `SELECT os, must_update_message, should_update_message
       FROM app_version_configs WHERE is_active = TRUE ORDER BY os ASC`,
  );
  const out = [];
  const add = (message, label, description) => { out.push({ ...message, label, description }); };
  for (const config of rows) {
    const name = OS_NAME[config.os] || config.os;
    if (config.must_update_message) {
      add(mustMessage(config.os, config), `${name}: must update`,
        'Shown in a dialog on the phone app that blocks it until the person updates to a new version.');
    }
    if (config.should_update_message) {
      add(shouldMessage(config.os, config), `${name}: should update`,
        'Shown in a dialog on the phone app recommending that the person updates to a new version.');
    }
  }
  add(mustMessage(null, null), 'Any phone: must update (default)',
    'Shown in a dialog on the phone app that blocks it until the person updates to a new version.');
  add(shouldMessage(null, null), 'Any phone: should update (default)',
    'Shown in a dialog on the phone app recommending that the person updates to a new version.');
  return out;
}

// ── Reading one ────────────────────────────────────────────────────────

const isCurrent = (row, english) => !!row && row.source_digest === packs.hash(english);
const hasText = (row) => typeof row?.text === 'string' && row.text.length > 0;
const isShown = (row, message) => isCurrent(row, message.english)
  && hasText(row)
  && (row.reviewed === true || !message.reviewRequired);

/** The message in `language`, or its English. Never throws. */
async function translated(pool, message, language) {
  if (!language) return message.english;
  try {
    const { rows } = await pool.query(
      `SELECT source_digest, text, reviewed
         FROM admin_text_translations
        WHERE source_key = $1 AND language = $2`,
      [message.key, language],
    );
    return isShown(rows[0], message) ? rows[0].text : message.english;
  } catch (err) {
    log.warn('admin-text-translations', 'Read failed, showing English', { key: message.key, message: err.message });
    return message.english;
  }
}

// ── The translation pass ───────────────────────────────────────────────

async function currentRows(pool) {
  const { rows } = await pool.query(
    `SELECT source_key, language, source_digest, text, reviewed, problem, attempted_at
       FROM admin_text_translations`,
  );
  return new Map(rows.map((row) => [`${row.source_key}|${row.language}`, row]));
}

/** Language -> the messages it owes: none yet, older English, or a refusal a day old. */
function owed(messages, rows, languages, now = Date.now()) {
  const plan = new Map();
  for (const language of languages) {
    const items = [];
    for (const message of messages) {
      const row = rows.get(`${message.key}|${language}`);
      if (isCurrent(row, message.english)) {
        if (hasText(row)) continue;
        if (now - new Date(row.attempted_at).getTime() < RETRY_MS) continue;
      }
      items.push({
        kind: 'text',
        id: message.key,
        key: message.key,
        english: message.english,
        description: message.description,
      });
    }
    if (items.length) plan.set(language, items);
  }
  return plan;
}

/** Keeps one attempt. What a person wrote for this English stays, by the WHERE. */
async function saveAttempt(pool, { key, language, english, text, problem, model }) {
  await pool.query(
    `INSERT INTO admin_text_translations
       (source_key, language, source_digest, text, reviewed, problem, model, updated_by, attempted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (source_key, language) DO UPDATE
       SET source_digest = EXCLUDED.source_digest, text = EXCLUDED.text, reviewed = EXCLUDED.reviewed,
           problem = EXCLUDED.problem, model = EXCLUDED.model, updated_by = EXCLUDED.updated_by,
           attempted_at = NOW()
     WHERE admin_text_translations.source_digest <> EXCLUDED.source_digest
        OR admin_text_translations.text IS NULL`,
    [key, language, packs.hash(english), text, false, problem, model, null],
  );
}

function isEnabled() {
  const value = String(process.env.LANGUAGE_SYNC_ENABLED ?? '1').trim().toLowerCase();
  return !(value === '0' || value === 'false' || value === 'off');
}

/** The clock's run: one target when anything is owed. */
async function look({ pool, deps = {} }) {
  if (!isEnabled()) return { off: true };
  const model = deps.llm || require('./llm');
  if (!model.isEnabled()) return { skipped: 'no_key' };
  const source = deps.source !== undefined ? deps.source : languageCache.readSource();
  if (!source) return { skipped: 'no_source' };
  const plan = owed(await sources(pool), await currentRows(pool), translatedLanguages(source));
  return plan.size ? { items: [{ target: 'pending', input: {} }] } : { skipped: 'nothing_missing' };
}

/** One pass: asks for what is owed and keeps what passes the checks. */
async function runOnce({ pool, deps = {} }) {
  const model = deps.llm || require('./llm');
  const budgets = deps.limits || require('./limits');
  const sync = require('./language-sync');
  if (!model.isEnabled()) return { skipped: 'no_key' };
  const source = deps.source !== undefined ? deps.source : languageCache.readSource();
  if (!source) return { skipped: 'no_source' };

  const messages = await sources(pool);
  const plan = owed(messages, await currentRows(pool), translatedLanguages(source));
  if (!plan.size) return { skipped: 'nothing_missing' };
  const budget = await budgets.checkSystemBudget(pool);
  if (budget.error) return { skipped: 'budget' };

  const glossary = glossaryOf(source);
  const names = languagesOf(source);
  const requests = [];
  for (const [language, items] of plan) {
    requests.push(...sync.buildRequests(language, names[language], items, glossary));
  }
  const answers = await model.translateCatalogDirect(requests);

  let saved = 0;
  let refused = 0;
  let spent = 0;
  for (const request of requests) {
    const answer = answers.get(request.customId);
    if (answer?.usage) spent += model.estimateCostCents(answer.usage, sync.MODEL);
    // Not reached, overloaded: nothing was learned, so it stays owed.
    if (!answer || (answer.error && !MODEL_ERRORS_PAID_FOR.has(answer.error))) continue;
    const parsed = sync.parseAnswer(answer.text);
    for (const item of request.items) {
      const accepted = sync.acceptItem(item, parsed.get(item.id), glossary);
      const text = accepted.entries ? accepted.entries[item.key] : null;
      await saveAttempt(pool, {
        key: item.key,
        language: request.language,
        english: item.english,
        text,
        problem: accepted.problem || null,
        model: sync.MODEL,
      });
      if (text) saved += 1;
      else refused += 1;
    }
  }
  await budgets.recordSystemSpend(pool, spent);
  return { saved, refused, spentCents: spent };
}

// ── What an admin reads and does ───────────────────────────────────────

/** waiting (nothing usable yet), failed, needs_review, or live. */
function stateOf(row, message) {
  if (!isCurrent(row, message.english)) return 'waiting';
  if (!hasText(row)) return row.problem ? 'failed' : 'waiting';
  return isShown(row, message) ? 'live' : 'needs_review';
}

async function overview(pool, { source = languageCache.readSource() } = {}) {
  const [messages, rows] = await Promise.all([sources(pool), currentRows(pool)]);
  const names = languagesOf(source);
  return {
    messages: messages.map((message) => ({
      key: message.key,
      label: message.label,
      english: message.english,
      review_required: message.reviewRequired,
      languages: translatedLanguages(source).map((language) => {
        const row = rows.get(`${message.key}|${language}`);
        const current = isCurrent(row, message.english);
        return {
          language,
          name: names[language],
          state: stateOf(row, message),
          text: current && hasText(row) ? row.text : null,
          reviewed: current && row.reviewed === true,
          problem: current ? row.problem || null : null,
        };
      }),
    })),
  };
}

/** The message and language a request names, or the error to answer with. */
async function target(pool, { key, language }, source) {
  if (!translatedLanguages(source).includes(language)) return { error: 'That language is not one Homeroom translates into.' };
  const message = (await sources(pool)).find((candidate) => candidate.key === key);
  return message ? { message } : { error: 'That message does not exist any more.' };
}

async function correct(pool, { key, language, text, userId }, { source = languageCache.readSource() } = {}) {
  const found = await target(pool, { key, language }, source);
  if (found.error) return found;
  const words = typeof text === 'string' ? text.trim() : '';
  if (!words || words.length > MAX_TEXT) return { error: `A translation needs between 1 and ${MAX_TEXT} characters.` };
  await pool.query(
    `INSERT INTO admin_text_translations
       (source_key, language, source_digest, text, reviewed, problem, model, updated_by, attempted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (source_key, language) DO UPDATE
       SET source_digest = EXCLUDED.source_digest, text = EXCLUDED.text, reviewed = EXCLUDED.reviewed,
           problem = NULL, model = NULL, updated_by = EXCLUDED.updated_by, attempted_at = NOW()`,
    [key, language, packs.hash(found.message.english), words, true, null, null, userId ?? null],
  );
  return { ok: true };
}

async function approve(pool, { key, language, userId }, { source = languageCache.readSource() } = {}) {
  const found = await target(pool, { key, language }, source);
  if (found.error) return found;
  const { rowCount } = await pool.query(
    `UPDATE admin_text_translations SET reviewed = TRUE, updated_by = $4, attempted_at = NOW()
      WHERE source_key = $1 AND language = $2 AND source_digest = $3 AND text IS NOT NULL`,
    [key, language, packs.hash(found.message.english), userId ?? null],
  );
  return rowCount ? { ok: true } : { error: 'There is no translation of the current words to approve.' };
}

async function retranslate(pool, { key, language }, { source = languageCache.readSource() } = {}) {
  const found = await target(pool, { key, language }, source);
  if (found.error) return found;
  await pool.query(
    'DELETE FROM admin_text_translations WHERE source_key = $1 AND language = $2',
    [key, language],
  );
  return { ok: true };
}

module.exports = {
  approve,
  correct,
  languageFor,
  look,
  overview,
  retranslate,
  runOnce,
  sources,
  translated,
  updateMessage,
};
