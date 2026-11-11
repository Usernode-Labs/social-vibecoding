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

test('Mosaic lays a list out as tiles, never a card of launcher tiles or a list of one-line rows', () => {
  const mosaic = read('frontend', 'looks', 'mosaic.css');
  const not = ':not(.list,:has(>.tiles,.row.showall,.row.item,.row.proj,.row.month,.row.th,.row.rk))';
  // Every rule of the mosaic carries the same exceptions: Home's Pinned apps
  // (tiles, then "Show all N apps") and You's History (an item under its
  // project's head row) were both laid out as two columns of tiles. The
  // rows are named at any depth: History's are inside a group per project.
  const all = mosaic.split('.cols>.stack:first-child .card:has(>.row)').length - 1;
  assert.ok(all >= 9);
  assert.equal(mosaic.split(`.cols>.stack:first-child .card:has(>.row)${not}`).length - 1, all);
  assert.ok(read('public', 'css', 'app.css').includes('html[data-skin="mosaic"] .fr-cols>.fr-stack:first-child .fr-card:has(>.fr-row):not(.fr-list,:has(>.fr-tiles,.fr-row.fr-showall,.fr-row.fr-item,.fr-row.fr-proj,.fr-row.fr-month,.fr-row.fr-th,.fr-row.fr-rk)),'));
});

