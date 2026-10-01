'use strict';

// "Position your photo" (#3525): a chosen profile photo opens a step where
// the viewer drags and zooms it inside the circle, and accepts or cancels,
// before anything is staged.
//
// The arithmetic is EXECUTED (tests/lib/render-tsx.js `loadTsx`, the harness
// tests/workshop-swipe-vote.test.js uses for its gesture maths): which way a
// drag moves the square, what zoom keeps still, where the edges stop it, and
// what reaches the canvas. Each of those wrong is a photo cut from somewhere
// the viewer did not choose, and nothing on screen would say so until the
// saved avatar came back.
//
// The wiring is pinned from source, like the rest of the editor's tests
// (tests/topochain-profile-web.test.js, tests/profile-editor-back.test.js):
// a pick opens the step instead of staging, the step is a kit modal stacked
// over an inert editor, the frame keeps the modal from scrolling under a drag
// and joins the kit's gesture arbiter, Back cancels the step and not the
// editor, and ?shot=profile-photo reaches it for the declared check.
//
// Run with: node --test tests/avatar-crop.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const crop = loadTsx('frontend/src/features/profile/avatar-crop.ts');
const {
  CROP_MAX_ZOOM, CROP_NUDGE_SHARE, CROP_NUDGE_BIG, CROP_ZOOM_STEP,
  coverSide, clampCrop, initialCrop, zoomOf, panCrop, zoomCrop, nudgeCrop, sourceRect, photoPlacement,
} = crop;

const DIALOG = read('frontend/src/features/profile/avatar-crop-dialog.tsx');
const SHEET = read('frontend/src/features/profile/profile-edit-sheet.tsx');
const PROFILE = read('frontend/src/features/profile/profile.js');
const VIEW = read('frontend/src/features/profile/profile-view.tsx');

const near = (a, b, msg, within = 1e-9) => assert.ok(Math.abs(a - b) < within, `${msg || ''} ${a} ≈ ${b}`);
const inside = (c, w, h) => {
  assert.ok(c.x >= 0 && c.y >= 0, `origin inside: ${JSON.stringify(c)}`);
  assert.ok(c.x + c.size <= w + 1e-9 && c.y + c.size <= h + 1e-9, `far edge inside: ${JSON.stringify(c)}`);
};

// ── Where the step opens ───────────────────────────────────────────────

test('it opens on exactly the square the old automatic crop cut', () => {
  // Accepting without touching anything must upload what a pick always
  // uploaded, floor included (the retired code was
  // Math.floor((bitmap.width - side) / 2)).
  assert.deepEqual(initialCrop(960, 640), { x: 160, y: 0, size: 640 });
  assert.deepEqual(initialCrop(1200, 1800), { x: 0, y: 300, size: 1200 });
  assert.deepEqual(initialCrop(500, 500), { x: 0, y: 0, size: 500 });
  assert.deepEqual(initialCrop(1001, 600), { x: 200, y: 0, size: 600 }, 'an odd margin floors');
  assert.equal(zoomOf(initialCrop(960, 640), 960, 640), 1);
});

test('an image with no area has no square to cut', () => {
  assert.equal(coverSide(0, 640), 0);
  assert.equal(coverSide(NaN, 640), 0);
  assert.deepEqual(initialCrop(0, 0), { x: 0, y: 0, size: 0 });
  assert.deepEqual(clampCrop({ x: 5, y: 5, size: 5 }, 0, 10), { x: 0, y: 0, size: 0 });
  assert.deepEqual(sourceRect({ x: 5, y: 5, size: 5 }, 0, 10), { x: 0, y: 0, size: 0 });
});

// ── The rules every step keeps ─────────────────────────────────────────

test('the square never leaves the photo and stays between zoom 1 and the maximum', () => {
  const w = 960;
  const h = 640;
  inside(clampCrop({ x: -50, y: -50, size: 640 }, w, h), w, h);
  inside(clampCrop({ x: 900, y: 900, size: 100 }, w, h), w, h);
  assert.equal(clampCrop({ x: 0, y: 0, size: 5000 }, w, h).size, 640, 'no zooming out past the cover');
  assert.equal(clampCrop({ x: 0, y: 0, size: 1 }, w, h).size, 640 / CROP_MAX_ZOOM, 'nor in past the maximum');
  assert.equal(CROP_MAX_ZOOM, 4);
});

