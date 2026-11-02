'use strict';

// A phone push in its recipient's language: the catalog
// (frontend/locales/en/push.json), the lookup (src/services/push-language.js)
// and the worker's use of it. frontend/locales/README.md, "Translations",
// says what wins; these say the push follows it, and that a problem anywhere
// here costs a push its translation, never its delivery.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildLanguagePacks, hash, writeSource } = require('../scripts/language-packs');
const cache = require('../src/services/language-cache');
const { buildMessage, buildNotificationCopy } = require('../src/services/mobile-push-policy');
const { pushTranslator, reset } = require('../src/services/push-language');
const { MobilePushWorker } = require('../src/services/mobile-push-worker');
const { encrypt } = require('../src/services/secrets');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const POLICY = 'src/services/mobile-push-policy.js';
const ENGLISH = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/locales/en/push.json'), 'utf8'));
const NOW = new Date('2026-11-02T12:00:00Z');

const english = (key) => ENGLISH[key].text;
const translated = (key, text) => ({ language: 'es', key, source: hash(english(key)), text });

/** A build's .source.json, with `committed` as its Spanish push catalog. */
function sourceWith(committed = {}) {
  return {
    files: {
      'config.json': {
        sourceLanguage: 'en',
        languages: { en: 'English', es: 'Español', ru: 'Русский', 'pt-BR': 'Português (Brasil)' },
      },
      'glossary.json': { doNotTranslate: ['Homeroom'] },
      'en/push.json': ENGLISH,
      'es/push.json': committed,
    },
  };
}

/** A pool whose language_translations holds `rows`; counts the reads. */
function poolWith(rows = [], { fail = null } = {}) {
  const db = { reads: 0, languages: [] };
  return {
    db,
    async query(sql, params) {
      assert.match(sql, /FROM language_translations/);
      db.reads += 1;
      db.languages.push(params[0]);
      if (fail) throw fail;
      return { rows: rows.filter((row) => row.language === params[0] && (row.namespace || 'push') === params[1]) };
    },
  };
}

test.beforeEach(() => reset());

test('with no language, or English, there is no reading at all and the words are as they were', async () => {
  const pool = poolWith();
  for (const locale of [null, undefined, '']) {
    assert.equal(await pushTranslator(pool, locale, { source: sourceWith() }), null);
  }
  for (const locale of ['en', 'en-GB', 'EN_us']) {
    assert.equal(await pushTranslator(pool, locale, { source: sourceWith() }), null, locale);
  }
  assert.equal(await pushTranslator(pool, 'xx', { source: sourceWith() }), null, 'a language Homeroom does not have');
  assert.equal(pool.db.reads, 0);
  assert.deepEqual(
    buildNotificationCopy('reply', { sourceUsername: 'ada', appName: 'Plant Pal', sessionTitle: 'Watering', messageContent: 'Nice' }, NOW),
    { title: '@ada replied in "Watering" · Plant Pal', body: 'Nice' },
  );
});

test('a translated message has its parameters filled in, joined the same way', async () => {
  const pool = poolWith([
    translated('reply.title.named', '@{{actor}} respondió en «{{title}}»'),
    translated('join.app', '{{title}} en {{app}}'),
    translated('friendRequest.body', 'Acepta o rechaza en Notificaciones'),
  ]);
  const t = await pushTranslator(pool, 'es', { source: sourceWith() });
  assert.deepEqual(
    buildNotificationCopy('reply', { sourceUsername: 'ada', appName: 'Plant Pal', sessionTitle: 'Watering', messageContent: 'Nice' }, NOW, t),
    { title: '@ada respondió en «Watering» en Plant Pal', body: 'Nice' },
  );
  assert.equal(buildNotificationCopy('friend_request', { sourceUsername: 'ada' }, NOW, t).body, 'Acepta o rechaza en Notificaciones');
});

