'use strict';
// Text alerts for platform limits (services/limit-texts.js): what is texted
// and when, the add-and-confirm flow, and the refusals, through the real SMS
// layer (services/sms) with Brevo stubbed at its HTTP boundary.
//
// Pinned here:
//
//   1. The rules, pure: one text per crossing (near, then reached), a
//      reminder at most every six hours while a limit stays at, over or out,
//      near texts that wait out quiet hours while full ones go at any hour,
//      "couldn't check" only after an hour, and the alerts' re-arm margin,
//      taken from the view's own rows.
//   2. The words: short, the figures and where to fix it, nothing personal.
//   3. Adding a number: refused before anything is sent when SMS delivery is
//      Firebase, or no Sender ID covers its country; otherwise texted a code
//      as a transactional limit_alert send, active only once the code is
//      entered, shown masked once confirmed.
//   4. The sweep: texts confirmed numbers only, once per crossing, records
//      every send and refusal, and never logs a full number.
//
// Run with: node --test tests/limit-texts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const loggerPath = require.resolve('../src/services/logger');
const logged = [];
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true, paths: [],
  exports: {
    info: (...a) => logged.push(a), warn: (...a) => logged.push(a),
    error: (...a) => logged.push(a), debug: () => {},
  },
};

const texts = require('../src/services/limit-texts');
const view = require('../src/services/platform-limits-view');
const smsSelect = require('../src/services/sms/select');

const HOUR = 60 * 60 * 1000;
// Noon in Paris on a Wednesday: inside France's sending window.
const NOON_PARIS = Date.parse('2026-11-18T11:00:00Z');
// 03:00 in Paris: quiet hours.
const NIGHT_PARIS = Date.parse('2026-11-18T02:00:00Z');

const appsRow = (used, level, cap = 300) => view.countedRow('apps', { used, cap, percent: 80, level });
const credit = (state, extra = {}) => ({ key: 'openrouter_credit', state, balanceCents: 18400, ...extra });

// ─── 1. The rules ───────────────────────────────────────────────────────

test('a crossing is texted once: near, then reached, then nothing while it holds', () => {
  let mark = null;
  const step = (row, now = NOON_PARIS) => {
    const out = texts.decide(mark, row, { now, country: 'GB' });
    mark = out.mark;
    return out.action;
  };
  assert.equal(step(appsRow(200, 'ok')), null, 'under the line: nothing');
  assert.equal(step(appsRow(245, 'ok')), 'crossing', 'near: one text');
  assert.equal(mark.level, 'near');
  assert.equal(step(appsRow(250, 'warn')), null, 'still near: nothing');
  assert.equal(step(appsRow(300, 'warn')), 'crossing', 'reached: one more text');
  assert.equal(mark.level, 'broken');
  assert.equal(step(appsRow(301, 'full'), NOON_PARIS + HOUR), null, 'over, an hour later: nothing yet');
});

test('a limit that stays full is reminded at most every six hours', () => {
  const start = texts.decide(null, appsRow(300, 'warn'), { now: NOON_PARIS, country: 'GB' });
  assert.equal(start.action, 'crossing');
  const later = (hours, mark) => texts.decide(mark, appsRow(302, 'full'), { now: NOON_PARIS + hours * HOUR, country: 'GB' });
  assert.equal(later(5.9, start.mark).action, null);
  const remind = later(6, start.mark);
  assert.equal(remind.action, 'reminder');
  assert.equal(later(11.9, remind.mark).action, null, 'the next one is six hours after the reminder');
  assert.equal(later(12, remind.mark).action, 'reminder');
  assert.equal(texts.REMIND_MS, 6 * HOUR);
});

