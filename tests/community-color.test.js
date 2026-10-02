'use strict';

// A community's colour (#852): frontend/src/lib/community-color.ts.
//
// The project page's header, its tabs and Open app wear it, always behind
// white text. dapp.json's `icon.color` decides it when set; otherwise it is
// read off the icon (the dominant hue, in OKLab), an emoji the same way, a
// colourless icon is graphite, and a project with no icon at all takes its
// name's swatch. Whatever the source, it is darkened until white passes 4.5:1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const color = loadTsx('frontend/src/lib/community-color.ts');

const px = (rgb, n) => {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(rgb[0], rgb[1], rgb[2], 255);
  return out;
};

test('every colour it hands out carries white text at 4.5:1 or better', () => {
  const inputs = ['#ffffff', '#ffeb3b', '#8fd14f', '#6fb3a8', '#c0532f', '#37477b', '#000000', '#ff00ff', '#9ad0ff'];
  for (const hex of inputs) {
    const fit = color.fitForWhiteText(hex);
    assert.match(fit, /^#[0-9a-f]{6}$/, `${hex} fits to a hex colour`);
    assert.ok(color.contrastWithWhite(fit) >= 4.5, `${hex} → ${fit} is ${color.contrastWithWhite(fit).toFixed(2)}:1`);
  }
  // A colour that already carries white keeps its hue and stays close.
  assert.equal(color.fitForWhiteText('#37477b'), '#37477b', 'Homeroom\'s own colour is left as it is');
  assert.equal(color.fitForWhiteText('red'), null, 'anything that is not a hex colour is not a colour');
});

test('an icon lends its dominant hue; a black-and-white one lends none', () => {
  // Mostly green with a little red: green wins, fitted for white text.
  const green = color.deriveFromPixels([...px([46, 160, 67], 80), ...px([220, 40, 40], 10), ...px([255, 255, 255], 30)]);
  assert.ok(green, 'a coloured icon has a colour');
  const [r, g, b] = color.parseHex(green);
  assert.ok(g > r && g > b, `${green} is green`);
  assert.ok(color.contrastWithWhite(green) >= 4.5);
  // Black on white (Homeroom's own mark): no hue to lend.
  assert.equal(color.deriveFromPixels([...px([0, 0, 0], 60), ...px([250, 250, 245], 60)]), null);
  // Transparent pixels are not counted at all.
  assert.equal(color.deriveFromPixels([0, 200, 0, 0, 0, 200, 0, 0]), null);
});

test('with no icon, the name picks a swatch, the same one every time', () => {
  assert.equal(color.swatchFor('garden'), color.swatchFor('garden'));
  const now = color.communityColorNow({ key: 'garden' });
  assert.equal(now, color.fitForWhiteText(color.swatchFor('garden'), color.SOFT), 'fitted as a read colour (#3523)');
  // A set colour wins over everything else, icon or not.
  assert.equal(color.communityColorNow({ key: 'x', color: '#2e6660', iconEmoji: '🧩' }), '#2e6660');
});

test('#3523: a colour read off an icon or a name flavours the header; a colour a project sets keeps its own', () => {
  const lch = (hex) => {
    const [L, a, b] = color.rgbToLab(...color.parseHex(hex));
    return { L, C: Math.hypot(a, b) };
  };
  // Saturated icons, every hue round the wheel: dusky, never neon, and
  // still readable behind white.
  for (const rgb of [[229, 57, 53], [67, 160, 71], [253, 216, 53], [142, 36, 170], [0, 172, 193], [251, 140, 0], [30, 136, 229], [236, 64, 122]]) {
    const read = color.deriveFromPixels(px(rgb, 64));
    const { L, C } = lch(read);
    assert.ok(C <= color.SOFT.C + 0.005, `${read} (from ${rgb}) has chroma ${C.toFixed(3)}`);
    assert.ok(L <= color.SOFT.L + 0.005, `${read} (from ${rgb}) has lightness ${L.toFixed(3)}`);
    assert.ok(color.contrastWithWhite(read) >= 4.5);
  }
  // The same hue, only quieter: a red icon still reads red.
  const red = color.parseHex(color.deriveFromPixels(px([229, 57, 53], 64)));
  assert.ok(red[0] > red[1] && red[0] > red[2], 'the hue survives');
  // A name's swatch is a read colour too.
  assert.ok(lch(color.communityColorNow({ key: 'garden' })).C <= color.SOFT.C + 0.005);
  // A set colour is fitted only for white text: dapp.json's is the group's
  // choice (and Homeroom's own is left as it is, above).
  assert.equal(color.communityColorNow({ key: 'x', color: '#c0532f' }), color.fitForWhiteText('#c0532f', color.SET));
  assert.ok(lch(color.fitForWhiteText('#c0532f')).C > color.SOFT.C, 'the set fit is the looser one');
  // Readings are cached fitted, so the softer fit moved the cache on.
  assert.match(fs.readFileSync(path.join(ROOT, 'frontend/src/lib/community-color.ts'), 'utf8'), /const CACHE_PREFIX = 'communityColor:v2:';/);
});

test('dapp.json\'s icon.color reaches the page: manifest, column, list and app reads, store', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  assert.match(read('src/db/schema.sql'), /ALTER TABLE apps ADD COLUMN IF NOT EXISTS icon_color VARCHAR\(7\);/);
  assert.match(read('src/services/app-access.js'), /'icon_image_id', 'icon_color',/, 'the client-facing column list carries it');
  assert.match(read('frontend/src/features/improve/improve-status.js'), /iconColor: appData\.icon_color \|\| null,/);
  assert.match(read('frontend/src/features/workshop/community-scope.ts'), /iconColor: r\.icon_color \|\| null,/);
  const dapp = JSON.parse(read('dapp.json'));
  assert.deepEqual(dapp.icon, { image: 'public/apple-touch-icon.png', color: '#37477b' },
    'Homeroom sets its own: its mark is black and white, so it has no hue to read');
});

test('the header wears the colour on a project\'s pages, and not in the running app', () => {
  // The owner kept the colour on the Communities tab's pages and took it off
  // the running app (#852 review): there the bar is the standard one and
  // takes the app's tone. Which half is the improve store's `tab`.
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const fixed = (state) => ({ get: () => state, set() {}, subscribe: () => () => {} });
  const tintFor = (improve, screen) => {
    const mod = loadTsx('frontend/src/features/header/community-tint.ts', {
      stubs: {
        '../improve/improve-store.js': { improveStore: fixed(improve) },
        '../nav/nav-store.js': { navStore: fixed({ screen }) },
        '../../lib/community-color': { useResolvedCommunityColor: (src) => (src ? '#2e6660' : null) },
      },
    });
    const Probe = () => createElement('i', null, mod.useCommunityHeaderTint() || 'none');
    return renderToHtml(createElement(Probe, {})).replace(/<\/?i>/g, '');
  };
  const app = { slug: 'garden', iconUrl: null, iconEmoji: '🌱', iconColor: null };
  assert.equal(tintFor({ ...app, tab: 'dev' }, 'app-view'), '#2e6660', 'the project\'s pages: its colour');
  assert.equal(tintFor({ ...app, tab: 'app' }, 'app-view'), 'none', 'the running app: the standard bar');
  assert.equal(tintFor({ ...app, tab: 'dev' }, 'workshop-screen'), 'none', 'off the app view: nothing');
  assert.equal(tintFor({ slug: null, tab: 'app', iconUrl: null, iconEmoji: null, iconColor: null }, 'app-view'), 'none',
    'no target and nothing held yet: nothing');
});
