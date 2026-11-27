// THE WORKSHOP'S FRONT PAGE (24 Nov 2026; the desktop polish's item 14):
// frontend/src/features/dev-board/workshop/front-page.tsx. One column of
// three parts and a row for admins: the hero (its one question, a box to
// Homeroom bot, four starts and Your work), the path a change travels (four
// stops, each a door to the place listing what it counts) and Lately with
// Live by week.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const FRONT = 'frontend/src/features/dev-board/workshop/front-page.tsx';
const SRC = read(FRONT);
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const CSS = read('public/css/app.css');
const front = loadTsx(FRONT);

const week = (over) => ({
  key: 'thisWeek', title: 'This week', startMs: Date.UTC(2026, 10, 23), endMs: Date.UTC(2026, 10, 24), live: true, line: '',
  counts: { closed: 7, partial: false }, fresh: [], seen: [], ...over,
});
const dash = (over) => ({
  open: 30, asked: 17, mine: { asked: 2, votes: 1, live: 0 }, weeksPending: false, themes: 2, votesWaiting: 6, votesWaitingRefs: [],
  shippedWeek: 7, shippedPrevWeek: 9, shippedPrevWeekToDate: 5, people: 3, unclaimed: 4, busiest: null, partial: false,
  everShipped: true, cards: null, weeks: [], openLine: '', firstWeek: null, summary: null, ...over,
});
const props = (over) => ({
  slug: 'garden', name: 'Garden club', loading: false, dash: dash(), mergedPending: false, owed: 0, viewer: true,
  selfHosted: false, filtered: false, since: false, thisWeek: week(), pastWeeks: [week({ key: 'lastWeek', title: '', live: false, counts: { closed: 9, partial: false } })],
  recentLive: [], openKey: null,
  onOpenItem: () => {}, onBoard: () => {}, onStage: () => {}, onBuilds: () => {}, onNeeds: () => {}, onWeek: () => {}, onEarlier: () => {}, onPrivate: () => {},
  ...over,
});
const render = (over) => renderToHtml(createElement(front.WorkshopFront, props(over)));

