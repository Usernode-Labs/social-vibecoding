// #5891: every search that finds apps or communities by name ranks by one
// rule (frontend/src/lib/search-rank.js): what was typed is inside a row's
// text, and a row whose name IS what was typed leads, in any case and with
// Latin accents set aside. Each surface is run here through its real module,
// so a surface that stops sharing the rule fails by behaviour.
//
// Run with: node --test tests/search-rank.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx } = require('./lib/render-tsx');

const RANK = 'frontend/src/lib/search-rank.js';

test('searchKey: any case, trimmed, Latin accents aside however they were written', () => {
  const { searchKey } = loadTsx(RANK);
  assert.equal(searchKey('  Café '), 'cafe');
  assert.equal(searchKey('Café'), 'cafe', 'a decomposed accent');
  assert.equal(searchKey('Café'), 'cafe', 'a composed accent');
  assert.equal(searchKey('ÉCOLE Ñandú'), 'ecole nandu');
  assert.equal(searchKey(null), '');
  // Only an accent on a Latin letter goes: Cyrillic and Greek keep theirs,
  // and a Japanese voicing mark and a Hangul syllable keep their meaning.
  assert.equal(searchKey('Всё'), 'всё');
  assert.notEqual(searchKey('Всё'), searchKey('Все'));
  assert.equal(searchKey('Ώρα'), 'ώρα');
  assert.equal(searchKey('が'), 'が');
  assert.equal(searchKey('한글'), '한글');
});

test('rankSearch: the exact name leads, then the same name accents aside, each tier stable', () => {
  const { rankSearch } = loadTsx(RANK);
  const rows = [
    { slug: 'a', name: 'Café Chat' },
    { slug: 'b', name: 'Daily Café Notes' },
    { slug: 'c', name: 'Cafe' },
    { slug: 'd', name: 'Board' },
    { slug: 'e', name: 'café' },
  ];
  const names = (r) => [r.name];
  const slugs = (q) => rankSearch(rows, q, names).map((r) => r.slug);
  assert.deepEqual(slugs('Café'), ['e', 'c', 'a', 'b'],
    'the name typed letter for letter leads, then the same name without its accent, then the rest');
  assert.deepEqual(slugs('  CAFE '), ['c', 'e', 'a', 'b'], 'typed without the accent, the unaccented name leads');
  assert.deepEqual(slugs('cafe\u0301'), ['e', 'c', 'a', 'b'], 'a decomposed accent is the same letter as a composed one');
  assert.deepEqual(slugs('caf'), ['a', 'b', 'c', 'e'], 'no exact match: the list order');
  assert.deepEqual(slugs(''), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(slugs('zzz'), []);
  // A text a match may be found in is not a name: it finds the row, and
  // only the name decides the lead.
  const described = [
    { slug: 'popular', name: 'Weekend Plans', description: 'Like Trip Planner, but social' },
    { slug: 'mine', name: 'Trip Planner', description: '' },
  ];
  assert.deepEqual(
    rankSearch(described, 'trip planner', names, (r) => [`${r.name} ${r.description}`]).map((r) => r.slug),
    ['mine', 'popular'],
  );
});

test('rankSearch: an accent-sensitive exact name is never beaten by a folded one, whatever the order', () => {
  const { rankSearch } = loadTsx(RANK);
  const names = (r) => [r.name];
  // The reviewer's case: the busier "Cafe" first in the list, "Café" typed.
  const rows = [{ slug: 'busy', name: 'Cafe' }, { slug: 'mine', name: 'Café' }];
  assert.deepEqual(rankSearch(rows, 'Café', names).map((r) => r.slug), ['mine', 'busy']);
  assert.deepEqual(rankSearch(rows, 'cafe', names).map((r) => r.slug), ['busy', 'mine']);
  // Cyrillic is not folded: "Все" neither matches nor leads a search for "Всё".
  const cyr = [{ slug: 'vse', name: 'Все' }, { slug: 'vsyo', name: 'Всё' }];
  assert.deepEqual(rankSearch(cyr, 'Всё', names).map((r) => r.slug), ['vsyo']);
  // Several in one tier keep the list's order.
  const many = [
    { slug: 'p1', name: 'Café Two' }, { slug: 'f1', name: 'CAFE' }, { slug: 'e1', name: 'café' },
    { slug: 'f2', name: 'cafe' }, { slug: 'e2', name: 'CAFÉ' },
  ];
  assert.deepEqual(rankSearch(many, 'Café', names).map((r) => r.slug), ['e1', 'e2', 'f1', 'f2', 'p1']);
});

test('Communities, the switcher and the drawer: an exact name leads, accents aside (#5891)', () => {
  const { matchRows } = loadTsx('frontend/src/features/workshop/sections.ts');
  const rows = [
    { slug: 'x1', name: 'Ecole Notes' },
    { slug: 'x2', name: 'Petite École' },
    { slug: 'x3', name: 'École' },
    { slug: 'x4', name: null },
  ];
  assert.deepEqual(matchRows(rows, 'ecole').map((r) => r.slug), ['x3', 'x1', 'x2'],
    'typed without the accent, "École" is the name typed, accents aside');
  assert.deepEqual(matchRows([{ slug: 'y1', name: 'Ecole' }, ...rows], 'École').map((r) => r.slug),
    ['x3', 'y1', 'x1', 'x2'], 'the accented name typed leads the unaccented one');
  assert.deepEqual(matchRows(rows, 'x4').map((r) => r.slug), ['x4'], 'a row with no name by its slug');
});

test('the guest directory: the project named what was typed leads, whatever the sort (#5891)', () => {
  const { filterApps, sortApps } = loadTsx('frontend/src/features/guest/guest-data.ts');
  const apps = [
    { slug: 'one', name: 'Pixel Party', description: 'Draw with friends, a Sketchbook for groups', active_users: 90, category: 'creative' },
    { slug: 'two', name: 'Sketchbook Club', description: null, active_users: 40, category: 'creative' },
    { slug: 'three', name: 'Daily Sketchbook Prompts', description: null, active_users: 20, category: 'creative' },
    { slug: 'mine', name: 'Sketchbook', description: null, active_users: 2, category: 'creative' },
  ];
  const shown = (q, sort, kind = null) => filterApps(sortApps(apps, sort), q, kind).map((a) => a.slug);
  assert.deepEqual(shown('sketchbook', 'trending'), ['mine', 'one', 'two', 'three'],
    'the least active project leads when its name is what was typed');
  assert.deepEqual(shown('SKETCHBOOK ', 'new'), ['mine', 'one', 'two', 'three']);
  assert.deepEqual(shown('sketch', 'trending'), ['one', 'two', 'three', 'mine'], 'a partial query keeps the sort');
  assert.deepEqual(shown('sketchbook', 'trending', 'games'), [], 'a kind still narrows');
});
