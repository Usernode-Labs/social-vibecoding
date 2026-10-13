'use strict';

// The app's tile on Homeroom's home screen, for each side of a shots pair
// (src/services/shots-home-tile.js). Admin export 2026-10-05: two hosted-app
// proposals that changed only dapp.json's icon could not be shot, because
// the tile is on the home screen and the pair's copies serve only the app.
// Pinned here: the tile follows the home screen's precedence (image, emoji,
// first letter), the brief describes both sides without the image bytes,
// and the page escapes what the repository wrote and runs no script.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const homeTile = require('../src/services/shots-home-tile');
const controlPlane = require('../src/services/shots-control');
const fixtures = require('./fixtures/shots');

// Enough of a PNG for the magic-byte sniff app-manifest applies.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 7)]);

function checkout(t, manifest, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-home-tile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (manifest !== undefined) fs.writeFileSync(path.join(dir, 'dapp.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('the tile takes the manifest\'s name, its emoji and its colour', async (t) => {
  const dir = checkout(t, { name: 'Habit Streak', icon: { emoji: '🔥', color: '#2E6660' } });
  assert.deepEqual(await homeTile.tileFromCheckout(dir, { fallbackName: 'Old name', slug: 'habit-streak-2a4523' }), {
    name: 'Habit Streak', icon: { kind: 'emoji', emoji: '🔥' }, color: '#2e6660',
  });
});

test('a committed image fills the tile; one that fails validation falls back to the emoji, then the letter', async (t) => {
  const image = await homeTile.tileFromCheckout(checkout(t,
    { name: 'Invite Board', icon: { image: 'brand/icon.png', emoji: '📮' } }, { 'brand/icon.png': PNG }));
  assert.equal(image.icon.kind, 'image');
  assert.equal(image.icon.contentType, 'image/png');
  assert.equal(Buffer.from(image.icon.data, 'base64').equals(PNG), true);
  assert.match(image.icon.sha256, /^[0-9a-f]{64}$/);

  // Not an image the platform accepts (an SVG): the emoji stands in.
  const notImage = await homeTile.tileFromCheckout(checkout(t,
    { name: 'Invite Board', icon: { image: 'brand/icon.svg', emoji: '📮' } },
    { 'brand/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }));
  assert.deepEqual(notImage.icon, { kind: 'emoji', emoji: '📮' });

  // No icon block: the first letter of the name the home screen shows, which
  // is the platform's name when the manifest has none.
  assert.deepEqual((await homeTile.tileFromCheckout(checkout(t, {}), { fallbackName: 'invite board' })).icon,
    { kind: 'letter', letter: 'I' });
  assert.deepEqual(await homeTile.tileFromCheckout(checkout(t, undefined), { slug: 'demo' }),
    { name: 'demo', icon: { kind: 'letter', letter: 'D' }, color: null });
});

test('the brief says what each side shows and whether they differ, never the image bytes', async (t) => {
  const before = checkout(t, { name: 'Invite Board' });
  const after = checkout(t, { name: 'Invite Board', icon: { image: 'brand/icon.png' } }, { 'brand/icon.png': PNG });
  const tiles = await homeTile.tilesForPair({ sides: { base: { checkout: before }, head: { checkout: after } } },
    { name: 'Invite Board', slug: 'invite-board-ad93b6' });
  const entry = homeTile.briefEntry(tiles);
  assert.deepEqual(entry, {
    path: '/__shots/home-tile',
    before: { name: 'Invite Board', icon: { kind: 'letter' } },
    after: { name: 'Invite Board', icon: { kind: 'image' } },
    differs: true,
  });
  assert.doesNotMatch(JSON.stringify(entry), new RegExp(tiles.head.icon.data.slice(0, 16)));

  const same = await homeTile.tilesForPair({ sides: { base: { checkout: after }, head: { checkout: after } } }, {});
  assert.equal(homeTile.briefEntry(same).differs, false);
  // A colour alone is a difference too: it tints the project's page.
  const tinted = await homeTile.tilesForPair({ sides: {
    base: { checkout: checkout(t, { name: 'A', icon: { emoji: '🍳' } }) },
    head: { checkout: checkout(t, { name: 'A', icon: { emoji: '🍳', color: '#123456' } }) },
  } }, {});
  assert.equal(homeTile.briefEntry(tinted).differs, true);

  // A pair without both checkouts (a dry run of one side) has no tiles.
  assert.equal(await homeTile.tilesForPair({ sides: { base: {}, head: { checkout: after } } }, {}), null);
  assert.equal(homeTile.briefEntry(null), null);
});

test('the page escapes what the repository wrote and runs no script', () => {
  const page = homeTile.renderPage({
    name: '<script>alert(1)</script> & "Co"',
    icon: { kind: 'emoji', emoji: '<b>' },
    color: '#2e6660',
  }, { side: 'head' });
  assert.doesNotMatch(page, /<script/i);
  assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;Co&quot;/);
  assert.match(page, /<span class="emoji">&lt;b&gt;<\/span>/);
  assert.match(page, /Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"/);
  assert.match(page, /Home screen tile, after the change/);
  assert.match(page, /class="pane light"[\s\S]*class="pane dark"/, 'light and dark');
  assert.equal((page.match(/class="app-card"/g) || []).length, 4, 'each theme at the home screen size and enlarged');
  assert.match(page, /Project colour <span class="swatch" style="background:#2e6660"><\/span> #2e6660/);

  const image = homeTile.renderPage({
    name: 'Invite Board', icon: { kind: 'image', contentType: 'image/png', data: PNG.toString('base64') }, color: null,
  }, { side: 'base' });
  assert.match(image, /Home screen tile, before the change/);
  assert.match(image, new RegExp(`<img src="data:image/png;base64,${PNG.toString('base64').replace(/[+/]/g, '\\$&')}" alt="">`));
  assert.doesNotMatch(image, /Project colour/, 'no colour declared, none shown');
  assert.match(homeTile.renderPage({ name: 'demo', icon: { kind: 'letter', letter: 'D' }, color: null }, { side: 'base' }),
    /data-icon="letter">D<\/div>/);
});

test('a run serves each side\'s page, and nothing for a side it has no tile for', async (t) => {
  controlPlane._clearForTests();
  t.after(() => controlPlane._clearForTests());
  const tiles = {
    base: { name: 'Habit Streak', icon: { kind: 'letter', letter: 'H' }, color: null },
    head: { name: 'Habit Streak', icon: { kind: 'emoji', emoji: '🔥' }, color: null },
  };
  const { control } = controlPlane.registerRun({
    runId: 'e'.repeat(32), sessionId: 42, intent: fixtures.intent(), context: {}, expiresAt: Date.now() + 60_000,
    homeTiles: tiles,
  });
  assert.match(control.homeTilePage('base'), /data-icon="letter">H</);
  assert.match(control.homeTilePage('head'), /<span class="emoji">🔥<\/span>/);
  assert.equal('homeTiles' in control.getContext(), false, 'the brief carries a description, not the tiles');
  for (const side of ['outside', 'hosted', '']) {
    assert.throws(() => control.homeTilePage(side), { code: 'home_tile_unavailable', status: 404 });
  }
  const { control: bare } = controlPlane.registerRun({
    runId: 'd'.repeat(32), sessionId: 42, intent: fixtures.intent(), context: {}, expiresAt: Date.now() + 60_000,
  });
  assert.throws(() => bare.homeTilePage('base'), { code: 'home_tile_unavailable' });
});
