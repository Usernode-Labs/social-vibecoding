'use strict';

// "How it got here": the timeline of a thread's big events beside a
// request's or a change's card (frontend/src/features/dev-board/topic/
// rail-model.ts and thread-rail.tsx; app.css "THE THREAD'S RAIL").
//
// The model is pure: who asked, the newest plan, each change built, what its
// tests said, then where the thread stands, which is the standing the server
// stored and worded. These tests read its steps in words, and hold the three
// places that draw it: the shell's host between the root post and the
// replies, the two heads that portal into it (never under one of the frame's
// looks), and the stylesheet that stands it beside the card on a wide page
// and folds its earlier steps into a pile on a narrow one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { withWords } = require('./lib/work-words');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MODEL = 'frontend/src/features/dev-board/topic/rail-model.ts';
const RAIL = 'frontend/src/features/dev-board/topic/thread-rail.tsx';

const words = (p) => (p == null ? null : typeof p === 'string' ? p : message(p.id, p.values));
const names = (steps) => steps.map((s) => words(s.title));

const plan = (over = {}) => ({
  key: 'spec:1', title: 'Plan', version: 1, by: 'Homeroom bot', at: '2026-11-07T10:00:00Z', time: 'Nov 7', timeTitle: '',
  read: { kind: 'shared', sessionId: 9, version: 1, previewTitle: 'Plan' }, ...over,
});
const change = (over = {}) => ({
  type: 'change', id: 51, number: 8, title: 'Dark mode toggle', status: 'promoted', state: 'review', replies: 0,
  by: 'Homeroom bot', at: '2026-11-08T09:00:00Z', ...over,
});
const lead = (over = {}) => ({
  id: 51, number: 8, status: 'promoted', checks: { state: 'passing', phase: 'done', failing: null }, votes: { yes: 0, no: 0 },
  voteOpen: true, firstVersion: false, githubHold: false, shotsHeld: false, conflict: false, update: null, ...over,
});
const standing = (state) => withWords({ since: '2026-11-08T12:00:00Z', ...state });
const base = { asker: 'maya', askedAt: '2026-11-07T09:12:00Z', specs: [], changes: [], standing: null };

test('a request just asked: Asked, then the stage the bot is on', () => {
  const { requestRail } = loadTsx(MODEL);
  const steps = requestRail({ ...base, standing: standing({ stage: 'reading' }) });
  assert.deepEqual(names(steps), ['Asked', 'Reading it']);
  assert.equal(words(steps[0].desc), 'By maya.');
  assert.deepEqual(JSON.parse(JSON.stringify(steps[0].link.open)), { kind: 'request' });
  assert.equal(words(steps[0].link.label), 'Read the request');
  assert.equal(steps[1].now, true);
  assert.equal(steps[1].busy, true, 'the bot is at work on it');
  assert.equal(steps[1].since, true, 'its stamp reads "since"');
  assert.equal(steps.filter((s) => s.now).length, 1, 'one step is where it stands');
});

test('a request with no words of its own offers nothing to read', () => {
  const { requestRail } = loadTsx(MODEL);
  assert.equal(requestRail({ ...base, words: false })[0].link, null);
});

test('the newest plan standing is the Planned step, and opens that plan', () => {
  const { requestRail, newestPlan } = loadTsx(MODEL);
  const specs = [plan({ key: 'a', version: 1, ended: 'replaced' }), plan({ key: 'b', version: 2, by: 'evan' }), plan({ key: 'c', version: 3, ended: 'stopped' })];
  assert.equal(newestPlan(specs).key, 'b', 'a plan that ended is passed over while another stands');
  assert.equal(newestPlan([specs[0], specs[2]]).key, 'c', 'with none standing, the newest of them');
  assert.equal(newestPlan([]), null);
  const steps = requestRail({ ...base, specs, standing: standing({ stage: 'waiting_for_you', why: 'plan' }) });
  assert.deepEqual(names(steps), ['Asked', 'Planned, v2', 'Waiting for you to OK the plan']);
  assert.equal(words(steps[1].desc), 'By evan.');
  assert.deepEqual(JSON.parse(JSON.stringify(steps[1].link.open)), { kind: 'plan', key: 'b' });
  assert.equal(steps[2].busy, false, 'it waits on a person');
  const others = requestRail({ ...base, specs, yours: false, standing: standing({ stage: 'waiting_for_you', why: 'plan' }) });
  assert.equal(words(others[2].title), 'Waiting for the plan to be OK’d'.replace('’', "'"), 'anyone else reads their own wording');
  const first = requestRail({ ...base, specs: [plan({ by: 'System', bySystem: true })] });
  assert.equal(words(first[1].title), 'Planned');
  assert.equal(first[1].desc, null, 'a stand-in author is not named');
});

test('a change being built is the last step, not an event behind it', () => {
  const { requestRail } = loadTsx(MODEL);
  const steps = requestRail({
    ...base, specs: [plan()], changes: [change({ state: 'underway', ready: false })],
    standing: standing({ stage: 'building', change: lead({ status: 'active', checks: { state: null, phase: null, failing: null } }) }),
  });
  assert.deepEqual(names(steps), ['Asked', 'Planned', 'Building']);
});

