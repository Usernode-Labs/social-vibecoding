'use strict';

// Homeroom's brand kit (13 October 2026): one source of the brand, and the
// places that hand it to apps.
//
//   1. THE KIT is .agents/skills/homeroom-brand/: the rules, the tokens
//      (DESIGN.md's front matter) and the assets.
//   2. HOSTED. Its fonts and logos are served to every app from
//      public/usernode-native/v1/brand/, beside the native UI kit, so they
//      reach an app on its own origin through the routes that already exist.
//      Those files are copies, and must stay byte for byte the kit's.
//   3. THE DEFAULT LOOK. A new app's starter links the hosted stylesheet,
//      names the two typefaces, and starts its colour tokens on the palette.
//   4. ICONS AND FEATURED ILLUSTRATIONS. The platform conventions draw both
//      from the palette.
//
// Run with: node --test tests/homeroom-brand-kit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { getTemplateFiles } = require('../src/services/template');

const ROOT = path.join(__dirname, '..');
const KIT = path.join(ROOT, '.agents', 'skills', 'homeroom-brand');
const HOSTED = path.join(ROOT, 'public', 'usernode-native', 'v1', 'brand');
const read = (p) => fs.readFileSync(p, 'utf8');

/** DESIGN.md's front-matter colours: { cream: '#FFFEEA', ... }. */
function paletteOf() {
  const design = read(path.join(KIT, 'DESIGN.md'));
  const front = design.split('---')[1];
  const colours = front.split('colors:')[1].split('typography:')[0];
  return Object.fromEntries([...colours.matchAll(/^\s+([\w-]+): "(#[0-9A-F]{6})"$/gim)].map(([, k, v]) => [k, v.toUpperCase()]));
}
const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(' ');

test('the kit is a skill with its rules, tokens and assets', () => {
  const skill = read(path.join(KIT, 'SKILL.md'));
  assert.match(skill, /^---\nname: homeroom-brand\ndescription: /);
  for (const f of ['BRAND.md', 'DESIGN.md', 'assets/fonts/geist.woff2', 'assets/fonts/source-serif-4.woff2',
    'assets/homeroom-mark-black.svg', 'assets/homeroom-wordmark-black.svg']) {
    assert.ok(fs.existsSync(path.join(KIT, f)), f);
  }
  const palette = paletteOf();
  assert.deepEqual(palette, {
    cream: '#FFFEEA', yellow: '#FFEE6F', blue: '#3090E1', green: '#A9CF97', white: '#FFFFFF',
    'pale-yellow': '#FCFAB3', black: '#000000', grey: '#B9B9B9', background: '#FFFEEA', text: '#000000',
  });
  // Where it is wired, so an edit to the kit finds its copies.
  assert.match(skill, /public\/usernode-native\/v1\/brand\//);
  assert.match(skill, /tests\/homeroom-brand-kit\.test\.js/);
});

test('the hosted fonts and logos are the kit\'s, byte for byte', () => {
  const pairs = [
    ['fonts/geist.woff2', 'assets/fonts/geist.woff2'],
    ['fonts/source-serif-4.woff2', 'assets/fonts/source-serif-4.woff2'],
    ...['mark', 'wordmark'].flatMap((kind) => ['black', 'cream', 'white'].map((ink) =>
      [`homeroom-${kind}-${ink}.svg`, `assets/homeroom-${kind}-${ink}.svg`])),
  ];
  for (const [hosted, kit] of pairs) {
    assert.ok(fs.readFileSync(path.join(HOSTED, hosted)).equals(fs.readFileSync(path.join(KIT, kit))), hosted);
  }
  const files = fs.readdirSync(HOSTED, { recursive: true }).filter((f) => !fs.statSync(path.join(HOSTED, f)).isDirectory());
  assert.deepEqual(files.sort(), ['brand.css', ...pairs.map(([h]) => h)].sort(), 'nothing else is hosted there');
});

test('brand.css defines the two typefaces from its own folder and the palette, and styles nothing', () => {
  const css = read(path.join(HOSTED, 'brand.css'));
  const faces = [...css.matchAll(/@font-face \{([^}]*)\}/g)].map(([, body]) => body);
  assert.equal(faces.length, 2);
  for (const [family, file] of [['Geist', 'geist.woff2'], ['Source Serif 4', 'source-serif-4.woff2']]) {
    const face = faces.find((f) => f.includes(`font-family: '${family}'`));
    assert.ok(face, family);
    assert.match(face, new RegExp(`src: url\\('fonts/${file.replace('.', '\\.')}'\\) format\\('woff2'\\);`), `${family}: relative, so it loads on any origin`);
    assert.match(face, /font-display: swap;/);
  }
  const palette = paletteOf();
  for (const name of ['cream', 'yellow', 'blue', 'green', 'white', 'pale-yellow', 'black', 'grey']) {
    assert.match(css, new RegExp(`--hr-${name}: ${palette[name]};`), name);
  }
  assert.match(css, /--hr-display-weight: 460;/);
  // Only @font-face and :root rules: linking it restyles no element.
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map(([, sel]) => sel.trim());
  assert.deepEqual([...new Set(rules)], ['@font-face', ':root']);
});

