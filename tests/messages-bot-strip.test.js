'use strict';

// One request, one story: the chat with Homeroom bot, redrawn.
//
//   1. Where each request stands (frontend/src/features/messages/bot-strip.tsx),
//      read from the viewer's tracks, each its stored work state
//      (lib/work-state.ts): the groups (Needs you, Ready to try, In progress,
//      Finished today, each request once, by its stage), each row's words,
//      the counts the Messages list's bot row says, and how a request ended.
//      5 Nov 2026 (docs/plans/bot-one-model.md): the activity drawer that
//      drew those groups under the bot chat's header is gone, and with it
//      its Activity bar, its remembered open state and its Try it and
//      Approve. 14 Nov 2026: so are the one-line news rows the chat's own
//      stream drew each request as (bot-news-line.tsx, with their fold into
//      "N finished", their badges and their tiles): every conversation with
//      the bot is a thread, and no screen draws that stream.
//   2. A request's number in its own colour (bot-request.ts), the same in
//      its thread's header and the bot's words.
//
// Run with: node --test tests/messages-bot-strip.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { withWords } = require('./lib/work-words');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const STRIP = 'frontend/src/features/messages/bot-strip.tsx';

globalThis.window = {
  App: { user: { id: 7, username: 'ada' } },
  location: { search: '', hash: '#messages/42' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout,
};

const NOW = new Date('2026-10-09T12:00:00Z');
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60000).toISOString();
const nowhere = { request: null, proposal: null, project: null };
// A work state as the server stores it (services/work-state.js), with the
// words it sends with it (11 Nov 2026: tests/lib/work-words.js).
const at = (stage, extra = {}) => withWords({ stage, why: null, reason: null, line: null, whoseMove: null, since: null, ...extra });
// One of the viewer's requests, as GET /api/ai/tracks sends it (api.ts normalizeBotTrack).
let seq = 0;
const track = (work, extra = {}) => {
  seq += 1;
  const issueNumber = extra.issueNumber || seq;
  return {
    key: `plant-pal#${issueNumber}`, appSlug: 'plant-pal', appName: 'Plant Pal', iconUrl: null, iconEmoji: null,
    issueNumber, title: `Request ${issueNumber}`, firstVersion: false, work, step: null, waitingOn: null,
    busy: false, try: 1, tryStartedAt: null, tryStarts: [], since: ago(30), rootId: null, askId: null, proposalId: null,
    sessionId: null, links: nowhere, ...extra,
  };
};
const work = (...tracks) => ({ tracks });

function strip() { return loadTsx(STRIP); }

// ── 1. Where each request stands ─────────────────────────────────────────

test('the groups, in order, each request once, by its stage', () => {
  const { stripGroups } = strip();
  const asked = track(at('waiting_for_you', { why: 'question' }), { title: 'Dinner rota' });
  const stuck = track(at('stopped', { reason: 'build_failed' }), { title: 'Print view', cause: 'time' });
  const ready = track(at('up_for_vote'), { title: 'Grey out', step: 'vote' });
  const building = track(at('building'), { title: 'Totals', step: 'build' });
  const held = track(at('building', { line: { code: 'held_waiting' } }), { title: 'Held', held: { limit: 'slots', position: 2, until: null } });
  const live = track(at('live'), { title: 'Went live', step: 'live', since: ago(50) });
  const oldLive = track(at('live'), { title: 'Long ago', step: 'live', since: ago(60 * 30) });
  const model = stripGroups(work(asked, stuck, ready, building, held, live, oldLive, { ...asked, work: at('building') }), NOW);
  const titles = (rows) => rows.map((row) => row.track.title);
  assert.deepEqual(titles(model.needs), ['Dinner rota', 'Print view'], 'what waits for them, and a stop they can start again');
  assert.deepEqual(titles(model.ready), ['Grey out'], 'a change up for a vote');
  assert.deepEqual(titles(model.progress), ['Totals', 'Held'], 'work under way, a hold among it');
  assert.deepEqual(titles(model.done), ['Went live'], 'done is today only');
  assert.deepEqual(model.needs.map((row) => row.state), ['Waiting for your answer', 'It ran out of time']);
  assert.deepEqual(model.ready.map((row) => row.state), ['Up for a vote']);
  assert.deepEqual(model.progress.map((row) => row.state), ['Building', 'Ready to build · Waiting for a slot, 1 request ahead of it']);
  assert.deepEqual(model.done.map((row) => row.state), ['Live']);
  // Each row carries its track: its badge and the chat's news rows read it.
  assert.equal(model.needs[0].track, asked, 'the first of a request\'s tracks is the one drawn');
  assert.equal(model.needs[0].key, asked.key);
  assert.deepEqual(stripGroups(null), { needs: [], ready: [], progress: [], done: [] });
  assert.deepEqual(stripGroups(work()), { needs: [], ready: [], progress: [], done: [] });
});

