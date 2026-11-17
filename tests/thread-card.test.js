'use strict';

// The thread's card on a request's and a change's page, under the standard
// look and the brand look (frontend/src/features/dev-board/topic/
// thread-card.tsx, card-model.ts and step-store.ts; app.css "THE THREAD'S
// CARD"): a kicker over the title, whose words the summary is, the picture,
// and a foot that says where the thread stands once, with its action. A step
// of "How it got here" opens its content over the card.
//
// The foot's model is pure: which of a change's votes, tests and merge it
// speaks for, and a request's standing in words. These tests read it in
// words, hold the step store's rules, and pin the places that draw the card:
// the two heads (never under one of the frame's looks), a lone change under a
// request, and the stylesheet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { withWords } = require('./lib/work-words');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MODEL = 'frontend/src/features/dev-board/topic/card-model.ts';
const RAIL_MODEL = 'frontend/src/features/dev-board/topic/rail-model.ts';
const STORE = 'frontend/src/features/dev-board/topic/step-store.ts';
const CARD = 'frontend/src/features/dev-board/topic/thread-card.tsx';
const CHANGE = 'frontend/src/features/dev-board/topic/change-head.tsx';
const REQUEST = 'frontend/src/features/dev-board/topic/request-head.tsx';
const CHANGES = 'frontend/src/features/dev-board/topic/thread-changes.tsx';

const words = (p) => (p == null ? null : typeof p === 'string' ? p : message(p.id, p.values));
const gate = (over = {}) => ({ name: 'Votes', figure: '', tone: 'muted', done: false, note: [], ...over });
const votes = (over = {}) => gate({ name: 'Votes', figure: 'Needs 2 more yes', ...over });
const testing = (over = {}) => gate({ name: 'Tested', figure: 'All checks passed', tone: 'done', done: true, ...over });
const standing = (state) => withWords({ since: '2026-11-08T12:00:00Z', ...state });

test("a change's foot speaks for the vote once its tests have passed", () => {
  const { changeFoot, alsoTests } = loadTsx(MODEL);
  const foot = changeFoot({
    status: { key: 'vote', label: 'Vote · 0/2' },
    votes: votes({ tone: 'ask', facts: [{ key: 'tally', text: '3 waiting' }, { key: 'mine', text: 'You haven’t voted.', ask: true }], note: ['Any of the 3 members can give it.'] }),
    testing: testing(),
  });
  assert.equal(foot.gate, 'votes');
  assert.equal(foot.key, 'vote');
  assert.equal(foot.headline, 'Needs 2 more yes');
  assert.deepEqual(JSON.parse(JSON.stringify(foot.facts)), ['3 waiting', 'You haven’t voted.']);
  assert.deepEqual(JSON.parse(JSON.stringify(foot.sub)), ['Any of the 3 members can give it.']);
  assert.equal(foot.tone, null);
  assert.equal(alsoTests(foot, testing()), null, 'passed tests add nothing under the vote');
});

test('a vote the viewer can cast leads even when its tests failed, which ride under it', () => {
  const { changeFoot, alsoTests } = loadTsx(MODEL);
  const bad = testing({ name: 'Testing', figure: 'The preview didn’t start', tone: 'bad', done: false, note: ['Could not parse repo URL'] });
  const foot = changeFoot({ status: { key: 'vote', label: 'Vote · 0/2' }, votes: votes({ tone: 'ask' }), testing: bad });
  assert.equal(foot.key, 'vote', 'the one thing the viewer can do here stays the headline');
  const also = alsoTests(foot, bad);
  assert.equal(also.bad, true);
  assert.equal(also.figure, 'The preview didn’t start');
  assert.deepEqual(JSON.parse(JSON.stringify(also.lines)), ['Could not parse repo URL']);
});

test('with no vote to cast, failed tests lead in red; running tests lead with how far they are', () => {
  const { changeFoot, barProgress } = loadTsx(MODEL);
  const failed = changeFoot({
    status: { key: 'checks', label: 'Checks failing' },
    votes: votes({ tone: 'muted' }),
    testing: testing({ name: 'Testing', figure: '2 checks failed', tone: 'bad', done: false, note: ['Homeroom bot is fixing it.'] }),
  });
  assert.equal(failed.key, 'failed');
  assert.equal(failed.gate, 'testing');
  assert.equal(failed.headline, '2 checks failed');
  assert.equal(failed.tone, 'bad');
  const segments = [{ weight: 1, pct: 100, state: 'done' }, { weight: 3, pct: 20, state: 'moving' }];
  const running = changeFoot({
    status: null,
    votes: votes({ tone: 'muted' }),
    testing: testing({ name: 'Testing', figure: 'about 6 min left', tone: 'muted', done: false, note: ['Running checks, 3 of 15'], segments }),
  });
  assert.equal(running.key, 'testing');
  assert.equal(running.headline, 'Testing');
  assert.deepEqual(JSON.parse(JSON.stringify(running.facts)), ['about 6 min left']);
  assert.equal(running.progress, 0.4, 'the bar is weighted as the Testing card draws it');
  assert.equal(barProgress([]), null);
  assert.equal(barProgress(undefined), null);
});

