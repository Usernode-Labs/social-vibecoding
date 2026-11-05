'use strict';

// Translate: fills every other language of one email template or layout
// version from its English, with the model and glossary the interface's
// translation step uses (../language-sync.js), and lets an admin correct a
// language by hand.
//
// A translation is held to everything the English is (template-validation.js:
// placeholders, safe HTML, every part ending where the next can follow and
// closing what it opens, required values on every path, inside its layout in
// that language or the English one where that has none), and to the English
// itself: the same placeholders, the same conditions, the same tags and
// attributes and the same links. Words a reader sees in alt, title and
// aria-label may change. A language that fails is reported with the reason and
// not saved; the others still save.
//
// A job runs per version, one at a time: a second press while one runs gets
// the running one. Its progress is a row in email_translation_jobs, so it
// survives a reload, and a job whose process died stops counting as running
// after STALE_MS. Each run claims the row with its own `run_id` and writes only
// while the row still carries it, so a slow run whose job was taken over as
// stale stops instead of writing over the new one. It touches `updated_at`
// with every language, so only a run that has gone quiet looks stale. Languages go to the model a few at a time (CHUNK), one
// request each; a failed request fails only its languages. Spend counts
// against the system budget, as the interface's translation step does.
//
// An admin's own translation of a version is kept by a later press unless the
// press asks to overwrite it. A translation an edit elsewhere leaves broken (a
// layout saved since, a template it frames) is not deleted and does not block
// that edit: recheckTranslations marks it `unusable` with the reason, the
// sender uses English for that part, and the admin sees why. Marking rather
// than deleting keeps an admin's text for them to fix, and the next press or
// correction clears it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const log = require('../logger');
const llm = require('../llm');
const limits = require('../limits');
const sync = require('../language-sync');
const packs = require('../../../scripts/language-packs');
const store = require('./template-store');
const { actionFor } = require('./actions');
const { parse } = require('./template-language');
const { scanHtml, URL_ATTRIBUTES } = require('./html-safety');
const { validateTranslation, validateLayout } = require('./template-validation');

const TEMPLATE_FIELDS = ['subject', 'preheader', 'why', 'html', 'text'];
const LAYOUT_FIELDS = ['html', 'text'];
const HTML_FIELDS = new Set(['html', 'why', 'preheader']);
// Attributes whose value is words a reader sees, which a translation changes.
const WORDS_ATTRIBUTES = new Set(['alt', 'title', 'aria-label']);
const LABELS = { subject: 'subject', preheader: 'preview line', why: '"why you got this" line', html: 'HTML version', text: 'text version' };
// Languages asked of the model at once: each is its own request.
const CHUNK = 4;
const MAX_TOKENS = 16000;
// A running job not heard from in this long belongs to a process that stopped.
const STALE_MS = 15 * 60 * 1000;

function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

const fieldsOf = (kind) => (kind === 'layout' ? LAYOUT_FIELDS : TEMPLATE_FIELDS);
const pick = (row, fields) => Object.fromEntries(fields.map((field) => [field, row && typeof row[field] === 'string' ? row[field] : '']));

// ── Configuration ──────────────────────────────────────────────────────

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

function source() {
  try { return require('../language-cache').readSource(); } catch { return null; }
}

/** The configured languages, { code: name }, from the running build's catalogs or the checkout. */
function configuredLanguages() {
  const fromSource = source()?.files?.['config.json']?.languages;
  if (fromSource && typeof fromSource === 'object') return fromSource;
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'frontend', 'locales', 'config.json'), 'utf8')).languages || {};
  } catch {
    return { en: 'English' };
  }
}

