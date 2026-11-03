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
// Two kinds of text so far. Update prompts are keyed by what they are, and a
// reply picks its one message. Challenges, seasons and season events are keyed
// by their words: the same sentence on ten challenges is one translation, and a
// read swaps any string in its answer that has one (translatedReads), so no read
// has to know which column a string came from. A string with no translation is
// simply not touched, which is what leaves rewards, links and names alone.

const log = require('./logger');
const packs = require('../../scripts/language-packs');
const languageCache = require('./language-cache');

// An answer the checks refused is asked for again after this long, not on
// every look: each ask is paid for and would most likely be refused again.
const RETRY_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT = 5000;
// Messages asked for in one pass. The first pass after a season's text arrives
// owes thousands; the clock's next look carries on, under the budget.
const MAX_PER_PASS = 300;
const MAX_STRINGS_READ = 5000;
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

// What each kind of text is, for the model. `{text}` is the words themselves.
const CHALLENGE_FIELDS = Object.freeze({
  goal: 'The title of a challenge, on its card. A short heading inviting the person to do it.',
  task: 'What a person does to complete a challenge, a line on its card.',
  description: 'The longer explanation of a challenge, in its details.',
  requirements: 'What a challenge asks for, in its details.',
  reward_logic: 'How the reward of a challenge is worked out, in its details.',
  cta_button: 'A short button on a challenge that takes the person to do it. Word it as an action on a button.',
  cta_label: 'A short button on a challenge that takes the person to do it. Word it as an action on a button.',
  mobile_cta_label: 'A short button on a challenge on a phone that takes the person to do it. Word it as an action on a button.',
  metric_label: 'The unit in a challenge\'s progress bar, right after the count, as in "1/3 {text}". It must read naturally after those numbers.',
});
const MAX_USES = 3;
// Bumped when what the model is told changes enough to ask again: a translation
// made under an older version is replaced once, and shows until it is.
const CONTEXT_VERSION = 'c2';
const hasWords = (text) => typeof text === 'string' && text.length <= MAX_TEXT && /\p{L}/u.test(text);
const textKey = (english) => `text:${packs.hash(english)}`;
const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * What readers see of the programme: a challenge's own words over its template's.
 * One sentence is one translation, so each says every place it is used (up to
 * MAX_USES): which challenge and event it belongs to, and what kind of text it is.
 */
async function programmeSources(pool) {
  const fields = Object.keys(CHALLENGE_FIELDS);
  const [challenges, events, seasons] = await Promise.all([
    pool.query(
      `SELECT e.name AS event_name, c.goal, c.task, c.description, c.requirements, c.reward_logic,
              c.cta_button, c.cta_label, c.mobile_cta_label, c.metric_label,
              t.goal AS t_goal, t.task AS t_task, t.description AS t_description,
              t.requirements AS t_requirements, t.reward_logic AS t_reward_logic,
              t.cta_button AS t_cta_button, t.cta_label AS t_cta_label,
              t.mobile_cta_label AS t_mobile_cta_label, t.metric_label AS t_metric_label
         FROM challenges c
         JOIN season_events e ON e.id = c.season_event_id
         LEFT JOIN challenge_templates t ON t.id = c.challenge_template_id
        WHERE c.enabled = TRUE AND e.internal = FALSE`,
    ),
    pool.query('SELECT name, description, disclaimer FROM season_events WHERE internal = FALSE'),
    pool.query('SELECT name, description FROM seasons WHERE internal = FALSE'),
  ]);
  const found = new Map();
  const add = (english, label, use) => {
    const words = typeof english === 'string' ? english.trim() : '';
    if (english !== words || !hasWords(words)) return;
    const entry = found.get(words) || { label, uses: new Set() };
    if (entry.uses.size < MAX_USES) entry.uses.add(use.replace(/\{text\}/g, words));
    found.set(words, entry);
  };
  for (const row of challenges.rows) {
    const title = row.goal ?? row.t_goal;
    const task = row.task ?? row.t_task;
    const where = [
      title ? `Challenge: "${shorten(String(title), 80)}"` : '',
      task && task !== title ? `which asks: "${shorten(String(task), 100)}"` : '',
      row.event_name ? `in the event "${shorten(String(row.event_name), 60)}"` : '',
    ].filter(Boolean).join(', ');
    for (const field of fields) {
      add(row[field] ?? row[`t_${field}`], 'Challenge', `${CHALLENGE_FIELDS[field]}${where ? ` ${where}.` : ''}`);
    }
  }
  for (const row of events.rows) {
    const about = row.name ? ` The event is "${shorten(String(row.name), 60)}".` : '';
    add(row.name, 'Season event', 'The name of a season event, a period of challenges, in the drop-down above the challenges and the leaderboard.');
    add(row.description, 'Season event', `What a season event is about.${about}`);
    add(row.disclaimer, 'Season event', `The small print of a season event.${about}`);
  }
  for (const row of seasons.rows) {
    const about = row.name ? ` The season is "${shorten(String(row.name), 60)}".` : '';
    add(row.name, 'Season', 'The name of a season of challenges.');
    add(row.description, 'Season', `What a season of challenges is about.${about}`);
  }
  return [...found.entries()].map(([english, entry]) => ({
    key: textKey(english),
    english,
    reviewRequired: false,
    group: 'programme',
    label: entry.label,
    contextVersion: CONTEXT_VERSION,
    description: shorten([...entry.uses].join(' Also: '), 700),
  }));
}

