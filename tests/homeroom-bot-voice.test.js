'use strict';

// The Homeroom bot's voice outside its DM (src/services/homeroom-bot-voice.js):
// where it may speak, decided in code before any model runs; the tools each
// place gets; what it says when a change's update ends; and the seams that
// hand it messages (ws.js, homeroom-bot-chat.js) and asks (homeroom-bot.js
// runFollowUp, homeroom-bot-dm.js postOnProposal). The same against the full
// schema is tests/homeroom-bot-voice-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const voice = require('../src/services/homeroom-bot-voice');
const followup = require('../src/services/homeroom-bot-followup');
const addressedMod = require('../src/services/homeroom-bot-addressed');
const bot = require('../src/services/homeroom-bot');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const LIVE = { mode: 'live', voiceSession: true, voiceIssue: true, voiceChat: true, pausedApps: [] };

test('a message\'s place is its thread, and a governance vote\'s is none', () => {
  assert.deepEqual(voice.placeOf(null), { type: 'chat', ref: null });
  assert.deepEqual(voice.placeOf({ type: 'session', ref: '12' }), { type: 'session', ref: 12 });
  assert.deepEqual(voice.placeOf({ type: 'issue', ref: 7 }), { type: 'issue', ref: 7 });
  assert.deepEqual(voice.placeOf({ type: 'category', ref: 3 }), { type: 'category', ref: 3 });
  assert.deepEqual(voice.placeOf({ type: 'message', ref: 99 }), { type: 'message', ref: 99 });
  assert.equal(voice.placeOf({ type: 'governance', ref: 4 }), null);
  assert.equal(voice.placeOf({ type: 'session', ref: 0 }), null);
  assert.equal(voice.placeKey(9, { type: 'chat', ref: null }), '9:chat:');
  assert.equal(voice.placeKey(9, { type: 'session', ref: 12 }), '9:session:12');
  assert.equal(voice.threadOf({ type: 'chat', ref: null }), null);
  assert.deepEqual(voice.threadOf({ type: 'issue', ref: 7 }), { type: 'issue', ref: 7 });
});

test('each place has its own switch, on unless an admin turns it off, and nothing speaks while the bot is off', () => {
  assert.equal(voice.switchOf({ type: 'session' }), 'voiceSession');
  assert.equal(voice.switchOf({ type: 'issue' }), 'voiceIssue');
  for (const type of ['chat', 'category', 'message']) assert.equal(voice.switchOf({ type }), 'voiceChat');
  assert.equal(voice.voiceOn(LIVE, { type: 'session' }), true);
  assert.equal(voice.voiceOn({ ...LIVE, voiceSession: false }, { type: 'session' }), false);
  assert.equal(voice.voiceOn({ ...LIVE, voiceSession: false }, { type: 'issue' }), true, 'one place at a time');
  assert.equal(voice.voiceOn({ ...LIVE, voiceChat: false }, { type: 'message' }), false);
  assert.equal(voice.voiceOn({ ...LIVE, mode: 'off' }, { type: 'session' }), false);
  assert.equal(voice.voiceOn(null, { type: 'session' }), false);
  assert.equal(voice.voiceOn(LIVE, { type: 'governance' }), false);
  // The settings: on by default, off only when an admin says so.
  const parsed = bot.parseSettings([]);
  assert.equal(parsed.voiceSession && parsed.voiceIssue && parsed.voiceChat, true);
  const off = bot.parseSettings([{ key: bot.KEY_VOICE_CHAT, value: 'off' }]);
  assert.equal(off.voiceChat, false);
  assert.equal(off.voiceSession, true);
});

test('a mention of the bot is its handle or its name', () => {
  assert.equal(voice.mentionsBot('@Homeroom bot can you sort it?'), true);
  assert.equal(voice.mentionsBot('hey @homeroom_bot'), true);
  assert.equal(voice.mentionsBot('the homeroom bot did it'), false);
});

test('words a DM or a chat passed on are not answered twice', () => {
  assert.equal(voice.isRelay('Make it blue\n\n(Sent in a chat with Homeroom bot. The change, as Homeroom bot understood it: blue.)'), true);
  assert.equal(voice.isRelay('Make it blue'), false);
});

// ── The gate, on a pool that answers what it asks ────────────────────────

