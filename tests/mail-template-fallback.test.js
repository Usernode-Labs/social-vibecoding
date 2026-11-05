'use strict';

// The send path over the stored templates, and the owner's order for when they
// cannot be had: the last copy this server loaded; else a plain message if the
// mail carries a code or a link, with an error logged; else nothing, recorded as
// no_template. A mistake here stops sign-in mail, so these go through
// mail.send and a transport that renders as the real ones do.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dbPool = require('../src/db/pool');
const log = require('../src/services/logger');
const mail = require('../src/services/mail');
const store = require('../src/services/mail/template-store');
const brevo = require('../src/services/mail/transports/brevo');
const languageCache = require('../src/services/language-cache');
const { READ_PATIENCE_MS } = require('../src/services/mail/language');
const { reset } = require('../src/services/push-language');
const { buildMessage, KINDS } = require('../src/services/mail/templates');
const { ACTIONS } = require('../src/services/mail/actions');
const { SEEDS, englishTemplate, seededLayout } = require('../src/db/email-template-seeds');
const { hash } = require('../scripts/language-packs');

const ROOT = path.join(__dirname, '..');
const ENGLISH = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/locales/en/email.json'), 'utf8'));
const SOURCE = {
  files: {
    'config.json': { sourceLanguage: 'en', languages: { en: 'English', fr: 'Français' } },
    'glossary.json': { doNotTranslate: ['Homeroom'] },
    'en/email.json': ENGLISH,
  },
};
const UNSUBSCRIBE = 'https://app.onhomeroom.com/mail/unsubscribe?token=abc';

function seededRows() {
  const templates = KINDS.map((kind, i) => {
    const { name, layout, ...fields } = englishTemplate(kind);
    return { id: i + 1, action: kind, name, layout_family_id: layout ? 1 : null, translations: {}, ...fields };
  });
  const layout = seededLayout(SEEDS.layouts[0].name);
  return { templates, layouts: [{ id: 1, family_id: 1, name: layout.name, html: layout.html, text: layout.text, translations: {} }] };
}

/** A database holding `state`, which a test changes as it goes. */
function poolWith(state = seededRows()) {
  const db = { ...state, down: false, hang: false, loads: 0, statements: [], deliveries: [], translationReads: 0, translations: [] };
  const query = async (sql, params) => {
    db.statements.push(sql);
    // Down is the whole database: suppressions, history and the ledger too.
    if (db.everything && db.down) throw new Error('connection refused');
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
    if (/FROM email_templates/.test(sql)) {
      db.loads += 1;
      if (db.hang) await new Promise(() => {});
      if (db.down) throw new Error('connection refused');
      return { rows: db.templates };
    }
    if (/FROM email_layouts/.test(sql)) {
      if (db.down) throw new Error('connection refused');
      return { rows: db.layouts };
    }
    if (/INSERT INTO mail_deliveries/.test(sql)) {
      db.deliveries.push({ kind: params[0], recipient: params[1], status: params[3], error: params[4] });
      return { rows: [{ id: db.deliveries.length }] };
    }
    if (/FROM language_translations/.test(sql)) {
      db.translationReads += 1;
      return { rows: db.translations.filter((row) => row.language === params[0]) };
    }
    return { rows: [], rowCount: 0 };
  };
  return { db, query, connect: async () => { if (db.down) throw new Error('connection refused'); return { query, release() {} }; } };
}

function door(t, pool, extra = {}) {
  t.mock.method(dbPool, 'getPool', () => pool);
  const sends = [];
  const rendered = [];
  return {
    sends,
    rendered,
    config: {
      databaseUrl: 'x',
      mailStagingLogOnly: false,
      mailTransport: {
        provider: 'test',
        // What a real transport does: renders from what it is handed.
        async send({ to, kind, ...payload }) { sends.push({ to, kind, ...payload }); rendered.push(buildMessage(kind, payload)); },
      },
      ...extra,
    },
  };
}
// The patience timers are unref'd, as a live server needs nothing else to stay
// up. A test waiting on one, with a read that never answers, does: with only that
// timer the event loop empties and node:test cancels the rest of the file
// (Node 22, the platform's). So such a test holds this for as long as it runs.
function keepAlive(t) {
  const timer = setInterval(() => {}, 50);
  t.after(() => clearInterval(timer));
}
const errorsLogged = (t) => t.mock.method(log, 'error', () => {});
const messagesOf = (spy) => spy.mock.calls.map((call) => call.arguments[1]);

