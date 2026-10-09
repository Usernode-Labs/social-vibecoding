'use strict';

// services/shots-diff.js: where a change's before and after screens differ,
// worked out when a run saves its shots so the card can outline it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PNG } = require('pngjs');
const diff = require('../src/services/shots-diff');

// A screen of `w`×`h` in a background colour, with rectangles painted on it.
function screen(w, h, rects = [], bg = [245, 245, 247]) {
  const d = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) d.set([...bg, 255], i * 4);
  for (const [x, y, rw, rh, color] of rects) {
    for (let yy = y; yy < y + rh; yy += 1) {
      for (let xx = x; xx < x + rw; xx += 1) d.set([...color, 255], (yy * w + xx) * 4);
    }
  }
  return { w, h, d };
}
// Text-like detail: a row of dark marks, so a crop is not plain background.
const glyphs = (x, y, n, color = [30, 30, 40]) => Array.from({ length: n }, (_, i) => [x + i * 7, y, 4, 9, color]);
const crop = (px, x, y, w, h) => {
  const d = new Uint8Array(w * h * 4);
  for (let yy = 0; yy < h; yy += 1) d.set(px.d.subarray(((y + yy) * px.w + x) * 4, ((y + yy) * px.w + x + w) * 4), yy * w * 4);
  return { w, h, d };
};
const png = (px) => {
  const image = new PNG({ width: px.w, height: px.h });
  image.data = Buffer.from(px.d);
  return PNG.sync.write(image);
};
const file = (storyId, viewport, side, variant, px) => {
  const data = png(px);
  return { storyId, viewport, side, variant, media: 'png', data,
    sha256: crypto.createHash('sha256').update(data).digest('hex') };
};

test('identical screens have nothing to outline', () => {
  const a = screen(120, 80, glyphs(10, 10, 8));
  assert.deepEqual(diff.regions(a, screen(120, 80, glyphs(10, 10, 8))), []);
});

test('a change in place is outlined at the same spot on both sides', () => {
  const before = screen(200, 120, [[40, 50, 60, 20, [37, 99, 235]], ...glyphs(10, 10, 10)]);
  const after = screen(200, 120, [[40, 50, 120, 20, [37, 99, 235]], ...glyphs(10, 10, 10)]);
  const found = diff.regions(before, after);
  assert.equal(found.length, 1);
  const [region] = found;
  assert.equal(region.b[1], 50);
  assert.equal(region.a[1], 50);
  assert.equal(region.b[3], 20);
  assert.ok(region.b[0] <= 100 && region.b[0] + region.b[2] >= 160, 'as wide as the pixels that differ');
  assert.equal(region.bMark, null);
});

test('rows added in the middle are outlined on the after side only, and what moved down is not', () => {
  const rows = (offset) => [
    ...glyphs(10, 10, 12), [10, 30, 150, 10, [200, 60, 60]],
    ...glyphs(10, 60 + offset, 12, [60, 60, 90]), [10, 90 + offset, 150, 10, [60, 160, 90]],
  ];
  const before = screen(180, 140, rows(0));
  const after = screen(180, 170, [...rows(30), [10, 50, 150, 16, [120, 60, 200]]]);
  const found = diff.regions(before, after);
  assert.equal(found.length, 1, 'the content that shifted lines up again');
  const [region] = found;
  assert.equal(region.b, null);
  assert.ok(region.a[1] >= 44 && region.a[1] <= 50 && region.a[3] >= 16 && region.a[3] <= 30);
  assert.ok(Array.isArray(region.bMark), 'the before side marks where it appears');
});

test('an element shot is found by its detail, not by the plain background around it', () => {
  const page = screen(300, 200, [...glyphs(20, 20, 20), ...glyphs(40, 150, 12, [90, 30, 30]), [36, 146, 100, 1, [210, 210, 214]]]);
  const element = crop(page, 30, 140, 110, 30);
  assert.deepEqual(diff.locate(page, element), [30, 140, 110, 30]);
  // A crop that exists nowhere in the screen is not found.
  const stranger = screen(60, 20, glyphs(5, 5, 6, [10, 200, 10]));
  assert.equal(diff.locate(page, stranger), null);
});

