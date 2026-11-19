'use strict';

// A project's first version goes first (Flat 4B Chores, 4 October 2026):
// while it is not live, the bot starts nothing else on the project, and a
// request that waits says what it waits for. The queries themselves run
// against PostgreSQL in homeroom-bot-first-version-hold-postgres.test.js;
// this file pins the pure parts, the words, and where the rule is read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const activity = require('../src/services/homeroom-bot-activity');
const dmSvc = require('../src/services/homeroom-bot-dm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot.js'), 'utf8');

test('a request waits for its project\'s first version, unless it is the first version or an admin\'s Run now', () => {
  const holds = new Map([[11, 1], [12, null]]);
  assert.equal(bot.heldForFirstVersion(holds, { appId: 11, issueNumber: 2 }), true);
  assert.equal(bot.heldForFirstVersion(holds, { appId: '11', issueNumber: '5' }), true, 'ids as the database returns them');
  assert.equal(bot.heldForFirstVersion(holds, { appId: 11, issueNumber: 1 }), false, 'the first version itself');
  assert.equal(bot.heldForFirstVersion(holds, { appId: 11, issueNumber: 2, firstVersion: true }), false);
  assert.equal(bot.heldForFirstVersion(holds, { appId: 11, issueNumber: 2, reason: 'admin' }), false, 'an admin\'s Run now');
  assert.equal(bot.heldForFirstVersion(holds, { appId: 12, issueNumber: 1 }), true, 'not filed yet: everything waits');
  assert.equal(bot.heldForFirstVersion(holds, { appId: 13, issueNumber: 2 }), false, 'a project with nothing pending');
  assert.equal(bot.heldForFirstVersion(null, { appId: 11, issueNumber: 2 }), false);
  assert.equal(bot.FIRST_VERSION_HOLD, 'first_version_pending');
});

// 19 Nov 2026: what a held request is doing is its stored work state
// (services/work-state.js), in the words every surface says it; the bot's
// own account of it (requestStates' queuedWait) had no reader left.
test('what a held request is doing, as every surface says it', () => {
  const ws = require('../src/services/work-state');
  const queued = { app_id: 11, issue_number: 5, queue_id: 3, enqueued_at: '2026-10-04T10:00:00Z' };
  // The bot's own rule decides the hold (heldForFirstVersion, read by refresh).
  const held = ws.derive({ ...queued, held_first_version: true });
  assert.deepEqual([held.stage, held.line, held.whoseMove], ['reading', { code: 'first_version_wait' }, 'bot']);
  assert.equal(ws.says(held), 'Not started yet · Waiting for the first version to go live');
  // The first version, an admin's Run now, and every other project read as before.
  const free = ws.derive({ ...queued, held_first_version: false });
  assert.deepEqual([free.stage, free.line], ['reading', { code: 'queued' }]);
  assert.equal(ws.says(free), 'Not started yet · Waiting its turn');
  // A look under way is never held.
  assert.equal(ws.derive({ ...queued, started_at: '2026-10-04T10:01:00Z', held_first_version: true }).line, null);
});