test('a value that is not a number is treated as nothing, never passed on', () => {
  const c = clampCrop({ x: NaN, y: Infinity, size: NaN }, 960, 640);
  assert.deepEqual(c, { x: 0, y: 0, size: 640 });
  const p = panCrop(initialCrop(960, 640), NaN, NaN, 288, 960, 640);
  assert.deepEqual(p, initialCrop(960, 640));
  const z = zoomCrop(initialCrop(960, 640), NaN, 960, 640);
  assert.equal(z.size, 640, 'a NaN zoom is zoom 1');
});

// ── Dragging ───────────────────────────────────────────────────────────

test('the photo follows the finger, so the square moves the other way', () => {
  const start = initialCrop(960, 640); // x 160, the square spans 640 of 960
  // 288px frame showing 640 source px: each screen px is 640/288 of the photo.
  const left = panCrop(start, -36, 0, 288, 960, 640);
  near(left.x, 160 + 36 * (640 / 288), 'dragging left shows more of the right');
  const right = panCrop(start, 36, 0, 288, 960, 640);
  near(right.x, 160 - 36 * (640 / 288), 'dragging right shows more of the left');
  assert.equal(left.size, 640, 'a drag never zooms');
  assert.equal(left.y, 0);
});

test('a drag stops at the edge and answers at once on the way back', () => {
  const start = initialCrop(960, 640);
  const far = panCrop(start, 10000, 0, 288, 960, 640);
  assert.equal(far.x, 0, 'pinned to the left edge, not past it');
  // Incremental: the very first pixel back moves it, with no dead zone to
  // unwind first.
  const back = panCrop(far, -1, 0, 288, 960, 640);
  assert.ok(back.x > 0);
  // The short axis has nowhere to go at zoom 1.
  assert.equal(panCrop(start, 0, 500, 288, 960, 640).y, 0);
});

test('a drag scales with how far in the photo is zoomed', () => {
  const zoomed = zoomCrop(initialCrop(960, 640), 2, 960, 640); // shows 320px
  const moved = panCrop(zoomed, -10, 0, 320, 960, 640);
  near(moved.x - zoomed.x, 10, 'at 320 source px across a 320px frame, one to one');
});

test('a frame with no width moves nothing', () => {
  const start = initialCrop(960, 640);
  assert.deepEqual(panCrop(start, 50, 50, 0, 960, 640), start);
});

// ── Zooming ────────────────────────────────────────────────────────────

test('zoom keeps the point under the pinch (or the pointer) where it is', () => {
  const start = { x: 100, y: 100, size: 400 };
  const w = 2000;
  const h = 2000;
  for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.75], [0.9, 0.1]]) {
    const before = { x: start.x + fx * start.size, y: start.y + fy * start.size };
    const z = zoomCrop(start, zoomOf(start, w, h) * 1.5, w, h, fx, fy);
    near(z.x + fx * z.size, before.x, `x under (${fx}, ${fy})`);
    near(z.y + fy * z.size, before.y, `y under (${fx}, ${fy})`);
  }
});

test('the slider and the keys zoom about the centre, within 1 to the maximum', () => {
  const start = initialCrop(960, 640);
  const z2 = zoomCrop(start, 2, 960, 640);
  assert.equal(z2.size, 320);
  near(z2.x + z2.size / 2, 480, 'still centred');
  assert.equal(zoomCrop(start, 99, 960, 640).size, 160, 'capped at the maximum');
  assert.equal(zoomCrop(z2, 0.2, 960, 640).size, 640, 'and never below the cover');
});

test('zooming out beside an edge slides the photo back in rather than opening a gap', () => {
  const inCorner = { x: 0, y: 0, size: 160 }; // zoom 4, in the top-left corner
  const out = zoomCrop(inCorner, 1, 960, 640, 0, 0);
  inside(out, 960, 640);
  assert.equal(out.size, 640);
  const farCorner = zoomCrop({ x: 800, y: 480, size: 160 }, 1, 960, 640, 1, 1);
  inside(farCorner, 960, 640);
});

