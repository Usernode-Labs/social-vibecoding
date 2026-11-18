'use strict';

// 18 Nov 2026: how Homeroom bot's messages look in its own chats.
//
//   1. A live card when it starts work: the reply names the request it
//      queued or started (`liveWork`), and the chat draws that request's own
//      track under it, moving as the server pushes, with Vote once it is up
//      for a vote. A request that is not the viewer's own is read too.
//   2. One style: every bot message in its chats is the flat named row
//      (pinned in tests/messages-bubble-sides.test.js), and a settled card
//      has no fill.
//   3. One card per action: a tapped offer changes into what came of it on
//      its card ("Filed as request #12."), with no "You chose" line and no
//      message under it saying it again; a draft folds away under its gist.
//
// Without a database or a browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message: catalog } = require('./lib/platform-i18n');
const { withWords } = require('./lib/work-words');
const mayor = require('../src/services/homeroom-bot-mayor');
const aiWork = require('../src/services/ai-work');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const LIVE = 'frontend/src/features/messages/bot-live-card.tsx';
const QUESTION = 'frontend/src/features/messages/bot-question.tsx';
const HEAD = 'frontend/src/features/messages/bot-head-card.tsx';
const API = 'frontend/src/features/messages/api.ts';

globalThis.window = {
  App: { user: { id: 7, username: 'ada' } },
  location: { search: '', hash: '#homeroom-bot' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout, setInterval, clearInterval,
};

const t = (id, values) => catalog(`messages:${id}`, values);
const at = (stage, extra = {}) => withWords({ stage, why: null, reason: null, line: null, whoseMove: null, since: null, ...extra });
const links = (extra = {}) => ({ request: '#app/plant-pal/dev/issues/12', proposal: null, project: '#app/plant-pal', ...extra });
const track = (extra = {}) => ({
  key: 'plant-pal#12', appSlug: 'plant-pal', appName: 'Plant Pal', iconUrl: null, iconEmoji: null,
  issueNumber: 12, title: 'Dark mode', firstVersion: false, work: at('building'), step: 'build', waitingOn: null,
  busy: true, try: 1, tryStartedAt: null, tryStarts: [], since: null, rootId: null, askId: null, proposalId: null,
  sessionId: null, links: links(), ...extra,
});

// ── 1. The live card ─────────────────────────────────────────────────────

test('a turn that starts work names its request for the live card, and tells the model the card says the rest', () => {
  const ctx = {};
  mayor.noteLiveWork(ctx, { slug: 'plant-pal', name: 'Plant Pal' }, 12, 'Dark mode');
  assert.deepEqual(ctx.liveWork, { appSlug: 'plant-pal', appName: 'Plant Pal', issueNumber: 12, title: 'Dark mode' });
  const none = {};
  mayor.noteLiveWork(none, { slug: 'plant-pal' }, 0);
  assert.equal(none.liveWork, undefined, 'no request, no card');
  assert.match(mayor.LIVE_CARD_NOTE, /A live card for it goes under your reply/);
  assert.match(mayor.LIVE_CARD_NOTE, /do not offer to tell them when it is ready: the card does\./);
  const src = read('src/services/homeroom-bot-mayor.js');
  // Every way start_request, the replan and a revision start work names it.
  const start = src.slice(src.indexOf('async function startRequest('), src.indexOf('async function replanRequest('));
  assert.equal((start.match(/ctx\.started = name;\n\s+noteLiveWork\(ctx, app, n\);/g) || []).length, 5);
  assert.match(src.slice(src.indexOf('async function replanRequest(')), /ctx\.started = name;\n  noteLiveWork\(ctx, app, n\);/);
  assert.match(src, /noteLiveWork\(ctx, app, issueNumber, session\.title \|\| null\);/);
  assert.match(src, /\.\.\.\(ctx\.liveWork \? \{ liveWork: ctx\.liveWork \} : \{\}\),/, 'on the reply\'s metadata');
  assert.doesNotMatch(src.slice(0, src.indexOf('PLATFORM RULES')), /—/);
});

test('the chat reads the live card\'s request off a bot reply, and nothing else', () => {
  const api = loadTsx(API);
  assert.deepEqual(api.normalizeLiveWork({ appSlug: 'plant-pal', appName: 'Plant Pal', issueNumber: 12 }),
    { appSlug: 'plant-pal', appName: 'Plant Pal', issueNumber: 12 });
  assert.equal(api.normalizeLiveWork({ appSlug: 'plant-pal', issueNumber: 0 }), null);
  assert.equal(api.normalizeLiveWork({ issueNumber: 12 }), null);
  assert.equal(api.normalizeLiveWork('x'), null);
  assert.deepEqual(api.normalizeBotMeta({ homeroomBot: { kind: 'chat', liveWork: { appSlug: 'p', issueNumber: 3 } } }).homeroomBot.liveWork,
    { appSlug: 'p', issueNumber: 3 });
  const live = loadTsx(LIVE);
  const work = { appSlug: 'plant-pal', issueNumber: 12 };
  const bot = { id: 2, username: 'homeroom_bot', bot: true };
  assert.deepEqual(live.liveWorkOf({ sender: bot, metadata: { homeroomBot: { kind: 'chat', liveWork: work } } }), work);
  assert.equal(live.liveWorkOf({ sender: { id: 7, username: 'ada' }, metadata: { homeroomBot: { liveWork: work } } }), null, 'only the bot\'s');
  assert.equal(live.isLiveCardObject(work, { type: 'issue', appSlug: 'plant-pal', issueNumber: 12, available: true }), true);
  assert.equal(live.isLiveCardObject(work, { type: 'issue', appSlug: 'plant-pal', issueNumber: 13, available: true }), false);
  assert.equal(live.isLiveCardObject(null, { type: 'issue', appSlug: 'plant-pal', issueNumber: 12, available: true }), false);
});

test('the live card moves through the stages in the words every screen uses, with Vote when it is time', () => {
  const { LiveTrackCard } = loadTsx(LIVE);
  const draw = (tr) => renderToHtml(createElement(LiveTrackCard, { track: tr, title: 'Dark mode' }));

  const queued = draw(track({ work: at('reading', { line: { code: 'queued' } }), step: null, busy: false }));
  assert.match(queued, /data-bot-live="reading"/);
  assert.match(queued, /bg-\[color:var\(--messages-surface\)\]/, 'work under way keeps its surface');
  assert.match(queued, /data-bot-track-bar=/, 'and its five steps');

  const building = draw(track());
  assert.match(building, /data-bot-live="building"/);
  assert.match(building, /data-bot-live-state="">Building</);
  assert.match(building, /data-bot-live-request="plant-pal#12"/);
  assert.doesNotMatch(building, /data-bot-live-vote/);

  const checking = draw(track({ work: at('checking'), step: 'checks' }));
  assert.match(checking, /data-bot-live="checking"/);

  const vote = draw(track({ work: at('up_for_vote'), step: 'vote', links: links({ proposal: '#app/plant-pal/dev/changes/7' }) }));
  assert.match(vote, /<a class="[^"]*bg-violet-600[^"]*" href="#app\/plant-pal\/dev\/changes\/7" data-bot-live-vote="">Vote<\/a>/,
    'the act, in the accent');
  assert.equal(t('bot.live.vote'), 'Vote');

  const live = draw(track({ work: at('live'), step: 'live', busy: false }));
  assert.match(live, /data-bot-live="live"/);
  assert.doesNotMatch(live, /bg-\[color:var\(--messages-surface\)\]/, 'a settled card has no fill');
  assert.match(live, /shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\]/, 'only its hairline');
  assert.doesNotMatch(live, /data-bot-track-bar=/);

  const stopped = draw(track({ work: at('stopped', { reason: 'build_failed' }), step: 'build', busy: false, cause: 'build_failed' }));
  assert.match(stopped, /data-bot-live="stopped"/);
  assert.match(stopped, new RegExp(`data-bot-live-facts="">${t('bot.track.line.stopped.build_failed').replace(/'/g, '&#x27;').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`),
    'and says what stopped it');
});