/** Everything there is to translate, as it stands now. */
async function sources(pool) {
  const { rows } = await pool.query(
    `SELECT os, must_update_message, should_update_message
       FROM app_version_configs WHERE is_active = TRUE ORDER BY os ASC`,
  );
  const out = [];
  const add = (message, label, description) => { out.push({ ...message, group: 'update-prompts', label, description }); };
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
  return [...out, ...await programmeSources(pool)];
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

// `only` limits both walks to what sits under those keys, wherever they are:
// a leaderboard's rows are people, and someone may have picked a name that is
// also a season's.
function collectStrings(value, only, out = new Set(), inside = !only) {
  if (typeof value === 'string') {
    if (inside && out.size < MAX_STRINGS_READ && hasWords(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, only, out, inside);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectStrings(item, only, out, inside || only.includes(key));
    }
  }
  return out;
}

function swapStrings(value, words, only, inside = !only) {
  if (typeof value === 'string') return inside && words.has(value) ? words.get(value) : value;
  if (Array.isArray(value)) return value.map((item) => swapStrings(item, words, only, inside));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(
      ([key, item]) => [key, swapStrings(item, words, only, inside || only.includes(key))],
    ));
  }
  return value;
}

/** A copy of `payload` with each string that has a translation swapped. Never throws. */
async function translatePayload(pool, payload, language, { only } = {}) {
  if (!language) return payload;
  try {
    const byKey = new Map([...collectStrings(payload, only)].map((english) => [textKey(english), english]));
    if (!byKey.size) return payload;
    const { rows } = await pool.query(
      `SELECT source_key, source_digest, text
         FROM admin_text_translations
        WHERE language = $1 AND source_key = ANY($2)`,
      [language, [...byKey.keys()]],
    );
    const words = new Map();
    for (const row of rows) {
      const english = byKey.get(row.source_key);
      if (english && isCurrent(row, english) && hasText(row)) words.set(english, row.text);
    }
    return words.size ? swapStrings(payload, words, only) : payload;
  } catch (err) {
    log.warn('admin-text-translations', 'Read failed, showing English', { message: err.message });
    return payload;
  }
}

/** The language a reader chose in Settings, else their browser's; null for English. */
async function readerLanguage(pool, req, source) {
  let locale = req.user?.locale;
  if (!locale && req.user?.id) {
    const { rows } = await pool.query('SELECT locale FROM users WHERE id = $1', [req.user.id]);
    locale = rows[0]?.locale;
  }
  return languageFor(locale || undefined, req.get('accept-language'), { source });
}