/** The glossary the interface's translations use, read the way language-sync reads it. */
function glossary() {
  const given = source()?.files?.['glossary.json'];
  if (!given) return sync.readGlossary(REPO_ROOT);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-glossary-'));
  try {
    packs.materializeSource({ files: { 'glossary.json': given } }, root);
    return sync.readGlossary(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ── Comparing with the English ─────────────────────────────────────────

function tree(source) {
  try { return parse(source).nodes; } catch { return null; }
}

function namesIn(nodes, out = new Set()) {
  for (const n of nodes) {
    if (n.name) out.add(n.name);
    if (n.then) namesIn(n.then, out);
    if (n.else) namesIn(n.else, out);
  }
  return out;
}

// The conditions of a tree, nested as they are, with the values each level
// prints. Order within a level is left out: a sentence may move a value.
function shape(nodes) {
  const vars = [];
  const blocks = [];
  for (const n of nodes) {
    if (n.type === 'var') vars.push(n.name);
    else if (n.then) blocks.push(`${n.type}:${n.name}(${shape(n.then)}|${shape(n.else || [])})`);
  }
  return `[${vars.sort().join(',')}]{${blocks.sort().join(';')}}`;
}

const sortedEqual = (a, b) => a.length === b.length && [...a].sort().every((value, i) => value === [...b].sort()[i]);

// Each tag as it must stay: its name and every attribute with its value, but
// for the words a reader sees. And the addresses it follows.
function tagsOf(source) {
  const scan = scanHtml(source);
  if (!scan.ok) return null;
  const tags = [];
  const links = [];
  for (const tag of scan.tags) {
    const attributes = tag.attributes.map((a) => {
      if (URL_ATTRIBUTES.has(a.name)) links.push(a.value || '');
      return WORDS_ATTRIBUTES.has(a.name) ? a.name : `${a.name}=${a.value == null ? '' : a.value}`;
    }).sort();
    tags.push(`${tag.closing ? '/' : ''}${tag.name} ${attributes.join(' ')}`);
  }
  return { tags, links };
}

const URLS = /https?:\/\/[^\s<>"']+/g;

/** The first way `translated` departs from `english`, as { field, message }, or null. */
function difference(english, translated) {
  for (const field of TEMPLATE_FIELDS) {
    if (!Object.hasOwn(english, field)) continue;
    const label = LABELS[field];
    const was = typeof english[field] === 'string' ? english[field] : '';
    const now = translated && typeof translated[field] === 'string' ? translated[field] : '';
    const before = tree(was);
    if (!before) continue;
    const after = tree(now);
    if (!after) return { field, message: `The ${label} does not read as a template.` };
    const had = namesIn(before);
    const has = namesIn(after);
    const missing = [...had].filter((name) => !has.has(name));
    const added = [...has].filter((name) => !had.has(name));
    if (missing.length && added.length) {
      return { field, message: `The ${label} has ${added.map((n) => `{{${n}}}`).join(', ')} where the English has ${missing.map((n) => `{{${n}}}`).join(', ')}. Placeholders are never translated.` };
    }
    if (missing.length) return { field, message: `The ${label} must keep ${missing.map((n) => `{{${n}}}`).join(', ')} as the English has it.` };
    if (added.length) return { field, message: `The ${label} has ${added.map((n) => `{{${n}}}`).join(', ')}, which the English does not.` };
    if (shape(before) !== shape(after)) return { field, message: `The ${label} does not keep the English's conditions ({{#if}}, {{else}}) as they are.` };
    if (HTML_FIELDS.has(field)) {
      const a = tagsOf(was);
      const b = tagsOf(now);
      if (a && !b) return { field, message: `The ${label} does not read as HTML the way the English does.` };
      if (a) {
        if (!sortedEqual(a.links, b.links)) return { field, message: `The ${label} changes a link or image address the English has.` };
        if (!sortedEqual(a.tags, b.tags)) return { field, message: `The ${label} does not keep the English's tags and attributes exactly.` };
      }
    } else if (!sortedEqual(was.match(URLS) || [], now.match(URLS) || [])) {
      return { field, message: `The ${label} changes a link the English has.` };
    }
  }
  return null;
}

/** Why `translated` cannot stand for `english`, or null. */
function englishDifference(english, translated) {
  const found = difference(english, translated);
  return found ? found.message : null;
}

// ── Checks ─────────────────────────────────────────────────────────────

/** Problems with a template translation, [] when none. `layoutPart` is the layout it is sent in. */
function templateProblems(englishRow, fields, layoutPart) {
  const result = validateTranslation(englishRow.action, pick(fields, TEMPLATE_FIELDS), layoutPart);
  if (!result.ok) return result.errors;
  const found = difference(pick(englishRow, TEMPLATE_FIELDS), fields);
  return found ? [found] : [];
}

/** Problems with a layout translation, [] when none: it must frame every English template it frames. */
function layoutProblems(englishRow, fields, templates) {
  const result = validateLayout(pick(fields, LAYOUT_FIELDS), templates);
  if (!result.ok) return result.errors;
  const found = difference(pick(englishRow, LAYOUT_FIELDS), fields);
  return found ? [found] : [];
}

const invalid = (errors) => fail('invalid', 'This translation cannot be saved', { errors });
const layoutPartOf = (translation, layout) => (translation ? { html: translation.html, text: translation.text } : layout ? { html: layout.html, text: layout.text } : null);

/**
 * Marks the translations a change leaves broken, inside the change's
 * transaction (`client`), and returns them: [{ templateId, action, locale,
 * reason }] and [{ layoutId, locale, reason }]. `templates` are the English
 * template rows the change concerns (an unsaved one with no id), `layout` the
 * English layout they are sent in ({ id?, html, text }, or null). With an id,
 * the layout's own translations are checked against those templates first.
 * `layoutTranslations` ({ locale: { html, text } }) stands in for stored ones,
 * for a layout translation being saved; `locale` narrows the check to one.
 */
async function recheckTranslations(client, { templates = [], layout = null, layoutTranslations = {}, locale = null } = {}) {
  const marked = [];
  const usable = { ...layoutTranslations };
  if (layout && layout.id != null) {
    const { rows } = locale
      ? await client.query('SELECT * FROM email_layout_translations WHERE layout_id = $1 AND locale = $2 AND unusable IS NULL', [layout.id, locale])
      : await client.query('SELECT * FROM email_layout_translations WHERE layout_id = $1 AND unusable IS NULL', [layout.id]);
    for (const translation of rows) {
      if (Object.hasOwn(usable, translation.locale)) continue;
      const result = templates.length ? validateLayout(pick(translation, LAYOUT_FIELDS), templates) : { ok: true };
      if (result.ok) {
        usable[translation.locale] = translation;
        continue;
      }
      const reason = result.errors[0].message;
      await client.query('UPDATE email_layout_translations SET unusable = $3 WHERE layout_id = $1 AND locale = $2', [layout.id, translation.locale, reason]);
      marked.push({ layoutId: layout.id, locale: translation.locale, reason });
    }
  }
  const ids = templates.map((row) => row.id).filter((id) => id != null);
  if (ids.length) {
    const { rows } = locale
      ? await client.query('SELECT * FROM email_template_translations WHERE template_id = ANY($1::int[]) AND locale = $2 AND unusable IS NULL ORDER BY template_id, locale', [ids, locale])
      : await client.query('SELECT * FROM email_template_translations WHERE template_id = ANY($1::int[]) AND unusable IS NULL ORDER BY template_id, locale', [ids]);
    const byId = new Map(templates.map((row) => [row.id, row]));
    for (const translation of rows) {
      const english = byId.get(translation.template_id);
      const action = actionFor(english.action);
      if (!action || action.englishOnly) continue;
      const problems = templateProblems(english, translation, layoutPartOf(usable[translation.locale], layout));
      if (!problems.length) continue;
      const reason = problems[0].message;
      await client.query('UPDATE email_template_translations SET unusable = $3 WHERE template_id = $1 AND locale = $2', [translation.template_id, translation.locale, reason]);
      marked.push({ templateId: translation.template_id, action: english.action, locale: translation.locale, reason });
    }
  }
  if (marked.length) log.warn('email-templates', 'Translations marked unusable after a change', { count: marked.length, marked: marked.slice(0, 20) });
  return marked;
}

// The version and why it cannot be translated, if it cannot.
async function versionFor(pool, kind, id) {
  if (kind !== 'template' && kind !== 'layout') throw fail('not_found', 'Unknown kind');
  const { rows: [row] } = kind === 'template'
    ? await pool.query('SELECT * FROM email_templates WHERE id = $1 AND deleted_at IS NULL', [id])
    : await pool.query('SELECT * FROM email_layouts WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!row) throw fail('not_found', kind === 'template' ? 'That template does not exist' : 'That layout version does not exist');
  if (kind === 'template') {
    const action = actionFor(row.action);
    if (!action) throw fail('not_found', 'That template does not exist');
    if (action.englishOnly) throw fail('english_only', 'This email is only ever sent in English, so it has no translations');
  }
  return row;
}

/**
 * Saves one language after the checks: `origin` 'admin' for a correction,
 * 'machine' for Translate (which leaves an admin's alone unless `overwrite`).
 * Returns { translation, unusableTranslations }; translation is null when an
 * admin's was kept. Throws `invalid` with errors.
 */
async function saveChecked(pool, kind, id, locale, fields, origin, { overwrite = true } = {}) {
  let unusableTranslations = [];
  const keepAdmin = origin === 'machine' && !overwrite;
  const translation = await store.saveCheckedTranslation(pool, kind, id, locale, pick(fields, fieldsOf(kind)), origin, {
    keepAdmin,
    check: async ({ client, row, layout, layoutTranslation, templates }) => {
      if (kind === 'template') {
        const problems = templateProblems(row, fields, layoutPartOf(layoutTranslation, layout));
        if (problems.length) throw invalid(problems);
        return;
      }
      const problems = layoutProblems(row, fields, templates);
      if (problems.length) throw invalid(problems);
      unusableTranslations = await recheckTranslations(client, {
        templates, layout: row, layoutTranslations: { [locale]: pick(fields, LAYOUT_FIELDS) }, locale,
      });
    },
  });
  return { translation, unusableTranslations };
}

/** An admin's correction of one language. */
async function saveCorrection(pool, kind, id, locale, fields, { deps = {} } = {}) {
  const languages = deps.languages || configuredLanguages();
  if (typeof locale !== 'string' || locale === 'en' || !Object.hasOwn(languages, locale)) {
    throw invalid([{ field: 'locale', message: 'Choose one of the configured languages other than English.' }]);
  }
  await versionFor(pool, kind, id);
  return saveChecked(pool, kind, id, locale, fields || {}, 'admin');
}

// ── The job ────────────────────────────────────────────────────────────

const EMAIL_RULES = [
  'This request is not interface text: it is one email (or the layout every email is framed in), given as JSON with one key per part. "html" and the other HTML parts are HTML, "text" is the plain-text version of the same email, "subject" is its subject line. These rules come first where they differ from the ones above:',
  '- Keep every {{…}} and every HTML tag and attribute exactly; translate only text. {{name}}, {{#if name}}, {{#unless name}}, {{else}} and {{/if}} are placeholders and conditions, not words: never translate, add, remove or move them out of the condition they sit in.',
  '- The words in alt, title and aria-label attributes are text a reader sees: translate those. Every other attribute and its value, every link and image address, stays character for character.',
  '- Keep the text version\'s line breaks and links as they are.',
  '- A part that is empty in the English stays empty.',
].join('\n');

function requestFor(kind, id, language, languageName, parts, words) {
  const system = sync.systemPrompt(language, languageName, words).split('\n\n')
    .filter((part) => !part.startsWith('Answer with JSON only'));
  const keys = Object.keys(parts);
  system.push(EMAIL_RULES);
  system.push(`Answer with JSON only: {${keys.map((key) => `"${key}": "..."`).join(', ')}}, each part translated.`);
  return {
    customId: `${kind}-${id}-${language}`,
    language,
    params: {
      model: sync.MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: system.join('\n\n'), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify({ parts }) }],
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: { type: 'object', properties: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])), required: keys, additionalProperties: false },
        },
      },
    },
  };
}

