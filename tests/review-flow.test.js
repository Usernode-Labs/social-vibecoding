'use strict';

// The new Needs you review flow (frontend/src/features/review-flow/), an
// experiment behind Settings › Experimental ("New Needs you"), off by
// default and kept on the device.
//
// What is pinned, and each is a way it can be quietly wrong:
//
//   1. THE SWITCH. Off until a person turns it on, kept where the screen
//      reads it, painted and saved by Settings through its bridge, and the
//      Communities tab draws the new flow only while it is on.
//   2. THE PICTURES' MATHS. The title shot crops the after side to what
//      changed; the slider places BOTH sides with one placement, so a seam
//      never moves what it compares; the seam resists past an edge and
//      settles softly on the edges of what changed.
//   3. THE VOTE. Votes go through the platform's castVote with the epoch;
//      a No carries its line; Undo goes through retractVote; Next change
//      moves to the next item.
//   4. THE COPY. Every message the flow asks for exists in English.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const settings = loadTsx('frontend/src/features/review-flow/settings.ts');
const model = loadTsx('frontend/src/features/review-flow/model.ts');
const compare = loadTsx('frontend/src/features/review-flow/compare.tsx');
const sheet = loadTsx('frontend/src/features/review-flow/vote-sheet.tsx');

function memoryStorage(on) {
  const map = new Map(on ? [[settings.REVIEW_FLOW_STORAGE_KEY, '1']] : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    map,
  };
}

const SCREEN = {
  viewport: 'mobile',
  width: 390,
  before: { url: '/api/apps/a/proposals/1/shots/' + 'a'.repeat(32), height: 844 },
  after: { url: '/api/apps/a/proposals/1/shots/' + 'b'.repeat(32), height: 900 },
  regions: [{ n: 1, b: [20, 300, 200, 40], a: [20, 300, 240, 60] }],
};

function feedItem(over = {}) {
  return {
    kind: 'proposal', id: 41, title: 'Unused invite links say so plainly',
    summary: '**A link** nobody used reads "No one joined yet".', author: 'ines',
    number: 4827, epoch: 3, at: '2026-10-19T10:00:00Z', yes: 1, no: 0,
    shots: { state: 'verified' }, visuals: null,
    app: { slug: 'homeroom', name: 'Homeroom', icon_url: null, icon_emoji: null },
    ...over,
  };
}

// ── 1. The switch ────────────────────────────────────────────────────────

test('the switch is off by default and kept under its own key on the device', () => {
  assert.equal(settings.REVIEW_FLOW_STORAGE_KEY, 'usernode:review-flow');
  const store = memoryStorage(false);
  assert.equal(settings.reviewFlowEnabled(store), false);
  settings.setReviewFlowEnabled(true, store);
  assert.equal(store.map.get('usernode:review-flow'), '1');
  assert.equal(settings.reviewFlowEnabled(store), true);
  settings.setReviewFlowEnabled(false, store);
  assert.equal(store.map.has('usernode:review-flow'), false);
  assert.equal(settings.reviewFlowEnabled(null), false, 'unreadable storage reads as off');
  const broken = { getItem() { throw new Error('denied'); } };
  assert.equal(settings.reviewFlowEnabled(broken), false);
});

test('the bridge settings.js reads and saves the switch through', () => {
  const win = {};
  settings.installReviewFlowBridge(win);
  assert.equal(typeof win.UsernodeReact.reviewFlow.enabled, 'function');
  assert.equal(typeof win.UsernodeReact.reviewFlow.setEnabled, 'function');
});

test('Settings, Experimental carries the switch, and settings.js paints and saves it', () => {
  const section = read('frontend/src/features/settings/sections/experimental.tsx');
  assert.match(section, /<SwitchRow id="review-flow-enabled">/);
  assert.match(section, /settings:experimental\.reviewFlow\.label/);
  const js = read('frontend/src/features/settings/settings.js');
  assert.match(js, /getElementById\('review-flow-enabled'\)[\s\S]{0,400}UsernodeReact\?\.reviewFlow[\s\S]{0,80}setEnabled\(e\.target\.checked\)/);
  assert.match(js, /review\.checked = !!reviewPref\?\.enabled\(\)/);
  assert.match(read('frontend/src/main.tsx'), /import '\.\/features\/review-flow\/settings';/);
  assert.equal(message('settings:experimental.reviewFlow.label'), 'New Needs you');
});