test('tests running, tests failed, and only the screenshots left', () => {
  const { requestRail } = loadTsx(MODEL);
  const running = requestRail({
    ...base, changes: [change()],
    standing: standing({ stage: 'checking', line: { code: 'checks_running', minutes: 2 }, change: lead({ checks: { state: 'pending', phase: 'testing', failing: null } }) }),
  });
  assert.deepEqual(names(running), ['Asked', 'Built', 'Checking']);
  assert.equal(running[2].busy, true);

  const failing = requestRail({
    ...base, changes: [change()],
    standing: standing({ stage: 'checking', line: { code: 'fixing' }, change: lead({ checks: { state: 'failing', phase: 'done', failing: 3 } }) }),
  });
  assert.deepEqual(names(failing), ['Asked', 'Built', '3 tests failed', 'Checking']);
  assert.equal(failing[2].tone, 'bad');
  assert.equal(words(failing[2].link.label), 'See what failed');
  assert.deepEqual(JSON.parse(JSON.stringify(failing[2].link.open)), { kind: 'checks', changeId: 51 });
  assert.equal(words(failing[3].note), 'Fixing what its tests found');

  const one = requestRail({
    ...base, changes: [change()],
    standing: standing({ stage: 'stopped', reason: 'fix_stopped', change: lead({ checks: { state: 'failing', phase: 'done', failing: 1 } }) }),
  });
  // The step is titled "Stopped": the foot carries the server's whole
  // headline, and why it stopped is the note under the step, tinted red.
  assert.deepEqual(names(one), ['Asked', 'Built', '1 test failed', 'Stopped']);
  assert.equal(one[3].tone, 'bad');
  assert.equal(one[3].noteTone, 'bad');
  assert.ok(words(one[3].note));
  const unknown = requestRail({
    ...base, changes: [change()],
    standing: standing({ stage: 'stopped', reason: 'fix_stopped', change: lead({ checks: { state: 'failing', phase: 'done', failing: null } }) }),
  });
  assert.equal(words(unknown[2].title), 'Tests failed', 'with no count it says so plainly');

  const shots = requestRail({
    ...base, changes: [change()],
    standing: standing({ stage: 'checking', line: { code: 'shots' }, change: lead() }),
  });
  assert.deepEqual(names(shots), ['Asked', 'Built', 'Tested', 'Taking screenshots']);
  assert.equal(shots[3].icon, 'shots');
});

test('up for a vote, approved and going live, live, and closed', () => {
  const { requestRail } = loadTsx(MODEL);
  const vote = requestRail({ ...base, specs: [plan()], changes: [change()], standing: standing({ stage: 'up_for_vote', change: lead() }) });
  assert.deepEqual(names(vote), ['Asked', 'Planned', 'Built', 'Tested', 'Up for a vote']);
  assert.equal(words(vote[3].desc), 'All checks passed.');
  assert.equal(vote[4].busy, false);

  const going = requestRail({ ...base, changes: [change()], standing: standing({ stage: 'going_live', change: lead({ votes: { yes: 2, no: 0 } }) }) });
  assert.deepEqual(names(going), ['Asked', 'Built', 'Tested', 'Approved', 'Going live']);
  assert.equal(words(going[3].desc), '2 yes votes.');

  const live = requestRail({ ...base, changes: [change({ state: 'merged', status: 'merged' })], standing: standing({ stage: 'live', change: lead({ status: 'merged', votes: { yes: 1, no: 0 } }) }) });
  assert.deepEqual(names(live), ['Asked', 'Built', 'Tested', 'Approved', 'Live']);
  assert.equal(words(live[3].desc), '1 yes vote.');
  assert.equal(live[4].tone, 'ok');
  assert.equal(live[4].since, false, 'a settled step gives its date, not "since"');

  const closed = requestRail({ ...base, standing: standing({ stage: 'closed' }) });
  assert.deepEqual(names(closed), ['Asked', 'Closed']);
  assert.equal(closed[1].tone, 'muted');
});

test('#7117 discussion: each update after the first is a step of its own', () => {
  const { changeRail } = loadTsx(MODEL);
  const gate = (over = {}) => ({ name: 'Votes', figure: '', tone: 'muted', done: false, note: [], ...over });
  const input = {
    id: 51, author: 'evan', at: '2026-11-13T15:16:00Z', plan: null,
    testing: gate({ name: 'Tested', figure: 'All checks passed', tone: 'done', done: true }),
    status: { key: 'needs_vote', label: 'Vote · 0/2', yes: 0, majority: 2 },
    votes: gate({ figure: 'Needs 2 more yes' }),
  };
  const updated = changeRail({
    ...input,
    updates: [{ at: '2026-11-20T09:00:00Z', by: 'evan', votesKept: false }],
  });
  assert.deepEqual(names(updated), ['Built', 'Updated', 'Tested', 'Up for a vote'], 'the update sits after Built');
  assert.equal(updated[1].at, '2026-11-20T09:00:00Z', 'when it happened');
  assert.equal(words(updated[1].desc), 'By evan.', 'by whom, when the line records a person');
  assert.equal(words(updated[1].note), 'Earlier votes were cleared.');
  const kept = changeRail({ ...input, updates: [{ at: '2026-11-21T09:00:00Z', bot: true, votesKept: true }] });
  assert.equal(words(kept[1].desc), 'By Homeroom bot.', 'Homeroom made it, and said so without a name');
  assert.equal(words(kept[1].note), 'Earlier votes still stand.');
  assert.deepEqual(names(changeRail({ ...input, updates: [] })), ['Built', 'Tested', 'Up for a vote'], 'no updates, no step');
});

test('several changes are numbered, and each opens its own section', () => {
  const { requestRail } = loadTsx(MODEL);
  const steps = requestRail({
    ...base,
    changes: [change(), change({ id: 52, number: 9, by: 'sam', at: '2026-11-09T09:00:00Z' })],
    standing: standing({ stage: 'up_for_vote', change: lead() }),
  });
  assert.deepEqual(names(steps), ['Asked', 'Change #8 built', 'Tested', 'Change #9 built', 'Up for a vote']);
  assert.deepEqual(JSON.parse(JSON.stringify(steps[3].link.open)), { kind: 'change', changeId: 52 });
  assert.equal(words(steps[3].link.label), 'Open');
});

