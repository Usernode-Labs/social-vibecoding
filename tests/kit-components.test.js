// The frame's kit (frontend/@/components/ui/kit.tsx), version 2: the pieces
// the looks need to draw the product's own content in the first tour's
// layout (docs/superpowers/plans/2026-11-11-looks-v2-todays-content.md, step
// P0). Each is rendered here and held to the markup its rules in
// frontend/looks/kit.css are written for (tests/looks-css.test.js holds the
// rules). The first half holds what was there before: a component that
// gained a slot draws exactly what it drew when the slot is not used.
//
// Run with: node --test tests/kit-components.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement: h } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const KIT_FILE = 'frontend/@/components/ui/kit.tsx';
const K = loadTsx(KIT_FILE);
const html = (el) => renderToHtml(el);
const fn = () => {};

// ── What was there stays as it was ───────────────────────────────────────

test('a component that gained a slot draws what it drew before when the slot is not used', () => {
  assert.equal(html(h(K.Head, { title: 'Home', purpose: 'Yours.', acts: 'ACTS' })),
    '<div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Home</h1><p class="fr-purpose">Yours.</p></div><div class="fr-acts">ACTS</div></div>');
  assert.equal(html(h(K.Tabs, { tabs: [{ key: 'a', label: 'A', count: 2 }, { key: 'b', label: 'B', href: '#b' }], current: 'a' })),
    '<nav class="fr-tabs"><button type="button" class="fr-tab fr-on" aria-pressed="true">A<span class="fr-n">2</span></button><a class="fr-tab" href="#b">B</a></nav>');
  assert.equal(html(h(K.Facts, { items: [{ value: 1, label: 'open', tone: 'acc' }, { value: 2, label: 'live' }] })),
    '<div class="fr-card"><div class="fr-facts fr-f2"><div class="fr-fact"><div class="fr-v fr-acc">1</div><div class="fr-l">open</div></div><div class="fr-fact"><div class="fr-v">2</div><div class="fr-l">live</div></div></div></div>');
  assert.equal(html(h(K.Cols, { side: 'S', sideFirst: true, wide: true }, 'M')),
    '<div class="fr-cols fr-wide"><div class="fr-stack">M</div><div class="fr-stack fr-first">S</div></div>');
  assert.equal(html(h(K.Cols, {}, 'M')), '<div class="fr-cols fr-one"><div class="fr-stack">M</div></div>');
  assert.equal(html(h(K.Row, { title: 'T', line: 'L', wrap: true, go: true })).replace(/<svg.*<\/svg>/, 'GO'),
    '<div class="fr-row fr-wrap"><span class="fr-tx"><span class="fr-t">T</span><span class="fr-s">L</span></span>GO</div>');
  assert.equal(html(h(K.Card, { pad: true }, 'c')), '<div class="fr-card fr-pad">c</div>');
  assert.equal(html(h(K.HRow, {}, 'x')), '<div class="fr-hrow">x</div>');
  assert.equal(html(h(K.Meta, {}, '2h')), '<span class="fr-meta">2h</span>');
  assert.equal(html(h(K.Pill, { kind: 'act' }, 'Vote')), '<span class="fr-pill fr-act" data-kind="act">Vote</span>');
  assert.equal(html(h(K.GroupLink, { onClick: fn }, 'Edit')), '<button type="button" class="fr-link">Edit</button>');
  assert.equal(html(h(K.Tiles, {}, h(K.TileItem, { tile: 'TILE', name: 'Chess', count: 3, href: '#chess' }))),
    '<div class="fr-card"><div class="fr-tiles"><a class="fr-at" href="#chess">TILE<span class="fr-n">3</span><span class="fr-nm">Chess</span></a></div></div>');
  assert.match(html(h(K.Field, { label: 'Name', placeholder: 'p' })),
    /^<div class="fr-field"><label for="([^"]+)">Name<\/label><div class="fr-inp"><input id="\1" class="fr-v" placeholder="p"\/><\/div><\/div>$/);
  assert.match(html(h(K.Search, { value: '', onChange: fn, placeholder: 'Search' })), /^<div class="fr-search"><label class="fr-inp">/);
  assert.equal(html(h(K.Track, { at: 1, words: ['a', 'b', 'c', 'd', 'e'], mini: true })).match(/class="fr-st[^"]*"/g).join(' '),
    'class="fr-st fr-done" class="fr-st fr-now" class="fr-st" class="fr-st" class="fr-st"');
  assert.match(html(h(K.PageBody, { title: 'T', tabs: 'TABS', side: 'S' }, 'M')),
    /^<div class="fr"><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">T<\/h1><\/div><\/div>TABS<div class="fr-cols"><div class="fr-stack">M<\/div><div class="fr-stack">S<\/div><\/div><\/div><\/div>$/);
  assert.match(html(h(K.PicCard, { href: '#', tile: 'TILE', title: 'T' })), /^<a class="fr-card fr-fcard" href="#"><span class="fr-fcover">TILE<\/span><span class="fr-fbody"><span class="fr-t">T<\/span><\/span><\/a>$/);
  const sheet = html(h(K.Sheet, { title: 'T', onClose: fn, closeLabel: 'Close' }, 'BODY'));
  assert.match(sheet, /<\/h2><\/div><\/div><div class="fr-stack">BODY<\/div><\/div><\/div><\/div>$/, 'nothing between a sheet\'s head and its groups unless it is given');
});