// The parts in a model answer, or null.
function answerParts(answer, keys) {
  if (!answer || typeof answer.text !== 'string') return null;
  const match = answer.text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  return keys.every((key) => typeof parsed[key] === 'string') ? pick(parsed, keys) : null;
}

const jobFrom = (row) => ({
  state: row.state === 'running' && Date.now() - new Date(row.updated_at).getTime() > STALE_MS ? 'stopped' : row.state,
  perLanguage: row.per_language || {},
  overwrite: row.overwrite,
  startedAt: row.started_at,
  updatedAt: row.updated_at,
});

// A run was taken over (its job looked stale and was claimed again): it stops.
class Superseded extends Error {}

// Records outcomes and touches the job, only while this run still owns it.
async function setLanguages(pool, kind, id, runId, updates) {
  const { rowCount } = await pool.query(
    `UPDATE email_translation_jobs SET per_language = per_language || $4::jsonb, updated_at = NOW()
     WHERE kind = $1 AND version_id = $2 AND run_id = $3`,
    [kind, id, runId, JSON.stringify(updates)]);
  if (!rowCount) throw new Superseded('This Translate run was taken over by a newer one');
}

async function run(pool, kind, id, runId, english, todo, { overwrite, deps }) {
  const model = deps.llm || llm;
  const budget = deps.limits || limits;
  const languages = deps.languages || configuredLanguages();
  const words = deps.glossary || glossary();
  const keys = fieldsOf(kind);
  const parts = pick(english, keys);
  // Each language's outcome is recorded as soon as it is known.
  const record = (language, state) => setLanguages(pool, kind, id, runId, { [language]: state });
  for (let start = 0; start < todo.length; start += CHUNK) {
    const chunk = todo.slice(start, start + CHUNK);
    const requests = chunk.map((language) => requestFor(kind, id, language, languages[language] || language, parts, words));
    let answers;
    try {
      answers = await model.translateCatalogDirect(requests);
    } catch (err) {
      for (const language of chunk) await record(language, `failed: the model did not answer (${(err && err.message) || 'request failed'})`);
      continue;
    }
    let cents = 0;
    for (const answer of answers.values()) if (answer && answer.usage) cents += llm.estimateCostCents(answer.usage, sync.MODEL);
    await budget.recordSystemSpend(pool, cents);
    for (const request of requests) {
      const { language } = request;
      const answer = answers.get(request.customId);
      if (!answer || answer.error) {
        await record(language, `failed: the model did not answer (${(answer && answer.error) || 'no answer'})`);
        continue;
      }
      const fields = answerParts(answer, keys);
      if (!fields) {
        await record(language, 'failed: the answer was not a translation of every part');
        continue;
      }
      // Still this run's job, or nothing is saved.
      await setLanguages(pool, kind, id, runId, {});
      let state;
      try {
        const { translation } = await saveChecked(pool, kind, id, language, fields, 'machine', { overwrite });
        state = translation ? 'saved' : 'skipped: admin';
      } catch (err) {
        if (err && err.code === 'invalid') state = `failed: ${err.errors[0].message}`;
        else if (err && (err.code === 'not_found' || err.code === 'retry' || err.code === 'conflict')) state = `failed: ${err.message}`;
        else {
          log.error('email-templates', 'A translation could not be saved', { kind, id, language, message: err && err.message });
          state = 'failed: it could not be saved; the server logged why';
        }
      }
      await record(language, state);
    }
  }
}

