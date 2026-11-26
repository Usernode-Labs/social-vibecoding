'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
const AppView = require('../public/js/app-view.js');

const id = (char) => char.repeat(32);
const url = (char) => `/api/apps/demo/proposals/42/shots/${id(char)}`;

function shots(overrides = {}) {
  return {
    state: 'verified',
    required: true,
    claims: [{
      id: 'dialog',
      claim: 'Typing shows <matching> users & keeps "Invite" visible.',
      persona: 'member',
      viewports: ['desktop'],
      steps: ['Open <Members>', 'Type ma'],
      baseState: 'present',
      animation: 'steps',
    }],
    baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), planHash: 'c'.repeat(64),
    shotResults: [{ id: 'dialog', status: 'ready', reason: null }],
    verifiedReason: null,
    artifacts: [
      { id: id('1'), storyId: 'dialog', viewport: 'desktop', side: 'base', variant: 'focus', media: 'png', url: url('1') },
      { id: id('2'), storyId: 'dialog', viewport: 'desktop', side: 'head', variant: 'focus', media: 'png', url: url('2') },
      { id: id('3'), storyId: 'dialog', viewport: 'desktop', side: 'base', variant: 'context', media: 'png', url: url('3') },
      { id: id('4'), storyId: 'dialog', viewport: 'desktop', side: 'head', variant: 'context', media: 'png', url: url('4') },
      // A server bug or injected object cannot turn an absolute URL into media.
      { id: id('6'), storyId: 'dialog', viewport: 'desktop', side: 'head', variant: 'focus', media: 'png', url: 'https://evil.example/x.png' },
    ],
    ...overrides,
  };
}

// A run from before shots: one paired before/after recording per viewport.
function legacyPaired() {
  return { id: id('5'), storyId: 'dialog', viewport: 'desktop', side: 'paired', variant: 'animation', media: 'webm', url: url('5') };
}

function clipArtifacts(storyId = 'dialog') {
  return [
    { id: id('7'), storyId, viewport: 'desktop', side: 'base', variant: 'animation', media: 'webm', url: url('7') },
    { id: id('8'), storyId, viewport: 'desktop', side: 'head', variant: 'animation', media: 'webm', url: url('8') },
  ];
}

// ── The one before & after viewer (review-flow/shots-viewer.tsx) ─────────
//
// A change's shots are drawn by one viewer everywhere: the Needs you page's
// slider (review-flow/compare.tsx), under it the run's screens as tiles and
// the changes each screen shows, then the changes no screen shows and what
// the shots agent noticed besides. ShotsPanel is the About sheet's and the
// admin gallery's whole Before & after; ShotDetails is Details' part.
// Effects do not run here (tests/lib/render-tsx.js), so the picture itself
// is not drawn until a width is measured: what it would show is pinned
// through the viewer's model (review-flow/shots-model.ts readShots).

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const viewerModule = loadTsx('frontend/src/features/review-flow/shots-viewer.tsx');
const panelModule = loadTsx('frontend/src/features/review-flow/shots-panel.tsx');
const modelModule = loadTsx('frontend/src/features/review-flow/shots-model.ts');
const compareModule = loadTsx('frontend/src/features/review-flow/compare.tsx');

// The screens Needs you draws, in a mode: what the viewer is handed.
const shape = (visuals, value, theme) => AppView._workshopVisuals(visuals, value, theme);
const read = (value, opts = {}) => modelModule.readShots(value, { sessionId: 42, shape, ...opts });

// The panel and the run's state read AppView's words through `window`.
function withWindow(fn) {
  const had = Object.hasOwn(globalThis, 'window');
  const previous = globalThis.window;
  globalThis.window = { AppView, PlatformI18n: globalThis.PlatformI18n };
  try { return fn(); } finally {
    if (had) globalThis.window = previous; else delete globalThis.window;
  }
}
const render = (Component, props) => withWindow(() => renderToHtml(createElement(Component, props)));
/** The About sheet's and the admin gallery's whole Before & after. */
const card = (value, sessionId = 42) => render(panelModule.ShotsPanel, { source: { shots: value, sessionId } });
/** The change page's Before and after: the viewer alone. */
const viewer = (value, props = {}) => render(viewerModule.ShotsViewer, { source: { shots: value, sessionId: 42 }, shape, ...props });
/** Details' Before & after part. */
const details = (value, canRetake = false) => render(panelModule.ShotDetails, { source: { shots: value, sessionId: 42 }, canRetake });

