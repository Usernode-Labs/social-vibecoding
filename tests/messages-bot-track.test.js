'use strict';

// One track per request (16 Oct 2026), drawn the same everywhere
// (frontend/src/features/messages/bot-track.tsx): the words for each state
// and why, the five-step bar and its loop ("Build, try 2"), the card a
// request's thread and its page draw, the activity drawer's groups read off
// the tracks (Needs you is only what waits on the person; a limit's hold is
// On hold, never finished), and the bot's slots page under a project's
// Workshop (frontend/src/features/dev-board/workshop/bot-slots.tsx).
//
// The server decides the state (services/homeroom-bot-track.js, pinned in
// tests/homeroom-bot-track.test.js); these pin how it is said and drawn.
//
// Run with: node --test tests/messages-bot-track.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TRACK = 'frontend/src/features/messages/bot-track.tsx';
const STRIP = 'frontend/src/features/messages/bot-strip.tsx';
const API = 'frontend/src/features/messages/api.ts';
const SLOTS = 'frontend/src/features/dev-board/workshop/bot-slots.tsx';

globalThis.window = {
  App: { user: { id: 7, username: 'ada' } },
  location: { search: '', hash: '#messages/42' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout, setInterval, clearInterval,
};

const NOW = new Date('2026-10-16T12:00:00Z');
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60000).toISOString();
const links = (extra = {}) => ({ request: '#app/plant-pal/dev/i/12', proposal: null, project: '#app/plant-pal', ...extra });
const track = (extra = {}) => ({
  key: `plant-pal#${extra.issueNumber || 12}`, appSlug: 'plant-pal', appName: 'Plant Pal', iconUrl: null, iconEmoji: null,
  issueNumber: 12, title: 'Dark mode', firstVersion: false, state: 'building', step: 'build', why: null, waitingOn: null,
  busy: false, try: 1, tryStartedAt: null, tryStarts: [], since: ago(30), rootId: null, askId: null, proposalId: null,
  sessionId: null, links: links(), ...extra,
});
const t = (id, values) => message(`messages:${id}`, values);

// ── 1. The words ──────────────────────────────────────────────────────────

test('each state has its word, and each why its line; a loop says which try', () => {
  const { trackStateWord, trackLine, trackEyebrow, trackPlace, trackEnding } = loadTsx(TRACK);
  const fixing = track({ state: 'building', why: 'fixing', try: 2 });
  assert.equal(trackStateWord(fixing), 'Building');
  assert.equal(trackLine(fixing), t('bot.track.line.building.fixing'));
  assert.equal(trackEyebrow(fixing), `Building · ${t('bot.track.try', { number: '2' })}`, 'the try, once it has looped');
  assert.equal(trackEyebrow(track({ state: 'live', step: 'live', try: 2 })), t('bot.track.state.live'), 'an ended track says only how it ended');
  assert.equal(trackLine(track({ state: 'vote', step: 'vote' })), t('bot.track.line.vote.default'));
  assert.equal(trackLine(track({ state: 'waiting', step: 'plan', why: 'no_such_why' })), t('bot.track.line.waiting.question'), 'an unknown why falls back to the state\'s own line');

  const held = track({ state: 'held', step: null, why: 'slots', held: { limit: 'slots', position: 3, until: null } });
  assert.equal(trackStateWord(held), 'On hold', 'the same word as the drawer\'s On hold group');
  assert.equal(trackLine(held), t('bot.track.line.held.slots'));
  assert.equal(trackPlace(held), t('bot.track.held.ahead_other', { count: 2 }));
  assert.equal(trackPlace({ ...held, held: { ...held.held, position: 1 } }), t('bot.track.held.next'));
  // 16 Oct 2026: one a person has taken since is theirs, not a wait.
  const taken = track({ state: 'held', step: null, why: 'taken', held: { limit: 'taken', position: null, until: null, by: 'maya' } });
  assert.equal(trackLine(taken), t('bot.track.line.held.taken', { username: 'maya' }));
  assert.equal(trackLine({ ...taken, held: { ...taken.held, by: null } }), t('bot.track.line.held.takenNoName'));
  assert.equal(trackPlace(taken), null, 'no place in a line it is not in');

  const elsewhere = track({ state: 'done_elsewhere', step: 'live', doneBy: { username: 'ben', prNumber: 4822 } });
  assert.equal(trackLine(elsewhere), t('bot.track.line.done_elsewhere.by', { username: 'ben', number: '4822' }), 'who shipped it, and where');
  assert.equal(trackLine({ ...elsewhere, doneBy: { username: 'ben', prNumber: null } }), t('bot.track.line.done_elsewhere.byNoPr', { username: 'ben' }));

  assert.deepEqual(
    ['live', 'going_live', 'done_elsewhere', 'closed', 'building'].map((state) => trackEnding({ state, why: null })),
    ['live', 'going_live', 'done_elsewhere', 'closed', null],
  );
  assert.equal(trackEnding({ state: 'stopped', why: 'needs_person' }), 'person');
  assert.equal(trackEnding({ state: 'stopped', why: 'withdrawn' }), 'stopped', 'a quiet stop');
  assert.equal(trackEnding({ state: 'stopped', why: 'time' }), 'build_failed', 'a build that went wrong');
});