test('the card stands under the reply in place of the request\'s plain card, which stays until a track is read', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /const objects = message\.objects\.filter\(\(object\) => !\(head && isHeadCard\(head, object\)\) && !isLiveCardObject\(liveWork, object\)\);/);
  assert.match(row, /\{liveWork \? <BotLiveCard work=\{liveWork\} objects=\{message\.objects\} \/> : null\}/);
  const { BotLiveCard } = loadTsx(LIVE);
  const carried = { type: 'issue', appSlug: 'plant-pal', issueNumber: 12, available: true, title: 'Dark mode', subtitle: 'Plant Pal' };
  const html = renderToHtml(createElement(BotLiveCard, { work: { appSlug: 'plant-pal', issueNumber: 12 }, objects: [carried] }));
  assert.match(html, /messages-object-list/, 'before the first read: the plain card');
  assert.doesNotMatch(html, /data-bot-live=/);
});

test('a request a live card follows that is not the viewer\'s own is read with theirs', () => {
  assert.deepEqual(aiWork.parseAlso('plant-pal:12,bad,x:0,plant-pal:12,notes-1a2b3c:4'),
    [{ slug: 'plant-pal', issueNumber: 12 }, { slug: 'notes-1a2b3c', issueNumber: 4 }]);
  assert.equal(aiWork.parseAlso(Array.from({ length: 20 }, (_, i) => `p:${i + 1}`).join(',')).length, 10, 'ten at most');
  assert.deepEqual(aiWork.parseAlso(''), []);
  const route = read('src/routes/ai-work.js');
  assert.match(route, /aiWork\.tracksFor\(pool, \{ user: req\.user, also: typeof req\.query\.also === 'string' \? req\.query\.also : '' \}\)/);
  const work = read('frontend/src/features/messages/bot-work.tsx');
  assert.match(work, /api\.getHomeroomBotWork\(\{ fresh, also: \[\.\.\.watched\.keys\(\)\] \}\)/);
  assert.match(read(LIVE), /useEffect\(\(\) => watchTrack\(work\.appSlug, work\.issueNumber\), \[work\.appSlug, work\.issueNumber\]\);/);
  // Access is the viewer's own: the extra rows go through the same view check.
  const svc = read('src/services/ai-work.js');
  assert.match(svc, /const extra = await alsoRows\(pool, also, rows\);\n  const watchedKeys = new Set\(extra\.map\(\(r\) => `\$\{r\.appId\}#\$\{r\.issueNumber\}`\)\);\n  rows\.push\(\.\.\.extra\);/);
  assert.match(svc, /if \(!\(await appAccess\.checkAppAccess\(pool, app, user, 'view'\)\)\) continue;/);
  // Kept apart from the viewer's own, so nothing that lists theirs lists these.
  assert.match(svc, /return \{ tracks: tracks\.filter\(\(t\) => !isWatched\(t\)\), watched: tracks\.filter\(isWatched\) \};/);
  const api = loadTsx(API);
  const read1 = api.normalizeBotWork({ tracks: [], watched: [track({ appSlug: 'notes', appName: 'Notes', issueNumber: 4 })] });
  assert.equal(read1.tracks.length, 0);
  assert.equal(read1.watched.length, 1);
  assert.equal('watched' in api.normalizeBotWork({ tracks: [] }), false);
  const { tracksByKey } = loadTsx('frontend/src/features/messages/bot-track.tsx');
  assert.ok(tracksByKey(read1).get('notes|4'), 'a live card finds it');
});

