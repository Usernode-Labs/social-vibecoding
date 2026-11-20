'use strict';

// Three rules that used to hold a change for an admin (20 Nov 2026):
//
//   1. `script`, a <script> from another site, is a failing check instead
//      (src/services/outside-script-check.js): the data rules forbid it, so
//      a vote that could allow it was the wrong tool.
//   2. `people` (it starts keeping data about people) tells the full admins,
//      naming what it keeps: "Stylist now keeps people's email addresses".
//   3. `secret` (it adds a private key for an outside service) tells them
//      too: "Stylist now uses a private key for an outside service".
//
// `wallet` and `content` still hold, and a change that trips either is held
// with the notices among its reasons.
//
// Run with: node --test tests/release-notices-and-script-check.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const check = require('../src/services/outside-script-check');
const holds = require('../src/services/release-holds');
const { ACTIONS } = require('../src/services/mail/actions');
const { buildMessage } = require('../src/services/mail/templates');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// A file's hunk: `lines` are diff lines (' ' context, '+' added, '-' removed).
const file = (name, lines, start = 1) => [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, `@@ -${start},2 +${start},3 @@`, ...lines].join('\n');

function withMode(value, fn) {
  const prev = process.env.OUTSIDE_SCRIPT_CHECK_MODE;
  if (value === undefined) delete process.env.OUTSIDE_SCRIPT_CHECK_MODE; else process.env.OUTSIDE_SCRIPT_CHECK_MODE = value;
  const done = () => { if (prev === undefined) delete process.env.OUTSIDE_SCRIPT_CHECK_MODE; else process.env.OUTSIDE_SCRIPT_CHECK_MODE = prev; };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(done);
    done();
    return out;
  } catch (err) { done(); throw err; }
}

// ── 1. The check ───────────────────────────────────────────────────────

test('the check reads only the lines a change adds, with their line numbers', () => {
  const diff = file('public/index.html', [
    ' <head>',
    '+  <script src="https://cdn.example.com/x.js"></script>',
    '-  <script src="/old.js"></script>',
    '   <title>Hi</title>',
    '+  <script src="//cdn.example.com/y.js"></script>',
  ], 10);
  assert.deepEqual(check.addedLines(diff).map((l) => [l.path, l.line]), [['public/index.html', 11], ['public/index.html', 13]]);
  assert.deepEqual(check.outsideScripts(diff).map((f) => [f.line, f.src]), [[11, 'https://cdn.example.com/x.js'], [13, '//cdn.example.com/y.js']],
    'https:// and protocol-relative // both name another site');
});

test('relative paths and the hosted files pass; a hosted file behind a hostname is named; tests and prose are not read', () => {
  const pass = (lines, name = 'public/index.html') => assert.deepEqual(check.outsideScripts(file(name, lines)), [], lines.join(' '));
  pass(['+<script src="/usernode-bridge/v1/bridge.js"></script>']);
  pass(['+<script src="/usernode-tailwind/v1/tailwind.js"></script>']);
  pass(['+<script src="js/app.js" defer></script>']);
  pass(['+<script type="module" src="./main.js"></script>']);
  pass(['+<script>window.x = "https://example.com"</script>'], 'public/index.html');
  pass(['+<script src="https://cdn.example.com/x.js"></script>'], 'tests/e2e/page.test.js');
  pass(['+<script src="https://cdn.example.com/x.js"></script>'], 'tests/fixtures/page.html');
  pass(['+<script src="https://cdn.example.com/x.js"></script>'], 'README.md');
  const hosted = check.outsideScripts(file('public/index.html', ['+<script src="https://app.onhomeroom.com/usernode-bridge/v1/bridge.js"></script>']));
  assert.equal(hosted.length, 1, 'a hosted file behind a hostname is flagged');
  assert.equal(hosted[0].hosted, '/usernode-bridge/v1/bridge.js');
});

test('a legacy tag already in the app never fails; a newly added one does', () => {
  const legacy = file('public/index.html', [
    '   <script src="https://cdn.tailwindcss.com"></script>',
    '+  <p>A new line</p>',
  ]);
  assert.deepEqual(check.outsideScripts(legacy), [], 'context is not an added line');
  const added = check.outsideScripts(file('public/index.html', ['+  <script src="https://cdn.tailwindcss.com"></script>']));
  assert.equal(added.length, 1, 'a new one fails, as the conventions say: do not add one');
  // A rewrite that re-indents the page shows the old tag removed and added
  // again: it was already in the app, so it passes. A different new one
  // beside it still fails.
  const reindented = file('public/index.html', [
    '-<script src="https://cdn.tailwindcss.com"></script>',
    '+    <script src="https://cdn.tailwindcss.com"></script>',
    '+    <script src="https://cdn.example.com/chart.js"></script>',
  ]);
  assert.deepEqual(check.outsideScripts(reindented).map((f) => f.src), ['https://cdn.example.com/chart.js']);
});