// #4974: a reply on the request's discussion settles a need. Its work state
// moves on (Homeroom bot reads the reply), so it leaves Needs you, and it is
// not done either: nothing was built from the reply yet.
test('a need settled by a reply leaves Needs you: Homeroom bot reads it, under In progress', () => {
  const { stripGroups } = strip();
  const settled = track(at('reading', { line: { code: 'reply' } }), { title: 'Dinner rota' });
  const waiting = track(at('waiting_for_you', { why: 'needs_detail' }), { title: 'Print view' });
  const model = stripGroups(work(waiting, settled), NOW);
  assert.deepEqual(model.needs.map((row) => row.track.title), ['Print view'], 'the answered one is not asked for any more');
  assert.deepEqual(model.progress.map((row) => [row.track.title, row.state]), [['Dinner rota', 'Reading your reply']]);
  assert.deepEqual(model.done, [], 'and it is not done: nothing was built from the reply yet');
});

test('each row says one short thing, in the stage\'s own words: no step numbers, no timings', () => {
  const { stripGroups } = strip();
  const said = (state, extra) => {
    const model = stripGroups(work(track(state, extra)), NOW);
    const [row] = [...model.needs, ...model.ready, ...model.progress, ...model.done];
    return [row.group, row.state];
  };
  // Waiting for you, by why it waits.
  assert.deepEqual(said(at('waiting_for_you', { why: 'question' })), ['needs', 'Waiting for your answer']);
  assert.deepEqual(said(at('waiting_for_you', { why: 'plan' })), ['needs', 'Waiting for you to OK the plan']);
  assert.deepEqual(said(at('waiting_for_you', { why: 'decide' })), ['needs', 'Waiting for you to decide']);
  assert.deepEqual(said(at('waiting_for_you', { why: 'already_works' })), ['needs', 'It may already work: close it?']);
  assert.deepEqual(said(at('waiting_for_you', { why: 'needs_detail' })), ['needs', 'Waiting for more detail from you']);
  assert.deepEqual(said(at('waiting_for_you', { why: 'decide', line: { code: 'reason', text: 'It needs a design call.' } })),
    ['needs', 'Homeroom bot: It needs a design call.'], 'Homeroom bot\'s own reason, where it gave one');
  // Stopped, by what stopped it, and a build by why it did not finish.
  assert.deepEqual(said(at('stopped', { reason: 'build_failed' }), { cause: 'time' }), ['needs', 'It ran out of time']);
  assert.deepEqual(said(at('stopped', { reason: 'build_failed' })), ['needs', 'Stopped: the build didn\'t finish']);
  assert.deepEqual(said(at('stopped', { reason: 'fix_stopped' })), ['needs', 'Stopped: its tests still fail']);
  assert.deepEqual(said(at('stopped', { reason: 'look_failed' })), ['needs', 'Stopped: it couldn\'t be read']);
  assert.deepEqual(said(at('stopped', { reason: 'change_closed' })), ['needs', 'Stopped: its change was closed']);
  assert.deepEqual(said(at('stopped', { reason: 'stalled' })), ['needs', 'Stopped: the build didn\'t start']);
  // Up for a vote says the stage alone.
  assert.deepEqual(said(at('up_for_vote')), ['ready', 'Up for a vote']);
  assert.deepEqual(said(at('up_for_vote', { line: { code: 'update_queued' } })), ['ready', 'Up for a vote']);
  // Under way: the second line, else the stage.
  assert.deepEqual(said(at('reading', { line: { code: 'queued', place: 4 } })), ['progress', 'Number 4 in line']);
  assert.deepEqual(said(at('reading', { line: { code: 'waiting' } })), ['progress', 'Waiting to be read']);
  assert.deepEqual(said(at('reading')), ['progress', 'Reading it']);
  assert.deepEqual(said(at('reading', { line: { code: 'on_hold' } })), ['progress', 'On hold until Monday: this week\'s building time is used up']);
  assert.deepEqual(said(at('planning')), ['progress', 'Planning']);
  assert.deepEqual(said(at('planning', { line: { code: 'retry_plan' } })), ['progress', 'Trying the plan again']);
  assert.deepEqual(said(at('building', { line: { code: 'reviewing', round: 2, of: 3 } })), ['progress', 'Reviewing, round 2 of 3']);
  assert.deepEqual(said(at('building', { line: { code: 'claimed', by: 'maya' } })), ['progress', 'maya is building it']);
  assert.deepEqual(said(at('checking')), ['progress', 'Checking']);
  assert.deepEqual(said(at('checking', { line: { code: 'checks_failing', failing: 2 } })), ['progress', '2 tests failing']);
  assert.deepEqual(said(at('going_live')), ['progress', 'Going live'], 'going live has not ended');
  assert.deepEqual(said(at('going_live', { line: { code: 'first_version' } })), ['progress', 'First version: it goes live without a vote']);
  // Done today, by how it ended.
  assert.deepEqual(said(at('live'), { since: ago(5) }), ['done', 'Live']);
  assert.deepEqual(said(at('closed'), { since: ago(5) }), ['done', 'Closed']);
  // No clock on a row, however long the try has run: its thread says that.
  const [, busy] = said(at('building'), { busy: true, step: 'build', try: 2, tryStartedAt: ago(15) });
  assert.equal(busy, 'Building');
  assert.doesNotMatch(busy, /so far|\d+m\b|step \d|Try \d/);
});

