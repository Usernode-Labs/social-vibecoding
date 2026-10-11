'use strict';

// The translation step (services/language-sync.js) and Homeroom's sweep that
// runs it (services/language-sync-runner.js), against a fake model and a fake
// GitHub. frontend/locales/README.md, "Translations", is the contract.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sync = require('../src/services/language-sync');
const runner = require('../src/services/language-sync-runner');
const { buildLanguagePacks, hash } = require('../scripts/language-packs');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const says = (text, description = 'Fixture message.') => ({ text, description });
const from = (english, text, extra = {}) => ({ text, source: hash(english), ...extra });

const ENGLISH = {
  'greeting.hello': says('Hello {{name}}', 'Heading on the home screen. {{name}} is the reader\'s username.'),
  'button.leave': says('Leave', 'Button on a community\'s menu: the reader stops being a member.'),
  'terms.read': says('Read <0>the terms</0> of Homeroom.', 'Sentence on the sign-up screen; <0> is a link.'),
  'items_one': says('{{count}} item', 'Count of items in a list.'),
  'items_other': says('{{count}} items', 'Count of items in a list.'),
};

function checkout(t, { languages = { en: 'English', es: 'Español' }, english = ENGLISH, translations = {}, glossary = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'language-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, data) => {
    const target = path.join(root, 'frontend/locales', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  };
  put('config.json', { sourceLanguage: 'en', minimumCoverage: 0.95, languages });
  put('glossary.json', glossary || {
    doNotTranslate: ['Homeroom'],
    terms: { community: { meaning: 'What a person joins.', es: 'comunidad' } },
    style: { es: 'Address the reader as "tú".' },
  });
  put('en/core.json', english);
  for (const [language, catalog] of Object.entries(translations)) put(`${language}/core.json`, catalog);
  return { root, put, readLanguage: (language) => JSON.parse(fs.readFileSync(path.join(root, 'frontend/locales', language, 'core.json'), 'utf8')) };
}

/** A model that answers every message in its request with `answer(item)`. */
function fakeModel(answer) {
  const calls = [];
  const translate = async (requests) => {
    calls.push(requests);
    const answers = new Map();
    for (const request of requests) {
      const translations = request.items.map((item) => ({ id: item.id, ...answer(item, request, calls.length) }));
      answers.set(request.customId, { text: JSON.stringify({ translations }), usage: { input_tokens: 1000, output_tokens: 100 } });
    }
    return answers;
  };
  return { calls, translate };
}

const SPANISH = {
  'core:greeting.hello': { text: 'Hola {{name}}' },
  'core:button.leave': { text: 'Salir' },
  'core:terms.read': { text: 'Lee <0>los términos</0> de Homeroom.' },
  'core:items': { forms: { one: '{{count}} elemento', many: '{{count}} de elementos', other: '{{count}} elementos' } },
};

test('a language is asked for what it is missing, what is out of date, and every form of a count', (t) => {
  const { root } = checkout(t, {
    translations: {
      es: {
        'greeting.hello': from('Hello {{name}}', 'Hola {{name}}'),
        // Translated from English that has since changed.
        'button.leave': from('Exit', 'Salir'),
        'items_one': from('{{count}} item', '{{count}} elemento'),
        'items_other': from('{{count}} items', '{{count}} elementos'),
      },
    },
  });
  const items = sync.planLanguage(root, 'es');
  assert.deepEqual(items.map((item) => item.id).sort(), ['core:button.leave', 'core:items', 'core:terms.read']);
  const plural = items.find((item) => item.kind === 'plural');
  assert.deepEqual(Object.keys(plural.forms).sort(), ['many', 'one', 'other'], 'Spanish counts in three forms; the missing `many` asks for the set');
  assert.deepEqual(plural.english, { one: '{{count}} item', other: '{{count}} items' });
  assert.match(items.find((item) => item.id === 'core:button.leave').description, /stops being a member/, 'each message travels with its description');
  // A proposal's own messages only.
  assert.deepEqual(sync.planLanguage(root, 'es', { onlyIds: new Set(['core:terms.read']) }).map((item) => item.id), ['core:terms.read']);
});

test('a person\'s correction is left alone until the English it corrects changes', (t) => {
  const { root } = checkout(t, {
    translations: {
      es: {
        'greeting.hello': from('Hello {{name}}', '¡Hola, {{name}}!', { locked: true }),
        'button.leave': from('Exit', 'Salir', { locked: true }),
      },
    },
  });
  const ids = sync.planLanguage(root, 'es').map((item) => item.id);
  assert.ok(!ids.includes('core:greeting.hello'), 'locked and current: kept');
  assert.ok(ids.includes('core:button.leave'), 'locked but stale: the English moved on');
});

test('a sync writes what passes the checks, with the digest of its English, and the build then ships the language', async (t) => {
  const { root, readLanguage } = checkout(t);
  const model = fakeModel((item) => SPANISH[item.id]);
  const summary = await sync.syncTranslations({ root, translate: model.translate });
  assert.deepEqual(summary.languages.es, { requested: 4, written: 4, failed: [] });
  assert.deepEqual(summary.files, [path.join('frontend', 'locales', 'es', 'core.json')]);
  const written = readLanguage('es');
  assert.deepEqual(written['greeting.hello'], { text: 'Hola {{name}}', source: hash('Hello {{name}}') });
  assert.deepEqual(written.items_many, { text: '{{count}} de elementos', source: hash('{{count}} items') }, 'a form English lacks is translated from its `other`');
  assert.deepEqual(Object.keys(written).slice(0, 3), ['greeting.hello', 'button.leave', 'terms.read'], 'in the English order');
  assert.deepEqual(Object.keys(written).slice(3).sort(), ['items_many', 'items_one', 'items_other'], 'then each count, every form');
  const { report, languages } = buildLanguagePacks(root);
  assert.equal(report.es.translated, report.es.total);
  assert.deepEqual(languages, { en: 'English', es: 'Español' }, 'covered, so offered');
  // Nothing left to do: a second pass sends nothing.
  const again = fakeModel(() => assert.fail('nothing should be asked'));
  assert.equal((await sync.syncTranslations({ root, translate: again.translate })).files.length, 0);
});

test('an answer that fails a check is asked again on its own once, and stays English if it fails twice', async (t) => {
  const { root, readLanguage } = checkout(t);
  const model = fakeModel((item, request, call) => {
    if (item.id === 'core:greeting.hello') return call === 1 ? { text: 'Hola {{nombre}}' } : SPANISH[item.id];
    if (item.id === 'core:button.leave') return { text: 'Salir — ahora' };
    return SPANISH[item.id];
  });
  const summary = await sync.syncTranslations({ root, translate: model.translate });
  assert.equal(model.calls.length, 2);
  assert.deepEqual(model.calls[1].map((request) => request.items.map((item) => item.id)), [['core:greeting.hello'], ['core:button.leave']], 'one message per retry');
  assert.equal(summary.languages.es.written, 3);
  assert.deepEqual(summary.languages.es.failed, [{ id: 'core:button.leave', problem: 'an em dash' }]);
  assert.equal(readLanguage('es')['button.leave'], undefined, 'left out, so it shows in English');
  assert.equal(readLanguage('es')['greeting.hello'].text, 'Hola {{name}}');
});

test('a round that failed wholesale is not retried one message at a time', async (t) => {
  const { root } = checkout(t);
  const model = fakeModel(() => ({ text: '' }));
  const summary = await sync.syncTranslations({ root, translate: model.translate, maxRetries: 2 });
  assert.equal(model.calls.length, 1, 'no second round');
  assert.equal(summary.languages.es.written, 0);
  assert.equal(summary.languages.es.failed.length, 4);
  assert.ok(summary.languages.es.failed.every((f) => f.problem === 'not retried'));
});

// What structured outputs accept in a schema, from Anthropic's documentation
// ("JSON Schema limitations": https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
// Everything else there is listed as not supported and answers 400; in a
// Message Batch that 400 arrives on every request, after the batch has ended.
const SCHEMA_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'anyOf', 'allOf', '$ref', '$defs', 'definitions', 'default', 'format', 'minItems', 'description', 'title',
]);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
const STRING_FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);

