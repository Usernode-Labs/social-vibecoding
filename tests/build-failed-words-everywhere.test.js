'use strict';

// A build Homeroom bot could not finish is said the same plain way wherever
// it is said (5 Oct 2026, Page Turners #3).
//
// The requester's DM said "I tried to build this but couldn't finish (the
// build ran past its time limit (finished after a restart)). A person can pick
// it up from here." #3895 fixed the DM: what happened in plain words
// (homeroom-bot-dm.js buildFailedWords) and "Reply here and I'll try again."
// Three places still had the old words:
//
//   - the bot's post on the request, which everybody in the project reads
//     (and its GitHub comment): "Homeroom bot tried to build this but
//     couldn't finish: <the run's own record>. A person could pick it up from
//     here." (homeroom-bot-live.js buildFailedText);
//   - the push for that DM, and its bell row: "Stopped: something went wrong
//     while I was building. Tap Try again." (homeroom-bot-notify-copy.js,
//     which the push and the bell both read; tests/homeroom-bot-notify.test.js
//     holds the two together).
//
// Pinned here: the post says each cause as the DM does, from the same reading
// of the run's record, never the record itself; it says how anybody starts it
// again, and that is true (a person's reply there is activity the bot reads
// again: homeroom-bot.js classifyIssue); the push and the bell row end as the
// DM ends; and no failure surface says "pick it up" any more.
//
// Run with: node --test tests/build-failed-words-everywhere.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dm = require('../src/services/homeroom-bot-dm');
const live = require('../src/services/homeroom-bot-live');
const bot = require('../src/services/homeroom-bot');
const policy = require('../src/services/mobile-push-policy');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DASH = /—/;
const RETRY = 'Reply here (or on the GitHub issue) and it will try again.';

// The run's own records (homeroom-bot.js, homeroom-bot-live.js), and what the
// DM and the post on the request each say about it.
const CAUSES = [
  ['the build ran past its time limit (finished after a restart)',
    'I couldn\'t finish building this: it took longer than I\'m allowed.',
    'Homeroom bot couldn\'t finish building this: the build took longer than it\'s allowed.'],
  ['the build ran past its time limit; last activity: npm test',
    'I couldn\'t finish building this: it took longer than I\'m allowed.',
    'Homeroom bot couldn\'t finish building this: the build took longer than it\'s allowed.'],
  ['the platform restarted in the middle of each of its last 3 tries at building this',
    'I couldn\'t finish building this: Homeroom restarted while I was working on it, 3 times in a row.',
    'Homeroom bot couldn\'t finish building this: Homeroom restarted in the middle of the build, 3 times in a row.'],
  [bot.ABANDONED_LIVE_REASON,
    'I couldn\'t finish building this: Homeroom restarted while I was working on it.',
    'Homeroom bot couldn\'t finish building this: Homeroom restarted in the middle of the build.'],
  ['the build produced no change to propose (finished after a restart)',
    'I couldn\'t finish building this: I ended up with no changes to show you.',
    'Homeroom bot couldn\'t finish building this: it ended up with no changes to show.'],
  ['the change was built but could not be proposed: checks unavailable',
    'I built this, but I couldn\'t put it up for approval.',
    'Homeroom bot built this, but couldn\'t put it up for approval.'],
  ['the build could not start (worker pool exhausted)',
    'I couldn\'t get started on building this.',
    'Homeroom bot couldn\'t get started on building this.'],
  ['the build turn failed (exit 1)',
    'I couldn\'t finish building this: something went wrong while I was working on it.',
    'Homeroom bot couldn\'t finish building this: something went wrong during the build.'],
  ['',
    'I couldn\'t finish building this: something went wrong while I was working on it.',
    'Homeroom bot couldn\'t finish building this: something went wrong during the build.'],
  [null,
    'I couldn\'t finish building this: something went wrong while I was working on it.',
    'Homeroom bot couldn\'t finish building this: something went wrong during the build.'],
];

