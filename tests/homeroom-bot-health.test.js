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
  });
  assert.equal(h.thresholds, health.THRESHOLDS);
});

test('on the line, or under it, is not past it', () => {
  const h = health.shapeHealth(rows({
    proposals: { up: 4, merged: 2, open: 0, median_secs: 24 * 3600 },
    questions: { asked: 4, waiting_of_asked: 2 },
    turns: { runs: 10, failed: 1, builds: 0, builds_failed: 0 },
    chat: { turns: 10, failed: 1 },
  }));
  assert.deepEqual(h.watch, { mergeRate: false, hoursToProposal: false, questionsWaiting: false, turnFailures: false, chatFailures: false });
});

test('too little behind a figure is no verdict, so a quiet week does not read as a broken one', () => {
  const h = health.shapeHealth(rows({
    proposals: { up: 3, merged: 0, open: 0, timed: 2 },
    questions: { asked: 3, waiting_of_asked: 3 },
    turns: { runs: 5, failed: 5, builds: 4, builds_failed: 4 },
    chat: { turns: 9, failed: 9 },
  }));
  assert.deepEqual(h.watch, { mergeRate: null, hoursToProposal: null, questionsWaiting: null, turnFailures: null, chatFailures: null });
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
  for (const r of Object.values(byKey)) {
    assert.ok(!/—/.test(`${r.label}${r.detail}${r.note}`), r.key);
  }

  const failures = [{ at: '2026-10-05T10:00:00Z', username: 'ada', error: 'invalid_request', failures: ['r1:invalid_request:400'], fallback: 'plain', rounds: 1 }];
  assert.match(failureLine(failures[0]), /@ada · invalid_request · r1:invalid_request:400 · answered by: plain$/);
  const html = renderToHtml(createElement(RolloutHealth, { health: h, failures }));
  assert.match(html, /id="admin-homeroom-bot-rollout"/);
  assert.match(html, /id="admin-homeroom-bot-rollout-summary">4 figures worth a look</);
  assert.equal((html.match(/data-rollout="/g) || []).length, 5);
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

test('the Overview tab shows it under the bot\'s card, and the declared check selects on it', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(tsx, /<RolloutHealth health=\{payload\?\.health\} failures=\{payload\?\.dmChat\?\.recentFailures\} \/>/);
  assert.ok(tsx.indexOf('id="admin-homeroom-bot-cadence"') < tsx.indexOf('<RolloutHealth'));
  assert.ok(tsx.indexOf('<RolloutHealth') < tsx.indexOf('Working on now'));
  const check = require('../dapp.json').tests.find((c) => c.path === '/#admin/homeroom-bot' && /rollout health/.test(c.name));
  assert.ok(check, 'folded into the dashboard\'s own check');
  assert.match(check.expectSelector, /#admin-homeroom-bot-rollout-rows \[data-rollout=\\?"chat\\?"\]/);
});