test('a language is matched by its base, and the regional tag is what is read', async () => {
  const pool = poolWith();
  assert.equal(typeof await pushTranslator(pool, 'pt-PT', { source: sourceWith() }), 'function');
  assert.deepEqual(pool.db.languages, ['pt-BR']);
});

test('a message with no translation is English, on its own', async () => {
  const pool = poolWith([translated('friendRequest.body', 'Acepta o rechaza en Notificaciones')]);
  const t = await pushTranslator(pool, 'es', { source: sourceWith() });
  assert.deepEqual(buildNotificationCopy('friend_request', { sourceUsername: 'ada' }, NOW, t), {
    title: message('push:friendRequest.title', { actor: 'ada' }),
    body: 'Acepta o rechaza en Notificaciones',
  });
});

test('a translation of older English is not used, committed or cached', async () => {
  const stale = hash('Some older English');
  const pool = poolWith([
    { language: 'es', key: 'friendRequest.title', source: stale, text: '@{{actor}} VIEJO' },
  ]);
  const t = await pushTranslator(pool, 'es', {
    source: sourceWith({ 'friendRequest.body': { text: 'VIEJO', source: stale } }),
  });
  assert.deepEqual(buildNotificationCopy('friend_request', { sourceUsername: 'ada' }, NOW, t), {
    title: message('push:friendRequest.title', { actor: 'ada' }),
    body: english('friendRequest.body'),
  });
});

test('a committed translation wins over the cache, and one with the wrong parameters is never used', async () => {
  const pool = poolWith([
    translated('friendRequest.title', '@{{actor}} DE LA CACHÉ'),
    translated('friendAccept.title', '@{{nombre}} aceptó'),
  ]);
  const t = await pushTranslator(pool, 'es', {
    source: sourceWith({
      'friendRequest.title': { text: '@{{actor}} COMPROMETIDO', source: hash(english('friendRequest.title')) },
    }),
  });
  assert.equal(buildNotificationCopy('friend_request', { sourceUsername: 'ada' }, NOW, t).title, '@ada COMPROMETIDO');
  assert.equal(buildNotificationCopy('friend_accept', { sourceUsername: 'ada' }, NOW, t).title,
    message('push:friendAccept.title', { actor: 'ada' }));
});

test('a failed cache read is English for what only the cache has, and is not asked again for each message', async () => {
  const pool = poolWith([], { fail: new Error('connection lost') });
  const source = sourceWith({
    'friendRequest.body': { text: 'Acepta o rechaza', source: hash(english('friendRequest.body')) },
  });
  const t = await pushTranslator(pool, 'es', { source, now: 1000 });
  assert.deepEqual(buildNotificationCopy('friend_request', { sourceUsername: 'ada' }, NOW, t), {
    title: message('push:friendRequest.title', { actor: 'ada' }),
    body: 'Acepta o rechaza',
  });
  await pushTranslator(pool, 'es', { source, now: 2000 });
  assert.equal(pool.db.reads, 1);
});

test('a read that fails after a good one keeps what the good one found', async () => {
  const rows = [translated('friendRequest.body', 'Acepta o rechaza')];
  const pool = poolWith(rows);
  const source = sourceWith();
  await pushTranslator(pool, 'es', { source, now: 1000 });
  pool.query = async () => { throw new Error('connection lost'); };
  const t = await pushTranslator(pool, 'es', { source, now: 1000 + cache.VERSION_TTL_MS });
  assert.equal(t('push:friendRequest.body'), 'Acepta o rechaza');
});