test('a merge under way, live and closed each say so; live is green and closed is grey', () => {
  const { changeFoot } = loadTsx(MODEL);
  const merging = changeFoot({
    status: { key: 'merging', label: 'Going live…' },
    votes: votes({ tone: 'done', done: true, figure: '2 of 2' }),
    testing: testing(),
    merge: gate({ name: 'Merging', figure: 'Waiting on GitHub', note: ['GitHub is building and scanning the release images.'] }),
  });
  assert.equal(merging.key, 'merging');
  assert.equal(merging.headline, 'Merging');
  assert.deepEqual(JSON.parse(JSON.stringify(merging.facts)), ['Waiting on GitHub']);
  const live = changeFoot({ status: { key: 'merged', label: 'Live' }, votes: votes({ tone: 'done', done: true, note: ['Merged.'] }), testing: testing() });
  assert.equal(live.key, 'live');
  assert.equal(live.headline, 'Live');
  assert.equal(live.tone, 'ok');
  const closed = changeFoot({ status: { key: 'closed', label: 'Closed' }, votes: votes({ tone: 'bad', note: ['Set aside.'] }), testing: testing({ tone: 'bad', done: false }) });
  assert.equal(closed.key, 'closed', 'a closed change says closed, whatever its tests said');
  assert.equal(closed.tone, 'muted');
});

test("a request's foot is its standing in words, with a sentence for every stage", () => {
  const { requestFoot, stageNote } = loadTsx(MODEL);
  const building = requestFoot(standing({ stage: 'building' }), true);
  assert.equal(building.key, 'building');
  assert.equal(words(building.headline), 'Building');
  assert.equal(building.busy, true);
  assert.equal(building.tone, null);
  assert.ok(words(building.sub), 'a line under it, the server\'s or the plain one');
  assert.equal(requestFoot(standing({ stage: 'stopped' }), true).tone, 'bad');
  assert.equal(requestFoot(standing({ stage: 'live' }), true).tone, 'ok');
  assert.equal(requestFoot(standing({ stage: 'closed' }), true).tone, 'muted');
  const stages = ['reading', 'planning', 'waiting_for_you', 'building', 'checking', 'up_for_vote', 'going_live', 'live', 'stopped', 'closed'];
  for (const stage of stages) {
    const note = stageNote({ stage });
    assert.ok(note && message(note.id), `${stage} has a sentence in the catalog`);
  }
  assert.equal(stageNote({ stage: 'waiting_for_you', why: 'question' }).id, 'project:topic.rail.note.question');
  assert.equal(stageNote({ stage: 'waiting_for_you', why: 'plan' }).id, 'project:topic.rail.note.plan');
  assert.equal(stageNote({ stage: 'checking', line: { code: 'shots' } }).id, 'project:topic.rail.note.shots');
});

test('the step store: one step open on one page, and a second press closes it', () => {
  const { sameStep, isGates, openStep, closeStep, stepStore } = loadTsx(STORE);
  assert.equal(sameStep({ kind: 'request' }, { kind: 'request' }), true);
  assert.equal(sameStep({ kind: 'plan', key: 'a' }, { kind: 'plan', key: 'b' }), false);
  assert.equal(sameStep({ kind: 'checks', changeId: 5 }, { kind: 'checks', changeId: 5 }), true);
  assert.equal(sameStep({ kind: 'checks', changeId: 5 }, { kind: 'votes', changeId: 5 }), false);
  assert.equal(sameStep(null, { kind: 'request' }), false);
  assert.equal(isGates({ kind: 'checks', changeId: 5 }, 5), true, "a change's tests and its votes are one layer");
  assert.equal(isGates({ kind: 'votes', changeId: 5 }, 5), true);
  assert.equal(isGates({ kind: 'votes', changeId: 6 }, 5), false);
  assert.equal(isGates({ kind: 'plan', key: 'a' }, 5), false);
  openStep('request:7', { kind: 'request' });
  assert.equal(stepStore.get().page, 'request:7');
  assert.equal(stepStore.get().open.kind, 'request');
  openStep('request:7', { kind: 'plan', key: 'a' });
  assert.equal(stepStore.get().open.kind, 'plan', 'another step replaces the open one');
  openStep('request:7', { kind: 'plan', key: 'a' });
  assert.equal(stepStore.get().open, null, 'pressing the open step closes it');
  openStep('change:9', { kind: 'votes', changeId: 9 });
  closeStep();
  assert.equal(stepStore.get().open, null);
});