/** Every way `schema` breaks those rules, as "path: problem" lines, plus the counts the API limits. */
function schemaProblems(schema) {
  const problems = [];
  const counts = { optional: 0, unions: 0 };
  const walk = (node, at) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) { problems.push(`${at}: not a schema object`); return; }
    for (const keyword of Object.keys(node)) {
      if (!SCHEMA_KEYWORDS.has(keyword)) problems.push(`${at}: "${keyword}" is not supported`);
    }
    const types = node.type === undefined ? [] : [].concat(node.type);
    for (const type of types) if (!SCHEMA_TYPES.has(type)) problems.push(`${at}: type "${type}"`);
    if (Array.isArray(node.type) || node.anyOf) counts.unions += 1;
    if (typeof node.$ref === 'string' && !node.$ref.startsWith('#')) problems.push(`${at}: an external $ref`);
    if (node.format !== undefined && !STRING_FORMATS.has(node.format)) problems.push(`${at}: format "${node.format}"`);
    if (node.minItems !== undefined && node.minItems !== 0 && node.minItems !== 1) problems.push(`${at}: minItems ${node.minItems}`);
    if (node.enum && !node.enum.every((value) => value === null || ['string', 'number', 'boolean'].includes(typeof value))) {
      problems.push(`${at}: a complex value in enum`);
    }
    if (types.includes('object') || node.properties !== undefined) {
      if (node.additionalProperties !== false) problems.push(`${at}: an object without additionalProperties: false`);
      const properties = node.properties || {};
      const required = node.required || [];
      for (const name of required) if (!(name in properties)) problems.push(`${at}: requires "${name}", which it does not define`);
      for (const [name, child] of Object.entries(properties)) {
        if (!required.includes(name)) counts.optional += 1;
        walk(child, `${at}.${name}`);
      }
    }
    if (node.items !== undefined) walk(node.items, `${at}[]`);
    for (const keyword of ['anyOf', 'allOf']) (node[keyword] || []).forEach((child, index) => walk(child, `${at}.${keyword}[${index}]`));
    for (const keyword of ['$defs', 'definitions']) {
      for (const [name, child] of Object.entries(node[keyword] || {})) walk(child, `${at}.${keyword}.${name}`);
    }
  };
  walk(schema, '$');
  return { problems, counts };
}

test('the answer schema is one structured outputs accept: every object closed, no unsupported keyword', () => {
  const { problems, counts } = schemaProblems(sync.RESPONSE_SCHEMA);
  assert.deepEqual(problems, []);
  // The API's limits across a request's schemas: 24 optional properties, 16 with a union type.
  assert.ok(counts.optional <= 24, `${counts.optional} optional properties`);
  assert.ok(counts.unions <= 16);
  // The walk itself refuses what the step shipped with: an object with open keys.
  const open = { type: 'object', properties: { forms: { type: 'object', additionalProperties: { type: 'string' } } }, required: [], additionalProperties: false };
  assert.deepEqual(schemaProblems(open).problems, ['$.forms: an object without additionalProperties: false']);
  assert.match(schemaProblems({ type: 'string', maxLength: 5 }).problems[0], /"maxLength" is not supported/);
  assert.match(schemaProblems({ type: 'array', items: { type: 'object', properties: {} } }).problems[0], /\$\[\]: an object without/);
  // Every plural category a language can use is a form the schema names, and no other.
  const forms = sync.RESPONSE_SCHEMA.properties.translations.items.properties.forms;
  assert.deepEqual(Object.keys(forms.properties), ['zero', 'one', 'two', 'few', 'many', 'other']);
  for (const language of ['ar', 'cy', 'ru', 'pl', 'ja', 'es', 'fr', 'pt-BR', 'id', 'vi']) {
    for (const category of new Intl.PluralRules(language).resolvedOptions().pluralCategories) {
      assert.ok(category in forms.properties, `${language}: ${category}`);
    }
  }
  // Every request is built from that schema, and the shape the runner remembers follows it.
  assert.equal(sync.REQUEST_OPTIONS.output_config.format.schema, sync.RESPONSE_SCHEMA);
  assert.match(sync.requestShape(), /^[0-9a-f]{16}$/);
});