const SAMPLES = {
  otp: { code: '123456' },
  password_reset: { url: 'https://app.onhomeroom.com/#reset-password/abc' },
  waitlist_released: { url: 'https://app.onhomeroom.com/?signup=1&t=a', hasAccount: false },
  project_opened: { appName: 'Run Club', url: 'https://x.test/app', unsubscribeUrl: UNSUBSCRIBE },
  build_ready: { appName: 'Run Club', url: 'https://x.test/app', unsubscribeUrl: UNSUBSCRIBE },
  invite_activity: { appName: 'Run Club', line: '@sam joined.', url: 'https://x.test/app', unsubscribeUrl: UNSUBSCRIBE },
};

test.beforeEach(() => reset());

// ── The everyday path ────────────────────────────────────────────────────

test('a send uses the stored template, and what is stored is what goes out', async (t) => {
  const pool = poolWith();
  pool.db.templates = pool.db.templates.map((row) => (row.action === 'otp' ? { ...row, subject: 'Edited {{code}}' } : row));
  const { config, rendered } = door(t, pool);
  await mail.sendOtpMail(config, 'a@example.com', '123456');
  assert.equal(rendered[0].subject, 'Edited 123456');
  assert.equal(pool.db.deliveries[0].status, 'sent');
  assert.ok(pool.db.statements.some((sql) => /REPEATABLE READ/.test(sql)), 'one consistent view of both tables');
});

test('every kind through the door matches what the code renders today, from the seeded rows', async (t) => {
  // A wording edited in the catalog after the first seed reaches this comparison
  // too, as it does the seeded rows of a fresh database, so a seed that stops
  // matching the code fails here. A running system sends its stored rows.
  const pool = poolWith();
  const { config, rendered } = door(t, pool);
  const payloads = {
    otp: { code: '123456' }, account_email: { code: '123456' }, username_change: { code: '123456' },
    waitlist_joined: { code: '123456', confirmUrl: 'https://x.test/c' },
    waitlist_code: { code: '123456', confirmUrl: 'https://x.test/c' },
    waitlist_released: { url: 'https://x.test/', mobile: { ios: 'https://x.test/i', android: 'https://x.test/a' } },
    password_reset: { url: 'https://x.test/r' },
    admin_test: { provider: 'test', from: 'a@b.c', sentAt: 'now', reference: 'r' },
    content_report: { reason: 'spam', targetType: 'app', targetLabel: 'T', reporter: 'u', caseId: 1, reportId: 2, url: 'https://x.test/m' },
    project_invite: { inviter: 'Sam', project: 'P', url: 'https://x.test/w' },
    ...Object.fromEntries(['build_ready', 'invite_activity', 'project_opened'].map((kind) => [kind, SAMPLES[kind]])),
  };
  assert.deepEqual(Object.keys(payloads).sort(), [...KINDS].sort());
  for (const [i, kind] of KINDS.entries()) {
    await mail.send(config, { kind, to: `k${i}@example.com`, ...payloads[kind] });
    const { html, text, subject, headers } = buildMessage(kind, payloads[kind]);
    assert.deepEqual({ html: rendered[i].html, text: rendered[i].text, subject: rendered[i].subject, headers: rendered[i].headers }, { html, text, subject, headers }, kind);
  }
});