// ── The page's head ──────────────────────────────────────────────────────

test('the head: a line over the title, a picture before it, a line under it', () => {
  const out = html(h(K.Head, { title: 'Pourover', purpose: 'Log every brew.', over: 'Request #5998', lead: h(K.Tile, { size: 56, emoji: 'x', color: '#123' }), under: 'Public community · 26 people' }));
  assert.match(out, /^<div class="fr-head"><span class="fr-tile" style="--fr-ts:56px;--fr-tc:#123" aria-hidden="true">x<\/span><div class="fr-tx">/, 'the picture leads the head, before the words');
  assert.match(out, /<div class="fr-tx"><div class="fr-cap fr-over">Request #5998<\/div><h1 class="fr-title">Pourover<\/h1><div class="fr-sub13">Public community · 26 people<\/div><p class="fr-purpose">Log every brew\.<\/p><\/div>/);
  const page = html(h(K.PageBody, { title: 'T', over: 'O', under: 'U', lead: 'LEAD', narrow: true }, 'M'));
  assert.match(page, /<div class="fr-inner fr-narrow"><div class="fr-head">LEAD<div class="fr-tx"><div class="fr-cap fr-over">O<\/div><h1 class="fr-title">T<\/h1><div class="fr-sub13">U<\/div>/, 'a page passes them on, and may be the narrow one');
});

test('tabs: an end slot for a search, a flush form and a switch', () => {
  const tabs = [{ key: 'people', label: 'People' }, { key: 'agents', label: 'Agents' }];
  const out = html(h(K.Tabs, { tabs, current: 'people', end: h(K.Search, { value: '', onChange: fn, placeholder: 'Search' }) }));
  assert.match(out, /<\/button><div class="fr-end"><div class="fr-search"><label class="fr-inp">.*<\/label><\/div><\/div><\/nav>$/s, 'after the last tab, inside the row');
  assert.match(html(h(K.Tabs, { tabs, current: 'people', seg: true, label: 'Sign in or create' })), /^<nav class="fr-tabs fr-seg" aria-label="Sign in or create">/);
  assert.match(html(h(K.Tabs, { tabs, current: 'people', flush: true })), /^<nav class="fr-tabs fr-flush">/);
  assert.match(html(h(K.Search, { value: '', onChange: fn, placeholder: 'Search', flush: true, only: 'p' })), /^<div class="fr-search fr-flush fr-p">/, 'the phone\'s own field, for the one the tabs hide there');
  const sheet = html(h(K.Sheet, { title: 'T', onClose: fn, closeLabel: 'Close', top: 'SWITCH' }, 'BODY'));
  assert.match(sheet, /<\/h2><\/div><\/div>SWITCH<div class="fr-stack">BODY<\/div>/, 'a sheet takes one between its head and its groups');
});

test('columns flipped: the side column leads', () => {
  assert.equal(html(h(K.Cols, { side: 'NAV', flip: true }, 'PANE')), '<div class="fr-cols fr-flip"><div class="fr-stack">NAV</div><div class="fr-stack">PANE</div></div>');
  assert.equal(html(h(K.Cols, { flip: true }, 'PANE')), '<div class="fr-cols fr-one"><div class="fr-stack">PANE</div></div>', 'with no side there is nothing to flip');
  assert.match(html(h(K.PageBody, { title: 'T', side: 'NAV', flip: true }, 'PANE')), /<div class="fr-cols fr-flip"><div class="fr-stack">NAV<\/div>/);
});

// ── Numbers ──────────────────────────────────────────────────────────────

test('facts: a second line, a tone, a press, and a form with no card of its own', () => {
  const items = [
    { value: 52, label: 'open items' },
    { value: 10, label: 'waiting on votes', tone: 'wait', sub: '1 on you', onClick: fn },
    { value: 3, label: 'live', href: '#live' },
  ];
  const out = html(h(K.Facts, { items }));
  assert.match(out, /^<div class="fr-card"><div class="fr-facts fr-f3"><div class="fr-fact"><div class="fr-v">52<\/div><div class="fr-l">open items<\/div><\/div>/);
  assert.match(out, /<button type="button" class="fr-fact"><span class="fr-v fr-wait">10<\/span><span class="fr-l">waiting on votes<\/span><span class="fr-l fr-sub">1 on you<\/span><\/button>/, 'a figure that opens something is a button, its parts spans');
  assert.match(out, /<a class="fr-fact" href="#live"><span class="fr-v">3<\/span><span class="fr-l">live<\/span><\/a>/);
  assert.equal(html(h(K.Facts, { items: [{ value: 1, label: 'a', sub: 's' }], bare: true })),
    '<div class="fr-facts fr-f1"><div class="fr-fact"><div class="fr-v">1</div><div class="fr-l">a</div><div class="fr-l fr-sub">s</div></div></div>', 'bare: the strip alone, for a card it shares');
  assert.match(html(h(K.Facts, { items: [{ value: 1, label: 'a' }, { value: 2, label: 'b' }], inset: true })), /^<div class="fr-facts fr-f2 fr-inset">/, 'inset is bare too');
});

test('the week\'s bars: one column a day, a picture with its words', () => {
  const days = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'].map((label, i) => ({ label, value: [0.04, 0.04, 0, 0.62, 1, 0.26, 0.04][i], text: label === 'Mon' ? '37m' : undefined, now: label === 'Wed' }));
  const out = html(h(K.Bars, { days, label: 'Time in apps, last 7 days' }));
  assert.match(out, /^<div class="fr-bars" role="img" aria-label="Time in apps, last 7 days">/);
  assert.equal((out.match(/class="fr-bcol/g) || []).length, 7);
  assert.match(out, /<div class="fr-bcol" aria-hidden="true"><span class="fr-bv">37m<\/span><i style="height:100%"><\/i><span class="fr-bl">Mon<\/span><\/div>/);
  assert.match(out, /<div class="fr-bcol fr-none" aria-hidden="true"><span class="fr-bv"><\/span><i><\/i><span class="fr-bl">Sat<\/span>/, 'an empty day is a baseline (.none), not a stub of the accent');
  assert.equal((out.match(/fr-none/g) || []).length, 1, 'only a day with nothing in it');
  assert.ok(fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8').includes('html[data-skin] .fr-bcol.fr-none i{height:2px;min-height:0;border-radius:1px;background:var(--fr-faint)}'));
  assert.match(out, /<div class="fr-bcol fr-now" aria-hidden="true">.*?<span class="fr-bl">Wed<\/span>/s);
  assert.match(html(h(K.Bars, { days: days.slice(0, 5), label: 'l' })), /style="--fr-bn:5"/, 'another count of columns is given to the grid');
});

test('a thin progress bar, and the same bar as a meter', () => {
  assert.equal(html(h(K.Prog, { value: 0.91, label: '10 of 11 done' })),
    '<div class="fr-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="91" aria-label="10 of 11 done"><i style="width:91%"></i></div>');
  assert.match(html(h(K.Prog, { value: 2, meter: true, done: true })), /^<div class="fr-prog fr-meter fr-done" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><i style="width:100%">/);
  assert.match(html(h(K.Prog, { value: -1 })), /aria-valuenow="0"><i style="width:0%">/);
});

test('the line for progress may be given each stop\'s own state', () => {
  const out = html(h(K.Track, { at: 0, words: ['a', 'b', 'c', 'd', 'e'], stops: ['done', 'done', 'wait', '', ''] }));
  assert.equal(out.match(/class="fr-st[^"]*"/g).join(' '), 'class="fr-st fr-done" class="fr-st fr-done" class="fr-st fr-wait" class="fr-st" class="fr-st"');
});

// ── Rows ─────────────────────────────────────────────────────────────────

test('a row: every line shown, a number column, a small glyph, a job of its own', () => {
  assert.match(html(h(K.Row, { title: 'Sounds', line: 'A long sentence.', wrap: 'all' })), /^<div class="fr-row fr-wrap fr-all">/, 'a switch\'s sentence is never cut');
  const item = html(h(K.Row, { title: 'Fix the bar', num: '#6412', glyph: 'vote', glyphTone: 'acc', kind: 'item', sm: true }));
  assert.match(item, /^<div class="fr-row fr-sm fr-item"><span class="fr-ei fr-acc" aria-hidden="true"><svg[^>]*width="16"[^>]*>.*?<\/svg><\/span><span class="fr-num">#6412<\/span><span class="fr-tx"><span class="fr-t">Fix the bar<\/span><\/span><\/div>$/s);
  assert.match(html(h(K.Row, { title: 'T', num: '6412', numMono: true })), /<span class="fr-num fr-mono">6412<\/span>/);
  assert.doesNotMatch(html(h(K.Row, { title: 'T', num: 0 })), /fr-num/, 'a zero says nothing');
  for (const kind of ['showall', 'headrow', 'week', 'item', 'act', 'proj', 'month', 'more']) {
    assert.match(html(h(K.Row, { title: 'T', kind })), new RegExp(`^<div class="fr-row fr-sm fr-${kind}">`));
  }
});

test('the row that ends a card, a card\'s head row, and a week', () => {
  assert.equal(html(h(K.ShowAll, { onClick: fn }, 'Show all 96 apps')),
    '<button type="button" class="fr-row fr-sm fr-showall"><span class="fr-tx"><span class="fr-t">Show all 96 apps</span></span></button>');
  assert.match(html(h(K.ShowAll, { href: '#all', go: true }, 'All of this week')), /^<a class="fr-row fr-sm fr-showall" href="#all">.*<svg class="fr-ic fr-go"/s);
  assert.match(html(h(K.HeadRow, { title: 'All items', link: 'See all', href: '#items' })),
    /^<a class="fr-row fr-sm fr-headrow" href="#items"><span class="fr-tx"><span class="fr-t">All items<\/span><\/span><span class="fr-link">See all<\/span><svg class="fr-ic fr-go"/);
  assert.match(html(h(K.WeekRow, { title: 'This week', line: '12 changes went live', right: h(K.Meta, { tone: 'ok' }, '3 new') })),
    /^<div class="fr-row fr-week"><span class="fr-tx"><span class="fr-t">This week<\/span><span class="fr-s">12 changes went live<\/span><\/span><span class="fr-meta fr-ok">3 new<\/span><\/div>$/);
});

test('small words: sub-headings, a muted word, a section\'s note, a label inside a group, a pill in a title', () => {
  assert.equal(html(h(K.Sub, { size: 22 }, 'snait')), '<div class="fr-sub22">snait</div>');
  assert.equal(html(h(K.Sub, { size: 15, as: 'p' }, h('b', null, '15,128 pts'), ' ', h(K.Mut, {}, '· 10 of 11 done'))), '<p class="fr-sub15"><b>15,128 pts</b> <span class="fr-mut">· 10 of 11 done</span></p>');
  assert.equal(html(h(K.Sub, { size: 13, as: 'span' }, 'x')), '<span class="fr-sub13">x</span>');
  assert.equal(html(h(K.Sub, { size: 17, as: 'h3' }, 'x')), '<h3 class="fr-sub17">x</h3>');
  assert.equal(html(h(K.SecNote, {}, 'Only you can see your friends.')), '<p class="fr-secnote">Only you can see your friends.</p>');
  assert.equal(html(h(K.SecNote, {}, '')), '', 'no sentence, no element');
  assert.equal(html(h(K.CapSub, {}, 'Featured')), '<h3 class="fr-cap fr-sub">Featured</h3>');
  assert.equal(html(h(K.Pill, { mini: true }, 3)), '<span class="fr-pill fr-mini" data-kind="none">3</span>');
  assert.equal(html(h(K.Pill, { href: '/u/x', kind: 'ok' }, 'Verified')), '<a class="fr-pill fr-ok" data-kind="ok" href="/u/x">Verified</a>');
  assert.equal(html(h(K.GroupLink, { onClick: fn, disabled: true }, 'Mark all seen')), '<button type="button" class="fr-link fr-off" disabled="">Mark all seen</button>');
  assert.equal(html(h(K.GroupLink, { href: '#r', bad: true }, 'Report')), '<a class="fr-link fr-bad" href="#r">Report</a>');
});

// ── Tiles, cards, pictures ───────────────────────────────────────────────

test('tiles: eight across, a row under the grid, and a tile that is faded, lit or has a corner control', () => {
  const out = html(h(K.Tiles, { cols: 8, after: h(K.ShowAll, { onClick: fn }, 'Show all') }, h(K.TileItem, { tile: 'T', name: 'Chess', onClick: fn, dim: true })));
  assert.match(out, /^<div class="fr-card"><div class="fr-tiles fr-t8"><button type="button" class="fr-at fr-dim">T<span class="fr-nm">Chess<\/span><\/button><\/div><button type="button" class="fr-row fr-sm fr-showall">/);
  assert.match(html(h(K.TileItem, { tile: h(K.Lead, { icon: 'grid', size: 52 }), name: 'All communities', onClick: fn, lit: true, pressed: true })), /^<button type="button" class="fr-at fr-lit" aria-pressed="true"><span class="fr-lead"/);
  assert.match(html(h(K.Lead, { icon: 'plus', size: 52, dash: true })), /^<span class="fr-lead fr-dash" style="width:52px;height:52px;border-radius:15px"/, 'the outline of something to add');
  const corner = html(h(K.TileItem, { tile: 'T', name: 'Chess', href: '#chess', corner: h('button', { type: 'button', className: K.k('corner'), 'aria-label': 'Unpin Chess' }, '×') }));
  assert.equal(corner, '<div class="fr-at"><a class="fr-atl" href="#chess">T<span class="fr-nm">Chess</span></a><button type="button" class="fr-corner" aria-label="Unpin Chess">×</button></div>',
    'the control sits beside the tile\'s door, never inside it');
});

test('a card may be picked, pressed, or a card of sentences', () => {
  assert.equal(html(h(K.Card, { on: true, onClick: fn, label: 'A quiz' }, 'x')), '<button type="button" class="fr-card fr-on fr-press" aria-pressed="true" aria-label="A quiz">x</button>');
  assert.equal(html(h(K.Card, { onClick: fn }, 'x')), '<button type="button" class="fr-card fr-press">x</button>');
  assert.equal(html(h(K.Card, { text: true }, 'x')), '<div class="fr-card fr-text">x</div>');
});

test('cards of words side by side, and a grid of cards', () => {
  const card = html(h(K.HCard, { top: 'TILE', end: h(K.Pill, {}, '50 pts'), title: 'Vote on a change', line: 'Any project', more: 'A longer sentence.', href: '#c' }));
  assert.equal(card, '<a class="fr-card fr-pad fr-hcard" href="#c"><span class="fr-hc-top">TILE<span class="fr-pill" data-kind="none">50 pts</span></span><span class="fr-t2">Vote on a change</span><span class="fr-s2">Any project</span><span class="fr-s2 fr-two">A longer sentence.</span></a>');
  assert.match(html(h(K.HCard, { title: 'T', onClick: fn })), /^<button type="button" class="fr-card fr-pad fr-hcard fr-press"><span class="fr-t2">T<\/span><\/button>$/);
  assert.match(html(h(K.HCard, { title: 'T', foot: 'FOOT' })), /^<div class="fr-card fr-pad fr-hcard"><span class="fr-t2">T<\/span>FOOT<\/div>$/);
  assert.equal(html(h(K.HRow, { even: true }, 'x')), '<div class="fr-hrow fr-even">x</div>');
  assert.equal(html(h(K.Grid, {}, 'x')), '<div class="fr-grid">x</div>');
  assert.equal(html(h(K.Grid, { cols: 2 }, 'x')), '<div class="fr-grid fr-g2">x</div>');
});

test('a picture card takes two badges on its cover; a cover stands alone', () => {
  const out = html(h(K.PicCard, { href: '#', tile: 'TILE', title: 'GOAL!', flag: 'New', badge: '1,284' }));
  assert.match(out, /<span class="fr-fcover">TILE<span class="fr-pill fr-new">New<\/span><span class="fr-pill">1,284<\/span><\/span>/);
  assert.equal(html(h(K.Cover, { color: '#14432f' }, 'x')), '<div class="fr-cover" style="--fr-tc:#14432f" aria-hidden="true">x</div>');
  assert.equal(html(h(K.Cover, { src: '/c.png' })), '<div class="fr-cover" aria-hidden="true"><img src="/c.png" alt="" loading="lazy"/></div>');
});

test('a change\'s pictures: the kit\'s own, one copy for a visitor\'s page and a member\'s', () => {
  const out = html(h(K.Shots, {}, h(K.Shot, { src: '/b.png', label: 'Before' }), h(K.Shot, { src: '/a.png', label: 'After' })));
  assert.equal(out, '<div class="fr-shots"><figure><img src="/b.png" alt="" loading="lazy"/><figcaption>Before</figcaption></figure><figure><img src="/a.png" alt="" loading="lazy"/><figcaption>After</figcaption></figure></div>');
  assert.match(html(h(K.Shots, { cols: 3 }, 'x')), /^<div class="fr-shots fr-s3">/);
  const src = fs.readFileSync(path.join(ROOT, KIT_FILE), 'utf8');
  assert.match(src, /\{bad \? null : <img src=\{src\} alt="" loading="lazy" onError=\{\(\) => setBad\(true\)\} \/>\}/, 'a picture that cannot be read is dropped');
  const guest = fs.readFileSync(path.join(ROOT, 'frontend/src/features/guest/frame/project-frame.tsx'), 'utf8');
  assert.match(guest, /<Shots>\s*\{v\.pictures\.before \? <Shot /, 'the visitor\'s page draws with it');
});

test('faces: the first few, then how many more', () => {
  const people = ['snait', 'kempis', '@nisarena1'].map((name) => ({ name, color: '#5b7f5a' }));
  const out = html(h(K.Avs, { people, max: 2, more: 21, label: '26 active this week' }));
  assert.equal(out, '<span class="fr-avs" role="img" aria-label="26 active this week">'
    + '<span class="fr-av" style="--fr-as:28px;--fr-ac:#5b7f5a" aria-hidden="true">s</span><span class="fr-av" style="--fr-as:28px;--fr-ac:#5b7f5a" aria-hidden="true">k</span>'
    + '<span class="fr-av fr-more" style="--fr-as:28px" aria-hidden="true">+22</span></span>', 'one left out of three, and the 21 the caller knows of');
  assert.doesNotMatch(html(h(K.Avs, { people })), /fr-more|role=/, 'all shown: no number, and no words it was not given');
  assert.equal(html(h(K.Avs, { people: [] })), '', 'nobody says nothing');
});

// ── Fields ───────────────────────────────────────────────────────────────

test('a field: several lines, a counter at its label\'s end, a control inside and one beside', () => {
  const area = html(h(K.Field, { label: 'Bio', area: true, count: '52/280', value: 'I build.', onChange: fn, maxLength: 280, hint: 'Shown on your page.' }));
  assert.match(area, /^<div class="fr-field"><label for="([^"]+)" class="fr-lab"><span>Bio<\/span><span class="fr-count">52\/280<\/span><\/label><div class="fr-inp fr-val fr-area"><textarea id="\1" class="fr-v" rows="3" maxLength="280">I build\.<\/textarea><\/div><span class="fr-hint">Shown on your page\.<\/span><\/div>$/);
  const beside = html(h(K.Field, { label: 'Repository', placeholder: 'github.com/…', end: 'MIC', after: h(K.Btn, { kind: 'quiet' }, 'Check'), afterWraps: true }));
  assert.match(beside, /<div class="fr-fieldrow fr-wrap"><div class="fr-inp"><input id="[^"]+" class="fr-v" placeholder="github\.com\/…"\/>MIC<\/div><button type="button" class="fr-btn fr-quiet">Check<\/button><\/div>/);
  assert.match(html(h(K.Field, { label: 'x', after: 'A' })), /<div class="fr-fieldrow">/);
});

test('a select is a real one in the kit\'s field', () => {
  const out = html(h(K.Select, { label: 'Event', value: 's2', onChange: fn, hint: 'Season 2 is on.', options: [{ value: 's1', label: 'Season 1' }, { value: 's2', label: 'Season 2' }] }));
  assert.match(out, /^<div class="fr-field"><label for="([^"]+)">Event<\/label><div class="fr-inp fr-val fr-sel"><select id="\1" class="fr-v"><option value="s1">Season 1<\/option><option value="s2" selected="">Season 2<\/option><\/select><svg class="fr-ic"[^>]*aria-hidden="true">.*<\/svg><\/div><span class="fr-hint">Season 2 is on\.<\/span><\/div>$/s);
});

// ── A thread ─────────────────────────────────────────────────────────────

test('an event line: a small glyph, then the words', () => {
  const out = html(h(K.Evt, { icon: 'vote' }, h('b', null, '#6317'), ' went up for a vote'));
  assert.match(out, /^<div class="fr-evt"><span class="fr-ei" aria-hidden="true"><svg class="fr-ic" width="16" height="16"[^>]*>.*<\/svg><\/span><span><b>#6317<\/b> went up for a vote<\/span><\/div>$/s);
});

// ── The file's own rules ─────────────────────────────────────────────────

// ── The left-overs pass (group A) ────────────────────────────────────────

test('a challenge\'s picture as a row\'s lead, and the arrow that ends its row (shared by Home and the Challenges page)', () => {
  assert.equal(html(h(K.ChallengeArt, { src: '/illustrations/challenges/x.svg', tone: 'home-tone-mint', icon: '🏆' })),
    '<span class="fr-cart fr-sm home-tone-mint" style="--fr-cs:44px;background:var(--tint-art)" aria-hidden="true"><img src="/illustrations/challenges/x.svg" alt="" loading="lazy" decoding="async" draggable="false"/></span>');
  assert.equal(html(h(K.ChallengeArt, { icon: '🏆', size: 40 })), '<span class="fr-cart fr-sm" style="--fr-cs:40px" aria-hidden="true">🏆</span>', 'no illustration: its emoji');
  assert.match(html(h(K.ChallengeArt, {})), /^<span class="fr-cart fr-sm" style="--fr-cs:44px" aria-hidden="true"><svg class="fr-ic" width="20" height="20"/, 'neither: the trophy');
  assert.match(html(h(K.RowArrow)), /^<span class="fr-arr" aria-hidden="true"><svg class="fr-ic" width="16" height="16"[^>]*>.*<\/svg><\/span>$/);
});

test('a tile waits for its picture in the look\'s sunk tone, not as a blank white square', () => {
  assert.match(html(h(K.Tile, { src: '/i.png', name: 'A' })), /^<span class="fr-tile" style="--fr-ts:40px;--fr-tc:var\(--fr-sunk\)" aria-hidden="true"><img src="\/i\.png"/);
  assert.match(html(h(K.Tile, { emoji: '🎮', name: 'A' })), /--fr-tc:#fff" aria-hidden="true">🎮</, 'an emoji is there at once: white, as before');
  assert.match(html(h(K.Tile, { src: '/i.png', color: '#123456', name: 'A' })), /--fr-tc:#123456"/, 'a colour of its own is its ground from the start');
  const src = fs.readFileSync(path.join(ROOT, KIT_FILE), 'utf8');
  assert.match(src, /onLoad=\{\(\) => setSeen\(picture\)\}\s*onError=\{\(\) => setLost\(picture\)\}/, 'white once it has loaded; its letter if it never does');
});

test('a picture card: its tile on the community\'s colour, a sentence with its whole self on hover, and the note that ends a list', () => {
  assert.equal(html(h(K.PicCard, { href: '/app/x', tile: 'TILE', color: '#224466', title: 'X', line: 'Says.', two: true, flag: 'New', label: 'X, 5 people' })),
    '<a class="fr-card fr-fcard" href="/app/x" aria-label="X, 5 people"><span class="fr-fcover fr-tc" style="--fr-tc:#224466">TILE<span class="fr-pill fr-new">New</span></span><span class="fr-fbody"><span class="fr-t">X</span><span class="fr-s fr-two" title="Says.">Says.</span></span></a>');
  assert.equal(html(h(K.PicCard, { href: '/app/x', title: 'X', line: 'One line, then an ellipsis.' })),
    '<a class="fr-card fr-fcard" href="/app/x"><span class="fr-fcover"></span><span class="fr-fbody"><span class="fr-t">X</span><span class="fr-s" title="One line, then an ellipsis.">One line, then an ellipsis.</span></span></a>', 'one line unless asked for two, with the whole sentence on hover (#6659)');
  assert.equal(html(h(K.PicCard, { href: '/app/x', title: 'X', line: h('b', {}, 'Rich') })),
    '<a class="fr-card fr-fcard" href="/app/x"><span class="fr-fcover"></span><span class="fr-fbody"><span class="fr-t">X</span><span class="fr-s"><b>Rich</b></span></span></a>', 'a node that is not a string gets no title');
  assert.equal(html(h(K.PicCard, { href: '/app/x', cover: '/c.png', title: 'X' })),
    '<a class="fr-card fr-fcard" href="/app/x"><span class="fr-fcover"><img src="/c.png" alt="" loading="lazy" class="fr-sun"/></span><span class="fr-fbody"><span class="fr-t">X</span></span></a>', 'as it was, with a picture');
  assert.equal(html(h(K.SecNote, { end: true }, 'That is all.')), '<p class="fr-secnote fr-end">That is all.</p>');
  assert.equal(html(h(K.SecNote, {}, 'A note.')), '<p class="fr-secnote">A note.</p>');
});

test('the kit carries kit classes only: no utility class, no colour of its own', () => {
  const src = fs.readFileSync(path.join(ROOT, KIT_FILE), 'utf8');
  const v2 = src.slice(src.indexOf('/* ── Version 2 (11 Nov 2026)'));
  assert.ok(v2.length > 2000, 'the version 2 components are one marked part at the end of the file');
  assert.doesNotMatch(v2, /className="(?!fr[ "-])[^"]*"/, 'every class is written through k()');
  assert.doesNotMatch(v2, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'no literal colour');
  for (const m of src.matchAll(/className=\{k\(([^)]*)\)\}/g)) {
    for (const lit of m[1].matchAll(/'([^']*)'/g)) {
      assert.doesNotMatch(lit[1], /[:[/]|(?:^| )(?:text|bg|p[xytblr]?|m[xytblr]?|gap|rounded|items|justify|font|min-w|max-w|w|h)-/, `"${lit[1]}" reads as a utility class`);
    }
  }
});