test('a counted message\'s forms come back through the schema\'s shape, in every category the language uses', async (t) => {
  const english = {
    'files_one': says('{{count}} file', 'Count of files.'),
    'files_other': says('{{count}} files', 'Count of files.'),
  };
  const ARABIC = { zero: 'لا ملفات {{count}}', one: 'ملف {{count}}', two: 'ملفان {{count}}', few: '{{count}} ملفات', many: '{{count}} ملفًا', other: '{{count}} ملف' };
  const { root, readLanguage } = checkout(t, { languages: { en: 'English', ar: 'العربية' }, english, glossary: { doNotTranslate: [], terms: {}, style: {} } });
  const [request] = sync.prepareSync(root).requests;
  assert.deepEqual([...JSON.parse(request.params.messages[0].content).messages[0].categories].sort(), Object.keys(ARABIC).sort(), 'the request names the categories');
  assert.match(request.params.system[0].text, /A counted message has "forms" and no "text", with exactly the categories it lists\./);
  // A form the language uses but the answer lacks is still refused.
  const glossary = sync.readGlossary(root);
  const [plural] = sync.planLanguage(root, 'ar');
  const { few, ...short } = ARABIC;
  assert.deepEqual(sync.acceptItem(plural, { id: plural.id, forms: short }, glossary), { problem: 'few: empty' });
  assert.deepEqual(sync.acceptItem(plural, { id: plural.id, text: 'ملفات' }, glossary), { problem: 'no plural forms' });
  // An answer exactly as the schema lets the model write it.
  const answerText = JSON.stringify({ translations: [{ id: 'core:files', forms: ARABIC }] });
  const answer = JSON.parse(answerText).translations[0];
  const item = sync.RESPONSE_SCHEMA.properties.translations.items;
  assert.deepEqual(Object.keys(answer).filter((key) => !(key in item.properties)), []);
  assert.deepEqual(Object.keys(answer.forms).filter((key) => !(key in item.properties.forms.properties)), []);
  const summary = await sync.syncTranslations({ root, translate: async (requests) => new Map(requests.map((r) => [r.customId, { text: answerText }])) });
  assert.deepEqual(summary.languages.ar, { requested: 1, written: 1, failed: [] });
  const written = readLanguage('ar');
  for (const [category, text] of Object.entries(ARABIC)) assert.equal(written[`files_${category}`].text, text, category);
});

test('a round in which every request failed is counted by reason and asked nothing more', async (t) => {
  const { root } = checkout(t);
  const calls = [];
  const refused = { kind: 'errored', type: 'invalid_request_error', message: 'output_config.format.schema: additionalProperties must be false' };
  const summary = await sync.syncTranslations({
    root,
    translate: async (requests) => { calls.push(requests); return new Map(requests.map((r) => [r.customId, { error: 'errored', failure: refused }])); },
  });
  assert.equal(calls.length, 1, 'no retry, though maxRetries allows any number');
  assert.equal(summary.nothingAnswered, true);
  assert.equal(summary.unanswered, 4);
  assert.deepEqual(summary.requests, {
    sent: 1, failed: 1, reasons: { 'errored: invalid_request_error': 1 }, example: refused.message,
  });
  assert.equal(summary.languages.es.failed.length, 4);
  assert.ok(summary.languages.es.failed.every((f) => f.problem === 'errored: invalid_request_error'));
  assert.deepEqual(summary.files, []);

  // One request of two fails while the other is answered: that is not the
  // request's shape, so the failed one's messages are asked again one by one.
  const partial = [];
  const model = fakeModel((item) => SPANISH[item.id]);
  const mixed = await sync.syncTranslations({
    root,
    chunkSize: 2,
    translate: async (requests, { round }) => {
      partial.push(requests.map((request) => request.items.length));
      const answers = await model.translate(requests);
      if (round === 0) answers.set(requests[0].customId, { error: 'expired', failure: { kind: 'expired' } });
      return answers;
    },
  });
  assert.deepEqual(partial, [[2, 2], [1, 1]]);
  assert.equal(mixed.nothingAnswered, false);
  assert.deepEqual(mixed.requests, { sent: 4, failed: 1, reasons: { expired: 1 }, example: null });
  assert.equal(mixed.languages.es.written, 4);
  assert.equal(mixed.unanswered, 0);
  // It fails again on its own: those messages end the sync unanswered.
  const twice = await sync.syncTranslations({
    root: checkout(t).root,
    chunkSize: 2,
    translate: async (requests, { round }) => {
      const answers = await model.translate(requests);
      for (const request of requests) {
        if (round === 1 || request === requests[0]) answers.set(request.customId, { error: 'expired', failure: { kind: 'expired' } });
      }
      return answers;
    },
  });
  assert.equal(twice.languages.es.written, 2);
  assert.equal(twice.unanswered, 2);
  assert.deepEqual(twice.languages.es.failed.map((f) => f.problem), ['expired', 'expired']);
  assert.deepEqual(twice.requests.reasons, { expired: 3 });
  // A request the transport lost altogether counts as failed too.
  const lost = await sync.syncTranslations({ root: checkout(t).root, languages: ['es'], translate: async () => new Map() });
  assert.equal(lost.nothingAnswered, true);
  assert.deepEqual(lost.requests.reasons, { 'no answer': 1 });
});

test('what the checks refuse', () => {
  const ok = (english, text, options) => assert.equal(sync.textProblem(english, text, options), null, text);
  const refuses = (english, text, pattern, options) => assert.match(String(sync.textProblem(english, text, options)), pattern, text);
  ok('Hello {{name}}', 'Hola {{name}}');
  refuses('Hello {{name}}', 'Hola {{nombre}}', /parameters or tags/);
  refuses('Hello {{name}}', ' Hola {{name}}', /space at an edge/);
  refuses('Read <0>this</0>', 'Lee <b>esto</b>', /parameters or tags/);
  refuses('One\nTwo', 'Uno Dos', /line breaks/);
  refuses('Saved', 'Guardado — listo', /em dash/);
  refuses('Join Homeroom', 'Únete a Hogar', /"Homeroom" is not written as it is/, { doNotTranslate: ['Homeroom'] });
  refuses('Hi', 'x'.repeat(60), /far longer/);
  refuses('Hi', '', /empty/);
  ok('{{count}} hours ago', 'il y a une heure', { counted: true });
});

