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
const progress = require('../src/services/homeroom-bot-progress');
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

test('what a held request is doing, in the bot\'s words, and what it waits for', () => {
  const holds = new Map([[11, 1]]);
  const row = { app_id: 11, issue_number: 5, slug: 'flat-4b-chores', name: 'Flat 4B Chores' };
  // Whatever else is in the way, the first version is what it waits for.
  const busy = new Map([[11, [{ issueNumber: 1, since: new Date(), what: 'reading' }]]]);
  assert.deepEqual(progress.queuedWait(row, { busy, queuePosition: 1, holds }), {
    doing: 'waiting for the first version to go live; I\'ll start on this as soon as it does',
    waitingFor: { reason: 'first_version_pending', number: 1 },
  });
  assert.deepEqual(progress.buildWait(row, { busy, holds }), {
    doing: 'ready to build; I\'ll start as soon as the first version goes live',
    waitingFor: { reason: 'first_version_pending', number: 1 },
  });
  // The first version, an admin's Run now, and every other project read as before.
  assert.equal(progress.queuedWait({ ...row, issue_number: 1 }, { queuePosition: 1, holds }).doing, 'next in line for a free builder');
  assert.equal(progress.queuedWait({ ...row, queue_reason: 'admin' }, { queuePosition: 1, holds }).doing, 'next in line for a free builder');
  assert.equal(progress.queuedWait({ ...row, app_id: 12 }, { queuePosition: 1, holds }).doing, 'next in line for a free builder');
  assert.equal(progress.buildWait({ ...row, app_id: 12 }, { holds }).doing, 'ready to build; its build starts next');
  assert.deepEqual(progress.queuedWait(row, {}), {}, 'with nothing known, the stage\'s own words stand');
  // Before the first version is filed it has no number to give.
  assert.deepEqual(progress.firstVersionWait(row, new Map([[11, null]])), { reason: 'first_version_pending' });
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
  assert.equal(activity.cardText(ctx, dmSvc, { queued: true }), `${line}\n\nWaiting for a free builder. This card follows it from here.`);
  assert.equal(activity.cardText(ctx, dmSvc, { filed: true }), `${line}\n\nFiled. This card follows it from here.`);
  // A look that started is never held, whatever it is handed.
  assert.match(activity.cardText(ctx, dmSvc, { waitsForFirstVersion: true }), /I'm working on this now/);
  for (const words of [activity.FIRST_VERSION_WAIT_WORDS, progress.FIRST_VERSION_WAIT, progress.FIRST_VERSION_BUILD_WAIT]) {
    assert.doesNotMatch(words, /\u2014/, 'no em dash');
  }
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

test('a queued or filed card asks whether the project\'s first version holds the request', async () => {
  const held = startDeps({ holds: new Map([[11, 1]]) });
  await activity.startCard(held.pool, { inDm: true,
    app, issueNumber: 2, requester: sam, bot: homeroomBot, jobKey: 41, settings: held.settings, queued: true,
    deps: { dm: held.dm, botSvc: held.botSvc },
  });
  assert.deepEqual(held.asked, [[11]]);
  assert.match(held.sent[0].content, /\n\nWaiting for the first version to go live\. I'll start on this as soon as it does\.$/);
  assert.equal(held.sent[0].idempotencyKey, 'hrbot-activity-41', 'the same key its look will start from');

  const filed = startDeps({ holds: new Map([[11, 1]]) });
  await activity.startCard(filed.pool, { inDm: true,
    app, issueNumber: 5, requester: sam, bot: homeroomBot, jobKey: 42, settings: filed.settings, filed: true,
    deps: { dm: filed.dm, botSvc: filed.botSvc },
  });
  assert.match(filed.sent[0].content, /\n\nFiled\. Waiting for the first version to go live\./);

  const free = startDeps();
  await activity.startCard(free.pool, { inDm: true,
    app, issueNumber: 2, requester: sam, bot: homeroomBot, jobKey: 43, settings: free.settings, queued: true,
    deps: { dm: free.dm, botSvc: free.botSvc },
  });
  assert.match(free.sent[0].content, /Waiting for a free builder/, 'nothing pending: as before');

  const broken = startDeps({ holdsThrow: true });
  await activity.startCard(broken.pool, { inDm: true,
    app, issueNumber: 2, requester: sam, bot: homeroomBot, jobKey: 44, settings: broken.settings, queued: true,
    deps: { dm: broken.dm, botSvc: broken.botSvc },
  });
  assert.match(broken.sent[0].content, /Waiting for a free builder/, 'a read that fails costs the card nothing');

  // The first version's own card, and a look that started, never ask.
  const own = startDeps({ holds: new Map([[11, 1]]) });
  await activity.startCard(own.pool, { inDm: true,
    app, issueNumber: 1, requester: { ...sam, firstVersion: true }, bot: homeroomBot, jobKey: 45, settings: own.settings, queued: true,
    deps: { dm: own.dm, botSvc: own.botSvc },
  });
  const started = startDeps({ holds: new Map([[11, 1]]) });
  await activity.startCard(started.pool, { inDm: true,
    app, issueNumber: 2, requester: sam, bot: homeroomBot, jobKey: 46, settings: started.settings,
    deps: { dm: started.dm, botSvc: started.botSvc },
  });
  assert.deepEqual([...own.asked, ...started.asked], []);
});

test('the read lane and the build lane both hold for the first version; the merge wakes the loop', () => {
  const lane = SRC.slice(SRC.indexOf('async function liveCandidates('), SRC.indexOf('async function liveBuildCandidates('));
  assert.match(lane, /AND \(fu\.id IS NOT NULL OR q\.reason = 'admin' OR NOT EXISTS \(\s+SELECT 1 FROM homeroom_bot_first_versions fv\s+WHERE fv\.app_id = q\.app_id AND fv\.bot_builds AND fv\.issue_number IS DISTINCT FROM q\.issue_number\s+AND \$\{FIRST_VERSION_PENDING_SQL\}/,
    'a follow-up on a change already up and an admin\'s Run now go ahead; the first version\'s own request too');
  const builds = SRC.slice(SRC.indexOf('async function liveBuildCandidates('), SRC.indexOf('function pickLiveBuilds('));
  assert.match(builds, /AND NOT EXISTS \(\s+SELECT 1 FROM homeroom_bot_first_versions fv\s+WHERE fv\.app_id = r\.app_id AND fv\.bot_builds AND fv\.issue_number IS DISTINCT FROM r\.issue_number\s+AND \$\{FIRST_VERSION_PENDING_SQL\}/);
  const holds = SRC.slice(SRC.indexOf('async function firstVersionHolds('), SRC.indexOf('function heldForFirstVersion('));
  assert.match(holds, /WHERE fv\.app_id = ANY\(\$1::int\[\]\) AND fv\.bot_builds\s+AND \$\{FIRST_VERSION_PENDING_SQL\}/,
    'the card reads the rule the loop does');
  const merged = SRC.slice(SRC.indexOf('async function noteRequestMerged('), SRC.indexOf('function requestPass('));
  assert.match(merged, /noteIssueActivity\(\{ appId, issueNumber: Number\(firstVersion\[0\]\.issue_number\), reason: 'first_version_live' \}\)/,
    'on every Pod, so whichever runs the loop picks the waiting requests up now');
  // The rule asks no parameters of the queries it joins, so neither lane's
  // parameter list moved.
  assert.doesNotMatch(bot.FIRST_VERSION_PENDING_SQL, /\$\d/);
});
