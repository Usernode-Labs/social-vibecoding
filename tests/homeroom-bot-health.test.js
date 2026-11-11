'use strict';

// The Homeroom bot dashboard's rollout health: where each figure's line is,
// that too little behind one is no verdict, that a read that fails is zeros
// rather than a broken dashboard, and how the Overview tab says it.
// tests/homeroom-bot-health-postgres.test.js runs the queries.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const health = require('../src/services/homeroom-bot-health');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const rows = (over = {}) => ({
  proposals: { up: 10, merged: 3, open: 2, timed: 8, median_secs: 30 * 3600, slowest_secs: 80 * 3600, ...over.proposals },
  questions: { asked: 6, answered: 2, closed: 0, waiting_of_asked: 4, median_answer_secs: 1800, waiting: 5, oldest_waiting_at: '2026-10-01T00:00:00Z', ...over.questions },
  turns: { runs: 40, failed: 3, builds: 10, builds_failed: 3, ...over.turns },
  chat: { turns: 30, failed: 4, broken: 1, recovered: 2, claims: 1, ...over.chat },
  cards: over.cards,
});

test('each figure says when it is past its line', () => {
  const h = health.shapeHealth(rows());
  assert.equal(h.days, 7);
  assert.deepEqual(h.proposals, {
    up: 10, merged: 3, closed: 5, open: 2, settled: 8, mergeRate: 3 / 8, timed: 8,
    medianHoursToProposal: 30, slowestHoursToProposal: 80,
  });
  assert.equal(h.questions.medianMinutesToAnswer, 30);
  assert.equal(h.questions.oldestWaitingAt, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(h.watch, {
    mergeRate: true, // 3 of 8 settled merged
    hoursToProposal: true, // a median of 30 hours
    questionsWaiting: true, // 4 of 6 still waiting
    turnFailures: true, // 6 of 50
    chatFailures: true, // 4 of 30
    cardFallbacks: null, // no plan card failed
  });
  assert.deepEqual(h.cards, { total: 0, repaired: 0, whole: 0, lines: 0, fallback: 0, kinds: {} });
  assert.equal(h.thresholds, health.THRESHOLDS);
});

test('on the line, or under it, is not past it', () => {
  const h = health.shapeHealth(rows({
    proposals: { up: 4, merged: 2, open: 0, median_secs: 24 * 3600 },
    questions: { asked: 4, waiting_of_asked: 2 },
    turns: { runs: 10, failed: 1, builds: 0, builds_failed: 0 },
    chat: { turns: 10, failed: 1 },
  }));
  assert.deepEqual(h.watch, { mergeRate: false, hoursToProposal: false, questionsWaiting: false, turnFailures: false, chatFailures: false, cardFallbacks: null });
});

test('too little behind a figure is no verdict, so a quiet week does not read as a broken one', () => {
  const h = health.shapeHealth(rows({
    proposals: { up: 3, merged: 0, open: 0, timed: 2 },
    questions: { asked: 3, waiting_of_asked: 3 },
    turns: { runs: 5, failed: 5, builds: 4, builds_failed: 4 },
    chat: { turns: 9, failed: 9 },
  }));
  assert.deepEqual(h.watch, { mergeRate: null, hoursToProposal: null, questionsWaiting: null, turnFailures: null, chatFailures: null, cardFallbacks: null });
  const empty = health.shapeHealth({});
  assert.equal(empty.proposals.mergeRate, null);
  assert.equal(empty.proposals.medianHoursToProposal, null);
  assert.equal(empty.questions.oldestWaitingAt, null);
  assert.deepEqual(empty.chat, { turns: 0, failed: 0, unanswered: 0, recovered: 0, claimsCaught: 0 });
});

test('a read that fails is zeros, and the others still count', async () => {
  const pool = {
    query: async (sql) => {
      if (/homeroom_bot_dm_turns/.test(sql)) throw new Error('relation does not exist');
      if (/FROM homeroom_bot_runs\n/.test(sql)) return { rows: [{ runs: 12, failed: 2, builds: 3, builds_failed: 0 }] };
      return { rows: [] };
    },
  };
  const h = await health.rolloutHealth(pool, { botUsername: 'homeroom_bot' });
  assert.deepEqual(h.turns, { runs: 12, failed: 2, builds: 3, buildsFailed: 0 });
  assert.equal(h.chat.turns, 0);
  assert.equal(h.proposals.up, 0);
});

test('the dashboard payload carries it, read-only, for view-only admins too', () => {
  const bot = read('src/services/homeroom-bot.js');
  assert.match(bot, /health: await require\('\.\/homeroom-bot-health'\)\.rolloutHealth\(pool, \{ botUsername: BOT_USERNAME \}\),/);
  const src = read('src/services/homeroom-bot-health.js');
  assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE)\b/, 'it only reads');
  // Never a person's words: no column that holds them is read.
  assert.doesNotMatch(src, /\b(content|asked_text|plan_change|question|question_default|build_note|reason|details)\s*(,|FROM|\))/i);
});

