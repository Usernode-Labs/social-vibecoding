// #6081: text people post is translated into the reader's language when they
// ask, and kept by the digest of the exact text and the target language.
//
// What this pins, each a way the feature can be quietly wrong:
//   1. THE CACHE. The second ask for the same text in the same language costs
//      no model call, whoever asks; a translated row is never overwritten.
//   2. THE CHECKS. A dropped URL, @name or code span is refused, and the
//      original stays.
//   3. THE RETRY. A refused answer is asked for again only after a day.
//   4. THE BOUNDS. The platform budget and one person's daily cap stop a tap
//      before the model is called; a cached answer still comes back.
//   5. THE TARGET. The reader's asked language, else their account's, else
//      their browser's, else English.
//
// Run with: node --test tests/user-content-translations.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const service = require('../src/services/user-content-translations');
const packs = require('../scripts/language-packs');

const source = {
  files: {
    'config.json': { languages: { en: 'English', fr: 'Français', 'zh-CN': '简体中文', es: 'Español' } },
    'glossary.json': { doNotTranslate: ['Homeroom'], terms: {}, style: {} },
  },
};

function fakePool({ rows = [], asks = 0, failAsks = false } = {}) {
  const table = new Map(rows.map((row) => [`${row.source_digest}|${row.language}`, { ...row }]));
  let askCount = asks;
  return {
    table,
    get asks() { return askCount; },
    async query(sql, params = []) {
      if (/FROM user_content_translations\s+WHERE source_digest = \$1 AND language = \$2/.test(sql)) {
        const row = table.get(`${params[0]}|${params[1]}`);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (/^\s*INSERT INTO user_content_translations/.test(sql)) {
        const [digest, language, text, from, same, problem, model] = params;
        const key = `${digest}|${language}`;
        const held = table.get(key);
        const fresh = {
          source_digest: digest, language, text, source_language: from, same_language: same,
          problem, model, attempted_at: new Date(),
        };
        if (held) {
          if (held.text != null || held.same_language === true) return { rows: [], rowCount: 0 };
          if (held.problem && Date.now() - new Date(held.attempted_at).getTime() < 24 * 60 * 60 * 1000) {
            return { rows: [], rowCount: 0 };
          }
        }
        table.set(key, fresh);
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO user_content_translation_asks/.test(sql)) {
        if (failAsks) throw new Error('asks table is down');
        return { rows: [{ count: askCount }] };
      }
      if (/UPDATE user_content_translation_asks SET count = count \+ \$2/.test(sql)) {
        askCount += params[1];
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql.replace(/\s+/g, ' ').slice(0, 100)}`);
    },
  };
}

function model(answerFor) {
  const calls = [];
  return {
    calls,
    isEnabled: () => true,
    estimateCostCents: () => 1,
    async translateCatalogDirect(requests) {
      calls.push(requests);
      return new Map(requests.map((request) => [request.customId, answerFor(request)]));
    },
  };
}

const translated = (request) => ({
  text: JSON.stringify({
    items: request.items.map((item) => ({ id: item.id, from: 'zh-CN', same: false, text: `EN ${item.text}` })),
  }),
  usage: { input_tokens: 10, output_tokens: 10 },
});
const same = (request) => ({
  text: JSON.stringify({ items: request.items.map((item) => ({ id: item.id, from: 'en', same: true, text: '' })) }),
});
const budgets = { checkSystemBudget: async () => ({}), recordSystemSpend: async () => {} };

test('a translated text is kept by digest and language, and costs one model call for everyone', async () => {
  const pool = fakePool();
  const llm = model(translated);
  const first = await service.translate(pool, { texts: ['你好'], language: 'en', userId: 1 }, { llm, limits: budgets, source });
  assert.deepEqual(first.results, [{ state: 'translated', text: 'EN 你好', from: 'zh-CN' }]);
  assert.equal(llm.calls.length, 1);
  assert.equal(pool.asks, 1);

  const second = await service.translate(pool, { texts: ['你好'], language: 'en', userId: 2 }, { llm, limits: budgets, source });
  assert.deepEqual(second.results, [{ state: 'translated', text: 'EN 你好', from: 'zh-CN' }]);
  assert.equal(llm.calls.length, 1, 'a cached translation asks the model nothing');
  assert.equal(pool.asks, 1, 'a cache hit is not counted');
});

test('text already in the target language answers "same" and stores no translation', async () => {
  const pool = fakePool();
  const llm = model(same);
  const out = await service.translate(pool, { texts: ['Hello'], language: 'en', userId: 1 }, { llm, limits: budgets, source });
  assert.deepEqual(out.results, [{ state: 'same' }]);
  const row = [...pool.table.values()][0];
  assert.equal(row.same_language, true);
  assert.equal(row.text, null);
});

test('an answer that drops a URL, an @name or a code span is refused and the original stays', async () => {
  const cases = [
    ['See https://example.test/x for more', 'See the page for more'],
    ['Ask @ada about it', 'Ask someone about it'],
    ['Run `npm test` first', 'Run the tests first'],
  ];
  for (const [text, answer] of cases) {
    const pool = fakePool();
    const llm = model((request) => ({
      text: JSON.stringify({ items: request.items.map((item) => ({ id: item.id, from: 'en', text: answer })) }),
    }));
    const out = await service.translate(pool, { texts: [text], language: 'fr', userId: 1 }, { llm, limits: budgets, source });
    assert.deepEqual(out.results, [{ state: 'failed' }], text);
    assert.ok([...pool.table.values()][0].problem, 'why it was refused is kept');
  }
});

test('a refused row is asked for again only after a day', async () => {
  const digest = packs.hash('Hello');
  const refusedAt = new Date(Date.now() - 1000);
  const pool = fakePool({
    rows: [{ source_digest: digest, language: 'fr', text: null, same_language: false, problem: 'empty', attempted_at: refusedAt }],
  });
  const llm = model(translated);
  const first = await service.translate(pool, { texts: ['Hello'], language: 'fr', userId: 1 }, { llm, limits: budgets, source });
  assert.deepEqual(first.results, [{ state: 'failed' }]);
  assert.equal(llm.calls.length, 0, 'a refusal less than a day old is not asked again');

  [...pool.table.values()][0].attempted_at = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const second = await service.translate(pool, { texts: ['Hello'], language: 'fr', userId: 1 }, { llm, limits: budgets, source });
  assert.deepEqual(second.results, [{ state: 'translated', text: 'EN Hello', from: 'zh-CN' }]);
  assert.equal(llm.calls.length, 1);
});

test('the platform budget stops a new ask; a cached answer still comes back', async () => {
  const digest = packs.hash('Cached');
  const pool = fakePool({
    rows: [{ source_digest: digest, language: 'fr', text: 'En cache', source_language: 'en', same_language: false, problem: null, attempted_at: new Date() }],
  });
  const llm = model(translated);
  const spent = { checkSystemBudget: async () => ({ error: 'budget reached' }), recordSystemSpend: async () => {} };
  const out = await service.translate(pool, { texts: ['Cached', 'Fresh'], language: 'fr', userId: 1 }, { llm, limits: spent, source });
  assert.deepEqual(out.results, [{ state: 'translated', text: 'En cache', from: 'en' }, { state: 'failed' }]);
  assert.equal(out.blocked, 'budget');
  assert.equal(llm.calls.length, 0);
});

test('one person may ask for only so many new translations a day; cache hits do not count', async () => {
  const pool = fakePool({ asks: service.DAILY_LIMIT });
  const llm = model(translated);
  const out = await service.translate(pool, { texts: ['Fresh'], language: 'fr', userId: 9 }, { llm, limits: budgets, source });
  assert.deepEqual(out.results, [{ state: 'failed' }]);
  assert.equal(out.blocked, 'translation_limit');
  assert.equal(llm.calls.length, 0);
});

test('the target is the asked language, then the account, then the browser, then English', () => {
  assert.equal(service.targetLanguage('fr', { locale: 'es' }, 'zh-CN', { source }), 'fr');
  assert.equal(service.targetLanguage('xx', { locale: 'es' }, 'zh-CN', { source }), 'es');
  assert.equal(service.targetLanguage('not a tag', { locale: null }, 'de, zh-CN;q=0.8', { source }), 'zh-CN');
  assert.equal(service.targetLanguage('not a tag', { locale: null }, 'de', { source }), 'en');
  assert.equal(service.targetLanguage('en-US', { locale: 'es' }, null, { source }), 'en');
});