function gatePool({ quoteOf = null, change = null, posts = [], asks = [], before = null, open = null } = {}) {
  const asked = [];
  return {
    asked,
    async query(sql, params) {
      const s = String(sql);
      asked.push(s);
      if (/SELECT user_id FROM chat_messages WHERE id = \$1/.test(s)) return { rows: quoteOf == null ? [] : [{ user_id: quoteOf }] };
      if (/FROM homeroom_bot_change_asks WHERE message_id/.test(s)) return { rows: asks.includes(Number(params[0])) ? [{ '?column?': 1 }] : [] };
      if (/FROM chat_sessions cs WHERE cs\.id = \$1/.test(s)) return { rows: change ? [change] : [] };
      if (/FROM homeroom_bot_posts/.test(s)) return { rows: posts };
      if (/m\.thread_type = 'message' AND m\.thread_ref = \$2 AND m\.id < \$3/.test(s)) return { rows: before ? [before] : [] };
      if (/FROM chat_sessions/.test(s) && /linked_issues/.test(s) && open) return { rows: [open] };
      return { rows: [] };
    },
  };
}

const APP = { id: 9, slug: 'todo', name: 'Todo' };
const BOT = { id: 1, username: 'homeroom_bot' };
const EVAN = { id: 2, username: 'evan', isSynthetic: false, hasPlatformAccess: true };
const msg = (over = {}) => ({ id: 50, user_id: 2, content: 'hello', msg_type: 'message', metadata: {}, created_at: new Date(), ...over });
const deps = (over = {}) => ({
  dmSvc: { hasBot: (s, p) => !!p && !p.isSynthetic, ...over.dmSvc },
  liveSvc: { async openBotProposal() { return over.open || null; }, isLiveFor: () => true },
});

test('the gate: on the bot\'s own change any person\'s message; on anybody else\'s, a mention or a reply', async () => {
  const own = { id: 70, app_id: 9, user_id: 1, status: 'promoted', is_headless: false };
  const place = { type: 'session', ref: 70 };
  let out = await voice.gate(gatePool({ change: own }), { app: APP, place, row: msg(), bot: BOT, settings: LIVE, speaker: EVAN, deps: deps() });
  assert.deepEqual(out, { speak: true, why: 'own_change' });
  const theirs = { ...own, user_id: 5 };
  out = await voice.gate(gatePool({ change: theirs }), { app: APP, place, row: msg(), bot: BOT, settings: LIVE, speaker: EVAN, deps: deps() });
  assert.deepEqual(out, { speak: false, why: 'not_addressed' });
  out = await voice.gate(gatePool({ change: theirs }), { app: APP, place, row: msg({ content: '@Homeroom bot what does this do?' }), bot: BOT, settings: LIVE, speaker: EVAN, deps: deps() });
  assert.deepEqual(out, { speak: true, why: 'mentioned' });
  out = await voice.gate(gatePool({ change: theirs, quoteOf: 1 }), {
    app: APP, place, row: msg({ metadata: { quote: { refMsgId: 44 } } }), bot: BOT, settings: LIVE, speaker: EVAN, deps: deps(),
  });
  assert.deepEqual(out, { speak: true, why: 'replied' });
  // Words a DM passed on as an ask are the follow-up's.
  out = await voice.gate(gatePool({ change: own, asks: [50] }), { app: APP, place, row: msg(), bot: BOT, settings: LIVE, speaker: EVAN, deps: deps() });
  assert.deepEqual(out, { speak: false, why: 'queued_as_ask' });
});

test('the gate never answers the bot, a connector, a relay, an edit or somebody it does not talk to', async () => {
  const place = { type: 'chat', ref: null };
  const row = msg({ content: '@Homeroom bot hi' });
  const g = (over) => voice.gate(gatePool(), { app: APP, place, row, bot: BOT, settings: LIVE, speaker: EVAN, deps: deps(), ...over });
  assert.equal((await g({})).speak, true);
  assert.equal((await g({ speaker: { ...EVAN, id: 1 } })).why, 'not_a_person');
  assert.equal((await g({ speaker: { ...EVAN, isSynthetic: true } })).why, 'not_a_person');
  assert.equal((await g({ row: { ...row, posted_via: 'agent' } })).why, 'connector');
  assert.equal((await g({ row: { ...row, msg_type: 'system' } })).why, 'not_a_message');
  assert.equal((await g({ row: { ...row, content: '@Homeroom bot x\n\n(Sent in a chat with Homeroom bot.)' } })).why, 'relayed');
  assert.equal((await g({ settings: { ...LIVE, voiceChat: false } })).why, 'switched_off');
  assert.equal((await g({ settings: { ...LIVE, pausedApps: ['todo'] } })).why, 'paused');
  assert.equal((await g({ deps: deps({ dmSvc: { hasBot: () => false } }) })).why, 'not_let_in');
  assert.equal((await g({ row: { ...row, content: 'hi all' } })).why, 'not_addressed');
});