test('with no standing (an older server) every step is behind, and nothing is "now"', () => {
  const { requestRail, railFolds, earlierSteps } = loadTsx(MODEL);
  const steps = requestRail({ ...base, specs: [plan()], changes: [change()] });
  assert.deepEqual(names(steps), ['Asked', 'Planned', 'Built']);
  assert.equal(steps.some((s) => s.now), false);
  assert.equal(earlierSteps(steps).length, 3);
  assert.equal(railFolds(steps), true);
  assert.equal(railFolds(requestRail({ ...base, standing: standing({ stage: 'reading' }) })), false, 'one earlier step is not worth a pile');
});

test("a change's own page: planned, built, its tests, then where it stands", () => {
  const { changeRail, requestRail } = loadTsx(MODEL);
  const gate = (over = {}) => ({ name: 'Votes', figure: '', tone: 'muted', done: false, note: [], ...over });
  const passed = gate({ name: 'Tested', figure: 'All checks passed', tone: 'done', done: true });
  const input = {
    id: 51, author: 'evan', at: '2026-11-13T15:16:00Z', plan: plan({ by: 'evan' }),
    testing: passed,
    status: { key: 'needs_vote', label: 'Vote · 0/2', yes: 0, majority: 2 },
    votes: gate({ figure: 'Needs 2 more yes', tone: 'ask', note: ['Any of the 63 members can give it.'] }),
  };
  const vote = changeRail(input);
  assert.deepEqual(names(vote), ['Planned', 'Built', 'Tested', 'Up for a vote']);
  assert.equal(words(vote[3].note), 'Needs 2 more yes. Any of the 63 members can give it.');
  assert.equal(vote[3].noteTone, 'act', 'a note that asks for somebody is the wash');
  // A viewer who has voted reads "Up for a vote" too, never the pill's tally.
  assert.deepEqual(names(changeRail({ ...input, plan: null, status: { key: 'needs_vote', label: 'Vote · 1/2', yes: 1, majority: 2 }, votes: gate({ figure: 'Needs 1 more yes' }) })), ['Built', 'Tested', 'Up for a vote']);

  // Failed tests: the failure is behind it, and the last step is what the
  // failure waits for. It used to stay on the vote ("Vote · 0/2").
  const bad = gate({ name: 'Testing', figure: 'Found a problem', tone: 'bad' });
  const failed = changeRail({ ...input, plan: null, testing: bad });
  assert.deepEqual(names(failed), ['Built', 'Tests failed', 'Waiting for a fix']);
  assert.deepEqual(JSON.parse(JSON.stringify(failed[1].link.open)), { kind: 'checks', changeId: 51 });
  assert.equal(words(failed[2].note), 'Its tests have to pass before it can go live. A new version is tested again when it arrives.');
  const fixing = changeRail({ ...input, plan: null, testing: { ...bad, botFix: 'fixing' } });
  assert.deepEqual(names(fixing), ['Built', 'Tests failed', 'Fixing']);
  assert.equal(fixing[2].busy, true);
  const stopped = changeRail({ ...input, plan: null, testing: { ...bad, botFix: 'stopped' }, fixNote: 'Homeroom bot stopped after two tries.' });
  assert.deepEqual(names(stopped), ['Built', 'Tests failed', 'Stopped']);
  assert.equal(stopped[2].tone, 'bad');
  assert.equal(stopped[2].noteTone, 'bad');
  assert.equal(words(stopped[2].note), 'Homeroom bot stopped after two tries.', 'the card\'s own words for who fixes it');

  // Tests still running: a Testing step, with how far they are.
  const running = changeRail({ ...input, plan: null, testing: gate({ name: 'Testing', figure: 'about 6 min left', note: ['Preview built, checks a third done.'] }) });
  assert.deepEqual(names(running), ['Built', 'Testing']);
  assert.equal(running[1].busy, true);
  assert.equal(words(running[1].note), 'About 6 min left. Preview built, checks a third done.');
  assert.equal(running[1].noteTone, 'plain', 'a wait that needs nobody is plain');
  assert.deepEqual(JSON.parse(JSON.stringify(running[1].open)), { kind: 'checks', changeId: 51 });

  const merged = changeRail({ ...input, plan: null, status: { key: 'merged', label: '✓ Live', yes: 2, majority: 2 }, votes: gate({ tone: 'done', done: true }) });
  assert.equal(merged[merged.length - 1].tone, 'ok');
  assert.equal(words(merged[merged.length - 1].title), 'Live');

  // Still being built, or closed (no pill): nothing stands after Built.
  assert.deepEqual(names(changeRail({ ...input, plan: null, status: null })), ['Built', 'Tested']);

  // On a request's page with one change, the request's last steps are that
  // change's (./step-store.ts leadStore), so the timeline ends on the phase
  // the card's foot shows, whatever the request's own standing says.
  const led = requestRail({ ...base, changes: [change()], standing: standing({ stage: 'up_for_vote', change: lead() }), lead: { ...input, testing: { ...bad, botFix: 'fixing' } } });
  assert.deepEqual(names(led), ['Asked', 'Built', 'Tests failed', 'Fixing']);
  // A ballot between competing changes names itself, and its rule is the note.
  const choosing = requestRail({ ...base, changes: [change()], standing: standing({ stage: 'up_for_vote', change: lead() }), ballot: { count: 2, about: 'The first to pass goes live.' } });
  assert.equal(words(choosing[choosing.length - 1].title), 'Choosing between 2 changes');
  assert.equal(words(choosing[choosing.length - 1].note), 'The first to pass goes live.');
});

test('the shell holds the rail between the root post and the replies, on a request and a change only', () => {
  const shell = read('frontend/src/features/group-chat/thread-shell.tsx');
  assert.match(shell, /<div id="gc-thread-head" \/>[\s\S]{0,600}\{decision \? null : <div id="gc-thread-rail" className="dev-request-rail" \/>\}\s*<div id="gc-thread-messages" \/>/);
});