// The drawer's Needs you rows, each with ONE action, and its Ready rows' Try
// it and Approve went with the drawer (5 Nov 2026): a request's acts are on
// its own card and page, and on the Homeroom bot tab.

test('the Messages list\'s bot row counts every request in its group, zero parts left out', () => {
  const { summaryParts, stripGroups } = strip();
  const tracks = [
    ...Array.from({ length: 5 }, () => track(at('waiting_for_you', { why: 'question' }))),
    ...Array.from({ length: 4 }, () => track(at('up_for_vote'), { step: 'vote' })),
    track(at('building'), { step: 'build' }), track(at('planning'), { step: 'plan' }),
    track(at('checking'), { step: 'checks' }), track(at('going_live'), { step: 'live' }),
    track(at('live'), { step: 'live', since: ago(30) }), track(at('closed'), { since: ago(90) }),
  ];
  const model = stripGroups(work(...tracks), NOW);
  assert.deepEqual(summaryParts(model).map((part) => part.text), ['5 need you', '4 ready to try', '4 in progress', '2 finished today'],
    'every request counted, none capped');
  assert.deepEqual(summaryParts(model).map((part) => part.group), ['needs', 'ready', 'progress', 'done']);
  const one = stripGroups(work(track(at('waiting_for_you', { why: 'plan' })), track(at('up_for_vote'))), NOW);
  assert.deepEqual(summaryParts(one).map((part) => part.text), ['1 needs you', '1 ready to try']);
  assert.deepEqual(summaryParts(stripGroups(work(), NOW)), [], 'nothing to say: nothing at all');
  // The row says the first two parts, from the tracks once they are read; its last message until then.
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /if \(!botWork\.work\) return null;\s*const parts = summaryParts\(stripGroups\(botWork\.work\)\);\s*return parts\.length \? parts\.slice\(0, 2\)\.map\(\(part\) => part\.text\)\.join\(' · '\) : null;/);
  assert.match(screen, /useWorkChanged\(!!botConversation\);/, 'read again when a request\'s stage moves, with no timer');
  assert.doesNotMatch(screen, /POLL_MS/);
});