test('a request carries the language, its style, its terms and the names to keep, and caches its system prompt', (t) => {
  const { root } = checkout(t, { languages: { en: 'English', 'pt-BR': 'Português (Brasil)' } });
  const glossary = sync.readGlossary(root);
  const items = sync.planLanguage(root, 'pt-BR');
  const requests = sync.buildRequests('pt-BR', 'Português (Brasil)', items, glossary, { chunkSize: 2 });
  assert.equal(requests.length, 2, 'four messages, two a request');
  const [first] = requests;
  assert.equal(first.params.model, sync.MODEL);
  assert.equal(sync.MODEL, 'claude-sonnet-5-5');
  assert.deepEqual(first.params.system[0].cache_control, { type: 'ephemeral' });
  assert.match(first.params.system[0].text, /into Brazilian Portuguese \(pt-BR/);
  assert.match(first.params.system[0].text, /Never translate these names; write them exactly as they are: Homeroom\./);
  assert.equal(first.params.output_config.format.type, 'json_schema');
  const sent = JSON.parse(first.params.messages[0].content);
  assert.deepEqual(Object.keys(sent.messages[0]).sort(), ['description', 'english', 'id']);
  // The shipped glossary names each of Homeroom's terms in every configured language.
  const shipped = JSON.parse(read('frontend/locales/glossary.json'));
  const configured = Object.keys(JSON.parse(read('frontend/locales/config.json')).languages).filter((tag) => tag !== 'en');
  for (const [term, entry] of Object.entries(shipped.terms)) {
    for (const language of configured) assert.equal(typeof entry[language], 'string', `${term} in ${language}`);
  }
  for (const language of configured) assert.equal(typeof shipped.style[language], 'string', `a style note for ${language}`);
});

test('a change\'s own messages are the ones whose English it added or reworded', () => {
  const before = { core: { a: says('A'), b: says('B'), n_one: says('{{count}} n'), n_other: says('{{count}} ns') } };
  const after = { core: { a: says('A'), b: says('B, reworded'), c: says('C'), n_one: says('{{count}} n'), n_other: says('{{count}} things') } };
  const ids = sync.changedEnglishIds(before, after);
  assert.ok(ids.has('core:b') && ids.has('core:c') && ids.has('core:n'));
  assert.ok(!ids.has('core:a'));
});

test('no build calls a model: the builder and the shell build never load the translation step', () => {
  for (const file of ['scripts/language-packs.js', 'frontend/scripts/build-shell.mjs', 'scripts/ensure-shell-artifacts.js']) {
    assert.doesNotMatch(read(file), /language-sync|services\/llm/, file);
  }
});

// ── The sweep ──────────────────────────────────────────────────────────

function platform(t, { translations = {}, english = ENGLISH, state = null, sessions = {} } = {}) {
  const repo = checkout(t, { translations, english });
  const db = { state, sessions: { ...sessions }, inserted: [], spend: 0 };
  const logged = [];
  const clock = { now: Date.parse('2026-10-11T12:00:00Z') };
  const pool = {
    async query(sql, params = []) {
      const text = String(sql);
      if (/FROM apps WHERE self_hosted/.test(text)) {
        return { rows: [{ id: 7, slug: 'usernode-2d5619', name: 'Homeroom', repo_url: 'https://github.com/Usernode-Labs/social-vibecoding' }] };
      }
      if (/SELECT value FROM platform_settings WHERE key = \$1/.test(text) && params[0] === runner.STATE_KEY) {
        return { rows: db.state ? [{ value: JSON.stringify(db.state) }] : [] };
      }
      if (/INSERT INTO platform_settings/.test(text)) { db.state = JSON.parse(params[1]); return { rows: [] }; }
      if (/SELECT status FROM chat_sessions WHERE id = \$1/.test(text)) {
        return { rows: db.sessions[params[0]] ? [{ status: db.sessions[params[0]] }] : [] };
      }
      if (/INSERT INTO chat_sessions/.test(text)) { db.inserted.push(params); return { rows: [{ id: 900 + db.inserted.length }] }; }
      if (/INSERT INTO system_token_usage/.test(text)) { db.spend += Number(params[0]); return { rows: [] }; }
      return { rows: [] };
    },
  };
  const files = () => {
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push({ path: path.relative(repo.root, full).split(path.sep).join('/'), size: 1, sha: full });
      }
    };
    walk(path.join(repo.root, 'frontend'));
    return out;
  };
  const pushed = [];
  const reads = [];
  let main = 'a'.repeat(40);
  const github = {
    async getBranchSha() { return main; },
    async listRepoFiles(owner, name, ref) { reads.push(ref); return { files: [...files(), { path: 'README.md', size: 1, sha: 'x' }], truncated: false }; },
    async getBlobContent(owner, name, sha) { return fs.readFileSync(sha, 'utf8'); },
    async ensureBranchAtSha(owner, name, branch, sha) { pushed.push({ branch, at: sha }); },
    async pushFiles(owner, name, list, { branch }) { pushed.push({ branch, files: list }); },
    async createPR(owner, name, { title }) { return { number: 5000 + pushed.length, html_url: 'https://github.com/x/y/pull/1', title }; },
  };
  const model = fakeModel((item) => SPANISH[item.id]);
  const batches = [];
  const llm = {
    isEnabled: () => true,
    translateCatalogDirect: model.translate,
    async submitCatalogBatch(requests) { batches.push({ requests, status: 'in_progress' }); return { id: `batch_${batches.length}` }; },
    async catalogBatchStatus(id) {
      const batch = batches[Number(id.split('_')[1]) - 1];
      return { status: batch.status, counts: batch.counts || null };
    },
    async catalogBatchAnswers(id) {
      const batch = batches[Number(id.split('_')[1]) - 1];
      return batch.answers ? batch.answers(batch.requests) : model.translate(batch.requests);
    },
  };
  const kicked = [];
  const deps = {
    github,
    llm,
    now: () => clock.now,
    log: {
      info: (scope, message, detail) => logged.push({ level: 'info', scope, message, detail }),
      warn: (scope, message, detail) => logged.push({ level: 'warn', scope, message, detail }),
    },
    maintenance: {
      PLATFORM_USERNAME: 'usernode-platform',
      ensurePlatformUser: async () => 1,
      kickChecks: (config, p, session) => kicked.push(session),
    },
    ws: { pushVoteUpdate() {}, pushNotificationToUser() {} },
    notifications: { createPrProposedNotifications: async () => [], serialize: (row) => row },
  };
  return {
    repo, db, pool, deps, pushed, kicked, batches, model, reads, logged, clock, llm,
    moveMain: (sha) => { main = sha; },
    run: () => runner.runOnce({ config: {}, pool, deps }),
  };
}