test('deliveries share one read: at once, within the memo, and for each language', async () => {
  const pool = poolWith();
  const source = sourceWith();
  await Promise.all(Array.from({ length: 20 }, () => pushTranslator(pool, 'es', { source, now: 1000 })));
  assert.equal(pool.db.reads, 1, 'a batch going out together');
  await pushTranslator(pool, 'es', { source, now: 1000 + cache.VERSION_TTL_MS - 1 });
  assert.equal(pool.db.reads, 1, 'still fresh');
  await pushTranslator(pool, 'es', { source, now: 1000 + cache.VERSION_TTL_MS });
  assert.equal(pool.db.reads, 2, 'a new translation is picked up');
  await pushTranslator(pool, 'ru', { source, now: 1000 + cache.VERSION_TTL_MS });
  assert.equal(pool.db.reads, 3, 'each language has its own');
});

test('a count takes the plural form of the language, and a partial set is English', async () => {
  const forms = (key, one, few, many, other) => [
    { language: 'ru', key: `${key}_one`, source: hash(english(`${key}_one`)), text: one },
    { language: 'ru', key: `${key}_few`, source: hash(english(`${key}_other`)), text: few },
    { language: 'ru', key: `${key}_many`, source: hash(english(`${key}_other`)), text: many },
    { language: 'ru', key: `${key}_other`, source: hash(english(`${key}_other`)), text: other },
  ];
  const pool = poolWith([
    ...forms('voteDigest.title', '{{count}} изменение', '{{count}} изменения', '{{count}} изменений', '{{count}} изменения'),
    { language: 'ru', key: 'stalePr.waiting.body.days_one', source: hash(english('stalePr.waiting.body.days_one')), text: 'день' },
  ]);
  const t = await pushTranslator(pool, 'ru', { source: sourceWith() });
  const title = (count) => buildNotificationCopy('vote_digest', { detail: String(count) }, NOW, t).title;
  assert.equal(title(1), '1 изменение');
  assert.equal(title(3), '3 изменения');
  assert.equal(title(5), '5 изменений');
  assert.equal(title(21), '21 изменение');
  const body = buildNotificationCopy('stale_pr', { promotedAt: new Date(NOW.getTime() - 86400000).toISOString() }, NOW, t).body;
  assert.equal(body, message('push:stalePr.waiting.body.days', { count: 1 }), 'half a set is not used');
});

test('names and quoted words pass through as written, once', async () => {
  const hostile = {
    sourceUsername: '{{message}}$&',
    appName: "{{title}}$1$'",
    messageContent: '{{actor}} costs $& $1 $$',
    sessionTitle: '{{app}}$`',
  };
  const pool = poolWith([
    translated('reply.title.named', '@{{actor}} respondió en «{{title}}»'),
    translated('join.app', '{{title}} en {{app}}'),
    translated('channelMessage.many.body', '{{message}} / @{{actor}}'),
  ]);
  const t = await pushTranslator(pool, 'es', { source: sourceWith() });
  assert.deepEqual(buildNotificationCopy('reply', hostile, NOW), {
    title: '@{{message}}$& replied in "{{app}}$`" · {{title}}$1$\'',
    body: '{{actor}} costs $& $1 $$',
  }, 'in English');
  assert.deepEqual(buildNotificationCopy('reply', hostile, NOW, t), {
    title: '@{{message}}$& respondió en «{{app}}$`» en {{title}}$1$\'',
    body: '{{actor}} costs $& $1 $$',
  }, 'in Spanish');
  assert.equal(
    buildNotificationCopy('channel_message', { ...hostile, detail: '2' }, NOW, t).body,
    '{{actor}} costs $& $1 $$ / @{{message}}$&',
    'a parameter the message places first is not read again for the one after it',
  );
});