test('both heads portal the rail into its host, and never under one of the frame\'s looks', () => {
  for (const file of ['frontend/src/features/dev-board/topic/request-head.tsx', 'frontend/src/features/dev-board/topic/change-head.tsx']) {
    const src = read(file);
    assert.match(src, /const rail = frame \? null : host\('gc-thread-rail'\);/, file);
    // `current`: the step open over the card, which the rail marks (thread-card.tsx).
    assert.match(src, /\{rail \? createPortal\(<ThreadRail steps=\{railSteps\} onOpen=\{openRail\} current=\{cardLook \? openNow : null\} \/>, rail\) : null\}/, file);
  }
  const request = read('frontend/src/features/dev-board/topic/request-head.tsx');
  assert.match(request, /open\.kind === 'plan'[\s\S]{0,160}openRequestSpec\(card\)/, 'a plan opens in the reader it always did');
  assert.match(request, /call\('openTechnicalDetails', \[open\.changeId\]\)/, 'failed tests open the change\'s details');
  assert.match(request, /showChangeSection\(open\.changeId\)/, 'a competing change opens its own section');
});

test('the rail draws its steps, the folded pile, and the links by what they open', () => {
  const rail = read(RAIL);
  assert.match(rail, /className="dev-rail" data-thread-rail=\{steps\.length\} data-rail-fold=\{folds \? \(open \? 'open' : 'shut'\) : undefined\}/);
  assert.match(rail, /className="dev-rail-pile" data-rail-pile=\{early\.length\} aria-expanded="false"/);
  assert.match(rail, /bare=\{i < early\.length - 1\}/, 'only the newest marker in the pile wears its glyph');
  assert.match(rail, /data-rail-open=\{s\.link\.open\.kind\}/);
  assert.match(rail, /t\('project:topic\.rail\.showEarlier', \{ count: early\.length \}\)/);
  assert.equal(message('project:topic.rail.title'), 'How it got here');
  assert.equal(message('project:topic.rail.showEarlier', { count: 4 }), 'Show 4 earlier steps');
  assert.equal(message('project:topic.rail.showEarlier', { count: 1 }), 'Show 1 earlier step');
  assert.equal(message('project:topic.rail.showLess'), 'Show less');
  assert.equal(message('project:topic.rail.since', { when: 'Nov 13' }), 'since Nov 13');
});