test('every word the module asks for is in the catalog', () => {
  const src = read(TRACK);
  const ids = [...src.matchAll(/'(messages:bot\.track\.[a-zA-Z_.]+)'/g)].map((m) => m[1]);
  assert.ok(ids.length > 60, 'the states, steps and lines');
  const catalog = JSON.parse(read('frontend/locales/en/messages.json'));
  for (const id of new Set(ids)) {
    const key = id.slice('messages:'.length);
    assert.ok(catalog[key] || catalog[`${key}_one`], `${id} is in the catalog`);
  }
});

// ── 2. The bar and the card ───────────────────────────────────────────────

test('the bar lights the step it is on; a loop back to building names its try under Build', () => {
  const { stepLooks, TrackBar, TrackBadge } = loadTsx(TRACK);
  assert.deepEqual(stepLooks({ state: 'building', step: 'build' }), ['done', 'now', 'next', 'next', 'next']);
  assert.deepEqual(stepLooks({ state: 'vote', step: 'vote' }), ['done', 'done', 'done', 'now', 'next']);
  assert.deepEqual(stepLooks({ state: 'live', step: 'live' }), ['live', 'live', 'live', 'live', 'live'], 'live: every step green');
  assert.deepEqual(stepLooks({ state: 'done_elsewhere', step: null }), ['live', 'live', 'live', 'live', 'live'], 'shipped another way: green too');
  assert.deepEqual(stepLooks({ state: 'queued', step: null }), ['next', 'next', 'next', 'next', 'next'], 'nothing lit before it starts');

  const html = renderToHtml(createElement(TrackBar, { track: track({ try: 2, why: 'fixing' }), labels: true }));
  assert.match(html, /role="img" aria-label="Building: step 2 of 5, Build"/, 'said in words for a screen reader');
  assert.match(html, new RegExp(`>${t('bot.track.step.buildTry', { number: '2' })}</span>`), 'Build, try 2');
  assert.equal((html.match(/data-bot-track-step=/g) || []).length, 5);
  assert.match(html, /data-bot-track-step="build" data-state="now"/);

  const { trackLook } = loadTsx(TRACK);
  assert.equal(trackLook({ state: 'checks', why: 'failed' }).tone, 'trouble', 'failed checks are a warning, never a spinner');
  assert.equal(trackLook({ state: 'checks', why: null }).tone, 'working');
  const badge = renderToHtml(createElement(TrackBadge, { track: track({ state: 'waiting', step: 'plan', why: 'question' }) }));
  assert.match(badge, /data-bot-track-badge="waiting"/);
  assert.match(badge, /bg-amber-100/, 'what waits on the person wears the need colour');
  assert.match(badge, new RegExp(`<span class="sr-only">${t('bot.track.state.waiting')}: ${t('bot.track.line.waiting.question')}</span>`));
});