test('the margin: back under the cap but within it is no new crossing; under it re-arms', () => {
  const hit = texts.decide(null, appsRow(300, 'warn'), { now: NOON_PARIS, country: 'GB' });
  // 280 of 300: under the cap, but the view still holds "full" (re-arms under 270).
  const dip = appsRow(280, 'full');
  assert.equal(dip.state, 'near');
  const held = texts.decide(hit.mark, dip, { now: NOON_PARIS + HOUR, country: 'GB' });
  assert.equal(held.action, null);
  assert.equal(held.mark.level, 'broken', 'still counted as broken: no near text on the way down');
  const back = texts.decide(held.mark, appsRow(300, 'full'), { now: NOON_PARIS + 2 * HOUR, country: 'GB' });
  assert.equal(back.action, null, 'up to the cap again inside the margin: not a new crossing');
  // Fixed: the row is gone (under 0.9 x the 240 warning line, 216).
  assert.equal(appsRow(210, 'full'), null);
  const rearmed = texts.decide(back.mark, null, { now: NOON_PARIS + 3 * HOUR, country: 'GB' });
  assert.equal(rearmed.mark.level, 'ok');
  assert.equal(texts.decide(rearmed.mark, appsRow(245, 'ok'), { now: NOON_PARIS + 4 * HOUR, country: 'GB' }).action, 'crossing',
    'once fixed, the next crossing is texted again');
});

test('near waits out quiet hours; reached and out go at any hour', () => {
  const near = texts.decide(null, appsRow(245, 'ok'), { now: NIGHT_PARIS, country: 'FR' });
  assert.equal(near.action, null);
  assert.equal(near.held, 'quiet_hours');
  assert.equal(near.mark.level, 'ok', 'held, not marked: it goes once the window opens');
  assert.equal(texts.decide(near.mark, appsRow(246, 'warn'), { now: NOON_PARIS, country: 'FR' }).action, 'crossing');
  assert.equal(texts.decide(null, appsRow(300, 'warn'), { now: NIGHT_PARIS, country: 'FR' }).action, 'crossing',
    'refusing people is texted at night');
  assert.equal(texts.decide(null, credit('out'), { now: NIGHT_PARIS, country: 'FR' }).action, 'crossing');
  assert.equal(texts.decide(null, appsRow(245, 'ok'), { now: NIGHT_PARIS, country: 'GB' }).action, 'crossing',
    'a country with no quiet hours of its own');
});

test("couldn't check is texted only once it has lasted an hour, and only once", () => {
  const row = { key: 'openrouter_credit', state: 'unknown', reason: 'no_answer' };
  const first = texts.decide(null, row, { now: NOON_PARIS, country: 'GB' });
  assert.equal(first.action, null);
  assert.equal(texts.decide(first.mark, row, { now: NOON_PARIS + 59 * 60 * 1000, country: 'GB' }).action, null);
  const hour = texts.decide(first.mark, row, { now: NOON_PARIS + HOUR, country: 'GB' });
  assert.equal(hour.action, 'unknown');
  assert.equal(texts.decide(hour.mark, row, { now: NOON_PARIS + 5 * HOUR, country: 'GB' }).action, null);
  const readable = texts.decide(hour.mark, null, { now: NOON_PARIS + 6 * HOUR, country: 'GB' });
  assert.deepEqual([readable.mark.unknownSince, readable.mark.unknownTexted], [null, false], 'readable again: re-armed');
});

test('people turned away (#6901): the first refusal at once, then the count at most every three hours', () => {
  const since = new Date(NOON_PARIS - 30 * 60 * 1000).toISOString();
  const full = (n) => ({ ...appsRow(300, 'full'), turnedAway: n, turnedAwaySince: n ? since : null });
  // Full and texted an hour ago, nobody refused yet.
  const crossed = texts.decide(null, appsRow(300, 'warn'), { now: NOON_PARIS - HOUR, country: 'GB' });
  assert.equal(crossed.action, 'crossing');
  const first = texts.decide(crossed.mark, full(1), { now: NOON_PARIS, country: 'GB' });
  assert.deepEqual([first.action, first.turnedAway, first.firstOfRun], ['turned_away', 1, true], 'the first refusal is texted at once');
  const soon = texts.decide(first.mark, full(3), { now: NOON_PARIS + 2 * HOUR, country: 'GB' });
  assert.equal(soon.action, null, 'more people, but within three hours: nothing yet');
  const later = texts.decide(soon.mark, full(4), { now: NOON_PARIS + 3 * HOUR, country: 'GB' });
  assert.deepEqual([later.action, later.turnedAway, later.firstOfRun], ['turned_away', 4, false]);
  const same = texts.decide(later.mark, full(4), { now: NOON_PARIS + 6 * HOUR + 1, country: 'GB' });
  assert.equal(same.action, null, 'no new people, and the refusal text counted as the reminder: six hours from it');
  const reminder = texts.decide(later.mark, full(4), { now: NOON_PARIS + 9 * HOUR, country: 'GB' });
  assert.deepEqual([reminder.action, reminder.turnedAway], ['reminder', 4], 'the six-hour reminder carries the count');
  assert.equal(texts.REFUSAL_TEXT_MS, 3 * HOUR);
});

