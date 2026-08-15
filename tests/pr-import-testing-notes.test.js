// Testing notes arriving with an imported pull request.
//
// A proposal's before/after screenshots are shot from `testing_path`, and
// the "How to test" panel beside the staging preview renders `testing_md`.
// On the in-platform path both come from a `==== TESTING ====` block in the
// build agent's final message. A connector-submitted proposal has no such
// message, so submit_work passes them to /api/apps/:slug/pr-import instead.
//
// This is the point where they cross a trust boundary. The route is reachable
// by any collaborator, and `testing_path` is joined onto the staging origin
// and loaded in an iframe — so it is re-validated HERE, whatever the
// connector already did to it. These tests pin that, and pin the property
// that makes the change safe to ship: a request that says nothing about
// testing imports exactly as it did before the fields existed.
//
// Run with: node --test tests/pr-import-testing-notes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const votes = require('../src/routes/votes');
const notes = require('../src/services/testing-notes');

const { parseImportTesting } = votes;

test('nothing supplied means nothing written', () => {
  // Every column this touches is nullable and every consumer already
  // handles null, so "absent" has to stay distinguishable from "empty".
  const none = { testingMd: null, testingPath: null, testingPaths: null };
  assert.deepEqual(parseImportTesting({}), none);
  assert.deepEqual(parseImportTesting({ pr: 12 }), none);
  assert.deepEqual(parseImportTesting(null), none);
  assert.deepEqual(parseImportTesting(undefined), none);
  assert.deepEqual(parseImportTesting('nope'), none);
  // Supplied but empty is also nothing — not an empty string in the column.
  assert.deepEqual(parseImportTesting({ testingPaths: [], testingSteps: '   ' }), none);
});

test('a supplied route is stored in the shape the capture step reads', () => {
  const parsed = parseImportTesting({
    testingPaths: ['/board?demo=1', { path: '/settings', viewport: 'mobile' }],
    testingSteps: '1. Open the board\n2. Toggle snap',
  });
  assert.deepEqual(parsed.testingPaths, [
    { path: '/board?demo=1', viewport: notes.VIEWPORT_DESKTOP },
    { path: '/settings', viewport: notes.VIEWPORT_MOBILE },
  ]);
  assert.equal(parsed.testingMd, '1. Open the board\n2. Toggle snap');
  // The single-valued consumers — the "Test this change" deep link and the
  // "Deep link:" line — read testing_path, which is the first entry.
  assert.equal(parsed.testingPath, '/board?demo=1');
});

test('the route is re-validated here, not trusted from the caller', () => {
  // This value ends up in an iframe src on the staging origin. The connector
  // validates too, but the route is reachable without going through it.
  const parsed = parseImportTesting({
    testingPaths: [
      'https://evil.example/steal',
      '//evil.example/steal',
      'javascript:alert(1)',
      'no-leading-slash',
      '/genuine',
    ],
  });
  assert.deepEqual(parsed.testingPaths, [
    { path: '/genuine', viewport: notes.VIEWPORT_DESKTOP },
  ]);
  assert.equal(parsed.testingPath, '/genuine');
  // A list of nothing but rejects is indistinguishable from no list at all.
  assert.equal(parseImportTesting({ testingPaths: ['https://evil.example'] }).testingPath, null);
});

test('junk entries are skipped without taking the import down with them', () => {
  // A failed import costs the submitter their whole push. A bad path costs
  // one screenshot — so this parses defensively and never throws.
  const parsed = parseImportTesting({
    testingPaths: [null, 42, {}, { viewport: 'mobile' }, [], '/ok'],
  });
  assert.deepEqual(parsed.testingPaths, [{ path: '/ok', viewport: notes.VIEWPORT_DESKTOP }]);
  assert.doesNotThrow(() => parseImportTesting({ testingPaths: 'not-an-array' }));
  assert.equal(parseImportTesting({ testingPaths: 'not-an-array' }).testingPath, null);
  assert.doesNotThrow(() => parseImportTesting({ testingSteps: 42 }));
  assert.equal(parseImportTesting({ testingSteps: 42 }).testingMd, null);
});

test('the list stops at the capture cap, and duplicates collapse', () => {
  // visuals.js budgets ~35-40s per route inside a 240s run timeout. A caller
  // that asks for ten routes gets three, not a timed-out capture.
  const over = parseImportTesting({
    testingPaths: ['/a', '/b', '/c', '/d', '/e', '/f'],
  });
  assert.equal(over.testingPaths.length, notes.CAPTURE_MAX_PATHS);
  assert.deepEqual(over.testingPaths.map((p) => p.path), ['/a', '/b', '/c']);

  // The same route twice is one screenshot. The same route at two viewports
  // is two, so that is not a duplicate.
  const dupes = parseImportTesting({
    testingPaths: ['/board', '/board', { path: '/board', viewport: 'mobile' }],
  });
  assert.deepEqual(dupes.testingPaths, [
    { path: '/board', viewport: notes.VIEWPORT_DESKTOP },
    { path: '/board', viewport: notes.VIEWPORT_MOBILE },
  ]);
  // Dedupe happens BEFORE the cap, so three duplicates do not spend it.
  const dupesThenReal = parseImportTesting({
    testingPaths: ['/a', '/a', '/a', '/b', '/c'],
  });
  assert.deepEqual(dupesThenReal.testingPaths.map((p) => p.path), ['/a', '/b', '/c']);
});

