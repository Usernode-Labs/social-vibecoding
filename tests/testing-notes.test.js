// Tests for src/services/testing-notes.js (#127) — extraction of the
// agent-emitted "==== TESTING ====" block from a build turn's final
// message, and validation of the deep-link path it may carry.
//
// Run with: node --test tests/testing-notes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { extract, validatePath, TESTING_MD_MAX, CAPTURE_MAX_PATHS } = require('../src/services/testing-notes');

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

test('single path -> testingPaths is the one path, testingPath the same', () => {
  const r = extract('S.\n==== TESTING ====\npath: /board\nSteps.\n==== END TESTING ====');
  assert.deepEqual(r.testingPaths, ['/board']);
  assert.equal(r.testingPath, '/board');
});

test('multiple consecutive path lines parse into testingPaths in order', () => {
  const text = [
    'S.', '==== TESTING ====',
    'path: /board', 'path: /settings?demo=1', 'path: /profile',
    '1. Step one.', '==== END TESTING ====',
  ].join('\n');
  const r = extract(text);
  assert.deepEqual(r.testingPaths, ['/board', '/settings?demo=1', '/profile']);
  assert.equal(r.testingPath, '/board');
  assert.equal(r.testingMd, '1. Step one.');
});

test('blank lines between path lines are tolerated', () => {
  const text = 'S.\n==== TESTING ====\n\npath: /a\n\npath: /b\n\nSteps.\n==== END TESTING ====';
  const r = extract(text);
  assert.deepEqual(r.testingPaths, ['/a', '/b']);
  assert.equal(r.testingMd, 'Steps.');
});

test('invalid path lines are dropped, valid ones kept in order', () => {
  const text = [
    'S.', '==== TESTING ====',
    'path: /ok1', 'path: https://evil/x', 'path: /ok2',
    'Steps.', '==== END TESTING ====',
  ].join('\n');
  const r = extract(text);
  assert.deepEqual(r.testingPaths, ['/ok1', '/ok2']);
  assert.equal(r.testingPath, '/ok1');
});

test('duplicate paths collapse preserving first-seen order', () => {
  const text = 'S.\n==== TESTING ====\npath: /a\npath: /b\npath: /a\nSteps.\n==== END TESTING ====';
  const r = extract(text);
  assert.deepEqual(r.testingPaths, ['/a', '/b']);
});

test('path list is capped at CAPTURE_MAX_PATHS, extras dropped', () => {
  const lines = ['S.', '==== TESTING ===='];
  for (let i = 0; i < CAPTURE_MAX_PATHS + 2; i++) lines.push(`path: /p${i}`);
  lines.push('Steps.', '==== END TESTING ====');
  const r = extract(lines.join('\n'));
  assert.equal(r.testingPaths.length, CAPTURE_MAX_PATHS);
  assert.equal(r.testingPaths[0], '/p0');
  assert.equal(r.testingPath, '/p0');
});

test('a non-path line stops path collection (later path: lines are md, not paths)', () => {
  const text = 'S.\n==== TESTING ====\npath: /a\n1. step\npath: /b\n==== END TESTING ====';
  const r = extract(text);
  assert.deepEqual(r.testingPaths, ['/a']);
  assert.equal(r.testingMd, '1. step\npath: /b');
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