test('the Communities tab draws the new flow only while the switch is on', () => {
  const src = read('frontend/src/features/workshop/index.tsx');
  assert.match(src, /const reviewFlow = useReviewFlowEnabled\(\);/);
  assert.match(src, /reviewFlow \? \(\s*\/\/[\s\S]*?<ReviewFlow[\s\S]*?\) : \(\s*<NeedsReel/);
  assert.match(src, /onRetracted=\{\(id\) => workshopController\.retracted\(id\)\}/);
  assert.match(src, /retracted\(id: number\) \{[\s\S]*?answeredVotes\.delete\(key\)[\s\S]*?this\.refreshNeeds\(\)/);
});

// ── 2. The pictures' maths ──────────────────────────────────────────────

test('feed items become review items: plain summary, shaped screens, phone first, ground by size', () => {
  const desktop = { ...SCREEN, viewport: 'desktop', width: 1280 };
  const shape = () => ({ screens: [desktop, SCREEN], protected: true });
  const [item] = model.toReviewItems([feedItem({ staging_url: 'https://preview.example/x' })], shape);
  assert.equal(item.key, 'proposal:41');
  assert.equal(item.summary, 'A link nobody used reads "No one joined yet".');
  assert.deepEqual(item.screens.map((s) => s.viewport), ['mobile'], 'a phone screen wins when there is one');
  assert.equal(item.ground, model.GROUNDS.quiet, 'one changed spot is quiet');
  assert.equal(item.stagingUrl, 'https://preview.example/x');
  assert.equal(item.epoch, 3);

  const many = { ...SCREEN, regions: [SCREEN.regions[0], SCREEN.regions[0]] };
  assert.equal(model.groundFor([many]), model.GROUNDS.notable);
  assert.equal(model.groundFor([SCREEN, SCREEN]), model.GROUNDS.loud, 'several screens are loud');

  const [gov] = model.toReviewItems([feedItem({ kind: 'governance', shots: null })], () => { throw new Error('not shaped'); });
  assert.equal(gov.kind, 'governance');
  assert.deepEqual(gov.screens, []);
  assert.equal(gov.stagingUrl, null);

  const [legacy] = model.toReviewItems([feedItem({ shots: null, visuals: {} })], () => ({ before: 'c'.repeat(32), after: 'd'.repeat(32) }));
  assert.deepEqual(legacy.pair, { before: '/visuals/' + 'c'.repeat(32), after: '/visuals/' + 'd'.repeat(32) });
});

test('the title shot crops the after side to what changed, at its own proportions', () => {
  const crop = model.titleCrop(SCREEN, { w: 300, h: 200 });
  // The after box (20,300,240,60) with 24px of room, clamped at the left
  // edge: 284 x 108.
  assert.ok(crop.w <= 300 && crop.h <= 200);
  assert.ok(Math.abs(crop.w / crop.h - 284 / 108) < 0.05, 'the plate keeps the crop\'s proportions');
  assert.ok(crop.place.scale >= 1 && crop.place.scale <= 2, 'a small spot is shown at least at its size, at most twice');
  assert.ok(crop.place.ty < 0, 'the screen is moved up so the spot shows');
});

test('one placement for both sides: the seam never moves what it compares', () => {
  const box = model.focusBox(SCREEN, ['before', 'after'], 16);
  assert.deepEqual(box, { x: 4, y: 284, w: 272, h: 92 });
  const place = model.placeBox(SCREEN, box, { w: 390, h: 292 }, 1.6);
  assert.ok(place.scale <= 1.6);
  // The box's middle lands in the view's middle (or as near as the screen's edges allow).
  const mid = (box.y + box.h / 2) * place.scale + place.ty;
  assert.ok(Math.abs(mid - 146) < 1, `middle at ${mid}`);
});

test('the seam resists past an edge and settles softly near what changed', () => {
  assert.equal(model.rubberBand(0, 390), 0);
  const far = model.rubberBand(400, 390);
  assert.ok(far > 0 && far < 400 && far < 390, 'it follows, less and less');
  assert.equal(model.rubberBand(-50, 390), -model.rubberBand(50, 390));
  assert.equal(model.magnet(100, [100]), 100);
  const pulled = model.magnet(108, [100]);
  assert.ok(pulled < 108 && pulled > 100, 'pulled toward the stop');
  assert.equal(model.magnet(140, [100]), 140, 'out of reach, untouched');
  const stops = model.seamStops(SCREEN, { scale: 1, tx: 0, ty: 0 }, 390);
  assert.ok(stops.length >= 3);
  assert.ok(stops.every((x, i) => i === 0 || stops[i - 1] <= x), 'in order');
});

test('the pill names the side most of the window shows, with hysteresis, and colour follows share', () => {
  assert.equal(compare.viewFor(0.55, 'after'), 'after');
  assert.equal(compare.viewFor(0.6, 'after'), 'before');
  assert.equal(compare.viewFor(0.45, 'before'), 'before');
  assert.equal(compare.viewFor(0.4, 'before'), 'after');
  assert.equal(compare.saturationFor(0.5), 1);
  assert.equal(compare.saturationFor(0.25), 0.5);
  assert.equal(compare.saturationFor(0), 0);
});

// ── 3. The vote ──────────────────────────────────────────────────────────

test('votes go through castVote with the epoch, a No carries its line, Undo goes through retractVote', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  assert.match(src, /callAppView\('castVote', item\.id, v, item\.epoch, opts\)/);
  assert.match(src, /v === 'no' \? \{ reason: reason \|\| '' \} : \{ reason: null \}/);
  assert.match(src, /callAppView\('retractVote', item\.id, item\.epoch\)/);
  assert.match(src, /onAnswered\?\.\(item\.id, item\.epoch\)/);
  assert.match(src, /onRetracted\?\.\(item\.id\)/);
  assert.equal(sheet.NO_LINE_MAX, 280, 'the server\'s VOTE_REASON_MAX');
});

test('going anywhere else takes the page down at once', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  assert.match(src, /window\.addEventListener\('hashchange', away\)/);
  assert.match(src, /window\.addEventListener\('popstate', away\)/);
});

