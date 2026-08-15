// Tests for src/services/testing-notes.js (#127) — extraction of the
// agent-emitted "==== TESTING ====" block from a build turn's final
// message, and validation of the deep-link path it may carry.
//
// Run with: node --test tests/testing-notes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extract, validatePath, normalizeStoredPath, TESTING_MD_MAX, CAPTURE_MAX_PATHS,
} = require('../src/services/testing-notes');

// testingPaths entries are { path, viewport } objects (#768).
const desk = (path) => ({ path, viewport: 'desktop' });
const mob = (path) => ({ path, viewport: 'mobile' });

test('no block -> text unchanged, fields null/empty', () => {
  const text = 'Built the thing.\n\n- added a route\n- wired the UI';
  assert.deepEqual(extract(text), { cleanedText: text, testingMd: null, testingPath: null, testingPaths: [] });
});

test('handles empty / non-string input', () => {
  assert.deepEqual(extract(''), { cleanedText: '', testingMd: null, testingPath: null, testingPaths: [] });
  assert.deepEqual(extract(null), { cleanedText: '', testingMd: null, testingPath: null, testingPaths: [] });
  assert.deepEqual(extract(undefined), { cleanedText: '', testingMd: null, testingPath: null, testingPaths: [] });
});

test('extracts a full block with path and instructions', () => {
  const text = [
    'Built snap-to-grid for the board.',
    '',
    '==== TESTING ====',
    'path: /board?demo-pr=1',
    '1. Open the board view.',
    '2. Drag a card — it should snap.',
    '==== END TESTING ====',
  ].join('\n');
  const r = extract(text);
  assert.equal(r.cleanedText, 'Built snap-to-grid for the board.');
  assert.equal(r.testingPath, '/board?demo-pr=1');
  assert.equal(r.testingMd, '1. Open the board view.\n2. Drag a card — it should snap.');
});

test('block without a path line keeps path null', () => {
  const text = 'Summary.\n\n==== TESTING ====\nClick the new button in the header.\n==== END TESTING ====';
  const r = extract(text);
  assert.equal(r.cleanedText, 'Summary.');
  assert.equal(r.testingPath, null);
  assert.equal(r.testingMd, 'Click the new button in the header.');
});

test('tolerates a missing END marker at end-of-text', () => {
  const text = 'Summary.\n\n==== TESTING ====\npath: /x\nDo the thing.';
  const r = extract(text);
  assert.equal(r.cleanedText, 'Summary.');
  assert.equal(r.testingPath, '/x');
  assert.equal(r.testingMd, 'Do the thing.');
});

test('last opening marker wins when markers appear mid-text', () => {
  const text = [
    'I will emit a block like:',
    '==== TESTING ====',
    'example steps',
    '==== END TESTING ====',
    'And here is the real one:',
    '==== TESTING ====',
    'path: /real',
    'Real steps.',
    '==== END TESTING ====',
  ].join('\n');
  const r = extract(text);
  assert.equal(r.testingPath, '/real');
  assert.equal(r.testingMd, 'Real steps.');
  // Everything before the LAST opening marker stays in the summary.
  assert.match(r.cleanedText, /example steps/);
  assert.match(r.cleanedText, /And here is the real one:/);
});

test('text after the END marker is preserved in cleanedText', () => {
  const text = 'Before.\n==== TESTING ====\nSteps.\n==== END TESTING ====\nAfter.';
  const r = extract(text);
  assert.equal(r.cleanedText, 'Before.\n\nAfter.');
  assert.equal(r.testingMd, 'Steps.');
});

test('empty block -> testingMd null', () => {
  const r = extract('Summary.\n==== TESTING ====\n\n==== END TESTING ====');
  assert.equal(r.cleanedText, 'Summary.');
  assert.equal(r.testingMd, null);
  assert.equal(r.testingPath, null);
});

test('block with only a path keeps md null', () => {
  const r = extract('Summary.\n==== TESTING ====\npath: /settings\n==== END TESTING ====');
  assert.equal(r.testingMd, null);
  assert.equal(r.testingPath, '/settings');
});

test('invalid path is dropped but instructions are kept', () => {
  const r = extract('S.\n==== TESTING ====\npath: https://evil.example/x\nSteps here.\n==== END TESTING ====');
  assert.equal(r.testingPath, null);
  assert.equal(r.testingMd, 'Steps here.');
});

test('marker lines tolerate extra = and surrounding whitespace', () => {
  const r = extract('S.\n  ======= TESTING =======  \nSteps.\n  == END TESTING ==  ');
  assert.equal(r.cleanedText, 'S.');
  assert.equal(r.testingMd, 'Steps.');
});