test('the sweep translates what main is missing and puts it to the community as one proposal', async (t) => {
  const p = platform(t);
  const result = await p.run();
  assert.equal(result.opened, 5002);
  assert.deepEqual(p.pushed[0], { branch: p.pushed[0].branch, at: 'a'.repeat(40) }, 'branched at the commit the English was read from');
  assert.match(p.pushed[0].branch, /^i18n\/translations-\d+$/);
  assert.deepEqual(p.pushed[1].files.map((file) => file.path), ['frontend/locales/es/core.json'], 'only the translation files');
  assert.equal(JSON.parse(p.pushed[1].files[0].content)['button.leave'].text, 'Salir');
  const [session] = p.db.inserted;
  assert.equal(session[6], 'translation', 'a translation proposal, by source');
  assert.match(session[5], /^Translations: 4 interface messages in Español$/);
  assert.match(session[7], /in Español/);
  assert.equal(p.kicked.length, 1, 'its preview and checks start like any platform-opened proposal');
  assert.ok(p.db.spend > 0, 'the spend counts against the system budget');
  assert.equal(p.db.state.proposal.sessionId, 901);

  // While it is open, nothing else is opened.
  p.db.sessions[901] = 'promoted';
  p.moveMain('b'.repeat(40));
  assert.deepEqual(await p.run(), { skipped: 'proposal_open' });
});

test('a closed translation proposal is not offered again until the English changes', async (t) => {
  const p = platform(t);
  await p.run();
  p.db.sessions[901] = 'closed';
  p.moveMain('b'.repeat(40));
  assert.deepEqual(await p.run(), { skipped: 'declined' });
  p.moveMain('c'.repeat(40));
  assert.deepEqual(await p.run(), { skipped: 'declined' }, 'main moved, but the English is the same');
  p.repo.put('en/core.json', { ...ENGLISH, 'button.join': says('Join', 'Button: become a member.') });
  p.moveMain('d'.repeat(40));
  SPANISH['core:button.join'] = { text: 'Unirse' };
  t.after(() => { delete SPANISH['core:button.join']; });
  const again = await p.run();
  assert.equal(again.opened > 0, true, 'new English, a new proposal');
});

test('a whole language goes as a Message Batch, and its proposal opens on the pass after it ends', async (t) => {
  const english = { ...ENGLISH };
  for (let i = 0; i <= runner.DIRECT_LIMIT; i += 1) english[`bulk.m${i}`] = says(`Message ${i}`, 'Bulk fixture message.');
  const p = platform(t, { english });
  for (let i = 0; i <= runner.DIRECT_LIMIT; i += 1) SPANISH[`core:bulk.m${i}`] = { text: `Mensaje ${i}` };
  t.after(() => { for (let i = 0; i <= runner.DIRECT_LIMIT; i += 1) delete SPANISH[`core:bulk.m${i}`]; });
  const submitted = await p.run();
  assert.equal(submitted.submitted, 'batch_1');
  assert.equal(p.db.state.batch.baseSha, 'a'.repeat(40));
  assert.deepEqual(await p.run(), { waiting: 'batch_1' });
  p.batches[0].status = 'ended';
  p.moveMain('b'.repeat(40));
  const opened = await p.run();
  assert.ok(opened.opened, 'opened from the batch');
  assert.equal(p.reads.at(-1), 'a'.repeat(40), 'the answers are matched against the catalogs the batch was built from');
  assert.equal(p.pushed[0].at, 'a'.repeat(40), 'at the commit the batch translated, not today\'s main');
  assert.equal(p.db.state.batch, undefined);
});

/** A catalog too large to translate directly, with its Spanish, removed after the test. */
function bulk(t) {
  const english = { ...ENGLISH };
  for (let i = 0; i <= runner.DIRECT_LIMIT; i += 1) english[`bulk.m${i}`] = says(`Message ${i}`, 'Bulk fixture message.');
  for (let i = 0; i <= runner.DIRECT_LIMIT; i += 1) SPANISH[`core:bulk.m${i}`] = { text: `Mensaje ${i}` };
  t.after(() => { for (let i = 0; i <= runner.DIRECT_LIMIT; i += 1) delete SPANISH[`core:bulk.m${i}`]; });
  return english;
}

const REFUSED = {
  kind: 'errored',
  type: 'invalid_request_error',
  message: 'output_config.format.schema: For \'object\' type, \'additionalProperties\' must be explicitly set to false',
};
const refuseAll = (requests) => new Map(requests.map((r) => [r.customId, { error: 'errored', failure: REFUSED }]));
const HOUR = 60 * 60 * 1000;