test('the code and links a mail exists to carry reach the transport from the stored template', async (t) => {
  const { config, rendered } = door(t, poolWith());
  await mail.sendOtpMail(config, 'a@example.com', '123456');
  await mail.sendPasswordResetMail(config, 'b@example.com', 'tok');
  await mail.send(config, { kind: 'project_opened', to: 'c@example.com', ...SAMPLES.project_opened });
  assert.match(rendered[0].text, /123456/);
  assert.match(rendered[0].html, /123456/);
  assert.match(rendered[1].text, /#reset-password\/tok/);
  assert.match(rendered[2].html, /unsubscribe/);
  assert.equal(rendered[2].headers['List-Unsubscribe'], `<${UNSUBSCRIBE}>`);
});

test('a mail that is not going out reads no templates', async (t) => {
  const pool = poolWith();
  const { config } = door(t, pool, { mailTransport: null });
  t.mock.method(log, 'info', () => {});
  await mail.sendOtpMail(config, 'a@example.com', '123456');
  assert.equal(pool.db.loads, 0);
  assert.equal(pool.db.deliveries[0].status, 'no_transport');
});

// ── The failure order ────────────────────────────────────────────────────

test('database down with a loaded snapshot uses it', async (t) => {
  const pool = poolWith();
  pool.db.templates = pool.db.templates.map((row) => (row.action === 'otp' ? { ...row, subject: 'Loaded {{code}}' } : row));
  const { config, rendered } = door(t, pool);
  const errors = errorsLogged(t);
  await store.getSnapshot(pool);
  pool.db.down = true;
  await mail.sendOtpMail(config, 'a@example.com', '123456');
  assert.equal(rendered[0].subject, 'Loaded 123456');
  assert.ok(!messagesOf(errors).some((message) => /plain/.test(message)));
});

test('no snapshot and otp sends a plain mail with the code and logs an error', async (t) => {
  // The whole database is down: the suppression list, the throttle's history and
  // the ledger cannot be read or written either, and the code still goes out.
  const pool = poolWith();
  pool.db.down = true;
  pool.db.everything = true;
  t.mock.method(log, 'warn', () => {});
  const { config, rendered } = door(t, pool);
  const errors = errorsLogged(t);
  assert.equal(await mail.sendOtpMail(config, 'a@example.com', '123456'), undefined);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].subject, 'Homeroom');
  assert.match(rendered[0].text, /123456/);
  assert.match(rendered[0].html, /123456/);
  assert.doesNotMatch(rendered[0].html, /<html|<body/i);
  assert.ok(messagesOf(errors).some((message) => /plain/.test(message)), 'logged as an error');
  assert.ok(errors.mock.calls.every((call) => !JSON.stringify(call.arguments).includes('123456')), 'the code is never logged');
});

