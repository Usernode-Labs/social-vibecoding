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

// #7021: Home's and Communities' community lists rank by the same rule, so a
// community named what was typed leads the ones that only mention the words.
test('rankCommunities: a community named what was typed leads, and the rest keep their order', () => {
  const { rankCommunities } = loadTsx('frontend/src/features/home/use-home-query.ts');
  const rows = [
    { slug: 'book', name: 'Book Club', description: 'Our Bee Watch notes from the garden' },
    { slug: 'log', name: 'Sunday Bee Watch Log', description: null },
    { slug: 'bee-watch', name: 'Bee Watch', description: 'Count bees in your garden' },
  ];
  const withDescription = { description: true };
  assert.deepEqual(
    rankCommunities(rows, 'Bee Watch', withDescription).map((r) => r.slug),
    ['bee-watch', 'book', 'log'],
    'the exact name leads, a description-only match is still shown, and the rest keep their order',
  );
  // "been" is a description-only match for "bee": it is shown, below nothing
  // in particular because no community is named "bee".
  const screenRows = [
    { slug: 'book', name: 'Book Club', description: 'What we have been reading' },
    { slug: 'beehive', name: 'Beehive Games', description: 'Quick word games' },
    { slug: 'bee-watch', name: 'Bee Watch', description: 'Count bees in your garden' },
  ];
  assert.deepEqual(
    rankCommunities(screenRows, 'bee', withDescription).map((r) => r.slug),
    ['book', 'beehive', 'bee-watch'],
    'a partial query with no exact name keeps the list order, descriptions included',
  );
  assert.deepEqual(
    rankCommunities([screenRows[0], screenRows[1]], 'bee watch', withDescription).map((r) => r.slug),
    [],
    'nothing matches, so nothing is shown',
  );
  // The name typed exactly leads even when it is last in the list and only a
  // description match would have found the first row.
  const named = [{ slug: 'first', name: 'Weekend Plans', description: 'Bee watch on Sunday' }, { slug: 'second', name: 'Bee' }];
  assert.deepEqual(rankCommunities(named, 'bee', withDescription).map((r) => r.slug), ['second', 'first'],
    '"Bee" leads the description-only match');
  assert.deepEqual(rankCommunities(named, 'BEE', withDescription).map((r) => r.slug), ['second', 'first'], 'any case');
  // Latin accents are set aside, as the app grid already does.
  const cafe = [{ slug: 'busy', name: 'Cafe' }, { slug: 'mine', name: 'Café' }];
  assert.deepEqual(rankCommunities(cafe, 'café', {}).map((r) => r.slug), ['mine', 'busy']);
  assert.deepEqual(rankCommunities(cafe, 'cafe', {}).map((r) => r.slug), ['busy', 'mine']);
  assert.deepEqual(rankCommunities([{ slug: 'x', name: 'Café Chat' }], 'cafe', {}).map((r) => r.slug), ['x'],
    '"cafe" still finds "Café Chat"');
  // A community's slug counts as its name.
  assert.deepEqual(
    rankCommunities([{ slug: 'hive', name: 'Garden Club' }, { slug: 'garden', name: 'Bee Hive' }], 'garden').map((r) => r.slug),
    ['garden', 'hive'],
    'the slug typed leads',
  );
  // Description is a text a match may be found in only when asked for.
  const described = [{ slug: 'quiet', name: 'Garden', description: 'Our beekeeping notes' }];
  assert.deepEqual(rankCommunities(described, 'bee').map((r) => r.slug), [], 'without the option, a description is not matched');
  assert.deepEqual(rankCommunities(described, 'bee', withDescription).map((r) => r.slug), ['quiet']);
  // An empty query returns the list unchanged, so the unsearched views do not move.
  assert.deepEqual(rankCommunities(rows, '', withDescription).map((r) => r.slug), ['book', 'log', 'bee-watch']);
});

test('matchesQuery: a Latin accent is the same letter, and an empty query matches everything', () => {
  const { matchesQuery } = loadTsx('frontend/src/features/home/use-home-query.ts');
  assert.equal(matchesQuery('cafe', 'Café'), true);
  assert.equal(matchesQuery('CAFÉ', 'cafe'), true);
  assert.equal(matchesQuery('', 'anything'), true);
  assert.equal(matchesQuery('bee', 'Bee Watch'), true);
  assert.equal(matchesQuery('bee', 'Book Club'), false);
});

test('matchesSearch: inside any text, any case, accents aside; an empty query finds everything', () => {
  const { matchesSearch } = loadTsx(RANK);
  assert.equal(matchesSearch('cafe', 'Café Corner'), true, '"cafe" finds Café');
  assert.equal(matchesSearch('CAFÉ', 'my cafe'), true, 'and Café finds cafe');
  assert.equal(matchesSearch('corner', null, undefined, 'Café Corner'), true, 'a missing text is passed over');
  assert.equal(matchesSearch('board', 'Café Corner'), false);
  assert.equal(matchesSearch('   ', 'anything'), true);
  assert.equal(matchesSearch('', null), true);
  assert.equal(matchesSearch('x', null), false);
  assert.equal(matchesSearch('Всё', 'Все'), false, 'Cyrillic keeps its marks');
});

// The searches that only narrow a list (no lead) find what Home's grid
// finds: typing "cafe" on Home found an app called Café but not a community
// called Café beside it, and the guest's own pins the same.
test('Home and the Communities page: a community called Café is found by "cafe" (use-home-query)', () => {
  const { matchesQuery } = loadTsx('frontend/src/features/home/use-home-query.ts');
  assert.equal(matchesQuery('cafe', 'Café', 'cafe-7a1f'), true);
  assert.equal(matchesQuery('ecole', 'Petite École', null), true);
  assert.equal(matchesQuery('chess', 'Café', 'cafe-7a1f'), false);
  assert.equal(matchesQuery('', 'Café'), true);
});

test('every list search in the shell reads the one matcher, not a matcher of its own', () => {
  const fs = require('node:fs');
  const read = (p) => fs.readFileSync(require('node:path').join(__dirname, '..', p), 'utf8');
  for (const file of [
    'frontend/src/features/home/use-home-query.ts',
    'frontend/src/features/guest/guest-discover.tsx',
    'frontend/src/features/home/home.js',
    'frontend/src/features/ai/lines.ts',
    'frontend/src/features/ai/project-picker.tsx',
    'frontend/src/features/notifications/notifications-search.js',
    'frontend/src/features/notifications/notifications-sheet.tsx',
    'frontend/src/features/messages/index.tsx',
  ]) {
    const src = read(file);
    assert.match(src, /lib\/search-rank\.js'/, `${file} imports lib/search-rank.js`);
    assert.doesNotMatch(src, /\.toLowerCase\(\)\.includes\(/, `${file} matches with no .toLowerCase().includes() of its own`);
  }
});