test('steps are clipped to what the column holds', () => {
  const parsed = parseImportTesting({ testingSteps: 'x'.repeat(notes.TESTING_MD_MAX + 1000) });
  assert.equal(parsed.testingMd.length, notes.TESTING_MD_MAX);
  // Steps alone, with no route, is a legitimate submission — the capture
  // falls back to the home page but the panel still tells a person what to do.
  assert.equal(parsed.testingPath, null);
  assert.equal(parsed.testingPaths, null);
});

test('the same validator backs every path, so they all land identically', () => {
  // If this route grew its own path rules, a connector proposal and an
  // in-platform one would capture differently from the same route string.
  // #1199 moved the rules themselves into services/testing-notes.js so the
  // UPDATE route could share them too — so what is pinned here is the
  // DELEGATION, and that the route kept no rules of its own.
  const SRC = fs.readFileSync(path.join(__dirname, '../src/routes/votes.js'), 'utf8');
  const fn = SRC.slice(
    SRC.indexOf('function parseImportTesting'),
    SRC.indexOf('function revisionChangedVoteResponse')
  );
  assert.match(fn, /require\('\.\.\/services\/testing-notes'\)/);
  assert.match(fn, /\.parseSubmitted\(/, 'the shared validator, not a local regex');
  assert.doesNotMatch(fn, /startsWith\('\/'\)|\.test\(/, 'no path rules of its own');

  // …and the shared validator is itself built out of the block parser's
  // rules rather than a second copy of them. #1214 moved the last of those
  // rules — the `@mobile` annotation grammar — into readAnnotatedPath, which
  // BOTH parsers now call, so what is pinned here is that parseSubmitted reads
  // an entry through the shared reader rather than picking the string apart.
  const NOTES_SRC = fs.readFileSync(path.join(__dirname, '../src/services/testing-notes.js'), 'utf8');
  const sliceOf = (start, end) => NOTES_SRC.slice(NOTES_SRC.indexOf(start), NOTES_SRC.indexOf(end));
  const shared = sliceOf('function parseSubmitted', 'function explainDrop');
  assert.match(shared, /readSubmittedPath\(/, 'the shared reader, not a local regex');
  assert.match(shared, /CAPTURE_MAX_PATHS/);
  assert.match(shared, /TESTING_MD_MAX/);
  assert.doesNotMatch(shared, /split\(|startsWith\(/, 'no path rules of its own');

  // The one reader both the block parser and the submitted-field parser use.
  const reader = sliceOf('function readSubmittedPath', 'function describeEntry');
  assert.match(reader, /validatePath\(/);
  assert.match(reader, /readAnnotatedPath\(/, 'a string entry is read by the block grammar');
  const blockLoop = sliceOf('const blockLines = text.slice', 'let testingMd');
  assert.match(blockLoop, /readAnnotatedPath\(/, 'the block parser reads it the same way');

  // The update route reaches the same function rather than its own copy.
  const HANDOFF_SRC = fs.readFileSync(path.join(__dirname, '../src/routes/proposal-handoff.js'), 'utf8');
  assert.match(HANDOFF_SRC, /testing-notes'\)\.parseSubmitted\(body\)/);

  // And the same string produces the same result through the block parser.
  const viaBlock = notes.extract(
    'Body.\n\n==== TESTING ====\npath: /board?demo=1\npath: /settings @mobile\nSteps here\n==== END TESTING ===='
  );
  const viaImport = parseImportTesting({
    testingPaths: ['/board?demo=1', { path: '/settings', viewport: 'mobile' }],
    testingSteps: 'Steps here',
  });
  assert.deepEqual(viaImport.testingPaths, viaBlock.testingPaths);
  assert.equal(viaImport.testingMd, viaBlock.testingMd);
});

test('the import writes parsed notes and defaults browser imports to active', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '../src/routes/votes.js'), 'utf8');
  const route = SRC.slice(
    SRC.indexOf("router.post('/api/apps/:slug/pr-import'"),
    SRC.indexOf('// #687 Slice 6')
  );
  const insert = SRC.slice(
    SRC.indexOf('const importTesting = parseImportTesting(req.body)'),
    SRC.indexOf('const sessionId = inserted[0].id')
  );
  assert.ok(insert.length > 0, 'the import route parses the body');
  // The three columns the capture step and the "How to test" panel read.
  assert.match(insert, /testing_md, testing_path, testing_paths/);
  // testing_paths is JSONB — the row stores the object form, same as the
  // in-platform path, so nothing downstream needs to know which path wrote it.
  assert.match(insert, /\$13::jsonb/);
  assert.match(insert, /importTesting\.testingPaths \? JSON\.stringify\(importTesting\.testingPaths\) : null/);
  // Nulls, not empty strings — an import with no notes is byte-for-byte the
  // row this route wrote before the fields existed.
  assert.match(insert, /importTesting\.testingMd/);
  assert.match(insert, /importTesting\.testingPath\b/);
  assert.match(insert, /const promote = req\.body\?\.promote === true/);
  assert.match(insert, /const initialStatus = promote \? 'promoted' : 'active'/);
  // The ::text casts are load-bearing (#1176): $7 also feeds the VARCHAR(32)
  // status column, and postgres rejects the statement at prepare time unless
  // every use of the parameter deduces the same type.
  assert.match(insert, /CASE WHEN \$7::text = 'active' THEN NOW\(\) END/,
    'an active import is shared onto the In-progress board');
  assert.doesNotMatch(route, /maxGlobalSessions|freeGlobalSlot/,
    'an externally produced PR owns no coding worker and spends no worker-cap slot');
});