test('changes on one screen share it, each area tied to the change whose element shot it holds', async () => {
  const base = [...glyphs(10, 10, 20), [20, 40, 80, 20, [37, 99, 235]], [120, 40, 80, 20, [37, 99, 235]], ...glyphs(20, 120, 10)];
  const before = screen(240, 200, base);
  const after = screen(240, 200, [...glyphs(10, 10, 20), [20, 40, 180, 20, [37, 99, 235]], ...glyphs(24, 44, 8, [255, 255, 255]),
    ...glyphs(20, 120, 10), [20, 150, 180, 20, [240, 240, 250]], ...glyphs(26, 155, 10)]);
  const stories = [
    { id: 'well', viewports: [{ name: 'desktop' }] },
    { id: 'list', viewports: [{ name: 'desktop' }] },
  ];
  const files = [
    file('well', 'desktop', 'base', 'context', before), file('well', 'desktop', 'head', 'context', after),
    file('well', 'desktop', 'head', 'focus', crop(after, 18, 38, 184, 24)),
    file('list', 'desktop', 'base', 'context', before), file('list', 'desktop', 'head', 'context', after),
    file('list', 'desktop', 'head', 'focus', crop(after, 18, 148, 184, 24)),
  ];
  const screens = await diff.screensFor(stories, files);
  assert.equal(screens.length, 1);
  const [shown] = screens;
  assert.deepEqual(shown.stories, ['well', 'list']);
  assert.equal(shown.shot, 'well');
  assert.deepEqual([shown.width, shown.heightBefore, shown.heightAfter], [240, 200, 200]);
  const byStory = Object.fromEntries(shown.regions.map((region) => [region.story, region]));
  assert.ok(byStory.well && byStory.list, 'both changes are outlined');
  assert.deepEqual(byStory.well.a, [18, 38, 184, 24], 'widened to the whole element the agent shot');
  assert.ok(byStory.list.a[1] <= 150 && byStory.list.a[1] + byStory.list.a[3] >= 170);
  for (const region of shown.regions) {
    for (const box of [region.b, region.a]) {
      if (box) assert.ok(box.every((value) => Number.isSafeInteger(value) && value >= 0));
    }
  }
});

test('screens of different widths are shown without outlines rather than guessed', async () => {
  const stories = [{ id: 'x', viewports: [{ name: 'desktop' }] }];
  const files = [
    file('x', 'desktop', 'base', 'context', screen(100, 60, glyphs(5, 5, 5))),
    file('x', 'desktop', 'head', 'context', screen(120, 60, glyphs(5, 5, 5))),
  ];
  const [shown] = await diff.screensFor(stories, files);
  assert.deepEqual(shown.regions, []);
});

test('unchangedStories names the changes whose every screen shows no difference', () => {
  const screens = [
    { viewport: 'desktop', shot: 'a', stories: ['a'], regions: [] },
    { viewport: 'mobile', shot: 'a', stories: ['a'], regions: [] },
    { viewport: 'mobile', shot: 'b', stories: ['b'], regions: [{ story: 'b' }] },
    { viewport: 'desktop', shot: 'c', stories: ['c'], regions: [] },
    // 'e' shares 'd's before screen; the areas compare it with 'd's after,
    // so they say nothing about 'e'.
    { viewport: 'desktop', shot: 'd', stories: ['d', 'e'], regions: [] },
  ];
  assert.deepEqual([...diff.unchangedStories(screens)].sort(), ['a', 'c', 'd']);
  assert.deepEqual([...diff.unchangedStories([])], []);
  assert.deepEqual([...diff.unchangedStories(undefined)], []);
});