test('a crossing that already has people turned away carries the count instead of a second text', () => {
  const since = new Date(NOON_PARIS - 10 * 60 * 1000).toISOString();
  const row = { ...appsRow(300, 'warn'), turnedAway: 2, turnedAwaySince: since };
  const hit = texts.decide(null, row, { now: NOON_PARIS, country: 'GB' });
  assert.deepEqual([hit.action, hit.turnedAway], ['crossing', 2]);
  assert.equal(texts.decide(hit.mark, row, { now: NOON_PARIS + 5 * 60 * 1000, country: 'GB' }).action, null,
    'the two people were told with the crossing');
});

// ─── 2. The words ───────────────────────────────────────────────────────

test('the words are short, carry the figures and the fix, and nothing personal', () => {
  const site = 'https://app.onhomeroom.com';
  const at = texts.textFor(appsRow(300, 'warn'), { action: 'crossing' }, { site });
  assert.equal(at, 'Homeroom: apps at 300 of 300. New projects are being refused. Raise the limit: https://app.onhomeroom.com/#admin/limits');
  assert.match(texts.textFor(appsRow(314, 'full'), { action: 'reminder' }, { site }), /^Homeroom reminder: apps over the limit, 314 of 300\./);
  assert.match(texts.textFor(appsRow(262, 'warn'), { action: 'crossing' }, { site }), /apps at 262 of 300, near the limit\. New projects stop at 300\./);
  assert.match(texts.textFor(credit('out'), { action: 'crossing' }, { site }), /OpenRouter credit is out\. .*https:\/\/openrouter\.ai\/settings\/credits$/);
  assert.match(texts.textFor(credit('near'), { action: 'crossing' }, { site }), /OpenRouter credit is down to \$184\. The bot stops at \$0\./);
  assert.match(texts.textFor({ key: 'sessions', state: 'at', used: 180, cap: 180 }, { action: 'crossing' }, { site }), /sessions at 180 of 180\./);
  assert.match(texts.textFor({ key: 'db_connections', state: 'at', used: 85, cap: 85 }, { action: 'crossing' }, { site }), /#admin\/status$/);
  assert.match(texts.textFor({ key: 'sessions', state: 'unknown' }, { action: 'unknown' }, { site }), /couldn't read the session count for an hour/);
  assert.equal(texts.textFor(appsRow(300, 'full'), { action: 'turned_away', turnedAway: 1, firstOfRun: true }, { site }),
    'Homeroom: someone was just turned away at the app limit (300 of 300). Raise the limit: https://app.onhomeroom.com/#admin/limits');
  assert.match(texts.textFor(appsRow(300, 'full'), { action: 'turned_away', turnedAway: 4, firstOfRun: false }, { site }),
    /^Homeroom: 4 people turned away at the app limit since it filled \(300 of 300\)\./);
  assert.match(texts.textFor(appsRow(300, 'full'), { action: 'reminder', turnedAway: 4 }, { site }),
    /New projects are being refused\. 4 people turned away so far\. Raise the limit:/);
  for (const words of [at, texts.textFor(credit('out'), { action: 'crossing' }, { site })]) {
    assert.ok(words.length <= 160, `one SMS: ${words.length}`);
    assert.doesNotMatch(words, /\+?\d{9,}/, 'no phone number');
  }
});

test('Homeroom bot\'s weekly budget is texted as a budget: dollars of the week, the day it turns, and where it is raised', () => {
  const site = 'https://app.onhomeroom.com';
  const detail = { usedCents: 64800, capCents: 80000, resetsAt: '2026-11-23T00:00:00.000Z' };
  const near = { key: 'bot_budget', state: 'near', used: 64800, cap: 80000, percent: 81, detail };
  const used = { key: 'bot_budget', state: 'at', used: 80000, cap: 80000, percent: 100, detail: { ...detail, usedCents: 80000 } };
  assert.equal(texts.textFor(near, { action: 'crossing' }, { site }),
    "Homeroom: bot's weekly budget at $648 of $800. It stops building at $800 until Monday. Raise it: https://app.onhomeroom.com/#admin/homeroom-bot/settings");
  assert.equal(texts.textFor(used, { action: 'crossing' }, { site }),
    "Homeroom: bot's weekly budget is used up, $800 of $800. Building stopped until Monday. Raise it: https://app.onhomeroom.com/#admin/homeroom-bot/settings");
  assert.match(texts.textFor(used, { action: 'reminder' }, { site }), /^Homeroom reminder: bot's weekly budget is still used up\. Building stopped until Monday\./);
  assert.match(texts.textFor({ key: 'bot_budget', state: 'unknown' }, { action: 'unknown' }, { site }), /couldn't read the bot's weekly budget for an hour/);
  assert.ok(texts.KEYS.includes('bot_budget'), 'the budget is one of the limits texted');
  const big = { usedCents: 1234500, capCents: 1500000, resetsAt: detail.resetsAt };
  for (const [row, action] of [[near, 'crossing'], [used, 'crossing'], [used, 'reminder'],
    [{ ...near, used: 1234500, cap: 1500000, detail: big }, 'crossing'], [{ ...used, used: 1500000, cap: 1500000, detail: { ...big, usedCents: 1500000 } }, 'crossing']]) {
    const words = texts.textFor(row, { action }, { site });
    assert.ok(words.length <= 160, `one SMS: ${words.length}`);
    assert.doesNotMatch(words, /credit|days/i, 'a budget is never said as credit running out, or in days');
  }
  // It crosses, holds and re-arms as every limit does: once near, once used up.
  const first = texts.decide({ level: 'ok', textedAt: null, unknownSince: null, unknownTexted: false, refusalsAt: null, refusalsCount: 0 }, near, { now: Date.parse('2026-11-20T12:00:00Z'), country: 'GB' });
  assert.equal(first.action, 'crossing');
  assert.equal(first.mark.level, 'near');
  const then = texts.decide(first.mark, used, { now: Date.parse('2026-11-20T15:00:00Z'), country: 'GB' });
  assert.deepEqual([then.action, then.mark.level], ['crossing', 'broken']);
});

test('the credit texts are about the account\'s credit', () => {
  const site = 'https://app.onhomeroom.com';
  const low = texts.textFor({ key: 'openrouter_credit', state: 'near', balanceCents: 18400, warnCents: 50000 }, { action: 'crossing' }, { site });
  assert.equal(low, 'Homeroom: OpenRouter credit is down to $184. The bot stops at $0. Add credit: https://openrouter.ai/settings/credits');
});

test('the cluster\'s own limits are texted in the same words: the figure, what stops, and where to look', () => {
  const site = 'https://app.onhomeroom.com';
  const say = (row) => texts.textFor(row, { action: 'crossing' }, { site });
  assert.equal(say({ key: 'db_disk', state: 'near', used: 41000, cap: 51200 }),
    'Homeroom: database disk at 40 of 50 GiB. When it fills, Postgres stops writing. See: https://app.onhomeroom.com/#admin/status');
  assert.match(say({ key: 'db_disk', state: 'at', used: 51200, cap: 51200 }), /^Homeroom: database disk full, 50 of 50 GiB\. Saves are failing/);
  assert.equal(say({ key: 'quota_workers', state: 'near', used: 917, cap: 1000, percent: 92 }),
    'Homeroom: workers quota 92% used. When it fills, new sessions and checks wait. See: https://app.onhomeroom.com/#admin/status');
  assert.match(say({ key: 'quota_apps', state: 'at', used: 1000, cap: 1000, percent: 100 }), /^Homeroom: apps quota used up\. Apps and previews can't start\./);
  assert.match(say({ key: 'quota_builds', state: 'over', used: 1100, cap: 1000, percent: 100 }), /builds quota used up\. New image builds are failing\./);
  assert.match(say({ key: 'node_pool', state: 'near', used: 9000, cap: 10000 }), /a node's volume pool is at 8\.8 of 9\.8 GiB\./);
  assert.match(texts.textFor({ key: 'node_pool', state: 'unknown' }, { action: 'unknown' }, { site }),
    /couldn't read the node volume pools for an hour/);
  for (const key of ['db_disk', 'quota_apps', 'quota_workers', 'quota_builds', 'node_pool']) {
    assert.ok(texts.KEYS.includes(key), `${key} is texted`);
    for (const state of ['near', 'at']) {
      const words = say({ key, state, used: 999999, cap: 999999, percent: 100 });
      assert.ok(words.length <= 160, `${key} ${state}: one SMS (${words.length})`);
    }
  }
});

// ─── 3 and 4: the flow, against the real SMS layer ─────────────────────

const GB = '+447700900123';
const FR = '+33680065433';
const CONFIG = {
  brevoApiKey: 'test-key',
  brevoSmsSenderIds: { GB: { sender: 'Homeroom', registered: false, optOut: null } },
};
const ENV = { USERNODE_ENV: 'production' };

function store({ provider = 'brevo' } = {}) {
  const db = { provider, phones: [], marks: [], sends: [], deliveries: [], nextId: 1 };
  const find = (id) => db.phones.find((p) => Number(p.id) === Number(id));
  const pool = {
    db,
    async query(raw, params = []) {
      const sql = raw.replace(/\s+/g, ' ').trim();
      if (sql === 'SELECT value FROM platform_settings WHERE key = $1') {
        return { rows: params[0] === 'sms_provider' && db.provider ? [{ value: db.provider }] : [] };
      }
      if (/^INSERT INTO sms_deliveries/.test(sql)) {
        db.deliveries.push({ kind: params[0], provider: params[1], country: params[2], last4: params[4], status: params[5] });
        return { rows: [] };
      }
      if (/^SELECT id, phone_e164, verified_at, verify_sent_at FROM limit_alert_phones WHERE phone_e164 = \$1$/.test(sql)) {
        return { rows: db.phones.filter((p) => p.phone_e164 === params[0]) };
      }
      if (/^SELECT COUNT\(\*\)::int AS n FROM limit_alert_phones$/.test(sql)) return { rows: [{ n: db.phones.length }] };
      if (/^INSERT INTO limit_alert_phones/.test(sql)) {
        const row = {
          id: db.nextId++, phone_e164: params[0], country: params[1], label: params[2], added_by: params[3],
          created_at: new Date(), verified_at: null, verify_code_hash: null, verify_expires_at: null,
          verify_attempts: 0, verify_sent_at: null, last_texted_at: null, last_status: null, last_error: null,
        };
        db.phones.push(row);
        return { rows: [{ id: row.id, phone_e164: row.phone_e164 }] };
      }
      if (/^UPDATE limit_alert_phones SET verify_code_hash = \$2/.test(sql)) {
        Object.assign(find(params[0]), {
          verify_code_hash: params[1], verify_expires_at: new Date(Date.now() + params[2]),
          verify_attempts: 0, verify_sent_at: new Date(),
        });
        return { rows: [] };
      }
      if (/^UPDATE limit_alert_phones SET label = \$2 WHERE id = \$1$/.test(sql)) { find(params[0]).label = params[1]; return { rows: [] }; }
      if (/^SELECT p\.id, .* FROM limit_alert_phones p LEFT JOIN users u ON u\.id = p\.added_by WHERE p\.id = \$1$/.test(sql)) {
        const row = find(params[0]);
        return { rows: row ? [{ ...row, added_by_username: 'evan' }] : [] };
      }
      if (/^SELECT p\.id, .* FROM limit_alert_phones p LEFT JOIN users u ON u\.id = p\.added_by ORDER BY/.test(sql)) {
        return { rows: db.phones.map((row) => ({ ...row, added_by_username: 'evan' })) };
      }
      if (/^SELECT id, verified_at, verify_code_hash, verify_expires_at, verify_attempts FROM limit_alert_phones WHERE id = \$1$/.test(sql)) {
        const row = find(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (/^UPDATE limit_alert_phones SET verify_attempts = verify_attempts \+ 1/.test(sql)) { find(params[0]).verify_attempts += 1; return { rows: [] }; }
      if (/^UPDATE limit_alert_phones SET verified_at = NOW\(\)/.test(sql)) {
        Object.assign(find(params[0]), { verified_at: new Date(), verify_code_hash: null, verify_expires_at: null, verify_attempts: 0 });
        return { rows: [] };
      }
      if (/^DELETE FROM limit_alert_phones WHERE id = \$1 RETURNING id$/.test(sql)) {
        const row = find(params[0]);
        db.phones = db.phones.filter((p) => p !== row);
        return { rows: row ? [{ id: row.id }] : [] };
      }
      if (/^INSERT INTO limit_alert_sends/.test(sql)) {
        db.sends.push({ phoneId: params[0], last4: params[1], limitKey: params[2], what: params[3], level: params[4], status: params[5], errorCode: params[6] });
        return { rows: [] };
      }
      if (/^UPDATE limit_alert_phones SET last_texted_at = CASE/.test(sql)) {
        const row = find(params[0]);
        if (['sent', 'logged'].includes(params[1])) row.last_texted_at = new Date();
        row.last_status = params[1];
        row.last_error = params[2];
        return { rows: [] };
      }
      if (/^SELECT id, phone_e164, country FROM limit_alert_phones WHERE verified_at IS NOT NULL ORDER BY id$/.test(sql)) {
        return { rows: db.phones.filter((p) => p.verified_at) };
      }
      if (/^SELECT phone_id, limit_key, level, texted_at, unknown_since, unknown_texted, refusals_texted_at, refusals_texted FROM limit_alert_marks/.test(sql)) {
        return { rows: db.marks.filter((m) => params[0].map(Number).includes(Number(m.phone_id))) };
      }
      if (/^INSERT INTO limit_alert_marks/.test(sql)) {
        const at = (v) => (v == null ? null : new Date(v));
        const next = {
          phone_id: params[0], limit_key: params[1], level: params[2], texted_at: at(params[3]), unknown_since: at(params[4]),
          unknown_texted: params[5], refusals_texted_at: at(params[6]), refusals_texted: params[7],
        };
        db.marks = db.marks.filter((m) => !(Number(m.phone_id) === Number(next.phone_id) && m.limit_key === next.limit_key));
        db.marks.push(next);
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return pool;
}

function brevo() {
  const calls = [];
  return {
    calls,
    fetch: async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 201, json: async () => ({ messageId: `m${calls.length}` }) };
    },
  };
}

const deps = (http, extra = {}) => ({ env: ENV, provider: 'brevo', fetch: http.fetch, sleep: async () => {}, code: () => '424242', ...extra });

test.beforeEach(() => smsSelect.invalidate());

test('adding a number texts it a code as a transactional limit_alert, and it is active only once confirmed', async () => {
  const pool = store();
  const http = brevo();
  const added = await texts.addPhone(pool, CONFIG, { phoneNumber: '+44 7700 900123', label: "Evan's phone", userId: 9 }, deps(http));
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, 'https://api.brevo.com/v3/transactionalSMS/send');
  assert.deepEqual(
    (({ type, tag, sender, recipient }) => ({ type, tag, sender, recipient }))(http.calls[0].body),
    { type: 'transactional', tag: 'limit_alert', sender: 'Homeroom', recipient: '447700900123' },
  );
  assert.match(http.calls[0].body.content, /^Homeroom: 424242 is your code to get platform limit alerts/);
  assert.deepEqual(pool.db.deliveries.map((d) => [d.kind, d.status, d.last4]), [['limit_alert', 'sent', '0123']]);
  assert.equal(added.verified, false);
  assert.equal(added.number, GB, 'shown in full until confirmed, so a typo can be seen');
  assert.ok(added.waitingForCode);
  assert.notEqual(pool.db.phones[0].verify_code_hash, '424242', 'the code is stored only as a hash');

  await assert.rejects(texts.verifyPhone(pool, { id: added.id, code: '111111' }), { code: 'wrong_code' });
  const confirmed = await texts.verifyPhone(pool, { id: added.id, code: '424242' });
  assert.equal(confirmed.verified, true);
  assert.equal(confirmed.number, '•••• 0123', 'masked once confirmed');
  assert.ok(!logged.some((line) => JSON.stringify(line).includes('7700900123')), 'the full number is never logged');
});

test('a code can be tried five times, and then a new one is needed', async () => {
  const pool = store();
  const added = await texts.addPhone(pool, CONFIG, { phoneNumber: GB, label: 'On call' }, deps(brevo()));
  for (let i = 0; i < texts.MAX_CODE_ATTEMPTS; i += 1) {
    await assert.rejects(texts.verifyPhone(pool, { id: added.id, code: '000000' }), { code: 'wrong_code' });
  }
  await assert.rejects(texts.verifyPhone(pool, { id: added.id, code: '424242' }), { code: 'too_many_attempts' });
});

test('Firebase cannot send alerts: adding is refused and nothing is texted', async () => {
  const pool = store({ provider: 'firebase' });
  const http = brevo();
  const { availability } = await texts.list(pool, CONFIG, { env: ENV });
  assert.deepEqual([availability.ready, availability.reason], [false, 'firebase']);
  await assert.rejects(
    texts.addPhone(pool, CONFIG, { phoneNumber: GB, label: 'On call' }, { env: ENV, fetch: http.fetch }),
    { code: 'sms_unavailable', message: /uses Firebase, which only sends sign-in codes/ },
  );
  assert.equal(http.calls.length, 0);
  assert.equal(pool.db.phones.length, 0);
});

test('no Sender ID for the country: refused, plainly, before anything is written', async () => {
  const pool = store();
  const http = brevo();
  await assert.rejects(
    texts.addPhone(pool, CONFIG, { phoneNumber: FR, label: 'Paris' }, deps(http)),
    { code: 'no_sender_id', message: /No Sender ID covers that number's country/ },
  );
  assert.equal(http.calls.length, 0);
  assert.equal(pool.db.phones.length, 0);
  const missing = await texts.availability(store(), { brevoSmsSenderIds: CONFIG.brevoSmsSenderIds }, { env: ENV });
  assert.deepEqual([missing.ready, missing.reason], [false, 'not_configured'], 'no key: not set up');
});

test('the sweep texts confirmed numbers once per crossing and records every send', async () => {
  const pool = store();
  const http = brevo();
  const added = await texts.addPhone(pool, CONFIG, { phoneNumber: GB, label: 'On call' }, deps(http));
  await texts.addPhone(pool, CONFIG, { phoneNumber: '+447700900456', label: 'Not confirmed' }, deps(http));
  await texts.verifyPhone(pool, { id: added.id, code: '424242' });
  http.calls.length = 0;

  let rows = [appsRow(300, 'warn')];
  const limits = async () => ({ rows });
  const run = (now) => texts.sweep(pool, CONFIG, deps(http, { limits, now: () => now }));

  const first = await run(NOON_PARIS);
  assert.equal(first.texts, 1, 'the confirmed number only');
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].body.recipient, '447700900123');
  assert.equal(http.calls[0].body.tag, 'limit_alert');
  assert.match(http.calls[0].body.content, /apps at 300 of 300\. New projects are being refused/);

  await run(NOON_PARIS + 5 * 60 * 1000);
  assert.equal(http.calls.length, 1, 'the next sweep, five minutes later: nothing new');

  rows = [appsRow(301, 'full')];
  await run(NOON_PARIS + 6 * HOUR);
  assert.equal(http.calls.length, 2, 'six hours on, still full: one reminder');
  assert.match(http.calls[1].body.content, /^Homeroom reminder: apps over the limit, 301 of 300/);

  const sends = pool.db.sends.filter((s) => s.what !== 'verify');
  assert.deepEqual(sends.map((s) => [s.what, s.limitKey, s.level, s.status, s.last4]), [
    ['crossing', 'apps', 'broken', 'sent', '0123'],
    ['reminder', 'apps', 'broken', 'sent', '0123'],
  ]);
  const card = await texts.list(pool, CONFIG, { env: ENV });
  assert.ok(card.phones.find((p) => p.id === added.id).lastTextedAt, 'the card shows when it was last texted');
});

test('a text due when SMS delivery is switched to Firebase is recorded as a refusal, not dropped', async () => {
  const pool = store();
  const http = brevo();
  const added = await texts.addPhone(pool, CONFIG, { phoneNumber: GB, label: 'On call' }, deps(http));
  await texts.verifyPhone(pool, { id: added.id, code: '424242' });
  http.calls.length = 0;
  pool.db.provider = 'firebase';
  smsSelect.invalidate();
  const out = await texts.sweep(pool, CONFIG, { env: ENV, fetch: http.fetch, limits: async () => ({ rows: [credit('out')] }), now: () => NOON_PARIS });
  assert.deepEqual([out.texts, out.refused], [0, 1]);
  assert.equal(http.calls.length, 0);
  const refusal = pool.db.sends.find((s) => s.what === 'crossing');
  assert.deepEqual([refusal.status, refusal.errorCode], ['refused', 'firebase_selected']);
  const card = await texts.list(pool, CONFIG, { env: ENV });
  assert.equal(card.phones[0].lastStatus, 'refused');
});

test('a test text and removing a number', async () => {
  const pool = store();
  const http = brevo();
  const added = await texts.addPhone(pool, CONFIG, { phoneNumber: GB, label: 'On call' }, deps(http));
  await assert.rejects(texts.testPhone(pool, CONFIG, { id: added.id }, deps(http)), { code: 'not_verified' });
  await texts.verifyPhone(pool, { id: added.id, code: '424242' });
  await texts.testPhone(pool, CONFIG, { id: added.id }, deps(http));
  assert.match(http.calls[http.calls.length - 1].body.content, /^Homeroom test: platform limit alerts will reach this number/);
  await texts.removePhone(pool, { id: added.id });
  assert.equal(pool.db.phones.length, 0);
  await assert.rejects(texts.removePhone(pool, { id: added.id }), { code: 'not_found' });
});

test('a second sweep running at the same moment skips instead of texting twice', async () => {
  const pool = store();
  const http = brevo();
  const added = await texts.addPhone(pool, CONFIG, { phoneNumber: GB, label: 'On call' }, deps(http));
  await texts.verifyPhone(pool, { id: added.id, code: '424242' });
  http.calls.length = 0;
  const taken = [];
  pool.connect = async () => ({
    async query(sql, params) {
      if (/pg_try_advisory_lock/.test(sql)) {
        taken.push(params[0]);
        return { rows: [{ acquired: taken.length > 1 ? false : true }] };
      }
      return { rows: [] };
    },
    release() {},
  });
  const { LIMIT_TEXTS_LOCK } = require('../src/services/advisory-locks');
  const limits = async () => ({ rows: [appsRow(300, 'warn')] });
  const first = await texts.sweep(pool, CONFIG, deps(http, { limits, now: () => NOON_PARIS }));
  assert.equal(first.texts, 1);
  pool.db.marks = [];
  const second = await texts.sweep(pool, CONFIG, deps(http, { limits, now: () => NOON_PARIS }));
  assert.equal(second.skipped, true, 'the lock was held elsewhere: this pass does nothing');
  assert.equal(http.calls.length, 1);
  assert.deepEqual(taken, [LIMIT_TEXTS_LOCK, LIMIT_TEXTS_LOCK]);
});

test('the sweep texts the first person turned away and logs it as turned_away', async () => {
  const pool = store();
  const http = brevo();
  const added = await texts.addPhone(pool, CONFIG, { phoneNumber: GB, label: 'On call' }, deps(http));
  await texts.verifyPhone(pool, { id: added.id, code: '424242' });
  http.calls.length = 0;
  let rows = [appsRow(300, 'warn')];
  const run = (now) => texts.sweep(pool, CONFIG, deps(http, { limits: async () => ({ rows }), now: () => now }));
  await run(NOON_PARIS);
  rows = [{ ...appsRow(300, 'full'), turnedAway: 1, turnedAwaySince: new Date(NOON_PARIS + 60 * 1000).toISOString() }];
  await run(NOON_PARIS + 5 * 60 * 1000);
  assert.equal(http.calls.length, 2);
  assert.match(http.calls[1].body.content, /^Homeroom: someone was just turned away at the app limit \(300 of 300\)/);
  const sends = pool.db.sends.filter((s) => s.what !== 'verify').map((s) => s.what);
  assert.deepEqual(sends, ['crossing', 'turned_away']);
  await run(NOON_PARIS + 10 * 60 * 1000);
  assert.equal(http.calls.length, 2, 'the same run, minutes later: nothing more');
});
