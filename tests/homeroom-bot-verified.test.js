'use strict';

// #6632: Homeroom bot only for verified accounts.
//
// An admin's rule over who the bot works for: everyone who is let in (the
// default, and exactly today's behaviour), or verified accounts only, with
// a tick list of which signals count. Pinned here, with no database:
//   1. the rule itself: any one ticked signal, admins exempt, the
//      grandfather box both ways, and the closed side when nothing reads;
//   2. hasBot is the one answer, read through botWorksFor;
//   3. each door that starts the bot's work refuses an unverified account
//      with `bot_verify_required` and the ticked signals, and lets a
//      verified one past the rule;
//   4. the client: the refusal opens the verify sheet and the press is sent
//      again; the admin form saves the three fields; the connector's
//      allow-lists carry them.
//
// tests/homeroom-bot-verified-postgres.test.js runs the same rule against
// the real tables (each signal's row, the fixed chat reply, the lane).
//
// Run with: node --test tests/homeroom-bot-verified.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const bot = require('../src/services/homeroom-bot');
const dm = require('../src/services/homeroom-bot-dm');
const rule = require('../src/services/homeroom-bot-verified');

const SINCE = '2026-11-12T09:00:00.000Z';
const settingsOf = (over = {}) => ({
  ...bot.parseSettings([
    { key: 'homeroom_bot_works_for', value: 'verified' },
    { key: 'homeroom_bot_verified_since', value: SINCE },
  ]),
  ...over,
});
const NONE = { phone: false, x: false, github: false, zkpassport: false, oauth: false, email: false, isAdmin: false, letInAt: '2026-11-12T10:00:00.000Z' };