test('verified cards list the declared change under its screen, escaped, authenticated, and never autoplay', () => {
  const value = shots();
  value.artifacts.push(legacyPaired());
  const html = card(value);
  assert.match(html, /Typing shows &lt;matching&gt; users &amp; keeps &quot;Invite&quot; visible/);
  assert.doesNotMatch(html, /<matching>|evil\.example|\/visuals\//);
  assert.match(html, /<li class="shots-change" data-shots-n="1" data-shots-change="dialog">[\s\S]*Play interaction/,
    'the change and its clip are described under the screen that shows it');
  assert.doesNotMatch(html, /class="shots-claims"/, 'nothing is left to list below the screen');
  assert.match(html, /aria-label="Before &amp; after"/);
  assert.match(html, /<video[^>]* controls=""[^>]* preload="none"[^>]* muted=""[^>]* playsInline=""/i);
  assert.doesNotMatch(html, /<video[^>]*\bautoplay\b/i);
  assert.match(html, /before <code>aaaaaaaa<\/code>/);
  assert.match(html, /after <code>bbbbbbbb<\/code>/);
  assert.match(html, /screenshots <code>cccccccccccc<\/code>/);
  assert.match(html, /Screenshots ready/);
  assert.match(html, /Screenshot details/);
  assert.match(html, /taken by the screenshot agent/);
  assert.match(html, /Look at the screenshots and clips to decide whether they show the change\./);
  // The retired replay vocabulary is gone.
  assert.doesNotMatch(html, /Visual change preview|clean replays|bounded repair|relative-pointer|Captured/);
  // The picture is the run's own stills, this change's, never another address.
  const model = read(value);
  assert.equal(model.screens.length, 1);
  assert.deepEqual([model.screens[0].pair.before, model.screens[0].pair.after], [url('3'), url('4')]);
});

test('a legacy paired recording still plays, labelled by what the change declared', () => {
  const steps = shots();
  steps.artifacts.push(legacyPaired());
  const interaction = viewer(steps);
  assert.match(interaction, /Play interaction/);
  assert.match(interaction, new RegExp(`<video class="shots-clip-video" src="${url('5')}"`));
  assert.doesNotMatch(interaction, /data-shots-clips/);

  const motion = shots();
  motion.claims[0].animation = 'motion';
  motion.artifacts.push(legacyPaired());
  const html = viewer(motion);
  assert.match(html, /Play animation/);
  assert.doesNotMatch(html, /Play interaction/);
});

test('a motion change with a clip per side shows a before and an after player', () => {
  const value = shots();
  value.claims[0].animation = 'motion';
  value.artifacts.push(...clipArtifacts());
  const html = card(value);
  const change = /<li class="shots-change" data-shots-n="1" data-shots-change="dialog">[\s\S]*?<\/li>/.exec(html)[0];
  assert.match(change, /data-shots-clips="1"/, 'the clips sit with their change');
  const players = change.match(/<video [^>]*>/g) || [];
  assert.equal(players.length, 2);
  assert.match(players[0], new RegExp(`src="${url('7')}"`));
  assert.match(players[0], new RegExp(`poster="${url('3')}"`), 'the before screen shot is the before poster');
  assert.match(players[1], new RegExp(`src="${url('8')}"`));
  assert.match(players[1], new RegExp(`poster="${url('4')}"`));
  for (const player of players) {
    assert.match(player, / controls="" preload="none" muted="" playsInline=""/);
    assert.doesNotMatch(player, /\bautoplay\b/i);
  }
  assert.match(change, /Before clip/);
  assert.match(change, /After clip/);
  // Side-by-side clips replace the legacy paired player.
  assert.doesNotMatch(html, /Play animation|Play interaction/);
  assert.match(html, /Look at the screenshots and clips/);

  // A clip missing on one side says so rather than hiding the other.
  const oneSided = shots();
  oneSided.claims[0].animation = 'motion';
  oneSided.artifacts.push(clipArtifacts()[1]);
  const partial = viewer(oneSided);
  assert.match(partial, /data-shots-clips="1"/);
  assert.match(partial, /No clip/);
  assert.equal((partial.match(/<video /g) || []).length, 1);

  // A clip URL for another proposal is never played.
  const foreign = shots();
  foreign.claims[0].animation = 'motion';
  foreign.artifacts.push(...clipArtifacts().map((clip) => ({ ...clip, url: clip.url.replace('/42/', '/43/') })));
  assert.doesNotMatch(viewer(foreign), /<video|data-shots-clips/);
});

test('each screen is one picture for the slider, both sides from the run, starting on After', () => {
  const model = read(shots());
  assert.equal(model.screens.length, 1);
  const [screen] = model.screens;
  assert.equal(screen.viewport, 'desktop');
  assert.deepEqual(screen.claims, [1]);
  // The slider draws the pair: After over Before, the switch between them.
  const html = renderToHtml(createElement(compareModule.CompareSlider, {
    screen: null, pair: { before: screen.pair.before, after: screen.pair.after },
    ground: '#fff', width: 600, height: 400, marks: true,
  }));
  assert.match(html, /role="slider"/);
  assert.match(html, new RegExp(`src="${url('4')}"`), 'the after side');
  assert.match(html, new RegExp(`src="${url('3')}"`), 'the before side');
  assert.match(html, /data-rf-switch="" data-view="after"/, 'it starts on After');
  assert.doesNotMatch(html, /<script|onclick/);
});

test('a screen\'s size and who it was seen as are said under it, in CSS pixels', () => {
  const value = shots({
    claims: [{ ...shots().claims[0], viewports: ['desktop', 'phone'] }],
    artifacts: [
      ...shots().artifacts.map((artifact) => (artifact.variant === 'context' ? { ...artifact, width: 1280, height: 800 } : artifact)),
      { id: id('a'), storyId: 'dialog', viewport: 'phone', side: 'base', variant: 'context', media: 'png', url: url('a'), width: 390, height: 844 },
      { id: id('b'), storyId: 'dialog', viewport: 'phone', side: 'head', variant: 'context', media: 'png', url: url('b'), width: 390, height: 844 },
    ],
  });
  const [desktop, phone] = read(value).screens;
  assert.deepEqual(desktop.size, { width: 1280, height: 800 });
  assert.deepEqual(phone.size, { width: 390, height: 844 });
  assert.match(card(value), /Desktop, 1280 × 800 · seen as a member/);
  assert.match(viewer(value, { expanded: true }), /Desktop, 1280 × 800 · seen as a member/);
  // The card on a change's page leaves the size to its expanded view.
  assert.doesNotMatch(viewer(value), /1280 × 800/);
  // Stills saved at device scale say the screen's own size, not their pixels.
  const dense = read({ ...value, artifacts: value.artifacts.map((artifact) => (artifact.variant === 'context'
    ? { ...artifact, width: artifact.width * (artifact.viewport === 'phone' ? 3 : 2), height: artifact.height * (artifact.viewport === 'phone' ? 3 : 2),
      density: artifact.viewport === 'phone' ? 3 : 2 }
    : artifact)) });
  assert.deepEqual(dense.screens.map((screen) => screen.size), [{ width: 1280, height: 800 }, { width: 390, height: 844 }]);
  // The picture keeps a screen's own shape (a phone is tall), within the most.
  assert.ok(viewerModule.wholeFrame(phone.pair, 400) > viewerModule.wholeFrame(desktop.pair, 400));
  assert.ok(viewerModule.wholeFrame(phone.pair, 400) <= viewerModule.PICTURE_MAX);
});

test('the run\'s screens are the slider\'s, with the changes each one shows, numbered as in the list', () => {
  const value = shots({
    claims: [
      shots().claims[0],
      { id: 'list', claim: 'The list has a new first row.', persona: 'member',
        viewports: ['desktop'], steps: ['Open the list'], baseState: 'present', animation: 'none' },
    ],
    shotResults: [{ id: 'dialog', status: 'ready' }, { id: 'list', status: 'ready' }],
    screens: [{
      viewport: 'desktop', shot: 'dialog', stories: ['dialog', 'list'],
      width: 1000, heightBefore: 500, heightAfter: 500,
      regions: [
        { story: 'dialog', b: [100, 50, 200, 40], a: [100, 50, 250, 40], bMark: null, aMark: null },
        { story: 'list', b: null, a: [0, 300, 1000, 50], bMark: [0, 300, 1000], aMark: null },
        { story: null, b: [0, 0, 1000, 20], a: [0, 0, 1000, 10], bMark: null, aMark: null },
      ],
    }],
  });
  const model = read(value);
  assert.equal(model.screens.length, 1, 'two changes on one screen share it');
  const [screen] = model.screens;
  assert.ok(screen.screen, 'the worked-out screen, as Needs you shapes it');
  assert.equal(screen.screen.after.url, url('4'));
  assert.equal(screen.screen.before.url, url('3'));
  assert.deepEqual(screen.screen.regions.map((region) => region.n), [1, 2, 0], 'the areas that differ, by the change they belong to');
  assert.deepEqual(screen.claims, [1, 2]);
  // Both changes are described under the picture, numbered; none is listed again.
  const html = viewer(value);
  assert.match(html, /<li class="shots-change" data-shots-n="1" data-shots-change="dialog"><span class="shots-change-n">1<\/span>/);
  assert.match(html, /<li class="shots-change" data-shots-n="2" data-shots-change="list"><span class="shots-change-n">2<\/span>/);
  assert.doesNotMatch(html, /class="shots-claims"/, 'no flat list repeats them');
  // The slider draws no outlines: dragging between the sides tells them apart.
  assert.doesNotMatch(html, /shots-box|shots-mark|Dashed/);

  // A run from before the screens were worked out: a picture per change and
  // size, from its own stills.
  const legacy = read({ ...value, screens: [] });
  assert.equal(legacy.screens.length, 1, 'only the change with shots gets a screen');
  assert.deepEqual(legacy.screens[0].claims, [1]);
  // The change with no screen is described below the viewer instead.
  assert.match(viewer({ ...value, screens: [] }), /<ol class="shots-claims"><li class="shots-claim" data-shots-story="list" data-shots-shot-status="ready"><span class="shots-claim-n">2<\/span>/);
  // A screen whose shots are not in this card's artifacts is not drawn.
  assert.ok(read({ ...value, screens: [{ ...value.screens[0], shot: 'list' }] }).screens.every((s) => !s.screen));
});

test('ready shots can be taken again from the card', () => {
  // After better steps or hints. Only failed and never-started runs offered it before.
  const html = card(shots());
  assert.match(html, /<button type="button" data-shots-retake="1" class="[^"]*">Take the screenshots again<\/button>/);
  assert.doesNotMatch(card(shots(), 0), /data-shots-retake/, 'no proposal id, nothing to take again');
  // The change page's card leaves it to its ⋯ menu.
  assert.doesNotMatch(viewer(shots()), /data-shots-retake/);
});

test('each screen of the run is a tile, labelled by its size, grouped by size', () => {
  const claim = (claimId, text) => ({ ...shots().claims[0], id: claimId, claim: text, viewports: ['desktop', 'phone'] });
  const context = (storyId, viewport, side, char) => ({ id: id(char), storyId, viewport, side, variant: 'context', media: 'png', url: url(char) });
  const value = shots({
    claims: [claim('dialog', 'The dialog lists matches.'), claim('list', 'The list has a new first row.')],
    shotResults: [{ id: 'dialog', status: 'ready' }, { id: 'list', status: 'ready' }],
    artifacts: [
      context('dialog', 'desktop', 'base', '1'), context('dialog', 'desktop', 'head', '2'),
      context('dialog', 'phone', 'base', '5'), context('dialog', 'phone', 'head', '6'),
      context('list', 'desktop', 'base', '3'), context('list', 'desktop', 'head', '4'),
    ],
  });
  const model = read(value);
  assert.deepEqual(model.screens.map((screen) => screen.viewport), ['desktop', 'desktop', 'phone']);
  // Each screen describes only its own change.
  assert.deepEqual(model.screens.map((screen) => screen.claims), [[1], [2], [1]]);
  const html = viewer(value);
  const tiles = html.match(/<button type="button" class="dev-thread-tile"[^>]*>/g) || [];
  assert.equal(tiles.length, 3);
  assert.match(tiles[0], /data-shots-screen="desktop" aria-pressed="true" aria-label="Screen 1 of 3: desktop"/);
  assert.match(tiles[1], /aria-pressed="false" aria-label="Screen 2 of 3: desktop"/);
  assert.match(tiles[2], /data-shots-screen="phone" aria-pressed="false" aria-label="Screen 3 of 3: phone"/);
  assert.match(html, /<p class="dev-thread-tiles-count">1 of 3 screens<\/p>/);
  // The first screen shows the dialog change only.
  assert.match(html, /data-shots-change="dialog"/);
  assert.doesNotMatch(html, /data-shots-change="list"/);
  // The list change has no phone screen, but its desktop screen describes
  // it, so nothing is listed again below the viewer.
  assert.doesNotMatch(html, /class="shots-claims"/);
  // One screen needs no tiles.
  assert.doesNotMatch(viewer(shots()), /class="dev-thread-tile"/);
  assert.match(viewer(shots()), /data-thread-tiles="0"/);
});

test('the Workshop picture\'s element shot must be readable on both sides', () => {
  const sized = (dims) => shots({
    artifacts: shots().artifacts.map((artifact) => (artifact.variant === 'focus' ? { ...artifact, ...dims(artifact) } : artifact)),
  });
  // A 46×28 crop of a corner badge: the screens lead instead, on both sides.
  assert.deepEqual(AppView._workshopVisuals(null, sized(() => ({ width: 46, height: 28 }))),
    { ...AppView._workshopVisuals(null, sized(() => ({ width: 352, height: 61 }))), before: url('3'), after: url('4') });
  assert.equal(AppView._workshopVisuals(null, sized(() => ({ width: 352, height: 61 }))).after, url('2'));
  // Readable in CSS pixels: the same badge saved at 3x is still a badge.
  assert.deepEqual(AppView._workshopVisuals(null, sized(() => ({ width: 138, height: 84, density: 3 }))),
    AppView._workshopVisuals(null, sized(() => ({ width: 46, height: 28 }))));
  assert.equal(AppView._workshopVisuals(null, sized(() => ({ width: 1056, height: 183, density: 3 }))).after, url('2'));
});

test('a privileged declared change is explicitly labelled as full admin', () => {
  const value = shots();
  value.claims[0].persona = 'full_admin';
  assert.match(card(value), /Desktop · seen as a full admin/);
});

test('a change declared for a guest is labelled as seen by a signed-out visitor', () => {
  const value = shots();
  value.claims[0].persona = 'guest';
  assert.match(card(value), /Desktop · seen as a signed-out visitor/);
});

test('a still change shows before and after PNGs without suggesting a video', () => {
  const value = shots();
  value.claims[0].animation = 'none';
  const html = card(value);
  assert.match(html, /Look at the screenshots to decide whether they show the change\./);
  assert.doesNotMatch(html, /<video|Play interaction|Play animation|shots and clips|data-shots-clips/);
  assert.equal(read(value).screens[0].pair.after, url('4'));
});

test('absence is labelled only when the author explicitly declared a new before state', () => {
  const model = read(shots());
  assert.equal(viewerModule.absentOnScreen(model, model.screens[0]), false);
  const declared = shots();
  declared.claims = [{ ...declared.claims[0], baseState: 'not_present' }];
  const absent = read(declared);
  assert.equal(viewerModule.absentOnScreen(absent, absent.screens[0]), true,
    'its before side is named "Before · not there yet"');
  assert.equal(PlatformI18n.t('changes:shots.viewer.chipBeforeAbsent'), 'Before · not there yet');
  // A missing before still: the picture is the after alone.
  const withoutBase = read(shots({ artifacts: shots().artifacts.filter((a) => a.side !== 'base') }));
  assert.equal(withoutBase.screens[0].pair.before, null);
  assert.equal(withoutBase.screens[0].pair.after, url('4'));
});

// A project's first version (services/shots-starter.js): its before build was
// the starter template's placeholder, so only the after side was taken. The
// card says so, where it opens and under the picture, instead of showing a
// missing shot.
test('a first version\'s card says New app: nothing before, and shows its after shots', () => {
  const afterOnly = (overrides = {}) => shots({
    afterOnly: true,
    artifacts: shots().artifacts.filter((artifact) => artifact.side !== 'base'),
    ...overrides,
  });
  const html = card(afterOnly());
  assert.match(html, /data-shots-state="verified" aria-label="Before &amp; after" class="space-y-3"/);
  assert.match(html, /data-shots-after-only="1"/);
  assert.match(html, /<p class="text-xs text-zinc-600 dark:text-zinc-400">New app: nothing before\. This proposal builds the app’s first real screens, so these are its after screenshots only\./);
  assert.match(html, /<p class="shots-after-only">New app: nothing before<\/p>/);
  assert.deepEqual([read(afterOnly()).screens[0].pair.before, read(afterOnly()).screens[0].pair.after], [null, url('4')],
    'the after screen is shown, alone');
  assert.doesNotMatch(html, /No screenshot|not there yet|Taken on the exact before and after builds/);
  // Even when the author declared the feature absent before, the card names the app as new.
  const declaredAbsent = afterOnly();
  declaredAbsent.claims = [{ ...declaredAbsent.claims[0], baseState: 'not_present' }];
  const model = read(declaredAbsent);
  assert.equal(viewerModule.absentOnScreen(model, model.screens[0]), false);

  // The change page's Before and after card says the same.
  const thread = viewer(afterOnly());
  assert.match(thread, /data-shots-after-only="1"/);
  assert.match(thread, /New app: nothing before/);

  // A motion change plays its after clip alone, with no empty before player.
  const motion = afterOnly({
    artifacts: [...afterOnly().artifacts, ...clipArtifacts().filter((artifact) => artifact.side === 'head')],
  });
  motion.claims = [{ ...motion.claims[0], animation: 'motion' }];
  const clips = card(motion);
  assert.match(clips, /these are its after screenshots and clips only/);
  assert.match(clips, new RegExp(`<video class="shots-clip-video" src="${url('8')}"`));
  assert.doesNotMatch(clips, /No clip|Before clip/);

  // An ordinary run is unchanged.
  assert.doesNotMatch(card(shots()), /New app|data-shots-after-only/);
});

test('a skipped change shows its reason and no media, beside a ready one', () => {
  const value = shots({
    claims: [
      { ...shots().claims[0], animation: 'none' },
      { id: 'empty', claim: 'An empty <search> says no users match.', persona: 'member',
        viewports: ['desktop'], steps: ['Type zz'], baseState: 'present', animation: 'none' },
    ],
    shotResults: [
      { id: 'dialog', status: 'ready', reason: null },
      { id: 'empty', status: 'skipped', reason: 'The member fixture has no <list> to search.' },
    ],
    // A run may publish only the screen shots; thumbnails use them.
    artifacts: shots().artifacts.filter((artifact) => artifact.variant === 'context'),
  });
  const html = card(value);
  const skipped = /<li class="shots-claim" data-shots-story="empty" data-shots-shot-status="skipped"[\s\S]*?<\/li>/.exec(html);
  assert.ok(skipped, 'the skipped change is marked');
  assert.match(skipped[0], /An empty &lt;search&gt; says no users match\./);
  assert.match(skipped[0], />Skipped</);
  assert.match(skipped[0], /The member fixture has no &lt;list&gt; to search\./);
  assert.doesNotMatch(skipped[0], /<img|<video|Screenshots ready/);
  const model = read(value);
  assert.deepEqual([model.screens[0].pair.before, model.screens[0].pair.after], [url('3'), url('4')], 'the ready change still shows its shots');
  assert.deepEqual(model.screens.map((screen) => screen.claims), [[1]], 'the skipped change has no screen');
  assert.match(html, /<li class="shots-change" data-shots-n="1" data-shots-change="dialog">/, 'the ready change is described under its screen');
  assert.doesNotMatch(html, /data-shots-story="dialog"/);

  const unexplained = card({
    ...value, shotResults: [value.shotResults[0], { id: 'empty', status: 'skipped', reason: null }],
  });
  assert.match(unexplained, /The screenshot agent could not get to this change\./);

  const summary = AppView._workshopVisuals(null, {
    ...value,
    claims: [value.claims[1], value.claims[0]],
  });
  assert.equal(summary.claim, value.claims[0].claim, 'the feed skips a change with no shots');
  assert.equal(summary.before, url('3'));
  assert.equal(summary.after, url('4'));
});

test('a ready change shows the shots agent\'s note on what its shots leave out, as text', () => {
  const noted = viewer(shots({
    shotResults: [{ id: 'dialog', status: 'ready', reason: null, note: 'The <b>Show more</b> fold needs a hidden app.' }],
  }));
  const change = /<li class="shots-change" data-shots-n="1" data-shots-change="dialog">[\s\S]*?<\/li>/.exec(noted)[0];
  assert.match(change, /<p data-shots-shot-note="1"[^>]*><span[^>]*>Not in these screenshots:<\/span> The &lt;b&gt;Show more&lt;\/b&gt; fold needs a hidden app\.<\/p>/);
  // No note, a skipped change's note, or a non-string note renders nothing.
  for (const shotResults of [
    [{ id: 'dialog', status: 'ready', reason: null }],
    [{ id: 'dialog', status: 'ready', reason: null, note: null }],
    [{ id: 'dialog', status: 'ready', reason: null, note: { html: '<b>x</b>' } }],
  ]) {
    assert.doesNotMatch(viewer(shots({ shotResults })), /data-shots-shot-note/);
  }
});

// An unchanged change (its before and after came out the same) is shown as
// a ready one was before it had its own status: its shots, then its note,
// then what the shots agent did to both builds to reach it.
test('an unchanged change shows its shots and the note that they came out the same, as a ready one', () => {
  const note = 'any visible difference. The before and after screens came out the same, so these shots cannot show this change.';
  const conditions = [{ kind: 'request_failed', request: '/api/items' }];
  const unchanged = card(shots({
    shotResults: [{ id: 'dialog', status: 'unchanged', reason: null, note, conditions }],
  }));
  const ready = card(shots({
    shotResults: [{ id: 'dialog', status: 'ready', reason: null, note, conditions }],
  }));
  assert.equal(unchanged, ready, 'the card reads it exactly as a ready change with that note');
  assert.match(unchanged, /<p data-shots-shot-note="1"[^>]*><span[^>]*>Not in these screenshots:<\/span> any visible difference\. The before and after screens came out the same/);
  assert.match(unchanged, /<p data-shots-condition="request_failed"[^>]*><span[^>]*>Controlled test:<\/span> the screenshot agent made GET \/api\/items fail on both builds/);
  assert.doesNotMatch(unchanged, /data-shots-shot-status="skipped"|>Skipped</);
});

// control_request and upload_file: a loading or error state the shots agent
// caused, or a file it chose, is said beside the shots, so nobody takes it
// for the app's own.
test('a ready change says what the shots agent did to both builds to reach it, as text', () => {
  const html = viewer(shots({
    shotResults: [{ id: 'dialog', status: 'ready', reason: null, note: 'The fold needs a hidden app.', conditions: [
      { kind: 'request_held', request: '/api/items?q=<b>' },
      { kind: 'request_failed', request: '/api/items' },
      { kind: 'sample_file', files: ['landscape.png', 'table.csv'] },
      { kind: 'evaluate', request: '/api/items' },
      { kind: 'sample_file', files: [] },
    ] }],
  }));
  const change = /<li class="shots-change" data-shots-n="1" data-shots-change="dialog">[\s\S]*?<\/li>/.exec(html)[0];
  assert.deepEqual([...change.matchAll(/data-shots-condition="([a-z_]+)"/g)].map((match) => match[1]),
    ['request_held', 'request_failed', 'sample_file']);
  assert.match(change, /Controlled test:<\/span> the screenshot agent kept GET \/api\/items\?q=&lt;b&gt; waiting on both builds, to show it loading\./);
  assert.match(change, /Controlled test:<\/span> the screenshot agent made GET \/api\/items fail on both builds, to show what happens when it does\./);
  assert.match(change, /Sample file:<\/span> the screenshot agent uploaded landscape\.png(?:, | and )table\.csv on both builds, from Homeroom(?:&#x27;|&#39;|')s own sample files\./);
  assert.ok(change.indexOf('data-shots-shot-note') < change.indexOf('data-shots-condition'), 'after what the shots leave out');
  // None recorded, or a change that is not ready: nothing is said.
  assert.doesNotMatch(viewer(shots()), /data-shots-condition/);
  const skipped = viewer(shots({
    claims: [...shots().claims, { ...shots().claims[0], id: 'other', claim: 'Another change.' }],
    shotResults: [{ id: 'dialog', status: 'ready', reason: null },
      { id: 'other', status: 'skipped', reason: 'Not reached.', conditions: [{ kind: 'request_held', request: '/api/items' }] }],
  }));
  assert.doesNotMatch(skipped, /data-shots-condition/);
});

// The shots agent's notes on clear problems it saw on the after build
// (note_problem): under a quiet small-caps label, each saying where it shows
// and whether the before build has it too, and never on a card that is not
// showing published shots.
test('problems the shots agent noticed are listed under Also noticed, quietly and as text', () => {
  const shotNotices = [
    { text: 'The <b>Newest</b> sort control overlaps the "Done" heading.', change: 'dialog', screen: 'desktop', shot: 'screen', alsoBefore: true },
    { text: 'The table is cut off at the right edge.', change: 'dialog', screen: 'phone', shot: null, alsoBefore: false },
    { text: 'An error banner shows.', change: 'dialog', screen: 'desktop', shot: null, alsoBefore: 'unknown' },
  ];
  const html = card(shots({ shotNotices }));
  const noticed = /<section class="shots-noticed" data-shots-noticed="3" aria-label="Also noticed">[\s\S]*?<\/section>/.exec(html)[0];
  assert.match(noticed, /<h3 class="shots-noticed-head">Also noticed<\/h3>/);
  const items = noticed.match(/<li class="shots-noticed-item"[\s\S]*?<\/li>/g);
  assert.equal(items.length, 3);
  assert.match(items[0], /data-shots-notice="dialog" data-also-before="true"/);
  assert.match(items[0], /<p class="shots-noticed-text">The &lt;b&gt;Newest&lt;\/b&gt; sort control overlaps the &quot;Done&quot; heading\.<\/p>/);
  assert.match(items[0], /<div class="shots-noticed-meta">Desktop · Also on the before build<\/div>/);
  assert.match(items[1], /data-also-before="false"[\s\S]*<div class="shots-noticed-meta">Phone · Not on the before build<\/div>/);
  assert.match(items[2], /data-also-before="unknown"[\s\S]*<div class="shots-noticed-meta">Desktop<\/div>/,
    'a notice nobody checked on the before build says nothing about it');
  assert.ok(html.indexOf('shots-noticed') > html.indexOf('data-shots-change="dialog"'), 'it follows the shots');
  assert.ok(html.indexOf('shots-noticed') < html.indexOf('Screenshot details'));
  // Quiet: no badge, fill or colour of its own; the card still reads ready.
  assert.doesNotMatch(noticed, /dev-badge|bg-|text-red|text-violet|Didn/);
  assert.match(html, /Screenshots ready/);

  // The change page's Before and after card lists them too, after the changes.
  assert.match(viewer(shots({ shotNotices })), /<section class="shots-noticed" data-shots-noticed="3" aria-label="Also noticed">/);
  // With more than one change, each says which one it was seen with.
  const two = shots({
    claims: [...shots().claims, { ...shots().claims[0], id: 'second', claim: 'The second change.' }],
    shotNotices: [{ ...shotNotices[0], change: 'second' }],
  });
  assert.match(card(two), /<div class="shots-noticed-meta">Change 2 · Desktop · Also on the before build<\/div>/);

  // None, or none with words: no section at all. Shot details never carries them.
  for (const value of [undefined, [], [{ text: '  ', change: 'dialog', screen: 'desktop' }], 'broken']) {
    assert.doesNotMatch(card(shots({ shotNotices: value })), /shots-noticed/);
  }
  assert.doesNotMatch(details(shots({ shotNotices })), /shots-noticed/);
  for (const state of ['planned', 'failed', 'stale']) {
    assert.doesNotMatch(card(shots({ state, shotNotices })), /Also noticed/, state);
  }
});

test('Also noticed is drawn with the shell\'s small-caps label and quiet lines', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/css/app.css'), 'utf8');
  const rule = (selector) => new RegExp(`\\n${selector.replace(/\./g, '\\.')} \\{([^}]*)\\}`).exec(css)?.[1] || '';
  const head = rule('.shots-noticed-head');
  for (const part of ['font-size: 12px', 'font-weight: 700', 'letter-spacing: .06em', 'text-transform: uppercase', 'color: var(--text-muted)']) {
    assert.ok(head.includes(part), `the label is the small-caps group label: ${part}`);
  }
  assert.match(rule('.shots-noticed-text'), /color: var\(--text-primary\)/);
  assert.match(rule('.shots-noticed-meta'), /color: var\(--text-muted\)/);
  assert.doesNotMatch(rule('.shots-noticed') + rule('.shots-noticed-text'), /background|border/);
});

test('pending or failed shots show the declared changes and status but no media or legacy fallback', () => {
  for (const state of ['planned', 'failed', 'stale']) {
    const html = card(shots({
      state,
      failureReason: state === 'failed' ? 'The dialog could not be reached.' : null,
      repairAvailable: state === 'failed',
    }));
    assert.match(html, new RegExp(`data-shots-state="${state}"`));
    assert.doesNotMatch(html, /<img|<video|\/visuals\//);
    assert.match(html, /<li>Typing shows &lt;matching&gt;/);
    // The change page's viewer draws nothing until there are shots.
    assert.equal(viewer(shots({ state })), '');
  }
  assert.equal(AppView._workshopVisuals({ after: { png: id('a') } }, shots({ state: 'failed' })), null);
});

test('after a new commit the card keeps the previous version\'s shots, labelled, under this version\'s state', () => {
  // shots-view.js `previous`: the published run a head move left, until this
  // version's shots publish (tests/shots-previous-version.test.js).
  const previous = shots();
  for (const state of ['exploring', 'failed']) {
    const html = card(shots({ state, artifacts: [], failureReason: state === 'failed' ? 'No row.' : null,
      repairAvailable: state === 'failed', previous }));
    assert.ok(html.startsWith(`<section data-shots="1" data-shots-state="${state}"`), `${state}: this version's state leads`);
    const kept = /<div class="mt-3" data-shots-previous="1">([\s\S]*)<\/div>$/.exec(html)?.[1] || '';
    assert.match(kept, /^<section data-shots-panel="1" data-shots-state="previous" aria-label="Before &amp; after"/);
    assert.match(kept, /data-shots-previous-badge="1">Previous version</);
    assert.match(kept, /Taken on the previous version of this proposal\. Screenshots of this version replace them once they are taken\./);
    assert.match(kept, /data-shots-change="dialog"/);
    assert.doesNotMatch(kept, /Screenshots ready|data-shots-retake/, 'not this version\'s, and not this version\'s to take again');
  }
  // This version's published: the previous version's are not drawn.
  assert.doesNotMatch(card(shots({ previous })), /data-shots-previous|Previous version/);
  // A previous version with no pictures, or none at all, draws nothing more.
  assert.doesNotMatch(card(shots({ state: 'exploring', artifacts: [], previous: { ...previous, artifacts: [] } })), /data-shots-previous/);
  assert.equal(AppView._shotsPrevious(shots({ state: 'exploring', previous: null })), null);
  // The change page's card draws them itself (_changeShotsView, through
  // shownShots); a version with none of its own draws nothing in the viewer.
  assert.equal(viewer(shots({ state: 'exploring', previous })), '');
  assert.equal(modelModule.shownShots(shots({ state: 'exploring', previous })).previousVersion, true);
  // The board's small picture stays this version's own.
  assert.equal(AppView._workshopVisuals(null, shots({ state: 'exploring', previous })), null);
});

test('running shots offer Stop, and a stopped or failed set offers to take them again', () => {
  const running = card(shots({ state: 'exploring', artifacts: [] }));
  assert.match(running, /Taking the screenshots/);
  assert.match(running, /<button type="button" data-shots-stop="1" class="[^"]*">Stop<\/button>/);
  assert.match(card(shots({ state: 'provisioning', artifacts: [] })), /Building before and after/);
  assert.match(card(shots({ state: 'reviewing', artifacts: [] })), /Saving the screenshots/);
  const notStarted = card(shots({ state: 'planned', artifacts: [] }));
  assert.doesNotMatch(notStarted, /data-shots-stop/, 'nothing is running to stop');

  const stopped = card(shots({
    state: 'failed', artifacts: [], failureCode: 'shots_stopped', repairAvailable: false,
    failureReason: 'Stopped before it finished.',
  }));
  assert.match(stopped, /Screenshots stopped/);
  assert.doesNotMatch(stopped, /bg-red-500\/10/, 'a stop is not a failure');
  assert.match(stopped, /data-shots-retake="1"[^>]*>Take the screenshots again</);
  assert.doesNotMatch(stopped, /data-shots-stop/);

  const failed = card(shots({
    state: 'failed', artifacts: [], failureCode: 'shots_capture_incomplete', repairAvailable: true,
    failureReason: 'The shots agent could not reach the dialog.',
  }));
  assert.match(failed, /Couldn’t take the screenshots/);
  assert.match(failed, /The shots agent could not reach the dialog\./);
  assert.match(failed, /bg-red-500\/10/);
  assert.match(failed, />Take the screenshots again</);

  const conflict = card(shots({
    state: 'failed', artifacts: [], failureCode: 'visible_changes_conflict', repairAvailable: false,
    failureReason: 'The declaration says nothing visible changed.',
  }));
  assert.doesNotMatch(conflict, /Take the screenshots again/, 'a retry that would repeat the failure is not offered');

  // The buttons are AppView's: the routes decide who may press them.
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../frontend/src/features/review-flow/shots-panel.tsx'), 'utf8');
  assert.match(source, /onClick=\{\(e\) => legacy\(\)\?\.rerunShots\?\.\(sessionId, e\.currentTarget\)\}/);
  assert.match(source, /onClick=\{\(e\) => av\?\.stopShots\?\.\(sessionId, e\.currentTarget\)\}/);
});

test('an interrupted run the platform is starting again reads as under way, not as a failure', () => {
  const retrying = card(shots({
    state: 'failed', artifacts: [], failureCode: 'shots_run_interrupted', repairAvailable: false,
    automaticRetryPending: true,
    failureReason: 'Homeroom restarted while these before & after shots were being taken. You can take them again.',
  }));
  assert.match(retrying, /Trying the screenshots again/);
  assert.match(retrying, /starts them again on its own in a moment/);
  assert.doesNotMatch(retrying, /Couldn’t take the screenshots|You can take them again/);
  assert.doesNotMatch(retrying, /bg-red-500\/10/, 'nothing has failed that needs anyone');
  assert.doesNotMatch(retrying, /Take the screenshots again/, 'the retry is already coming');

  const view = AppView._shotsView(shots({
    state: 'failed', artifacts: [], failureCode: 'shots_run_interrupted', automaticRetryPending: true,
  }));
  assert.equal(view.retrying, true);
  assert.equal(view.label, 'Trying the screenshots again');

  // Once the retries are used up, the stored reason and the manual retry are back.
  const spent = card(shots({
    state: 'failed', artifacts: [], failureCode: 'shots_run_interrupted', repairAvailable: true,
    automaticRetryPending: false,
    failureReason: 'Homeroom restarted while these before & after shots were being taken. You can take them again.',
  }));
  assert.match(spent, /Couldn’t take the screenshots/);
  assert.match(spent, />Take the screenshots again</);
});

test('a change not yet up for a vote shows its shots on its page and in the feed', () => {
  // The shots are taken once the preview is up, before anyone promotes the
  // change, so a draft is where the author first looks at them.
  const draft = { id: 42, source: 'cli_handoff', status: 'paused', shots: shots(), visuals: null };
  const view = AppView._detailActionsView('session', draft);
  assert.ok(view && view.visuals, 'the page carries the before & after');
  assert.deepEqual(view.visuals.source, { shots: draft.shots, sessionId: 42 }, 'the viewer reads the shots themselves');
  assert.equal(view.visuals.tilesHtml, undefined);
  assert.match(card(view.visuals.source.shots), /data-shots-change="dialog"/);
  // Without shots, a session still shows no legacy route capture.
  const legacyOnly = AppView._detailActionsView('session', { ...draft, shots: null, visuals: legacyPaired() });
  assert.ok(!legacyOnly || !legacyOnly.visuals, 'legacy captures stay on proposals and imported pull requests');
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/app-view.js'), 'utf8');
  assert.match(source, /\(kind === 'session' && item && item\.shots \? AppView\._workshopVisuals\(null, item\.shots\) : null\)/,
    'the feed picture follows the same rule, from the shots alone');
});

test('a proposal with nothing to show says so plainly, not in the author\'s words', () => {
  const quiet = shots({
    state: 'not_required', required: false, claims: [], artifacts: [],
    rationale: 'No rendering code changes. The bot records different text in build_error.',
  });
  const html = card(quiet);
  assert.match(html, /No before &amp; after needed/);
  assert.match(html, /This proposal has no visual changes\./);
  assert.doesNotMatch(html, /rendering code|build_error/);
  const strip = AppView._shotsView(quiet);
  assert.equal(strip.label, 'No before & after needed');
  assert.equal(strip.sentence, 'This proposal has no visual changes.');
});

test('no state of the card says "Visual change preview"', () => {
  const states = ['planned', 'provisioning', 'exploring', 'replaying', 'reviewing', 'verified',
    'failed', 'stale', 'cancelled', 'not_required', 'overridden'];
  for (const state of states) {
    for (const extra of [{}, { failureCode: 'shots_stopped' }, { notStartedReason: 'Switched off here.' }]) {
      assert.doesNotMatch(card(shots({ state, ...extra })), /visual change preview/i, `${state} ${JSON.stringify(extra)}`);
    }
  }
});

// The dark shots (#4459): a run that took them offers the other mode, a
// round moon or sun at the picture's foot. The picture starts in the page's
// mode; a side with no dark shot keeps its light one.

test('the workshop summary uses protected element shots only after verification', () => {
  const summary = AppView._workshopVisuals(null, shots());
  assert.equal(summary.protected, true);
  assert.equal(summary.before, url('1'));
  assert.equal(summary.after, url('2'));
  assert.equal(summary.claim, shots().claims[0].claim);
});

test('a run with no dark shots offers no other mode', () => {
  assert.equal(read(shots()).themes, false);
  assert.doesNotMatch(viewer(shots()), /data-shots-theme/);
  // Older runs' artifacts, with no theme on them, read as light.
  assert.equal(read(shots({ artifacts: shots().artifacts.map((artifact) => ({ ...artifact, theme: undefined })) })).themes, false);
});

test('with dark shots, the picture shows the mode asked for, and the flip offers the other', () => {
  const value = shots({
    artifacts: [
      ...shots().artifacts,
      { id: id('9'), storyId: 'dialog', viewport: 'desktop', side: 'base', variant: 'context', media: 'png', url: url('9'), theme: 'dark' },
      { id: id('0'), storyId: 'dialog', viewport: 'desktop', side: 'head', variant: 'context', media: 'png', url: url('0'), theme: 'dark' },
    ],
  });
  const light = read(value, { theme: 'light' });
  const dark = read(value, { theme: 'dark' });
  assert.equal(light.themes, true);
  assert.deepEqual([light.screens[0].pair.before, light.screens[0].pair.after], [url('3'), url('4')]);
  assert.deepEqual([dark.screens[0].pair.before, dark.screens[0].pair.after], [url('9'), url('0')]);
  // On a light page the flip offers dark; the words are the catalog's.
  const html = viewer(value);
  assert.match(html, /<button type="button" class="dev-thread-compare-theme" data-shots-theme="light" title="Show in dark mode" aria-label="Show in dark mode">/);
  assert.equal(PlatformI18n.t('changes:shots.viewer.showDark'), 'Show in dark mode');
  assert.equal(PlatformI18n.t('changes:shots.viewer.showLight'), 'Show in light mode');
  // The worked-out screens follow the mode too (_workshopVisuals' theme).
  const screens = { ...value, screens: [{ viewport: 'desktop', shot: 'dialog', width: 1280, heightBefore: 800, heightAfter: 800, regions: [] }] };
  assert.equal(read(screens, { theme: 'dark' }).screens[0].screen.after.url, url('0'));
  assert.equal(read(screens, { theme: 'light' }).screens[0].screen.after.url, url('4'));
});

test('a side with no dark shot keeps its light one in both modes', () => {
  const value = shots({
    artifacts: [
      ...shots().artifacts,
      { id: id('0'), storyId: 'dialog', viewport: 'desktop', side: 'head', variant: 'context', media: 'png', url: url('0'), theme: 'dark' },
    ],
  });
  const dark = read(value, { theme: 'dark' });
  assert.deepEqual([dark.screens[0].pair.before, dark.screens[0].pair.after], [url('3'), url('0')]);
  // The flip is still there: the after side has a dark shot to show.
  assert.equal(dark.themes, true);
});

// #5691: the viewer is its own popover, so a narrow pane can hand the shots
// to the whole window. The button is a plain popovertarget: no script, so it
// survives the innerHTML both the card and a spec's frames are drawn with.
test('the viewer is a popover and every bar ends with the button that opens it over the window', () => {
  const html = AppView._shotsViewerHtml({
    key: 42,
    screens: [{ viewport: 'desktop', afterHtml: '<span></span>', beforeHtml: '<span></span>', notesHtml: '' }],
  });
  assert.match(html, /^<div class="shots-viewer" id="shots-42-viewer" popover="auto">/);
  const buttons = html.match(/<button type="button" class="shots-expand"[^>]*>/g) || [];
  assert.equal(buttons.length, 1);
  assert.match(buttons[0], /popovertarget="shots-42-viewer" popovertargetaction="toggle" title="Expand">$/);
  // Both words are in the button, and CSS shows the one that matches:
  // the arrows out with "Expand", the arrows in with "Close" once open.
  assert.match(html, /<span class="shots-expand-out"><svg[\s\S]*?<\/svg><span class="shots-expand-word">Expand<\/span><\/span><span class="shots-expand-in"><svg[\s\S]*?<\/svg><span class="shots-expand-word">Close<\/span><\/span><\/button>/);
  assert.doesNotMatch(html, /<script|onclick|onchange/, 'still no script');
  // The catalogs' words are what it says.
  assert.equal(PlatformI18n.t('changes:shots.viewer.expand'), 'Expand');
  assert.equal(PlatformI18n.t('changes:shots.viewer.collapse'), 'Close');
});

test('the expand CSS: closed it is the same block, open a window-sized card over a dim, and hidden where popovers do not exist', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/css/app.css'), 'utf8');
  assert.match(css, /\.shots-viewer\[popover\] \{ display: block; position: relative; inset: auto; margin: 0; padding: 0; border: 0; width: auto; height: auto;\n  overflow: hidden;/,
    'closed, the UA popover box is neutralised and the viewer is the block it always was');
  assert.match(css, /\.shots-viewer:popover-open \{ position: fixed; inset: 0 var\(--platform-float-right\) 0 var\(--platform-float-left\); margin: auto; height: fit-content;[^}]*width: min\(calc\(var\(--platform-float-w\) - 48px\), calc\(\(100vh - 200px\) \* 1\.6\)\); max-height: calc\(100vh - 48px\);/,
    'open, it is nearly the window less the Duo\'s column (the float box, centred in it), in the top layer so a backdrop-filter ancestor cannot trap it');
  assert.match(css, /\.shots-viewer::backdrop \{ background: rgba\(0, 0, 0, 0\.55\); \}/);
  assert.match(css, /@supports \(height: 100dvh\) \{\n  \.shots-viewer:popover-open \{ width: min\(calc\(var\(--platform-float-w\) - 48px\), calc\(\(100dvh - 200px\) \* 1\.6\)\); max-height: calc\(100dvh - 48px\); \}/);
  assert.match(css, /\.shots-expand-in \{ display: none; \}/);
  assert.match(css, /\.shots-viewer:popover-open \.shots-expand-out \{ display: none; \}/);
  assert.match(css, /\.shots-viewer:popover-open \.shots-expand-in \{ display: inline-flex; \}/);
  assert.match(css, /\.shots-expand ~ \.shots-screen-nav \{ margin-inline-start: 0; \}/);
  assert.match(css, /@supports not selector\(:popover-open\) \{ \.shots-expand \{ display: none; \} \}/,
    'a browser without the popover API gets no button that does nothing');
});

// #6382, and now: the detail column draws the viewer as its own contents.
// There is no popover to flatten, so no rule there reaches into one.
test('in the detail column the viewer is the column\'s contents, with no popover to flatten', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/css/app.css'), 'utf8');
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => ({ selector: match[1].trim(), body: match[2] }));
  assert.ok(rules.some((rule) => rule.selector === '.gc-detail-shots' && /overflow: auto;/.test(rule.body)),
    'the column scrolls the viewer under the reader\'s header');
  assert.ok(!rules.some((rule) => rule.selector.includes('.gc-detail-shots') && /\.shots-viewer|\[popover\]/.test(rule.selector)),
    'nothing in the column reaches into a popover');
});

test('a sharp still at its own address shows like any other, and nothing else may follow the id', () => {
  // shots-view.js serves an account in the New Needs you experiment each
  // dense still at `…/shots/<id>?density=device` (#5651).
  const dense = (char) => `${url(char)}?density=device`;
  const value = shots();
  value.artifacts = value.artifacts.map((a) => (a.url.startsWith('/api/') ? { ...a, url: dense(a.id[0]), density: 2 } : a));
  const model = read(value);
  assert.equal(model.missing, false);
  assert.deepEqual([model.screens[0].pair.after, model.screens[0].pair.before], [dense('4'), dense('3')]);
  for (const bad of [`${url('4')}?density=other`, `${url('4')}?density=device&x=1`, `${url('4')}#x`, `${url('4')}?`]) {
    assert.equal(modelModule.shotUrl(bad, 42), '', `${bad} is refused`);
    const tampered = shots();
    tampered.artifacts = tampered.artifacts.map((a) => (a.url === url('4') ? { ...a, url: bad } : a));
    assert.ok(!JSON.stringify(read(tampered)).includes(bad), `${bad} is never drawn`);
  }
  // Another proposal's still is not this one's.
  assert.equal(modelModule.shotUrl(url('4').replace('/42/', '/43/'), 42), '');
  assert.equal(modelModule.shotUrl('https://evil.example/x.png', 42), '');
  // Needs you and New Needs you read the same stills through _workshopVisuals.
  const pictures = AppView._workshopVisuals(null, {
    ...value,
    claims: [{ ...value.claims[0], viewports: ['desktop'] }],
    screens: [{ viewport: 'desktop', shot: 'dialog', width: 1280, heightBefore: 800, heightAfter: 800, density: 2, regions: [] }],
  });
  assert.equal(pictures.screens.length, 1);
  assert.equal(pictures.screens[0].after.url, dense('4'));
});

// ── A failed run's retake, offered where the failure shows (issue #6551) ───

function asUser(user, fn) {
  const previous = globalThis.App;
  globalThis.App = { user };
  try { return fn(); } finally { globalThis.App = previous; }
}

function failedShots(overrides = {}) {
  return shots({
    state: 'failed', artifacts: [], failureCode: 'shots_capture_incomplete',
    repairAvailable: true, failureReason: 'The shots agent could not reach the dialog.',
    ...overrides,
  });
}

test('only the change author or an app admin may retake a failed run', () => {
  const item = { id: 42, user_id: 7, status: 'promoted', shots: failedShots() };
  assert.equal(asUser({ id: 7 }, () => AppView._canRetakeShots(item)), true, 'its author may');
  assert.equal(asUser({ id: 7, canAdminWrite: true }, () => AppView._canRetakeShots(item)), true, 'an app admin may');
  assert.equal(asUser({ id: 8 }, () => AppView._canRetakeShots(item)), false, 'nobody else may');
  assert.equal(asUser({ id: 42 }, () => AppView._canRetakeShots({ ...item, user_id: 8 })), false, 'not even another change');
  // An app admin without the write flag, through the board's own context.
  const ctx = AppView._proposalsCtx;
  AppView._proposalsCtx = { ...(ctx || {}), isAppAdmin: true };
  try {
    assert.equal(asUser({ id: 8 }, () => AppView._canRetakeShots(item)), true);
  } finally { AppView._proposalsCtx = ctx; }
  // A read-only viewer sees no retake even on their own change.
  const appData = AppView.appData;
  AppView.appData = { can_collaborate: false };
  try {
    assert.equal(asUser({ id: 7 }, () => AppView._canRetakeShots(item)), false);
  } finally { AppView.appData = appData; }
  // Nothing to press while the platform is already retrying, or when the
  // declaration itself says nothing visible changed.
  assert.equal(asUser({ id: 7 }, () => AppView._canRetakeShots({ ...item, shots: failedShots({ automaticRetryPending: true }) })), false);
  assert.equal(asUser({ id: 7 }, () => AppView._canRetakeShots({ ...item, shots: failedShots({ failureCode: 'visible_changes_conflict' }) })), false);
  // Only a failed run has a retake worth offering.
  for (const state of ['planned', 'provisioning', 'exploring', 'replaying', 'reviewing', 'verified', 'stale', 'cancelled', 'not_required', 'overridden']) {
    assert.equal(asUser({ id: 7 }, () => AppView._canRetakeShots({ ...item, shots: { state } })), false, state);
  }
});

test('a failed run’s Details reading says what happened, and retakes only for a reader allowed to', () => {
  const failed = failedShots();
  const seen = details(failed);
  assert.match(seen, /Couldn’t take the screenshots/);
  assert.match(seen, /The shots agent could not reach the dialog\./);
  assert.doesNotMatch(seen, /data-shots-retake/, 'no button for a reader who may not use it');
  const allowed = details(failed, true);
  assert.match(allowed, /<button type="button" data-shots-retake="1" class="[^"]*">Take the screenshots again<\/button>/);
  // An automatic retry already coming draws nothing here, as everywhere else.
  assert.equal(details(failedShots({ automaticRetryPending: true }), true), '');
  assert.equal(panelModule.shotDetailsShown(failedShots({ automaticRetryPending: true })), false);
  // The change page's viewer of a failed run draws nothing until it passes.
  assert.equal(viewer(failed), '');
  // A verified run's details still carries no retake (that is the card's).
  const ready = details(shots(), true);
  assert.match(ready, /Taken on the exact before and after builds/);
  assert.match(ready, /<li class="dev-shot-details-claim" data-shots-detail="dialog"><strong>Typing shows &lt;matching&gt;/);
  assert.match(ready, /Desktop · seen as a member/);
  assert.match(ready, /Open &lt;Members&gt;<\/span><span><span aria-hidden="true"> → <\/span>Type ma/);
  assert.doesNotMatch(ready, /data-shots-retake/);
});

test('a failed run’s description drops the Before & after block that links to shots it has none of', () => {
  const body = '## What changed\n\nFor real.\n\n'
    + '<!-- usernode:shots -->\n## Before & after\n\n'
    + '[See the before & after shots of this exact revision in Homeroom](https://example.test/change)\n'
    + '<!-- /usernode:shots -->';
  const failed = { id: 7, pr_body: body, shots: failedShots() };
  const view = AppView._proposalBodyView(failed);
  assert.match(view.html, /What changed/);
  assert.doesNotMatch(view.html, /usernode:shots|Before &amp; after|exact revision/);
  assert.match(failed.pr_body, /usernode:shots/, 'the pull request body itself is untouched');
  // The legacy marker pair is stripped too.
  const legacy = { id: 7, shots: failedShots(), pr_body: 'Intro.\n\n<!-- usernode:visual-evidence -->\n## Before & after\n<!-- /usernode:visual-evidence -->' };
  assert.doesNotMatch(AppView._proposalBodyView(legacy).html, /usernode:visual-evidence|Before &amp; after/);
  // A verified run, and one the platform is retrying, keep their block.
  assert.match(AppView._proposalBodyView({ ...failed, shots: shots() }).html, /Before &amp; after/);
  assert.match(AppView._proposalBodyView({
    ...failed, shots: failedShots({ automaticRetryPending: true }),
  }).html, /exact revision/);
  // Nothing left but the block reads as no description at all.
  assert.equal(AppView._proposalBodyView({
    id: 7, shots: failedShots(), pr_body: '<!-- usernode:shots -->\n## Before & after\n<!-- /usernode:shots -->',
  }), null);
});
