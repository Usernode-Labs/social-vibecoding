'use strict';

// Threads, stage 5 of #6019: a private thread in the chat with Homeroom
// bot, without a database (the doors themselves run against PostgreSQL in
// private-threads-postgres.test.js).
//
// What this pins:
//   1. Its first render is nothing, and it reads where the thread stands.
//   2. The projects to pick from are the viewer's communities, in order.
//   3. It is drawn on every private thread in the bot's chat, by the
//      server's word (`mine`; 1 Nov 2026: a "+" thread, a draft the bot
//      opened and a design thread hang off the bot's line): the note at
//      its head, the doors at its foot.
//   4. 31 Oct 2026: the doors come once the bot has answered, and only the
//      ones that apply to what the thread is. 1 Nov 2026: File it and Post
//      it are the bot's to offer, under its reply, never at the foot.
//   5. The routes the old doors wrote to stay same-origin writes.
//
// Run with: node --test tests/private-thread-bar.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');
const { withWords } = require('./lib/work-words');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BAR = 'frontend/src/features/messages/private-thread-bar.tsx';

test('its first render is nothing; where the thread stands is read in an effect', () => {
  assert.equal(renderComponent(BAR, 'PrivateThreadNote', { where: null }), '');
  const doors = { rootId: 5, text: 'An idea', where: null, botReplied: true };
  assert.equal(renderComponent(BAR, 'PrivateThreadDoors', doors), '');
  assert.match(read(BAR), /fetch\(`\/api\/conversations\/homeroom-bot\/threads\/\$\{rootId\}`/);
});

test('the projects to pick from are the viewer\'s communities, in the switcher\'s order', () => {
  const { projectChoices } = loadTsx(BAR);
  assert.deepEqual(JSON.parse(JSON.stringify(projectChoices({
    list: ['seed-swap', 'notes'], info: { 'seed-swap': { name: 'Seed swap' } },
  }))), [{ slug: 'seed-swap', name: 'Seed swap' }, { slug: 'notes', name: 'notes' }]);
  assert.deepEqual(projectChoices({ list: null, info: {} }), []);
});

test('the doors wait for the bot\'s answer, and File it is never one of them', () => {
  const { doorsFor } = loadTsx(BAR);
  const notes = { slug: 'notes', name: 'Notes' };
  const open = (kind, app = null) => ({ state: 'open', kind, app });
  const doors = (where, replied = true, invited = false) => JSON.parse(JSON.stringify(doorsFor(where, replied, invited)));
  assert.deepEqual(doors(open('idea'), false), [], 'nothing to take public before the bot answers');
  // 1 Nov 2026 (Evan): File it and Post it are under the bot's offer, once
  // something is ready, not at the foot of every thread.
  assert.deepEqual(doors(open('draft_request', notes)), [], 'a drafted request is filed from its card');
  assert.deepEqual(doors(open('draft_reply', notes)), [], 'a drafted reply is posted from its card');
  assert.deepEqual(doors(open('ask', notes)), [], 'a "+" thread for a project waits for the bot\'s offer');
  assert.deepEqual(doors(open('idea', notes)), []);
  assert.deepEqual(doors(open('design', notes)), []);
  assert.deepEqual(doors(open('design')), [], 'a design\'s bot offers the project itself');
  // #6523 (9 Nov 2026): New project is the bot's to offer. Without its
  // offer, no thread in no project shows it, whatever it is about.
  assert.deepEqual(doors(open('ask')), [], 'a "+" thread in no project without an offer');
  assert.deepEqual(doors(open('idea')), [], 'an idea without an offer');
  assert.deepEqual(doors({ state: 'open' }), [], 'an older server sends no kind: an idea, no offer');
  assert.deepEqual(doors({ state: 'open' }, true, true), ['new'], 'an older server, offered');
  // With its offer, only a thread in no project shows it.
  assert.deepEqual(doors(open('ask'), true, true), ['new']);
  assert.deepEqual(doors(open('idea'), true, true), ['new']);
  assert.deepEqual(doors(open('ask', notes), true, true), [], 'never a thread for a project that exists');
  assert.deepEqual(doors(open('design'), true, true), [], 'a design\'s bot offers the project itself');
  assert.deepEqual(doors({ ...open('idea'), mine: false }, true, true), [], 'never on a thread that is not theirs');
  assert.deepEqual(doors({ state: 'filed', number: 4 }, true, true), [], 'none once it went somewhere');
  assert.deepEqual(doors(null), []);
  // B04 (audit 2 Nov 2026): a screen drawn for no project yet is made into one from its drawing.
  const drawn = { title: 'Weekly chore chart', version: 2 };
  assert.deepEqual(doors({ ...open('ask'), design: drawn }), ['new']);
  assert.deepEqual(doors({ ...open('design'), design: drawn }), ['new'], 'a design for no project yet too');
  assert.deepEqual(doors({ ...open('design', notes), design: drawn }), [], 'never one of a project that exists');
  assert.deepEqual(doors({ ...open('ask'), design: drawn }, false), []);
});

test('#6523: New project is invited by the bot\'s newest reply, or by the thread it opened for a new project', () => {
  const { newProjectInvited } = loadTsx(BAR);
  const bot = (meta) => ({ content: 'A reply', sender: { id: 2, bot: true }, metadata: { homeroomBot: meta } });
  const person = { content: 'Yes please', sender: { id: 7 } };
  const root = { content: 'New thread, for a new project.', sender: { id: 2, bot: true }, metadata: { homeroomBot: { kind: 'opened_thread', changeKind: 'project' } } };
  const other = { content: 'A question', sender: { id: 2, bot: true }, metadata: { homeroomBot: { kind: 'opened_thread', changeKind: 'any' } } };
  // Its newest reply is the one that counts.
  assert.equal(newProjectInvited(null, [person, bot({ newProject: true })]), true);
  assert.equal(newProjectInvited(null, [bot({ newProject: true }), person]), true, 'their answer after it does not take it away');
  assert.equal(newProjectInvited(null, [bot({ newProject: true }), bot({})]), false, 'an earlier offer alone does not count');
  assert.equal(newProjectInvited(null, [person]), false, 'no bot reply, no offer');
  assert.equal(newProjectInvited(null, []), false);
  // The bot opened the thread for a new project.
  assert.equal(newProjectInvited(root, []), true);
  assert.equal(newProjectInvited(root, [{ ...bot({}), metadata: {} }]), true);
  assert.equal(newProjectInvited(other, []), false, 'a thread it opened for anything else');
  assert.equal(newProjectInvited({ content: 'Their own words', sender: { id: 7 } }, [bot({ newProject: true })]), true,
    'a thread of theirs, with its offer');
});

test('B04: New project on a drawn screen makes it with its name and drawing, never the generic create screen', () => {
  const src = read(BAR);
  assert.match(src, /import \{ MakeSheet \} from '\.\/bot-make';/);
  assert.match(src, /const drawn = where\.design && !where\.app \? where\.design : null;/);
  assert.match(src, /\{door === 'new' && drawn \? \(\s*<MakeSheet\s+project=\{\{ name: \(drawn\.title \|\| ''\)\.slice\(0, 60\), rootId, version: drawn\.version \}\}/);
  assert.match(src, /\{door === 'new' && !drawn \? \(/, 'the who-for choices only for an idea with nothing drawn');
  const server = read('src/services/private-threads.js');
  assert.match(server, /\{ design: \{ title: row\.design_title \|\| null, version: Number\(row\.design_version\) \} \}/);
});

test('it is drawn on every private thread in the bot\'s chat, by the server\'s word: the note on top, the doors under it', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  const gate = screen.slice(screen.indexOf('const privateRoot = '), screen.indexOf('const [privateWhere, setPrivateWhere] = usePrivateThread(privateRoot);'));
  assert.match(gate, /snap\.active\?\.kind === 'direct' && threadsAllowed\(snap\.active\) && snap\.active\.homeroomBot/, 'the bot\'s chat');
  assert.match(gate, /privateRootMessage && !requestPageOf\(privateRootMessage\)/, 'any root but a request\'s story, the bot\'s line too');
  assert.doesNotMatch(gate, /!privateRootMessage\.sender\.bot/, '1 Nov 2026: not only the viewer\'s own message');
  assert.match(screen, /const privateMine = !!privateRoot && isOwnPrivateThread\(privateWhere, privateRootMessage, meId\);/);
  // #6159: the note carries the thread, for Reopen on a done one.
  const note = screen.indexOf('<PrivateThreadNote where={privateWhere} rootId={privateRoot}');
  const doors = screen.indexOf('<PrivateThreadDoors');
  assert.ok(note > 0 && doors > note, 'the note heads the thread, the doors close it');
  assert.match(screen.slice(doors - 80, doors), /\{privateRoot && privateMine && root \? \(\s*$/);
  assert.match(screen.slice(doors, doors + 400), /text=\{privateThreadWords\(root, replies, meId\)\}/);
  assert.match(screen.slice(doors, doors + 400), /botReplied=\{replies\.some\(\(message\) => message\.sender\.bot\)\}/);
  // #6523: the foot follows what Homeroom bot last said, not the thread's kind.
  assert.match(screen.slice(doors, doors + 400), /invited=\{newProjectInvited\(root, replies\)\}/);
  assert.match(screen, /PrivateThreadDoors, PrivateThreadNote, isOwnPrivateThread, newProjectInvited,/);
  assert.match(screen.slice(doors, doors + 400), /working=\{!!threadWorking\}/, 'the thread\'s working state holds the foot back');
  assert.doesNotMatch(screen, /<PrivateThreadBar\b/, 'no bar of doors over the thread any more');
});

test('whose thread it is, its name and the words to take public, for a root of theirs or the bot\'s line', () => {
  const { isOwnPrivateThread, privateThreadTitle, privateThreadWords } = loadTsx(BAR);
  const ME = 7;
  const mine = { content: 'An idea: swap seeds\nby post', sender: { id: ME } };
  const plus = { content: 'New thread, to add something new on Seed swap.', sender: { id: 2, bot: true }, metadata: { homeroomBot: { kind: 'opened_thread' } } };
  const design = { content: 'I opened a design thread for Home', sender: { id: 2, bot: true }, metadata: { homeroomBot: { kind: 'opened_design', designTitle: 'Home screen' } } };
  const draft = { content: 'I drafted it as a request on Seed swap, in a thread only you can see.', sender: { id: 2, bot: true }, metadata: { homeroomBot: { kind: 'opened_draft' } } };
  const replies = [
    { content: 'Hello', sender: { id: 2, bot: true } },
    { content: 'A seed calendar\nmonth by month', sender: { id: ME } },
    { content: 'and reminders', sender: { id: ME } },
  ];
  // The server's word, when it says it; an older server's rule otherwise.
  assert.equal(isOwnPrivateThread({ state: 'open', mine: true }, plus, ME), true);
  assert.equal(isOwnPrivateThread({ state: 'open', mine: false }, mine, ME), false);
  assert.equal(isOwnPrivateThread({ state: 'open' }, mine, ME), true, 'their own root');
  assert.equal(isOwnPrivateThread({ state: 'open' }, plus, ME), false, 'the bot\'s line, with no word from the server');
  assert.equal(isOwnPrivateThread(null, mine, 8), false, 'somebody else\'s');
  // Named as the tab's list names it.
  assert.equal(privateThreadTitle(mine, [], ME), 'An idea: swap seeds');
  assert.equal(privateThreadTitle(plus, replies, ME), 'A seed calendar', 'a "+" thread by their first words in it');
  assert.equal(privateThreadTitle(plus, [], ME), null, 'nothing yet: the caller names it by its kind');
  assert.equal(privateThreadTitle(design, [], ME), 'Home screen', 'a design thread by its screen');
  assert.equal(privateThreadTitle(draft, [], ME), 'I drafted it as a request on Seed swap, in a thread only you can see.');
  // The words: their root's, else their first message in the thread.
  assert.equal(privateThreadWords(mine, replies, ME), 'An idea: swap seeds\nby post');
  assert.equal(privateThreadWords(plus, replies, ME), 'A seed calendar\nmonth by month');
  assert.equal(privateThreadWords(draft, [], ME), '', 'nothing of theirs yet');
  // B08, B04 (audit 2 Nov 2026): a new project's thread is named by its idea and starts from it.
  const project = { content: 'New thread, for a new project: a chore chart. Only you can see it.', sender: { id: 2, bot: true }, metadata: { homeroomBot: { kind: 'opened_thread', projectIdea: 'a chore chart for our flat' } } };
  const answered = [{ content: 'Yes please. Just the three of us', sender: { id: ME } }];
  assert.equal(privateThreadTitle(project, answered, ME), 'a chore chart for our flat', 'never their newest words');
  assert.equal(privateThreadWords(project, answered, ME), 'a chore chart for our flat');
  // B19: a draft's thread by what it drafts.
  const named = { ...draft, metadata: { homeroomBot: { kind: 'opened_draft', draftTitle: 'Also show who has each thing' } } };
  assert.equal(privateThreadTitle(named, [], ME), 'Also show who has each thing');
});

test('in the bot tab\'s column a thread is alone under its own head, and says it is theirs', () => {
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /function ReplyThreadPanel\(\{ alone = false, onBack = null \}/);
  assert.match(screen, /<div className="messages-thread-name min-w-0 truncate" data-reply-title="">\{aloneTitle\}<\/div>/);
  assert.match(screen, /<span className="truncate">\{t\('messages:ai\.thread\.sub'\)\}<\/span>/);
  assert.equal(message('messages:ai.thread.sub'), 'Only you can see this thread');
  // 6 Nov 2026 (#6425): on a desktop the thread closes with its own ✕, which
  // leaves the lists alone; a phone's arrow still goes to the list, with no
  // ✕ beside it.
  assert.match(screen, /\{alone && onBack \? null : \(\s*<button type="button" className="messages-thread-action" data-reply-close=""/);
  assert.match(screen, /\{alone && onBack \? \(\s*<button type="button" className="messages-thread-action messages-thread-back" data-reply-back=""\s+aria-label=\{t\('messages:ai\.drawer\.back'\)\}/);
  assert.doesNotMatch(screen, /messages:replies\.backToMain/);
  assert.equal(message('messages:replies.close'), 'Close thread');
  assert.match(screen, /\{here && snap\.route\.threadRootId \? <ReplyThreadPanel alone onBack=\{onBack\} \/> : null\}/, 'the chat with the bot, mounted threads only');
});

test('the foot has New project alone: no File it or Post it form, and nothing it writes', () => {
  const source = read(BAR);
  assert.match(source, /data-private-doors=/);
  assert.match(source, /data-private-door=\{d\}/);
  assert.doesNotMatch(source, /privateThread\.(fileIt|postIt|sendFile|sendPost)/, 'no File it or Post it at the foot');
  assert.doesNotMatch(source, /method: 'POST'/, 'the foot writes nothing: the bot\'s offer does');
  assert.equal(renderComponent(BAR, 'PrivateThreadDoors', {
    rootId: 5, text: 'An idea', where: { state: 'open', kind: 'ask', app: { slug: 'notes', name: 'Notes' } }, botReplied: true, invited: true,
  }), '', 'a thread for a project has no foot, even when offered');
  assert.equal(renderComponent(BAR, 'PrivateThreadDoors', {
    rootId: 5, text: 'An idea', where: { state: 'open', kind: 'ask', app: null }, botReplied: true,
  }), '', 'no foot without the bot\'s offer');
  assert.match(renderComponent(BAR, 'PrivateThreadDoors', {
    rootId: 5, text: 'An idea', where: { state: 'open', kind: 'ask', app: null }, botReplied: true, invited: true,
  }), /data-private-door="new"[^>]*>New project</);
  // While the bot works in it, its working card is the foot's one thing: the chip waits.
  assert.equal(renderComponent(BAR, 'PrivateThreadDoors', {
    rootId: 5, text: 'An idea', where: { state: 'open', kind: 'ask', app: null }, botReplied: true, invited: true, working: true,
  }), '', 'nothing under the working card until the reply lands');
});

test('the bot offers File it once a request is ready: the foot has none', () => {
  const mayor = require('../src/services/homeroom-bot-mayor');
  const plus = mayor.systemPrompt({ username: 'ada', thread: { draft: { kind: 'ask', changeKind: 'fix', appSlug: 'notes', appName: 'Notes' } } });
  assert.match(plus, /Once it is clear enough to build, offer it as a request with offer_request:\n  File it shows only under that offer, so make it then, without waiting to be asked\./);
  const idea = mayor.systemPrompt({ username: 'ada', thread: { draft: null } });
  assert.match(idea, /Nothing in this thread is filed until you offer it\. Once what they want is clear enough to build, offer it as\n  a request with offer_request: File it shows only under that offer\./);
  const filed = mayor.systemPrompt({ username: 'ada', thread: { draft: { kind: 'draft_request', state: 'filed', issueNumber: 4, appSlug: 'notes', appName: 'Notes' } } });
  assert.doesNotMatch(filed, /File it shows only under that offer/, 'not once it is filed');
});

// #6153 (2 Nov 2026): a design thread filed as request #14 went quiet, its
// head saying only that it was filed, with a snapshot of the request that
// never moved. Its head says where the request stands now, from its track.
test('#6153: once filed, its head says where the request stands, live from its track, with Open request #N', () => {
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const track = (extra = {}) => ({
    key: 'ear trainer|14', appSlug: 'ear-trainer', appName: 'Ear Trainer', iconUrl: null, iconEmoji: null,
    issueNumber: 14, title: 'Design: Ear Trainer home', firstVersion: false, work: { stage: 'building' }, step: 'build',
    waitingOn: null, busy: true, try: 1, tryStartedAt: null, tryStarts: [], since: null, rootId: null, askId: null,
    proposalId: null, sessionId: null, links: { request: '#app/ear-trainer/dev/issues/14', proposal: null, project: '#app/ear-trainer' },
    ...extra,
  });
  // The viewer's bot work (./bot-work.tsx), which every track on the page reads.
  let work = { tracks: [track()] };
  const bar = loadTsx(BAR, { stubs: { './bot-work': { useBotWork: () => ({ work, failed: false }) } } });
  const where = {
    state: 'filed', kind: 'design', number: 14, app: { slug: 'ear-trainer', name: 'Ear Trainer' },
    href: '#app/ear-trainer/dev/issues/14', mine: true,
  };
  const head = () => renderToHtml(createElement(bar.PrivateThreadNote, { where }));

  const building = head();
  assert.match(building, /data-private-thread="track" data-private-track="building"/);
  assert.match(building, /<span class="[^"]*" data-private-track-state="">Building<\/span>/, 'the stage\'s own word');
  assert.match(building, /data-private-track-state="">Building<\/span><span class="min-w-0 flex-1 truncate"><\/span>/,
    'a stage with no second line says its word once');
  assert.match(building, /data-bot-track-bar="building"/, 'its five steps');
  assert.equal((building.match(/data-bot-track-step=/g) || []).length, 5);
  assert.match(building, /<a class="[^"]*" href="#app\/ear-trainer\/dev\/issues\/14" data-private-track-open="">Open request #14<\/a>/);
  assert.equal(message('messages:privateThread.openRequest', { number: 14 }), 'Open request #14');
  assert.doesNotMatch(building, /Filed as request/, 'the strip, not the snapshot');

  // Where the stage has a second line, it follows the word, whole on hover.
  // 11 Nov 2026: in the words the server sends with it (tests/lib/work-words.js).
  work = { tracks: [track({ work: withWords({ stage: 'building', line: { code: 'reviewing', round: 1, of: 2 } }) })] };
  assert.match(head(), /data-private-track-state="">Building<\/span><span class="min-w-0 flex-1 truncate" title="Reviewing, round 1 of 2">Reviewing, round 1 of 2<\/span>/);
  // It moves as the track does.
  work = { tracks: [track({ work: { stage: 'up_for_vote' }, step: 'vote', busy: false })] };
  assert.match(head(), /data-private-track="up_for_vote"/);
  assert.match(head(), /data-private-track-state="">Up for a vote<\/span>/);
  // Posted on a request as its plan, the same; with no address, the request's page.
  assert.match(renderToHtml(createElement(bar.PrivateThreadNote, { where: { ...where, state: 'posted', href: null } })),
    /href="#app\/ear-trainer\/dev\/issues\/14" data-private-track-open=""/);
  // No track for it (the bot is not on it, or its work is not read yet): where it went, as before.
  work = { tracks: [track({ issueNumber: 15, key: 'ear trainer|15' })] };
  assert.match(head(), /data-private-thread="filed">Filed as request #14 on Ear Trainer\./);
  work = null;
  assert.match(head(), /data-private-thread="filed"/);
  // Still open: only they can see it. Read in an effect: nothing on the first render.
  assert.match(renderToHtml(createElement(bar.PrivateThreadNote, { where: { state: 'open', kind: 'design', app: where.app, mine: true } })),
    /data-private-thread="open">Only you can see this thread\./);
  assert.equal(renderToHtml(createElement(bar.PrivateThreadNote, { where: null })), '');

  const { filedRequestOf } = bar;
  assert.deepEqual(filedRequestOf(where), { slug: 'ear-trainer', name: 'Ear Trainer', number: 14, href: '#app/ear-trainer/dev/issues/14' });
  assert.equal(filedRequestOf({ ...where, state: 'open' }), null);
  assert.equal(filedRequestOf({ ...where, app: null }), null, 'a thread in no project');
  assert.equal(filedRequestOf({ ...where, number: null }), null);
  assert.equal(filedRequestOf(null), null);
});

test('#6153: the Vote under a request\'s up-for-a-vote line goes once its vote is decided, as Read the plan does once it is built', () => {
  const source = read('frontend/src/features/messages/bot-question.tsx');
  // By the request's stage (lib/work-state.ts): its change went live or is on its way, or it stopped or closed.
  assert.match(source, /const VOTE_DECIDED: ReadonlySet<string> = new Set\(\['going_live', 'live', 'stopped', 'closed'\]\);/);
  assert.match(source, /const pastVote = !!track && VOTE_DECIDED\.has\(track\.work\.stage\);/);
  // Read the plan goes once the work is past its plan: built, or ended.
  assert.match(source, /const BEFORE_BUILD: ReadonlySet<string> = new Set\(\['reading', 'planning', 'waiting_for_you'\]\);/);
  assert.match(source, /const pastPlan = !!track && !BEFORE_BUILD\.has\(track\.work\.stage\);/);
  assert.match(source, /\.filter\(\(action\) => !\(pastPlan && action\.id === 'read_plan'\) && !\(pastVote && action\.id === 'vote'\)\);/);
  // The lines themselves (buildingLine, upForVoteLine) are no longer said
  // (5 Nov 2026, decision 6); one said before keeps its Vote until decided.
  const dm = require('../src/services/homeroom-bot-dm');
  assert.equal(dm.buildingLine, undefined);
  assert.equal(dm.upForVoteLine, undefined);
  const { planHtml, planDesignVersion } = require('../src/services/design-threads');
  const design = { title: 'Home', route: '/', width: 390, height: 844 };
  assert.equal(planDesignVersion(planHtml({ design, title: 'Design: Home', notes: '', after: '<p>new</p>', version: 4 })), 4, 'a new screen');
  assert.equal(planDesignVersion(planHtml({ design, title: 'Design: Home', notes: '', before: '<p>was</p>', after: '<p>new</p>', version: 7 })), 7,
    'a captured one, beside version 1');
  assert.equal(planDesignVersion('A plan a person wrote, version 3 of it.'), null);
  assert.equal(planDesignVersion(null), null);
});

test('the routes the old doors wrote to stay same-origin writes, and the head\'s copy is unchanged', () => {
  const routes = read('src/routes/conversations.js');
  assert.match(routes, /router\.post\('\/api\/conversations\/homeroom-bot\/threads\/:rootId\/file', conversationActionLimiter, sameOriginBrowserOnly,/);
  assert.match(routes, /router\.post\('\/api\/conversations\/homeroom-bot\/threads\/:rootId\/post', conversationActionLimiter, sameOriginBrowserOnly,/);
  assert.equal(message('messages:privateThread.label'), 'Only you can see this thread.');
  assert.equal(message('messages:privateThread.newProject'), 'New project');
  assert.equal(message('messages:privateThread.filed', { number: 41, project: 'Seed swap' }), 'Filed as request #41 on Seed swap.');
});

// #6159 (3 Nov 2026): a private thread can be finished, and brought back.
test('a done thread says so under its head, with Reopen; its ⋯ has Mark done, or Reopen', () => {
  const DONE = 'frontend/src/features/messages/private-thread-done.tsx';
  const done = renderComponent(BAR, 'PrivateThreadNote', { where: { state: 'done', mine: true }, rootId: 13306 });
  assert.match(done, /data-private-thread="done"[^>]*>This thread is done\./);
  assert.match(done, /data-private-thread-reopen=""[^>]*>Reopen</);
  const menu = renderComponent(DONE, 'ThreadDoneMenu', { rootId: 13306, done: false, onChanged() {} });
  assert.match(menu, /aria-label="Thread actions"[^>]*aria-haspopup="menu" aria-expanded="false"/);
  const source = read(DONE);
  assert.match(source, /\{done \? t\('messages:privateThread\.reopen'\) : t\('messages:privateThread\.markDone'\)\}/);
  assert.match(source, /`\/api\/conversations\/homeroom-bot\/threads\/\$\{rootId\}\/\$\{door\}`/);
  // Its row on the Homeroom bot page has the same ⋯, and leaves the lists at once.
  const lists = read('frontend/src/features/ai/lists.tsx');
  assert.match(lists, /<ThreadDoneMenu rootId=\{rootId\} done=\{false\} onChanged=\{\(state\) => \{ if \(state === 'done'\) mark\(\); \}\} className="shrink-0" \/>/);
  assert.match(read('frontend/src/features/ai/model.ts'), /if \(p\.state === 'done'\) continue;/);
});