test('a batch in which every request failed is logged with its reason and is not sent again on the next merge', async (t) => {
  const p = platform(t, { english: bulk(t) });
  assert.equal((await p.run()).submitted, 'batch_1');
  assert.equal(p.db.state.batch.shape, sync.requestShape(), 'the batch remembers what its requests were made of');
  const requests = p.batches[0].requests.length;
  Object.assign(p.batches[0], {
    status: 'ended',
    answers: refuseAll,
    counts: { processing: 0, succeeded: 0, errored: requests, canceled: 0, expired: 0 },
  });
  const failed = await p.run();
  assert.deepEqual(failed, { failed: true, reasons: { 'errored: invalid_request_error': requests }, spentCents: 0 });
  assert.equal(p.model.calls.length, 0, 'nothing is asked again one message at a time');
  assert.equal(p.pushed.length, 0, 'no proposal');

  const warnings = p.logged.filter((line) => line.level === 'warn');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].scope, 'language-sync');
  assert.match(warnings[0].message, /^Every translation request failed; not sending them again until the request changes or a day has passed$/);
  assert.deepEqual(warnings[0].detail, {
    requests,
    failedRequests: requests,
    reasons: { 'errored: invalid_request_error': requests },
    example: REFUSED.message,
    leftInEnglish: { 'errored: invalid_request_error': runner.DIRECT_LIMIT + 5 },
    batchId: 'batch_1',
    batchCounts: { processing: 0, succeeded: 0, errored: requests, canceled: 0, expired: 0 },
    retryAfter: '2026-10-12T12:00:00.000Z',
  });
  // Counts and the API's words only: no message, English or translated.
  assert.doesNotMatch(JSON.stringify(warnings), /Message \d|Mensaje|Hello|Leave/);

  // The state keeps the failure and does not call main read.
  assert.equal(p.db.state.batch, undefined);
  assert.equal(p.db.state.checkedSha, null);
  assert.equal(p.db.state.failure.shape, sync.requestShape());
  assert.equal(p.db.state.failure.baseSha, 'a'.repeat(40));

  // Main moves, as it does on every merge: the same requests are not sent.
  for (const sha of ['b', 'c', 'd']) {
    p.moveMain(sha.repeat(40));
    p.clock.now += 3 * HOUR;
    assert.deepEqual(await p.run(), { skipped: 'failed_before' });
  }
  assert.equal(p.batches.length, 1, 'one batch, not one a merge');
  assert.equal(p.logged.filter((line) => line.level === 'warn').length, 1);

  // The admin connector's status shows it.
  assert.deepEqual((await runner.status(p.pool, { now: p.clock.now })).failure, {
    at: '2026-10-11T12:00:00.000Z',
    requests,
    reasons: { 'errored: invalid_request_error': requests },
    example: REFUSED.message,
    batchCounts: { processing: 0, succeeded: 0, errored: requests, canceled: 0, expired: 0 },
    retryAfter: '2026-10-12T12:00:00.000Z',
  });

  // A day on it is tried again, and a good batch opens the proposal and clears the failure.
  p.clock.now = Date.parse('2026-10-12T12:00:00Z');
  assert.equal((await runner.status(p.pool, { now: p.clock.now })).failure.retryAfter, null, 'due: the day has passed');
  assert.equal((await p.run()).submitted, 'batch_2');
  assert.ok(p.db.state.failure, 'kept until a pass gets an answer');
  p.batches[1].status = 'ended';
  const opened = await p.run();
  assert.ok(opened.opened, 'the proposal opens');
  assert.equal(p.pushed[0].at, 'd'.repeat(40));
  assert.equal(p.db.state.failure, undefined);
  assert.equal((await runner.status(p.pool, { now: p.clock.now })).failure, null);
});

test('a failure stops holding the step back as soon as a request is made differently', async (t) => {
  const p = platform(t, { english: bulk(t) });
  await p.run();
  Object.assign(p.batches[0], { status: 'ended', answers: refuseAll });
  await p.run();
  assert.deepEqual(await p.run(), { skipped: 'failed_before' });
  // The fix merges: the schema, the model or the token limit changes.
  const before = sync.REQUEST_OPTIONS.max_tokens;
  sync.REQUEST_OPTIONS.max_tokens = before + 1;
  t.after(() => { sync.REQUEST_OPTIONS.max_tokens = before; });
  assert.equal((await runner.status(p.pool, { now: p.clock.now })).failure.retryAfter, null, 'due on the next pass');
  assert.equal((await p.run()).submitted, 'batch_2');
});

test('a failed batch sent by an earlier version does not hold this one back', async (t) => {
  const p = platform(t, { english: bulk(t) });
  await p.run();
  // As the version before this one recorded a batch: no shape.
  delete p.db.state.batch.shape;
  Object.assign(p.batches[0], { status: 'ended', answers: refuseAll });
  assert.equal((await p.run()).failed, true);
  const [warning] = p.logged.filter((line) => line.level === 'warn');
  assert.match(warning.message, /made by an earlier version, so the next pass sends them as this one makes them$/);
  assert.equal(warning.detail.retryAfter, undefined);
  assert.equal(warning.detail.example, REFUSED.message, 'the reason is logged all the same');
  assert.equal((await runner.status(p.pool, { now: p.clock.now })).failure.retryAfter, null);
  assert.equal((await p.run()).submitted, 'batch_2', 'sent again at once, as this version makes it');
});

test('a direct pass in which every request failed is logged and held back the same way', async (t) => {
  const p = platform(t);
  const calls = [];
  const direct = p.llm.translateCatalogDirect;
  p.llm.translateCatalogDirect = async (requests) => {
    calls.push(requests.length);
    return new Map(requests.map((r) => [r.customId, { error: '400 refused', failure: { ...REFUSED, kind: 'request' } }]));
  };
  const failed = await p.run();
  assert.deepEqual(failed, { failed: true, reasons: { 'request: invalid_request_error': 1 }, messages: 4, spentCents: 0 });
  assert.deepEqual(calls, [1], 'one request, not one more per message');
  const [warning] = p.logged.filter((line) => line.level === 'warn');
  assert.equal(warning.detail.example, REFUSED.message);
  assert.equal(warning.detail.batchId, undefined);
  p.moveMain('b'.repeat(40));
  assert.deepEqual(await p.run(), { skipped: 'failed_before' });
  assert.deepEqual(calls, [1]);
  // The next day the API answers: the proposal opens.
  p.clock.now += 25 * HOUR;
  p.llm.translateCatalogDirect = direct;
  assert.ok((await p.run()).opened);
  assert.equal(p.db.state.failure, undefined);
});

test('a pass that wrote only part, or nothing the checks would pass, says why at warn level and is not held back', async (t) => {
  // Three messages pass, one is refused twice: the proposal opens, with a warning.
  const part = platform(t);
  part.llm.translateCatalogDirect = fakeModel((item) => (item.id === 'core:button.leave' ? { text: 'Salir — ahora' } : SPANISH[item.id])).translate;
  assert.ok((await part.run()).opened);
  const partWarnings = part.logged.filter((line) => line.level === 'warn');
  assert.equal(partWarnings.length, 1);
  assert.equal(partWarnings[0].message, 'Translation pass wrote less than it asked for');
  assert.deepEqual(partWarnings[0].detail, { requests: 2, failedRequests: 0, reasons: {}, leftInEnglish: { 'an em dash': 1 } });
  assert.equal(part.db.state.failure, undefined);

  // Everything written: no warning.
  const whole = platform(t);
  assert.ok((await whole.run()).opened);
  assert.equal(whole.logged.filter((line) => line.level === 'warn').length, 0);

  // Every request answered, nothing the checks pass.
  const p = platform(t);
  p.llm.translateCatalogDirect = fakeModel(() => ({ text: 'Salir — ahora' })).translate;
  const result = await p.run();
  assert.equal(result.nothingUsable, true);
  const [warning] = p.logged.filter((line) => line.level === 'warn');
  assert.equal(warning.message, 'Translation pass produced nothing');
  assert.equal(warning.detail.failedRequests, 0);
  assert.deepEqual(warning.detail.reasons, {});
  assert.equal(warning.detail.leftInEnglish['an em dash'], 1);
  assert.equal(p.db.state.failure, undefined, 'the requests were answered');
  assert.equal(p.db.state.checkedSha, 'a'.repeat(40));
});