test('with the card under it, the chat no longer offers to say when it is ready', () => {
  const lines = require('../src/services/homeroom-bot-thread-tools/follow-up').promptLines({ user: { id: 3 }, deps: {} }).join(' ');
  assert.doesNotMatch(lines, /offer to tell them here when it is ready to vote/);
  assert.match(lines, /never offer to tell them when\s+it is ready/);
});

// ── 2. A settled card has no fill ────────────────────────────────────────

test('a settled card of the bot\'s keeps only its hairline', () => {
  for (const [file, rule] of [
    ['frontend/src/features/messages/bot-track.tsx', /\$\{ended \? 'shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\]' : 'bg-\[color:var\(--messages-surface\)\]'\}/],
    ['frontend/src/features/messages/bot-activity.tsx', /\$\{card\?\.state === 'done' \? 'shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\]' : 'bg-\[color:var\(--messages-surface\)\]'\}/],
    ['frontend/src/features/messages/bot-cards/confirm.tsx', /\$\{state === 'pending' \? 'bg-\[color:var\(--messages-surface\)\]' : 'shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\]'\}/],
  ]) assert.match(read(file), rule, file);
});

// ── 3. One card per action ───────────────────────────────────────────────

test('what came of a tapped offer is said on its card, as its record', async () => {
  assert.equal(mayor.outcomeWords('Done. I opened a vote on closing request #6.'), 'I opened a vote on closing request #6.');
  assert.equal(mayor.DECLINED_LINES.file_request, 'Not filed.');
  assert.equal(mayor.DECLINED_LINES.post_reply, 'Kept here. Nothing was posted.');
  for (const words of Object.values(mayor.DECLINED_LINES)) assert.doesNotMatch(words, /—/);
  const patched = [];
  const dm = { async setQuestionState(_pool, id, patch, opts) { patched.push({ id, patch, opts }); } };
  const out = await mayor.settleOnCard({}, dm, {
    action: { id: 5, message_id: 900, conversation_id: 41 }, user: { id: 7 },
    content: 'Filed as request #12.', extra: { metadata: { kind: 'filed', issueNumber: 12 } },
  });
  assert.deepEqual(out, { messageId: 900, inPlace: true, outcome: { text: 'Filed as request #12.', state: 'done', kind: 'filed', issueNumber: 12 } });
  assert.deepEqual(patched, [{ id: 900, patch: { outcome: out.outcome }, opts: { conversationId: 41, userId: 7 } }]);
  const failed = await mayor.settleOnCard({}, dm, { action: { id: 5, message_id: 901 }, user: { id: 7 }, content: 'I couldn\'t post it just now.', extra: { failed: true } });
  assert.equal(failed.outcome.state, 'failed');
  // A card that cannot be written never fails the act.
  const broken = { async setQuestionState() { throw new Error('down'); } };
  assert.equal((await mayor.settleOnCard({}, broken, { action: { id: 5, message_id: 902 }, user: { id: 7 }, content: 'x' })).inPlace, true);
});