test('Next change moves to the next item, wrapping round, and the only item has none', () => {
  const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  assert.equal(model.nextIndex(items, 0), 1);
  assert.equal(model.nextIndex(items, 2), 0);
  assert.equal(model.nextIndex([{ key: 'a' }], 0), -1);
});

test('the sheet covers the page only while it is open', () => {
  assert.equal(sheet.sheetOpen('ask'), false);
  assert.equal(sheet.sheetOpen('voted'), false);
  for (const s of ['unsure', 'no', 'askq', 'talk', 'try', 'about', 'more']) assert.equal(sheet.sheetOpen(s), true, s);
});

function sheetHtml(props) {
  const [item] = model.toReviewItems([feedItem()], () => ({ screens: [SCREEN] }));
  return renderToHtml(createElement(sheet.VoteSheet, {
    item, vote: null, state: 'ask', setState() {}, onVote: async () => true, onUndo: async () => true,
    onNext() {}, hasNext: true, maxHeight: 600, fresh: false, ...props,
  }));
}

test('at rest the sheet asks Yes or No, with Not sure? under them', () => {
  const html = sheetHtml({});
  assert.match(html, /data-rf-vote="yes"/);
  assert.match(html, /data-rf-vote="no"/);
  assert.ok(html.includes(message('communities:review.unsure.open')));
});

test('Not sure? opens the four help rows', () => {
  const html = sheetHtml({ state: 'unsure' });
  for (const to of ['askq', 'talk', 'try', 'about']) assert.match(html, new RegExp(`data-rf-help="${to}"`));
});

test('after a vote: a large mark, what you said, Undo beside Next change', () => {
  const html = sheetHtml({ vote: 'yes', state: 'voted', fresh: true });
  assert.match(html, /data-rf-said="yes"/);
  assert.ok(html.includes(message('communities:review.said.yes')));
  assert.match(html, /data-rf-undo=""[\s\S]*data-rf-next=""/);
  assert.ok(html.includes(message('communities:review.said.next')));
  const last = sheetHtml({ vote: 'no', state: 'voted', hasNext: false });
  assert.ok(last.includes(message('communities:review.said.no')));
  assert.ok(last.includes(message('communities:review.said.done')));
});

test('a No asks for its line, held to the server\'s limit', () => {
  const html = sheetHtml({ state: 'no' });
  assert.ok(html.includes(message('communities:review.no.ask')));
  assert.match(html, /maxLength="280"/);
  assert.match(html, /aria-pressed="true"/);
});

// ── 4. The copy ──────────────────────────────────────────────────────────

test('every message the flow asks for exists in English', () => {
  const dir = 'frontend/src/features/review-flow/';
  const ids = new Set();
  for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    const src = read(dir + f);
    for (const m of src.matchAll(/'((?:communities|settings):[a-zA-Z0-9_.]+)'/g)) ids.add(m[1]);
  }
  assert.ok(ids.size > 40, `found ${ids.size} ids`);
  const has = (id) => { try { return !!message(id); } catch { return false; } };
  for (const id of ids) {
    // A message read with a count is written as its _one/_other pair.
    assert.ok(has(id) || (has(`${id}_one`) && has(`${id}_other`)), `missing ${id}`);
  }
});