/**
 * Starts Translate for one version unless a job for it runs: { started, job,
 * done }, where `done` resolves when this job has finished (at once when it was
 * not started here) and never rejects. `languages` narrows it to some locales.
 */
async function startTranslation(pool, kind, id, { overwrite = false, languages: only = null, userId = null, deps = {} } = {}) {
  const english = await versionFor(pool, kind, id);
  const model = deps.llm || llm;
  if (!model.isEnabled()) throw fail('no_model', 'Translation is not available: no model is configured');
  const check = await (deps.limits || limits).checkSystemBudget(pool);
  if (check && check.error) throw fail('budget', check.error);
  const configured = deps.languages || configuredLanguages();
  const locales = Object.keys(configured).filter((code) => code !== 'en' && (!only || only.includes(code)));
  const { rows: admins } = kind === 'template'
    ? await pool.query("SELECT locale FROM email_template_translations WHERE template_id = $1 AND origin = 'admin'", [id])
    : await pool.query("SELECT locale FROM email_layout_translations WHERE layout_id = $1 AND origin = 'admin'", [id]);
  const kept = new Set(overwrite ? [] : admins.map((row) => row.locale));
  const perLanguage = Object.fromEntries(locales.map((code) => [code, kept.has(code) ? 'skipped: admin' : 'pending']));
  const runId = crypto.randomUUID();
  const { rows: [claimed] } = await pool.query(
    `INSERT INTO email_translation_jobs (kind, version_id, state, per_language, overwrite, started_by, run_id)
     VALUES ($1, $2, 'running', $3::jsonb, $4, $5, $7)
     ON CONFLICT (kind, version_id) DO UPDATE SET state = 'running', per_language = EXCLUDED.per_language,
       overwrite = EXCLUDED.overwrite, started_by = EXCLUDED.started_by, run_id = EXCLUDED.run_id, started_at = NOW(), updated_at = NOW()
     WHERE email_translation_jobs.state <> 'running' OR email_translation_jobs.updated_at < NOW() - make_interval(secs => $6)
     RETURNING *`,
    [kind, id, JSON.stringify(perLanguage), !!overwrite, userId, STALE_MS / 1000, runId]);
  if (!claimed) {
    const { rows: [running] } = await pool.query('SELECT * FROM email_translation_jobs WHERE kind = $1 AND version_id = $2', [kind, id]);
    return { started: false, job: jobFrom(running), done: Promise.resolve() };
  }
  const todo = locales.filter((code) => perLanguage[code] === 'pending');
  const done = run(pool, kind, id, runId, english, todo, { overwrite, deps })
    .catch(async (err) => {
      // A newer run owns the job now and reports it; this one only stops.
      if (err instanceof Superseded) {
        log.warn('email-templates', 'A Translate run stopped: a newer run took its job over', { kind, id });
        return;
      }
      log.error('email-templates', 'Translate stopped', { kind, id, message: err && err.message });
      const { rows: [now] } = await pool.query('SELECT per_language FROM email_translation_jobs WHERE kind = $1 AND version_id = $2 AND run_id = $3', [kind, id, runId]);
      const left = Object.entries((now && now.per_language) || {}).filter(([, state]) => state === 'pending');
      if (left.length) await setLanguages(pool, kind, id, runId, Object.fromEntries(left.map(([code]) => [code, 'failed: Translate stopped; the server logged why'])));
    })
    .then(() => pool.query("UPDATE email_translation_jobs SET state = 'done', updated_at = NOW() WHERE kind = $1 AND version_id = $2 AND run_id = $3", [kind, id, runId]))
    .catch((err) => {
      if (!(err instanceof Superseded)) log.error('email-templates', 'Could not record the end of Translate', { kind, id, message: err && err.message });
    });
  return { started: true, job: jobFrom(claimed), done };
}

