// The frame's kit and its nine looks are the 2026-11-06 screen tour's own
// stylesheets (frontend/looks/kit.css and one file per look, in the tour's
// notation). scripts/build-looks-css.js compiles them into a marked section
// of public/css/app.css: classes prefixed fr-, tokens prefixed --fr-, the
// tour's .hr root mapped to html[data-skin], .dark to .dark on <html>,
// .phone to a max-width media query, every rule keeping the weight it had
// beside its neighbours. This suite holds the mapping, and holds the
// committed section to the script's output.
//
// Run with: node --test tests/looks-css.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const looks = require('../scripts/build-looks-css.js');

// ── One selector ─────────────────────────────────────────────────────────

test('a kit selector is scoped to any look, a look\'s selector to its own flag', () => {
  assert.deepEqual(looks.mapSelector('.row .t', null), { media: null, selector: 'html[data-skin] .fr-row .fr-t' });
  assert.deepEqual(looks.mapSelector('.row .t', 'glass'), { media: null, selector: 'html[data-skin="glass"] .fr-row .fr-t' });
  assert.equal(looks.mapSelector('.nv.on .ic', 'glass').selector, 'html[data-skin="glass"] .fr-nv.fr-on .fr-ic');
  assert.equal(looks.mapSelector('.field label', null).selector, 'html[data-skin] .fr-field label');
  assert.equal(looks.mapSelector('.stack>.sec:nth-of-type(3n+1)>.card', 'pastel').selector,
    'html[data-skin="pastel"] .fr-stack>.fr-sec:nth-of-type(3n+1)>.fr-card');
  assert.equal(looks.mapSelector('.cols>.stack:first-child .card:has(>.row)>.row.on .s', 'mosaic').selector,
    'html[data-skin="mosaic"] .fr-cols>.fr-stack:first-child .fr-card:has(>.fr-row)>.fr-row.fr-on .fr-s');
  assert.equal(looks.mapSelector('.tab.on::after', null).selector, 'html[data-skin] .fr-tab.fr-on::after');
});

test('.phone becomes a media query and keeps its extra weight', () => {
  // `.phone .title` outweighs `.title` in the tour by one class; here by
  // one more attribute on html, so a look's plain rule cannot overtake the
  // kit's phone rule (or the reverse) just by coming later.
  assert.deepEqual(looks.mapSelector('.phone .title', 'glass'), { media: 'phone', selector: 'html[data-skin="glass"][data-skin] .fr-title' });
  assert.deepEqual(looks.mapSelector('.phone .cols>.first', null), { media: 'phone', selector: 'html[data-skin][data-skin] .fr-cols>.fr-first' });
  assert.deepEqual(looks.mapSelector('.hr.phone .d', null), { media: 'phone', selector: 'html[data-skin][data-skin] .fr-d' });
  assert.deepEqual(looks.mapSelector('.hr:not(.phone) .p', null), { media: 'wide', selector: 'html[data-skin][data-skin] .fr-p' });
  assert.deepEqual(looks.mapSelector('.phone .noside .colm', 'paper'), { media: 'phone', selector: 'html[data-skin="paper"][data-skin] .fr-noside .fr-colm' });
});

test('.dark moves onto <html>, with its weight', () => {
  assert.deepEqual(looks.mapSelector('.dark .tile.hm', null), { media: null, selector: 'html[data-skin].dark .fr-tile.fr-hm' });
  assert.deepEqual(looks.mapSelector('.dark .nv.on', 'playground'), { media: null, selector: 'html[data-skin="playground"].dark .fr-nv.fr-on' });
});

test('the mock\'s own machinery is dropped, and its reset is kept inside a frame root', () => {
  for (const sel of ['.hr.full', '.hr.phone.full', '.full .app', '.full .colm', '.full.phone .app', '.hr.phone']) {
    assert.equal(looks.mapSelector(sel, null), null, `${sel} sizes the tour's mock`);
  }
  assert.equal(looks.mapSelector('.hr *', null).selector, 'html[data-skin] .fr *');
  assert.equal(looks.mapSelector('.hr *::before', null).selector, 'html[data-skin] .fr *::before');
  assert.equal(looks.mapSelector('.hr svg.ic', null).selector, 'html[data-skin] .fr svg.fr-ic');
});

