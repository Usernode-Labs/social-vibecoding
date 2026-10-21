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
//      a No counts in one tap and may carry a line after; your own answer
//      again goes through retractVote; Next change moves to the next change
//      without a vote, and Done on the last one closes onto the feed's end.
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

test('the switch is off by default and kept on the account; a failed save changes nothing', async () => {
  assert.equal(settings.reviewFlowEnabled({ user: {} }), false);
  assert.equal(settings.reviewFlowEnabled(null), false, 'signed out reads as off');
  const app = { user: { reviewFlowEnabled: false } };
  const sent = [];
  const ok = (v) => { sent.push(v); return Promise.resolve(true); };
  assert.equal(await settings.setReviewFlowEnabled(true, app, ok), true);
  assert.deepEqual(sent, [true]);
  assert.equal(settings.reviewFlowEnabled(app), true);
  assert.equal(await settings.setReviewFlowEnabled(false, app, () => Promise.resolve(false)), false);
  assert.equal(settings.reviewFlowEnabled(app), true, 'the account keeps what the server has');
});

test('a device that had it on carries it over to the account once, then forgets it', async () => {
  const app = { user: { reviewFlowEnabled: false } };
  const store = memoryStorage(true);
  const sent = [];
  await settings.carryOverDeviceSwitch(app, store, (v) => { sent.push(v); return Promise.resolve(true); });
  assert.deepEqual(sent, [true]);
  assert.equal(app.user.reviewFlowEnabled, true);
  assert.equal(store.map.has(settings.REVIEW_FLOW_STORAGE_KEY), false);
  await settings.carryOverDeviceSwitch(app, store, (v) => { sent.push(v); return Promise.resolve(true); });
  assert.deepEqual(sent, [true], 'nothing left to carry');
  const failing = memoryStorage(true);
  await settings.carryOverDeviceSwitch({ user: { reviewFlowEnabled: false } }, failing, () => Promise.resolve(false));
  assert.equal(failing.map.get(settings.REVIEW_FLOW_STORAGE_KEY), '1', 'kept to try again when the save failed');
});