test('screens pair and outline photos within their own appearance only', async () => {
  const stories = [{ id: 'change', viewports: [{ name: 'desktop' }] }];
  const modes = ['light', 'dark'];
  const files = modes.flatMap((colorScheme, i) => ['base', 'head'].map((side) => ({
    ...file('change', 'desktop', side, 'context', screen(120, 80, side === 'head' ? [[20 + i * 40, 20, 10, 15, [100, 20, 30]]] : [], i ? [20, 20, 20] : [245, 245, 247])),
    colorScheme,
  })));
  const screens = await diff.screensFor(stories, files);
  assert.equal(screens.length, 2);
  assert.deepEqual(screens.map((s) => s.colorScheme), modes);
  assert.ok(screens[0].regions.length > 0, 'historical light comparison retains its measured difference');
  assert.deepEqual(screens[1].regions, [], 'dark photos do not trigger another pixel comparison or reuse light outlines');
  const mismatched = await diff.screensFor(stories, [files[0], files[3]]);
  assert.equal(mismatched.length, 0, 'a light before never pairs with a dark after');
});


test('both viewers keep claim groups consistent when only light captures are identical', async () => {
  const AppView = require('../public/js/app-view');
  const stories = ['first', 'second'].map((id) => ({ id, claim: id, persona: 'member', viewports: [{ name: 'desktop' }] }));
  const files = stories.flatMap((story, i) => ['light', 'dark'].flatMap((colorScheme) => ['base', 'head'].map((side) => ({
    ...file(story.id, 'desktop', side, 'context', screen(120, 80, [
      ...glyphs(5, 5, 5),
      ...(colorScheme === 'dark' && i ? [[80, 5, 10, 10, [150, 80, 20]]] : []),
      ...(side === 'head' ? [[20 + i * 40, 40, 10, 15, [100, 20, 30]]] : []),
    ], colorScheme === 'dark' ? [20, 20, 20] : [245, 245, 247])), colorScheme,
  }))));
  assert.equal(files[0].sha256, files[4].sha256, 'the light before images coincide');
  assert.notEqual(files[2].sha256, files[6].sha256, 'the dark before images differ');
  const screens = await diff.screensFor(stories, files);
  assert.equal(screens.length, 4, 'split the light group as well, instead of losing the second dark screen');
  for (const mode of ['light', 'dark']) {
    const own = screens.filter((s) => s.colorScheme === mode);
    assert.deepEqual(own.map((s) => [s.shot, s.stories]), [['first', ['first']], ['second', ['second']]]);
    if (mode === 'light') assert.ok(own.every((s) => s.regions.length > 0), 'light groups retain measured outlines');
    else assert.ok(own.every((s) => s.regions.length === 0), 'additional dark photos stay plain');
  }
  const shots = { state: 'verified', claims: stories.map((s) => ({ ...s, viewports: ['desktop'] })), screens, artifacts: files.map((f) => ({
    ...f, id: f.sha256.slice(0, 32), url: `/api/apps/demo/proposals/42/shots/${f.sha256.slice(0, 32)}`,
  })) };
  const html = AppView.shotsHtml(shots, { sessionId: 42 });
  assert.equal((html.match(/<figure class="shots-view"/g) || []).length, 2, 'two logical screens, not a stranded third dark screen');
  assert.equal((html.match(/class="shots-photo-mode shots-photo-light"/g) || []).length, 4);
  assert.equal((html.match(/class="shots-photo-mode shots-photo-dark"/g) || []).length, 4);
  const preview = AppView._workshopVisuals(null, shots);
  for (const changes of [[1], [2]]) {
    const family = preview.screens.filter((s) => s.changes.join(',') === changes.join(','));
    assert.deepEqual(family.map((s) => s.colorScheme), ['light', 'dark'], 'React preview can select either mode with identical claim identity');
  }
});