test('an admin\'s alert and the bot\'s own words are never translated', async () => {
  const everything = Object.keys(ENGLISH).map((key) => translated(key, 'TRADUCIDO'));
  const t = await pushTranslator(poolWith(everything), 'es', { source: sourceWith() });
  assert.deepEqual(
    buildNotificationCopy('platform_limit', { detail: 'apps_warn:9:10' }, NOW, t),
    buildNotificationCopy('platform_limit', { detail: 'apps_warn:9:10' }, NOW),
  );
  assert.deepEqual(
    buildNotificationCopy('platform_incident', { detail: 'hour:push_failed:12' }, NOW, t),
    buildNotificationCopy('platform_incident', { detail: 'hour:push_failed:12' }, NOW),
  );
  const fromBot = { kind: 'conversation_reply', context: { sourceIsSynthetic: true, sourceUsername: 'homeroom_bot', detail: 'hrbot:reply:', messageContent: 'Done, see the plan.' } };
  assert.deepEqual(buildNotificationCopy(fromBot.kind, fromBot.context, NOW, t), { title: 'Homeroom bot', body: 'Done, see the plan.' });
});

test('a translator that throws, or fills nothing, costs the push its words and not its delivery', () => {
  assert.deepEqual(
    buildNotificationCopy('friend_request', { sourceUsername: 'ada' }, NOW, () => { throw new Error('boom'); }),
    { title: 'Homeroom', body: 'You have new activity' },
  );
  assert.deepEqual(
    buildNotificationCopy('friend_request', { sourceUsername: 'ada' }, NOW, () => ''),
    { title: 'Homeroom', body: 'You have new activity' },
  );
  const sent = buildMessage({
    token: 't', notificationId: 1, kind: 'friend_request', environment: 'production',
    installationId: 'abc', userId: 7, expiresAt: new Date(NOW.getTime() + 60000), now: NOW,
    context: { sourceUsername: 'ada' }, translate: (id) => (id === 'push:friendRequest.title' ? 'hola @ada' : 'cuerpo'),
  });
  assert.deepEqual(sent.notification, { title: 'hola @ada', body: 'cuerpo' });
});

test('the generic wording is a catalog message as well, in the language when it can be', async () => {
  assert.equal(message('push:generic.body'), 'You have new activity');
  const t = await pushTranslator(poolWith([translated('generic.body', 'Tienes actividad nueva')]), 'es', { source: sourceWith() });
  assert.deepEqual(buildNotificationCopy('friend_request', {}, NOW, t), { title: 'Homeroom', body: 'Tienes actividad nueva' });
});

// ── The worker ───────────────────────────────────────────────────────────

const DATA_KEY = 'mobile-push-language-test-key';

function workerFor(row, { translations = [], fail = null } = {}) {
  const calls = { sent: [], finished: [], translationReads: 0 };
  const pool = {
    async query(sql, params) {
      if (sql.includes('FROM notifications AS n')) return { rows: [{ c: 1 }] };
      if (sql.includes('FROM language_translations')) {
        calls.translationReads += 1;
        if (fail) throw fail;
        return { rows: translations.filter((t) => t.language === params[0]) };
      }
      throw new Error(`unexpected pool query: ${sql}`);
    },
  };
  const worker = new MobilePushWorker({
    pool,
    config: { mobilePushEnabled: true, mobilePushEnvironment: 'production', firebaseProjectId: 'p', dataEncryptionKey: DATA_KEY },
    provider: { send: async (sent) => { calls.sent.push(sent); return 'id'; } },
    options: { sendTimeoutMs: 100 },
  });
  worker.loadDelivery = async () => ({
    id: 9, attempts: 1, expires_at: new Date(Date.now() + 60000), delivery_created_at: new Date(Date.now() - 1000),
    notification_id: 42, notification_user_id: 7, kind: 'friend_request', read_at: null,
    push_category: 'social', push_enabled: true, registration_id: 3,
    delivery_environment: 'production', delivery_installation_id: '123e4567-e89b-12d3-a456-426614174000',
    deployment_send_enabled: true, deployment_send_not_before: new Date(Date.now() - 2000), deployment_firebase_project_id: 'p',
    installation_id: '123e4567-e89b-12d3-a456-426614174000', registration_environment: 'production', registration_platform: 'android',
    registration_hash: 'a'.repeat(64), registration_enc: encrypt('token', DATA_KEY), permission_status: 'authorized',
    registration_user_id: 7, registration_session_expires_at: new Date(Date.now() + 60000),
    conversation_id: null, source_username: 'ada',
    ...row,
  });
  worker.finish = async (job, status, code) => { calls.finished.push({ status, code: code || null }); };
  return { worker, calls };
}

