'use strict';

// #6423: before a build starts, the files its plan names are compared with
// the files the project's other open changes and running builds touch. The
// rules are pure (src/workflow/rules/bot-loop.ts): which files a plan names,
// and what the build does on an overlap.

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../src/workflow/rules/bot-loop.ts');
const { APPEND_ONLY_FILES, isAppendOnly } = require('../src/workflow/rules/append-only-files.ts');

const OTHER = {
  sessionId: 501, runId: null, issueNumber: 6404, prNumber: 6404, status: 'active', branch: 'dev/x', stacked: false,
};

test('filesNamed reads the repository paths a plan names, once each', () => {
  const plan = [
    'Add the list: `frontend/src/features/ai/lists.tsx` and `frontend/src/features/ai/door.ts`.',
    '- tests/baselines/test-durations.json (append a row)',
    '| src/db/migrations/manifest.json | manifest |',
    'frontend/src/features/ai/lists.tsx again.',
    'No path here: just words, a/b and c.d',
  ].join('\n');
  assert.deepEqual(rules.filesNamed(plan), [
    'frontend/src/features/ai/lists.tsx',
    'frontend/src/features/ai/door.ts',
    'tests/baselines/test-durations.json',
    'src/db/migrations/manifest.json',
  ]);
  assert.deepEqual(rules.filesNamed(''), [], 'a plan naming no file');
  assert.deepEqual(rules.filesNamed(null), []);
  // A token with no extension, or no slash, is no path.
  assert.deepEqual(rules.filesNamed('src/features/ai and lists.tsx'), []);
});

test('filesNamed keeps at most NAMED_FILES_CAP', () => {
  const many = Array.from({ length: 300 }, (_, i) => `src/dir/f${i}.ts`).join(' ');
  assert.equal(rules.filesNamed(many).length, rules.NAMED_FILES_CAP);
});

test('no shared file: the build goes ahead as today', () => {
  const d = rules.decideOverlap({ files: ['src/a.ts'], others: [{ ...OTHER, files: ['src/b.ts'] }] });
  assert.deepEqual(d, { strategy: 'none', with: null, files: [] });
  assert.equal(rules.decideOverlap({ files: ['src/a.ts'], others: [] }).strategy, 'none');
  assert.equal(rules.decideOverlap({ files: [], others: [{ ...OTHER, files: ['src/a.ts'] }] }).strategy, 'none',
    'a plan that names no file overlaps nothing');
});

test('an active change touching the same file is waited for', () => {
  const d = rules.decideOverlap({
    files: ['src/a.ts', 'src/b.ts'], others: [{ ...OTHER, status: 'active', files: ['src/b.ts', 'src/c.ts'] }],
  });
  assert.equal(d.strategy, 'wait');
  assert.deepEqual(d.files, ['src/b.ts'], 'the files it waits on');
  assert.equal(d.with.sessionId, 501);
});

test('a running build touching the same file is waited for the same way', () => {
  const d = rules.decideOverlap({
    files: ['src/a.ts'],
    others: [{ sessionId: null, runId: 77, issueNumber: 6410, prNumber: null, status: 'building', branch: null, files: ['src/a.ts'] }],
  });
  assert.equal(d.strategy, 'wait');
  assert.equal(d.with.runId, 77, 'the running build, which has no pull request yet');
});

test('one change up for a vote, not itself stacked, is built on top of', () => {
  const d = rules.decideOverlap({ files: ['src/a.ts'], others: [{ ...OTHER, status: 'promoted', files: ['src/a.ts'] }] });
  assert.equal(d.strategy, 'stack');
  assert.equal(d.with.prNumber, 6404);
  assert.equal(d.with.branch, 'dev/x');
});

test('the wait is bounded, and only then does the build go on main', () => {
  const since = new Date('2026-11-06T10:00:00Z');
  const other = { ...OTHER, status: 'active', files: ['src/a.ts'] };
  const before = rules.decideOverlap({ files: ['src/a.ts'], others: [other], since, now: new Date('2026-11-06T11:59:00Z') });
  assert.equal(before.strategy, 'wait');
  const after = rules.decideOverlap({ files: ['src/a.ts'], others: [other], since, now: new Date('2026-11-06T12:00:00Z') });
  assert.equal(after.strategy, 'timeout', '2 hours after the first wait');
});

test('append-only shared files never block on their own', () => {
  for (const path of APPEND_ONLY_FILES) {
    assert.ok(isAppendOnly(path), path);
    const d = rules.decideOverlap({
      files: [path, 'src/a.ts'],
      others: [{ ...OTHER, status: 'active', files: [path] }],
    });
    assert.equal(d.strategy, 'parallel', `${path} is combined by the merge sync`);
    assert.deepEqual(d.files, [path]);
  }
  assert.equal(isAppendOnly('./tests/baselines/test-durations.json'), true);
  assert.equal(isAppendOnly('src/a.ts'), false);
});

test('an append-only file plus a real one still blocks', () => {
  const d = rules.decideOverlap({
    files: ['tests/baselines/test-durations.json', 'src/a.ts'],
    others: [{ ...OTHER, status: 'active', files: ['tests/baselines/test-durations.json', 'src/a.ts'] }],
  });
  assert.equal(d.strategy, 'wait');
  assert.deepEqual(d.files, ['src/a.ts'], 'only the file that really conflicts');
});

test('a stacked change is never built on, and two overlaps are waited for', () => {
  const stacked = rules.decideOverlap({
    files: ['src/a.ts'], others: [{ ...OTHER, status: 'promoted', stacked: true, files: ['src/a.ts'] }],
  });
  assert.equal(stacked.strategy, 'wait');
  const two = rules.decideOverlap({
    files: ['src/a.ts'],
    others: [
      { ...OTHER, sessionId: 9, status: 'promoted', files: ['src/a.ts'] },
      { ...OTHER, sessionId: 8, status: 'promoted', files: ['src/a.ts'] },
    ],
  });
  assert.equal(two.strategy, 'wait');
  assert.equal(two.with.sessionId, 8, 'the earliest one');
});

test('a promoted change with no pull request or branch is waited for', () => {
  const d = rules.decideOverlap({
    files: ['src/a.ts'], others: [{ ...OTHER, status: 'promoted', prNumber: null, files: ['src/a.ts'] }],
  });
  assert.equal(d.strategy, 'wait');
});