test('no snapshot and a link mail sends a plain mail with the link', async (t) => {
  const pool = poolWith();
  pool.db.down = true;
  const { config, rendered } = door(t, pool);
  errorsLogged(t);
  await mail.sendPasswordResetMail(config, 'a@example.com', 'tok');
  assert.match(rendered[0].text, /https:\/\/[^\s]+#reset-password\/tok/);
  assert.match(rendered[0].html, /<a href="https:\/\/[^"]+#reset-password\/tok"/);
  // A link that is not plain http(s) is not a link to send.
  await mail.send(config, { kind: 'password_reset', to: 'b@example.com', url: 'javascript:alert(1)' });
  assert.equal(rendered.length, 1);
  assert.equal(pool.db.deliveries.at(-1).status, 'no_template');
});

for (const kind of ['project_opened', 'build_ready', 'invite_activity']) {
  test(`no snapshot and ${kind} sends nothing, records status 'no_template' and logs`, async (t) => {
    const pool = poolWith();
    const { config, rendered } = door(t, pool);
    pool.connect = async () => { throw new Error('connection refused'); };
    const errors = errorsLogged(t);
    assert.equal(await mail.send(config, { kind, to: 'a@example.com', ...SAMPLES[kind] }), undefined);
    assert.equal(rendered.length, 0);
    assert.deepEqual(pool.db.deliveries.map((row) => row.status), ['no_template']);
    assert.ok(messagesOf(errors).some((message) => /template/i.test(message)));
  });
}

test('a mail with neither a code nor a link sends nothing', async (t) => {
  const pool = poolWith();
  const { config, rendered } = door(t, pool);
  pool.connect = async () => { throw new Error('connection refused'); };
  errorsLogged(t);
  await mail.sendWaitlistCodeMail(config, 'a@example.com', { confirmed: false });
  assert.equal(rendered.length, 0);
  assert.deepEqual(pool.db.deliveries.map((row) => row.status), ['no_template']);
});

test('a template that throws on render goes the same way', async (t) => {
  const pool = poolWith();
  pool.db.templates = pool.db.templates.map((row) => ({ ...row, html: '{{#if broken}}' }));
  const { config, rendered } = door(t, pool);
  const errors = errorsLogged(t);
  assert.equal(await mail.sendOtpMail(config, 'a@example.com', '123456'), undefined);
  assert.equal(rendered.length, 1);
  assert.match(rendered[0].text, /123456/);
  assert.ok(messagesOf(errors).some((message) => /plain/.test(message)));
  assert.equal(await mail.send(config, { kind: 'project_opened', to: 'b@example.com', ...SAMPLES.project_opened }), undefined);
  assert.equal(rendered.length, 1);
  assert.equal(pool.db.deliveries.at(-1).status, 'no_template');
});

test('a kind missing from an otherwise good snapshot goes the same way', async (t) => {
  const pool = poolWith();
  pool.db.templates = pool.db.templates.filter((row) => row.action !== 'otp');
  const { config, rendered } = door(t, pool);
  errorsLogged(t);
  await mail.sendOtpMail(config, 'a@example.com', '123456');
  assert.match(rendered[0].text, /123456/);
  assert.equal(rendered[0].subject, 'Homeroom');
});

test('send() still resolves undefined, whatever happens, and an unknown kind reads nothing', async (t) => {
  const pool = poolWith();
  const { config, rendered } = door(t, pool);
  errorsLogged(t);
  assert.equal(await mail.send(config, { kind: 'nope', to: 'a@example.com' }), undefined);
  assert.equal(await mail.send(config, { kind: 'constructor', to: 'a@example.com' }), undefined);
  assert.equal(rendered.length, 0);
  assert.equal(pool.db.loads, 0);
  assert.deepEqual(pool.db.deliveries, []);
  assert.equal(await mail.send(config, { kind: 'otp', to: 'a@example.com', code: '1' }), undefined);
  pool.db.down = true;
  assert.equal(await mail.send(config, { kind: 'otp', to: 'b@example.com', code: '1' }), undefined);
});

test('buildMessage given resolved never falls through to the code templates', () => {
  assert.throws(() => buildMessage('project_opened', { ...SAMPLES.project_opened, resolved: { template: null, layout: null } }), { code: 'no_template' });
  const plain = buildMessage('otp', { code: '1', resolved: { template: null, layout: null } });
  assert.equal(plain.subject, 'Homeroom');
  assert.notEqual(plain.subject, buildMessage('otp', { code: '1' }).subject);
  assert.throws(() => buildMessage('nope', { resolved: { template: null, layout: null } }), /unknown mail kind/);
});

test('a plain mail keeps what a transport and the headers need', () => {
  const { why, preheader, resolved, translate, ...rest } = buildMessage('otp', { code: '1', resolved: { template: null, layout: null } });
  assert.equal(why, undefined);
  assert.equal(preheader, undefined);
  assert.equal(resolved, undefined);
  assert.equal(translate, undefined);
  assert.equal(typeof rest.html, 'string');
  assert.equal(typeof rest.text, 'string');
});

// ── The reader's language ────────────────────────────────────────────────

test('a reader with a language and no row gets the English row with its subject cleaned', async (t) => {
  t.mock.method(languageCache, 'readSource', () => SOURCE);
  const pool = poolWith();
  const { config, rendered } = door(t, pool);
  await mail.send(config, { kind: 'project_invite', to: 'a@example.com', locale: 'fr', project: 'A  B\nBcc: x@y.z', url: 'https://x.test/w' });
  assert.equal(rendered[0].subject, 'Someone invited you to A B Bcc: x@y.z on Homeroom');
  await mail.send(config, { kind: 'project_invite', to: 'b@example.com', locale: 'en', project: 'A  B', url: 'https://x.test/w' });
  assert.match(rendered[1].subject, /A {2}B/);
  await mail.send(config, { kind: 'project_invite', to: 'c@example.com', project: 'A  B', url: 'https://x.test/w' });
  assert.match(rendered[2].subject, /A {2}B/);
  assert.equal(pool.db.translationReads, 0, 'no row means no translator to read');
});

test('a regional language tag finds its language\'s row, and a login code asks no translator', async (t) => {
  t.mock.method(languageCache, 'readSource', () => SOURCE);
  const pool = poolWith();
  pool.db.templates = pool.db.templates.map((row) => (row.action === 'otp'
    ? { ...row, translations: { fr: { subject: 'Votre code', preheader: '', why: 'Pourquoi', html: '<p>{{code}}</p>', text: 'Code {{code}}' } } }
    : row));
  const { config, rendered } = door(t, pool);
  await mail.send(config, { kind: 'otp', to: 'a@example.com', locale: 'fr-CA', code: '123456' });
  assert.equal(rendered[0].subject, 'Votre code');
  assert.match(rendered[0].text, /Code 123456/);
  assert.equal(pool.db.translationReads, 0);
});

const frenchBuildReady = (row) => (row.action === 'build_ready'
  ? { ...row, translations: { fr: { subject: '{{subject}}', preheader: '', why: 'Pourquoi', html: '<h1>{{lead}}</h1><a href="{{url}}">x</a> <a href="{{unsubscribeUrl}}">y</a>', text: '{{lead}} {{url}} {{unsubscribeUrl}}' } } }
  : row);

test('the words built in code come from the catalog through the translator, for a translated row', async (t) => {
  t.mock.method(languageCache, 'readSource', () => SOURCE);
  const pool = poolWith();
  pool.db.templates = pool.db.templates.map(frenchBuildReady);
  pool.db.translations = [{ language: 'fr', key: 'buildReady.lead.ready', source: hash(ENGLISH['buildReady.lead.ready'].text), text: 'C\'est prêt.' }];
  const { config, rendered } = door(t, pool);
  await mail.send(config, { kind: 'build_ready', to: 'a@example.com', locale: 'fr', ...SAMPLES.build_ready });
  assert.equal(pool.db.translationReads, 1);
  assert.match(rendered[0].text, /^C'est prêt\./);
  assert.match(rendered[0].html, new RegExp(UNSUBSCRIBE.replace(/[?]/g, '\\?')));
});

test('a translator read that never answers costs its words only, within the patience', async (t) => {
  keepAlive(t);
  t.mock.method(languageCache, 'readSource', () => SOURCE);
  const pool = poolWith();
  pool.db.templates = pool.db.templates.map(frenchBuildReady);
  const realQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/FROM language_translations/.test(sql)) await new Promise(() => {});
    return realQuery(sql, params);
  };
  const { config, rendered } = door(t, pool);
  const started = Date.now();
  await mail.send(config, { kind: 'build_ready', to: 'a@example.com', locale: 'fr', ...SAMPLES.build_ready });
  assert.ok(Date.now() - started < READ_PATIENCE_MS * 5);
  assert.match(rendered[0].text, new RegExp(ENGLISH['buildReady.lead.ready'].text.replace(/[.]/g, '\\.')));
});