test('settleOffer answers a tap on its card, and typed words with words', () => {
  const src = read('src/services/homeroom-bot-mayor.js');
  const settle = src.slice(src.indexOf('async function settleOffer('), src.indexOf('// 18 Nov 2026: what a tapped no leaves'));
  assert.match(settle, /const inPlace = tapped && !!action\.message_id;\n  const ack = inPlace\n    \? \(content, extra = \{\}\) => settleOnCard\(pool, dm, \{ action, user, content, extra \}\)\n    : sendAck;/);
  assert.match(settle, /if \(inPlace\) await settleOnCard\(pool, dm, \{ action, user, content: DECLINED_LINES\[action\.kind\] \|\| DECLINED_LINES\.file_request, extra: \{ declined: true \} \}\);/);
  assert.match(settle, /const filedLine = `Filed as request #\$\{filed\.issueNumber\}\.`;/);
  // A second tap, or one already decided, is still answered with words.
  assert.match(settle, /return sendAck\(\.\.\.await alreadyFiled\(pool, action\)\);/);
  // A design posted from its card says so on the card, and no notice follows it.
  assert.match(src, /notice: !ack\.inPlace,/);
  const designs = read('src/services/design-threads.js');
  assert.match(designs, /if \(notice\) \{\n      await dm\.sendDm\(pool, \{/);
  assert.match(designs, /\.\.\.\(notice \? \{\} : \{ said: postedLine \}\),/);
});

test('the card draws what came of it in place of the "You chose" line, with no fill', () => {
  const api = loadTsx(API);
  assert.deepEqual(api.normalizeBotOutcome({ text: 'Filed as request #12.', state: 'done', kind: 'filed', issueNumber: 12 }),
    { text: 'Filed as request #12.', state: 'done', kind: 'filed', issueNumber: 12 });
  assert.equal(api.normalizeBotOutcome({ text: '', state: 'done' }), null);
  assert.equal(api.normalizeBotOutcome({ text: 'x', state: 'maybe' }), null);
  const q = loadTsx(QUESTION);
  const done = renderToHtml(createElement(q.OfferOutcome, { outcome: { text: 'Filed as request **#12**.', state: 'done', kind: 'filed' } }));
  assert.match(done, /data-bot-outcome="done"/);
  assert.match(done, /data-bot-outcome-kind="filed"/);
  assert.match(done, /<p class="m-0">Filed as request #12\.<\/p>/, 'plain words');
  assert.match(done, /text-zinc-500/);
  assert.doesNotMatch(done, /\bbg-/, 'a settled state gets no fill');
  const failed = renderToHtml(createElement(q.OfferOutcome, { outcome: { text: 'I couldn\'t post it.', state: 'failed' } }));
  assert.match(failed, /text-red-700/);
  const next = renderToHtml(createElement(q.OfferOutcome, { outcome: { text: 'Filed it as request #4.', state: 'done', filedNext: { say: 'person' } } }));
  assert.match(next, /data-bot-outcome-next="person"/);

  const bot = { id: 2, username: 'homeroom_bot', bot: true };
  const offer = (extra) => ({
    id: 900, conversationId: 41, sender: bot, content: 'Here is the request.', createdAt: '2026-11-18T10:00:00.000Z',
    attachments: [], objects: [], reactions: [],
    metadata: { homeroomBot: {
      kind: 'confirm', appSlug: 'plant-pal', appName: 'Plant Pal', question: 'File this?', status: 'answered', answer: 'File it', chosen: 'yes',
      actions: [{ id: 'yes', label: 'File it', style: 'primary', type: 'server' }, { id: 'no', label: 'Not now', style: 'secondary', type: 'server' }],
      ...extra,
    } },
  });
  const settled = renderToHtml(createElement(q.BotQuestion, { message: offer({ outcome: { text: 'Filed as request #12.', state: 'done' } }), conversationId: 41 }));
  assert.match(settled, /data-bot-outcome="done"/);
  assert.doesNotMatch(settled, new RegExp(t('bot.actions.youChose', { choice: 'File it' })), 'no "You chose" line beside it');
  const before = renderToHtml(createElement(q.BotQuestion, { message: offer({}), conversationId: 41 }));
  assert.match(before, new RegExp(t('bot.actions.youChose', { choice: 'File it' })), 'a card decided before this keeps its line');
});

test('a draft folds away under a one-line gist, and opens whole', () => {
  const head = loadTsx(HEAD);
  const details = [
    'Show a podium for the top three players, with their scores under their names. Everyone else stays in the table below.',
    '',
    'Done when: the podium shows on a phone and a desktop, and ties share a step.',
    '',
    'Where: the Leaderboard screen. '.repeat(6),
  ].join('\n');
  assert.equal(head.draftGist(details), 'Show a podium for the top three players, with their scores under their names.');
  assert.equal(head.draftGist('**Bold** words only'), 'Bold words only');
  const long = 'word '.repeat(60);
  assert.ok(head.draftGist(long).endsWith('…') && head.draftGist(long).length <= 141);
  assert.equal(head.draftGist(''), '');
  const meta = { kind: 'confirm', appSlug: 'plant-pal', appName: 'Plant Pal', status: 'open', actionId: 5 };
  const content = `Here is the request I'd file on Plant Pal.\n\n**Plant Pal** · new request: Podium\n\n${details}`;
  const parsed = head.botHead(content, meta);
  assert.equal(parsed.offer, true);
  assert.equal(head.foldsDraft(parsed), true);
  assert.equal(head.foldsDraft({ ...parsed, rest: 'Short.' }), false, 'a short draft is shown as it is');
  assert.equal(head.foldsDraft(head.botHead('**Plant Pal** · request #12: Podium\n\nIt is live.', { kind: 'filed', appName: 'Plant Pal', appSlug: 'plant-pal', issueNumber: 12 }) || { offer: false, rest: details }), false,
    'only an offer\'s words fold');
  const html = renderToHtml(createElement(head.BotHeadWords, { head: parsed, objects: [] }));
  assert.match(html, /data-bot-draft-fold="closed"/);
  assert.match(html, /data-bot-draft-gist="">Show a podium for the top three players, with their scores under their names\.</);
  assert.match(html, new RegExp(`aria-expanded="false" data-bot-draft-toggle="">${t('bot.draft.show')}<`));
  assert.doesNotMatch(html, /Done when: the podium/, 'the rest is folded away');
  assert.equal(t('bot.draft.show'), 'Show the full draft');
  assert.equal(t('bot.draft.hide'), 'Show less');
});

test('the chat and the voice lead with the answer and never restate a card', () => {
  const chat = mayor.systemPrompt({ username: 'evan' });
  const flat = (s) => s.replace(/\n\s*/g, ' ');
  assert.match(flat(chat), /Lead with the answer itself, in the first sentence\. No preamble and no hedging/);
  assert.match(flat(chat), /never open with "Worth knowing"/);
  assert.match(flat(chat), /that the vote stays open meanwhile/);
  assert.match(flat(chat), /Never restate what a card under your reply already shows: a request's card, a draft, a live card for work you started\./);
  const voiceSrc = read('src/services/homeroom-bot-voice.js');
  assert.match(voiceSrc, /'- Lead with the answer itself, in the first sentence\. No preamble and no hedging: never explain how you know',/);
  assert.match(voiceSrc, /next: 'Say in one short sentence that it is queued\. Never say it is done\. Do not explain the queue or the vote\./);
  assert.doesNotMatch(voiceSrc, /You may also offer to tell them here when it is ready to vote \(tell_me_when\), if they would like that\./);
});