// ── The keyboard ───────────────────────────────────────────────────────

test('the arrows move the photo the way they point, as a drag does', () => {
  const start = zoomCrop(initialCrop(960, 640), 2, 960, 640);
  const step = start.size * CROP_NUDGE_SHARE;
  near(nudgeCrop(start, 'ArrowLeft', 960, 640).x, start.x + step, 'left: the photo goes left');
  near(nudgeCrop(start, 'ArrowRight', 960, 640).x, start.x - step);
  near(nudgeCrop(start, 'ArrowUp', 960, 640).y, start.y + step);
  near(nudgeCrop(start, 'ArrowDown', 960, 640).y, start.y - step);
  // Same direction as a drag the same way.
  assert.ok(nudgeCrop(start, 'ArrowLeft', 960, 640).x > start.x);
  assert.ok(panCrop(start, -5, 0, 288, 960, 640).x > start.x);
  near(nudgeCrop(start, 'ArrowLeft', 960, 640, true).x, start.x + step * CROP_NUDGE_BIG, 'Shift is a bigger step');
});

test('+ and - zoom a step; any other key is left alone', () => {
  const start = initialCrop(960, 640);
  near(zoomOf(nudgeCrop(start, '+', 960, 640), 960, 640), CROP_ZOOM_STEP);
  near(zoomOf(nudgeCrop(start, '=', 960, 640), 960, 640), CROP_ZOOM_STEP, '= is + without Shift');
  const zoomed = nudgeCrop(start, '+', 960, 640);
  near(zoomOf(nudgeCrop(zoomed, '-', 960, 640), 960, 640), 1);
  assert.equal(nudgeCrop(start, '-', 960, 640).size, 640, 'no zooming out past the cover');
  for (const key of ['Tab', 'Enter', 'Escape', ' ', 'a', 'Home']) {
    assert.equal(nudgeCrop(start, key, 960, 640), null, `${key} keeps its own meaning`);
  }
});

// ── What reaches the canvas ────────────────────────────────────────────

test('the canvas gets whole pixels, inside the photo, whatever the square was', () => {
  const r = sourceRect({ x: 123.6, y: 10.4, size: 300.5 }, 960, 640);
  for (const v of Object.values(r)) assert.ok(Number.isInteger(v), `${v} is whole`);
  inside(r, 960, 640);
  // Flush with the right edge at a fractional x: rounding must not step past.
  const flush = sourceRect({ x: 960 - 300.4, y: 0, size: 300.4 }, 960, 640);
  inside(flush, 960, 640);
  // A tiny, odd-sized image still gets a square of at least one pixel.
  assert.deepEqual(sourceRect({ x: 0, y: 0, size: 0.2 }, 1, 3), { x: 0, y: 0, size: 1 });
  // A hand-built square larger than the photo is refitted, not trusted.
  const big = sourceRect({ x: -10, y: -10, size: 5000 }, 960, 640);
  assert.deepEqual(big, { x: 0, y: 0, size: 640 });
});

test('what the frame shows is what the canvas cuts', () => {
  // The frame draws the whole photo at `photoPlacement`; the square it shows
  // is therefore (-left, -top) sized frame/width-share. Read it back and it
  // must be the square sourceRect hands to drawImage.
  const w = 1200;
  const h = 1800;
  let c = initialCrop(w, h);
  c = zoomCrop(c, 1.5, w, h, 0.3, 0.2);
  c = panCrop(c, 17, -40, 288, w, h);
  const place = photoPlacement(c, w, h);
  const pct = (s) => Number(String(s).replace('%', '')) / 100;
  // Four decimals of a percentage: a thousandth of a source pixel at most.
  const shownSize = w / pct(place.width);
  near(shownSize, c.size, 'size', 1e-3);
  near(-pct(place.left) * shownSize, c.x, 'x', 1e-3);
  near(-pct(place.top) * shownSize, c.y, 'y', 1e-3);
  near(h / pct(place.height), shownSize, 'the photo keeps its shape', 1e-3);
  const r = sourceRect(c, w, h);
  assert.ok(Math.abs(r.x - c.x) <= 0.5 && Math.abs(r.y - c.y) <= 0.5 && Math.abs(r.size - c.size) <= 0.5);
});