/** Runs Translate for one version to the end: { started, perLanguage }. */
async function translateVersion(pool, kind, id, options = {}) {
  const { started, done } = await startTranslation(pool, kind, id, options);
  await done;
  const status = await jobStatus(pool, kind, id);
  return { started, perLanguage: status.perLanguage };
}

/**
 * Where Translate stands for a version: { state: 'none'|'running'|'done'|
 * 'stopped', perLanguage, unusable: { locale: reason } }.
 */
async function jobStatus(pool, kind, id) {
  const { rows: [row] } = await pool.query('SELECT * FROM email_translation_jobs WHERE kind = $1 AND version_id = $2', [kind, id]);
  const { rows: marks } = kind === 'template'
    ? await pool.query('SELECT locale, unusable FROM email_template_translations WHERE template_id = $1 AND unusable IS NOT NULL', [id])
    : await pool.query('SELECT locale, unusable FROM email_layout_translations WHERE layout_id = $1 AND unusable IS NOT NULL', [id]);
  const unusable = Object.fromEntries(marks.map((mark) => [mark.locale, mark.unusable]));
  return row ? { ...jobFrom(row), unusable } : { state: 'none', perLanguage: {}, unusable };
}

/** Every translation of a version, by locale. */
async function translationsOf(pool, kind, id) {
  await versionFor(pool, kind, id).catch((err) => {
    if (err.code !== 'english_only') throw err;
  });
  const { rows } = kind === 'template'
    ? await pool.query('SELECT * FROM email_template_translations WHERE template_id = $1 ORDER BY locale', [id])
    : await pool.query('SELECT * FROM email_layout_translations WHERE layout_id = $1 ORDER BY locale', [id]);
  return Object.fromEntries(rows.map((row) => [row.locale, row]));
}

module.exports = {
  CHUNK,
  STALE_MS,
  englishDifference,
  recheckTranslations,
  saveCorrection,
  startTranslation,
  translateVersion,
  jobStatus,
  translationsOf,
  configuredLanguages,
};