test('testingMd is truncated to the cap', () => {
  const long = 'x'.repeat(TESTING_MD_MAX + 500);
  const r = extract(`S.\n==== TESTING ====\n${long}\n==== END TESTING ====`);
  assert.equal(r.testingMd.length, TESTING_MD_MAX);
});

// ── multiple path: lines (#270) ────────────────────────────────────────

test('single path -> testingPaths is the one entry, testingPath the plain string', () => {
  const r = extract('S.\n==== TESTING ====\npath: /board\nSteps.\n==== END TESTING ====');
  assert.deepEqual(r.testingPaths, [desk('/board')]);
  assert.equal(r.testingPath, '/board');
});

test('multiple consecutive path lines parse into testingPaths in order', () => {
  const text = [
    'S.', '==== TESTING ====',
    'path: /board', 'path: /settings?demo=1', 'path: /profile',
    '1. Step one.', '==== END TESTING ====',
  ].join('\n');
  const r = extract(text);
  assert.deepEqual(r.testingPaths, [desk('/board'), desk('/settings?demo=1'), desk('/profile')]);
  assert.equal(r.testingPath, '/board');
  assert.equal(r.testingMd, '1. Step one.');
});

test('blank lines between path lines are tolerated', () => {
  const text = 'S.\n==== TESTING ====\n\npath: /a\n\npath: /b\n\nSteps.\n==== END TESTING ====';
  const r = extract(text);
  assert.deepEqual(r.testingPaths, [desk('/a'), desk('/b')]);
  assert.equal(r.testingMd, 'Steps.');
});

test('invalid path lines are dropped, valid ones kept in order', () => {
  const text = [
    'S.', '==== TESTING ====',
    'path: /ok1', 'path: https://evil/x', 'path: /ok2',
    'Steps.', '==== END TESTING ====',
  ].join('\n');
  const r = extract(text);
  assert.deepEqual(r.testingPaths, [desk('/ok1'), desk('/ok2')]);
  assert.equal(r.testingPath, '/ok1');
});

test('duplicate paths collapse preserving first-seen order', () => {
  const text = 'S.\n==== TESTING ====\npath: /a\npath: /b\npath: /a\nSteps.\n==== END TESTING ====';
  const r = extract(text);
  assert.deepEqual(r.testingPaths, [desk('/a'), desk('/b')]);
});

test('path list is capped at CAPTURE_MAX_PATHS, extras dropped', () => {
  const lines = ['S.', '==== TESTING ===='];
  for (let i = 0; i < CAPTURE_MAX_PATHS + 2; i++) lines.push(`path: /p${i}`);
  lines.push('Steps.', '==== END TESTING ====');
  const r = extract(lines.join('\n'));
  assert.equal(r.testingPaths.length, CAPTURE_MAX_PATHS);
  assert.deepEqual(r.testingPaths[0], desk('/p0'));
  assert.equal(r.testingPath, '/p0');
});

test('a non-path line stops path collection (later path: lines are md, not paths)', () => {
  const text = 'S.\n==== TESTING ====\npath: /a\n1. step\npath: /b\n==== END TESTING ====';
  const r = extract(text);
  assert.deepEqual(r.testingPaths, [desk('/a')]);
  assert.equal(r.testingMd, '1. step\npath: /b');
});

// ── @mobile viewport annotation (#768) ─────────────────────────────────

test('@mobile annotation sets the entry viewport, testingPath stays the plain path', () => {
  const r = extract('S.\n==== TESTING ====\npath: /board?demo=1 @mobile\nSteps.\n==== END TESTING ====');
  assert.deepEqual(r.testingPaths, [mob('/board?demo=1')]);
  assert.equal(r.testingPath, '/board?demo=1');
});

test('@mobile is case-insensitive', () => {
  const r = extract('S.\n==== TESTING ====\npath: /a @MOBILE\nSteps.\n==== END TESTING ====');
  assert.deepEqual(r.testingPaths, [mob('/a')]);
});

test('unknown annotations are ignored, the path is kept as desktop', () => {
  const r = extract('S.\n==== TESTING ====\npath: /a @tablet\nSteps.\n==== END TESTING ====');
  assert.deepEqual(r.testingPaths, [desk('/a')]);
});