test('the page is three parts in one column, then the admins\' row: the hero, the path, Lately and Live by week', () => {
  const html = render();
  const at = (s) => html.indexOf(s);
  const order = ['data-ws-front="hero"', 'data-ws-front="path"', 'data-ws-front="lately-pair"', 'data-ws-front="lately"', 'data-ws-front="weeks"'].map(at);
  assert.ok(order.every((n) => n > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(SRC, /<Hero \{\.\.\.props\} \/>\n\s+<Path \{\.\.\.props\} \/>\n\s+<Lately \{\.\.\.props\} \/>\n\s+<PrivateRequestsDoor slug=\{props\.slug\} onOpen=\{props\.onPrivate\} \/>/);
  // The page's one large heading, a question with the project's name; no kicker over it and no sentence under it.
  assert.match(html, /<h2 class="dev-ws-front-title">What should change in Garden club\?<\/h2><form class="dev-ws-front-ask"/);
  assert.equal(message('project:workshop.front.title', { project: 'Homeroom' }), 'What should change in Homeroom?');
  assert.equal((html.match(/<h2 /g) || []).length, 4, 'the heading and three small-caps labels');
});

test('the box: a field, the mic and a round send that is off until something is typed', () => {
  const html = render();
  assert.match(html, /<input class="dev-ws-front-ask-input" type="text" dir="auto" enterKeyHint="send" maxLength="8000" placeholder="Tell Homeroom bot what to change…" aria-label="Tell Homeroom bot what should change in Garden club" value=""\/><span[^>]*data-dictation="idle"/);
  assert.match(html, /<button type="submit" class="dev-ws-front-send" data-ws-front-send="" disabled="" aria-label="Open a new chat with this"/);
  // Sending opens a new chat about the project with the words in its box (ready to send: nothing is sent for them).
  assert.match(SRC, /carryWordsToNewChat\(field\.current \? field\.current\.value : words, start\);\n\s+goBotAddress\(botNewAddress\(\{ project: slug \}\)\);/);
});

test('four starts, Edit the app live first and tinted, where New chat would offer the live start; three elsewhere', () => {
  const four = render();
  const starts = [...four.matchAll(/data-ws-front-start="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(starts, ['live', 'fix', 'add', 'ask']);
  assert.match(four, /data-ws-front-start="live" data-tone="live"><svg[^>]*aria-hidden="true"[\s\S]*?<span>Edit the app live<\/span>/);
  assert.equal((four.match(/data-tone="live"/g) || []).length, 1, 'the only tinted one');
  // A self-hosted app (Homeroom itself, to anyone but its admins, whom the page learns of after mount) has no live start.
  const three = render({ selfHosted: true });
  assert.deepEqual([...three.matchAll(/data-ws-front-start="([a-z]+)"/g)].map((m) => m[1]), ['fix', 'add', 'ask']);
  assert.match(SRC, /const live = offersLive\(slug, \{ \[slug\]: \{ selfHosted \} \}, \{ platformSlug: platformSlug\(\), isAdmin: !!who\?\.isAdmin \}\);/, 'New chat\'s own rule (#6961)');
  // Each is one of New chat's own starts, pressed there for you.
  const { NEW_THREAD_STARTS, LIVE_START } = loadTsx('frontend/src/features/messages/new-thread.tsx');
  assert.equal(front.FRONT_STARTS[0].key, LIVE_START.key);
  for (const s of front.FRONT_STARTS.slice(1)) assert.ok(NEW_THREAD_STARTS.some((one) => one.key === s.key), s.key);
  assert.deepEqual(['live', 'fix', 'add', 'ask'].map((k) => message(`project:workshop.front.start.${k}`)),
    ['Edit the app live', 'Fix an issue', 'Add a feature', 'Ask a question']);
});

test('Your work: one door with the visitor\'s threads peeking out of it; a faint card, not a door, with nothing of theirs', () => {
  const { yoursWords } = front;
  assert.equal(yoursWords({ ready: false, needs: 3, progress: 0, waiting: 0 }), null);
  assert.deepEqual(yoursWords({ ready: true, needs: 20, progress: 2, waiting: 1 }), { id: 'project:workshop.front.yours.both', values: { count: 20, progress: 2 } });
  assert.deepEqual(yoursWords({ ready: true, needs: 0, progress: 2, waiting: 1 }), { id: 'project:workshop.front.yours.progress', values: { count: 2 } });
  assert.deepEqual(yoursWords({ ready: true, needs: 0, progress: 0, waiting: 1 }), { id: 'project:workshop.front.yours.waiting', values: { count: 1 } });
  assert.equal(yoursWords({ ready: true, needs: 0, progress: 0, waiting: 0 }), null, 'nothing of theirs: no door');
  assert.equal(message('project:workshop.front.yours.both', { count: 20, progress: 2 }), '<0>20 need you</0> · 2 in progress');
  assert.equal(message('project:workshop.front.yours.needs', { count: 1 }), '<0>1 needs you</0>');
  // A guest (and the first render, before the lists are read): the faint card, its two blank cards, no chevron, no link.
  const guest = render({ viewer: false });
  const side = guest.slice(guest.indexOf('data-ws-desk=""') - 40, guest.indexOf('data-ws-front="path"'));
  assert.match(side, /data-ws-desk="" data-ws-desk-empty=""><div class="dev-ws-front-yours" data-ghost=""><span class="dev-ws-front-stack" aria-hidden="true"><span class="dev-ws-front-mini" data-ghost=""><\/span><span class="dev-ws-front-mini" data-ghost=""><\/span><\/span>/);
  assert.ok(side.includes('What you ask for shows up here.'));
  assert.ok(!/<a |dev-ws-front-chev/.test(side), 'not a door');
  // The door: the tab narrowed to the project, as Your work's row is; the small cards are decoration, the whole card one link.
  assert.match(SRC, /<a\n\s+className="dev-ws-front-yours"\n\s+href=\{projectTabAddress\(slug\)\}\n\s+data-ws-desk-open=""/);
  assert.match(SRC, /<span key=\{i\} className="dev-ws-front-mini" data-hot=\{card\.hot \? '' : undefined\}>/);
  // The desk carries the three most pressing: what owes the visitor first, then what is being worked on.
  const { deskOf, needGlyph } = loadTsx('frontend/src/features/ai/desk.ts');
  const app = { slug: 'garden', name: 'Garden' };
  const thread = (id, work, group) => ({ threadId: id, number: id, kind: 'work', title: `T${id}`, app, change: null, href: '#', group, work: { why: null, reason: null, line: null, since: null, ...work }, at: null });
  const d = deskOf('garden', [{ kind: 'proposal', id: 1, number: 40, title: 'Dark mode', app }], {
    private: [], needs: [], next: [thread(3, { stage: 'building' }, 'next'), thread(4, { stage: 'building' }, 'next'), thread(5, { stage: 'building' }, 'next')],
    waiting: [], live: [],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(d.top)), [{ glyph: 'vote', hot: true }, { glyph: 'build', hot: false }, { glyph: 'build', hot: false }]);
  assert.deepEqual(['need:proposal:1', 'need:governance:2', 'need:question:3', 'plan:9', 'fix_yours:4', 'private:7'].map(needGlyph), ['vote', 'vote', 'ask', 'plan', 'fix', 'ask']);
  // It does the first-change card's job on this page, so that card is not drawn here.
  assert.doesNotMatch(SRC, /FirstChangeCard|useFirstChange/);
});

test('the path: four stops in order, each a door, a zero saying its word alone', () => {
  const html = render();
  assert.deepEqual([...html.matchAll(/data-ws-front-stop="([a-z]+)"/g)].map((m) => m[1]), ['asked', 'building', 'votes', 'live']);
  assert.match(html, /<h2 class="dev-ws-front-label">In the workshop now<\/h2><button type="button" class="dev-ws-front-go" data-ws-all-open="">Open the board<svg/);
  assert.match(html, /data-ws-front-stop="asked" data-n="17"><button type="button" class="dev-ws-front-stop-door">/);
  assert.ok(html.includes('17 suggestions') && html.includes('6 open') && html.includes('7 this week'));
  assert.equal(message('project:workshop.front.path.asked.line', { count: 17 }), '17 suggestions');
  assert.equal(message('project:workshop.front.path.asked.line', { count: 1 }), '1 suggestion', 'one is one suggestion');
  // The bot's builds are read after mount: until then Being built says its word alone.
  assert.match(html, /data-ws-front-stop="building"><button[^>]*>[\s\S]*?<b class="dev-ws-front-word">Being built<\/b><\/button>/);
  assert.equal(front.stopLine({ key: 'asked', n: 0, mine: 0 }, false), null, 'zero says nothing');
  assert.equal(front.stopLine({ key: 'asked', n: null, mine: 0 }, false), null, 'nor does a number not yet read');
  assert.deepEqual(front.stopLine({ key: 'building', n: 5, mine: 0 }, false), { id: 'project:workshop.front.path.building.line', values: { count: 5 } });
  // Being built says how many builds are under way, as the other stops state theirs; zero says nothing.
  assert.equal(message(front.stopLine({ key: 'building', n: 3, mine: 0 }, false).id, { count: 3 }), '3 right now');
  assert.equal(front.stopLine({ key: 'building', n: 0, mine: 0 }, false), null);
  assert.deepEqual(front.stopLine({ key: 'live', n: 127, atLeast: true, mine: 0 }, false), { id: 'project:workshop.front.path.live.lineAtLeast', values: { count: 127 } });
  assert.equal(message('project:workshop.front.path.live.lineAtLeast', { count: 127 }), '127+ this week');
  // The page is drawn while the board is read: the four words, no numbers.
  const early = render({ loading: true, dash: null });
  assert.equal((early.match(/class="dev-ws-front-line"/g) || []).length, 0);
  assert.deepEqual([...early.matchAll(/<b class="dev-ws-front-word">([^<]+)<\/b>/g)].map((m) => m[1]), ['Asked', 'Being built', 'Up for a vote', 'Live']);
  // The track's travelling dots and the nodes are decoration.
  assert.match(html, /<span class="dev-ws-front-run" aria-hidden="true"><i><\/i><i><\/i><i><\/i><\/span>/);
  assert.equal((html.match(/class="dev-ws-front-node" data-node="[a-z]+" aria-hidden="true"/g) || []).length, 4);
  // Each stop's door, as the brief's table says.
  assert.match(SRC, /asked: \(\) => onStage\('asked'\),\n\s+building: onBuilds,\n\s+votes: \(\) => onStage\('votes'\),/);
  assert.match(SRC, /live: \(\) => \(thisWeek \? onWeek\(thisWeek\) : onStage\('shipped'\)\),/);
  assert.match(WORKSHOP, /onBoard=\{\(\) => \{ callAppView\('clearWorkshopStage'\); openTab\('all'\); \}\}\n\s+onStage=\{\(stage\) => \{ callAppView\('openWorkshopStage', stage\); openTab\('all'\); \}\}\n\s+onBuilds=\{\(\) => openTab\('bot'\)\}\n\s+onNeeds=\{\(\) => openTab\('needs'\)\}/);
  // Being built is the bot's builds, the number its own page says ("building 3 of 5"), which the stop opens.
  assert.match(SRC, /n: slots \? slotCounts\(slots\)\.building : null,/);
});

test('the vote pill: votes waiting on the visitor, in place of the open count; "your yes" on a project that is just theirs', () => {
  const html = render({ owed: 4 });
  const votes = html.slice(html.indexOf('data-ws-front-stop="votes"'), html.indexOf('data-ws-front-stop="live"'));
  assert.match(votes, /<button type="button" class="dev-ws-front-pill" data-ws-front-pill="">4 need your vote<\/button>/);
  assert.ok(!votes.includes('6 open'), 'the open count would repeat the number');
  assert.ok(!render().includes('data-ws-front-pill'), 'nothing owed: no pill');
  assert.equal(message('project:workshop.front.path.pill', { count: 1 }), '1 needs your vote');
  assert.equal(message('project:workshop.front.path.pillYours', { count: 2 }), '2 need your yes');
  assert.equal(message('project:workshop.front.path.votes.yours'), 'Ready for your yes');
  // Just yours is read off the project's approval rule, as the rule line says it.
  const solo = { audience: 'solo', is_member: true, approval: { mode: 'rules', preset: 'you_or_the_group', required: 1, electorate: 1 } };
  assert.equal(front.ruleIsYours(solo, null), true);
  assert.equal(front.ruleIsYours({ ...solo, audience: 'invited', is_creator: true }, null), false, 'the group can still decide');
  assert.equal(front.ruleIsYours({ audience: 'open', is_member: true, approval: { mode: 'members', policy: 'anyone', required: 5, electorate: 12 } }, null), false);
  assert.equal(front.ruleIsYours(null, null), false);
});

test('the visitor\'s marker over a stop: up to two faces and "{n} of yours", in the accent', () => {
  assert.equal(message('project:workshop.front.path.mine', { count: 2 }), '2 of yours');
  assert.match(SRC, /Array\.from\(\{ length: Math\.min\(2, n\) \}, \(_, i\) => face\(i\)\)/);
  assert.match(SRC, /\{ key: 'asked', n: d && typeof d\.asked === 'number' \? d\.asked : null, mine: d\?\.mine\?\.asked \|\| 0 \},/);
  assert.match(CSS, /html:root #dev-workshop \.dev-ws-front-mine \{[^}]*color: var\(--wip-mark-2-ink\); \}/);
});

test('Lately: the last three things that went live, title only; Live by week: three bars, this week\'s solid', () => {
  const rows = [1, 2, 3, 4].map((n) => ({ key: `live:${n}`, sessionId: n, prNumber: 100 + n, title: `Change ${n}`, who: null, at: '2026-11-23T10:00:00Z', going: false }));
  const html = render({ recentLive: [{ ...rows[0], going: true, title: 'Still going live' }, ...rows], since: true, thisWeek: week({ fresh: [{ key: 'a', brief: { kind: 'request' } }, { key: 'b', brief: { kind: 'live' } }] }) });
  const lately = html.slice(html.indexOf('data-ws-front="lately"'), html.indexOf('data-ws-front="weeks"'));
  assert.deepEqual([...lately.matchAll(/<span>(Change \d)<\/span>/g)].map((m) => m[1]), ['Change 1', 'Change 2', 'Change 3'], 'three, a change still going live left out');
  assert.match(lately, /<a class="dev-ws-front-row-link" href="#app\/garden\/dev\/changes\/101\/1" data-ws-front-live="live:1"><svg[^>]*aria-hidden="true"/);
  assert.ok(!/<time/.test(lately), 'no time');
  assert.match(lately, /<span class="dev-ws-front-aside" data-ws-front-fresh="">2 new since you were last here<\/span><button type="button" class="dev-ws-front-go" data-ws-week="thisWeek" data-ws-week-all="">All of this week/);
  assert.ok(!render().includes('data-ws-front-fresh'), 'a first visit says nothing new');
  const weeks = html.slice(html.indexOf('data-ws-front="weeks"'));
  assert.match(weeks, /<h2 class="dev-ws-front-label">Live by week<\/h2><button type="button" class="dev-ws-front-go" data-ws-front-earlier="">Earlier weeks/);
  assert.match(weeks, /data-ws-week="thisWeek" data-now="" aria-label="This week so far: 7 went live"><span class="dev-ws-front-bar-label">This week so far<\/span>/);
  assert.match(weeks, /data-ws-week="lastWeek" aria-label="Last week: 9 went live">/);
  assert.match(weeks, /<u style="inline-size:78%"><\/u>/, 'scaled to the largest of the three');
  const bars = front.weekBars(week(), [week({ key: 'a', live: false }), week({ key: 'b', live: false }), week({ key: 'c', live: false })]);
  assert.deepEqual(bars.map((b) => b.week.key), ['thisWeek', 'a', 'b'], 'this week and the two before it');
});

test('a project with nothing yet: the four words, one line in Lately, and no Live by week', () => {
  const html = render({ dash: dash({ open: 0, asked: 0, votesWaiting: 0, shippedWeek: 0, everShipped: false }), thisWeek: null, pastWeeks: [], recentLive: [] });
  assert.equal((html.match(/class="dev-ws-front-line"/g) || []).length, 0);
  assert.match(html, /data-ws-front="lately-pair" data-one="" data-never="">/);
  assert.ok(html.includes('<p class="dev-ws-front-none" data-ws-front-none="">Nothing has gone live yet.</p>'));
  assert.ok(!html.includes('data-ws-front="weeks"'));
  // While the digest the weeks come from is still on its way the card holds its place, grey.
  const waiting = render({ dash: dash({ weeksPending: true }), thisWeek: null, pastWeeks: [] });
  assert.match(waiting, /data-ws-front="weeks"[\s\S]*?class="dev-ws-front-bar" data-skeleton=""/);
});

test('the Workshop tab draws it, with its other pages', () => {
  assert.match(WORKSHOP, /\{tab === 'workshop' && !weekUp && !frontPage \? \(\n\s+<WorkshopFront\n/);
  // Its other pages open in the tab as a week's does: Earlier weeks and Private requests.
  assert.match(WORKSHOP, /export const EARLIER_WEEKS = '@earlier';\nexport const PRIVATE_PAGE = '@private';/);
  assert.match(WORKSHOP, /\{tab === 'workshop' && frontPage === EARLIER_WEEKS \? \(\n\s+<EarlierWeeks/);
  assert.match(WORKSHOP, /\{tab === 'workshop' && frontPage === PRIVATE_PAGE && slug \? <PrivateRequestsPage slug=\{slug\} onBack=\{closeFrontPage\} \/> : null\}/);
  // Mark all seen is where the log is read now, on a returning visit.
  assert.match(WORKSHOP, /const markSeen = v\.since \? \{ any: sinceRows\.length > 0, onClear: clearSince \} : null;/);
  const { EarlierWeeks } = loadTsx('frontend/src/features/dev-board/workshop/week-pages.tsx');
  const page = renderToHtml(createElement(EarlierWeeks, {
    weeks: [week({ key: 'lastWeek', title: '', live: false })], firstWeek: Date.UTC(2026, 10, 9), onWeek: () => {}, onBack: () => {},
    seen: { any: true, onClear: () => {} },
  }));
  assert.match(page, /data-ws-weeks-page=""[\s\S]*?<button type="button" class="dev-ws-since-clear un-touch-target" data-ws-since-clear="">Mark all seen<\/button>[\s\S]*?<button type="button" class="dev-ws-week" data-ws-week="lastWeek">/);
  assert.match(page, /data-ws-week-start="">This project started the week of/);
});

test('its CSS: tokens only, one motion that stops for reduced motion and on a phone, and the path reversed right to left', () => {
  const block = CSS.slice(CSS.indexOf("/* ── A project's Workshop: its front page"), CSS.indexOf('/* The bot\'s slots, a page under the Workshop'));
  assert.ok(block.length > 1000);
  assert.doesNotMatch(block.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, 'every colour is a token');
  assert.doesNotMatch(block, /gray-|indigo-/);
  assert.match(block, /@media \(prefers-reduced-motion: no-preference\) \{\n  html:root #dev-workshop \.dev-ws-front-run > i \{ animation: ws-front-run 12s linear infinite; \}/,
    'the dots move only for someone who has not asked for less');
  assert.match(block, /html:root:where\(\[data-motion="reduce"\]\) #dev-workshop \.dev-ws-front-run > i \{ animation: none; \}/, 'nor under Reduce motion');
  assert.match(block, /html:root #dev-workshop \.dev-ws-front-run > i \{ position: absolute;[^}]*opacity: 0; \}/, 'not drawn when they do not move');
  assert.match(block, /@container ws-front \(max-width: 700px\) \{[\s\S]*?\.dev-ws-front-run > i \{ animation: none; \}/, 'no dots on a phone');
  assert.match(block, /html:root\[dir="rtl"\] #dev-workshop \.dev-ws-front-stops::before \{ background: linear-gradient\(to left,/, 'right to left, the track runs the other way');
  assert.match(CSS, /@keyframes ws-front-run \{\n  0% \{ inset-inline-start: 2%; opacity: 0; \}/, 'and the dots with it (a logical inset)');
  assert.match(block, /html:root #dev-workshop \.dev-ws\[data-ws-tab="workshop"\] > \.dev-ws-tabbody:has\(> \.dev-ws-front\) \{ width: 100%; max-width: 1132px; margin-inline: auto; \}/);
  // The path's colours are the hub hero's three and the vote's near-black, declared once as the look's tokens.
  assert.match(CSS, /--wip-path-ask: #ffee6f;\n  --wip-path-ask-ink: #121a0e;[\s\S]*?--wip-path-build: #3c7bd8;[\s\S]*?--wip-path-live: #a9cf97;/);
});

test('its words are whole messages in the project catalog, each with a description', () => {
  const catalog = JSON.parse(read('frontend/locales/en/project.json'));
  const ids = [...SRC.matchAll(/'project:(workshop\.front\.[a-zA-Z.]+)'/g)].map((m) => m[1]);
  assert.ok(ids.length > 20);
  for (const id of ids) {
    const entry = catalog[id] || catalog[`${id}_other`];
    assert.ok(entry && entry.text && entry.description, id);
  }
  assert.equal(message('project:workshop.front.ask.placeholder'), 'Tell Homeroom bot what to change…');
  assert.equal(message('project:workshop.front.path.title'), 'In the workshop now');
  assert.equal(message('project:workshop.front.lately.fresh', { count: 4 }), '4 new since you were last here');
});

test('the viewer\'s threads it marks are read from their own route, which the thread-by-number route passes on', () => {
  const threads = read('src/routes/threads.js');
  assert.match(threads, /router\.get\('\/api\/apps\/:slug\/threads\/:number', async \(req, res, next\) => \{\n(?:\s*\/\/[^\n]*\n)*\s*if \(req\.params\.number === 'yours'\) return next\(\);/);
  const server = read('server.js');
  assert.ok(server.indexOf("require('./src/routes/threads')") < server.indexOf("require('./src/routes/ai-work')"), 'the threads routes are mounted first');
  assert.match(read('src/routes/ai-work.js'), /router\.get\('\/api\/apps\/:slug\/threads\/yours',/);
  // Asked for while the front page is up, once a project: never by every page built from the board's view
  // (each declared check is a fresh page, and the read shares a rate limit with the chat's other reads).
  assert.match(SRC, /useEffect\(\(\) => \{ if \(slug && viewer\) callAppView\('_loadYours'\); \}, \[slug, viewer\]\);/);
  assert.doesNotMatch(read('public/js/app-view.js'), /if \(meId != null\) AppView\._loadYours\(\);/);
});