/**
 * Middleware for a read of the programme: its answer, in the reader's language.
 * An error answer goes out as it is, and anything going wrong here sends the
 * English the handler wrote.
 */
function translatedReads(pool, { source, only } = {}) {
  return (req, res, next) => {
    res.vary('Accept-Language');
    const send = res.json.bind(res);
    res.json = (body) => {
      res.json = send;
      if (res.statusCode >= 400) return send(body);
      (async () => {
        const language = await readerLanguage(pool, req, source !== undefined ? source : languageCache.readSource());
        return translatePayload(pool, body, language, { only });
      })().then(send, (err) => {
        log.warn('admin-text-translations', 'Could not tell the reader\'s language', { message: err.message });
        send(body);
      });
      return res;
    };
    next();
  };
}

// ── The translation pass ───────────────────────────────────────────────

async function currentRows(pool) {
  const { rows } = await pool.query(
    `SELECT source_key, language, source_digest, text, reviewed, problem, model, attempted_at
       FROM admin_text_translations`,
  );
  return new Map(rows.map((row) => [`${row.source_key}|${row.language}`, row]));
}

const modelMark = (model, contextVersion) => (contextVersion ? `${model}#${contextVersion}` : model);
const isUpToDate = (row, message) => typeof row?.model === 'string' && row.model.endsWith(`#${message.contextVersion}`);

/**
 * Language -> the messages it owes: none yet, older English, a refusal a day
 * old, or a translation made with less context than the text now has.
 */
function owed(messages, rows, languages, { now = Date.now(), limit = Infinity } = {}) {
  const plan = new Map();
  let count = 0;
  for (const language of languages) {
    const items = [];
    for (const message of messages) {
      if (count >= limit) break;
      const row = rows.get(`${message.key}|${language}`);
      if (isCurrent(row, message.english)) {
        if (hasText(row) && (!message.contextVersion || row.reviewed === true || isUpToDate(row, message))) continue;
        if (!hasText(row) && now - new Date(row.attempted_at).getTime() < RETRY_MS) continue;
      }
      count += 1;
      items.push({
        kind: 'text',
        id: message.key,
        key: message.key,
        english: message.english,
        description: message.description,
        contextVersion: message.contextVersion,
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
       SET text = CASE WHEN admin_text_translations.source_digest = EXCLUDED.source_digest
                       THEN COALESCE(EXCLUDED.text, admin_text_translations.text)
                       ELSE EXCLUDED.text END,
           source_digest = EXCLUDED.source_digest, reviewed = EXCLUDED.reviewed,
           problem = EXCLUDED.problem, model = EXCLUDED.model, updated_by = EXCLUDED.updated_by,
           attempted_at = NOW()
     WHERE admin_text_translations.source_digest <> EXCLUDED.source_digest
        OR admin_text_translations.text IS NULL
        OR admin_text_translations.reviewed = FALSE`,
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
  const plan = owed(messages, await currentRows(pool), translatedLanguages(source), { limit: MAX_PER_PASS });
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
      const answered = parsed.get(item.id);
      // Some languages write a spaced hyphen as a dash. The check refuses a dash
      // the English lacks, and that alone should not cost a translation.
      if (typeof answered?.text === 'string' && !item.english.includes('—')) {
        answered.text = answered.text.replace(/\s*—\s*/g, ' - ');
      }
      const accepted = sync.acceptItem(item, answered, glossary);
      const text = accepted.entries ? accepted.entries[item.key] : null;
      await saveAttempt(pool, {
        key: item.key,
        language: request.language,
        english: item.english,
        text,
        problem: accepted.problem || null,
        model: modelMark(sync.MODEL, item.contextVersion),
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
      group: message.group,
      label: message.label,
      description: message.description,
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
  translatePayload,
  translated,
  translatedReads,
  updateMessage,
};