test('the worker words a push in the recipient\'s language', async (t) => {
  t.mock.method(cache, 'readSource', () => sourceWith());
  const { worker, calls } = workerFor({ recipient_locale: 'es' }, {
    translations: [translated('friendRequest.title', '@{{actor}} quiere ser tu amigo')],
  });
  await worker.processDelivery({ id: 9, attempts: 1 });
  assert.deepEqual(calls.finished, [{ status: 'sent', code: null }]);
  assert.deepEqual(calls.sent[0].notification, {
    title: '@ada quiere ser tu amigo',
    body: english('friendRequest.body'),
  });
});

test('a recipient with no language, or English, costs the worker no read', async (t) => {
  t.mock.method(cache, 'readSource', () => sourceWith());
  const words = { title: '@ada sent you a friend request', body: 'Accept or decline in Notifications' };
  for (const locale of [null, undefined, 'en']) {
    const { worker, calls } = workerFor({ recipient_locale: locale });
    await worker.processDelivery({ id: 9, attempts: 1 });
    assert.equal(calls.translationReads, 0, String(locale));
    assert.deepEqual(calls.sent[0].notification, words, String(locale));
  }
});

test('a cache that cannot be read costs a delivery nothing', async (t) => {
  t.mock.method(cache, 'readSource', () => sourceWith());
  const { worker, calls } = workerFor({ recipient_locale: 'es' }, { fail: new Error('connection lost') });
  await worker.processDelivery({ id: 9, attempts: 1 });
  assert.deepEqual(calls.finished, [{ status: 'sent', code: null }]);
  assert.equal(calls.sent[0].notification.title, '@ada sent you a friend request');
});

test('a push is delivered, in English, when the lookup itself breaks', async (t) => {
  t.mock.method(cache, 'readSource', () => { throw new Error('no such file'); });
  const { worker, calls } = workerFor({ recipient_locale: 'es' });
  await worker.processDelivery({ id: 9, attempts: 1 });
  assert.deepEqual(calls.finished, [{ status: 'sent', code: null }]);
  assert.equal(calls.sent[0].notification.title, '@ada sent you a friend request');
});

test('the worker reads the recipient\'s language in its one delivery query', () => {
  const worker = fs.readFileSync(path.join(ROOT, 'src/services/mobile-push-worker.js'), 'utf8');
  assert.match(worker, /recipient\.locale AS recipient_locale/);
  assert.match(worker, /LEFT JOIN users recipient ON recipient\.id = n\.user_id/);
});