test('the placement is plain percentages, so drawing it needs no measurement', () => {
  assert.deepEqual(photoPlacement(initialCrop(960, 640), 960, 640), {
    left: '-25.0000%', top: '0.0000%', width: '150.0000%', height: '100.0000%',
  });
});

// ── The flow: pick, position, Use photo, Save ──────────────────────────

test('a pick opens the step; nothing is staged until Use photo', () => {
  const onFile = SHEET.slice(SHEET.indexOf('const onFile = async'), SHEET.indexOf('const onCropAccept = async'));
  assert.match(onFile, /await Profile\.beginAvatarCrop\(chosen\);/);
  assert.doesNotMatch(onFile, /stageAvatar/, 'a pick used to stage the centred square at once');
  const accept = SHEET.slice(SHEET.indexOf('const onCropAccept = async'));
  assert.match(accept.slice(0, 400), /if \(await Profile\.acceptAvatarCrop\(crop\)\) setShowRemove\(true\);/);
  // Profile's side: Use photo is the only path to _stageBlob from the step,
  // and a step cancelled while it prepared drops what it prepared.
  const fn = PROFILE.slice(PROFILE.indexOf('  async acceptAvatarCrop('), PROFILE.indexOf('  cancelAvatarCrop() {'));
  assert.match(fn, /blob = await Profile\._prepareAvatar\(file, crop\);/);
  assert.match(fn, /if \(Profile\._cropFile !== file\) return false;/);
  assert.ok(fn.indexOf('Profile._endAvatarCrop();') < fn.indexOf('Profile._stageBlob(blob);'));
});

test('the step checks and measures the file before it opens, and only over an open editor', () => {
  const fn = PROFILE.slice(PROFILE.indexOf('  async beginAvatarCrop('), PROFILE.indexOf('  async acceptAvatarCrop('));
  assert.match(fn, /Profile\._checkAvatarType\(file\);/);
  assert.match(fn, /Profile\._decodeImage\(file\)/);
  assert.match(fn, /That image could not be read\./);
  assert.match(fn, /if \(!profileStore\.get\(\)\.sheetOpen\) return;/);
  assert.match(fn, /cropSource: \{ url: URL\.createObjectURL\(file\), width, height \}/);
});