test('a vote taken back leaves the saved-vote store, so no screen keeps it answered', () => {
  const cards = loadTsx('frontend/src/features/dev-board/card/cards-store.ts');
  cards.publishVoteSaved(9001, 'yes', 4);
  assert.equal(cards.voteSavedStore.get()['9001'].vote, 'yes');
  cards.publishVoteSaved(9001, null, 4);
  assert.equal('9001' in cards.voteSavedStore.get(), false);
  const before = cards.voteSavedStore.get();
  cards.publishVoteSaved(9002, null, null);
  assert.equal(cards.voteSavedStore.get(), before, 'nothing to forget: the store is untouched');
});

// ── 5. A picture for every card, a short line, changes first ──────────

test('every item gets a picture: shots, a pair, a drawn benefit or a drawn decision', () => {
  const shape = (v, shots) => (shots && shots.screens ? { screens: shots.screens } : null);
  const items = model.toReviewItems([
    feedItem({ id: 1, shots: { screens: [SCREEN] } }),
    feedItem({ id: 2, title: 'Fix the invite link that never opened', shots: null }),
    feedItem({ id: 3, kind: 'governance', shots: null, decision: { kind: 'close_issue', issueNumber: 5 } }),
    feedItem({ id: 4, kind: 'governance', shots: null, decision: { kind: 'something_new' } }),
    feedItem({ id: 5, shots: { claims: [], benefit: { kind: 'speed', area: 'messages', before: '85 KB', after: '46 KB' } } }),
    feedItem({ id: 6, shots: null, benefit: { kind: 'security', area: 'accounts' } }),
  ], shape);
  assert.deepEqual(items.pop().picture, { kind: 'benefit', benefit: 'security', area: 'accounts', token: null }, 'the feed row\'s own benefit counts too');
  assert.deepEqual(items.map((i) => i.picture.kind), ['shots', 'benefit', 'decision', 'decision', 'benefit']);
  assert.equal(items[1].picture.benefit, 'fixed');
  assert.equal(items[2].picture.decision, 'close_issue');
  assert.equal(items[3].picture.decision, 'decision', 'an unknown decision kind is drawn as a group decision');
  assert.deepEqual(items[4].picture, { kind: 'benefit', benefit: 'speed', area: 'messages', token: { before: '85 KB', after: '46 KB' } }, 'a declared benefit wins over the guess');
  for (const i of items) assert.match(i.ground, /^#[0-9A-F]{6}$/i);
});

test('the benefit is read from the title first, the summary only for work nobody sees', () => {
  const g = model.guessBenefit;
  assert.equal(g('Make the deferred tap-save tests run on mock timers'), 'behind');
  assert.equal(g('Add a one-tap light/dark switch to the top bar'), 'effort');
  assert.equal(g('Usage analytics are off by default, with a Share usage analytics switch'), 'security');
  assert.equal(g('Add rest timer to Gym Tracker'), 'more', '"Tracker" in a name is not privacy');
  assert.equal(g('Stop the rest timer when you go back from a workout'), 'fixed');
  assert.equal(g('Explain retry limit with last deploy error in Build log panel'), 'clarity');
  assert.equal(g('Polish the home lobby'), 'results');
  assert.equal(g('Category', 'Nothing in the game changes.'), 'behind');
  assert.equal(g('Category'), 'more');
});

test('the area is the project for an app, and named for Homeroom itself', () => {
  assert.equal(model.guessArea('Add a timer', 'gym-tracker-1'), 'app');
  assert.equal(model.guessArea('The Mayor answers in threads', model.PLATFORM_SLUG), 'agents');
  assert.equal(model.guessArea('Votes show at once', model.PLATFORM_SLUG), 'proposals');
  assert.equal(model.guessArea('Something else', model.PLATFORM_SLUG), 'platform');
});

test('the change line is the first declared change, else the first sentence, never a wall', () => {
  assert.equal(model.changeLine('A link nobody used says so.', 'Long summary. More.'), 'A link nobody used says so.');
  assert.equal(model.changeLine('', 'What changes for people Nothing in the game changes. The tests do.'), 'Nothing in the game changes.');
  const long = model.changeLine('', 'word '.repeat(80));
  assert.ok(long.length <= 141 && long.endsWith('…'), long);
  assert.equal(model.cleanTitle('implement this change in the app: TITLE: Add comments'), 'Add comments');
});

test('changes come first, group decisions after', () => {
  const order = model.orderForReview([{ key: 'g1', kind: 'governance' }, { key: 'p1', kind: 'proposal' }, { key: 'g2', kind: 'governance' }, { key: 'p2', kind: 'proposal' }]);
  assert.deepEqual(order.map((i) => i.key), ['p1', 'p2', 'g1', 'g2']);
});

test('the title shot zooms in on the biggest change, not every change at once', () => {
  const busy = { ...SCREEN, regions: [{ n: 1, a: [10, 10, 40, 20], b: null }, { n: 2, a: [20, 600, 300, 120], b: null }] };
  assert.deepEqual(model.largestRegion(busy), { x: 20, y: 600, w: 300, h: 120 });
  const crop = model.titleCrop(busy, { w: 300, h: 200 });
  assert.ok(crop.place.ty < -400, 'it moves to the big change far down the screen');
});

test('a project\'s Needs you draws the same flow when the switch is on', () => {
  const src = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(src, /const reviewFlow = useReviewFlowEnabled\(\);/);
  assert.match(src, /tab === 'needs' && reviewFlow && slug \? \([\s\S]*?<ProjectReviewFlow slug=\{slug\}/);
  const flow = read('frontend/src/features/review-flow/review-flow.tsx');
  assert.match(flow, /export function ProjectReviewFlow\(/);
  assert.match(flow, /all\.filter\(\(it\) => it\.app && it\.app\.slug === slug\)/);
});


// ── 6. The title shot's composition (the prototype's rules) ─────────────

const CARD = { w: 358, h: 268 };
function screenWith(regions, over = {}) {
  return { viewport: 'phone', width: 390, before: { url: 'b.png', height: 844 }, after: { url: 'a.png', height: 844 }, regions, ...over };
}

test('one change: 62% of the binding side, or real size when it fits, centred at 48%, never past the captured pixels', () => {
  // A small control (60x30): real size fits, so it is not blown up past 1x.
  const small = model.composeTitle(model.piecesOf([screenWith([{ n: 1, a: [100, 200, 60, 30], b: null }])]), CARD, '#ECE6CE');
  assert.equal(small.rule, 'single');
  const p = small.plates[0];
  assert.ok(Math.abs(p.img.width - 390) < 0.5, 'shown at 1x: the still has one pixel per point');
  assert.ok(Math.abs((p.y + p.h / 2) - CARD.h * 0.48) < 0.5, 'centred 48% down');
  // A wide section (370x300): framed at 62% of the binding side.
  const big = model.composeTitle(model.piecesOf([screenWith([{ n: 1, a: [10, 100, 370, 300], b: null }])]), CARD, '#ECE6CE');
  const q = big.plates[0];
  assert.ok(q.w <= CARD.w * 0.92 + 0.5 && q.h <= CARD.h * 0.92 + 0.5, 'inside the wide allowance');
  assert.ok(Math.max(q.w / CARD.w, q.h / CARD.h) >= 0.62 - 0.01, 'binding side at least 62%');
});

test('a thin strip gets real context, never a sliver', () => {
  const [piece] = model.piecesOf([screenWith([{ n: 1, a: [0, 400, 390, 20], b: null }])]);
  assert.ok(piece.box.w / piece.box.h <= 3.3, `strip widened to ${piece.box.w}x${piece.box.h}`);
});

test('noise is dropped and near areas are one piece', () => {
  const pieces = model.piecesOf([screenWith([
    { n: 1, a: [20, 100, 200, 60], b: null },
    { n: 1, a: [20, 170, 200, 40], b: null },
    { n: 0, a: [300, 700, 10, 10], b: null },
  ])]);
  assert.equal(pieces.length, 1, 'the two named areas 10px apart merge; the unnamed speck goes');
});

test('two to four changes: a grid at one common scale; too small becomes a deck', () => {
  const two = model.composeTitle(model.piecesOf([screenWith([{ n: 1, a: [20, 100, 160, 60], b: null }, { n: 2, a: [20, 500, 160, 60], b: null }])]), CARD, '#F7E07A');
  assert.equal(two.rule, 'grid');
  assert.equal(two.plates.length, 2);
  assert.ok(Math.abs(two.plates[0].img.width - two.plates[1].img.width) < 0.01, 'one common scale');
  const many = model.composeTitle(model.piecesOf([1, 2, 3, 4, 5].map(() => null).map((_, i) => screenWith([{ n: 1, a: [10, 50, 370, 300], b: null }], { after: { url: `s${i}.png`, height: 844 } }))), CARD, '#F2958A');
  assert.equal(many.rule, 'deck');
  assert.equal(many.plates.length, 4, 'a lead and three back plates at most');
  assert.ok(many.plates.slice(1).every((p) => p.img === null && /^#[0-9a-f]{6}$/.test(p.fill)), 'back plates are plain tones');
  assert.ok(many.plates[1].w < many.plates[0].w && many.plates[2].w < many.plates[1].w, 'each back plate narrower');
});