// ── Nothing carries the templates anywhere it should not go ──────────────

test('resolved never reaches a provider\'s params or a log line', async (t) => {
  const posted = [];
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    posted.push(JSON.parse(init.body));
    return { ok: true, status: 201, text: async () => '{"messageId":"<m@x>"}' };
  });
  const transport = brevo.create({ BREVO_API_KEY: 'k' }, { sender: 'Homeroom <a@b.c>' });
  const { config } = door(t, poolWith(), { mailTransport: transport });
  await mail.sendOtpMail(config, 'a@example.com', '123456');
  assert.equal(posted[0].templateId, undefined);
  assert.equal(posted[0].params, undefined);
  assert.doesNotMatch(JSON.stringify(posted[0]), /"resolved"/);

  t.mock.method(languageCache, 'readSource', () => SOURCE);
  await mail.send(config, { kind: 'otp', to: 'b@example.com', locale: 'fr', code: '1' });
  assert.equal(posted[1].templateId, undefined);

  const lines = [];
  for (const level of ['info', 'warn', 'error']) t.mock.method(log, level, (...args) => { lines.push(JSON.stringify(args)); });
  await mail.send({ databaseUrl: 'x', mailTransport: null }, { kind: 'otp', to: 'c@example.com', code: '1' });
  const logTransport = require('../src/services/mail/transports/log').create();
  await mail.send({ databaseUrl: 'x', mailStagingLogOnly: true, mailTransport: logTransport }, { kind: 'otp', to: 'd@example.com', code: '1' });
  assert.ok(lines.length >= 2);
  for (const line of lines) assert.doesNotMatch(line, /resolved|<!doctype/i);
});

