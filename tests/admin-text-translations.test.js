// #6152: text an admin writes in the console and a phone shows gets translated.
// English is the source and the fallback: a missing, out-of-date or failed
// translation shows the English, and a must-update message, which stands
// between someone and the app, is shown only once an admin has reviewed it.
//
// Run with: node --test tests/admin-text-translations.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const packs = require('../scripts/language-packs');
const service = require('../src/services/admin-text-translations');

const source = {
  files: {
    'config.json': { sourceLanguage: 'en', languages: { en: 'English', fr: 'Français', 'pt-BR': 'Português (Brasil)', 'zh-CN': '简体中文', ar: 'العربية' } },
    'glossary.json': { doNotTranslate: ['Homeroom'], terms: {}, style: {} },
  },
};

// The table as a Map, answering only the statements the service sends.
function fakePool({ configs = [], rows = [], failReads = false } = {}) {
  const table = new Map(rows.map((row) => [`${row.source_key}|${row.language}`, { ...row }]));
  return {
    table,
    async query(sql, params = []) {
      if (failReads) throw new Error('database is down');
      if (sql.includes('FROM app_version_configs')) return { rows: configs };
      if (/FROM (challenges|season_events|seasons)/.test(sql)) return { rows: [] };
      if (/^\s*SELECT/.test(sql) && sql.includes('WHERE source_key = $1 AND language = $2')) {
        const row = table.get(`${params[0]}|${params[1]}`);
        return { rows: row ? [row] : [] };
      }
      if (/^\s*SELECT/.test(sql) && sql.includes('FROM admin_text_translations')) return { rows: [...table.values()] };
      if (/^\s*INSERT INTO admin_text_translations/.test(sql)) {
        const [key, language, digest, text, reviewed, problem, model, by] = params;
        table.set(`${key}|${language}`, {
          source_key: key, language, source_digest: digest, text, reviewed, problem, model, updated_by: by, attempted_at: new Date(),
        });
        return { rows: [], rowCount: 1 };
      }
      if (/^\s*UPDATE admin_text_translations/.test(sql)) {
        const row = table.get(`${params[0]}|${params[1]}`);
        if (!row || row.source_digest !== params[2] || row.text == null) return { rows: [], rowCount: 0 };
        row.reviewed = true;
        return { rows: [], rowCount: 1 };
      }
      if (/^\s*DELETE FROM admin_text_translations/.test(sql)) {
        table.delete(`${params[0]}|${params[1]}`);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    },
  };
}

const row = (key, language, english, text, extra = {}) => ({
  source_key: key, language, source_digest: packs.hash(english), text, reviewed: false, problem: null, attempted_at: new Date(), ...extra,
});

// ── Which language a phone is asking for ─────────────────────────────────

test('a phone gets the language of Homeroom closest to the one it asks for', () => {
  const language = (asked, header) => service.languageFor(asked, header, { source });
  assert.equal(language('fr'), 'fr');
  assert.equal(language('fr-CA'), 'fr');
  assert.equal(language('pt'), 'pt-BR');
  assert.equal(language('pt_BR'), 'pt-BR');
  assert.equal(language('zh-Hans-CN'), 'zh-CN');
  assert.equal(language(undefined, 'ar-MA,fr;q=0.5'), 'ar');
});

test('English, a language Homeroom lacks and rubbish all ask for nothing, so no read is made', () => {
  const language = (asked, header) => service.languageFor(asked, header, { source });
  assert.equal(language('en'), null);
  assert.equal(language('en-GB'), null);
  assert.equal(language('sw'), null);
  assert.equal(language(42), null);
  assert.equal(language({ a: 1 }), null);
  assert.equal(language(undefined, undefined), null);
  assert.equal(language('x'.repeat(500)), null);
});

test('a build with no language source treats every language as English', () => {
  assert.equal(service.languageFor('fr', undefined, { source: null }), null);
});

// ── What an update prompt says ───────────────────────────────────────────

test('an update prompt\'s message comes from the config, or the default when the config has none', () => {
  const config = { must_update_message: 'Update now.', should_update_message: null };
  assert.deepEqual(service.updateMessage('ios', 2, config), {
    key: 'app-version:ios:must', english: 'Update now.', reviewRequired: true,
  });
  assert.deepEqual(service.updateMessage('ios', 1, config), {
    key: 'app-version:default:should',
    english: 'A new version is available. We recommend updating.',
    reviewRequired: false,
  });
  assert.equal(service.updateMessage('ios', 2, {}).key, 'app-version:default:must');
  assert.equal(service.updateMessage('ios', 0, config), null);
});

test('with no language asked for, the English is returned without touching the database', async () => {
  const pool = { query: async () => { throw new Error('must not read'); } };
  const message = { key: 'k', english: 'Hello', reviewRequired: false };
  assert.equal(await service.translated(pool, message, null), 'Hello');
});

test('a translation of the current English is shown', async () => {
  const pool = fakePool({ rows: [row('k', 'fr', 'Hello', 'Bonjour')] });
  assert.equal(await service.translated(pool, { key: 'k', english: 'Hello', reviewRequired: false }, 'fr'), 'Bonjour');
});

test('a translation of older English is not shown: the admin\'s new words win', async () => {
  const pool = fakePool({ rows: [row('k', 'fr', 'Old words', 'Vieux mots', { reviewed: true })] });
  assert.equal(await service.translated(pool, { key: 'k', english: 'New words', reviewRequired: false }, 'fr'), 'New words');
});

test('a must-update message shows its translation only once it has been reviewed', async () => {
  const message = { key: 'k', english: 'Update now.', reviewRequired: true };
  const waiting = fakePool({ rows: [row('k', 'fr', 'Update now.', 'Mettez à jour.')] });
  assert.equal(await service.translated(waiting, message, 'fr'), 'Update now.');
  const reviewed = fakePool({ rows: [row('k', 'fr', 'Update now.', 'Mettez à jour.', { reviewed: true })] });
  assert.equal(await service.translated(reviewed, message, 'fr'), 'Mettez à jour.');
});

test('a failed read still answers, in English: the update gate must never fall over on a translation', async () => {
  const pool = fakePool({ failReads: true });
  assert.equal(await service.translated(pool, { key: 'k', english: 'Hello', reviewRequired: false }, 'fr'), 'Hello');
});

test('an attempt that produced no text is not shown', async () => {
  const pool = fakePool({ rows: [row('k', 'fr', 'Hello', null, { problem: 'empty' })] });
  assert.equal(await service.translated(pool, { key: 'k', english: 'Hello', reviewRequired: false }, 'fr'), 'Hello');
});

// ── The translation pass ─────────────────────────────────────────────────

const iosConfig = { os: 'ios', must_update_message: 'Update now.', should_update_message: 'Please update.' };

// A model that answers every message with "<language>: <english>".
function fakeModel({ answer, enabled = true } = {}) {
  const calls = [];
  return {
    calls,
    isEnabled: () => enabled,
    estimateCostCents: () => 1,
    async translateCatalogDirect(requests) {
      calls.push(requests);
      const answers = new Map();
      for (const request of requests) {
        const translations = request.items.map((item) => ({
          id: item.id,
          text: answer ? answer(item, request.language) : `${request.language}: ${item.english}`,
        }));
        answers.set(request.customId, { text: JSON.stringify({ translations }), usage: { input_tokens: 1 } });
      }
      return answers;
    },
  };
}

const budget = (error = null) => {
  const spent = [];
  return { spent, checkSystemBudget: async () => ({ error }), recordSystemSpend: async (_pool, cents) => { spent.push(cents); } };
};

test('the clock has nothing to do with no model key, and a target when text is missing', async () => {
  const pool = fakePool({ configs: [iosConfig] });
  assert.deepEqual(await service.look({ pool, deps: { source, llm: fakeModel({ enabled: false }) } }), { skipped: 'no_key' });
  const out = await service.look({ pool, deps: { source, llm: fakeModel() } });
  assert.deepEqual(out, { items: [{ target: 'pending', input: {} }] });
});

test('a pass translates every message into every language but English, and they wait or show by kind', async () => {
  const pool = fakePool({ configs: [iosConfig] });
  const out = await service.runOnce({ pool, deps: { source, llm: fakeModel(), limits: budget() } });
  // ios must + ios should + the two defaults, in fr, pt-BR, zh-CN and ar.
  assert.equal(out.saved, 16);
  assert.equal(pool.table.get('app-version:ios:must|fr').text, 'fr: Update now.');
  assert.equal(pool.table.get('app-version:ios:must|fr').reviewed, false);
  assert.equal(pool.table.get('app-version:ios:must|fr').source_digest, packs.hash('Update now.'));
  assert.equal(pool.table.has('app-version:ios:must|en'), false);
  // Nothing is missing now, so the clock rests.
  assert.deepEqual(await service.look({ pool, deps: { source, llm: fakeModel() } }), { skipped: 'nothing_missing' });
});

test('a translation a person wrote is never overwritten while the English stands', async () => {
  const pool = fakePool({
    configs: [iosConfig],
    rows: [row('app-version:ios:must', 'fr', 'Update now.', 'Faites la mise à jour.', { reviewed: true })],
  });
  await service.runOnce({ pool, deps: { source, llm: fakeModel(), limits: budget() } });
  assert.equal(pool.table.get('app-version:ios:must|fr').text, 'Faites la mise à jour.');
  assert.equal(pool.table.get('app-version:ios:must|fr').reviewed, true);
});

test('when the English changes the old translation is replaced and must be reviewed again', async () => {
  const pool = fakePool({
    configs: [iosConfig],
    rows: [row('app-version:ios:must', 'fr', 'Older words.', 'Vieux mots.', { reviewed: true })],
  });
  await service.runOnce({ pool, deps: { source, llm: fakeModel(), limits: budget() } });
  assert.equal(pool.table.get('app-version:ios:must|fr').text, 'fr: Update now.');
  assert.equal(pool.table.get('app-version:ios:must|fr').reviewed, false);
});

test('an answer the checks refuse keeps the English, and is not paid for again for a day', async () => {
  const pool = fakePool({ configs: [iosConfig] });
  const model = fakeModel({ answer: (item, language) => (language === 'fr' && item.english === 'Update now.' ? '  ' : `ok ${item.english}`) });
  await service.runOnce({ pool, deps: { source, llm: model, limits: budget() } });
  const refused = pool.table.get('app-version:ios:must|fr');
  assert.equal(refused.text, null);
  assert.ok(refused.problem);
  assert.deepEqual(await service.look({ pool, deps: { source, llm: fakeModel() } }), { skipped: 'nothing_missing' });
  // A day on, it is tried again.
  refused.attempted_at = new Date(Date.now() - 25 * 3600 * 1000);
  assert.deepEqual(await service.look({ pool, deps: { source, llm: fakeModel() } }), { items: [{ target: 'pending', input: {} }] });
});

test('a pass spends nothing once the system budget is gone, and records what it did spend', async () => {
  const pool = fakePool({ configs: [iosConfig] });
  const gone = fakeModel();
  assert.deepEqual(await service.runOnce({ pool, deps: { source, llm: gone, limits: budget('over') } }), { skipped: 'budget' });
  assert.equal(gone.calls.length, 0);
  const limits = budget();
  await service.runOnce({ pool, deps: { source, llm: fakeModel(), limits } });
  assert.ok(limits.spent[0] > 0);
});

test('a model that cannot be reached loses nothing: the messages stay owed', async () => {
  const pool = fakePool({ configs: [iosConfig] });
  const model = fakeModel();
  model.translateCatalogDirect = async (requests) => new Map(requests.map((r) => [r.customId, { error: 'overloaded' }]));
  await service.runOnce({ pool, deps: { source, llm: model, limits: budget() } });
  assert.equal(pool.table.size, 0);
});

// ── What an admin reads and does ─────────────────────────────────────────

test('the overview lists each message, whether it must be reviewed, and where each language stands', async () => {
  const pool = fakePool({
    configs: [iosConfig],
    rows: [
      row('app-version:ios:must', 'fr', 'Update now.', 'Mettez à jour.'),
      row('app-version:ios:must', 'ar', 'Update now.', 'حدّث', { reviewed: true }),
      row('app-version:ios:must', 'pt-BR', 'Older words.', 'Velho'),
      row('app-version:ios:should', 'fr', 'Please update.', 'Mettez à jour svp.'),
      row('app-version:ios:should', 'ar', 'Please update.', null, { problem: 'empty' }),
    ],
  });
  const { messages } = await service.overview(pool, { source });
  assert.equal(messages.length, 4);
  const must = messages.find((m) => m.key === 'app-version:ios:must');
  assert.equal(must.review_required, true);
  assert.equal(must.english, 'Update now.');
  const state = (message, language) => message.languages.find((l) => l.language === language).state;
  assert.equal(state(must, 'fr'), 'needs_review');
  assert.equal(state(must, 'ar'), 'live');
  assert.equal(state(must, 'pt-BR'), 'waiting');
  assert.equal(state(must, 'zh-CN'), 'waiting');
  assert.equal(must.languages.find((l) => l.language === 'pt-BR').text, null, 'text of older English is not offered');
  assert.equal(must.languages.some((l) => l.language === 'en'), false);
  const should = messages.find((m) => m.key === 'app-version:ios:should');
  assert.equal(state(should, 'fr'), 'live');
  assert.equal(state(should, 'ar'), 'failed');
});

test('a correction is live at once and counts as reviewed', async () => {
  const pool = fakePool({ configs: [iosConfig] });
  const out = await service.correct(pool, { key: 'app-version:ios:must', language: 'fr', text: ' Mettez à jour. ', userId: 7 }, { source });
  assert.deepEqual(out, { ok: true });
  const saved = pool.table.get('app-version:ios:must|fr');
  assert.equal(saved.text, 'Mettez à jour.');
  assert.equal(saved.reviewed, true);
  assert.equal(saved.updated_by, 7);
  assert.equal(saved.source_digest, packs.hash('Update now.'));
});

test('a correction is refused for an unknown message, an unknown language, English, or no text', async () => {
  const pool = fakePool({ configs: [iosConfig] });
  const good = { key: 'app-version:ios:must', language: 'fr', text: 'x', userId: 1 };
  for (const bad of [{ key: 'nope' }, { language: 'sw' }, { language: 'en' }, { text: '   ' }, { text: 7 }, { text: 'x'.repeat(5001) }]) {
    const out = await service.correct(pool, { ...good, ...bad }, { source });
    assert.ok(out.error, JSON.stringify(bad));
  }
  assert.equal(pool.table.size, 0);
});

test('a translation of the current English can be approved; a missing one cannot', async () => {
  const pool = fakePool({ configs: [iosConfig], rows: [row('app-version:ios:must', 'fr', 'Update now.', 'Mettez à jour.')] });
  assert.deepEqual(await service.approve(pool, { key: 'app-version:ios:must', language: 'fr', userId: 1 }, { source }), { ok: true });
  assert.equal(pool.table.get('app-version:ios:must|fr').reviewed, true);
  assert.ok((await service.approve(pool, { key: 'app-version:ios:must', language: 'ar', userId: 1 }, { source })).error);
});

test('asking for a new translation forgets the old one, so the next pass writes it again', async () => {
  const pool = fakePool({ configs: [iosConfig], rows: [row('app-version:ios:must', 'fr', 'Update now.', 'Mettez à jour.', { reviewed: true })] });
  assert.deepEqual(await service.retranslate(pool, { key: 'app-version:ios:must', language: 'fr' }, { source }), { ok: true });
  assert.equal(pool.table.has('app-version:ios:must|fr'), false);
});

// ── Who may do what ──────────────────────────────────────────────────────

test('every route that changes a translation takes the write gate, and the screen hides those controls from a reader', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/topochain/admin/text-translations.js'), 'utf8');
  const posts = routes.match(/router\.post\([^\n]+/g);
  assert.equal(posts.length, 3);
  for (const post of posts) assert.match(post, /adminWriteGate,$/);
  const screen = fs.readFileSync(path.join(__dirname, '../frontend/src/features/admin/topochain/text-translations.tsx'), 'utf8');
  assert.match(screen, /\{write \? \(\n\s+<div className="mt-2 flex flex-wrap gap-2">/);
  assert.equal((screen.match(/<button/g) || []).length, 5, 'all five buttons sit inside that one gate');
  const gated = screen.slice(screen.indexOf('{write ? ('));
  assert.equal((gated.match(/<button/g) || []).length, 5);
});

// ── Challenges, seasons and season events (#4814) ────────────────────────

const programmePool = ({ rows = [], locale = null } = {}) => {
  const base = fakePool({ rows });
  const query = base.query;
  base.reads = [];
  base.query = async (sql, params = []) => {
    base.reads.push(sql);
    if (/FROM challenges/.test(sql)) {
      return { rows: [{ goal: null, task: 'Use any app', description: null, requirements: null, reward_logic: null, cta_button: null, cta_label: null, mobile_cta_label: null, metric_label: null,
        t_goal: 'Use apps for 10 minutes', t_task: 'Template task', t_description: 'Any apps, any mix.', t_requirements: null, t_reward_logic: null, t_cta_button: null, t_cta_label: 'Browse apps', t_mobile_cta_label: null, t_metric_label: '42' }] };
    }
    if (/FROM season_events/.test(sql)) return { rows: [{ name: 'Week one', description: 'Any apps, any mix.', disclaimer: null }] };
    if (/FROM seasons/.test(sql)) return { rows: [{ name: 'Season one', description: null }] };
    if (/FROM users/.test(sql)) return { rows: [{ locale }] };
    if (/source_key = ANY/.test(sql)) {
      return { rows: [...base.table.values()].filter((r) => r.language === params[0] && params[1].includes(r.source_key)) };
    }
    return query(sql, params);
  };
  return base;
};
const textKey = (english) => `text:${packs.hash(english)}`;

test('the text to translate is what a reader sees: a challenge\'s own words over its template\'s, each once', async () => {
  const messages = await service.sources(programmePool());
  const programme = messages.filter((m) => m.group === 'programme');
  const english = programme.map((m) => m.english).sort();
  assert.deepEqual(english, ['Any apps, any mix.', 'Browse apps', 'Season one', 'Use any app', 'Use apps for 10 minutes', 'Week one']);
  assert.equal(english.includes('Template task'), false, 'the challenge overrides its template\'s task');
  assert.equal(english.includes('42'), false, 'nothing without a letter is sent to be translated');
  for (const message of programme) {
    assert.equal(message.key, textKey(message.english));
    assert.equal(message.reviewRequired, false);
    assert.ok(message.description);
  }
  assert.equal(messages.find((m) => m.key === 'app-version:default:must').group, 'update-prompts');
});

test('a response\'s strings are swapped wherever they sit, and nothing else in it moves', async () => {
  const pool = programmePool({ rows: [
    row(textKey('Browse apps'), 'id', 'Browse apps', 'Jelajahi aplikasi'),
    row(textKey('Week one'), 'id', 'Older', 'Basi'),
  ] });
  const body = {
    success: true,
    data: [{ id: 7, reward: '500 pts', card_preview: { goal: 'Browse apps' }, detail_modal: { cta_label: 'Browse apps', cta_link: '#apps' }, event_name: 'Week one', flags: [true, null, 3] }],
  };
  const out = await service.translatePayload(pool, body, 'id');
  assert.deepEqual(out, {
    success: true,
    data: [{ id: 7, reward: '500 pts', card_preview: { goal: 'Jelajahi aplikasi' }, detail_modal: { cta_label: 'Jelajahi aplikasi', cta_link: '#apps' }, event_name: 'Week one', flags: [true, null, 3] }],
  });
  assert.equal(body.data[0].card_preview.goal, 'Browse apps', 'the object handed in is left alone');
});

test('a read that fails hands the payload back in English, and English reads nothing', async () => {
  const body = { goal: 'Browse apps' };
  assert.deepEqual(await service.translatePayload(fakePool({ failReads: true }), body, 'id'), body);
  const pool = { query: async () => { throw new Error('must not read'); } };
  assert.equal(await service.translatePayload(pool, body, null), body);
});

function fakeResponse() {
  const res = { sent: null, varied: [], statusCode: 200, json(body) { res.sent = body; return res; }, vary(field) { res.varied.push(field); return res; } };
  return res;
}
const run = async (pool, req, body, statusCode = 200) => {
  const res = fakeResponse();
  res.statusCode = statusCode;
  await new Promise((done) => {
    const original = res.json;
    res.json = (sent) => { const out = original(sent); done(); return out; };
    const wrapped = res.json;
    service.translatedReads(pool, { source: { files: { 'config.json': { languages: { en: 'English', id: 'Bahasa Indonesia', fr: 'Français' } } } } })(req, res, () => {
      assert.notEqual(res.json, wrapped);
      res.json(body);
    });
  });
  return res;
};
const browse = () => [row(textKey('Browse apps'), 'id', 'Browse apps', 'Jelajahi aplikasi'), row(textKey('Browse apps'), 'fr', 'Browse apps', 'Parcourir')];
const headers = (accept) => ({ get: (name) => (name === 'accept-language' ? accept : undefined) });

test('a signed-in reader gets the language they chose in Settings, over the browser\'s', async () => {
  const pool = programmePool({ rows: browse(), locale: 'id' });
  const res = await run(pool, { user: { id: 3 }, query: {}, ...headers('fr') }, { goal: 'Browse apps' });
  assert.deepEqual(res.sent, { goal: 'Jelajahi aplikasi' });
  assert.deepEqual(res.varied, ['Accept-Language']);
});

test('someone with no choice in Settings, or signed out, gets the browser\'s language', async () => {
  const pool = programmePool({ rows: browse(), locale: null });
  assert.deepEqual((await run(pool, { user: { id: 3 }, query: {}, ...headers('fr-CA') }, { goal: 'Browse apps' })).sent, { goal: 'Parcourir' });
  assert.deepEqual((await run(pool, { query: {}, ...headers('id') }, { goal: 'Browse apps' })).sent, { goal: 'Jelajahi aplikasi' });
});

test('an error answer goes out as it is, and a failed language read answers in English', async () => {
  const pool = programmePool({ rows: browse(), locale: 'id' });
  const refused = await run(pool, { user: { id: 3 }, query: {}, ...headers('id') }, { error: 'Browse apps' }, 404);
  assert.deepEqual(refused.sent, { error: 'Browse apps' });
  const down = await run(fakePool({ failReads: true }), { user: { id: 3 }, query: {}, ...headers(undefined) }, { goal: 'Browse apps' });
  assert.deepEqual(down.sent, { goal: 'Browse apps' });
});

test('a pass asks for at most its share of what is owed, the update prompts first', async () => {
  const pool = programmePool();
  const many = [];
  for (let i = 0; i < 400; i += 1) many.push({ goal: `Goal number ${i}` });
  const query = pool.query;
  pool.query = async (sql, params) => (/FROM challenges/.test(sql) ? { rows: many } : query(sql, params));
  const model = fakeModel();
  const out = await service.runOnce({ pool, deps: { source, llm: model, limits: budget() } });
  const asked = model.calls[0].flatMap((request) => request.items);
  assert.equal(asked.length, 300);
  assert.equal(out.saved, 300);
  assert.equal(asked[0].key, 'app-version:default:must');
});

test('each challenge read and the home panels are wrapped; the admin\'s own reads never are', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const mobile = read('src/routes/topochain/mobile.js');
  for (const route of ['/api/v4/mobile/challenges', '/api/v4/mobile/seasons', '/api/v4/mobile/me/breakdown', '/challenges-api/challenges', '/challenges-api/seasons', '/challenges-api/me/breakdown']) {
    assert.ok(mobile.includes(`'${route}'`), route);
  }
  assert.match(mobile, /\]\) router\.use\(path, translated\);/);
  assert.ok(mobile.indexOf('router.use(path, translated)') < mobile.indexOf("router.get('/api/v4/mobile/me'"), 'mounted ahead of the routes');
  const pub = read('src/routes/topochain/public.js');
  for (const route of ['/api/v4/season-events', '/api/v4/season-history', '/api/v4/season-events/:seasonEventId', '/api/v4/season-events/:seasonEventId/challenges']) {
    assert.ok(pub.includes(`router.get('${route}', translated,`), route);
  }
  assert.ok(read('src/routes/home-panels.js').includes("router.get('/api/home-panels', translated,"));
  assert.doesNotMatch(read('src/routes/topochain/admin/challenges.js'), /translatedReads/);
});