test('the gate on a request: a mention or a reply, but an answer to its question is the build\'s; once its change is up, any message', async () => {
  const place = { type: 'issue', ref: 24 };
  const asked = new Date(Date.now() - 60_000);
  const mention = msg({ content: '@Homeroom bot the grocery list' });
  let out = await voice.gate(gatePool({ posts: [{ kind: 'question', created_at: asked }] }), {
    app: APP, place, row: mention, bot: BOT, settings: LIVE, speaker: EVAN, deps: deps(),
  });
  assert.deepEqual(out, { speak: false, why: 'answers_question' });
  out = await voice.gate(gatePool({ posts: [{ kind: 'person', created_at: asked }] }), {
    app: APP, place, row: mention, bot: BOT, settings: LIVE, speaker: EVAN, deps: deps(),
  });
  assert.deepEqual(out, { speak: true, why: 'mentioned' });
  out = await voice.gate(gatePool(), { app: APP, place, row: msg({ content: 'looks good' }), bot: BOT, settings: LIVE, speaker: EVAN, deps: deps() });
  assert.deepEqual(out, { speak: false, why: 'not_addressed' });
  out = await voice.gate(gatePool(), {
    app: APP, place, row: msg({ content: 'looks good' }), bot: BOT, settings: LIVE, speaker: EVAN, deps: deps({ open: { id: 70, status: 'promoted' } }),
  });
  assert.deepEqual(out, { speak: true, why: 'own_change' });
});

test('the gate in a reply thread: the next message after the bot\'s own, soon after it, is to the bot', async () => {
  const place = { type: 'message', ref: 40 };
  const g = (before) => voice.gate(gatePool({ before }), { app: APP, place, row: msg({ content: 'and on Sundays?' }), bot: BOT, settings: LIVE, speaker: EVAN, deps: deps() });
  assert.deepEqual(await g({ user_id: 1, created_at: new Date() }), { speak: true, why: 'continued' });
  assert.deepEqual(await g({ user_id: 1, created_at: new Date(Date.now() - 2 * 60 * 60 * 1000) }), { speak: false, why: 'not_addressed' });
  assert.deepEqual(await g({ user_id: 3, created_at: new Date() }), { speak: false, why: 'not_addressed' });
});

// ── Tools, prompt, words ─────────────────────────────────────────────────

const names = (tools) => tools.map((t) => t.function.name);

test('each place gets the tools that fit it, and nothing that acts without a tap', () => {
  assert.deepEqual(names(voice.toolsFor({ type: 'session', ref: 1 }, { ownChange: true })),
    ['reply', 'stay_quiet', 'update_change', 'offer_withdraw', 'request_detail', 'list_source', 'read_source']);
  assert.deepEqual(names(voice.toolsFor({ type: 'session', ref: 1 }, { ownChange: false })),
    ['reply', 'stay_quiet', 'request_detail', 'list_source', 'read_source'], 'somebody else\'s change: answer only');
  assert.deepEqual(names(voice.toolsFor({ type: 'issue', ref: 1 }, { requestChange: false })),
    ['reply', 'stay_quiet', 'start_request', 'offer_close_request', 'request_detail', 'list_source', 'read_source']);
  const chat = voice.toolsFor({ type: 'chat', ref: null }, { openChangeCount: 2, platform: true });
  assert.deepEqual(names(chat), ['reply', 'stay_quiet', 'update_change', 'offer_request', 'offer_close_request', 'request_detail', 'list_source', 'read_source', 'get_change', 'get_discussion', 'list_requests']);
  assert.ok(chat[2].function.parameters.properties.change, 'in a chat it names which change');
  assert.ok(!names(chat).includes('offer_withdraw'), 'withdrawing is offered where the change is');
  const chatClose = chat.find((t) => t.function.name === 'offer_close_request');
  assert.deepEqual(chatClose.function.parameters.required, ['number', 'why'], 'in a chat it names which request');
  const issueClose = voice.toolsFor({ type: 'issue', ref: 1 }, { requestChange: false })
    .find((t) => t.function.name === 'offer_close_request');
  assert.ok(!issueClose.function.parameters.properties.number, 'on the request it is the request itself');
});