function loadPanel() {
  const { loadTsx } = require('./lib/render-tsx');
  return loadTsx('frontend/src/features/admin/admin-homeroom-bot-health.tsx', {
    stubs: {
      './admin-console.js': {
        AdminUI: new Proxy({}, {
          get: (_t, key) => (['btn', 'badge'].includes(key) ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` }) : String(key)),
        }),
      },
    },
  });
}

test('durations read the way a person says them', () => {
  const { duration } = loadPanel();
  assert.equal(duration(null), '–');
  assert.equal(duration(0.001), '1 min');
  assert.equal(duration(0.5), '30 min');
  assert.equal(duration(3.2), '3 h');
  assert.equal(duration(48), '2 d');
  assert.equal(duration(52), '2 d 4 h');
});

test('the panel says each figure, flags only what is past its line, and lists the week\'s failed answers', () => {
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const { RolloutHealth, healthRows, failureLine } = loadPanel();
  const h = health.shapeHealth(rows({ chat: { turns: 9, failed: 1 } }));
  const now = Date.parse('2026-10-06T00:00:00Z');
  const byKey = Object.fromEntries(healthRows(h, now).map((r) => [r.key, r]));
  assert.equal(byKey.proposals.value, '38%');
  assert.equal(byKey.proposals.detail, '10 proposals put up: 3 merged, 5 closed without merging, 2 still open.');
  assert.equal(byKey.time.value, '1 d 6 h');
  assert.equal(byKey.questions.value, '4 of 6');
  assert.match(byKey.questions.detail, /2 answered \(in 30 min, the median\), 0 settled another way\. 5 questions waiting in all; the oldest was asked 5 d ago\./);
  assert.equal(byKey.turns.value, '6 of 50');
  assert.equal(byKey.chat.value, '1 of 9');
  assert.equal(byKey.chat.note, 'Too few DM answers to judge yet.');
  assert.equal(byKey.cards.value, '0 of 0');
  assert.equal(byKey.cards.note, 'Too few plan cards to judge yet.');
  for (const r of Object.values(byKey)) {
    assert.ok(!/—/.test(`${r.label}${r.detail}${r.note}`), r.key);
  }

  const failures = [{ at: '2026-10-05T10:00:00Z', username: 'ada', error: 'invalid_request', failures: ['r1:invalid_request:400'], fallback: 'plain', rounds: 1 }];
  assert.match(failureLine(failures[0]), /@ada · invalid_request · r1:invalid_request:400 · answered by: plain$/);
  const html = renderToHtml(createElement(RolloutHealth, { health: h, failures }));
  assert.match(html, /id="admin-homeroom-bot-rollout"/);
  assert.match(html, /id="admin-homeroom-bot-rollout-summary">4 figures worth a look</);
  assert.equal((html.match(/data-rollout="/g) || []).length, 6);
  assert.match(html, /data-rollout="chat" data-watch="unknown"/);
  assert.match(html, /data-rollout="proposals" data-watch="true"/);
  assert.equal((html.match(/>Worth a look</g) || []).length, 4, 'a badge only where a figure is past its line');
  assert.match(html, /id="admin-homeroom-bot-rollout-failures"/);
  assert.match(html, /DM answers that failed in the last 7 days \(1\)/);

  const loading = renderToHtml(createElement(RolloutHealth, {}));
  assert.match(loading, /Loading…/);
  assert.doesNotMatch(loading, /data-rollout=/);
  assert.match(loading, /No DM answer failed in the last 7 days/);
});

test('plan cards: how many were fixed, kept their lines, fell back, and which rule broke most', () => {
  const { healthRows } = loadPanel();
  const h = health.shapeHealth(rows({
    cards: { total: 10, repaired: 6, whole: 3, lines_only: 3, fallback: 4, kinds: { summary_long: 7, line_long: 3, line_not_sentence: 1 } },
  }));
  assert.deepEqual(h.cards, {
    total: 10, repaired: 6, whole: 3, lines: 3, fallback: 4,
    kinds: { summary_long: 7, line_long: 3, line_not_sentence: 1 },
  });
  assert.equal(h.watch.cardFallbacks, true, '4 of 10 fell back, more than 1 in 5');
  const row = healthRows(h).find((r) => r.key === 'cards');
  assert.equal(row.label, 'Plan cards that fell back');
  assert.equal(row.value, '4 of 10');
  assert.equal(row.detail, '6 fixed by a repair turn, 3 kept their numbered lines without a summary, 4 fell back to the older lines. Most often: summary too long (7).');
  assert.match(row.note, /More than 1 in 5 of its plan cards fell back/);
  assert.equal(health.shapeHealth(rows({ cards: { total: 4, fallback: 3 } })).watch.cardFallbacks, null, 'too few to judge');
});

// Step 5 of the bot's one model (11 Nov 2026): the numbers that say whether
// it reads requests again less, and says less twice.
const REREAD_ROWS = {
  reads: { reads: 12, requests: 5, kinds: { fix: 3, sync: 1, hand_off: 2 } },
  why: [
    { week: '2026-11-09', code: 'changed:discussion', n: 4 },
    { week: '2026-11-09', code: 'changed:voice', n: 2 },
    { week: '2026-11-02', code: 'checks_failing', n: 3 },
    { week: '2026-11-02', code: 'new', n: 3 },
  ],
  taps: [
    { week: '2026-11-09', surface: 'thread', taps: 10, not_found: 1, gone: 2 },
    { week: '2026-11-09', surface: 'chat', taps: 5, not_found: 0, gone: 1 },
    { week: '2026-10-26', surface: 'card', taps: 3, not_found: 0, gone: 0 },
  ],
};

test('step 5: reads per request, why it read by week, Main Chat repairs and dead taps, from their rows', () => {
  const h = health.shapeHealth({ ...rows(), rereads: REREAD_ROWS });
  const r = h.rereads;
  assert.equal(r.days, 7);
  assert.equal(r.weeks, health.WEEKS);
  assert.deepEqual([r.reads, r.requests, r.perRequest], [12, 5, 12 / 5]);
  assert.deepEqual(r.otherRuns, { fix: 3, sync: 1, hand_off: 2 }, 'the runs that read no request, by kind');
  assert.deepEqual(r.byWeek.map((w) => w.week), ['2026-11-09', '2026-11-02', '2026-10-26'], 'newest first');
  assert.deepEqual(r.byWeek[0], {
    week: '2026-11-09', reads: 6, why: { 'changed:discussion': 4, 'changed:voice': 2 },
    taps: 15, notFound: 1, gone: 3,
    surfaces: { thread: { taps: 10, notFound: 1, gone: 2 }, chat: { taps: 5, notFound: 0, gone: 1 } },
  });
  assert.deepEqual(r.byWeek[2], { week: '2026-10-26', reads: 0, why: {}, taps: 3, notFound: 0, gone: 0, surfaces: { card: { taps: 3, notFound: 0, gone: 0 } } });
  assert.deepEqual(r.claimRepair, { recovered: 2, turns: 30, rate: 2 / 30 }, 'the Main Chat answers of the same week');
  assert.equal(r.duplicateNotes, null, 'not counted: no count was read');
  // Step 4: counted from the posts' said-once keys (bot-post.js duplicateNotes).
  assert.equal(health.shapeRereads({ ...REREAD_ROWS, duplicates: 4 }).duplicateNotes, 4);
  assert.equal(health.shapeRereads({ ...REREAD_ROWS, duplicates: 0 }).duplicateNotes, 0);
  const empty = health.shapeHealth({}).rereads;
  assert.deepEqual([empty.reads, empty.requests, empty.perRequest, empty.byWeek, empty.claimRepair.rate], [0, 0, null, [], null]);
});

test('step 5: the re-read numbers are read off the runs that read, and the taps the routes record', async () => {
  const asked = [];
  const pool = {
    query: async (sql, params) => {
      asked.push({ sql: String(sql), params });
      if (/AS requests/.test(sql)) return { rows: [REREAD_ROWS.reads] };
      if (/AS code/.test(sql)) return { rows: REREAD_ROWS.why };
      if (/bot_offer_tap/.test(sql)) return { rows: REREAD_ROWS.taps };
      return { rows: [] };
    },
  };
  const h = await health.rolloutHealth(pool, { botUsername: 'homeroom_bot' });
  assert.equal(h.rereads.perRequest, 12 / 5);
  assert.equal(h.rereads.byWeek.length, 3);
  const reads = asked.find((q) => /AS requests/.test(q.sql));
  assert.match(reads.sql, /COUNT\(DISTINCT \(app_id, issue_number\)\) FILTER \(WHERE look_kind IS NULL\)/, 'a request read twice is one request');
  assert.match(reads.sql, /reused_run_id IS NULL/, 'a held verdict used again is no read');
  assert.deepEqual(reads.params, [7]);
  const why = asked.find((q) => /AS code/.test(q.sql));
  assert.match(why.sql, /COALESCE\(read_reason, 'unknown'\)/);
  assert.match(why.sql, /reused_run_id IS NULL AND look_kind IS NULL/, 'reads only');
  assert.deepEqual(why.params, [health.WEEKS]);
  const taps = asked.find((q) => /bot_offer_tap/.test(q.sql));
  assert.match(taps.sql, /metadata->>'status' = '404'/);
  assert.match(taps.sql, /metadata->>'status' = '410'/);
  assert.equal(require('../src/services/events').EVENT_TYPES.BOT_OFFER_TAP, 'bot_offer_tap');
  // Soft even where the watched figures are not: they watch nothing.
  const broken = {
    query: async (sql) => {
      if (/AS requests|AS code|bot_offer_tap/.test(sql)) throw new Error('down');
      return { rows: [] };
    },
  };
  const soft = await health.rolloutHealth(broken, { botUsername: 'homeroom_bot', failSoft: false });
  assert.equal(soft.rereads.reads, 0);
});

test('step 5: every tap on an offer or a card is recorded as its route answered it', async () => {
  const events = require('../src/services/events');
  const recorded = [];
  await events.recordBotOfferTap({ query: async (sql, params) => { recorded.push(params); return { rows: [] }; } },
    { surface: 'thread', status: 410, userId: 7, appId: 3 });
  assert.deepEqual(recorded, [[7, 3, null, 'bot_offer_tap', JSON.stringify({ surface: 'thread', status: 410 })]]);
  await events.recordBotOfferTap({ query: () => { throw new Error('down'); } }, { surface: 'chat', status: 404 });
  const chat = read('src/routes/chat.js');
  const conversations = read('src/routes/conversations.js');
  const after = (src, call) => src.slice(src.indexOf(call), src.indexOf(call) + 700);
  assert.match(after(chat, '.decideOffer(pool, config, {'), /recordBotOfferTap\(pool, \{\n\s+surface: 'thread', status: out\.ok \? 200 : out\.status \|\| 400,/);
  assert.match(after(conversations, '.decideOfferTap(pool, config,'), /recordBotOfferTap\(pool, \{\n\s+surface: 'chat', status: out\.ok \? 200 : out\.status \|\| 400,/);
  assert.match(after(conversations, "require('../services/homeroom-bot-cards').decide(pool, config, {"),
    /recordBotOfferTap\(pool, \{\n\s+surface: 'card', status: out\.ok \? 200 : out\.status \|\| 400,/);
});

test('step 5: the panel says the re-read numbers, and how many notes were said twice', () => {
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const { RolloutHealth, rereadRows, weekLabel } = loadPanel();
  const h = health.shapeHealth({ ...rows(), rereads: REREAD_ROWS });
  assert.equal(weekLabel('2026-11-09'), 'Week of 9 Nov');
  const byKey = Object.fromEntries(rereadRows(h.rereads).map((r) => [r.key, r]));
  assert.equal(byKey.reads.value, '2.4');
  assert.deepEqual(byKey.reads.lines, [
    '12 reads of 5 requests in the last 7 days. A held verdict used again without a read is not one.',
    'Not reads: 3 fix rounds, 1 sync with main, 2 hand-offs.',
  ]);
  assert.equal(byKey.why.value, '6');
  assert.deepEqual(byKey.why.lines, [
    'Week of 9 Nov: changed:discussion 4, changed:voice 2.',
    'Week of 2 Nov: checks_failing 3, new 3.',
  ]);
  assert.equal(byKey.repair.value, '7%');
  assert.match(byKey.repair.lines[0], /^2 of 30 answers in the last 7 days were asked again before they were sent/);
  assert.equal(byKey.taps.value, '4 of 15');
  assert.equal(byKey.taps.lines[0], 'Week of 9 Nov: 1 found nothing to do (404), 3 found the offer gone (410), of 15 taps.');
  assert.equal(byKey.notes.value, '–', 'none read');
  assert.match(byKey.notes.lines[0], /^Could not be counted just now/);
  const counted = Object.fromEntries(rereadRows(health.shapeHealth({ ...rows(), rereads: { ...REREAD_ROWS, duplicates: 3 } }).rereads)
    .map((r) => [r.key, r]));
  assert.equal(counted.notes.value, '3');
  assert.equal(counted.notes.lines[0], 'Notes on requests said, or asked for, more than once in the last 7 days.');
  for (const r of Object.values(byKey)) assert.ok(!/—/.test(`${r.label}${r.value}${r.lines.join('')}`), r.key);

  const html = renderToHtml(createElement(RolloutHealth, { health: h, failures: [] }));
  assert.match(html, /id="admin-homeroom-bot-rereads"/);
  assert.equal((html.match(/data-reread="/g) || []).length, 5);
  assert.equal((html.match(/data-rollout="/g) || []).length, 6, 'the watched figures are as they were');
  const none = renderToHtml(createElement(RolloutHealth, { health: { ...h, rereads: null }, failures: [] }));
  assert.doesNotMatch(none, /admin-homeroom-bot-rereads/, 'an older payload shows no section');
  const quiet = rereadRows(health.shapeHealth({}).rereads);
  assert.deepEqual(quiet.find((r) => r.key === 'why').lines, ['No reads in the last 4 weeks.']);
  assert.deepEqual(quiet.find((r) => r.key === 'taps').lines, ['No taps on its offers in the last 4 weeks.']);
  assert.equal(quiet.find((r) => r.key === 'reads').value, '–');
});

test('the Overview tab shows it under the bot\'s card, and the declared check selects on it', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(tsx, /<RolloutHealth health=\{payload\?\.health\} failures=\{payload\?\.dmChat\?\.recentFailures\} incidents=\{payload\?\.incidents\} \/>/);
  assert.ok(tsx.indexOf('id="admin-homeroom-bot-cadence"') < tsx.indexOf('<RolloutHealth'));
  assert.ok(tsx.indexOf('<RolloutHealth') < tsx.indexOf('Working on now'));
  const check = require('../dapp.json').tests.find((c) => c.path === '/#admin/homeroom-bot' && /rollout health/.test(c.name));
  assert.ok(check, 'folded into the dashboard\'s own check');
  assert.match(check.expectSelector, /#admin-homeroom-bot-rollout-rows \[data-rollout=\\?"chat\\?"\]/);
});