test('the timeline: a passed test opens its checks, and the last step opens its votes, its tests or the bot\'s progress', () => {
  const { requestRail, changeRail, stepOpens } = loadTsx(RAIL_MODEL);
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const built = changeRail({
    id: 51, author: 'evan', at: '2026-11-13T15:16:00Z', plan: null,
    testing: { tone: 'done', done: true, figure: 'All checks passed' },
    status: { key: 'vote', label: 'Vote · 0/1' },
    votes: { figure: 'Needs 1 more yes', done: false, asking: true },
  });
  const tested = built.find((s) => s.key === 'tested');
  assert.equal(words(tested.link.label), 'See checks');
  assert.deepEqual(plain(stepOpens(tested)), { kind: 'checks', changeId: 51 });
  const now = built[built.length - 1];
  assert.deepEqual(plain(stepOpens(now)), { kind: 'votes', changeId: 51 });
  assert.equal(stepOpens(built.find((s) => s.key === 'built')), null, 'a step with nothing to show is not a press');
  const live = changeRail({ id: 51, author: 'evan', at: null, plan: null, testing: { tone: 'done', done: true, figure: null }, status: { key: 'merged', label: 'Live' }, votes: { figure: null, done: true, asking: false } });
  assert.equal(words(live[live.length - 1].note), 'Everyone has it now.');
  const asked = requestRail({ asker: 'maya', askedAt: '2026-11-07T09:12:00Z', specs: [], changes: [], standing: standing({ stage: 'building' }), track: true });
  const last = asked[asked.length - 1];
  assert.deepEqual(plain(stepOpens(last)), { kind: 'track' });
  assert.ok(words(last.note), 'the last step always says what happens next');
  const untracked = requestRail({ asker: 'maya', askedAt: '2026-11-07T09:12:00Z', specs: [], changes: [], standing: standing({ stage: 'building' }) });
  assert.equal(stepOpens(untracked[untracked.length - 1]), null);
});