/** 61 plain messages: two direct requests. */
const sixtyOne = () => Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`msg.m${i}`, says('A')]));
const emptyAnswers = (requests) => requests.map((request) => [request.customId, {
  text: JSON.stringify({ translations: request.items.map((item) => ({ id: item.id, text: '' })) }),
  usage: { input_tokens: 100, output_tokens: 100 },
}]);
const OUTAGE = { kind: 'request', type: 'api_error', message: 'Internal server error' };

test('a pass that wrote nothing while requests went unanswered does not call main read', async (t) => {
  // Direct: the first request fails, and so does every retry of its
  // messages; the second is answered with nothing the checks pass.
  const p = platform(t, { english: sixtyOne() });
  p.llm.translateCatalogDirect = async (requests, _options) => new Map(requests.map((request, index) => (
    (index === 0 && requests.length === 2) || request.customId.startsWith('es-0-retry')
      ? [request.customId, { error: '500', failure: OUTAGE }]
      : emptyAnswers([request])[0])));
  const mixed = await p.run();
  assert.equal(mixed.failed, true);
  assert.equal(p.db.state.checkedSha, null, 'the work is not done');
  const [warning] = p.logged.filter((line) => line.level === 'warn');
  assert.match(warning.message, /^Translation requests failed and nothing was written; not sending them again until/);
  assert.equal(warning.detail.failedRequests, 61, 'the request, then each of its 60 messages');
  assert.deepEqual(await p.run(), { skipped: 'failed_before' });
  // Main has not moved. A day later the same work is sent again, and opens the proposal.
  p.clock.now += 25 * HOUR;
  p.llm.translateCatalogDirect = async (requests) => new Map(requests.map((request) => [request.customId, {
    text: JSON.stringify({ translations: request.items.map((item) => ({ id: item.id, text: 'B' })) }),
    usage: { input_tokens: 100, output_tokens: 100 },
  }]));
  assert.ok((await p.run()).opened, 'not "unchanged"');
  assert.equal(p.db.state.failure, undefined);

  // The first request fails once and its messages are answered on the second try: a proposal, as before this change.
  const q = platform(t, { english: sixtyOne() });
  q.llm.translateCatalogDirect = async (requests) => new Map(requests.map((request, index) => (
    index === 0 && requests.length === 2
      ? [request.customId, { error: '500', failure: OUTAGE }]
      : [request.customId, { text: JSON.stringify({ translations: request.items.map((item) => ({ id: item.id, text: 'B' })) }), usage: { input_tokens: 100, output_tokens: 100 } }])));
  assert.ok((await q.run()).opened);
  assert.match(q.db.inserted[0][5], /^Translations: 61 interface messages/);

  // A batch: one request expired, the rest answered with nothing usable,
  // and too many messages are left to ask one at a time.
  const b = platform(t, { english: bulk(t) });
  await b.run();
  Object.assign(b.batches[0], {
    status: 'ended',
    answers: async (requests) => new Map(requests.map((request, index) => (index === 0
      ? [request.customId, { error: 'expired', failure: { kind: 'expired' } }]
      : emptyAnswers([request])[0]))),
  });
  assert.equal((await b.run()).failed, true);
  assert.equal(b.db.state.checkedSha, null);
  assert.equal(b.db.state.batch, undefined);
  assert.deepEqual(await b.run(), { skipped: 'failed_before' });
  b.clock.now += 25 * HOUR;
  assert.equal((await b.run()).submitted, 'batch_2', 'due again on the same main');
});

test('a batch the API will not take is logged, kept and held back like any failed pass', async (t) => {
  const p = platform(t, { english: bulk(t) });
  let creates = 0;
  const refuse = (status, type, message) => async () => {
    creates += 1;
    throw Object.assign(new Error(`${status} ${message}`), { status, error: { type: 'error', error: { type, message } } });
  };
  const submit = p.llm.submitCatalogBatch;
  p.llm.submitCatalogBatch = refuse(401, 'authentication_error', `invalid x-api-key sk-ant-api03-${'A'.repeat(40)} ${'x'.repeat(900)}`);
  const refused = await p.run();
  assert.deepEqual(refused, { failed: true, reasons: { 'submit: authentication_error': 1 }, messages: runner.DIRECT_LIMIT + 5, spentCents: 0 });
  const [warning] = p.logged.filter((line) => line.level === 'warn');
  assert.match(warning.message, /^The translation batch was refused; not sending them again until the request changes or a day has passed$/);
  assert.ok(warning.detail.example.length <= 300, 'the API\'s message is cut short');
  assert.doesNotMatch(JSON.stringify([warning, p.db.state]), /sk-ant-api03-A/, 'and a key in it is masked, in the log and in the state');
  assert.ok(p.db.state.failure.requests > 1, 'the batch\'s requests');
  assert.equal(p.db.state.checkedSha, null);
  for (const sha of ['b', 'c']) {
    p.moveMain(sha.repeat(40));
    assert.deepEqual(await p.run(), { skipped: 'failed_before' });
  }
  assert.equal(creates, 1, 'one submission, not one a merge');
  const shown = (await runner.status(p.pool, { now: p.clock.now })).failure;
  assert.deepEqual(shown.reasons, { 'submit: authentication_error': 1 });
  assert.equal(shown.retryAfter, '2026-10-12T12:00:00.000Z');

  // A rate limit or a server error is not a refusal: it is thrown to the pass's own log, and tried next pass.
  p.clock.now += 25 * HOUR;
  p.llm.submitCatalogBatch = refuse(529, 'overloaded_error', 'Overloaded');
  await assert.rejects(p.run(), /529 Overloaded/);
  p.llm.submitCatalogBatch = refuse(429, 'rate_limit_error', 'Slow down');
  await assert.rejects(p.run(), /429/);
  p.llm.submitCatalogBatch = submit;
  assert.equal((await p.run()).submitted, 'batch_1');
});