test('the card: its status word and try, the title, where it is and why, the bar and its links', () => {
  const { TrackCard, trackLinks } = loadTsx(TRACK);
  const fixing = track({
    try: 2, why: 'fixing', tryStartedAt: ago(15), links: links({ proposal: '#app/plant-pal/dev/s/88' }),
  });
  const html = renderToHtml(createElement(TrackCard, { track: fixing, title: 'Dark mode', links: trackLinks(fixing), now: NOW }));
  assert.match(html, /role="group" aria-label="Where Dark mode is" data-bot-track="building" data-bot-track-why="fixing" data-bot-activity="working" data-bot-activity-request="plant-pal#12"/);
  assert.match(html, new RegExp(`data-bot-activity-eyebrow="">Building · ${t('bot.track.try', { number: '2' })}</div>`));
  assert.match(html, new RegExp(`data-bot-activity-status="" role="status">${t('bot.track.line.building.fixing')} · ${t('bot.track.soFar', { duration: '15m' }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</p>`), 'and this try\'s clock');
  assert.match(html, /href="#app\/plant-pal\/dev\/s\/88"/, 'its change');
  assert.match(html, /href="#app\/plant-pal\/dev\/i\/12"/, 'its request');

  const held = track({ state: 'held', step: null, why: 'slots', held: { limit: 'slots', position: 2, until: null } });
  const heldHtml = renderToHtml(createElement(TrackCard, { track: held, title: 'Dark mode', links: trackLinks(held, { request: false }), now: NOW }));
  assert.match(heldHtml, /data-bot-track-slots="plant-pal"/, 'held for a slot: a way to the bot\'s slots');
  assert.match(heldHtml, new RegExp(`>${t('bot.track.link.slots').replace(/'/g, '&#x27;')}</a>`));
  assert.doesNotMatch(heldHtml, /href="#app\/plant-pal\/dev\/i\/12"/, 'on the request\'s own page, no link to itself');
  assert.match(heldHtml, new RegExp(t('bot.track.held.ahead_one', { count: 1 })));
});

test('a thread\'s card is the track once the tray has one for the request, and a try starts a divider', () => {
  const src = read(TRACK);
  assert.match(src, /if \(!meta \|\| !track \|\| \(track\.rootId && track\.rootId !== message\.id\)\) return <BotActivityCard message=\{message\} words=\{words\} \/>;/, 'else the activity card as it was');
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /<BotCardOrTrack /);
  const screen = read('frontend/src/features/messages/index.tsx');
  assert.match(screen, /useTrackOf\(/, 'the thread reads the request\'s track for its try dividers');
  assert.match(screen, /bot\.track\.tryDivider/);
  const head = read('frontend/src/features/dev-board/topic/request-head.tsx');
  assert.match(head, /<div className="dev-request-track" data-request-track=\{track\.state\}>\s*<TrackCard track=\{track\} title=\{r\.title\} links=\{trackLinks\(track, \{ request: false \}\)\} pictures \/>/, 'the request\'s page draws the same card');
});

// ── 3. The activity drawer, from the tracks ──────────────────────────────

test('the drawer groups the tracks: what waits on you, a vote, work under way, a hold, and what ended today', () => {
  const { stripGroups, summaryParts } = loadTsx(STRIP);
  const tracks = [
    track({ issueNumber: 1, state: 'waiting', step: 'plan', why: 'question', askId: 40 }),
    track({ issueNumber: 2, state: 'vote', step: 'vote' }),
    track({ issueNumber: 3, state: 'building', step: 'build', why: 'fixing', try: 2 }),
    track({ issueNumber: 4, state: 'held', step: null, why: 'slots', held: { limit: 'slots', position: 1, until: null } }),
    track({ issueNumber: 5, state: 'live', step: 'live', since: ago(60) }),
    track({ issueNumber: 6, state: 'live', step: 'live', since: ago(60 * 30) }),
    track({ issueNumber: 7, state: 'done_elsewhere', step: null, since: ago(90), doneBy: { username: 'ben', prNumber: 4822 } }),
    track({ issueNumber: 3, state: 'building', step: 'build' }),
  ].map((tr) => ({ ...tr, key: `plant-pal#${tr.issueNumber}` }));
  const model = stripGroups({ now: [], needsYou: [], history: [], tracks }, NOW);
  const numbers = (rows) => rows.map((row) => row.job.issueNumber);
  assert.deepEqual(numbers(model.needs), [1], 'only what waits on the person');
  assert.equal(model.needs[0].focusId, 40, 'opened at what waits');
  assert.equal(model.needs[0].action, 'messages:bot.strip.action.answer');
  assert.deepEqual(numbers(model.ready), [2], 'a change up for a vote is ready to try');
  assert.deepEqual(numbers(model.progress), [3], 'each request once');
  assert.deepEqual(numbers(model.held), [4], 'a hold is On hold, never finished');
  assert.equal(model.held[0].state, t('bot.track.held.next'), 'under On hold, its place in line');
  const { trackShort } = loadTsx(TRACK);
  const second = track({ state: 'held', step: null, why: 'slots', held: { limit: 'slots', position: 3, until: null } });
  assert.equal(trackShort(second), t('bot.track.held.aheadSlot_other', { count: 2 }), 'one short line that still says what it waits for');
  assert.equal(trackShort(track({ state: 'vote', step: 'vote' })), t('bot.track.line.vote.default'));
  assert.deepEqual(numbers(model.done), [5, 7], 'ended in the last day, done another way among them');
  assert.deepEqual(summaryParts(model).map((part) => part.text),
    ['1 needs you', '1 ready to try', '1 in progress', '1 on hold', '2 finished today']);
});