test('the prompt says where it is, lists only what it can do, and holds it to what it did', () => {
  const tools = voice.toolsFor({ type: 'chat', ref: null }, { openChangeCount: 0 });
  const prompt = voice.systemPrompt({ app: { slug: 'todo', name: 'Todo' }, place: { type: 'chat', ref: null }, tools, today: new Date('2026-10-10T00:00:00Z') });
  assert.match(prompt, /in a reply thread under the message you answer/);
  assert.match(prompt, /offer_request/);
  assert.match(prompt, /offer_close_request/);
  assert.match(prompt, /by its number/);
  assert.doesNotMatch(prompt, /update_change|offer_withdraw/);
  assert.match(prompt, /Never say you did something/);
  assert.match(prompt, /Credit what was said to the person whose name is on that message\./,
    '#5371: each answer is credited to the person who wrote it, not to whoever filed the request');
  assert.match(prompt, /stay_quiet/);
  assert.match(prompt, /Today is 2026-10-10/);
  assert.doesNotMatch(prompt, /—/, 'no em dashes in what it is told either');
});

test('a transcript line says who wrote it, what it replied to, and the bot as "you"', () => {
  const at = new Date('2026-10-09T12:30:00Z');
  assert.equal(voice.transcriptLine({ id: 5, user_id: 2, username: 'evan', content: 'Make it\nblue', msg_type: 'message', created_at: at, metadata: {} }, 1),
    '#5 [10-09 12:30] @evan: Make it blue');
  assert.match(voice.transcriptLine({ id: 6, user_id: 1, content: 'Done', msg_type: 'message', created_at: at, metadata: {} }, 1), /you \(Homeroom bot\): Done/);
  assert.match(voice.transcriptLine({ id: 7, user_id: 2, username: 'evan', content: 'thanks', msg_type: 'message', created_at: at, metadata: { quote: { refMsgId: 6, author: 'homeroom_bot', snippet: 'Done' } } }, 1),
    /replying to #6 by @homeroom_bot: "Done"/);
});

test('an offer is two buttons the person it is for taps; the reply quotes what it answers', () => {
  assert.deepEqual(voice.offerActions('withdraw_change', 4), [
    { id: 'yes', label: 'Withdraw it', style: 'primary', offerId: 4 },
    { id: 'no', label: 'Keep it', style: 'secondary', offerId: 4 },
  ]);
  assert.deepEqual(voice.offerActions('file_request', 5).map((a) => a.label), ['File it', 'Not now']);
  assert.deepEqual(voice.offerActions('close_request', 6).map((a) => a.label), ['Propose to close', 'Keep it open']);
  assert.deepEqual(voice.offerActions('nope', 1), []);
  assert.deepEqual(voice.quoteOf({ id: 8, content: 'Make   it blue' }, 'evan'), { source: 'message', refMsgId: 8, author: 'evan', snippet: 'Make it blue' });
});

test('what a change\'s update came to, in its own words when no model answers', () => {
  // One note per update: that its votes were cleared is the platform's line
  // in the change's discussion, not the voice's to repeat.
  assert.equal(voice.plainReport({ action: 'revise', moved: true, summary: 'The header is blue now.' }),
    'Done: The header is blue now.');
  assert.equal(voice.plainReport({ action: 'answer', reply: 'It already sorts by date.' }), 'It already sorts by date.');
  assert.match(voice.plainReport({ action: 'ask', reply: 'Which header?' }), /^I have a question before I update this change: Which header\?/);
  assert.match(voice.plainReport({ action: 'failed', why: 'it ran out of time' }), /^I couldn't make that change: I ran out of time\. The change is as it was\./);
  assert.match(voice.plainReport({ action: 'gone' }), /isn't up for a vote any more/);
  assert.deepEqual(voice.mustSay({ action: 'revise', moved: true, planVersion: 2 }), [
    'Its plan was updated to match (version 2).',
  ]);
  for (const action of ['revise', 'answer', 'ask', 'person', 'failed', 'gone']) {
    const text = voice.plainReport({ action, moved: true, summary: 'x — y', reply: 'a — b', why: 'c' });
    assert.doesNotMatch(text, /—|Homeroom bot/, action);
  }
});

test('an ask is read by the follow-up beside the other replies, saying where it was asked', () => {
  const reply = followup.askAsReply({
    id: 3, asker: 'evan', instruction: 'Make the header blue on every page', source: 'chat', place_type: 'chat',
    created_at: new Date('2026-10-10T09:00:00Z'),
  });
  assert.deepEqual(reply, {
    where: 'proposal', via: 'ask', askedIn: 'chat', author: 'evan', body: 'Make the header blue on every page',
    createdAt: '2026-10-10T09:00:00.000Z', askId: 3,
  });
  const prompt = followup.followUpPrompt({ seed: 'SEED', replies: [reply], canRevise: true });
  assert.match(prompt, /evan, asked you for a change in the project's chat/);
  assert.match(prompt, /Make the header blue on every page/);
  assert.equal(followup.askAsReply({ source: 'issue', place_type: 'issue', instruction: 'x' }).where, 'issue');
});

test('a repeat note is held for a mention the voice answers, but an answer to its question still speaks', () => {
  const lastNote = { kind: 'person', created_at: '2026-10-10T09:00:00Z' };
  const messages = [{ body: '@homeroom_bot what now?', createdAt: '2026-10-10T09:05:00Z', quotesBot: false }];
  assert.equal(addressedMod.addressed({ lastNote, messages }).why, 'mention');
  assert.deepEqual(addressedMod.addressed({ lastNote, messages, voiceAnswers: true }), { speak: false, why: 'not_addressed' });
  assert.equal(addressedMod.addressed({ lastNote: { ...lastNote, kind: 'question' }, messages, voiceAnswers: true }).why, 'answer');
  // A mention on GitHub still counts: the voice does not read GitHub.
  const comments = [{ author: 'sam', body: '@homeroom_bot please', createdAt: '2026-10-10T09:06:00Z', id: 1 }];
  assert.equal(addressedMod.addressed({ lastNote, comments, voiceAnswers: true }).why, 'mention');
});

// ── The seams ────────────────────────────────────────────────────────────

test('the room hands every person\'s message to the voice in the statement that stores it, never a connector\'s or a vote\'s', () => {
  const ws = read('src/services/ws.js');
  assert.match(ws, /const heard = postedVia !== 'agent' && \(!thread \|\| thread\.type !== 'governance'\);/);
  assert.match(ws, /\? require\('\.\.\/workflow\/platform\.ts'\)\.insertHeard\(db, insertSql, insertParams, \{ appId: client\.appId, thread: thread \|\| null \}\)/);
  const platform = read('src/workflow/platform.ts');
  const heard = platform.slice(platform.indexOf('export async function insertHeard'));
  assert.match(heard, /`WITH m AS \(\$\{insertSql\}\),\s+e AS \(\s+INSERT INTO wf_events/, 'the message and its event, one statement');
  // Nothing floats after the commit to hear it.
  assert.doesNotMatch(ws, /homeroom-bot-voice'\)\.noteMessage|homeroom-bot-chat'\)\.noteChatMessage/);
  assert.match(ws, /require\('\.\/homeroom-bot-voice'\)\.setConfig\(config\)/);
  assert.match(ws, /module\.exports = \{ noteBoardChange, broadcastThreadSummary,/);
  // The bot's reply in a reply thread names its root, as a person's does.
  const send = ws.slice(ws.indexOf('async function sendBotMessage'), ws.indexOf('function getOnlineUsers'));
  assert.match(send, /appChat\.findThreadRoot\(pool, appId, thread\.ref\)/);
});

test('a mention in a project\'s chat is the voice\'s while it is on there; the newcomer\'s offer stays', () => {
  const chat = read('src/services/homeroom-bot-chat.js');
  const note = chat.slice(chat.indexOf('async function noteChatMessage'), chat.indexOf('function wordCount'));
  assert.match(note, /if \(mentioned && await \(deps\.voice \|\| require\('\.\/homeroom-bot-voice'\)\)\.enabledFor\(pool, 'chat', deps\)\) return null;/);
  assert.ok(note.indexOf('enabledFor') < note.indexOf('return await maybeOffer'), 'decided before anything is read for it');
  // The chat place's turn hands it what nobody said to the bot.
  const src = read('src/services/homeroom-bot-voice.js');
  assert.match(src, /await chatModule\(deps\)\.heardInChat\(pool, cfg, \{ app, place, messages: fresh\.filter\(\(m\) => !told\.has\(Number\(m\.id\)\)\), deps \}\);/);
});

test('the change follow-up takes the asks and lets the voice tell the people who asked; no working or wait notes for them', () => {
  const src = read('src/services/homeroom-bot.js');
  const run = src.slice(src.indexOf('async function runFollowUp'), src.indexOf('async function renameRevised'));
  assert.match(run, /voice\.takeAsks\(pool, \{ sessionId: proposal\.id, runTag \}\)/);
  assert.match(run, /replies = replies\.filter\(\(r\) => r\.via !== 'homeroom' \|\| \(r\.where === 'proposal' \? !voiceOnChange : !voiceOnRequest\)\);/);
  assert.match(run, /onStart: deps\.ws && !asks\.length \?/);
  assert.match(run, /turn\.routed\?\.error === 'session_busy' && deps\.ws && !asks\.length/);
  // The asks end and their report is owed in one transaction.
  assert.match(run, /voice\.reportFollowUp\(pool, config, \{\s*app, session, asks, runTag, deps: voiceDeps,/);
  assert.match(run, /finish: \(db\) => voice\.finishAsks\(db, \{ runTag, runId \}\),/);
  assert.match(run, /await requeueAsks\(\);\n  return \{ ran: true, verdict: followup\.VERDICT_FOR\[action\]/);
  // And a message in its discussion no longer brings it back by itself.
  const note = src.slice(src.indexOf('async function noteProposalActivity'), src.indexOf('function onBusMessage'));
  assert.match(note, /if \(voiceModule\(deps\)\.voiceOn\(settings, \{ type: 'session' \}\)\) return false;/);
  // GitHub hears an update, or an answer to a comment there, and no chatter.
  assert.match(run, /skipGithub: kind !== 'followup_revise' && !others\.some\(\(r\) => r\.via === 'github'\)/);
});

test('the DM, a chat\'s fix and a No vote\'s line become asks, and a merge drops what was still asked', () => {
  const dm = read('src/services/homeroom-bot-dm.js');
  const post = dm.slice(dm.indexOf('async function postOnProposal'), dm.indexOf('// ── A No vote\'s line'));
  assert.match(post, /\.recordAsk\(pool, \{/);
  assert.match(post, /source: queueReason === 'vote_no' \? 'vote_no' : 'dm'/);
  assert.match(post, /messageId: Number\(posted\.message\?\.id\) \|\| null/);
  const merged = dm.slice(dm.indexOf('async function noteProposalMerged'));
  assert.match(merged.slice(0, 500), /\.dropAsks\(pool, session\.id, \{ strict: !!deps\.strict \}\)/, 'strict in the bot-change machine\'s durable work');
});

test('a tap under an offer is the person\'s own, from their browser, and members only', () => {
  const routes = read('src/routes/chat.js');
  const at = routes.indexOf("router.post('/api/apps/:slug/messages/:id/bot-offer'");
  assert.ok(at > 0);
  const route = routes.slice(at, at + 1400);
  assert.match(route, /groupChatWriteLimiter, sameOriginBrowserOnly,\s*communities\.requireAppMembership\(pool\)/);
  assert.match(route, /if \(choice !== 'yes' && choice !== 'no'\)/);
  assert.match(route, /appAccess\.getAppForUser\(pool, req\.params\.slug, req\.user, 'collab'/);
  assert.match(route, /decideOffer\(pool, config, \{/);
});

test('the chat draws an offer\'s buttons for the person it is for, and takes them away when it is decided', () => {
  const gc = read('public/js/group-chat.js');
  assert.match(gc, /case 'chat_message_updated': \{/);
  assert.match(gc, /botOffer: GroupChat\._botOfferView\(kind === 'message' && !deleted \? meta : null\)/);
  assert.match(gc, /\/messages\/\$\{Number\(messageId\)\}\/bot-offer/);
  const tx = read('frontend/src/features/group-chat/transcript.tsx');
  assert.match(tx, /msg\.botOffer && msg\.botOffer\.forMe && msg\.botOffer\.status === 'open'/);
  assert.match(tx, /controller\(\)\?\.decideBotOffer\?\.\(id, choice\)/);
});

test('the voice\'s module and its tables say what they are for', () => {
  const schema = read('src/db/schema.sql');
  for (const table of ['homeroom_bot_voice_turns', 'homeroom_bot_change_asks', 'homeroom_bot_voice_offers']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(schema, new RegExp(`COMMENT ON TABLE ${table} IS 'staging:private'`));
  }
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS homeroom_bot_voice_turns_running\s+ON homeroom_bot_voice_turns\(place_key\) WHERE finished_at IS NULL/);
  const agents = read('AGENTS.md');
  assert.match(agents, /Homeroom bot answering somebody who mentioned it there is conversation,\s+not activity/);
});

// ── What a report says, and how a queued change is said (10 October) ─────
//
// The voice's first real update, on change 7630 (PR #4646): its report ended
// "The harness will commit and push.", passed on from the coding agent's own
// reply, and the turn that queued it opened "Done, @evan: I've queued…".

test('a report says nothing of the coding agent\'s workings: harness, commits, pushes, branches, files', () => {
  const said = 'I updated change 7630 as asked. The requester\'s locale now flows into every prompt that writes to people, '
    + 'so DM replies come in the language picked in Settings. The harness will commit and push.';
  assert.equal(voice.withoutInternals(said),
    'I updated change 7630 as asked. The requester\'s locale now flows into every prompt that writes to people, '
    + 'so DM replies come in the language picked in Settings.');
  for (const leak of [
    'I pushed it to the branch.', 'I committed the fix.', 'I\'ll push the change once checks pass.',
    'I changed frontend/src/features/messages/format.tsx so names drop the @.', 'The edit is in server.js.',
    'I rebased it on main.', 'Run git status to see it.', 'It lives in a worktree.',
  ]) assert.equal(voice.withoutInternals(leak), '', leak);
  for (const kept of [
    'Push notifications now say who replied.', 'Push the big button to start a round.',
    'Names in DMs drop the @.', 'The list now sorts by due date.',
  ]) assert.equal(voice.withoutInternals(kept), kept, kept);
  assert.equal(voice.withoutInternals(''), '');
  assert.equal(voice.withoutInternals(null), '');
  // Its plain words, when no model answers, leave them out too.
  assert.equal(
    voice.plainReport({ action: 'revise', moved: true, summary: 'Names in DMs drop the @. The harness will commit and push.' }),
    'Done: Names in DMs drop the @.',
  );
  assert.equal(voice.plainReport({ action: 'answer', reply: 'I pushed it to the branch.' }), 'I looked, and there is nothing to change.');
});

test('the report\'s model is never shown the agent\'s workings, is told not to name them, and what it says of them anyway goes', async () => {
  const seen = [];
  const deps = {
    apiKey: 'test-key', sleep: async () => {},
    ws: { async sendBotMessage(_p, _a, args) { seen.push({ sent: args }); return { id: 9 }; } },
    notifications: { async createMentionNotifications() { return []; }, async hydrateAndPush() {} },
    chat: async (req) => {
      seen.push({ req });
      return {
        content: '',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'reply', arguments: JSON.stringify({
          text: 'I updated it: DM replies now come in your language. The harness will commit and push.',
        }) } }],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      };
    },
  };
  // The rows the report's work reads, by what it asks.
  const pool = {
    async query(sql) {
      if (/FROM apps WHERE id/.test(sql)) return { rows: [{ id: 9, slug: 'homeroom', name: 'Homeroom' }] };
      if (/FROM chat_sessions WHERE id/.test(sql)) return { rows: [{ id: 7630, pr_number: 4646, title: 'Match the requester\'s language in DMs' }] };
      if (/FROM homeroom_bot_change_asks a WHERE a\.id = ANY/.test(sql)) {
        return { rows: [{ id: 1, asker: 'evan', asker_id: 2, instruction: 'Use the user\'s locale in DMs', place_type: 'session', place_ref: 7630 }] };
      }
      return { rows: [] };
    },
  };
  deps.dmSvc = { async botAccount() { return { id: 1, username: 'homeroom_bot' }; } };
  const out = await voice.sayReport(pool, {}, {
    appId: 9, place: { type: 'session', ref: 7630 }, sessionId: 7630, runTag: 'fu1', asks: [1],
    outcome: {
      action: 'revise', moved: true,
      summary: 'DM replies follow the language picked in Settings.',
      reply: 'Folded in. The DM chat replier stays untouched. The harness will commit and push.',
    },
    deps,
  });
  assert.equal(out.id, 9);
  const req = seen.find((x) => x.req).req;
  const facts = req.messages[1].content;
  assert.doesNotMatch(facts, /harness|commit|push/i, 'the facts it writes from leave them out');
  assert.match(facts, /DM replies follow the language picked in Settings\./);
  assert.match(req.messages[0].content, /Never mention the harness, commits, pushes,\s+branches, files, code, prompts/);
  const sent = seen.find((x) => x.sent).sent;
  assert.equal(sent.content,
    'I updated it: DM replies now come in your language.');
});

test('a turn that only queued a change, or only offered something, never opens by saying it is done', () => {
  assert.equal(voice.notDoneYet('Done, @evan: I\'ve queued the update to fold locale-aware DM replies into change 7630.'),
    'Got it, @evan: I\'ve queued the update to fold locale-aware DM replies into change 7630.');
  assert.equal(voice.notDoneYet('Done. I\'ve queued it behind the update running now.'), 'Got it. I\'ve queued it behind the update running now.');
  assert.equal(voice.notDoneYet('All done! It\'s queued.'), 'Got it. It\'s queued.');
  assert.equal(voice.notDoneYet('Finished: queued for its next update.'), 'Got it, queued for its next update.');
  assert.equal(voice.notDoneYet('Done'), 'Got it.');
  for (const fine of ['Got it: I\'ve queued it.', 'Queued: I\'ll make the header blue next.', 'Doneness aside, it is queued.']) {
    assert.equal(voice.notDoneYet(fine), fine, fine);
  }
  // Applied to a turn's reply when it queued a change or made an offer, and
  // the model is told the same in the prompt and in update_change's answer.
  const src = read('src/services/homeroom-bot-voice.js');
  assert.match(src, /if \(text && \(ctx\.revised \|\| ctx\.offer\)\) text = notDoneYet\(text\);/);
  assert.match(src, /never say it is done, since it is not made yet/);
  assert.match(src, /next: 'It is not made yet, so never say it is done\./);
});

test('a change something is running on reads busy, in a turn\'s facts and when an ask is recorded', async () => {
  // turnRunningOn takes one options object. Both paths once passed it the
  // pool and an id, so it threw, the throw read as "free", and a running
  // turn, operation or shots run on the change was never seen.
  const change = { id: 70, app_id: 9, user_id: 1, status: 'promoted', is_headless: false, linked_issues: [], title: 'Blue header' };
  const pool = ({ activeTurn = null } = {}) => ({
    async query(sql) {
      if (/FROM chat_sessions cs WHERE cs\.id/.test(sql)) return { rows: [change] };
      if (/SELECT active_turn FROM chat_sessions/.test(sql)) return { rows: [{ active_turn: activeTurn }] };
      if (/INSERT INTO homeroom_bot_change_asks/.test(sql)) return { rows: [{ id: 501 }] };
      if (/COUNT\(\*\)::int AS n FROM homeroom_bot_runs/.test(sql)) return { rows: [{ n: 0 }] };
      return { rows: [] };
    },
  });
  const busyDeps = (over = {}) => ({
    ...deps(),
    botSvc: { async enqueueFront() { return true; } },
    worker: { isInFlight: () => false },
    activeWorkers: new Set(),
    shotsRunning: async () => false,
    ...over,
  });
  const facts = (p, d) => voice.factsFor(p, {
    app: APP, place: { type: 'session', ref: 70 }, bot: BOT, settings: LIVE, speaker: EVAN, deps: d,
  });
  const ask = async (p, d) => (await voice.recordAsk(p, {
    appId: 9, sessionId: 70, issueNumber: 12, askerId: 2, instruction: 'make it blue', force: true, deps: d,
  })).running;

  assert.match(await facts(pool(), busyDeps()), /Nothing is running on it now\./);
  assert.equal(await ask(pool(), busyDeps()), false);
  const held = [
    ['a worker turn in this process', pool(), busyDeps({ activeWorkers: new Set([70]) })],
    ['its executing worker', pool(), busyDeps({ worker: { isInFlight: (id) => Number(id) === 70 } })],
    ['a shots run', pool(), busyDeps({ shotsRunning: async (id) => id === 70 })],
    ['a turn on its row', pool({ activeTurn: { turnId: 't1' } }), busyDeps()],
  ];
  for (const [what, p, d] of held) {
    assert.match(await facts(p, d), /A run on it is going right now\./, what);
    assert.equal(await ask(p, d), true, what);
  }
});