test('both heads draw the card only outside the frame\'s looks, and keep Votes, Testing and the progress card in the page', () => {
  const change = read(CHANGE);
  const request = read(REQUEST);
  for (const src of [change, request]) {
    assert.match(src, /const cardLook = !frame;/);
    assert.match(src, /\{cardLook \? <ThreadKicker kind="(change|request)"/);
    assert.match(src, /useEffect\(\(\) => closeStep, \[page\]\);/, 'a step left open does not follow the reader to the next page');
    assert.match(src, /<ThreadRail steps=\{railSteps\} onOpen=\{openRail\} current=\{cardLook \? openNow : null\} \/>/);
  }
  // A change: the pair wraps itself in a layer that stays mounted, so the
  // declared checks and the doors to the vote still find the cards; shut,
  // the cards carry no buttons, so the page offers each action once.
  assert.match(change, /const layer = thread\.card && !ballot;/);
  assert.match(change, /const shut = layer && !isGates\(openNow, id\);/);
  assert.match(change, /if \(!stick \|\| layer\) return;/, 'the pair never floats under the header from inside the layer');
  assert.match(change, /if \(!layer\) return drawn;\s*return \(\s*<GatesShut\.Provider value=\{shut\}>\s*<StepLayer\s+keep\s+open=\{isGates\(openNow, id\)\}\s+name="gates"/);
  assert.match(change, /const voteAction = shut \? null : acts\.voteAction;/);
  assert.match(change, /if \(useContext\(GatesShut\)\) return null;/, 'Fix it is the foot\'s while the layer is shut');
  assert.match(change, /\{cardLook \? <ChangeFoot id=\{id\} card=\{card\} v=\{v\} page=\{page\} \/> : null\}/);
  assert.match(change, /\{cardLook && body\.summaryBy \? <WordsBy who=\{body\.summaryBy\}/);
  assert.match(change, /<ThreadCardContext\.Provider value=\{cardContext\}>/);
  // A request: the old status box gives way to the foot, and the bot's
  // progress card is the content of the last step's layer.
  assert.match(request, /\{\(working && !r\.status\.closed\) \|\| cardLook \? null : \(\s*<RequestStatus/);
  assert.match(request, /<StepLayer keep open=\{openNow\?\.kind === 'track'\} name="track"[\s\S]*?<div className="dev-request-track"/);
  assert.match(request, /<WordsBy who="asker" name=\{r\.asker \|\| null\} \/>/);
  assert.match(request, /<ThreadCardContext\.Provider value=\{cardContext\}>/);
  // A lone change under a request draws the same foot, over the same pair.
  const changes = read(CHANGES);
  assert.match(changes, /const lone = thread\.card && !ballot;/);
  assert.match(changes, /\{lone && view && item\.state !== 'underway' && hasCards\(item\)\s*\? <ChangeFoot id=\{item\.id\} card=\{view\.card\} v=\{view\.v\} page=\{thread\.page\} \/> : null\}/);
});

test('the layer: over the card, × on its right, Escape and the dimmed card close it', () => {
  const src = read(CARD);
  assert.match(src, /closest<HTMLElement>\('\[data-thread-card\]'\)/, 'it measures the card it lies over');
  assert.match(src, /if \(event\.key === 'Escape'\) \{ event\.stopPropagation\(\); onClose\(\); \}/);
  assert.match(src, /className="dev-step-scrim" tabIndex=\{-1\}[^>]*onClick=\{onClose\}/);
  assert.match(src, /className="dev-step-close" data-step-close=""/);
  assert.match(src, /if \(!open && !keep\) return null;/);
  assert.match(src, /data-step-layer=\{name\} data-open=\{open \? 'true' : 'false'\} hidden=\{!open\}/);
  const head = src.slice(src.indexOf('className="dev-step-head"'), src.indexOf('className="dev-step-body"'));
  assert.ok(head.indexOf('dev-step-title') < head.indexOf('dev-step-close'), 'the × is the header\'s last thing, on its right');
  assert.doesNotMatch(head, /ChevronLeft|ArrowLeft/, 'no back arrow');
});

test('the stylesheet: the card\'s block sits after the rail\'s and before the bell\'s sheet, with a twin for reduced motion', () => {
  const css = read('public/css/app.css');
  const rail = css.indexOf("THE THREAD'S RAIL");
  const card = css.indexOf("THE THREAD'S CARD");
  const bell = css.indexOf("THE BELL'S SHEET");
  assert.ok(rail > 0 && card > rail && bell > card);
  const block = css.slice(card, bell);
  assert.match(block, /\.dev-thread-card > :first-child:not\(\.min-w-0\) \{ display: none; \}/, 'the author\'s avatar gives way to the kicker');
  assert.match(block, /\.dev-thread-card \{ position: relative; \}/, 'the card is the layer\'s containing block');
  assert.match(block, /\.dev-step-layer \{ position: absolute; inset: 0;/, 'the layer lies over the card and adds no height');
  assert.match(block, /@media \(prefers-reduced-motion: reduce\) \{ \.dev-step-sheet \{ animation: none; \} \}/);
  assert.match(block, /:where\(html\[data-motion="reduce"\]\) \.dev-step-sheet \{ animation: none; \}/);
  assert.match(block, /\.dev-thread-foot\[data-thread-foot-tone="bad"\] \.dev-thread-foot-head \{ color: var\(--state-blocked\); \}/);
  assert.doesNotMatch(block, /gray-|indigo-/);
});

test('two competing changes are seeded on a staging copy only, as fake rows for the demo request', async () => {
  const { seedStagingCompetingChanges } = require('../src/db/migrate');
  const was = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'production';
  try {
    await seedStagingCompetingChanges({ query() { assert.fail('must not seed production'); } });
  } finally {
    if (was === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = was;
  }
  const calls = [];
  process.env.USERNODE_ENV = 'staging';
  try {
    await seedStagingCompetingChanges({ query: async (sql, args) => { calls.push({ sql, args }); return { rows: [] }; } });
  } finally {
    if (was === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = was;
  }
  assert.equal(calls.length, 2, 'two changes');
  for (const call of calls) {
    assert.match(call.sql, /ON CONFLICT \(id\) DO NOTHING/, 'idempotent');
    assert.match(call.sql, /ARRAY\[900001\]/, 'both for the demo request');
    assert.match(call.args[2], /^\[Mock\] Staging demo: /, 'obviously fake');
    assert.match(call.args[7], /^staging-demo-/, 'by fake people, never whoever opened the preview');
  }
});