// ── The admin's test mail ────────────────────────────────────────────────

test('sendTest goes the same way and reports the words it rendered', async (t) => {
  const pool = poolWith();
  pool.db.templates = pool.db.templates.map((row) => (row.action === 'admin_test' ? { ...row, subject: 'Edited {{reference}}', text: 'Body {{provider}}' } : row));
  const { config, rendered } = door(t, pool);
  const outcome = await mail.sendTest(config, { to: 'a@example.com' });
  assert.equal(outcome.status, 'sent');
  assert.equal(outcome.message.subject, `Edited ${outcome.reference}`);
  assert.match(outcome.message.text, /^Body test/);
  assert.equal(rendered[0].subject, outcome.message.subject);
  assert.equal(rendered[0].text, outcome.message.text);
});

test('sendTest with no template says so and sends nothing', async (t) => {
  const pool = poolWith();
  const { config, rendered } = door(t, pool);
  pool.connect = async () => { throw new Error('connection refused'); };
  errorsLogged(t);
  const outcome = await mail.sendTest(config, { to: 'a@example.com' });
  assert.equal(outcome.status, 'no_template');
  assert.match(outcome.error, /template/i);
  assert.equal(outcome.message, null);
  assert.equal(rendered.length, 0);
  assert.equal(pool.db.deliveries[0].status, 'no_template');
});

// ── getSnapshot ──────────────────────────────────────────────────────────

test('getSnapshot: memory first, and after 30 seconds an edit is on the very next send', async () => {
  const pool = poolWith();
  let now = 1000;
  const clock = { now: () => now };
  const first = await store.getSnapshot(pool, clock);
  assert.equal(first.templates.otp.action, 'otp');
  assert.equal(pool.db.loads, 1);
  now += 29000;
  assert.equal(await store.getSnapshot(pool, clock), first);
  assert.equal(pool.db.loads, 1);
  // A quiet process: the first send after the 30 seconds, however long after,
  // gets the edit when the database answers in time.
  now += 10 * 60 * 1000;
  pool.db.templates = pool.db.templates.map((row) => (row.action === 'otp' ? { ...row, subject: 'New' } : row));
  assert.equal((await store.getSnapshot(pool, clock)).templates.otp.subject, 'New');
  assert.equal(pool.db.loads, 2);
});

test('getSnapshot: a refresh that does not answer in time sends the copy in hand, within the patience', async (t) => {
  keepAlive(t);
  t.mock.method(log, 'error', () => {});
  const pool = poolWith();
  let now = 1000;
  const clock = { now: () => now };
  const good = await store.getSnapshot(pool, clock);
  now += 31000;
  pool.db.hang = true;
  const started = Date.now();
  assert.equal(await store.getSnapshot(pool, clock), good);
  assert.ok(Date.now() - started < READ_PATIENCE_MS * 5);
  assert.equal(pool.db.loads, 2);
  assert.equal(await store.getSnapshot(pool, clock), good, 'and does not start a second read meanwhile');
  assert.equal(pool.db.loads, 2);
});