// #5373: the per-project "The bot's slots on …" links that hung under the
// drawer's Finished today are gone, and so is the drawer (5 Nov 2026); the
// slots page still opens from a held request's own card (./bot-track.tsx).
test('the strip has no slots links of its own: a hold is In progress, and its card opens the slots', () => {
  const { stripGroups } = strip();
  const model = stripGroups(work(
    track(at('building'), { issueNumber: 12, step: 'build' }),
    track(at('up_for_vote'), { issueNumber: 13, step: 'vote' }),
    track(at('building', { line: { code: 'held_waiting' } }), { issueNumber: 14, held: { limit: 'slots', position: 2, until: null } }),
    track(at('building', { line: { code: 'held_builds' } }), { issueNumber: 15, held: { limit: 'builds', position: 1, until: null } }),
  ), NOW);
  // #5392: a hold is in progress; there is no On hold group.
  assert.deepEqual(model.progress.map((row) => row.track.issueNumber), [12, 14, 15], 'the building one and the held ones');
  assert.deepEqual(Object.keys(model), ['needs', 'ready', 'progress', 'done']);
  assert.equal(model.progress[1].state, 'Ready to build · Waiting for a slot, 1 request ahead of it', 'a hold says it is ready to build, and what it waits for');
  assert.equal(model.progress[2].state, 'Ready to build · Next in line to be built');
  const source = read(STRIP);
  assert.doesNotMatch(source, /data-bot-strip-slots|bot\.strip\.slots|openSlots\(/);
  assert.equal(JSON.parse(read('frontend/locales/en/messages.json'))['bot.strip.slots'], undefined, 'the link\'s words are gone from the catalog');
  // The held request's card keeps its own slots button.
  assert.match(read('frontend/src/features/messages/bot-track.tsx'), /data-bot-track-slots/);
});

test('the bot chat has no drawer and no news rows of its own: its threads read its requests\' tracks', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /\{embedded \? null : <ThreadHeader \/>\}/);
  assert.doesNotMatch(screen, /<BotStrip\b|BotWorkPanel|BotWorkButton|BotWorkStatusLine/);
  const sync = screen.slice(screen.indexOf('function BotThreadsSync('), screen.indexOf('export function MessagesScreen('));
  assert.match(sync, /<BotWorkSync conversationId=\{conversationId\} newsKey=\{newsKey\} \/>/,
    'the chat still reads its requests\' tracks, for the thread on show');
  // 14 Nov 2026: the one-line news rows of the chat's own stream are gone
  // with the stream, and the tiles and small squares they were drawn with.
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/messages/bot-news-line.tsx')));
  assert.doesNotMatch(screen, /BotNewsLine|SettledRun|foldBotNews|newsStatusOf|asksInChat/);
  const source = read(STRIP);
  assert.doesNotMatch(source, /export function (ProjectTile|OpenState|FinalState|SettledLine|trayNow|trayEnded)\b|data-bot-badge|data-bot-settled/);
  const catalog = JSON.parse(read('frontend/locales/en/messages.json'));
  assert.deepEqual(Object.keys(catalog).filter((key) => key.startsWith('bot.news.')), [], 'their words went with them');
  assert.doesNotMatch(source, /export function BotStrip|data-bot-strip=|homeroom:botDrawer|localStorage|useDismiss/,
    'no drawer, no Activity bar, no remembered open state');
  for (const gone of ['bot.strip.name', 'bot.strip.activity', 'bot.strip.group.needs', 'bot.strip.action.approve', 'bot.strip.approveStale']) {
    assert.equal(JSON.parse(read('frontend/locales/en/messages.json'))[gone], undefined, `${gone} went with the drawer`);
  }
});


// ── How a request ended, and its project's icon ──────────────────────────

test('how a track ended, and how that is said in words', () => {
  const { trackEnding, endedWords } = strip();
  const ending = (state, extra = {}) => trackEnding({ work: state, ...extra });
  assert.deepEqual(
    ['live', 'going_live', 'closed'].map((stage) => ending(at(stage))),
    ['live', 'going_live', 'closed'],
  );
  assert.equal(ending(at('closed'), { doneBy: { username: 'ben', prNumber: null } }), 'done_elsewhere');
  assert.equal(ending(at('stopped', { reason: 'build_failed' })), 'build_failed', 'a build that went wrong');
  assert.equal(ending(at('stopped', { reason: 'look_failed' })), 'failed');
  for (const reason of ['fix_stopped', 'change_closed', 'stalled']) assert.equal(ending(at('stopped', { reason })), 'stopped', reason);
  for (const stage of ['reading', 'planning', 'waiting_for_you', 'building', 'checking', 'up_for_vote']) {
    assert.equal(ending(at(stage)), null, `${stage} has not ended`);
  }
  // In words: the ending's own word, and a build that went wrong says why with it.
  const failed = track(at('stopped', { reason: 'build_failed' }), { cause: 'time' });
  assert.equal(endedWords('build_failed', failed, 'Stopped'), 'Couldn’t build · It ran out of time', 'the dot joins two whole sentences');
  assert.equal(endedWords('build_failed', null, 'Stopped'), 'Couldn’t build', 'no track: the ending\'s word alone');
  assert.equal(endedWords('live', failed, 'Stopped'), 'Live');
  assert.equal(endedWords('done_elsewhere', null, 'x'), message('messages:bot.final.doneElsewhere'));
  assert.equal(endedWords(null, failed, 'What it last said'), 'What it last said', 'no record of how it ended: the words it last said');
});