test('Back cancels the step and leaves the editor open', () => {
  const begin = PROFILE.slice(PROFILE.indexOf('  async beginAvatarCrop('), PROFILE.indexOf('  async acceptAvatarCrop('));
  assert.match(begin, /Profile\._releaseCropBack = pushDismissible\(\(\) => \{\s*Profile\._releaseCropBack = null;\s*Profile\._endAvatarCrop\(\);\s*return true;/);
  // Closing the editor closes the step first: its record is on top, and only
  // the top record may be spent.
  const dismiss = PROFILE.slice(PROFILE.indexOf('  _dismissSheet({'), PROFILE.indexOf('  takeDraft() {'));
  const cropAt = dismiss.indexOf('Profile._endAvatarCrop({ navigating: true });');
  const editorAt = dismiss.indexOf('const release = Profile._releaseBack;');
  assert.ok(cropAt > 0 && editorAt > cropAt, 'the step is released before the editor');
});

test('the object URL outlives the dialog copy the kit animates out', () => {
  // lib/kit-surface.ts leaves a copy of the card to play the exit; revoking
  // the URL before the store closed the dialog made that copy's <img> fail
  // to load, which logs a console error.
  const fn = PROFILE.slice(PROFILE.indexOf('  _endAvatarCrop({'));
  const closeAt = fn.indexOf('profileStore.set({ cropSource: null });');
  const revokeAt = fn.indexOf('URL.revokeObjectURL(source.url)');
  assert.ok(closeAt > 0 && revokeAt > closeAt);
});

test('decoding honours EXIF rotation, as the <img> in the frame does', () => {
  const fn = PROFILE.slice(PROFILE.indexOf('  async _decodeImage('));
  assert.match(fn, /createImageBitmap\(file, \{ imageOrientation: 'from-image' \}\)/);
});

// ── The dialog ─────────────────────────────────────────────────────────

test('it is a kit modal over the editor, presented the way the editor is', () => {
  assert.match(DIALOG, /adoptKitSurface\(\{\s*kind: 'modal',/);
  assert.match(DIALOG, /home: 'placeholder'/);
  assert.match(DIALOG, /adoptedOn: flagEl/);
  // Both kit-written nodes render a constant className.
  assert.match(DIALOG, /const ROOT_CLASS = '[^']*';/);
  assert.match(DIALOG, /id="profile-photo-crop"\s*ref=\{rootRef\}\s*className=\{ROOT_CLASS\}/);
  assert.match(DIALOG, /<DialogCard id="profile-photo-crop-card" ref=\{cardRef\}>/);
  // The backdrop and Escape are Cancel; a dismissal after our own teardown is not.
  assert.match(DIALOG, /onDismiss: \(\) => \{\s*if \(!adoption\) return;\s*adoption = null;\s*onCancelRef\.current\(\);/);
  assert.match(DIALOG, /handle\.release\(\);/);
});

test('the editor under it is inert, and the step renders after the lifted card', () => {
  assert.match(SHEET, /id="profile-edit-sheet" ref=\{panelRef\} className=\{CARD_CLASS\} inert=\{cropping\}/);
  const cardAt = SHEET.indexOf('id="profile-edit-sheet"');
  const stepAt = SHEET.indexOf('<AvatarCropDialog');
  const rootEnd = SHEET.lastIndexOf('</div>\n  );\n}');
  assert.ok(cardAt > 0 && stepAt > cardAt && rootEnd > stepAt, 'the last child of #profile-edit-root');
  assert.match(VIEW, /cropSource=\{state\.cropSource\}/);
});

test('the frame keeps a drag from scrolling the modal, and joins the gesture arbiter', () => {
  const stage = DIALOG.match(/const STAGE_CLASS = ([^;]*);/);
  assert.ok(stage, 'STAGE_CLASS is a literal');
  const tokens = stage[1].replace(/['+\n]/g, ' ').split(/\s+/);
  assert.ok(tokens.includes('touch-none'), 'the frame withholds panning and zooming from the browser');
  assert.ok(tokens.includes('select-none'));
  // Claimed at the lock, never on the press, and let go if a kit recognizer
  // already has the finger.
  assert.match(DIALOG, /const DRAG_LOCK_PX = \d+;/);
  assert.match(DIALOG, /if \(arbiter && !arbiter\.claim\(seq, CROP_GESTURE_TOKEN\)\) \{ endGesture\(\); return; \}/);
  assert.doesNotMatch(DIALOG.slice(DIALOG.indexOf('const onPointerDown'), DIALOG.indexOf('const onPointerMove')), /claim\(/);
  assert.match(DIALOG, /setPointerCapture\(e\.pointerId\)/);
  // The wheel is bound non-passive, or preventDefault would be ignored.
  assert.match(DIALOG, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/);
});

test('it is reachable and named for a keyboard and a screen reader', () => {
  assert.match(DIALOG, /tabIndex=\{0\}\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*role="application"/);
  assert.match(DIALOG, /aria-label="Photo position\. Drag to move the photo, or use the arrow keys\. Plus and minus zoom\."/);
  assert.match(DIALOG, /onKeyDown=\{onKeyDown\}/);
  assert.match(DIALOG, /aria-label="Zoom"/);
  assert.match(DIALOG, /shell\.setAttribute\('aria-labelledby', 'profile-photo-crop-title'\)/);
});

test('it renders the photo at its opening square, with Use photo and Cancel', () => {
  const Profile = {
    _user: () => ({ username: 'evan', displayName: 'Evan', bio: '', links: {} }),
    _dismissSheet: () => {}, MAX_DISPLAY_NAME: 40, MAX_BIO: 280,
    cancelAvatarCrop: () => {}, acceptAvatarCrop: async () => true,
  };
  const mod = loadTsx('frontend/src/features/profile/profile-edit-sheet.tsx', {
    stubs: { './profile.js': { Profile } },
  });
  const html = renderToHtml(createElement(mod.ProfileEditSheet, {
    avatarUrl: null,
    initial: 'E',
    cropSource: { url: 'blob:sample', width: 960, height: 640 },
  }));
  assert.match(html, /id="profile-edit-sheet" class="[^"]*" inert=""/, 'the editor is inert under the step');
  const step = html.slice(html.indexOf('id="profile-photo-crop"'));
  assert.ok(html.indexOf('id="profile-photo-crop"') > html.indexOf('id="profile-edit-sheet"'));
  assert.match(step, />Position your photo</);
  assert.match(step, /Nothing is saved until you press Save\./);
  assert.match(step, /<img src="blob:sample"[^>]*style="left:-25\.0000%;top:0\.0000%;width:150\.0000%;height:100\.0000%"/);
  assert.match(step, /id="profile-photo-zoom"[^>]*min="1"[^>]*max="4"/);
  assert.match(step, /id="profile-photo-cancel"[^>]*>Cancel</);
  assert.match(step, /id="profile-photo-use"[^>]*>Use photo</);

  // Without a photo being positioned there is no step, and the editor is live.
  const plain = renderToHtml(createElement(mod.ProfileEditSheet, { avatarUrl: null, initial: 'E' }));
  assert.doesNotMatch(plain, /profile-photo-crop/);
  assert.doesNotMatch(plain, /inert/);
});

test('the Photo row says where a photo change stands until Save', () => {
  const Profile = {
    _user: () => ({ username: 'evan', links: {} }),
    _dismissSheet: () => {}, MAX_DISPLAY_NAME: 40, MAX_BIO: 280,
  };
  const mod = loadTsx('frontend/src/features/profile/profile-edit-sheet.tsx', {
    stubs: { './profile.js': { Profile } },
  });
  const note = (pendingPhoto) => {
    const html = renderToHtml(createElement(mod.ProfileEditSheet, { avatarUrl: null, initial: 'E', pendingPhoto }));
    return html.match(/id="profile-edit-photo-note"[^>]*>([^<]*)</)[1];
  };
  assert.match(note(null), /You choose the part that shows before it is used\./);
  assert.match(note('new'), /not saved yet\. Press Save/);
  assert.match(note('removed'), /removed when you press Save/);
  assert.match(VIEW, /pendingPhoto=\{state\.pendingAvatarUrl \? 'new' : state\.pendingRemove \? 'removed' : null\}/);
});

// ── Reaching it without a file chooser ─────────────────────────────────

test('?shot=profile-photo opens the editor and the step, and a declared check reads it', () => {
  const fn = PROFILE.slice(PROFILE.indexOf('  _maybeOpenShot() {'), PROFILE.indexOf('  _checkAvatarType('));
  assert.match(fn, /if \(shot !== 'profile-edit' && shot !== 'profile-photo'\) return;/);
  assert.match(fn, /if \(shot === 'profile-photo'\) void Profile\._openSamplePhoto\(\);/);
  // Drawn, not fetched, and a PNG the step accepts.
  assert.match(fn, /new File\(\[blob\], 'sample-photo\.png', \{ type: 'image\/png' \}\)/);
  assert.doesNotMatch(fn, /staging/i, 'pure UI state, like ?shot=profile-edit');

  const dapp = JSON.parse(read('dapp.json'));
  const check = dapp.tests.find((t) => t.path === '/?shot=profile-photo#profile');
  assert.ok(check, 'a declared check opens the step');
  assert.match(check.name, /#3525/);
  assert.match(check.expectSelector, /#profile-photo-crop-stage\[role='application'\] > img/);
  assert.match(check.expectSelector, /#profile-edit-sheet\[inert\]/);
  assert.equal(check.expectText, 'Position your photo');
});