test('the hosted path is one the platform already serves to apps', () => {
  assert.match(read(path.join(ROOT, 'src/middleware/auth.js')), /'\/usernode-native\/'/);
  const assets = read(path.join(ROOT, 'scripts/serve-platform-assets.js'));
  assert.match(assets, /'\/usernode-native\/'/);
  assert.match(assets, /'\.woff2': 'font\/woff2'/);
  assert.match(assets, /'\.svg': 'image\/svg\+xml'/);
});

function generate() {
  return getTemplateFiles('Demo App', 'demo-app-abc123', 'postgres://x', null, {});
}
const file = (files, p) => files.find((f) => f.path === p).content;

test('a new app starts in the brand: the stylesheet, the typefaces and the palette', () => {
  const files = generate();
  const html = file(files, 'public/index.html');
  const brand = html.indexOf('<link rel="stylesheet" href="/usernode-native/v1/brand/brand.css">');
  assert.ok(brand !== -1, 'the starter links the hosted brand stylesheet by relative path');
  assert.ok(brand < html.indexOf('<link rel="stylesheet" href="/tailwind.css">'), 'before the app\'s own stylesheet');

  const mod = { exports: {} };
  vm.runInNewContext(file(files, 'tailwind.config.js'), { module: mod, exports: mod.exports });
  const { fontFamily } = mod.exports.theme.extend;
  assert.equal(fontFamily.sans[0], 'Geist');
  assert.equal(fontFamily.display[0], '"Source Serif 4"');
  assert.equal(mod.exports.theme.extend.fontSize.title[1].fontWeight, '460');

  const css = file(files, 'styles/tailwind-input.css');
  const light = css.slice(css.indexOf(':root {'), css.indexOf('.dark {'));
  const dark = css.slice(css.indexOf('.dark {'));
  const palette = paletteOf();
  for (const [block, name, colour] of [
    [light, 'ground', 'cream'], [light, 'surface', 'white'], [light, 'raised', 'pale-yellow'], [light, 'fg', 'black'],
    [light, 'line', 'grey'], [light, 'accent', 'black'], [light, 'on-accent', 'cream'], [light, 'highlight', 'yellow'],
    [light, 'focus', 'blue'],
    [dark, 'ground', 'black'], [dark, 'fg', 'cream'], [dark, 'muted', 'grey'], [dark, 'accent', 'yellow'],
    [dark, 'on-accent', 'black'], [dark, 'focus', 'blue'],
  ]) {
    assert.match(block, new RegExp(`--${name}: ${channels(palette[colour])};`), `${name} is ${colour}`);
  }
  const claude = file(files, 'CLAUDE.md');
  assert.match(claude.replace(/\s+/g, ' '), /\*\*Palette:\*\* Homeroom's, the default/);
});

test('the conventions draw app icons and featured illustrations from the palette', () => {
  const conventions = read(path.join(ROOT, 'src/prompts/app-conventions.md'));
  const palette = new Set(Object.values(paletteOf()));
  const section = (heading) => {
    const start = conventions.indexOf(heading);
    assert.ok(start !== -1, heading);
    const next = conventions.slice(start + heading.length).search(/\n#{2,4} |\nPer-field rules:/);
    return conventions.slice(start, start + heading.length + next);
  };
  const icons = section('#### Icon style: Homeroom\'s set on the home screen');
  const rows = [...icons.matchAll(/^ {2}\| [\w ]+ \| `(#[0-9A-F]{6})` \| `(#[0-9A-F]{6})` \|/gm)];
  assert.equal(rows.length, 6, 'six tile colours');
  for (const [, fill, glyph] of rows) {
    assert.ok(palette.has(fill), `${fill} is a brand colour`);
    assert.ok(palette.has(glyph), `${glyph} is a brand colour`);
  }
  assert.doesNotMatch(icons, /linearGradient|radialGradient|feDropShadow/, 'flat: no gradient, gloss or shadow');
  assert.match(icons, /Never use the Homeroom mark or wordmark/);
  assert.match(icons, /Icons already drawn\s+in the earlier style \(a gradient with a white glyph\) stay as they are/);

  const featured = section('#### Featured illustration: the Discover card');
  for (const hex of featured.match(/#[0-9A-F]{6}/g)) assert.ok(palette.has(hex), `${hex} is a brand colour`);
  assert.match(featured, /cream, yellow, blue, sage or gray/);

  const look = section('### New apps: Homeroom\'s look, unless the group chooses another');
  assert.match(look, /<link rel="stylesheet" href="\/usernode-native\/v1\/brand\/brand\.css">/);
  assert.match(look, /Existing apps keep what they have\./);
});