test('the drawer\'s On hold group and its way to the bot\'s slots', () => {
  const src = read(STRIP);
  assert.match(src, /t\('messages:bot\.strip\.group\.held'\)/);
  assert.match(src, /openSlots\(/, 'the slots page opens as a place under the Workshop');
  assert.match(src, /done_elsewhere: \{ key: 'messages:bot\.final\.doneElsewhere', tone: 'good', icon: CheckIcon \}/);
  assert.equal(message('messages:bot.strip.group.held'), 'On hold');
  assert.equal(message('messages:bot.strip.group.done'), 'Finished today');
});

// ── 4. The tracks as the server sends them ───────────────────────────────

test('a track is read field by field; one in a state the client does not know is drawn nowhere', () => {
  const { normalizeBotTrack, normalizeBotSlots } = loadTsx(API);
  const row = {
    key: 'plant-pal#12', appSlug: 'plant-pal', appName: 'Plant Pal', issueNumber: 12, title: 'Dark mode',
    state: 'held', step: 'nonsense', why: 'slots', try: 3, held: { limit: 'slots', position: 2 },
    links: { request: '#app/plant-pal/dev/i/12' }, rootId: 55, tryStarts: [ago(90), ago(30)],
  };
  const got = normalizeBotTrack(row);
  assert.equal(got.state, 'held');
  assert.equal(got.step, null, 'an unknown step lights nothing');
  assert.equal(got.try, 3);
  assert.deepEqual(got.held, { limit: 'slots', position: 2, until: null });
  assert.equal(got.rootId, 55);
  assert.equal(got.tryStarts.length, 2);
  assert.equal(normalizeBotTrack({ ...row, state: 'exploded' }), null);
  assert.equal(normalizeBotTrack({ ...row, why: 'Not A Code!' }).why, null);

  const view = normalizeBotSlots({
    slots: {
      app: { slug: 'plant-pal', name: 'Plant Pal' }, botOn: true, acts: true, cap: 5, buildsAtOnce: 2, reading: 1,
      slots: [{ kind: 'proposal', issueNumber: 8, title: 'Sort by name', track: { ...row, issueNumber: 8, state: 'vote', step: 'vote' } }],
      waiting: [{ issueNumber: 12, title: 'Dark mode', askedBy: 'lee', excerpt: 'Make it darker at night.', position: 1, track: row }],
      taken: [{ issueNumber: 13, title: 'Frost alerts', by: 'maya', track: { ...row, issueNumber: 13, why: 'taken', held: { limit: 'taken', by: 'maya' } } }],
      onHold: [], week: { limited: true, usedShare: 1.4, resetsAt: '2026-10-19T00:00:00Z' },
    },
  });
  assert.equal(view.app.slug, 'plant-pal');
  assert.equal(view.slots[0].track.state, 'vote');
  assert.equal(view.waiting[0].position, 1);
  assert.deepEqual([view.waiting[0].askedBy, view.waiting[0].excerpt], ['lee', 'Make it darker at night.']);
  assert.deepEqual([view.taken[0].by, view.taken[0].track.held], ['maya', { limit: 'taken', position: null, until: null, by: 'maya' }]);
  assert.deepEqual(normalizeBotSlots({ slots: { app: { slug: 'x' } } }).taken, [], 'an older server: nobody has taken anything');
  assert.equal(view.week.usedShare, 1, 'a share is clamped to the whole');
  assert.equal(normalizeBotSlots({ slots: {} }), null, 'no project, no view');
});

// ── 5. The bot's slots page ───────────────────────────────────────────────

test('the slots page: what holds each slot, what waits for one in order, and the limits', () => {
  const { BotSlotsBody } = loadTsx(SLOTS);
  const vote = track({ issueNumber: 8, title: 'Sort by name', state: 'vote', step: 'vote', links: links({ proposal: '#app/plant-pal/dev/s/91' }) });
  const building = track({ issueNumber: 9, title: 'Water log', state: 'building', step: 'build' });
  const held = track({ issueNumber: 12, state: 'held', step: null, why: 'slots', held: { limit: 'slots', position: 1, until: null } });
  const view = {
    app: { slug: 'plant-pal', name: 'Plant Pal' }, botOn: true, acts: true, paused: false, cap: 5, buildsAtOnce: 2, reading: 3,
    slots: [
      { kind: 'proposal', issueNumber: 8, title: 'Sort by name', track: vote },
      { kind: 'build', issueNumber: 9, title: 'Water log', track: building },
    ],
    waiting: [{ issueNumber: 12, title: 'Dark mode', askedBy: 'lee', excerpt: 'Make it darker at night.', position: 1, since: ago(200), track: held }],
    taken: [],
    onHold: [],
    week: { limited: true, usedShare: 0.42, usedUp: false, resetsAt: null },
  };
  const html = renderToHtml(createElement(BotSlotsBody, { view }));
  assert.match(html, /data-ws-bot-slots-used="2\/5">2 of 5 in use</);
  assert.equal((html.match(/data-ws-bot-slot="\d+"/g) || []).length, 3, 'the two holding a slot, and the one waiting');
  assert.match(html, /href="#app\/plant-pal\/dev\/s\/91"[^>]*data-ws-bot-slot="8" data-ws-bot-slot-state="vote"|data-ws-bot-slot="8" data-ws-bot-slot-state="vote"[^>]*/, 'a change up for a vote opens the change');
  assert.match(html, /data-ws-bot-waiting=""/);
  assert.match(html, new RegExp(message('project:botSlots.waiting.title')));
  assert.doesNotMatch(html, /data-ws-bot-on-hold=""/, 'no hold, no section');
  assert.match(html, /data-ws-bot-week=""[\s\S]*42% used/);
  assert.match(html, />Up to 2 builds at once on this project</);
  assert.match(html, />3 requests waiting to be read</);
  assert.doesNotMatch(html, /data-ws-bot-slots-note/, 'acting: no note');

  // Its badge names the state; the row says where it is, and a request
  // waiting for a slot, under the heading that says so, its place in line.
  const { entryLine } = loadTsx(SLOTS);
  assert.equal(entryLine(building), t('bot.track.line.building.default'));
  assert.equal(entryLine(held), t('bot.track.held.next'));
  assert.doesNotMatch(html, />Building · /, 'never the state word twice');

  // 16 Oct 2026: a row says what its request is about, not only its
  // number: a line of what it asks, who asked, and how long it has waited.
  assert.match(html, /data-ws-bot-slot-excerpt="">Make it darker at night\.</);
  const { entryMeta } = loadTsx(SLOTS);
  const meta = entryMeta(view.waiting[0], 'waiting', new Date(NOW.getTime()));
  assert.deepEqual(meta, [
    message('project:botSlots.meta.asked', { username: 'lee' }),
    message('project:botSlots.meta.waiting', { span: message('messages:bot.span.hoursMinutes', { hours: 3, minutes: 20 }) }),
  ]);
  assert.equal(entryMeta({ ...view.waiting[0], askedBy: null }, 'slots', NOW).length, 0, 'a slot\'s row has its clock on its bar');

  // A row opens its item in the Workshop's panel: the request, or its
  // change once it has one, and the open row is marked.
  assert.match(html, /data-ws-bot-slot="12"[^>]*data-ws-open="issue:12"/);
  assert.match(html, /href="#app\/plant-pal\/dev\/i\/12"/, 'the request\'s own address for a plain open');
  const { entryRef, hrefOf } = loadTsx(SLOTS);
  assert.deepEqual(entryRef({ issueNumber: 8, track: { ...vote, proposalId: 91 } }), { kind: 'proposal', id: 91 });
  assert.equal(entryRef({ issueNumber: 8, track: vote }), null, 'a change the panel cannot name opens as a page');
  assert.equal(hrefOf({ issueNumber: 900009, track: { ...held, links: null } }, 'staging-demo'), '#app/staging-demo/dev/issues/900009', 'the demo\'s rows open their mock request');
  const openHtml = renderToHtml(createElement(BotSlotsBody, { view, openKey: 'issue:12', onOpen: () => {} }));
  assert.match(openHtml, /aria-current="true"[^>]*data-ws-open="issue:12"|data-ws-open="issue:12"[^>]*aria-current="true"/);

  // One a person has taken since is listed apart, as theirs.
  const taken = track({ issueNumber: 14, state: 'held', step: null, why: 'taken', held: { limit: 'taken', position: null, until: null, by: 'maya' } });
  const takenHtml = renderToHtml(createElement(BotSlotsBody, {
    view: { ...view, taken: [{ issueNumber: 14, title: 'Frost alerts', by: 'maya', since: ago(60 * 26), track: taken }] },
  }));
  assert.match(takenHtml, /data-ws-bot-taken=""/);
  assert.match(takenHtml, new RegExp(message('project:botSlots.taken.title')));
  assert.match(takenHtml, new RegExp(t('bot.track.line.held.taken', { username: 'maya' })));

  const off = renderToHtml(createElement(BotSlotsBody, { view: { ...view, acts: false, slots: [], waiting: [] } }));
  assert.match(off, new RegExp(`data-ws-bot-slots-note="">${message('project:botSlots.notHere').replace(/'/g, '&#x27;')}</p>`));
  assert.match(off, new RegExp(message('project:botSlots.slots.empty')));
});

test('the slots page is a page under the Workshop: its address, its way back, its door', () => {
  const places = loadTsx('frontend/src/features/dev-board/workshop/places.ts');
  assert.equal(places.litPlace('bot'), 'workshop', 'the Workshop stays lit while it is up');
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(ws, /return tab === 'all' \|\| tab === 'bot' \? 'workshop' : 'status';/, 'Back goes to the Workshop');
  assert.match(ws, /\{tab === 'bot' && slug \? \(\s*<BotSlotsPage\s+slug=\{slug\}\s+backLabel=\{t\('project:page\.backToWorkshop'\)\}\s+onBack=\{\(\) => openTab\(pageParent\(tab\)\)\}\s+openKey=\{sideKey\}\s+onOpen=\{openItem\}\s+\/>/);
  // Its rows open beside it, as the Workshop's own do.
  assert.match(ws, /const sideOpen = !!sideItem && \(tab === 'workshop' \|\| tab === 'all' \|\| tab === 'bot'\);/);
  assert.match(ws, /\{sideOpen && sideItem \? <TopicSidePanel item=\{sideItem\} onClose=\{closeSide\} \/> : null\}/);
  assert.match(ws, /data-ws-side-open=\{sideOpen \? '' : undefined\}/);
  assert.match(ws, /\{slug \? <BotSlotsDoor slug=\{slug\} onOpen=\{\(\) => openTab\('bot'\)\} \/> : null\}/, 'its door in the overview card');
  const src = read(SLOTS);
  assert.match(src, /if \(!view \|\| \(!view\.acts && !view\.slots\.length\)\) return null;/, 'no door where the bot neither builds nor holds anything');
  assert.match(src, /useEffect\(\(\) => \{\s*if \(!slug\) return undefined;/, 'it reads in an effect, never on the first render');
  assert.equal(message('project:page.title.bot'), 'Homeroom bot\'s slots');
});