// ── Declarations ─────────────────────────────────────────────────────────

test('tokens are namespaced where they are set and where they are read', () => {
  assert.deepEqual(looks.mapDeclaration('--surface', '#fff'), ['--fr-surface', '#fff']);
  assert.deepEqual(looks.mapDeclaration('box-shadow', 'inset 0 0 0 1px var(--ring),var(--glow)'), ['box-shadow', 'inset 0 0 0 1px var(--fr-ring),var(--fr-glow)']);
  assert.deepEqual(looks.mapDeclaration('background', 'var(--tc,#888)'), ['background', 'var(--fr-tc,#888)']);
  assert.deepEqual(looks.mapDeclaration('--ts', '24px!important'), ['--fr-ts', '24px!important']);
  assert.deepEqual(looks.mapDeclaration('border-radius', 'calc(var(--ts) * .28)'), ['border-radius', 'calc(var(--fr-ts) * .28)']);
});

// ── A whole file ─────────────────────────────────────────────────────────

test('a look\'s root rule becomes its tokens on <html> and its type on the frame root', () => {
  const css = looks.compile('.hr{--surface:#fff;--f:"X",system-ui;font:14px/1.45 var(--f);background:var(--ground)}\n.hr.dark{--surface:#000}\n.row{min-height:42px}\n.phone .row{min-height:50px}\n.dark .row{color:red}', 'workbench');
  assert.match(css, /html\[data-skin="workbench"\]\{--fr-surface:#fff;--fr-f:"X",system-ui\}/);
  assert.match(css, /html\[data-skin="workbench"\] \.fr\{font:14px\/1\.45 var\(--fr-f\)\}/, 'type goes on the frame root, never on <html> (rem sizes hang off it)');
  assert.doesNotMatch(css, /background:var\(--fr-ground\)/, 'the page ground is the product\'s wallpaper, not the mock\'s');
  assert.match(css, /html\[data-skin="workbench"\]\.dark\{--fr-surface:#000\}/);
  assert.match(css, /html\[data-skin="workbench"\] \.fr-row\{min-height:42px\}/);
  assert.match(css, /html\[data-skin="workbench"\]\.dark \.fr-row\{color:red\}/);
  assert.match(css, /@media \(max-width: 767\.98px\)\{\nhtml\[data-skin="workbench"\]\[data-skin\] \.fr-row\{min-height:50px\}\n\}/);
});

test('a selector list is split when its parts land in different places', () => {
  const css = looks.compile('.row.wrap .tx,.phone .row .tx{display:block}', null);
  assert.match(css, /html\[data-skin\] \.fr-row\.fr-wrap \.fr-tx\{display:block\}/);
  assert.match(css, /@media \(max-width: 767\.98px\)\{\nhtml\[data-skin\]\[data-skin\] \.fr-row \.fr-tx\{display:block\}\n\}/);
});

test('the kit\'s root rule keeps colour and type for the frame root and drops the mock\'s box', () => {
  const css = looks.compile(read('frontend', 'looks', 'kit.css'), null);
  const root = css.match(/html\[data-skin\] \.fr\{([^}]*)\}/);
  assert.ok(root, 'a rule for the frame root');
  assert.match(root[1], /color:var\(--fr-ink\)/);
  assert.match(root[1], /font:15px\/1\.45 var\(--fr-f\)/);
  for (const prop of ['width:', 'height:', 'position:', 'overflow:', 'background:', 'color-scheme:']) assert.ok(!root[1].includes(prop), `${prop} belongs to the mock`);
  assert.match(css, /html\[data-skin\]\{--fr-ground:[^;]*;--fr-surface:#fff;/, 'light tokens on any look');
  assert.match(css, /html\[data-skin\]\.dark\{--fr-ground:[^;]*;--fr-surface:#151823;/, 'dark tokens on any look');
});

// ── What the product's own markup wears ──────────────────────────────────

test('a kit rule for a worn component also names the product\'s own markup for it', () => {
  // A conversation is drawn by the product's renderer (message-row.tsx, the
  // thread header, the composer): hundreds of behaviours the kit's markup
  // has no word for. looks.json "wear" says which of the product's classes
  // is each kit class of those components, and the rule names both.
  assert.equal(looks.wornSelector('html[data-skin] .fr-post .fr-who'), 'html[data-skin]:where(:not([data-skin="brand"])) .messages-message .messages-message-author',
    'the kit is any look\'s, and the New look ("brand") is not one: its conversations keep the standard markup\'s rules');
  assert.equal(looks.wornSelector('html[data-skin="workbench"] .fr-post .fr-when'), 'html[data-skin="workbench"] .messages-message .messages-message-head time');
  assert.equal(looks.wornSelector('html[data-skin="workbench"] .fr-post'), 'html[data-skin="workbench"] .messages-message');
  assert.equal(looks.wornSelector('html[data-skin] .fr-day::before'), 'html[data-skin]:where(:not([data-skin="brand"])) .messages-day::before');
  assert.equal(looks.wornSelector('html[data-skin][data-skin] .fr-dhead'), 'html[data-skin][data-skin]:where(:not([data-skin="brand"])) .messages-thread-header', 'a phone rule keeps its weight');
  assert.equal(looks.wornSelector('html[data-skin].dark .fr-day'), 'html[data-skin].dark:where(:not([data-skin="brand"])) .messages-day');
  assert.equal(looks.wornSelector('html[data-skin="brandkit"] .fr-dhead .fr-t'), 'html[data-skin="brandkit"] .messages-thread-header .messages-thread-name');
  assert.equal(looks.wornSelector('html[data-skin="playground"].dark .fr-composer .fr-send.fr-go'), 'html[data-skin="playground"].dark .messages-composer-card .messages-send:not(:disabled)',
    'a state the kit writes as a class is the product\'s own state');
});

test('a class the map does not name stays the kit\'s, and a rule for anything else is not repeated', () => {
  assert.equal(looks.wornSelector('html[data-skin="workbench"] .fr-post .fr-av'), 'html[data-skin="workbench"] .messages-message .fr-av', 'the avatar in a message is the kit\'s own');
  assert.equal(looks.wornSelector('html[data-skin] .fr-row .fr-t'), null, 'a row is drawn by the kit: nothing to repeat');
  assert.equal(looks.wornSelector('html[data-skin] .fr-status .fr-txt'), null, 'a part only counts inside its own component');
  assert.equal(looks.wornSelector('html[data-skin] .fr-post .fr-txt b'), null, 'left out by name: a bold word a person wrote is not an accent');
});

test('compiled, the worn selector rides on the kit\'s own rule, in the same place', () => {
  const css = looks.compile('.post .who{font-weight:650}.phone .dhead{padding:8px 16px}.row .t{font-weight:650}', null);
  assert.match(css, /html\[data-skin\] \.fr-post \.fr-who,html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.messages-message \.messages-message-author\{font-weight:650\}/);
  assert.match(css, /@media \(max-width: 767\.98px\)\{\nhtml\[data-skin\]\[data-skin\] \.fr-dhead,html\[data-skin\]\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.messages-thread-header\{padding:8px 16px\}\n\}/);
  assert.match(css, /html\[data-skin\] \.fr-row \.fr-t\{font-weight:650\}/);
});

// ── The committed section ────────────────────────────────────────────────

const BEGIN = '/* looks:begin';
const END = '/* looks:end */';
function section() {
  const css = read('public', 'css', 'app.css');
  const a = css.indexOf(BEGIN);
  const b = css.indexOf(END);
  assert.ok(a > 0 && b > a, 'app.css carries the generated section between its two marks');
  return css.slice(a, b + END.length);
}

test('app.css carries exactly what the script builds from frontend/looks/', () => {
  assert.equal(section(), looks.build(), 'run `node scripts/build-looks-css.js` after changing a file in frontend/looks/');
});

test('the section sits just before the New look\'s block, which stays last', () => {
  const css = read('public', 'css', 'app.css');
  const end = css.indexOf(END) + END.length;
  assert.match(css.slice(end, end + 80), /^\n\n\/\* ── THE NEW LOOK, AN EXPERIMENT/);
});

// The product's classes looks.json "wear" names: the only ones the section may carry.
const WORN = new Set(Object.values(looks.config.wear.roots).flatMap((root) => [root.to, ...Object.values(root.parts || {})])
  .flatMap((sel) => sel.match(/\.[a-zA-Z][\w-]*/g) || []));

test('every rule of the section starts from a look, and every class and token is the frame\'s', () => {
  const body = section().replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...body.matchAll(/(?:^|\n)([^@{}\n][^{}]*)\{([^{}]*)\}/g)];
  assert.ok(rules.length > 900, `the kit and nine looks are all there (${rules.length} rules)`);
  for (const [, head, decls] of rules) {
    for (const sel of head.split(/,(?![^()]*\))/).map((s) => s.trim())) {
      assert.match(sel, /^html\[data-skin/, `"${sel}" must start from a look`);
      const classes = sel.replace(/^html\[data-skin(?:="[a-z]+")?\](?:\[data-skin\])?(?:\.dark)?(?::not\(\.dark\))?(?::not\(\[data-app-tone="(?:dark|light)"\]\))?(?::where\([^)]*\)\))?/, '').match(/\.[a-zA-Z][\w-]*/g) || [];
      for (const c of classes) assert.ok(/^\.fr(-|$)/.test(c) || WORN.has(c), `${c} in "${sel}" is neither a frame class nor one the product's markup wears`);
    }
    // --home-ground is the product's: the frame's ground follows it.
    for (const m of decls.matchAll(/var\((--[a-z0-9-]+)/g)) assert.match(m[1], /^--(fr-|home-ground$)/, `${m[1]} is read un-namespaced`);
  }
});

test('each look is headed by its flag, in the registry\'s order, with its fonts, tint and fallbacks', () => {
  const mod = require('./lib/render-tsx').loadTsx('frontend/src/lib/skin.ts');
  const text = section();
  let last = 0;
  for (const id of mod.FRAME_SKINS) {
    const at = text.indexOf(`(data-skin="${id}")`);
    assert.ok(at > last, `${id}'s block follows the one before it`);
    last = at;
    const block = text.slice(text.lastIndexOf('/* ── ', at), text.indexOf('\n/* ── ', at) > 0 ? text.indexOf('\n/* ── ', at) : text.length);
    const look = looks.config.looks[id];
    assert.match(block, new RegExp(`html\\[data-skin="${id}"\\]\\{font-family:'${look.family}',system-ui`), `${id}: its typeface leads the document's stack`);
    assert.match(block, new RegExp(`html\\[data-skin="${id}"\\]\\{[^}]*--accent-tint:rgba\\(`), `${id}: a literal tint in light`);
    assert.match(block, new RegExp(`html\\[data-skin="${id}"\\]\\.dark\\{[^}]*--accent-tint:rgba\\(`), `${id}: and in dark`);
    for (const dir of look.faces) {
      for (const f of looks.config.fonts[dir].files) {
        assert.ok(block.includes(`url('/fonts/${dir}/${f.file}') format('woff2')`), `${id}: ${f.file} from our own origin`);
        assert.ok(fs.statSync(path.join(ROOT, 'public', 'fonts', dir, f.file)).size > 5000);
      }
    }
    assert.equal(block.includes('@supports not (backdrop-filter: blur(1px))'), !!look.opaque, `${id}: an opaque surface where backdrop-filter is missing, if it is translucent`);
    assert.equal(block.includes('--home-ground:'), !!look.ground, `${id}: only a look with its own page moves the ground`);
  }
});

test('what every look shares: the product\'s tokens follow the look\'s, at a look\'s own weight', () => {
  const text = section();
  const m = text.match(/html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\)\{([^}]*)\}/);
  assert.ok(m, 'one rule for any look but New look, its exception inside :where() so More contrast still outweighs it');
  for (const [token, from] of [['--text-primary', '--fr-ink'], ['--text-secondary', '--fr-mut'], ['--text-muted', '--fr-faint'], ['--border', '--fr-line'],
    ['--border-light', '--fr-line'], ['--accent', '--fr-acc'], ['--accent-ink', '--fr-acc-ink'], ['--accent-tint-ink', '--fr-acc'], ['--lit-ink', '--fr-lit'],
    ['--lit-tint', '--fr-lit-t'], ['--lit-line', '--fr-line'], ['--dc-sheet', '--fr-surface'], ['--dc-sheet-solid', '--fr-surface'], ['--dc-sheet-raise', '--fr-surface'],
    ['--app-sheet-line', '--fr-line']]) {
    assert.ok(m[1].includes(`${token}:var(${from})`), `${token} follows ${from}`);
  }
});