test('the same path may appear once per viewport', () => {
  const text = 'S.\n==== TESTING ====\npath: /board\npath: /board @mobile\nSteps.\n==== END TESTING ====';
  const r = extract(text);
  assert.deepEqual(r.testingPaths, [desk('/board'), mob('/board')]);
  assert.equal(r.testingPath, '/board');
});

test('duplicate path+viewport pairs collapse', () => {
  const text = 'S.\n==== TESTING ====\npath: /a @mobile\npath: /a @mobile\nSteps.\n==== END TESTING ====';
  assert.deepEqual(extract(text).testingPaths, [mob('/a')]);
});

test('an invalid path with an annotation is still dropped', () => {
  const r = extract('S.\n==== TESTING ====\npath: https://evil/x @mobile\nSteps.\n==== END TESTING ====');
  assert.deepEqual(r.testingPaths, []);
  assert.equal(r.testingPath, null);
});

// ── normalizeStoredPath (stored-row back-compat, #768) ─────────────────

test('normalizeStoredPath maps legacy strings to desktop entries', () => {
  assert.deepEqual(normalizeStoredPath('/board'), desk('/board'));
  assert.deepEqual(normalizeStoredPath('/'), desk('/'));
});

test('normalizeStoredPath passes object entries through, defaulting bad viewports to desktop', () => {
  assert.deepEqual(normalizeStoredPath(mob('/a')), mob('/a'));
  assert.deepEqual(normalizeStoredPath(desk('/a')), desk('/a'));
  assert.deepEqual(normalizeStoredPath({ path: '/a', viewport: 'tablet' }), desk('/a'));
  assert.deepEqual(normalizeStoredPath({ path: '/a' }), desk('/a'));
});

test('normalizeStoredPath returns null for unusable entries', () => {
  assert.equal(normalizeStoredPath(''), null);
  assert.equal(normalizeStoredPath(null), null);
  assert.equal(normalizeStoredPath(undefined), null);
  assert.equal(normalizeStoredPath(42), null);
  assert.equal(normalizeStoredPath({}), null);
  assert.equal(normalizeStoredPath({ path: '' }), null);
  assert.equal(normalizeStoredPath({ viewport: 'mobile' }), null);
});

test('absent block -> empty testingPaths list', () => {
  assert.deepEqual(extract('just a summary').testingPaths, []);
});

test('validatePath accepts plain relative paths with queries', () => {
  assert.equal(validatePath('/board'), '/board');
  assert.equal(validatePath('  /board?demo=1&x=2  '), '/board?demo=1&x=2');
  assert.equal(validatePath('/a/b/c#frag'), '/a/b/c#frag');
});

test('validatePath rejects unsafe or non-relative values', () => {
  assert.equal(validatePath('https://evil.example/'), null);
  assert.equal(validatePath('//evil.example/x'), null);
  assert.equal(validatePath('board'), null);
  assert.equal(validatePath('/has space'), null);
  assert.equal(validatePath('/tick`y'), null);
  assert.equal(validatePath('/quo"te'), null);
  assert.equal(validatePath("/quo'te"), null);
  assert.equal(validatePath('/ang<le>'), null);
  assert.equal(validatePath('/back\\slash'), null);
  assert.equal(validatePath(''), null);
  assert.equal(validatePath(null), null);
  assert.equal(validatePath('/' + 'a'.repeat(600)), null);
});

// ── #1214: one grammar for a submitted route, and no silent drops ─────────
//
// `parseSubmitted` is what a PR import and a proposal update read their
// capture routes with. It used to read a whole string as the path, so the
// annotated form every agent-facing description teaches — "/board @mobile" —
// failed the no-whitespace rule and the route vanished. Nothing said so: the
// only signal was `captureDefaultedToRoot` on a different endpoint, minutes
// later, by which time the group was voting on home-page screenshots.

const {
  parseSubmitted, readSubmittedPath, displayPaths, explainDrops,
} = require('../src/services/testing-notes');

test('a submitted route may carry the same @mobile annotation the block does', () => {
  const parsed = parseSubmitted({ testingPaths: ['/board?shot=invite @mobile', '/settings'] });
  assert.deepEqual(parsed.testingPaths, [mob('/board?shot=invite'), desk('/settings')]);
  // The primary path is the path alone — the annotation is not part of it.
  assert.equal(parsed.testingPath, '/board?shot=invite');
  assert.deepEqual(parsed.dropped, []);

  // The same route, written all three ways, means the same thing.
  const viaObject = parseSubmitted({ testingPaths: [{ path: '/board', viewport: 'mobile' }] });
  const viaString = parseSubmitted({ testingPaths: ['/board @mobile'] });
  const viaBlock = extract('==== TESTING ====\npath: /board @mobile\n==== END TESTING ====');
  assert.deepEqual(viaString.testingPaths, viaObject.testingPaths);
  assert.deepEqual(viaString.testingPaths, viaBlock.testingPaths);
});