test('a project\'s card wears the icon its requests\' tracks have', () => {
  const { newsIcon } = loadTsx('frontend/src/features/messages/bot-shared.ts');
  const icon = (appSlug, iconUrl, iconEmoji, appName = 'Project') => track(at('building'), { appSlug, appName, iconUrl, iconEmoji });
  const tracks = work(icon('plants', null, null), icon(null, null, '🧪', 'Staging demo app'), icon('plants', null, '🌱'), icon('rota', '/app-icons/7', null));
  assert.deepEqual(newsIcon(tracks, 'plants'), { iconUrl: null, iconEmoji: '🌱' }, 'the first track with artwork, wherever it is');
  assert.deepEqual(newsIcon(tracks, 'rota'), { iconUrl: '/app-icons/7', iconEmoji: null });
  assert.deepEqual(newsIcon(tracks, 'elsewhere'), { iconUrl: null, iconEmoji: null });
  assert.deepEqual(newsIcon(null, 'plants'), { iconUrl: null, iconEmoji: null }, 'before the tracks are read: none');
  assert.deepEqual(newsIcon(tracks, null, 'Staging demo app'), { iconUrl: null, iconEmoji: '🧪' }, 'a project with no slug, by its name');
  assert.deepEqual(newsIcon(tracks, null, 'Project'), { iconUrl: null, iconEmoji: null }, 'a name never matches a project that has a slug');
  assert.match(read('frontend/src/features/messages/bot-head-card.tsx'), /const tray = head\.kind === 'project' \? newsIcon\(work, head\.appSlug, head\.appName\) : null;/);
  assert.match(read('frontend/src/features/messages/bot-shared.ts'), /for \(const job of work\.tracks\) \{/, 'read from the tracks alone');
});

// ── #5392: one reading of the bot's work, grouped once ───────────────────

test('"today" is the local day: what ended since midnight, not the last 24 hours', () => {
  const { startOfDay, stripGroups } = strip();
  // NOW is midday; the day began at midnight on this device.
  const midnight = startOfDay(NOW).getTime();
  const yesterday = new Date(midnight - 10 * 60000).toISOString(); // 23:50 the day before
  const early = new Date(midnight + 5 * 60000).toISOString(); // 00:05 today
  const model = stripGroups(work(
    track(at('live'), { issueNumber: 1, step: 'live', since: yesterday }),
    track(at('live'), { issueNumber: 2, step: 'live', since: early }),
    track(at('closed'), { issueNumber: 3, since: early }),
    track(at('closed'), { issueNumber: 4, since: early, doneBy: { username: 'ben', prNumber: 4822 } }),
    track(at('live'), { issueNumber: 5, step: 'live', since: 'not a moment' }),
    track(at('stopped', { reason: 'build_failed' }), { issueNumber: 6, since: early }),
  ), NOW);
  assert.deepEqual(model.done.map((row) => row.track.issueNumber), [2, 3, 4], '23:50 yesterday is not finished today; 00:05 today is; no parsable since stays out');
  // Each says how it ended, in the ending's own word.
  assert.deepEqual(model.done.map((row) => row.state), ['Live', 'Closed', 'Done another way']);
  assert.deepEqual(model.needs.map((row) => row.track.issueNumber), [6], 'a stop waits for them to start it again, under Needs you');
});

test('a change up for a vote is Ready to try, whoever\'s yes it waits for', () => {
  const { stripGroups, summaryParts } = strip();
  const model = stripGroups(work(
    track(at('up_for_vote', { whoseMove: 'group' }), { issueNumber: 30, step: 'vote', waitingOn: 'group' }),
    track(at('up_for_vote'), { issueNumber: 31, step: 'vote' }),
  ), NOW);
  assert.deepEqual(model.ready.map((row) => row.track.issueNumber), [30, 31]);
  assert.deepEqual(model.ready.map((row) => row.state), ['Up for a vote', 'Up for a vote']);
  assert.deepEqual(model.needs, [], 'a vote is the group\'s to give, never a need of the requester\'s');
  assert.deepEqual(summaryParts(model).map((part) => part.text), ['2 ready to try']);
  // The drawer's Try it and Approve went with it (5 Nov 2026): the change's
  // ready card in the chat keeps both (./bot-ready.tsx).
  assert.doesNotMatch(read(STRIP), /tryChange|approveChange|noteApprovedHere/);
});

test('a hold and a change going live are In progress, never finished; the counts, in order', () => {
  const { stripGroups, summaryParts } = strip();
  const model = stripGroups(work(
    track(at('building', { line: { code: 'held_waiting' } }), { issueNumber: 40, held: { limit: 'slots', position: 1, until: null } }),
    track(at('reading', { line: { code: 'on_hold' } }), { issueNumber: 41, held: { limit: 'allowance', position: null, until: '2026-10-19T09:00:00Z' } }),
    track(at('going_live'), { issueNumber: 42, step: 'live', since: ago(5) }),
    track(at('waiting_for_you', { why: 'plan' }), { issueNumber: 43, step: 'plan', askId: 44 }),
  ), NOW);
  assert.deepEqual(model.progress.map((row) => row.track.issueNumber), [40, 41, 42], 'none of it has ended');
  assert.equal(model.progress[0].state, 'Ready to build · Next in line for a slot', 'the stage\'s word leads, then what it waits for');
  assert.match(model.progress[1].state, /^On hold until .+: this week's building time is used up$/, 'the allowance line says on hold, and until when');
  assert.equal(model.progress[2].state, 'Going live');
  assert.deepEqual(model.done, [], 'going live has not ended');
  const parts = summaryParts(model).map((part) => part.text);
  assert.deepEqual(parts, ['1 needs you', '3 in progress'], 'the groups in order, zero ones left out');
  assert.equal(parts.slice(0, 2).join(' · '), '1 needs you · 3 in progress', 'the row shows the first two parts');
});

// ── 2. A request's number, in its own colour ─────────────────────────────

test('a request\'s number wears one of eight hues, neighbours apart, never the need amber or the action blue', () => {
  const { requestHue, requestKey } = loadTsx('frontend/src/features/messages/bot-request.ts');
  const hues = Array.from({ length: 8 }, (_, i) => requestHue(10 + i));
  assert.equal(new Set(hues).size, 8, 'any eight in a row all differ');
  assert.equal(requestHue(9), requestHue(17), 'eight apart share one');
  for (const hue of hues) {
    assert.ok(!(hue >= 25 && hue <= 60), `${hue} is not amber`);
    assert.ok(!(hue >= 195 && hue <= 240), `${hue} is not the action blue`);
  }
  assert.equal(requestKey({ appName: 'Plant Pal', issueNumber: 4 }), 'plant pal|4');
  assert.equal(requestKey({ appSlug: 'plant-pal', issueNumber: 4 }), 'plant-pal|4', 'the slug only when there is no name');
  assert.equal(requestKey({ appName: 'Plant Pal', firstVersion: true, issueNumber: 1 }), 'plant pal|first');
  assert.equal(requestKey({ appName: 'Plant Pal' }), null, 'no number: no request');
  assert.equal(requestKey({ issueNumber: 4 }), null, 'no project: no request');
});

test('the thread\'s header and the bot\'s own words wear the number\'s colour too', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /\{request && !request\.firstVersion \? <RequestTag number=\{request\.number\} size="head" \/> : null\}/);
  const format = read('frontend/src/features/messages/format.tsx');
  assert.match(format, /if \(requestColors\) \{\s*for \(const chip of root\.querySelectorAll<HTMLElement>\('\.gc-ref-issue\[data-ref-number\]'\)\) \{[\s\S]*?chip\.classList\.add\('gc-ref-request'\);\s*chip\.style\.setProperty\('--req-h', String\(requestHue\(n\)\)\);/);
  const css = read('public/css/app.css');
  assert.match(css, /html \.messages-markdown \.gc-ref-issue\.gc-ref-request \{ color: hsl\(var\(--req-h\) 70% 26%\); background: hsl\(var\(--req-h\) 80% 92%\);/);
  assert.match(css, /html\.dark \.messages-markdown \.gc-ref-issue\.gc-ref-request \{ color: hsl\(var\(--req-h\) 80% 82%\); background: hsl\(var\(--req-h\) 35% 25%\); \}/);
  // The tag's own ink is the same four values, so the two never drift apart.
  assert.match(read(STRIP), /bg-\[hsl\(var\(--req-h\)_80%_92%\)\] text-\[hsl\(var\(--req-h\)_70%_26%\)\] dark:bg-\[hsl\(var\(--req-h\)_35%_25%\)\] dark:text-\[hsl\(var\(--req-h\)_80%_82%\)\]/);
});

// Polish board #22 (19 Oct 2026) pinned the Activity drawer's dismiss rules
// (a press outside, Escape, focus back to its bar); the drawer is gone.