test('getSnapshot: a load that goes wrong past its own handlers is never an unhandled rejection', async (t) => {
  const unhandled = [];
  const onUnhandled = (err) => { unhandled.push(err); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const logged = t.mock.method(log, 'error', () => { throw new Error('the logger broke'); });
  const pool = poolWith();
  pool.db.down = true;
  assert.equal(await store.getSnapshot(pool), null);
  await store.settled(pool);
  await new Promise((done) => setImmediate(done));
  assert.ok(logged.mock.callCount() >= 1);
  assert.deepEqual(unhandled, []);
});

test('getSnapshot: no pool, a failed first read and a hung first read are null, never a rejection', async (t) => {
  keepAlive(t);
  assert.equal(await store.getSnapshot(null), null);
  t.mock.method(log, 'error', () => {});
  const down = poolWith();
  down.db.down = true;
  assert.equal(await store.getSnapshot(down), null);
  assert.equal(await store.getSnapshot({ }), null, 'not even a pool');
  const hung = poolWith();
  hung.db.hang = true;
  const started = Date.now();
  assert.equal(await store.getSnapshot(hung), null);
  assert.ok(Date.now() - started < READ_PATIENCE_MS * 5);
});

test('getSnapshot: a load that hangs does not hold the door for ever', async (t) => {
  t.mock.method(log, 'error', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pool = poolWith();
  pool.db.hang = true;
  const waiting = store.getSnapshot(pool);
  await new Promise((done) => setImmediate(done));
  t.mock.timers.tick(READ_PATIENCE_MS);
  assert.equal(await waiting, null);
  assert.equal(pool.db.loads, 1);
  t.mock.timers.tick(store.LOAD_LIMIT_MS);
  await store.settled(pool);
  pool.db.hang = false;
  const again = store.getSnapshot(pool);
  await new Promise((done) => setImmediate(done));
  t.mock.timers.tick(READ_PATIENCE_MS);
  assert.ok(await again);
  assert.equal(pool.db.loads, 2);
});

test('getSnapshot: an empty first read is not kept, and is asked again after a short wait', async (t) => {
  const errors = errorsLogged(t);
  const pool = poolWith({ templates: [], layouts: [] });
  let now = 1000;
  const clock = { now: () => now };
  assert.equal(await store.getSnapshot(pool, clock), null);
  assert.equal(errors.mock.callCount(), 1, 'one line per read');
  now += store.INCOMPLETE_RETRY_MS - 1;
  assert.equal(await store.getSnapshot(pool, clock), null);
  assert.equal(pool.db.loads, 1, 'not on every send');
  assert.equal(errors.mock.callCount(), 1);
  now += 1;
  const seeded = seededRows();
  pool.db.templates = seeded.templates;
  pool.db.layouts = seeded.layouts;
  assert.equal((await store.getSnapshot(pool, clock)).templates.otp.action, 'otp');
  assert.equal(pool.db.loads, 2);
  now += 29000;
  await store.getSnapshot(pool, clock);
  assert.equal(pool.db.loads, 2, 'now it is good for its 30 seconds');
});

test('getSnapshot: an incomplete read is used for what it has, not kept as good, and re-read after a short wait', async (t) => {
  errorsLogged(t);
  const seeded = seededRows();
  const pool = poolWith({ templates: seeded.templates.filter((row) => row.action !== 'project_opened'), layouts: seeded.layouts });
  let now = 1000;
  const clock = { now: () => now };
  const partial = await store.getSnapshot(pool, clock);
  assert.equal(partial.templates.otp.action, 'otp');
  assert.equal(await store.getSnapshot(pool, clock), partial);
  assert.equal(pool.db.loads, 1);
  now += store.INCOMPLETE_RETRY_MS;
  pool.db.templates = seeded.templates;
  assert.ok((await store.getSnapshot(pool, clock)).templates.project_opened);
  assert.equal(pool.db.loads, 2);
  await store.getSnapshot(pool, clock);
  assert.equal(pool.db.loads, 2);
  // A template without its layout is incomplete too.
  const noLayout = poolWith({ templates: seeded.templates, layouts: [] });
  await store.getSnapshot(noLayout, clock);
  now += store.INCOMPLETE_RETRY_MS;
  await store.getSnapshot(noLayout, clock);
  assert.equal(noLayout.db.loads, 2);
});

test('getSnapshot: at most one load in flight', async () => {
  const pool = poolWith();
  const all = await Promise.all([store.getSnapshot(pool), store.getSnapshot(pool), store.getSnapshot(pool)]);
  assert.equal(pool.db.loads, 1);
  assert.ok(all.every((snapshot) => snapshot && snapshot === all[0]));
});

test('getSnapshot: a failed refresh, or a worse read, keeps the last good snapshot', async (t) => {
  const errors = errorsLogged(t);
  const pool = poolWith();
  let now = 1000;
  const clock = { now: () => now };
  const good = await store.getSnapshot(pool, clock);
  now += 31000;
  pool.db.down = true;
  assert.equal(await store.getSnapshot(pool, clock), good);
  await new Promise((done) => setImmediate(done));
  await store.settled(pool);
  assert.ok(messagesOf(errors).some((message) => /template/i.test(message)));
  assert.equal(await store.getSnapshot(pool, clock), good);

  now += 31000;
  pool.db.down = false;
  pool.db.templates = [];
  assert.equal(await store.getSnapshot(pool, clock), good);
  await new Promise((done) => setImmediate(done));
  await store.settled(pool);
  assert.equal(await store.getSnapshot(pool, clock), good);
});

// ── The rest of the system ───────────────────────────────────────────────

test('the first load starts at server boot, and the migration Job does not try', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /mail\/template-store'\)\.getSnapshot\(getPool\(config\)\)/);
  for (const file of ['scripts/migrate-kubernetes.js', 'src/db/email-template-seeds.js', 'src/db/migrate.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), /getSnapshot/, file);
  }
});

test('build_ready\'s app can carry the catalog\'s word, so it is marked as coming from code', () => {
  assert.equal(ACTIONS.build_ready.placeholders.app.fromCode, true);
  assert.equal(ACTIONS.build_ready.codeWords, true);
  assert.equal(ACTIONS.invite_activity.codeWords, true);
  const usesWords = Object.keys(ACTIONS).filter((kind) => ACTIONS[kind].codeWords);
  assert.deepEqual(usesWords.sort(), ['build_ready', 'invite_activity']);
});

test('with no database configured at all, mail is worded from the first templates in memory', async (t) => {
  const rendered = [];
  const config = { mailStagingLogOnly: false, mailTransport: { provider: 'test', async send({ to, kind, ...payload }) { rendered.push(buildMessage(kind, payload)); } } };
  await mail.sendOtpMail(config, 'a@example.com', '123456');
  await mail.send(config, { kind: 'project_opened', to: 'b@example.com', ...SAMPLES.project_opened });
  assert.deepEqual(rendered[0], buildMessage('otp', { code: '123456' }));
  assert.equal(rendered[1].html, buildMessage('project_opened', SAMPLES.project_opened).html);
  // A configured database that cannot be reached is the failure order, not these.
  const getPool = t.mock.method(dbPool, 'getPool', () => { throw new Error('bad url'); });
  errorsLogged(t);
  await mail.send({ ...config, databaseUrl: 'x' }, { kind: 'project_opened', to: 'c@example.com', ...SAMPLES.project_opened });
  assert.equal(getPool.mock.callCount(), 1);
  assert.equal(rendered.length, 2);
});

test('a stored row shaped as nothing expected is no template, and a login code still goes', async (t) => {
  const pool = poolWith();
  const { config, rendered } = door(t, pool);
  errorsLogged(t);
  t.mock.method(store, 'resolve', () => { throw new Error('unexpected row'); });
  await mail.sendOtpMail(config, 'a@example.com', '123456');
  assert.match(rendered[0].text, /123456/);
});

test('a client whose ROLLBACK failed is not put back in the pool for reuse', async () => {
  const released = [];
  const pool = {
    connect: async () => ({
      query: async (sql) => {
        if (/^ROLLBACK/.test(sql)) throw new Error('connection gone');
        if (/^BEGIN/.test(sql)) return { rows: [] };
        throw new Error('read failed');
      },
      release: (err) => { released.push(err); },
    }),
    query: async () => { throw new Error('read failed'); },
  };
  await assert.rejects(store.snapshot(pool), /read failed/);
  await assert.rejects(store.saveLayout(pool, { name: 'L', html: '{{content}}', text: '{{content}}' }, null), /read failed/);
  assert.equal(released.length, 2);
  for (const err of released) assert.match(String(err && err.message), /connection gone/);
});

test('a client whose transaction rolled back cleanly goes back to the pool', async () => {
  const released = [];
  const pool = {
    connect: async () => ({
      query: async (sql) => { if (/^(BEGIN|ROLLBACK)/.test(sql)) return { rows: [] }; throw new Error('read failed'); },
      release: (err) => { released.push(err); },
    }),
  };
  await assert.rejects(store.snapshot(pool), /read failed/);
  assert.deepEqual(released, [undefined]);
});