// A pool that answers the two reads the rule makes: the settings and one
// account's signals. Everything else is empty.
function poolOf({ settings = [], flags = {}, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push(String(sql));
      if (/FROM platform_settings WHERE key = ANY/.test(sql)) return { rows: settings };
      if (/user_phone_identities/.test(sql) && /user_oauth_identities/.test(sql)) {
        if (fail) throw new Error('down');
        const f = { ...NONE, ...(flags[params[0]] || {}) };
        return { rows: [{
          has_phone: f.phone, has_x: f.x, has_github: f.github, has_zkpassport: f.zkpassport, has_oauth: f.oauth,
          has_email: f.email, is_admin: f.isAdmin, let_in_at: f.letInAt,
        }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}
const RULE_ROWS = [
  { key: 'homeroom_bot_mode', value: 'shadow' },
  { key: 'homeroom_bot_works_for', value: 'verified' },
  { key: 'homeroom_bot_verified_since', value: SINCE },
];

// ── 1. The rule ─────────────────────────────────────────────────────────

test('off, the rule lets everybody past and reads nothing', async () => {
  const everyone = bot.parseSettings([]);
  assert.equal(rule.ruleOn(everyone), false);
  assert.equal(rule.passes(everyone, null), true);
  const pool = poolOf();
  assert.equal(await rule.verifyRequired(pool, everyone, { id: 7 }), false);
  assert.equal(await rule.verifyRequired(pool, null, { id: 7 }), false, 'unreadable settings are today\'s behaviour');
  assert.deepEqual(pool.calls, []);
});

test('each signal alone unlocks the bot when it is ticked, and not when it is not', () => {
  for (const signal of rule.SIGNALS) {
    const only = settingsOf({ verifiedSignals: [signal] });
    const others = settingsOf({ verifiedSignals: rule.SIGNALS.filter((s) => s !== signal) });
    assert.equal(rule.passes(only, { ...NONE, [signal]: true }), true, `${signal}, ticked`);
    assert.equal(rule.passes(others, { ...NONE, [signal]: true }), false, `${signal}, not ticked`);
  }
  assert.deepEqual([...rule.DEFAULT_SIGNALS], ['phone', 'x', 'github'], 'what starts ticked');
  const start = settingsOf();
  assert.equal(rule.passes(start, { ...NONE, github: true }), true, 'GitHub alone is enough here, unlike the verified-identity rule');
  assert.equal(rule.passes(start, { ...NONE, email: true, oauth: true, zkpassport: true }), false, 'offered, unticked');
  assert.equal(rule.passes(start, NONE), false);
  assert.equal(rule.passes(start, null), false, 'no account: the closed side');
  assert.equal(rule.passes(settingsOf({ verifiedSignals: [] }), { ...NONE, phone: true }), false, 'nothing ticked passes nobody');
});

test('admins always have the bot; the grandfather box decides for accounts let in before the rule', () => {
  const before = { ...NONE, letInAt: '2026-11-01T00:00:00.000Z' };
  const after = { ...NONE, letInAt: '2026-11-12T09:00:00.001Z' };
  assert.equal(rule.passes(settingsOf(), { ...NONE, isAdmin: true }), true);
  assert.equal(rule.passes(settingsOf(), before), true, 'ticked: let in before it was switched on');
  assert.equal(rule.passes(settingsOf(), after), false, 'let in after it');
  assert.equal(rule.passes(settingsOf({ verifiedGrandfather: false }), before), false, 'unticked: the rule applies to everyone');
  assert.equal(rule.passes(settingsOf({ verifiedGrandfather: false }), { ...before, x: true }), true);
  assert.equal(rule.passes(settingsOf({ verifiedSince: null }), before), false, 'no moment, nobody is earlier than it');
});

test('verifyRequired: one read per account, none for an admin or one already read, closed when the read fails', async () => {
  const s = settingsOf();
  const pool = poolOf({ flags: { 7: { phone: true }, 8: {} } });
  assert.equal(await rule.verifyRequired(pool, s, { id: 7 }), false);
  assert.equal(await rule.verifyRequired(pool, s, { userId: 8 }), true, 'a requester carries userId');
  assert.equal(pool.calls.length, 2, 'one query each');
  assert.equal(await rule.verifyRequired(pool, s, { id: 9, isAdmin: true }), false);
  assert.equal(await rule.verifyRequired(pool, s, { id: 9, botVerified: true }), false);
  assert.equal(await rule.verifyRequired(pool, s, { id: 9, botVerified: false }), true);
  assert.equal(pool.calls.length, 2, 'and none of those read');
  assert.equal(await rule.verifyRequired(pool, s, { username: 'nobody' }), true, 'nobody to read');
  assert.equal(await rule.verifyRequired(poolOf({ fail: true }), s, { id: 7 }), true, 'a failed read keeps the bot locked');
  const sql = read('src/services/homeroom-bot-verified.js');
  assert.doesNotMatch(sql.split('async function readSignals')[1].split('function passes')[0], /github_login|u\.github\b|u\.x\b/,
    'self-declared text and a legacy github_login never count');
});

// ── 2. hasBot is the one answer ─────────────────────────────────────────

test('botWorksFor reads the rule and hasBot decides; with the rule off nothing is read', async () => {
  const ada = { id: 7, username: 'ada', hasPlatformAccess: true };
  const off = poolOf();
  assert.equal(await dm.botWorksFor(off, bot.parseSettings([]), ada), true);
  assert.deepEqual(off.calls, [], 'everyone: exactly today\'s hasBot');
  const s = settingsOf();
  assert.equal(await dm.botWorksFor(poolOf({ flags: { 7: { x: true } } }), s, ada), true);
  assert.equal(await dm.botWorksFor(poolOf(), s, ada), false);
  assert.equal(await dm.botWorksFor(poolOf(), s, { ...ada, isAdmin: true }), true);
  assert.equal(await dm.botWorksFor(poolOf({ flags: { 7: { x: true } } }), s, { ...ada, hasPlatformAccess: false }), false,
    'verified and not let in is still not let in');
  assert.equal(await dm.botWorksFor(poolOf({ flags: { 7: { phone: true } } }), s, { ...ada, isSynthetic: true }), false);
  // Nothing outside this module and its rule asks the pure hasBot of a
  // person the rule was not read for.
  for (const file of ['homeroom-bot-mayor.js', 'homeroom-bot-flaky-checks.js', 'homeroom-bot-activity.js', 'homeroom-bot-voice.js',
    'homeroom-bot-chat.js', 'invite-nudge.js', 'homeroom-bot.js', 'homeroom-bot-public-plan.js', 'private-threads.js', 'design-threads.js']) {
    assert.doesNotMatch(read(`src/services/${file}`).replace(/^\s*(\/\/|\*).*$/gm, ''), /\.hasBot\(/, `${file} goes through the rule`);
  }
  assert.doesNotMatch(read('src/routes/auth.js').replace(/^\s*\/\/.*$/gm, ''), /\.hasBot\(settings, req\.user\)/);
});

// ── 3. The doors ────────────────────────────────────────────────────────

const REFUSAL = { ok: false, status: 403, error: rule.VERIFY_ERROR, code: 'bot_verify_required', signals: ['phone', 'x', 'github'] };
const ada = { id: 7, username: 'ada', hasPlatformAccess: true };

test('Ask Homeroom bot to build this: 403 with the code for an unverified account, the old sentence for one not let in', async () => {
  const app = { id: 1, slug: 'seed-swap' };
  assert.deepEqual(await dm.askBotToBuild(poolOf({ settings: RULE_ROWS }), { app, user: ada, issueNumber: 4 }), REFUSAL);
  assert.deepEqual(
    await dm.askBotToBuild(poolOf({ settings: RULE_ROWS }), { app, user: { ...ada, hasPlatformAccess: false }, issueNumber: 4 }),
    { ok: false, status: 403, error: 'Homeroom bot is not on for you yet.' },
  );
  assert.match(read('src/routes/issues.js'), /\.\.\.\(out\.code \? \{ code: out\.code \} : \{\}\), \.\.\.\(out\.signals \? \{ signals: out\.signals \} : \{\}\)/);
});

test('Build it on a plan, by its requester or anybody else: refused before anything is decided', async () => {
  const plan = require('../src/services/homeroom-bot-public-plan');
  const pool = poolOf({ settings: RULE_ROWS });
  assert.deepEqual(await plan.buildPlan(pool, { app: { id: 1, slug: 'seed-swap' }, issueNumber: 4, user: ada }), REFUSAL);
  assert.ok(!pool.calls.some((sql) => /homeroom_bot_runs/.test(sql)), 'no plan read, no payer written');
  // A verified press goes on to the plan (there is none here).
  const went = await plan.buildPlan(poolOf({ settings: RULE_ROWS, flags: { 7: { github: true } } }),
    { app: { id: 1, slug: 'seed-swap' }, issueNumber: 4, user: ada });
  assert.deepEqual(went, { ok: false, status: 409, error: 'plan_gone' });
  // And their own plan's card in the chat is the same press.
  assert.deepEqual(await dm.decidePlanTap(pool, { user: ada, action: { id: 1, message_id: 2 }, choice: 'build' }), REFUSAL);
  assert.match(read('src/routes/request-specs.js'), /went\.code \? \{ code: went\.code, signals: went\.signals \|\| \[\] \}/);
});

test('a new thread, a thread about a request, and a design thread: refused with the code', async () => {
  const threads = require('../src/services/private-threads');
  const designs = require('../src/services/design-threads');
  const pool = () => poolOf({ settings: RULE_ROWS });
  assert.deepEqual(await threads.startThread(pool(), { user: ada }), REFUSAL);
  assert.deepEqual(await threads.startAbout(pool(), { user: ada, app: { id: 1, slug: 'seed-swap' }, kind: 'request', number: 4 }), REFUSAL);
  assert.deepEqual(await designs.startDesign(pool(), {}, {
    user: ada, html: '<p>x</p>', surface: 'platform', title: 'Home', width: 390, height: 800,
  }), REFUSAL);
  // Everyone: none of them reads the rule's table.
  const off = poolOf({ settings: [{ key: 'homeroom_bot_mode', value: 'shadow' }] });
  await threads.startThread(off, { user: ada, deps: { dm: { botAccount: async () => null } } });
  assert.ok(!off.calls.some((sql) => /user_phone_identities/.test(sql)));
  assert.match(read('src/routes/threads.js'), /out\.code \? \{ code: out\.code, signals: out\.signals \|\| \[\] \}/);
});

test('a described project: the create route asks to verify before anything is made', () => {
  const routes = read('src/routes/apps.js');
  const at = routes.indexOf("refusalFor(pool, req.user)");
  assert.ok(at > 0);
  assert.match(routes.slice(at - 400, at + 200), /if \(owesFirstVersion\) \{\s*const locked = await require\('\.\.\/services\/homeroom-bot-verified'\)\.refusalFor\(pool, req\.user\);\s*if \(locked\) return res\.status\(locked\.status\)\.json\(\{ error: locked\.error, code: locked\.code, signals: locked\.signals \}\);/);
  assert.ok(at < routes.indexOf("await db.query('BEGIN')", at) || at < routes.indexOf('startSketch', at), 'before the project, its sketch and its first request');
});

test('mentions stay quiet, and the lane does not start a request for somebody the rule keeps the bot from', () => {
  const voice = read('src/services/homeroom-bot-voice.js');
  assert.match(voice, /has_the_bot: async \(s\) => \(\(await require\('\.\/homeroom-bot-verified'\)\.worksFor\(dmModule\(s\.deps\), s\.pool, s\.settings, s\.speaker\)\)\s*\? null : no\('not_let_in'\)\)/);
  const lane = read('src/services/homeroom-bot.js');
  assert.match(lane, /if \(requester && await botVerified\.verifyRequired\(pool, settings, requester\)\) eligible\.splice\(i, 1\);/,
    'the refresh leaves it out of the queue');
  assert.match(lane, /look\.once\('gate:verified', \(\) => botVerified\.verifyRequired\(pool, settings, forWhom\)\)\) \{\s*look\.consume\(\);/,
    'and a look that got there anyway ends before its turn');
  assert.ok(lane.indexOf("'gate:verified'") < lane.indexOf("'gate:allowance'"), 'before the allowance, and so before any model call');
});

test('the connector keeps the code', () => {
  assert.match(read('src/services/mcp-tools.js'), /result\.body\.code === 'bot_verify_required'\) \{\s*return toolError\('bot_verify_required', message\);/);
});

// ── 4. The client, the admin form and the connector's lists ────────────

function response(status, body) {
  const text = JSON.stringify(body);
  const make = () => ({ status, ok: status < 400, json: async () => JSON.parse(text), clone: () => make() });
  return make();
}

test('a refused press opens the verify sheet with the signals, and is sent again once verified', async () => {
  const mod = loadTsx('frontend/src/lib/bot-verify-required.ts');
  const run = async ({ verified, answers }) => {
    const calls = [];
    const asked = [];
    const win = {
      fetch: async (url, init) => { calls.push([url, (init && init.method) || 'GET']); return answers.shift() || response(200, { ok: true }); },
      UsernodeReact: { verifyIdentity: { askForBot: async (signals) => { asked.push(signals); return verified; } } },
    };
    mod.installBotVerifyRequired(win);
    mod.installBotVerifyRequired(win);
    return { win, calls, asked };
  };
  const refused = () => response(403, { code: 'bot_verify_required', error: 'Verify', signals: ['phone', 'x'] });
  const yes = await run({ verified: true, answers: [refused(), response(200, { ok: true })] });
  const res = await yes.win.fetch('/api/apps/seed-swap/issues/4/homeroom-bot', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(yes.asked, [['phone', 'x']]);
  assert.equal(yes.calls.length, 2, 'the same press, once more');
  const no = await run({ verified: false, answers: [refused()] });
  const kept = await no.win.fetch('/api/apps', { method: 'POST' });
  assert.equal(kept.status, 403);
  assert.equal((await kept.json()).code, 'bot_verify_required', 'the caller still reads the refusal');
  assert.equal(no.calls.length, 1);
  const again = await run({ verified: true, answers: [refused(), refused()] });
  assert.equal((await again.win.fetch('/x', { method: 'POST' })).status, 403, 'a second refusal goes back: no loop');
  assert.equal(again.asked.length, 1);
  const other = await run({ verified: true, answers: [response(403, { code: 'join_required' }), refused()] });
  await other.win.fetch('/x', { method: 'POST' });
  await other.win.fetch('/x');
  assert.deepEqual(other.asked, [], 'another refusal, and a read, are not its business');
  assert.match(read('frontend/src/main.tsx'), /bootStep\('installBotVerifyRequired', \(\) => installBotVerifyRequired\(\)\);/);
});

test('the sheet has the bot\'s wording, names what counts, and offers the phone only when it counts', () => {
  const sheet = read('frontend/src/features/auth/verify-identity.tsx');
  assert.match(sheet, /title: 'auth:verify\.bot\.title',\s*lead: 'auth:verify\.bot\.lead',\s*reason: 'auth:verify\.bot\.reason'/);
  assert.match(sheet, /const phone = phoneOffered && botSignals\.includes\('phone'\);/);
  assert.match(sheet, /askForBot: askToVerifyForBot/);
  assert.equal(message('auth:verify.bot.title'), 'Verify to use Homeroom bot');
  assert.match(message('auth:verify.bot.reason'), /^Homeroom bot works for verified accounts\. Any one of these is enough: \{\{signals\}\}\.$/);
  for (const signal of rule.SIGNALS) assert.ok(message(`auth:verify.bot.signal.${signal}`), `${signal} has a name`);
  // The bot's own reply carries a Verify button the chat opens the sheet for.
  assert.match(dm.VERIFY_TEXT, /^I work for verified accounts\./);
  assert.doesNotMatch(dm.VERIFY_TEXT, /—/);
  assert.match(read('frontend/src/features/messages/store.ts'), /if \(action\.type === 'open' && action\.id === 'verify_account'\) \{/);
});

test('/api/auth/me tells the client: locked for the rule, with what counts', async () => {
  const express = require('express');
  const poolMod = require('../src/db/pool');
  const prior = poolMod.getPool;
  let pool = poolOf({ settings: RULE_ROWS });
  poolMod.getPool = () => pool;
  delete require.cache[require.resolve('../src/routes/auth')];
  const { authRoutes } = require('../src/routes/auth');
  const app = express();
  let user = null;
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(authRoutes({ jwtSecret: 'test-secret' }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const me = async () => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/auth/me`)).json()).user || {};
  try {
    user = { id: 7, username: 'ada', isAdmin: false, appQuota: 0, locale: null, hasPlatformAccess: true };
    let got = await me();
    assert.deepEqual([got.homeroomBotDm, got.homeroomBotVerify], [false, { signals: ['phone', 'x', 'github'] }]);
    user = { ...user, hasPlatformAccess: false };
    got = await me();
    assert.deepEqual([got.homeroomBotDm, got.homeroomBotVerify], [false, null], 'not let in is not a verify ask');
    user = { ...user, hasPlatformAccess: true, isAdmin: true };
    got = await me();
    assert.deepEqual([got.homeroomBotDm, got.homeroomBotVerify], [true, null]);
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
    poolMod.getPool = prior;
    delete require.cache[require.resolve('../src/routes/auth')];
    pool = null;
  }
});

test('the admin card saves the three fields, and refuses verified with nothing ticked', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  for (const id of ['admin-homeroom-bot-works-for', 'admin-homeroom-bot-works-for-everyone', 'admin-homeroom-bot-works-for-verified',
    'admin-homeroom-bot-verified-signals', 'admin-homeroom-bot-verified-grandfather']) {
    assert.ok(tsx.includes(`"${id}"`) || tsx.includes(`'${id}'`), id);
  }
  assert.match(tsx, /<h3 className=\{AdminUI\.cardTitle\}>Who Homeroom bot works for<\/h3>/);
  assert.match(tsx, /Members let in before this was switched on keep the bot/);
  const admin = loadTsx('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.deepEqual(admin.BOT_SIGNALS.map((s) => s.key), [...rule.SIGNALS], 'the card lists what the server reads');
  const saved = admin.savedForm({ settings: { mode: 'shadow' }, bot: null });
  assert.deepEqual([saved.worksFor, saved.verifiedSignals, saved.verifiedGrandfather], ['everyone', ['phone', 'x', 'github'], true]);
  const form = { ...saved, worksFor: 'verified', verifiedSignals: ['github', 'phone'], verifiedGrandfather: false };
  assert.deepEqual(admin.buildPatch(form, saved, ['worksFor', 'verifiedSignals', 'verifiedGrandfather']), {
    patch: { worksFor: 'verified', verifiedSignals: ['phone', 'github'], verifiedGrandfather: false }, error: null,
  });
  assert.deepEqual(admin.buildPatch({ ...form, verifiedSignals: [] }, saved, ['worksFor', 'verifiedSignals']),
    { patch: {}, error: 'Tick at least one signal that counts as verified.' });
  assert.deepEqual(admin.dirtyFields({ verifiedSignals: ['github', 'x', 'phone'] }, saved), [], 'the order ticked in is not a change');
  assert.equal(bot.validateSettingsPatch(admin.buildPatch(form, saved, ['worksFor', 'verifiedSignals', 'verifiedGrandfather']).patch).ok, true,
    'what Save sends is what the route takes');
});

test('the connector\'s allow-lists carry the three fields, and the moment is read-only', () => {
  const data = require('../src/services/bench/connector-data');
  for (const field of ['worksFor', 'verifiedSignals', 'verifiedGrandfather']) {
    assert.ok(data.SETTINGS_FIELDS.includes(field), field);
  }
  assert.ok(!data.SETTINGS_FIELDS.includes('verifiedSince'));
  const tools = read('src/services/mcp-tools.js');
  assert.match(tools, /worksFor: z\.enum\(\['everyone', 'verified'\]\)\.optional\(\),\s*verifiedSignals: z\.array\(z\.enum\(\['phone', 'x', 'github', 'zkpassport', 'oauth', 'email'\]\)\)\.min\(1\)\.max\(6\)\.optional\(\),\s*verifiedGrandfather: botSwitch,/);
});