test('the server keeps the switch on the account and serves it with the user', () => {
  assert.match(read('src/db/schema.sql'), /ALTER TABLE users ADD COLUMN IF NOT EXISTS review_flow_enabled BOOLEAN NOT NULL DEFAULT FALSE;/);
  const routes = read('src/routes/auth.js');
  assert.match(routes, /router\.post\('\/api\/me\/review-flow'[\s\S]{0,400}UPDATE users SET review_flow_enabled = \$1 WHERE id = \$2/);
  assert.match(routes, /reviewFlowEnabled: !!req\.user\.reviewFlowEnabled/);
  const mw = read('src/middleware/auth.js');
  assert.equal((mw.match(/review_flow_enabled/g) || []).length, 4, 'both reads select it and both shapes carry it');
  assert.match(read('src/services/global-chat/classic-capabilities.js'), /experimental: \['aiProgressEstimate', 'sessionBridgeEnabled', 'reviewFlowEnabled'\]/);
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
  assert.match(js, /getElementById\('review-flow-enabled'\)[\s\S]{0,400}UsernodeReact\?\.reviewFlow[\s\S]{0,80}setEnabled\(e\.target\.checked\)[\s\S]{0,80}if \(!ok\) reviewToggle\.checked = !!pref\?\.enabled\(\)/);
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

test('the switch names the side most of the window shows, with hysteresis, and colour follows share', () => {
  assert.equal(compare.viewFor(0.55, 'after'), 'after');
  assert.equal(compare.viewFor(0.6, 'after'), 'before');
  assert.equal(compare.viewFor(0.45, 'before'), 'before');
  assert.equal(compare.viewFor(0.4, 'before'), 'after');
  assert.equal(compare.saturationFor(0.5), 1);
  assert.equal(compare.saturationFor(0.25), 0.5);
  assert.equal(compare.saturationFor(0), 0);
});

test('the magnifier shows what is under the finger at the zoom, and stays inside the window', () => {
  const place = { scale: 1.2, tx: -10, ty: -40 };
  const lens = compare.lensPlace(place, { x: 100, y: 80 }, 2.5, 132);
  assert.equal(lens.scale, 3, 'the drawn scale times the zoom');
  const layerX = (100 - place.tx) / place.scale;
  const layerY = (80 - place.ty) / place.scale;
  assert.ok(Math.abs(lens.tx + layerX * lens.scale - 66) < 1e-9, 'the point lands at the circle\'s centre');
  assert.ok(Math.abs(lens.ty + layerY * lens.scale - 66) < 1e-9);
  const identity = compare.lensPlace(null, { x: 50, y: 20 }, 2.5, 132);
  assert.equal(identity.scale, 2.5, 'a whole pair magnifies by the zoom alone');

  const size = { w: 366, h: 275 };
  assert.deepEqual(compare.lensBox({ x: 183, y: 200 }, size, 132, 0), { x: 117, y: 134 }, 'a mouse: centred under the pointer');
  assert.deepEqual(compare.lensBox({ x: 183, y: 200 }, size, 132, 24), { x: 117, y: 44 }, 'a finger: raised clear of the fingertip');
  assert.deepEqual(compare.lensBox({ x: 0, y: 0 }, size, 132, 0), { x: 0, y: 0 });
  assert.deepEqual(compare.lensBox({ x: 366, y: 275 }, size, 132, 0), { x: 234, y: 143 });
  assert.deepEqual(compare.lensBox({ x: 366, y: 275 }, size, 132, 24), { x: 234, y: 119 }, 'inside at every edge');
});

test('a still press of a third of a second opens the magnifier; moving early does not', () => {
  const src = read('frontend/src/features/review-flow/compare.tsx');
  assert.match(src, /const HOLD_TO_ZOOM = 300;/);
  assert.match(src, /const LENS_ZOOM = 2\.5;/);
  assert.match(src, /Math\.hypot\(dx, dy\) > HOLD_SLOP\) clearTimeout\(zoomTimer\.current\)/, 'moving off the spot cancels the hold');
  assert.match(src, /Math\.abs\(dy\) > 8 && Math\.abs\(dy\) > Math\.abs\(dx\)/, 'the vertical threshold is unchanged');
  assert.match(src, /Math\.abs\(dx\) < 6/, 'the drag threshold is unchanged');
  assert.match(src, /addEventListener\('touchmove', hold, \{ passive: false \}\)/, 'the page does not scroll while the magnifier is open');
  assert.match(src, /if \(lensRef\.current\) \{\n\s+const p = pointAt\(e\)/, 'once open it follows the finger, not the seam');
  assert.match(src, /className="rf-lens"\s+aria-hidden="true"/, 'the magnifier is visual only');
  assert.match(src, /onContextMenu=\{\(e\) => e\.preventDefault\(\)\}/, 'the phone\'s long-press menu stays shut');

  const css = read('public/css/app.css');
  assert.match(css, /\n\.rf-lens \{ position: absolute; left: 0; top: 0; z-index: 6; width: 132px; height: 132px; border-radius: 999px;/);
  assert.match(css, /\.rf-compare \{[^}]*\-webkit-touch-callout: none;/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\n  \.rf-sheet, \.rf-scrim, \.rf-seam, \.rf-cap, \.rf-switch, [^}]*\{ transition: none; \}\n  \.rf-lens \{ animation: none; \}/,
    'the magnifier opens at once when motion is reduced',
  );
});

test('each side carries its own caption, and the seam wipes it with its picture', () => {
  const src = read('frontend/src/features/review-flow/compare.tsx');
  // The After caption lies over the after picture; the Before caption is
  // inside the clip with the before picture, so the seam cuts both alike.
  assert.match(src, /<div className="rf-cap rf-cap-after"[\s\S]*?<div className="rf-layer-clip"/);
  assert.match(src, /<div className="rf-layer-clip"[^>]*>\s*<div className="rf-layer"[^>]*>\{img\(before, 'before'\)\}<\/div>\s*<div className="rf-cap rf-cap-before"/);
  assert.match(src, /RichMessage id="communities:review\.compare\.captionAfter"/);
  assert.match(src, /RichMessage id="communities:review\.compare\.captionBefore"/);
  assert.equal(message('communities:review.compare.captionBefore'), 'Before <0>· Today</0>');
  assert.equal(message('communities:review.compare.captionAfter'), '<0>If it passes ·</0> After');
  assert.doesNotMatch(src, /rf-pill|rf-tab/, 'the pill and the ›› tab are gone');
});

test('the switch flips the view and its knob says which side, a press leans the seam in', () => {
  const src = read('frontend/src/features/review-flow/compare.tsx');
  assert.match(src, /role="switch"\s+aria-checked=\{word === 'before'\}/);
  assert.match(src, /const LEAN = 0\.08;/);
  assert.match(src, /onPointerDown=\{switchDown\}/);
  assert.match(src, /onClick=\{flip\}/);
  // A flip pins the knob to where it was sent while the seam glides there.
  assert.match(src, /pinned\.current = true;\s*setView\(to > 0 \? 'before' : 'after'\);\s*glide\(to, 320/);
  assert.match(src, /closest\('\[data-rf-switch\]'\)\) return;/, 'a press on the switch never starts a drag');
  const css = read('public/css/app.css');
  assert.match(css, /\.rf-switch \{ position: absolute; left: 50%; bottom: 12px;[^}]*width: 72px; height: 40px;/);
  assert.match(css, /\.rf-switch\[data-view="before"\] \.rf-knob \{ left: 2\.5px;/, 'Before on the left');
  assert.match(css, /\.rf-knob \{ position: absolute; top: 2\.5px; left: 34\.5px;/, 'After on the right');
});

test('the hero takes the page\'s free height, never shorter than 4:3 or taller than 3:2', () => {
  const flow = loadTsx('frontend/src/features/review-flow/review-flow.tsx');
  assert.equal(flow.heroHeight(351, 704, false), 704 - 292, 'a phone: what the page leaves');
  assert.equal(flow.heroHeight(351, 400, false), Math.round(351 * 0.75), 'a short window keeps 4:3');
  assert.equal(flow.heroHeight(351, 2000, false), Math.round(351 * 1.5), 'a tall one stops at 3:2');
  assert.equal(flow.heroHeight(351, 704, true), 704 - 292 - 76, 'thumbnails take their row');
});

// ── 2b. The preview card ────────────────────────────────────────────────

test('the change page sets its picture and thumbnails apart in an inset card', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  assert.match(src, /const PREVIEW_INSET = 12;/);
  // The hero is drawn the card's inner width, one inset off each page edge.
  assert.match(src, /const inner = Math\.max\(0, width - PREVIEW_INSET \* 2\);/);
  assert.match(src, /width=\{inner\} height=\{height\}/, 'the slider is drawn at the card\'s inner width');
  assert.match(src, /<div className="rf-preview">\s*\{visual \? \(/, 'the hero is inside the card');
  assert.match(
    src,
    /<div className="rf-thumbs"[\s\S]*?<\/div>\s*\) : null\}\s*<\/div>\s*\{item\.line \? <p className="rf-claim">/,
    'the thumbnails are inside the card and the claim follows it',
  );
  const css = read('public/css/app.css');
  const rule = css.match(/\n\.rf-preview \{[^}]*\}/)[0];
  assert.match(rule, /margin: 12px 12px 0;/);
  assert.match(rule, /border-radius: 24px;/);
  assert.match(rule, /background: var\(--rf-sheet\);/);
  assert.match(rule, /box-shadow: 0 0 0 1px var\(--rf-line\);/);
  assert.match(css, /\.rf-preview \.rf-thumb\[aria-pressed="true"\] \{ box-shadow: 0 0 0 2px var\(--rf-sheet\), 0 0 0 4px var\(--lit-ink\); \}/);
  assert.match(css, /\.rf-claim \{ margin: 0; padding: 20px 16px 0 20px;/, 'the description starts further below the card');
  // The opening ghost lands on the inset card, edges rounded like it.
  assert.match(src, /const k = \(page\.width - PREVIEW_INSET \* 2\) \/ card\.width;/);
  assert.equal((src.match(/heroTransform\(cr, pr, headH\), borderRadius: '24px'/g) || []).length, 2);
});

// ── 3. The vote ──────────────────────────────────────────────────────────

test('votes go through castVote with the epoch, a No may carry a line, a vote taken back goes through retractVote', () => {
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

test('Next change goes to the next change with no vote, wraps to an earlier one, and skips what you voted on', () => {
  const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  assert.equal(model.nextIndex(items, 0, {}), 1, 'nothing voted: the next one');
  assert.equal(model.nextIndex(items, 2, {}), 0, 'the last wraps to the first');
  assert.equal(model.nextIndex(items, 0, { b: 'yes' }), 2, 'a voted change is skipped');
  assert.equal(model.nextIndex(items, 1, { c: 'yes' }), 0, 'the one behind you, unvoted');
  assert.equal(model.nextIndex(items, 0, { b: 'yes', c: 'yes' }), -1, 'every other change has a vote');
  assert.equal(model.nextIndex([{ key: 'a' }], 0, {}), -1, 'a single change has none');
  const withDecision = [{ key: 'a' }, { key: 'g', kind: 'governance' }, { key: 'b' }];
  assert.equal(model.nextIndex(withDecision, 0, {}), 2, 'a group decision opens its own page and is skipped');
  assert.equal(model.nextIndex(withDecision, 2, { a: 'yes' }), -1, 'and it does not keep all-done from showing');
});

test('the sheet covers the page only while its help or menu is open', () => {
  for (const s of ['ask', 'voted', 'reason']) assert.equal(sheet.sheetOpen(s), false, s);
  for (const s of ['unsure', 'askq', 'talk', 'try', 'about', 'more']) assert.equal(sheet.sheetOpen(s), true, s);
});

function sheetHtml(props) {
  const [item] = model.toReviewItems([feedItem()], () => ({ screens: [SCREEN] }));
  return renderToHtml(createElement(sheet.VoteSheet, {
    item, vote: null, state: 'ask', setState() {}, onVote: async () => true, onUndo: async () => true,
    onNext() {}, hasNext: true, maxHeight: 600, ...props,
  }));
}

test('Next change passes the votes, and Done on the last one closes onto the feed\'s end', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  assert.match(src, /nextIndex\(list, open\.index, votes\)/);
  assert.match(src, /if \(n < 0\) \{ finishAll\(\); return; \}/);
  const at = src.indexOf('const finishAll = ');
  const finish = src.slice(at, src.indexOf('};', at));
  assert.match(finish, /takeDown\(\)/);
  assert.match(finish, /\[data-rf-end\]/, 'the feed\'s own end comes into view');
  assert.doesNotMatch(finish, /onDone\(\)/, 'Done no longer leaves the feed');
  // A list your votes emptied shows the end, centred, not the empty line.
  assert.match(src, /if \(!list\.length && Object\.keys\(votes\)\.length\) \{[\s\S]*?rf-end rf-end-alone/);
  assert.match(read('public/css/app.css'), /\.rf-end-alone \{ min-height: 56vh; justify-content: center;/);
});

test('at rest the vote is part of the page: Yes | No and ⋯, no sheet', () => {
  const html = sheetHtml({});
  assert.match(html, /class="rf-sheet rf-sheet-rest"/);
  assert.doesNotMatch(html, /rf-grab/, 'no handle while it rests');
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /data-rf-vote="yes"[\s\S]*rf-pair-div[\s\S]*data-rf-vote="no"/);
  assert.match(html, /data-rf-morph="help"[^>]*data-rf-unsure=""/);
  assert.match(html, /class="rf-why rf-why-off"/, 'the room for a reason is kept, empty');
});

test('⋯ opens the four help rows in a sheet', () => {
  const html = sheetHtml({ state: 'unsure' });
  assert.match(html, /class="rf-sheet"/);
  assert.match(html, /rf-grab/);
  for (const to of ['askq', 'talk', 'try', 'about']) assert.match(html, new RegExp(`data-rf-help="${to}"`));
});

test('after a vote the row stays: the pair shows the choice, ⋯ becomes Next change', () => {
  const html = sheetHtml({ vote: 'yes', state: 'voted' });
  assert.match(html, /data-rf-voted="yes"/);
  assert.match(html, /aria-checked="true"[^>]*data-rf-vote="yes"/);
  assert.match(html, /data-rf-morph="next"[^>]*data-rf-next=""/);
  assert.ok(html.includes(message('communities:review.said.next')));
  assert.ok(html.includes(message('communities:review.said.yes')), 'said for a screen reader');
  assert.doesNotMatch(html, /data-rf-undo/, 'your own answer again takes it back');
  const last = sheetHtml({ vote: 'yes', state: 'voted', hasNext: false });
  assert.ok(last.includes(message('communities:review.said.done')));
  const src = read('frontend/src/features/review-flow/vote-sheet.tsx');
  assert.match(src, /if \(vote === v\) \{ void undo\(\); return; \}/);
});

test('a No counts in one tap; a reason is offered after, held to the server\'s limit', () => {
  const src = read('frontend/src/features/review-flow/vote-sheet.tsx');
  assert.match(src, /void cast\(v\);/, 'the tap casts, nothing is asked first');
  const offered = sheetHtml({ vote: 'no', state: 'voted' });
  assert.match(offered, /data-rf-voted="no"/);
  assert.match(offered, /data-rf-why=""/);
  assert.ok(offered.includes(message('communities:review.reason.add')));
  const writing = sheetHtml({ vote: 'no', state: 'reason' });
  assert.match(writing, /class="rf-why-form"/);
  assert.match(writing, /maxLength="280"/);
  assert.ok(writing.includes(`class="rf-share">${message('communities:review.reason.share')}</button>`), 'Share sits inside the field');
  assert.match(src, /if \(await cast\('no', text\)\) setShared\(text\);/);
  assert.doesNotMatch(sheetHtml({ vote: 'yes', state: 'voted' }), /data-rf-why=""/, 'a Yes is not asked why');
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

test('a still is never shown larger than its saved pixels allow on the display', () => {
  const at = (density, display) => model.densityOf({ ...SCREEN, density }, display);
  assert.equal(at(undefined, 3), 1, 'a 1x still keeps today\'s size');
  assert.equal(at(3, 3), 1);
  assert.equal(at(3, 2), 1.5);
  assert.equal(at(8.2, 2), 4.1);
  const view = read('public/js/app-view.js');
  assert.match(view, /const density = Number\(screen\.density\) >= 1 \? Number\(screen\.density\) : 1;/);
});

test('the title flies between its two ends measured at rest, and transitions end on their last frame', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  const open = src.slice(src.indexOf("open.phase !== 'opening'"), src.indexOf('/* ── Collapse'));
  assert.ok(open.indexOf('planTitleFlight(') < open.indexOf('page.animate('), 'measured before the page moves');
  assert.match(src, /whenDone\(moving, done, OPEN_MS\)/);
  assert.match(src, /whenDone\(moving, finish, OPEN_MS \* 0\.85\)/);
  assert.match(src, /whenDone\(sliding, settle, PUSH_MS\)/);
});

// ── 7. A wide window ─────────────────────────────────────────────────────

test('on a wide window the feed is one column as wide as the page, and the cards are composed at that cap', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  const css = read('public/css/app.css');
  const cap = Number((src.match(/^const COLUMN = (\d+);$/m) || [])[1]);
  assert.equal(cap, 520, 'the change page\'s own width');
  assert.match(src, /^const GUTTERS = 32;$/m, 'the feed\'s 16px gutters, both sides');
  // The measured width is capped, so the composition never draws past the column.
  assert.match(src, /setWidth\(Math\.max\(0, Math\.min\(el\.clientWidth, COLUMN\) - GUTTERS\)\)/);
  assert.match(src, /setPageWidth\(Math\.min\(COLUMN, pr\.width\)\)/);
  assert.match(src, /const pw = pageWidth \|\| Math\.min\(COLUMN, width \+ GUTTERS\);/);
  assert.doesNotMatch(src, /Math\.min\(520\b/, 'one number, not two copies of it');
  // The CSS column is the same cap, gutters included, centred.
  const col = css.match(/\.rf-feed, \.rf-feed-note \{([^}]*)\}/);
  assert.ok(col, 'the feed and its notes share one column rule');
  assert.match(col[1], /box-sizing: border-box;/);
  assert.match(col[1], new RegExp(`max-width: ${cap}px;`));
  assert.match(col[1], /margin-left: auto; margin-right: auto;/);
  assert.match(css, /\.rf-feed \{[^}]*padding: 4px 16px 32px;/, 'the gutters GUTTERS counts');
  assert.match(css, new RegExp(`\\.rf-page \\{[^}]*left: max\\(0px, calc\\(50% - ${cap / 2}px\\)\\); width: min\\(100%, ${cap}px\\);`));
  // The page centres over the pane, past the sidebar, so a card grows straight up into it.
  assert.match(css, /\.rf-page-wrap \{ position: fixed; left: var\(--platform-rail-w, 0px\); right: 0;/);
  // Every state of the feed sits in the column: cards and the end inside .rf-feed, the notes beside it.
  assert.match(src, /<p className="rf-feed-note [^"]*" data-needs-error="">/);
  assert.match(src, /<p className="rf-feed-note [^"]*" data-needs-empty="" data-review-flow="">/);
  assert.match(src, /<div className="rf-feed rf-loading" data-review-flow=""/);
});

test('from 768px the change page is a panel under the header, its vote sheet at its foot, the pane dimmed behind it', () => {
  const src = read('frontend/src/features/review-flow/review-flow.tsx');
  const css = read('public/css/app.css');
  const at = css.indexOf('.rf-page-dim { display: none; }');
  assert.ok(at > 0, 'the dim is drawn on a wide window only');
  // After the sheet's own rules, so the panel's foot overrides them at equal specificity.
  assert.ok(at > css.indexOf('\n.rf-sheet {'), 'the panel block follows the sheet\'s rules');
  const block = css.slice(at, css.indexOf('\n}\n', at) + 3);
  assert.match(block, /@media \(min-width: 768px\) \{/, 'a phone keeps the full page');
  // Under the app's header, measured by the shell's own tokens, never over it.
  assert.match(block, /\.rf-page-wrap \{\s*top: calc\(var\(--browser-banner-h, 0px\) \+ var\(--platform-header-h\) \+ var\(--platform-safe-top, 0px\)\);/);
  assert.match(block, /--rf-room: calc\(100dvh - var\(--browser-banner-h, 0px\) - var\(--platform-header-h\) - var\(--platform-safe-top, 0px\) - var\(--platform-tabs-h, 0px\) - 32px\);/, '16px clear above and below');
  // A rounded panel as tall as what it holds, up to the room; the stage scrolls past it.
  assert.match(block, /\.rf-page \{ top: 16px; bottom: auto; max-height: var\(--rf-room\); border-radius: 20px; box-shadow: 0 0 0 1px var\(--rf-line\), [^;]+; \}/);
  assert.match(block, /\.rf-stage \{ flex: 0 1 auto; \}/);
  // The vote sheet is the panel's foot, not a sheet pinned to the window.
  assert.match(block, /\.rf-sheet \{ max-height: calc\(var\(--rf-room\) - 52px\); border-radius: 0; box-shadow: inset 0 1px 0 var\(--rf-line\); \}/);
  // The pane behind is dimmed, and a click on it is Back.
  assert.match(block, /\.rf-page-dim \{ display: block; position: absolute; inset: 0; [^}]*pointer-events: auto; \}/);
  assert.match(src, /<div ref=\{dimRef\} className="rf-page-dim" onClick=\{close\} aria-hidden="true" \/>\s*<div ref=\{pageRef\} className="rf-page"/);
  assert.match(src, /dimRef\.current\?\.animate\(\[\{ opacity: 0 \}, \{ opacity: 1 \}\], opts\)/, 'the dim fades in as the card opens');
  assert.match(src, /dimRef\.current\?\.animate\(\[\{ opacity: 1 \}, \{ opacity: 0 \}\], opts\)/, 'and out as it closes');
  // The card opens onto the panel's own corners and closes from them; a phone's are none.
  assert.equal((src.match(/clipPath: `inset\(0px 0px 0px 0px round \$\{restRadius\(page\)\}\)`/g) || []).length, 2);
  assert.match(src, /function restRadius\(page: HTMLElement\): string \{\s*return getComputedStyle\(page\)\.borderTopLeftRadius \|\| '0px';/);
});