test('on a phone only a card\'s own item rows wrap; a compact list\'s stay one line', () => {
  const css = read('public', 'css', 'app.css');
  assert.ok(css.includes('html[data-skin][data-skin] .fr-row.fr-item:not(.fr-list .fr-row){flex-wrap:wrap;'));
  assert.ok(css.includes('html[data-skin][data-skin] .fr-row.fr-item:not(.fr-list .fr-row) .fr-t{white-space:normal}'));
  // Homeroom bot's rows are a .list's, which the rule used to catch: three
  // rows filled a phone's screen where the standard list shows eight.
  assert.doesNotMatch(css, /html\[data-skin\]\[data-skin\] \.fr-row\.fr-item\{flex-wrap/);
  assert.doesNotMatch(css, /html\[data-skin\]\[data-skin\] \.fr-row\.fr-item \.fr-t\{white-space:normal\}/);
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
  const css = looks.compile('.hr{--surface:#fff;--f:"X",system-ui;font:14px/1.45 var(--f);background:var(--ground)}\n.hr.dark{--surface:#000}\n.tile{min-height:42px}\n.phone .tile{min-height:50px}\n.dark .tile{color:red}', 'workbench');
  assert.match(css, /html\[data-skin="workbench"\]\{--fr-surface:#fff;--fr-f:"X",system-ui\}/);
  assert.match(css, /html\[data-skin="workbench"\] \.fr\{font:14px\/1\.45 var\(--fr-f\)\}/, 'type goes on the frame root, never on <html> (rem sizes hang off it)');
  assert.doesNotMatch(css, /background:var\(--fr-ground\)/, 'the page ground is the product\'s wallpaper, not the mock\'s');
  assert.match(css, /html\[data-skin="workbench"\]\.dark\{--fr-surface:#000\}/);
  assert.match(css, /html\[data-skin="workbench"\] \.fr-tile\{min-height:42px\}/);
  assert.match(css, /html\[data-skin="workbench"\]\.dark \.fr-tile\{color:red\}/);
  assert.match(css, /@media \(max-width: 767\.98px\)\{\nhtml\[data-skin="workbench"\]\[data-skin\] \.fr-tile\{min-height:50px\}\n\}/);
});

test('a selector list is split when its parts land in different places', () => {
  const css = looks.compile('.tile.wrap .tx,.phone .tile .tx{display:block}', null);
  assert.match(css, /html\[data-skin\] \.fr-tile\.fr-wrap \.fr-tx\{display:block\}/);
  assert.match(css, /@media \(max-width: 767\.98px\)\{\nhtml\[data-skin\]\[data-skin\] \.fr-tile \.fr-tx\{display:block\}\n\}/);
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

// ── Sides that mirror ────────────────────────────────────────────────────

test('a side the tour wrote as left or right is written as the start or the end, so a look mirrors in Arabic', () => {
  // The tour is drawn left to right only. app.css mirrors (tests/rtl-logical-css.test.js),
  // so the compiler turns each physical side into its logical twin.
  const map = (prop, value) => looks.mapDeclarations(prop, value).map(([p, v]) => `${p}:${v}`).join(';');
  assert.equal(map('margin-left', '8px'), 'margin-inline-start:8px');
  assert.equal(map('padding-right', '40px'), 'padding-inline-end:40px');
  assert.equal(map('border-left', '1px solid var(--line)'), 'border-inline-start:1px solid var(--fr-line)');
  assert.equal(map('border-right', '2px solid var(--line2)!important'), 'border-inline-end:2px solid var(--fr-line2)!important');
  assert.equal(map('left', '3px'), 'inset-inline-start:3px');
  assert.equal(map('right', '16px'), 'inset-inline-end:16px');
  assert.equal(map('left', '50%'), 'left:50%', 'a centre is not a side: it stays with its translate');
  assert.equal(map('text-align', 'left'), 'text-align:start');
  assert.equal(map('text-align', 'center'), 'text-align:center');
  assert.equal(map('border-top-left-radius', '8px'), 'border-start-start-radius:8px');
  assert.equal(map('border-bottom-right-radius', '8px'), 'border-end-end-radius:8px');
});

test('a four-sided shorthand whose left and right differ is split so its sides mirror too', () => {
  const map = (prop, value) => looks.mapDeclarations(prop, value).map(([p, v]) => `${p}:${v}`).join(';');
  assert.equal(map('padding', '4px 4px 4px 8px'), 'padding-block:4px 4px;padding-inline:8px 4px');
  assert.equal(map('margin', '0 9px'), 'margin:0 9px', 'the same on both sides: left as written');
  assert.equal(map('padding', '60px 24px 0 0'), 'padding-block:60px 0;padding-inline:0 24px');
  assert.equal(map('border-radius', '0 4px 4px 0'), 'border-start-start-radius:0;border-start-end-radius:4px;border-end-end-radius:4px;border-end-start-radius:0');
  assert.equal(map('border-radius', '2px 2px 0 0'), 'border-radius:2px 2px 0 0', 'top and bottom differ, the sides do not');
  assert.equal(map('border-radius', '24px 24px 0 0!important'), 'border-radius:24px 24px 0 0!important');
  assert.equal(map('padding', '0 16px'), 'padding:0 16px');
});

test('the generated section holds no physical side', () => {
  const body = section().replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(body, /[;{](margin|padding|border)-(left|right)\b[^;}]*/);
  assert.doesNotMatch(body, /[;{](left|right):(?!50%)/);
  assert.doesNotMatch(body, /text-align:(left|right)/);
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
  // (The day's label has a second wearer, the count of a reply thread's replies: lane M, tests/messages-frame-stream.test.js.)
  assert.equal(looks.wornSelector('html[data-skin] .fr-day::before').split(',')[0], 'html[data-skin]:where(:not([data-skin="brand"])) .messages-day::before');
  assert.equal(looks.wornSelector('html[data-skin][data-skin] .fr-dhead'), 'html[data-skin][data-skin]:where(:not([data-skin="brand"])) .messages-thread-header', 'a phone rule keeps its weight');
  assert.equal(looks.wornSelector('html[data-skin].dark .fr-day').split(',')[0], 'html[data-skin].dark:where(:not([data-skin="brand"])) .messages-day');
  assert.equal(looks.wornSelector('html[data-skin="brandkit"] .fr-dhead .fr-t'), 'html[data-skin="brandkit"] .messages-thread-header .messages-thread-name');
  assert.equal(looks.wornSelector('html[data-skin="playground"].dark .fr-composer .fr-send.fr-go'), 'html[data-skin="playground"].dark .messages-composer-card .messages-send:not(:disabled)',
    'a state the kit writes as a class is the product\'s own state');
});

test('a class the map does not name stays the kit\'s, and a rule for anything else is not repeated', () => {
  assert.equal(looks.wornSelector('html[data-skin="workbench"] .fr-post .fr-av'), 'html[data-skin="workbench"] .messages-message .fr-av', 'the avatar in a message is the kit\'s own');
  assert.equal(looks.wornSelector('html[data-skin] .fr-tile .fr-t'), null, 'a tile is drawn by the kit: nothing to repeat');
  // Each wearer of a root is a selector of its own: Settings' rows first, then the review stage's help rows (lane K).
  assert.deepEqual(looks.wornSelector('html[data-skin] .fr-row+.fr-row').split(',html'), ['html[data-skin]:where(:not([data-skin="brand"])) :is(.ui-lrow,.ui-row,.drawer-ver-row):is(#settings-root *)+:is(.ui-lrow,.ui-row,.drawer-ver-row):is(#settings-root *)', '[data-skin]:where(:not([data-skin="brand"])) .rf-help-row+.rf-help-row'], 'Settings\' rows wear the row, the scope inside each compound');
  assert.equal(looks.wornSelector('html[data-skin] .fr-status .fr-txt'), null, 'a part only counts inside its own component');
  assert.equal(looks.wornSelector('html[data-skin] .fr-post .fr-txt b'), null, 'left out by name: a bold word a person wrote is not an accent');
});

test('compiled, the worn selector rides on the kit\'s own rule, in the same place', () => {
  const css = looks.compile('.post .who{font-weight:650}.phone .dhead{padding:8px 16px}.tile .t{font-weight:650}', null);
  assert.match(css, /html\[data-skin\] \.fr-post \.fr-who,html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.messages-message \.messages-message-author\{font-weight:650\}/);
  assert.match(css, /@media \(max-width: 767\.98px\)\{\nhtml\[data-skin\]\[data-skin\] \.fr-dhead,html\[data-skin\]\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.messages-thread-header\{padding:8px 16px\}\n\}/);
  assert.match(css, /html\[data-skin\] \.fr-tile \.fr-t\{font-weight:650\}/);
});

// ── Version 2: what today's content needs of the kit ─────────────────────

// The block at the end of kit.css (11 Nov 2026): the pieces the looks need
// to draw the product's own content in the first tour's layout. It only
// adds: each rule names a class, or a pairing, that nothing drew before.
const V2_MARK = '/* ==== version 2 (11 Nov 2026)';
const kitSource = () => read('frontend', 'looks', 'kit.css');
const v2Source = () => kitSource().slice(kitSource().indexOf(V2_MARK));

test('version 2 is one block at the end of kit.css, and nothing above it changed with it', () => {
  const src = kitSource();
  const at = src.indexOf(V2_MARK);
  assert.ok(at > 0 && src.indexOf(V2_MARK, at + 1) < 0, 'one marked block');
  assert.match(src.slice(0, at), /\.nv\.all \.nm\{color:var\(--mut\)\}\n\n$/, 'it starts after the tour\'s own last rule');
  // The sideways row of picture cards and the two-line wrapping row were
  // there before it; version 2 adds a modifier beside each instead of
  // changing them under the pages that use them.
  assert.match(src.slice(0, at), /\.hrow\{display:flex;gap:10px;padding:2px 0 4px;overflow-x:auto;/);
  assert.match(src.slice(0, at), /\.row\.wrap \.s\{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;/);
});

test('version 2 is written with the kit\'s tokens only, and names no side', () => {
  const body = v2Source().replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, 'no literal colour: a look could not restyle it');
  const tokens = new Set([...kitSource().slice(0, kitSource().indexOf(V2_MARK)).matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]));
  for (const m of body.matchAll(/var\(--([a-z0-9-]+)/g)) {
    assert.ok(tokens.has(m[1]) || ['tc', 'bn', 'solid'].includes(m[1]), `--${m[1]} is not one of the kit's tokens (tc and bn are given by the data; solid is a see-through look's opaque surface, from looks.json)`);
  }
  assert.doesNotMatch(body, /box-shadow:inset -?[1-9]\d*px 0 0/, 'a line on one side is a border, which mirrors; an inset shadow does not');
});

test('version 2 names no class the kit already styled on its own, so no page drawn before it changes', () => {
  const src = kitSource();
  const before = src.slice(0, src.indexOf(V2_MARK)).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = (text) => [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()));
  const old = new Set(rules(before));
  for (const sel of rules(v2Source())) assert.ok(!old.has(sel), `"${sel}" is already a rule of the kit: version 2 may not restate it`);
  // A bare class of version 2 is a new name (a bare .quiet or .more would
  // have dressed the quiet button and the "+3" face).
  const oldNames = new Set([...before.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  for (const sel of rules(v2Source())) {
    const bare = /^\.([a-zA-Z][\w-]*)$/.exec(sel);
    if (bare && oldNames.has(bare[1])) assert.ok(['acc'].includes(bare[1]), `.${bare[1]} is a class the kit already uses in a pairing`);
  }
});

test('version 2, compiled: each piece under any look, phone rules in the phone block, sides mirrored', () => {
  const css = looks.compile(v2Source(), null);
  // A piece Settings wears (looks.json "wear") carries the worn selectors
  // beside the kit's own: the rule is read with those taken out.
  const kitOnly = css.split('\n').filter((rule) => rule.startsWith('html')).map((rule) => {
    const at = rule.indexOf('{');
    return topLevel(rule.slice(0, at)).filter((sel) => !/:where\(:not\(\[data-skin="brand"\]\)\)/.test(sel)).join(',') + rule.slice(at);
  }).join('\n');
  const has = (text, why) => assert.ok(css.includes(text) || kitOnly.includes(text), why || text);
  // The page, its head, its tabs.
  has('html[data-skin] .fr-inner.fr-narrow{max-width:784px}');
  has('html[data-skin] .fr-cols.fr-flip{grid-template-columns:360px minmax(0,680px)}');
  assert.match(css, /html\[data-skin\] \.fr-head>\.fr-tile,[^{]*html\[data-skin\] \.fr-head>\.fr-av,[^{]*html\[data-skin\] \.fr-head>\.fr-lead[^{]*\{margin-top:2px\}/, 'the head\'s picture (Settings\' own head wears the head too, so the rule is repeated for it)');
  has('html[data-skin] .fr-cap.fr-over{margin-bottom:8px}');
  has('html[data-skin] .fr-cap.fr-sub{padding:4px 4px 0}');
  has('html[data-skin] .fr-sub13{font-size:13px;color:var(--fr-mut);margin-top:4px}');
  has('html[data-skin] .fr-sub15{font-size:15px;line-height:1.45}');
  has('html[data-skin] .fr-sub22{font-size:22px;font-weight:700;letter-spacing:-.02em}');
  has('html[data-skin] .fr-mut{color:var(--fr-mut);font-weight:500}');
  has('html[data-skin] .fr-secnote{font-size:13px;color:var(--fr-mut);padding:0 4px}');
  has('html[data-skin] .fr-tabs .fr-end{margin-inline-start:auto;display:flex;align-items:center;gap:8px;flex:none}', 'the tabs\' end slot, at the row\'s end either way round');
  has('html[data-skin] .fr-tabs.fr-seg .fr-tab{flex:1;justify-content:center}');
  has('html[data-skin] .fr-link.fr-bad{color:var(--fr-bad)}');
  // Rows.
  has('html[data-skin] .fr-row.fr-wrap.fr-all .fr-t,html[data-skin] .fr-row.fr-wrap.fr-all .fr-s{white-space:normal;overflow:visible}', 'a switch\'s sentence is never cut');
  has('html[data-skin] .fr-row.fr-wrap.fr-all .fr-s{display:block;-webkit-line-clamp:none;');
  has('html[data-skin] .fr-row.fr-showall{justify-content:center}');
  has('html[data-skin] .fr-row.fr-showall .fr-t{color:var(--fr-acc);font-size:13px;font-weight:600}');
  has('html[data-skin] .fr-row.fr-headrow .fr-link{flex:none;white-space:nowrap}');
  has('html[data-skin] .fr-row.fr-week .fr-t{font-weight:700}');
  has('html[data-skin] .fr-row.fr-item .fr-t{font-weight:500}');
  has('html[data-skin] .fr-row .fr-num,');
  has('html[data-skin] .fr-row .fr-ei,');
  has('html[data-skin] .fr-list .fr-row.fr-sm{min-height:40px;padding-top:4px;padding-bottom:4px}');
  has('html[data-skin] .fr-list .fr-row.fr-more{padding-inline-start:52px}');
  has('html[data-skin] .fr-pill.fr-mini{height:20px;padding:0 8px;margin-inline-start:8px;vertical-align:1px;font-weight:600}');
  // Tiles.
  has('html[data-skin] .fr-tiles.fr-t8{grid-template-columns:repeat(8,minmax(0,1fr))}');
  has('html[data-skin] .fr-at.fr-dim .fr-tile,html[data-skin] .fr-at.fr-dim .fr-nm{opacity:.5}');
  has('html[data-skin] .fr-at .fr-corner{position:absolute;top:-6px;inset-inline-start:calc(50% + 14px);');
  has('html[data-skin] .fr-lead.fr-dash{background:transparent;border:1.5px dashed var(--fr-faint);color:var(--fr-mut)}');
  // Numbers, bars, progress.
  has('html[data-skin] .fr-fact .fr-l.fr-sub{font-size:12px;color:var(--fr-faint);white-space:normal}');
  has('html[data-skin] .fr-facts.fr-inset .fr-fact+.fr-fact{border-inline-start:0}');
  has('html[data-skin] .fr-facts+.fr-bars{border-top:1px solid var(--fr-line2)}');
  has('html[data-skin] .fr-bars{display:grid;grid-template-columns:repeat(var(--fr-bn,7),1fr);');
  has('html[data-skin] .fr-bcol.fr-now .fr-bl{color:var(--fr-ink);font-weight:700}');
  has('html[data-skin] .fr-foot.fr-left{text-align:start;padding:4px 16px 16px;font-size:12px}');
  has('html[data-skin] .fr-prog i{display:block;height:100%;border-radius:3px;background:var(--fr-lit)}', 'a bar still moving is drawn in the lit ink');
  has('html[data-skin] .fr-prog.fr-done i{background:var(--fr-ok)}', 'and a finished one may be green');
  has('html[data-skin] .fr-prog.fr-meter{margin:8px 0}');
  // Cards side by side, a grid of cards, pictures.
  has('html[data-skin] .fr-hrow.fr-even{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:12px;padding:0;overflow:visible}');
  has('html[data-skin] .fr-hcard{display:flex;flex-direction:column;gap:6px}');
  has('html[data-skin] .fr-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}');
  has('html[data-skin] .fr-card.fr-on{box-shadow:inset 0 0 0 2px var(--fr-acc)}');
  has('html[data-skin] .fr-fcover .fr-pill{position:absolute;inset-inline-start:8px;bottom:8px;background:var(--fr-surface);color:var(--fr-ink)}');
  has('html[data-skin] .fr-cover{aspect-ratio:16/10;border-radius:20px;background:var(--fr-tc,var(--fr-sunk));');
  // Fields.
  has('html[data-skin] .fr-field label.fr-lab{display:flex;justify-content:space-between;align-items:baseline;gap:8px}');
  has('html[data-skin] .fr-fieldrow .fr-inp{flex:1}');
  has('html[data-skin] .fr-inp>textarea.fr-v{flex:1;min-width:0;min-height:64px;border:0;outline:0;background:none;font:inherit;');
  has('html[data-skin] .fr-inp>select.fr-v{flex:1;min-width:0;min-height:44px;margin-inline-end:-26px;padding-inline-end:26px;', 'the select reaches under its chevron, so a press there opens it');
  has('html[data-skin] .fr-bullets{padding-block:4px 12px;padding-inline:34px 16px;font-size:14px;line-height:1.6}');
  // A thread's small parts.
  has('html[data-skin] .fr-quote{border-inline-start:3px solid var(--fr-acc);');
  has('html[data-skin] .fr-byline b{color:var(--fr-ink);font-weight:650;font-size:15px}');
  has('html[data-skin] .fr-lone{padding:64px 16px;text-align:center;color:var(--fr-mut)}');
  // A phone.
  const phone = kitOnly.slice(kitOnly.indexOf('html[data-skin][data-skin]'));
  assert.ok(css.indexOf('@media (max-width: 767.98px){') > 0 && css.indexOf('@media (max-width: 767.98px){') < css.indexOf('html[data-skin][data-skin]'), 'the doubled flag is the phone block\'s');
  for (const rule of [
    'html[data-skin][data-skin] .fr-cols.fr-flip{grid-template-columns:minmax(0,1fr)}',
    'html[data-skin][data-skin] .fr-tabs .fr-end{display:none}',
    'html[data-skin][data-skin] .fr-list .fr-row.fr-sm{min-height:44px}',
    'html[data-skin][data-skin] .fr-tiles.fr-t8,html[data-skin][data-skin] .fr-inner.fr-narrow .fr-tiles.fr-t8{grid-template-columns:repeat(4,minmax(0,1fr))}',
    'html[data-skin][data-skin] .fr-hrow.fr-even{grid-auto-columns:240px;overflow-x:auto;margin-inline-end:-16px}',
    'html[data-skin][data-skin] .fr-grid{grid-template-columns:repeat(2,minmax(0,1fr))}',
    'html[data-skin][data-skin] .fr-shots.fr-s3{grid-template-columns:none;grid-auto-flow:column;grid-auto-columns:200px;overflow-x:auto}',
  ]) assert.ok(phone.includes(rule), `${rule} belongs to a phone`);
});

test('version 2 dresses nothing of the product\'s own that it did not dress before', () => {
  // A kit rule naming a worn component is repeated for the product's markup
  // (looks.json "wear"). A state the kit writes as a class (.card.on,
  // .card.press, .row.showall, .btn.chip, .ib.more) never reaches it; what
  // is repeated only places a kit element inside or beside a worn one.
  const css = looks.compile(v2Source(), null);
  const worn = css.split('\n').filter((rule) => rule.startsWith('html')).flatMap((rule) => topLevel(rule.slice(0, rule.indexOf('{')))).filter((sel) => /:where\(:not\(\[data-skin="brand"\]\)\)/.test(sel));
  // Settings is the one screen that wears version 2's own pieces (lane S: the
  // 22px name, the note, the link's bad tone, the wrapping row): every such
  // selector is held inside Settings by name. Anywhere else a worn rule only
  // places a kit element inside or beside a worn one, and they stay a handful.
  const SETTINGS = /#settings-root|#settings-section-content|\.settings-(frame|page|filter)/;
  const elsewhere = worn.filter((sel) => !SETTINGS.test(sel));
  assert.ok(worn.length > 0 && elsewhere.length < 53, `a handful only outside Settings (${elsewhere.length} of ${worn.length})`);
  for (const sel of elsewhere) assert.match(sel, /\.fr-[\w-]+/, `"${sel}" would dress the product's markup with no kit element in it`);
  assert.doesNotMatch(css, /messages-|dev-request|dev-change|auth-waiting/, 'no conversation, request or waiting-room node is named');
});

test('an item\'s page keeps the product\'s discussion and dresses it: the stream a card, its count a section\'s label, what happened an event line', () => {
  // Lane T of version 2 (a request's and a change's page). P0 left the
  // event line out of the map on purpose; the lane that redraws the page
  // adds it, with the stream's card and its label.
  const roots = looks.config.wear.roots;
  assert.deepEqual(roots.evt, { to: '#dev-topic-thread #gc-thread-messages .dev-request-event', parts: { ei: '.dev-request-event-glyph' } },
    'two ids: the standard look\'s rule for the line names both, and a worn rule must outweigh it');
  assert.equal(looks.wornSelector('html[data-skin] .fr-evt .fr-ei'), 'html[data-skin]:where(:not([data-skin="brand"])) #dev-topic-thread #gc-thread-messages .dev-request-event .dev-request-event-glyph');
  assert.equal(looks.wornSelector('html[data-skin="workbench"] .fr-evt b'), 'html[data-skin="workbench"] #dev-topic-thread #gc-thread-messages .dev-request-event b');
  // The stream wears the card as a second wearer, a selector of its own:
  // inside the first's :is() its two ids would lift every other card.
  assert.doesNotMatch(roots.card.to, /gc-thread-messages/);
  assert.deepEqual(roots.card.also[0], { to: '#dev-topic-thread .dev-request #gc-thread-messages:is([data-language="request"],[data-language="change"])' });
  const card = looks.wornSelector('html[data-skin] .fr-card');
  // Every wearer in turn (Settings' cards are a third, tests/settings-frame.test.js), each a selector of its own.
  assert.equal(card, [roots.card, ...roots.card.also].map((w) => `html[data-skin]:where(:not([data-skin="brand"])) ${w.to}`).join(','));
  assert.ok(card.startsWith(`html[data-skin]:where(:not([data-skin="brand"])) ${roots.card.to},html[data-skin]:where(:not([data-skin="brand"])) ${roots.card.also[0].to}`));
  assert.equal(looks.wornSelector('html[data-skin] .fr-card.fr-pad'), null, 'a state neither wearer carries is still left out');
  // The line that counts the replies is the section's label: the kit's
  // .cap, and .sechead .cap for the looks that draw a section's label
  // larger (Today, Playground). The section head's own box is not worn.
  assert.equal(looks.wornSelector('html[data-skin="paper"] .fr-cap').split(',')[0], 'html[data-skin="paper"] #dev-topic-thread .dev-request .messages-reply-count');
  assert.equal(looks.wornSelector('html[data-skin="today"] .fr-sechead .fr-cap', '.sechead .cap'), 'html[data-skin="today"] #dev-topic-thread .dev-request #gc-thread-messages .messages-reply-count');
  assert.equal(looks.wornSelector('html[data-skin] .fr-sechead', '.sechead'), null);
  assert.equal(looks.wornSelector('html[data-skin] .fr-cap.fr-over'), null);
  const css = section();
  assert.ok(css.includes('html[data-skin="today"] .fr-sechead .fr-cap,html[data-skin="today"] #dev-topic-thread .dev-request #gc-thread-messages .messages-reply-count{font-size:22px;'));
  assert.ok(css.includes(',html[data-skin]:where(:not([data-skin="brand"])) #dev-topic-thread #gc-thread-messages .dev-request-event{display:flex;align-items:center;gap:12px;font-size:13px;color:var(--fr-mut);min-width:0}'));
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
const WORN = new Set(Object.values(looks.config.wear.roots).flatMap((root) => [root.to, ...(root.also || []).flatMap((w) => [w.to, ...Object.values(w.parts || {})]), ...Object.values(root.parts || {})])
  .flatMap((sel) => sel.match(/\.[a-zA-Z][\w-]*/g) || []));

// A rule's selectors: split at the commas outside every bracket (a worn
// selector nests :is() in :is()).
function topLevel(head) {
  const out = [];
  let depth = 0;
  let at = 0;
  for (let i = 0; i < head.length; i += 1) {
    if (head[i] === '(') depth += 1;
    else if (head[i] === ')') depth -= 1;
    else if (head[i] === ',' && depth === 0) { out.push(head.slice(at, i).trim()); at = i + 1; }
  }
  out.push(head.slice(at).trim());
  return out;
}

test('every rule of the section starts from a look, and every class and token is the frame\'s', () => {
  const body = section().replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...body.matchAll(/(?:^|\n)([^@{}\n][^{}]*)\{([^{}]*)\}/g)];
  assert.ok(rules.length > 900, `the kit and nine looks are all there (${rules.length} rules)`);
  for (const [, head, decls] of rules) {
    for (const sel of topLevel(head)) {
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
    ['--lit-tint', '--fr-lit-t'], ['--lit-line', '--fr-line'], ['--dc-sheet-raise', '--fr-surface'],
    ['--app-sheet-line', '--fr-line']]) {
    assert.ok(m[1].includes(`${token}:var(${from})`), `${token} follows ${from}`);
  }
});

test('a solid sheet is solid under a see-through look: a dialog, a menu and a pinned head are never read through', () => {
  // Glass, Workbench and Mosaic draw their surface see-through, over a blur.
  // What the product calls --dc-sheet-solid sits over other content with no
  // blur behind it (a dialog's card, a menu, a head pinned over a scroller),
  // so it takes the look's opaque surface (looks.json "opaque", the same
  // value the no-backdrop-filter fallback uses) where the look has one.
  const text = section();
  assert.match(text, /--dc-sheet:var\(--fr-solid,var\(--fr-surface\)\)/, 'the dialog\'s own card too (Edit profile was read through under Glass)');
  const m = text.match(/html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\)\{([^}]*)\}/);
  assert.ok(m[1].includes('--dc-sheet-solid:var(--fr-solid,var(--fr-surface))'));
  for (const [id, look] of Object.entries(looks.config.looks)) {
    const light = text.match(new RegExp(`html\\[data-skin="${id}"\\]\\{([^}]*)\\}`))[1];
    const dark = text.match(new RegExp(`html\\[data-skin="${id}"\\]\\.dark\\{([^}]*)\\}`))[1];
    if (look.opaque) {
      assert.ok(light.includes(`--fr-solid:${look.opaque[0]}`), `${id}: an opaque surface in light`);
      assert.ok(dark.includes(`--fr-solid:${look.opaque[1]}`), `${id}: and in dark`);
    } else {
      assert.ok(!light.includes('--fr-solid'), `${id}: its surface is already solid, so it needs none`);
    }
  }
});

test('a worn rule that could match nothing is left out', () => {
  // .btn.sm, .card.pad: a state the kit writes as a class on the component
  // itself. The product's node never carries a kit class, so unless the map
  // names that state as a part the rule is dead weight in every look.
  const text = section();
  let seen = 0;
  for (const root of Object.values(looks.config.wear.roots)) {
    for (let at = text.indexOf(root.to); at > -1; at = text.indexOf(root.to, at + 1)) {
      seen += 1;
      const after = text.slice(at + root.to.length, at + root.to.length + 40);
      assert.doesNotMatch(after, /^\.fr-/, `"${root.to}${after}" hangs a kit state on the product's own node`);
    }
  }
  assert.ok(seen > 100, `the worn rules are there (${seen})`);
  const btn = looks.config.wear.roots.btn;
  // The quiet button, for the first wearer by its own part and for Settings' buttons by theirs, one rule.
  const quiet = text.split('\n').find((rule) => rule.includes(`${btn.to}${btn.parts.quiet},`) && rule.includes('{background:var(--fr-sunk)'));
  assert.ok(quiet, 'a state the map names is kept: the quiet button');
  for (const wearer of btn.also || []) assert.ok([',', '{'].some((end) => quiet.includes(`${wearer.to}${wearer.parts.quiet}${end}`)), 'and each second wearer\'s, by its own part');
});