test('the post on the request says what the DM says, about the bot, and how anybody starts it again', () => {
  for (const [reason, toThem, onRequest] of CAUSES) {
    assert.equal(dm.buildFailedWords(reason), toThem, `DM: ${reason}`);
    assert.equal(dm.buildFailedWords(reason, 'this', 'bot'), onRequest, `post: ${reason}`);
    assert.equal(live.buildFailedText(reason), `${onRequest} ${RETRY}`, `post: ${reason}`);
  }
  // The 5 October request, word for word.
  assert.equal(
    live.buildFailedText('the build ran past its time limit (finished after a restart)'),
    'Homeroom bot couldn\'t finish building this: the build took longer than it\'s allowed. '
      + 'Reply here (or on the GitHub issue) and it will try again.',
  );
  // The DM's own words are unchanged by the second voice.
  assert.equal(dm.buildFailedWords('the build ran past its time limit', 'the first version'),
    'I couldn\'t finish building the first version: it took longer than I\'m allowed.');
  assert.equal(dm.buildFailedWords('x', 'this', 'someone else'), dm.buildFailedWords('x'), 'an unknown voice is the DM\'s');
});

test('the run\'s own record is never the sentence anybody reads', () => {
  for (const [reason] of CAUSES) {
    const text = live.buildFailedText(reason);
    assert.doesNotMatch(text, /\(finished|time limit|finished after|exit 1|worker pool|checks unavailable|last activity|npm test/, String(reason));
    assert.doesNotMatch(text, /pick it up|A person could|unknown reason/, String(reason));
    assert.doesNotMatch(text, DASH, String(reason));
  }
  // It stays where a maintainer looks: on the run (build_error, which the
  // admin's Homeroom bot screen shows) and in the log, beside the post.
  const src = read('src/services/homeroom-bot.js');
  const announce = src.slice(src.indexOf('async function announceBuilt('), src.indexOf('async function actOnVerdict('));
  assert.match(announce, /await recordLiveBuild\(pool, runId, built/);
  assert.match(announce, /log\.warn\('homeroom-bot', 'Live build did not become a proposal', \{[\s\S]*?error: built\.error/);
  assert.match(announce, /say\('build_failed', live\.buildFailedText\(built\.error, \{ firstVersion \}\), \{ dm: \{ reason: built\.error \} \}\)/);
  assert.match(read('frontend/src/features/admin/admin-homeroom-bot.tsx'), /Live build did not become a proposal: \$\{why\}\./);
});

test('"Reply here (or on the GitHub issue)" is true: a person\'s word on the request has the bot read it again', () => {
  const failedAt = '2026-10-05T10:00:00.000Z';
  const lastRun = { thread_seen_at: failedAt, verdict: 'ready', mode: 'live', live_building: false };
  const issue = { number: 3, state: 'open', createdAt: '2026-10-05T09:00:00.000Z', updatedAt: failedAt };
  // Nothing new since the failed build: it waits.
  assert.equal(bot.classifyIssue({ issue, lastRun }).reason, 'unchanged');
  // A reply in its Homeroom discussion (threadActivityByIssue counts people only).
  const here = bot.classifyIssue({ issue, threadLastAt: '2026-10-05T10:05:00.000Z', lastRun });
  assert.deepEqual([here.eligible, here.reason], [true, 'changed']);
  // A comment on the GitHub issue moves its updated time.
  const there = bot.classifyIssue({ issue: { ...issue, updatedAt: '2026-10-05T10:06:00.000Z' }, lastRun });
  assert.deepEqual([there.eligible, there.reason], [true, 'changed']);
  // And a person's message there reaches the bot at once: its request's
  // instance hears it in the statement that stores it (ws.js insertHeard),
  // and a connector's post is heard after it, as what they said.
  const ws = read('src/services/ws.js');
  assert.match(ws, /require\('\.\.\/workflow\/platform\.ts'\)\.insertHeard\(db, insertSql, insertParams, \{ appId: client\.appId, thread: thread \|\| null \}\)/);
  assert.match(ws, /if \(thread && thread\.type === 'issue' && !heard\) noteIssueActivityForBot\(client\.appId, thread\.ref, 'thread'\);/);
});

test('the push and the bell row for the DM say it stopped and how to start it again', async () => {
  const pool = { async query() { return { rows: [] }; } };
  const notifyCopy = require('../src/services/homeroom-bot-notify-copy');
  // "One story" (section 2.2): a stopped build's push names the request and
  // its project, and ends with what starts it again (the DM's Try again).
  const metadata = { kind: 'build_failed', appName: 'Page Turners', requestTitle: 'Display location and host information' };
  const detail = await dm.notificationDetail(pool, dm.momentOf(metadata), metadata);
  const parsed = notifyCopy.parseBotDetail(detail);
  assert.deepEqual([parsed.moment, parsed.said], ['stopped', 'build_other']);
  const copy = policy.buildNotificationCopy('build_stopped', {
    sourceUsername: 'homeroom_bot', sourceIsSynthetic: true, detail, messageContent: 'x',
  });
  assert.deepEqual(copy, {
    title: 'Display location and host information · Page Turners',
    body: 'Stopped: something went wrong while I was building. Tap Try again.',
  });
  // A sender that says which stop it was is worded by it.
  const timedOut = await dm.notificationDetail(pool, 'stopped', { ...metadata, said: 'build_time' });
  assert.equal(notifyCopy.botMomentCopy(timedOut).body, 'Stopped: it took longer than I\'m allowed. Tap Try again.');
  const said = dm.dmText('build_failed', { reason: 'the build ran past its time limit (finished after a restart)' },
    { appName: 'Page Turners', issueNumber: 3, issueTitle: 'Display location and host information', firstVersion: false });
  assert.match(said, /try again/i, 'the DM it opens says how to start it again too');
  assert.match(copy.body, /Try again\.$/);
});

test('no failure surface says "pick it up" any more', () => {
  for (const rel of ['src/services/homeroom-bot-live.js', 'src/services/mobile-push-policy.js',
    'frontend/src/features/notifications/notifications.js']) {
    const code = read(rel).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.doesNotMatch(code, /A person (?:can|could) pick it up/, rel);
  }
});

// 14 Oct 2026 (newcomer run eight, Club Votes, iPhone Safari): a first
// version was built and its proposal refused (a release was under way), so
// the build ended "built but could not be proposed". Its maker read "I built
// the first version, but I couldn't put it up for approval." under a Try
// again, and a push that said "couldn't put it up for a vote". A first
// version goes live without a vote (D1), so every stop of one says what is
// true without approval, a proposal or a vote; a later change keeps its words.
// 15 Oct 2026: one built and only not proposed is finished by Try again
// (homeroom-bot.js finishBuiltFirstVersion), so it says it finishes it, and
// its request says where Try again is: a reply there would start it over.
// Every other cause still starts over.
const FINISH = 'Whoever asked for it can tap Try again in their chat with Homeroom bot, and it will finish it.';
const FIRST_CAUSES = [
  ['the change was built but could not be proposed: Server is restarting',
    'I built Book Club but couldn\'t put it live yet. Tap Try again and I\'ll finish it.',
    'Homeroom bot built this but couldn\'t put it live yet.', FINISH],
  ['the build ran past its time limit (finished after a restart)',
    'I couldn\'t finish building Book Club: it took longer than I\'m allowed. Tap Try again and I\'ll start over.',
    'Homeroom bot couldn\'t finish building this: the build took longer than it\'s allowed.'],
  ['the platform restarted in the middle of each of its last 2 tries at building this',
    'I couldn\'t finish building Book Club: Homeroom restarted while I was working on it, 2 times in a row. Tap Try again and I\'ll start over.',
    'Homeroom bot couldn\'t finish building this: Homeroom restarted in the middle of the build, 2 times in a row.'],
  ['the build produced no change to propose',
    'I couldn\'t finish building Book Club: I ended up with no changes to show you. Tap Try again and I\'ll start over.',
    'Homeroom bot couldn\'t finish building this: it ended up with no changes to show.'],
  ['the build could not start (worker pool exhausted)',
    'I couldn\'t get started on building Book Club. Tap Try again and I\'ll start over.',
    'Homeroom bot couldn\'t get started on building this.'],
  ['the build turn failed (exit 1)',
    'I couldn\'t finish building Book Club: something went wrong while I was working on it. Tap Try again and I\'ll start over.',
    'Homeroom bot couldn\'t finish building this: something went wrong during the build.'],
];
// (Its project is not called Club Votes here: the name would match.)
const APPROVAL = /approv|propos|vote/i;

test('a first version that stopped is said without approval, a proposal or a vote, in every place', async () => {
  const words = require('../src/services/homeroom-bot-words');
  const notifyCopy = require('../src/services/homeroom-bot-notify-copy');
  const context = { appName: 'Book Club', issueNumber: 1, issueTitle: 'First version of Book Club', firstVersion: true };
  for (const [reason, toThem, onRequest, ending = RETRY] of FIRST_CAUSES) {
    // Its maker's chat, in the request's thread and in the main chat.
    assert.equal(dm.dmText('build_failed', { reason }, { ...context, threaded: true }), toThem, reason);
    assert.equal(dm.dmText('build_failed', { reason }, context), `**Book Club**, its first version\n\n${toThem}`, reason);
    // The request (and its GitHub comment), and its Homeroom copy.
    const posted = live.buildFailedText(reason, { firstVersion: true });
    assert.equal(posted, `${onRequest} ${ending}`, reason);
    for (const text of [toThem, posted, words.firstPerson(posted)]) {
      assert.doesNotMatch(text, APPROVAL, `${reason}: ${text}`);
      assert.doesNotMatch(text, DASH);
    }
  }
  assert.equal(words.firstPerson(live.buildFailedText(FIRST_CAUSES[0][0], { firstVersion: true })),
    'I built this but couldn\'t put it live yet. Whoever asked for it can tap Try again in their chat with me, and I\'ll finish it.');
  // Without a name, it is the first version.
  assert.equal(dm.dmText('build_failed', { reason: FIRST_CAUSES[0][0] }, { ...context, appName: '', threaded: true }),
    'I built the first version but couldn\'t put it live yet. Tap Try again and I\'ll finish it.');

  // The push and the bell row of that message.
  const pool = { async query() { return { rows: [] }; } };
  const metadata = { kind: 'build_failed', appName: 'Book Club', firstVersion: true, said: 'build_not_proposed' };
  const copy = notifyCopy.botMomentCopy(await dm.notificationDetail(pool, dm.momentOf(metadata), metadata));
  assert.deepEqual([copy.title, copy.body, copy.bellLabel, copy.bellSubject],
    ['Book Club', 'Stopped: I built your first version but couldn\'t put it live yet. Tap Try again and I\'ll finish it.', 'Stopped', 'Book Club first version']);
  assert.doesNotMatch(copy.body, APPROVAL);
  // Every stop's push for a first version.
  for (const said of notifyCopy.SAID_BY_MOMENT.stopped) {
    const body = notifyCopy.botMomentCopy(`hrbot2:${JSON.stringify({ m: 'stopped', s: said, a: 'Book Club', f: 1 })}`).body;
    if (said === 'checks' || said === 'needs_look' || said === 'update_failed') continue;
    assert.doesNotMatch(body, APPROVAL, `${said}: ${body}`);
  }

  // Its card in the chat: "Stopped · I built it but couldn't put it live yet".
  const { message } = require('./lib/platform-i18n');
  assert.equal(message('messages:bot.state.line.stop.unproposedFirst'), 'I built it but couldn’t put it live yet');
  const card = read('frontend/src/features/messages/bot-activity.tsx');
  assert.match(card, /if \(card\.outcome === 'build_failed' && card\.stopCause === 'unproposed' && firstVersion\) \{\s*return translate\('messages:bot\.state\.line\.stop\.unproposedFirst'\);/);
  assert.match(card, /cardStateLine\(card, at\.getTime\(\), meta\.appName \|\| meta\.appSlug \|\| '', \{ firstVersion: meta\.firstVersion === true \}\)/);

  // Said so from every place a first version's build ends: its build and
  // the build a restart could not start.
  const src = read('src/services/homeroom-bot.js');
  assert.match(src, /announceBuilt\(\{\s*pool, ws, app, bot, issueNumber, runId, built, say, domain: deps\.domain, firstVersion,\s*\}\)/);
  assert.match(src, /firstVersion: !!requester\?\.firstVersion,\s*built: \{ ok: false, error: `the build could not start/);
});

test('a later change that stopped keeps its words', async () => {
  const context = { appName: 'Book Club', issueNumber: 4, issueTitle: 'Dark mode', firstVersion: false, threaded: true };
  assert.equal(dm.dmText('build_failed', { reason: FIRST_CAUSES[0][0] }, context),
    'I built this, but I couldn\'t put it up for approval. Reply here and I\'ll try again.');
  assert.equal(live.buildFailedText(FIRST_CAUSES[0][0]), `Homeroom bot built this, but couldn't put it up for approval. ${RETRY}`);
  const notifyCopy = require('../src/services/homeroom-bot-notify-copy');
  assert.equal(notifyCopy.botMomentCopy(`hrbot2:${JSON.stringify({ m: 'stopped', s: 'build_not_proposed', a: 'Book Club', t: 'Dark mode' })}`).body,
    'Stopped: I built it but couldn\'t put it up for a vote. Tap Try again.');
  // An update that did not happen has nothing to put up, first version or not.
  assert.equal(dm.updateFailedWords(FIRST_CAUSES[0][0], 'the first version'),
    'I couldn\'t update the first version: something went wrong while I was working on it.');
});