test('an unknown annotation loses the annotation, never the route', () => {
  // A typo'd annotation degrades to a desktop shot. Losing the route would
  // fall the capture back to the home page, which is strictly worse.
  const parsed = parseSubmitted({ testingPaths: ['/board @tablet', '/inbox @MOBILE'] });
  assert.deepEqual(parsed.testingPaths, [desk('/board'), mob('/inbox')]);
  assert.deepEqual(parsed.dropped, []);
});

test('every dropped entry is reported, with the caller\'s own text', () => {
  const parsed = parseSubmitted({
    testingPaths: ['https://evil.example/x', '/ok', '/ok', 42],
  });
  assert.deepEqual(parsed.testingPaths, [desk('/ok')]);
  assert.deepEqual(parsed.dropped, [
    { index: 0, entry: 'https://evil.example/x', reason: 'invalid_path' },
    { index: 2, entry: '/ok', reason: 'duplicate' },
    { index: 3, entry: '(number)', reason: 'invalid_path' },
  ]);
  // Dropping is still the behaviour — one bad route must not cost a whole
  // submission — so the usable route is kept and `provided` stays true.
  assert.equal(parsed.provided, true);
});

test('entries over the capture cap are reported rather than vanishing', () => {
  const many = ['/a', '/b', '/c', '/d', '/e'];
  const parsed = parseSubmitted({ testingPaths: many });
  assert.equal(parsed.testingPaths.length, CAPTURE_MAX_PATHS);
  assert.deepEqual(parsed.dropped.map((d) => d.entry), ['/d', '/e']);
  assert.ok(parsed.dropped.every((d) => d.reason === 'over_cap'));
  assert.match(explainDrops(parsed.dropped)[0], /over the 3-route cap/);
});

test('a body whose every route is rejected still reports why', () => {
  // This is the case that most needs saying out loud: nothing is stored, the
  // capture falls back to '/', and to every consumer downstream it is
  // indistinguishable from a submission that named no route at all.
  const parsed = parseSubmitted({ testingPaths: ['nope', '//evil.example'] });
  assert.equal(parsed.provided, false);
  assert.equal(parsed.testingPaths, null);
  assert.equal(parsed.dropped.length, 2);
  assert.match(explainDrops(parsed.dropped)[0], /must start with a single "\/"/);
  // And a caller that sent nothing at all hears nothing at all.
  assert.deepEqual(parseSubmitted({}).dropped, []);
  assert.deepEqual(parseSubmitted(null).dropped, []);
  assert.equal(explainDrops([]), null);
  assert.equal(explainDrops(undefined), null);
});

test('a rejected entry is clipped and stripped before it is echoed back', () => {
  // It goes into a tool response. It is the caller's own text, but it is not
  // a licence to bounce a wall of it back through the connector.
  const long = `/${'x'.repeat(600)}`; // over TESTING_PATH_MAX, so it is rejected
  const [dropped] = parseSubmitted({ testingPaths: [`${long} @mobile`] }).dropped;
  assert.ok(dropped.entry.length < 130, 'clipped');
  assert.match(dropped.entry, /…$/);
  const [controls] = parseSubmitted({ testingPaths: ['/ba\u0001d path'] }).dropped;
  assert.equal(controls.entry, '/ba d path');
  const [noPath] = parseSubmitted({ testingPaths: [{ viewport: 'mobile' }] }).dropped;
  assert.match(noPath.entry, /object with no path/);
});

test('readSubmittedPath and displayPaths round-trip a route', () => {
  // An agent reading a response compares it against what it sent, so the
  // annotation has to be spelled back the way it was written.
  assert.deepEqual(readSubmittedPath('/board @mobile'), mob('/board'));
  assert.deepEqual(readSubmittedPath({ path: '/board', viewport: 'mobile' }), mob('/board'));
  assert.equal(readSubmittedPath('nope'), null);
  assert.equal(readSubmittedPath(null), null);
  assert.deepEqual(displayPaths([mob('/board'), desk('/settings')]), ['/board @mobile', '/settings']);
  // Pre-#768 rows hold plain strings, and they display as themselves.
  assert.deepEqual(displayPaths(['/legacy']), ['/legacy']);
  assert.equal(displayPaths([]), null);
  assert.equal(displayPaths(null), null);
});