test('the card of a request filed or queued while the first version is not live says so, once', () => {
  const ctx = { appName: 'Flat 4B Chores', issueNumber: 2, issueTitle: 'Bin day reminder', firstVersion: false };
  const line = '**Flat 4B Chores** · request #2: Bin day reminder';
  assert.equal(activity.FIRST_VERSION_WAIT_WORDS, 'Waiting for the first version to go live. I\'ll start on this as soon as it does.');
  assert.equal(activity.cardText(ctx, dmSvc, { queued: true, waitsForFirstVersion: true }),
    `${line}\n\nWaiting for the first version to go live. I'll start on this as soon as it does.`);
  assert.equal(activity.cardText(ctx, dmSvc, { filed: true, waitsForFirstVersion: true }),
    `${line}\n\nFiled. Waiting for the first version to go live. I'll start on this as soon as it does.`);
  // Without the hold, the words are what they were.
  // 13 Nov 2026: and they say whose line it is: the bot's own, which starts
  // by itself ("Waiting for a free builder" read as a wait for another person).
  assert.equal(activity.QUEUED_WORDS, 'I\'ll start on this by myself as soon as I have a free slot.');
  assert.equal(activity.cardText(ctx, dmSvc, { queued: true }), `${line}\n\n${activity.QUEUED_WORDS} This card follows it from here.`);
  assert.equal(activity.cardText(ctx, dmSvc, { filed: true }), `${line}\n\nFiled. This card follows it from here.`);
  // A look that started is never held, whatever it is handed.
  assert.match(activity.cardText(ctx, dmSvc, { waitsForFirstVersion: true }), /I'm working on this now/);
  assert.doesNotMatch(activity.FIRST_VERSION_WAIT_WORDS, /\u2014/, 'no em dash');
});

function startDeps({ holds = new Map(), holdsThrow = false } = {}) {
  const sent = [];
  const asked = [];
  const pool = { async query() { return { rows: [] }; } };
  const dm = {
    hasBot: dmSvc.hasBot,
    requestLine: dmSvc.requestLine,
    async requestStart() { return null; },
    async sendDm(_pool, args) { sent.push(args); return { conversationId: 5, messageId: 900, duplicate: false }; },
  };
  const botSvc = {
    async firstVersionHolds(_pool, appIds) {
      asked.push(appIds);
      if (holdsThrow) throw new Error('database gone');
      return holds;
    },
    heldForFirstVersion: bot.heldForFirstVersion,
  };
  return { pool, dm, botSvc, sent, asked, settings: { mode: 'shadow' } };
}

const app = { id: 11, slug: 'flat-4b-chores', name: 'Flat 4B Chores' };
const homeroomBot = { id: 1, username: 'homeroom_bot' };
const sam = { userId: 8, username: 'sam', hasPlatformAccess: true, issueTitle: 'Bin day reminder', firstVersion: false };

// 5 Nov 2026 (docs/plans/bot-one-model.md, step 4): an ordinary request's
// card no longer goes to its requester's chat with the bot, so no card says
// it waits for the first version. Its stored stage does, on every screen
// (work-state.js: reading · first_version_wait, by the same rule:
// tests/work-state.test.js), and a project chat's card as before.
test('no card asks about the hold for an ordinary request; a first version\'s own card never did', async () => {
  const held = startDeps({ holds: new Map([[11, 1]]) });
  assert.equal(await activity.startCard(held.pool, { inDm: true,
    app, issueNumber: 2, requester: sam, bot: homeroomBot, jobKey: 41, settings: held.settings, queued: true,
    deps: { dm: held.dm, botSvc: held.botSvc },
  }), null);
  assert.deepEqual([held.asked, held.sent], [[], []], 'nothing asked, nothing sent');

  const own = startDeps({ holds: new Map([[11, 1]]) });
  await activity.startCard(own.pool, { inDm: true,
    app, issueNumber: 1, requester: { ...sam, firstVersion: true }, bot: homeroomBot, jobKey: 45, settings: own.settings, queued: true,
    deps: { dm: own.dm, botSvc: own.botSvc },
  });
  assert.deepEqual(own.asked, []);
  assert.equal(own.sent.length, 1, 'the first version\'s own card');
});

test('the stored stage reads the hold by the bot\'s own rule', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src/services/work-state.js'), 'utf8');
  assert.match(src, /const holds = await bot\.firstVersionHolds\(db, \[\.\.\.new Set\(rows\.map\(\(r\) => Number\(r\.app_id\)\)\)\]\)/);
  assert.match(src, /row\.held_first_version = bot\.heldForFirstVersion\(holds, \{/);
});

test('the read lane and the build lane both hold for the first version; the merge wakes the lane', () => {
  // The lane's candidates (bot-lane reads them, rules/bot-loop.ts).
  const rules = require('../src/workflow/rules/bot-loop.ts');
  assert.match(rules.READ_CANDIDATES_SQL, /AND \(fu\.id IS NOT NULL OR q\.reason = 'admin' OR NOT EXISTS \(\s+SELECT 1 FROM homeroom_bot_first_versions fv\s+WHERE fv\.app_id = q\.app_id AND fv\.bot_builds AND fv\.issue_number IS DISTINCT FROM q\.issue_number\s+AND \(\s+\(fv\.status IN/,
    'a follow-up on a change already up and an admin\'s Run now go ahead; the first version\'s own request too');
  assert.match(rules.BUILD_CANDIDATES_SQL, /AND NOT EXISTS \(\s+SELECT 1 FROM homeroom_bot_first_versions fv\s+WHERE fv\.app_id = w\.app_id AND fv\.bot_builds AND fv\.issue_number IS DISTINCT FROM \(w\.data->>'issueNumber'\)::int\s+AND \(\s+\(fv\.status IN/);
  assert.ok(rules.READ_CANDIDATES_SQL.includes(rules.FIRST_VERSION_PENDING_SQL));
  assert.ok(rules.BUILD_CANDIDATES_SQL.includes(rules.FIRST_VERSION_PENDING_SQL));
  assert.equal(bot.FIRST_VERSION_PENDING_SQL, rules.FIRST_VERSION_PENDING_SQL, 'the card reads the rule the lane does');
  const holds = SRC.slice(SRC.indexOf('async function firstVersionHolds('), SRC.indexOf('function heldForFirstVersion('));
  assert.match(holds, /WHERE fv\.app_id = ANY\(\$1::int\[\]\) AND fv\.bot_builds\s+AND \$\{FIRST_VERSION_PENDING_SQL\}/);
  const merged = SRC.slice(SRC.indexOf('async function noteRequestMerged('), SRC.indexOf('async function pauseOnBudget('));
  assert.match(merged, /if \(firstVersion\.length\) \{[\s\S]*?await \(deps\.platform \|\| platform\(\)\)\.botRefresh\(appId\)/,
    'the lane refreshes the project soon, wherever the workflow runs, so the waiting requests are picked up now');
  // The rule asks no parameters of the queries it joins, so neither lane's
  // parameter list moved.
  assert.doesNotMatch(bot.FIRST_VERSION_PENDING_SQL, /\$\d/);
});