test('the row names the file and line and what to do, and fails the gate when blocking', () => {
  const found = [{ file: 'public/index.html', line: 12, src: 'https://cdn.example.com/x.js', hosted: null }];
  const row = check.shapeRow({ found, checkMode: 'blocking', checkedSha: 'A'.repeat(40) });
  assert.equal(row.name, 'No script from another site');
  assert.equal(row.status, 'fail');
  assert.equal(row.advisory, false, 'it gates the merge like any failing check');
  assert.match(row.failureReason, /public\/index\.html line 12, https:\/\/cdn\.example\.com\/x\.js/);
  assert.match(row.failureReason, /Install it from npm and serve it from the app's own origin\./);
  assert.equal(row.checkedSha, 'a'.repeat(40));
  assert.equal(check.shapeRow({ found, checkMode: 'advisory' }).advisory, true);
  const hosted = check.shapeRow({ found: [{ ...found[0], hosted: '/usernode-bridge/v1/bridge.js' }], checkMode: 'blocking' });
  assert.match(hosted.failureReason, /Load it by its relative path, src="\/usernode-bridge\/v1\/bridge\.js"/);
  const pass = check.shapeRow({ found: [], checkMode: 'blocking' });
  assert.deepEqual([pass.status, pass.advisory, pass.summary], ['pass', true, 'Passes']);
  assert.equal(check.OUTSIDE_SCRIPT_CHECK_INDEX, -8);
  assert.doesNotMatch(row.failureReason, /—/, 'no em dash');
});

test('the run: blocking by default, off is no row, the platform itself is skipped, and a failed read passes open', async () => {
  const diff = file('public/index.html', ['+<script src="https://cdn.example.com/x.js"></script>']);
  const github = { getProposalDiff: async () => ({ diff }) };
  const args = { pool: null, sessionId: 51, appSlug: 'stylist', repoOwner: 'o', repoName: 'r', commitHash: 'e'.repeat(40) };
  await withMode(undefined, async () => {
    check._resetCache();
    const out = await check.maybeRunOutsideScriptCheck({ ...args, deps: { github } });
    assert.deepEqual([out.row.status, out.row.advisory], ['fail', false]);
  });
  await withMode('off', async () => {
    check._resetCache();
    assert.equal(await check.maybeRunOutsideScriptCheck({ ...args, deps: { github } }), null);
  });
  await withMode('blocking', async () => {
    check._resetCache();
    assert.equal(await check.maybeRunOutsideScriptCheck({ ...args, config: { selfAppSlug: 'stylist' }, deps: { github } }), null,
      'the platform\'s own repository is no app');
    check._resetCache();
    const down = await check.maybeRunOutsideScriptCheck({ ...args, deps: { github: { getProposalDiff: async () => { throw new Error('down'); } } } });
    assert.deepEqual([down.row.status, down.row.advisory], ['pass', true]);
    assert.match(down.row.summary, /not checked/);
    check._resetCache();
    const partial = await check.maybeRunOutsideScriptCheck({ ...args, deps: { github: { getProposalDiff: async () => ({ diff: '', truncated: true }) } } });
    assert.match(partial.row.summary, /read in part/);
  });
});

test('the check is wired into the checks run and its mode is declared, blocking by default', () => {
  const visuals = read('src/services/visuals.js');
  assert.match(visuals, /outsideScriptCheck\.maybeRunOutsideScriptCheck\(\{[\s\S]{0,200}\}\)\.catch\(\(\) => null\);\s+if \(outsideScriptOutcome\) extraRows\.push\(outsideScriptOutcome\.row\);/);
  const manifest = JSON.parse(read('dapp.json'));
  const entry = (manifest.platform_env || []).find((e) => e.key === 'OUTSIDE_SCRIPT_CHECK_MODE');
  assert.ok(entry, 'declared in platform_env');
  assert.equal(entry.default, 'blocking');
  assert.match(read('src/prompts/app-conventions.md'), /fails its checks \("No script from another site"\)/);
});

// ── 2 and 3. People and private keys tell, and do not hold ─────────────

test('people and secret tell and hold nothing; wallet and content still hold, with them as reasons', () => {
  assert.equal(holds.holds(['people']), false);
  assert.equal(holds.holds(['secret']), false);
  assert.equal(holds.holds(['people', 'secret', 'unread']), false);
  assert.equal(holds.holds(['wallet', 'people']), true);
  assert.equal(holds.holds(['content', 'secret']), true);
  // script is a check now: the rule reads nothing and holds nothing, and
  // stays only so a hold opened for one before 20 Nov still says why.
  assert.equal(holds.holds(['script']), false);
  assert.deepEqual(holds.tripped({ diff: file('public/index.html', ['+<script src="https://cdn.example.com/x.js"></script>']) }), []);
  assert.deepEqual(holds.ruleWords(['script']), ['It loads a script from another site']);
});

test('what a change keeps about people is read off its new tables', () => {
  const table = file('server.js', ['+CREATE TABLE IF NOT EXISTS clients (', '+  user_id INTEGER,', '+  contact_email TEXT,', '+  phone_number TEXT,', '+  date_of_birth DATE,', '+  first_name TEXT);']);
  assert.deepEqual(holds.peopleKept(table), ['email', 'phone', 'birth', 'name']);
  assert.deepEqual(holds.peopleKept(file('tests/db.test.js', ['+CREATE TABLE t (email TEXT);'])), []);
  assert.equal(holds.personKind('home_address'), 'address');
  assert.equal(holds.personKind('zip_code'), 'address');
  assert.deepEqual(holds.cleanRules(['people', 'people:email']), ['people'], 'every gate reads the rules without the tags');
});

function pool(routes) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql: String(sql), params });
      for (const [pattern, answer] of routes) {
        if (pattern.test(String(sql))) return typeof answer === 'function' ? answer(params, String(sql)) : answer;
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('a change that keeps email addresses is a notice carrying what it keeps; with a token send it is held', async () => {
  holds._resetCache();
  const keeps = file('server.js', ['+CREATE TABLE IF NOT EXISTS clients (', '+  email TEXT,', '+  phone TEXT);']);
  const db = pool([[/INSERT INTO release_holds/, { rows: [{ id: 4, opened: true }], rowCount: 1 }]]);
  const out = await holds.evaluate({
    pool: db, session: { id: 61 }, app: { id: 2 }, repoOwner: 'o', repoName: 'r', commitHash: 'c'.repeat(40),
    deps: { isFirstVersion: async () => false, notify: async () => {}, github: { getProposalDiff: async () => ({ diff: keeps }) } },
  });
  assert.deepEqual([out.state, out.rules], ['notice', ['people']]);
  const insert = db.seen.find((q) => /INSERT INTO release_holds/.test(q.sql));
  assert.deepEqual(insert.params[3], ['people', 'people:email', 'people:phone']);

  holds._resetCache();
  const both = keeps + '\n' + file('public/app.js', ['+  await usernode.sendTransaction(to, amount);']);
  const db2 = pool([[/INSERT INTO release_holds/, { rows: [{ id: 5, opened: true }], rowCount: 1 }]]);
  const held = await holds.evaluate({
    pool: db2, session: { id: 62 }, app: { id: 2 }, repoOwner: 'o', repoName: 'r', commitHash: 'd'.repeat(40),
    deps: { isFirstVersion: async () => false, notify: async () => {}, github: { getProposalDiff: async () => ({ diff: both }) } },
  });
  assert.deepEqual([held.state, held.rules], ['held', ['wallet', 'people']]);

  holds._resetCache();
  const script = file('public/index.html', ['+<script src="https://cdn.example.com/x.js"></script>']);
  const db3 = pool([]);
  const clear = await holds.evaluate({
    pool: db3, session: { id: 63 }, app: { id: 2 }, repoOwner: 'o', repoName: 'r', commitHash: 'f'.repeat(40),
    deps: { isFirstVersion: async () => false, notify: async () => {}, github: { getProposalDiff: async () => ({ diff: script }) } },
  });
  assert.equal(clear.state, 'clear', 'a script from another site holds nothing: the check fails it instead');
});

test('the notice\'s detail, mail reasons and subject say what the change now keeps or uses', async () => {
  const mails = [];
  let detail = null;
  const db = pool([
    [/UPDATE release_holds rh SET notified_at = NOW\(\)/, (params) => ({
      rows: [{ id: 8, rules: ['people', 'secret', 'people:email', 'people:phone'], status: 'notice', session_id: params[0], author_id: 5, app_id: 2, app_slug: 'stylist', app_name: 'Stylist', title: 'Book a fitting' }],
    })],
    [/INSERT INTO notifications/, (params) => { detail = params[3]; return { rows: [{ id: 100, user_id: 8 }] }; }],
    [/SELECT id, email, locale FROM users/, { rows: [{ id: 8, email: 'a@example.com', locale: null }] }],
    [/SELECT username FROM users/, { rows: [{ username: 'homeroom_bot' }] }],
  ]);
  await holds.notifyIfDue({
    pool: db, sessionId: 70,
    deps: { notifications: { hydrateAndPush: async () => {} }, sendMail: async (_c, mail) => { mails.push(mail); } },
  });
  assert.equal(detail, 'notice:people,secret|people:email,people:phone');
  assert.deepEqual(mails[0].reasons, ['It now keeps people\'s email addresses and phone numbers', 'It now uses a private key for an outside service']);
  assert.deepEqual([mails[0].held, mails[0].unread], [false, false]);

  const mail = buildMessage('release_hold', { to: 'a@example.com', ...mails[0] });
  assert.equal(mail.subject, 'For your information: Book a fitting');
  assert.match(mail.text, /You do not need to do anything\. Open the change if you want to look at it\./);
  assert.doesNotMatch(mail.text, /read only the first part/);
  const big = buildMessage('release_hold', { ...mails[0], reasons: ['It could not be read in full'], unread: true });
  assert.equal(big.subject, 'Not read in full: Book a fitting');
  assert.equal(ACTIONS.release_hold.values({ held: false }).unread, true, 'a notice from before `unread` was a change not read in full');
  assert.equal(ACTIONS.release_hold.values({}).unread, false);
});

// ── The bell row and the push ──────────────────────────────────────────

function loadBell() {
  const { agoStamp } = require('./lib/render-tsx').loadTsx('frontend/src/lib/timestamp.ts');
  const src = read('frontend/src/features/notifications/notifications.js').replace(/^import \{ agoStamp \}.*$/m, '');
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise, setTimeout, clearTimeout, URLSearchParams, Intl,
    location: { search: '', hash: '#home' },
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { title: '', getElementById: () => null, addEventListener: () => {}, querySelectorAll: () => ({ forEach: () => {} }), body: { appendChild: () => {} } },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    PlatformUI: { isTouch: () => false, toast() {} },
    App: { user: { id: 1 }, _isScreenVisible: () => false },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.agoStamp = agoStamp;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInContext(src, sandbox);
  return sandbox.Notifications;
}

test('the bell row says what the project now keeps or uses, and asks nothing', () => {
  const N = loadBell();
  const row = (detail, extra = {}) => N._rowView({
    id: 1, kind: 'release_hold', detail, appName: 'Stylist', appSlug: 'stylist', sessionId: 14150,
    sessionTitle: 'Book a fitting', createdAt: new Date().toISOString(), ...extra,
  });
  const keeps = row('notice:people|people:email');
  assert.equal(keeps.label, 'Stylist now keeps people\'s email addresses');
  assert.equal(keeps.segments[0].v, 'Book a fitting');
  assert.ok(!keeps.needsYou);
  assert.equal(row('notice:people|people:email,people:phone').label, 'Stylist now keeps people\'s email addresses and phone numbers');
  assert.equal(row('notice:people').label, 'Stylist now keeps data about people');
  assert.equal(row('notice:secret').label, 'Stylist now uses a private key for an outside service');
  assert.equal(row('notice:people,secret|people:email').label, 'Stylist now keeps people\'s email addresses', 'the first rule names the row');
  assert.equal(row('notice:secret', { appName: '' }).label, 'A project now uses a private key for an outside service');
  assert.equal(row('notice:unread').label, 'Not read in full');
  assert.equal(row('wallet,people|people:email').label, 'Needs your approval');
});

test('the phone push says the same', () => {
  const { buildNotificationCopy } = require('../src/services/mobile-push-policy');
  const copy = (detail) => buildNotificationCopy('release_hold', { appName: 'Stylist', sessionTitle: 'Book a fitting', detail });
  assert.match(copy('notice:people|people:email').title, /Now keeps people's email addresses/);
  assert.match(copy('notice:people|people:email,people:phone').title, /email addresses and phone numbers/);
  assert.match(copy('notice:secret').title, /Now uses a private key for an outside service/);
  assert.match(copy('notice:unread').title, /A change was not read in full/);
  assert.match(copy('wallet,people').title, /A change needs your approval/);
  assert.equal(copy('notice:secret').body, '“Book a fitting” is not held, and you can look at it');
});

test('the words are in the catalogs with descriptions and no em dashes', () => {
  for (const [ns, prefix] of [['notifications', 'row.releaseHold.'], ['push', 'releaseHold.']]) {
    const catalog = JSON.parse(read(`frontend/locales/en/${ns}.json`));
    for (const [key, entry] of Object.entries(catalog).filter(([k]) => k.startsWith(prefix))) {
      assert.ok(entry.description && entry.description.length > 20, `${ns}:${key} has a description`);
      assert.doesNotMatch(entry.text, /—/, `${ns}:${key}`);
    }
  }
});