test('the stylesheet: beside the card on a wide page, a folded pile on a narrow one, the standard and brand looks only', () => {
  const css = read('public/css/app.css');
  const at = css.indexOf("THE THREAD'S RAIL: \"How it got here\"");
  // Before the bell's sheet, which is the block that ends at the generated
  // looks (tests/frame-app.test.js), and so before the brand look too.
  const next = css.indexOf("/* THE BELL'S SHEET");
  const brand = css.indexOf('/* ── THE BRAND LOOK: PAPER, SIMPLIFIED, WITH BRAND STYLING');
  assert.ok(at > 0 && at < next && next < brand, 'the block sits before the brand look, which repaints it');
  const block = css.slice(at, next);
  assert.match(block, /\.dev-request-rail:empty \{ display: none; \}/);
  assert.match(block, /@media \(max-width: 1179\.98px\) \{\s*\.dev-rail\[data-rail-fold="shut"\] \.dev-rail-pile \{ display: flex; \}\s*\.dev-rail\[data-rail-fold="shut"\] \.dev-rail-step:not\(\[data-rail-now\]\) \{ display: none; \}/);
  // The wide layout is the one `@media (min-width: 1180px)` block and nothing
  // after it: a later narrow block (the phone's scale) is not part of it.
  const wideAt = block.indexOf('@media (min-width: 1180px)');
  let wideDepth = 0;
  let wideEnd = block.indexOf('{', wideAt);
  for (; wideEnd < block.length; wideEnd++) {
    if (block[wideEnd] === '{') wideDepth++;
    else if (block[wideEnd] === '}' && --wideDepth === 0) break;
  }
  const wide = block.slice(wideAt, wideEnd + 1);
  const scope = 'html:is(:not([data-skin]), [data-skin="brand"]):not(.in-side-panel) .gc-tab-body:not(:has(> .gc-spec-side-panel-open)) #dev-topic-thread:not(.dev-ws-side-page) .dev-request:has(.dev-request-rail:not(:empty))';
  const rules = wide.split('\n').filter((line) => /^\s*html/.test(line));
  assert.ok(rules.length >= 9, 'the wide layout has its rules');
  for (const line of rules) assert.ok(line.trim().startsWith(scope), `scoped to the two looks, a page, and no open reader: ${line.trim().slice(0, 80)}`);
  assert.match(wide, /\.dev-request-scroll \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\) var\(--thread-rail-w\);/);
  assert.match(wide, /\.dev-request-rail \{\s*grid-column: 2;\s*grid-row: 1 \/ span 2;\s*align-self: start;\s*position: sticky;/);
  // The cards are cards at every width (a phone's three, a desktop's two
  // columns): their paint sits outside the wide rule, on the same scope, and
  // a look paints them through the `-look` variables.
  const cards = block.slice(block.indexOf('/* THE CARDS, at every width'), block.indexOf('/* WIDE: two columns.'));
  assert.ok(cards.length > 0, 'the cards have their own part of the block');
  // …on a full page, and in the two side panels (the Workshop's, and the
  // column beside Homeroom bot's list) and beside the open reader, which
  // have a scope of their own.
  const panel = 'html:is(:not([data-skin]), [data-skin="brand"]) :is(.dev-ws-side, .in-side-panel body, .gc-tab-body:has(> .gc-spec-side-panel-open)) #dev-topic-thread .dev-request:has(.dev-request-rail:not(:empty))';
  for (const line of cards.split('\n').filter((l) => /^html/.test(l))) {
    const reader = 'html:is(:not([data-skin]), [data-skin="brand"]) .gc-tab-body:has(> .gc-spec-side-panel-open) .dev-request:has(.dev-request-rail:not(:empty)) .dev-request-sheet';
    assert.ok(line.startsWith(scope) || line.startsWith(panel) || line.startsWith(reader) || line.startsWith('html.in-side-panel.side-panel-beside-ai .dev-thread-kicker')
      || line.startsWith('html:is(:not([data-skin]), [data-skin="brand"]) #ai-screen .dev-private-thread'),
      `scoped as the wide layout is, or to a side panel: ${line.slice(0, 80)}`);
  }
  assert.match(cards, /--thread-card: var\(--thread-card-look, var\(--dc-sheet-fill\)\);/);
  assert.match(cards, /:is\(#gc-thread-head, #gc-thread-messages, \.dev-request-rail\) \{\s*min-width: 0;\s*border-radius: var\(--thread-card-r\);\s*background: var\(--thread-card\);/);
  assert.match(css.slice(brand), /\.dev-request \{\s*--thread-card-look: var\(--bl-card\);\s*--thread-card-solid-look: var\(--bl-card\);\s*--thread-card-edge-look: inset 0 0 0 1px var\(--app-sheet-line\), var\(--bl-lift\);/);
});

// #7171: the rail's height cap was written for the wide sticky column, but it
// applied at every width. Below 1180px the rail is in normal flow, has no
// `overflow`, and its last step painted over the first reply. The cap now
// lives only where the rail is sticky.
test('the narrow rail is not height-capped', () => {
  const css = read('public/css/app.css');

  // The ranges of every `@media (min-width: 1180px)` block, so what is left
  // is every rule that applies at any other width.
  const ranges = [];
  const header = '@media (min-width: 1180px)';
  for (let i = 0; ;) {
    const at = css.indexOf(header, i);
    if (at < 0) break;
    const open = css.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (; end < css.length; end++) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}' && --depth === 0) break;
    }
    ranges.push([at, end + 1]);
    i = end + 1;
  }
  assert.ok(ranges.length > 0, 'the wide layout block exists');

  let outside = '';
  let from = 0;
  for (const [start, end] of ranges) {
    outside += css.slice(from, start);
    from = end;
  }
  outside += css.slice(from);

  assert.doesNotMatch(outside, /\.dev-request-rail[^{]*\{[^}]*max-height/,
    'no height cap on the rail where it is in normal flow');
  assert.doesNotMatch(css, /\.dev-request-rail \{ max-height: calc\(100% - var\(--pill-under\)\) !important; \}/);

  const wide = ranges.map(([start, end]) => css.slice(start, end)).join('\n');
  assert.match(wide, /\.dev-request-rail \{[^}]*max-height: 100%;/, 'the sticky rail keeps its own cap');
  assert.match(wide, /\.dev-request-rail \{[^}]*max-height: calc\(100% - var\(--pill-top\)\) !important;/, 'and with a card, the pill-aware one');
});

// Request 7183: the card's format in the standard look.
test('the now step\'s "since" is a line under its name, and the standard card gives the step room', () => {
  const rail = read('frontend/src/features/dev-board/topic/thread-rail.tsx');
  const line = /<span className="dev-rail-line">([\s\S]*?)<\/span>\n\s*\{\/\*/.exec(rail);
  assert.ok(line, 'the name and time line is found');
  assert.match(line[1], /\{when && !s\.since \? <time className="dev-rail-time" /, 'an earlier step keeps its time beside its name');
  assert.doesNotMatch(line[1], /dev-rail-since/, 'the since line is outside the name\'s line');
  const since = rail.indexOf('{when && s.since ? <time className="dev-rail-time dev-rail-since" dateTime={s.at || undefined} title={stamp?.title}>{when}</time> : null}');
  assert.ok(since > rail.indexOf(line[0]) && since < rail.indexOf('className="dev-rail-desc"'), 'it comes after the line and before the description');

  const css = read('public/css/app.css');
  assert.match(css, /\n\.dev-rail-since \{ display: block; margin-inline-start: 0; \}/, 'every look draws it as its own line');
  const from = css.indexOf('/* HOW IT GOT HERE: its own card');
  const block = css.slice(from, css.indexOf("/* THE REPLIES' CARD", from));
  assert.ok(from > 0 && block.length > 0, 'the standard card block exists');
  const scope = 'html:not([data-skin]) #dev-topic-thread#dev-topic-thread .dev-request:has(.dev-thread-card) ';
  // The last rule the block has for a selector: the format rules follow the card's first ones.
  const rule = (selector) => {
    const at = block.lastIndexOf(`${scope}${selector} {`);
    assert.ok(at >= 0, `the block sets ${selector}`);
    return block.slice(at + scope.length + selector.length, block.indexOf('}', at) + 1).trim();
  };
  assert.equal(rule('.dev-rail-line'), '{ flex-wrap: nowrap; }', 'a long name wraps beside its time');
  assert.equal(rule('.dev-rail-name'), '{ flex: 1 1 auto; min-width: 0; }');
  assert.equal(rule('.dev-rail-time'), '{ flex: none; }');
  assert.equal(rule('.dev-rail-since'), '{ margin: 2px 0 0; font-size: 0.8125rem; line-height: 1.125rem; color: var(--one-ink-2); white-space: normal; }');
  assert.equal(rule('.dev-rail-step'), '{ padding: 0 0 14px; }', 'even space between steps');
  assert.equal(rule('.dev-rail-step::before'), '{ inset-inline-start: 14px; top: 34px; bottom: 4px; }', 'the connector stops short of the next mark');
  assert.equal(rule('.dev-rail-step[data-rail-now] .dev-rail-press'), '{ width: calc(100% + 16px); margin-inline: -8px; padding: 8px; border-radius: 14px; }', 'room around the mark and its ring');
  assert.equal(rule('.dev-rail-note'), '{ margin-top: 8px; padding: 8px 10px; border-radius: 10px; font-size: 0.8125rem; line-height: 1.125rem; }');
  assert.equal(rule('.dev-rail-note[data-rail-note="act"]'), '{ background: color-mix(in srgb, var(--bl-wash) 30%, transparent); }', 'a quieter tint');
  assert.doesNotMatch(block, /\.dev-rail-note\[data-rail-note="(plain|bad)"\]/, 'the other two tones keep their backgrounds');
});

// #7171: one scale across the three cards on a phone's thread page.
test("a phone's thread page uses one scale", () => {
  const css = read('public/css/app.css');
  const marker = css.indexOf("ONE SCALE ON A PHONE'S THREAD PAGE");
  assert.ok(marker > 0, 'the phone scale block exists');
  const open = css.indexOf('@media (max-width: 767.98px) {', marker);
  assert.ok(open > marker, 'it is a phone block');
  let depth = 0;
  let end = open;
  for (; end < css.length; end++) {
    if (css[end] === '{') depth++;
    else if (css[end] === '}' && --depth === 0) break;
  }
  const block = css.slice(open, end + 1);

  const value = (selector) => {
    const at = block.indexOf(selector);
    assert.ok(at > 0, `the block sets ${selector}`);
    const rule = block.slice(at, block.indexOf('}', at));
    const size = /font-size:\s*([^;]+);/.exec(rule);
    assert.ok(size, `${selector} sets a size`);
    return size[1].trim();
  };

  assert.equal(value('.dev-rail-time'), '0.8125rem');
  assert.equal(value('.dev-rail-title'), '0.75rem');
  assert.equal(value('.dev-rail-name'), '0.9375rem');
  assert.equal(value('.dev-thread-foot-head'), '0.9375rem');
  assert.match(block, /\.messages-thread-name \{ font-size: 1\.125rem;/, "the head's title is the one larger line");
  assert.match(block, /\.flex > \.truncate \{ font-size: 0\.9375rem; \}/, 'the reply name is the words\' size');
  assert.match(block, /\.flex > \.shrink-0 \{ font-size: 0\.8125rem; \}/, 'the reply time is the times\' size');
  assert.match(block, /\.gc-msg-content \{ font-size: 0\.9375rem; line-height: 1\.4; \}/, 'the reply words are 15 over 1.4');

  // No in-between size survives in it.
  for (const m of block.matchAll(/font-size:\s*([^;]+);/g)) {
    assert.doesNotMatch(m[1].trim(), /^(12\.5|13\.5|14\.5|15\.5|17)(px|rem|em)$/, `no in-between size: ${m[1].trim()}`);
  }
  // Scoped to the standard and brand looks, on the page's own thread, so
  // desktop and the Homeroom bot column are untouched.
  for (const line of block.split('\n').filter((l) => /^\s*html/.test(l))) {
    assert.match(line, /^\s*html:is\(:not\(\[data-skin\]\), \[data-skin="brand"\]\) #dev-topic-thread /, `scoped to the two looks and the thread page: ${line.trim().slice(0, 90)}`);
  }
});

// #6807: a change waiting on the bot's fix for a check that is not its own
// ends on Fixing, with the card's own line under it.
test('#6807: a change waiting on a fix for its check ends on Fixing, with its line', () => {
  const { changeRail } = loadTsx(MODEL);
  const input = {
    id: 51, author: 'evan', at: '2026-11-13T15:16:00Z', plan: null,
    status: { key: 'needs_vote', label: 'Vote · 0/2', yes: 0, majority: 2 },
    votes: { name: 'Votes', figure: 'Needs 2 more yes', tone: 'ask', done: false, note: [] },
  };
  const testing = { name: 'Testing', figure: 'Found a problem', tone: 'bad', done: false, note: [] };
  const note = 'The check it fails on fails without the change too. Homeroom bot is getting that check fixed (request #6805).';
  const flaky = changeRail({ ...input, testing: { ...testing, botFix: 'fixing' }, fixNote: note });
  assert.deepEqual(names(flaky), ['Built', 'Tests failed', 'Fixing']);
  assert.equal(words(flaky[2].note), note);
  assert.equal(flaky[2].busy, true);
});

// T2.3 (19 Nov 2026): the change's stored row (its own work_states row)
// words the last step while it is not up for a vote, as it words the foot
// (card-model.ts storedFoot). The timeline said "Up for a vote" once its
// checks passed while the foot said "Taking screenshots".
test('T2.3: a change\'s timeline ends on its stored row\'s words while it is not up for a vote', () => {
  const { changeRail, requestRail } = loadTsx(MODEL);
  const gate = (over = {}) => ({ name: 'Votes', figure: '', tone: 'muted', done: false, note: [], ...over });
  const input = {
    id: 51, author: 'evan', at: '2026-11-13T15:16:00Z', plan: null,
    testing: gate({ name: 'Tested', figure: 'All checks passed', tone: 'done', done: true }),
    status: { key: 'needs_vote', label: 'Vote · 0/2', yes: 0, majority: 2 },
    votes: gate({ figure: 'Needs 2 more yes', tone: 'ask', note: ['Any of the 63 members can give it.'] }),
  };
  const shots = changeRail({ ...input, work: standing({ stage: 'checking', line: { code: 'shots' } }) });
  assert.deepEqual(names(shots), ['Built', 'Tested', 'Taking screenshots']);
  const now = shots[shots.length - 1];
  assert.equal(now.icon, 'shots');
  assert.equal(words(now.note), 'Tests passed: only the before and after screenshots are left');
  assert.equal(now.noteTone, 'plain', 'nobody is asked for anything');
  assert.equal(now.busy, true);
  assert.deepEqual(JSON.parse(JSON.stringify(now.open)), { kind: 'votes', changeId: 51 }, 'a press still opens what it did');

  const sync = changeRail({ ...input, work: standing({ stage: 'checking', line: { code: 'syncing' } }) });
  assert.equal(names(sync).pop(), 'Syncing with main');
  const update = changeRail({ ...input, work: standing({ stage: 'building', line: { code: 'update_queued' } }) });
  assert.equal(names(update).pop(), 'Building');
  assert.equal(words(update[update.length - 1].note), 'An update is on its way');
  const held = changeRail({ ...input, work: standing({ stage: 'going_live', line: { code: 'github_checks' } }) });
  assert.equal(names(held).pop(), 'Approved');
  // GitHub holding its merge (the Merging card, AppView._changeMergeView):
  // the note stays the card's own account. Under the card look the card
  // itself sits in the shut step layer, so this note is the only place the
  // page says what GitHub is doing (dapp.json #6593 reads it).
  const merge = {
    name: 'Merging', figure: "Waiting on GitHub's checks", tone: 'muted', done: false,
    note: ['Approved and tested by Homeroom. GitHub is now building and scanning the release images, which usually takes about 6 minutes. It merges as soon as they pass.'],
  };
  const github = changeRail({
    ...input, votes: gate({ figure: '3 yes', tone: 'done', done: true }), merge,
    work: standing({ stage: 'going_live', line: { code: 'github_checks' } }),
  });
  assert.equal(names(github).pop(), 'Approved');
  assert.match(words(github[github.length - 1].note), /building and scanning the release images/);
  assert.match(words(github[github.length - 1].note), /^Waiting on GitHub's checks\./);
  const fixing = changeRail({
    ...input, testing: gate({ name: 'Testing', figure: 'Found a problem', tone: 'bad' }),
    // The server words it (work-state.js phrasesOf): "Fixing", its line.
    work: {
      stage: 'checking', line: { code: 'fixing_check' },
      words: { stage: { id: 'core:work.stage.fixing' }, stageOthers: { id: 'core:work.stage.fixing' }, line: { id: 'core:work.line.fixingCheck' } },
    },
  });
  assert.deepEqual(names(fixing), ['Built', 'Tests failed', 'Fixing']);

  // Up for a vote: the live vote's own step, with its tally's sentence.
  const vote = changeRail({ ...input, work: standing({ stage: 'up_for_vote' }) });
  assert.equal(names(vote).pop(), 'Up for a vote');
  assert.equal(words(vote[vote.length - 1].note), 'Needs 2 more yes. Any of the 63 members can give it.');
  // Merged: the change's own status is newer than any row.
  const merged = changeRail({
    ...input, status: { key: 'merged', label: '✓ Live', yes: 2, majority: 2 }, votes: gate({ tone: 'done', done: true }),
    work: standing({ stage: 'checking', line: { code: 'shots' } }),
  });
  assert.equal(names(merged).pop(), 'Live');

  // A request's page with one change, whose own row still says only "Up
  // for a vote": whether that vote is open is the change's row's to say
  // (the two reach the page by different reads), so the request's timeline
  // ends on the change's words (rail-model.ts leadRow).
  const led = requestRail({
    ...base, changes: [change()], standing: standing({ stage: 'up_for_vote', change: lead() }),
    lead: { ...input, work: standing({ stage: 'checking', line: { code: 'shots' } }) },
  });
  assert.deepEqual(names(led), ['Asked', 'Built', 'Tested', 'Taking screenshots']);
  // And once the request's row says the same, on its own words.
  const same = requestRail({
    ...base, changes: [change()], standing: standing({ stage: 'checking', line: { code: 'shots' }, change: lead({ voteOpen: false }) }),
    lead: { ...input, work: standing({ stage: 'up_for_vote' }) },
  });
  assert.deepEqual(names(same), ['Asked', 'Built', 'Tested', 'Taking screenshots']);
  // With no row for the request (an older server), the change's own row words it.
  const older = requestRail({
    ...base, changes: [change()], standing: null,
    lead: { ...input, work: standing({ stage: 'checking', line: { code: 'shots' } }) },
  });
  assert.deepEqual(names(older), ['Asked', 'Built', 'Tested', 'Taking screenshots']);
});

// ── The one rule on a request's page (frontend/src/lib/work-state.ts) ──
//
// A request's page with one change ended on the CHANGE's row. The two rows
// differ on purpose: the request's says what is being done about it (the bot
// stopped fixing, a question was asked), the change's where the change is.
// So the Homeroom bot tab and the bell said "Stopped: its tests still fail"
// while the request's own page showed a busy "Checking". These feed the page
// the rows the server sends (tests/lib/stored-row.js), the request's through
// normalizeWorkState as request-head.tsx hands it on.
const { storedRow, storedChange } = require('./lib/stored-row');

test('a request\'s page with one change ends on the REQUEST\'s row, over the change\'s events', () => {
  const { requestRail } = loadTsx(MODEL);
  const { normalizeWorkState } = loadTsx('frontend/src/lib/work-state.ts');
  const gate = (over = {}) => ({ name: 'Votes', figure: '', tone: 'muted', done: false, note: [], ...over });
  const failing = storedChange({ checks: { state: 'failing', phase: 'done', failing: 2 } });
  const one = {
    id: 51, author: 'Homeroom bot', at: '2026-11-13T15:16:00Z', plan: null,
    status: { key: 'needs_vote', label: 'Vote · 0/2', yes: 0, majority: 2 },
    votes: gate({ figure: 'Needs 2 more yes', tone: 'ask', note: ['Any of the 63 members can give it.'] }),
    testing: gate({ name: 'Testing', figure: '2 tests failed', tone: 'bad', botFix: 'stopped' }),
    fixNote: 'Homeroom bot tried to fix these and stopped at its own limit.',
    // The change's own row: its tests fail, and that is all it knows.
    work: storedRow({ stage: 'checking', line: { code: 'checks_failing', failing: 2 } }, { kind: 'change' }),
  };
  const page = (sent, lead = one) => requestRail({
    ...base, changes: [change()], standing: normalizeWorkState(sent), yours: sent.mine !== false, lead,
  });

  // Homeroom bot gave up fixing the tests: the request's row is Stopped.
  const stopped = page(storedRow({ stage: 'stopped', reason: 'fix_stopped', change: failing }));
  assert.deepEqual(names(stopped), ['Asked', 'Built', 'Tests failed', 'Stopped'], 'never a busy "Checking"');
  const now = stopped[stopped.length - 1];
  assert.equal(now.now, true);
  assert.equal(now.tone, 'bad');
  assert.equal(now.icon, 'stopped');
  assert.equal(now.busy, false, 'nothing is at work on it');
  assert.equal(now.noteTone, 'bad');
  assert.equal(words(now.note), 'Homeroom bot tried to fix these and stopped at its own limit.', 'the card\'s own words for who fixes it now');
  assert.deepEqual(JSON.parse(JSON.stringify(now.open)), { kind: 'checks', changeId: 51 }, 'a press still opens the tests');
  assert.equal(stopped.filter((s) => s.now).length, 1);

  // The bot is fixing them: the request says so, with its line.
  const fixing = page(storedRow({ stage: 'building', line: { code: 'fixing' }, whoseMove: 'bot', change: failing }),
    { ...one, testing: { ...one.testing, botFix: 'fixing' } });
  assert.deepEqual(names(fixing), ['Asked', 'Built', 'Tests failed', 'Building']);
  assert.equal(words(fixing[fixing.length - 1].note), message('core:work.line.fixing'));
  assert.equal(fixing[fixing.length - 1].busy, true);

  // A question asked about a change that is open for votes: the request
  // waits on its requester, in their words or in anyone else's.
  const open = {
    ...one, testing: gate({ name: 'Tested', figure: 'All checks passed', tone: 'done', done: true }), fixNote: null,
    work: storedRow({ stage: 'up_for_vote' }, { kind: 'change' }),
  };
  const question = { stage: 'waiting_for_you', why: 'question', whoseMove: 'requester', change: storedChange({ voteOpen: true }) };
  const mine = page(storedRow(question), open);
  assert.deepEqual(names(mine), ['Asked', 'Built', 'Tested', message('core:work.why.question')]);
  assert.equal(mine[mine.length - 1].noteTone, 'act', 'somebody has to answer');
  assert.deepEqual(JSON.parse(JSON.stringify(mine[mine.length - 1].open)), { kind: 'votes', changeId: 51 });
  const theirs = page(storedRow(question, { mine: false }), open);
  assert.equal(names(theirs).pop(), message('core:work.whyOthers.question'));

  // Both rows up for a vote: the vote's own step, with its tally's sentence.
  const vote = page(storedRow({ stage: 'up_for_vote', whoseMove: 'group', change: storedChange({ voteOpen: true }) }), open);
  assert.equal(names(vote).pop(), 'Up for a vote');
  assert.equal(words(vote[vote.length - 1].note), 'Needs 2 more yes. Any of the 63 members can give it.');

  // The change has since gone live: its own status is newer than any row.
  const live = page(storedRow({ stage: 'checking', line: { code: 'shots' }, change: storedChange() }),
    { ...open, status: { key: 'merged', label: '✓ Live', yes: 2, majority: 2 }, votes: gate({ tone: 'done', done: true }) });
  assert.equal(names(live).pop(), 'Live');

  // The request's row is about ANOTHER change (one this page no longer
  // draws), or names none: it says nothing about this one, so this change's
  // own row words its step, never "Stopped" or "Not started yet" borrowed
  // from elsewhere.
  const elsewhere = page(storedRow({ stage: 'stopped', reason: 'fix_stopped', change: storedChange({ id: 77, number: 9 }) }), open);
  assert.equal(names(elsewhere).pop(), 'Up for a vote');
  const shotsRow = { ...open, work: storedRow({ stage: 'checking', line: { code: 'shots' } }, { kind: 'change' }) };
  assert.equal(names(page(storedRow({ stage: 'reading', line: { code: 'waiting' } }), shotsRow)).pop(), 'Taking screenshots');
});

test('leadRow: the request\'s row words its one change only while it is about that change', () => {
  const { leadRow } = loadTsx(MODEL);
  const { normalizeWorkState } = loadTsx('frontend/src/lib/work-state.ts');
  const own = normalizeWorkState(storedRow({ stage: 'checking', line: { code: 'shots' } }, { kind: 'change' }));
  const stopped = normalizeWorkState(storedRow({ stage: 'stopped', reason: 'fix_stopped', change: storedChange() }));
  const vote = normalizeWorkState(storedRow({ stage: 'up_for_vote', change: storedChange({ voteOpen: true }) }));
  const other = normalizeWorkState(storedRow({ stage: 'stopped', reason: 'fix_stopped', change: storedChange({ id: 77 }) }));
  const none = normalizeWorkState(storedRow({ stage: 'reading', line: { code: 'waiting' } }));
  assert.equal(leadRow(stopped, own, 51), stopped, 'about this change: the request\'s row');
  assert.equal(leadRow(vote, own, 51), own, 'only "up for a vote": whether it is open is the change\'s row\'s to say');
  assert.equal(leadRow(vote, null, 51), vote);
  assert.equal(leadRow(other, own, 51), own, 'about another change: this one\'s own row');
  assert.equal(leadRow(other, null, 51), null, 'and with none, the live cards');
  assert.equal(leadRow(none, own, 51), own, 'a request\'s row that names no change');
  assert.equal(leadRow(null, own, 51), own, 'an older server: the change\'s row');
  assert.equal(leadRow(stopped, own, null), stopped, 'a change with no id yet');
});