test('with no frontend/, as in the runtime image, the English is the running build\'s', () => {
  // Without this a push says its generic words to everybody, in production only.
  const preload = `
    const fs = require('node:fs');
    const real = fs.readFileSync;
    fs.readFileSync = (file, ...rest) => {
      if (String(file).endsWith('frontend/locales/en/push.json')) throw new Error('ENOENT');
      return real(file, ...rest);
    };
    const cache = require('./src/services/language-cache');
    cache.readSource = () => ({ files: { 'en/push.json': { 'friendRequest.title': { text: 'FROM THE BUILD @{{actor}}', description: 'x' } } } });
    const { buildNotificationCopy } = require('./src/services/mobile-push-policy');
    process.stdout.write(JSON.stringify(buildNotificationCopy('friend_request', { sourceUsername: 'ada' })));
  `;
  const { stdout, status, stderr } = spawnSync(process.execPath, ['-e', preload], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(status, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { title: 'FROM THE BUILD @ada' });
});

// ── The catalog and the code agree ───────────────────────────────────────

test('every push id in the code is in the catalog whole, and every entry is asked for', () => {
  // scripts/language-inventory.js reads the client sources only, so this is
  // the same check for the server's one reader of this namespace.
  const source = fs.readFileSync(path.join(ROOT, POLICY), 'utf8');
  assert.deepEqual(source.match(/[`"]push:[^`"]*[`"]/g) || [], [], 'an id is one plain quoted literal');
  assert.deepEqual(source.match(/'push:[^']*\$\{[^']*'/g) || [], []);
  const used = new Set([...source.matchAll(/'push:([A-Za-z0-9_.-]+)'/g)].map((match) => match[1]));
  assert.ok(used.size > 50, 'the policy is read');
  const stems = new Set(Object.keys(ENGLISH).map((key) => key.replace(/_(one|other)$/, '')));
  assert.deepEqual([...used].filter((id) => !stems.has(id)), [], 'an id the catalog does not have');
  assert.deepEqual([...stems].filter((id) => !used.has(id)), [], 'an entry nothing asks for');
});

test('the catalog passes the build\'s check and stays out of what a screen loads', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, data) => {
    const target = path.join(root, 'frontend/locales', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(data));
  };
  const texts = { 'tab.home': { text: 'Home', description: 'Tab.' } };
  put('config.json', { sourceLanguage: 'en', minimumCoverage: 0, languages: { en: 'English', es: 'Español' } });
  put('en/core.json', texts);
  put('en/push.json', ENGLISH);
  put('es/core.json', { 'tab.home': { text: 'Inicio', source: hash('Home') } });
  put('es/push.json', { 'friendRequest.body': { text: 'Acepta', source: hash(english('friendRequest.body')) } });
  const { manifest } = buildLanguagePacks(root);
  const generated = JSON.parse(fs.readFileSync(path.join(root, 'frontend/src/lib/i18n/catalogs.generated.json'), 'utf8'));
  assert.deepEqual(generated.namespaces, ['core'], 'the shell does not know this namespace');
  assert.deepEqual(Object.keys(generated.english), ['core'], 'its English is not in the bundle');
  assert.deepEqual(Object.keys(manifest.es), ['core'], 'it has no pack to fetch');
  assert.deepEqual(fs.readdirSync(path.join(root, 'public/locales')).filter((name) => name.includes('.push.')), []);

  const source = JSON.parse(fs.readFileSync(writeSource(root), 'utf8'));
  assert.ok(source.files['en/push.json'], 'the server and the translation step still read it');
  assert.ok(source.files['es/push.json']);

  const live = cache.packsFrom(root);
  assert.deepEqual(live.namespaces, ['core']);
  assert.deepEqual(Object.keys(live.manifest.es), ['core'], 'the live list agrees with the shell, which checks it whole');
  assert.ok(![...live.files.keys()].some((name) => name.includes('.push.')));
});

test('a server-only catalog with nothing translated cannot take a language off the screens', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const packs = require('../scripts/language-packs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-coverage-'));
  try {
    const dir = path.join(root, 'frontend/locales');
    const write = (file, value) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
    };
    write('config.json', { sourceLanguage: 'en', minimumCoverage: 0.95, languages: { en: 'English', fr: 'Français' } });
    const entry = (text) => ({ text, description: 'Somewhere on the screen.' });
    write('en/core.json', { hello: entry('Hello') });
    write('en/push.json', { one: entry('One'), two: entry('Two'), three: entry('Three') });
    write('fr/core.json', { hello: { text: 'Bonjour', source: packs.hash('Hello') } });
    const { config, report } = packs.collectCatalogs(root);
    assert.equal(report.fr.total, 1, 'push is not counted');
    assert.equal(report.fr.translated, 1);
    assert.equal(report.fr.ships, true);
    assert.ok(packs.shippedLanguages(config, report).fr);
    assert.equal(report.fr.missing.length, 3, 'what it lacks is still listed, for the translation step');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