test('the day is counted from when the failure was known, not from when the pass began', async (t) => {
  const p = platform(t);
  p.llm.translateCatalogDirect = async (requests) => {
    p.clock.now += HOUR; // the requests take an hour to time out
    return new Map(requests.map((request) => [request.customId, { error: 'timeout', failure: { kind: 'request', message: 'Request timed out.' } }]));
  };
  const started = p.clock.now;
  assert.equal((await p.run()).failed, true);
  assert.equal(p.db.state.failure.at, new Date(started + HOUR).toISOString());
  const [warning] = p.logged.filter((line) => line.level === 'warn');
  assert.equal(warning.detail.retryAfter, new Date(started + 25 * HOUR).toISOString());
  let calls = 0;
  p.llm.translateCatalogDirect = async (requests) => { calls += 1; return new Map(requests.map((request) => [request.customId, { error: 'timeout', failure: { kind: 'request' } }])); };
  p.clock.now = started + 24 * HOUR;
  assert.deepEqual(await p.run(), { skipped: 'failed_before' }, '23 hours after the failure');
  assert.equal((await runner.status(p.pool, { now: p.clock.now })).failure.retryAfter, new Date(started + 25 * HOUR).toISOString());
  p.clock.now = started + 25 * HOUR;
  assert.equal((await runner.status(p.pool, { now: p.clock.now })).failure.retryAfter, null, 'due: no past deadline is shown');
  assert.equal((await p.run()).failed, true);
  assert.equal(calls, 1);
});

// ── The transport (services/llm.js) ───────────────────────────────────

test('a failed batch entry or direct request keeps the API\'s error type and message', async (t) => {
  const llm = require('../src/services/llm');
  const message = (text) => ({ model: sync.MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } });
  const lines = [
    { custom_id: 'es-0', result: { type: 'succeeded', message: message('{"translations":[]}') } },
    // An errored entry as the API writes it: the error response a direct call would have had.
    { custom_id: 'es-1', result: { type: 'errored', error: { type: 'error', request_id: 'req_1', error: { type: 'invalid_request_error', message: 'output_config.format.schema:\n  additionalProperties must be false' } } } },
    { custom_id: 'es-2', result: { type: 'expired' } },
    { custom_id: 'es-3', result: { type: 'canceled' } },
    { custom_id: 'es-4', result: { type: 'errored', error: { type: 'error', error: { type: 'api_error', message: 'x'.repeat(900) } } } },
  ];
  const sent = [];
  llm._setClientForTests({
    messages: {
      batches: {
        async results() { return (async function* entries() { yield* lines; }()); },
        async retrieve(id) { return { id, processing_status: 'ended', request_counts: { processing: 0, succeeded: 1, errored: 2, canceled: 1, expired: 1 } }; },
      },
      async create(params) {
        sent.push(params);
        if (params.messages[0].content === 'refused') {
          // The SDK's APIError: the status, the parsed body, and a message that repeats it.
          throw Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"bad schema"}}'), {
            status: 400, error: { type: 'error', error: { type: 'invalid_request_error', message: 'bad schema' } },
          });
        }
        if (params.messages[0].content === 'offline') throw new Error('Connection error.');
        return message('{"translations":[]}');
      },
    },
  });
  t.after(() => llm._setClientForTests(null));

  const answers = await llm.catalogBatchAnswers('msgbatch_1');
  assert.equal(answers.get('es-0').failure, undefined);
  assert.equal(answers.get('es-0').text, '{"translations":[]}');
  assert.deepEqual(answers.get('es-1'), {
    error: 'errored',
    failure: { kind: 'errored', type: 'invalid_request_error', message: 'output_config.format.schema: additionalProperties must be false' },
  });
  assert.deepEqual(answers.get('es-2'), { error: 'expired', failure: { kind: 'expired' } });
  assert.deepEqual(answers.get('es-3'), { error: 'canceled', failure: { kind: 'canceled' } });
  assert.equal(answers.get('es-4').failure.type, 'api_error');
  assert.equal(answers.get('es-4').failure.message.length, 300, 'a long message is cut short');
  assert.deepEqual((await llm.catalogBatchStatus('msgbatch_1')).counts, { processing: 0, succeeded: 1, errored: 2, canceled: 1, expired: 1 });

  const request = (customId, content) => ({ customId, params: { model: sync.MODEL, max_tokens: 100, messages: [{ role: 'user', content }] } });
  const direct = await llm.translateCatalogDirect([request('a', 'fine'), request('b', 'refused'), request('c', 'offline')], { concurrency: 1 });
  assert.equal(direct.get('a').failure, undefined);
  assert.deepEqual(direct.get('b').failure, { kind: 'request', type: 'invalid_request_error', message: 'bad schema' });
  assert.match(direct.get('b').error, /^400 /);
  assert.deepEqual(direct.get('c').failure, { kind: 'request', message: 'Connection error.' });
  assert.equal(sent.length, 3);
});

test('the sweep is idle without a key, off with LANGUAGE_SYNC_ENABLED=false, and runs only on the leader', () => {
  const before = process.env.LANGUAGE_SYNC_ENABLED;
  try {
    process.env.LANGUAGE_SYNC_ENABLED = 'false';
    assert.equal(runner.isEnabled(), false);
    delete process.env.LANGUAGE_SYNC_ENABLED;
    assert.equal(runner.isEnabled(), true);
  } finally {
    if (before === undefined) delete process.env.LANGUAGE_SYNC_ENABLED; else process.env.LANGUAGE_SYNC_ENABLED = before;
  }
  const server = read('server.js');
  const leader = server.indexOf("require('./src/services/fixed-check-sync').start(config, getPool(config));");
  assert.ok(server.indexOf("require('./src/services/language-sync-runner').start(config, getPool(config));") > leader);
  assert.match(server, /const languageSyncStop = require\('\.\/src\/services\/language-sync-runner'\)\.stop\(\);/);
  assert.match(server, /Promise\.all\(\[[^\]]*languageSyncStop[^\]]*\]\)/);
});

test('no key, no pass', async () => {
  const result = await runner.runOnce({ config: {}, pool: { query: async () => ({ rows: [] }) }, deps: { llm: { isEnabled: () => false } } });
  assert.deepEqual(result, { skipped: 'no_key' });
});
