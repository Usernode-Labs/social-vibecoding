'use strict';

// #6423, #6428: before a build starts, the files its plan names are compared
// with the files the project's other open changes really change. The rules
// are pure (src/workflow/rules/bot-loop.ts): which files a plan names, and
// what the build does on an overlap. Since #6428 an overlap never holds a
// build: it builds in parallel and says what it shares, and it goes on top
// of another change only when its request depends on that one's.

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

test('an overlap in a file that is not append-only builds in parallel, naming the file', () => {
  const d = rules.decideOverlap({
    files: ['src/a.ts', 'src/b.ts'], others: [{ ...OTHER, status: 'active', files: ['src/b.ts', 'src/c.ts'] }],
  });
  assert.equal(d.strategy, 'parallel');
  assert.deepEqual(d.files, ['src/b.ts'], 'the files it shares');
  assert.equal(d.with.sessionId, 501, 'the change its note names');
});

test('a running build or a person\'s open change never holds another build', () => {
  const others = [
    // A person's change, not up for a vote.
    { ...OTHER, sessionId: 9, status: 'active', files: ['src/a.ts'] },
    // A running build: its session, read by its branch's diff.
    { ...OTHER, sessionId: 10, issueNumber: 6410, prNumber: null, status: 'active', files: ['src/a.ts'] },
    // Up for a vote, and on top of another change itself.
    { ...OTHER, sessionId: 11, status: 'promoted', stacked: true, files: ['src/a.ts'] },
    // Up for a vote and buildable on: sharing files alone never stacks.
    { ...OTHER, sessionId: 12, status: 'promoted', files: ['src/a.ts'] },
  ];
  for (const other of others) {
    const d = rules.decideOverlap({ files: ['src/a.ts'], others: [other] });
    assert.equal(d.strategy, 'parallel', `session ${other.sessionId}`);
  }
  const all = rules.decideOverlap({ files: ['src/a.ts'], others });
  assert.equal(all.strategy, 'parallel', 'several overlaps at once');
  assert.equal(all.with.sessionId, 9, 'the first one is named');
  assert.equal(rules.OVERLAP_WAIT_MS, undefined, 'there is no wait to bound any more');
});

test('a build is stacked only when its request depends on the other change\'s request', () => {
  const parent = { ...OTHER, status: 'promoted', requests: [6404, 6405], files: ['src/a.ts'] };
  const on = rules.decideOverlap({ files: ['src/a.ts'], others: [parent], dependsOn: [6405] });
  assert.equal(on.strategy, 'stack');
  assert.equal(on.with.prNumber, 6404);
  assert.equal(on.with.branch, 'dev/x');
  assert.deepEqual(on.files, ['src/a.ts']);
  assert.equal(rules.decideOverlap({ files: [], others: [{ ...parent, files: [] }], dependsOn: [6404] }).strategy, 'stack',
    'a dependency stacks with no shared file, and with a plan that names none');
  assert.equal(rules.decideOverlap({ files: ['src/a.ts'], others: [parent] }).strategy, 'parallel',
    'the same overlap with no dependency');
  assert.equal(rules.decideOverlap({ files: ['src/a.ts'], others: [parent], dependsOn: [7000] }).strategy, 'parallel',
    'a dependency on another request');
  const issueOnly = { ...OTHER, status: 'promoted', requests: undefined, files: [] };
  assert.equal(rules.decideOverlap({ files: ['src/a.ts'], others: [issueOnly], dependsOn: [6404] }).strategy, 'stack',
    'with no linked requests, its own request number is read');
  for (const [why, other] of [
    ['not up for a vote', { ...parent, status: 'active' }],
    ['on top of another change itself', { ...parent, stacked: true }],
    ['with no pull request', { ...parent, prNumber: null }],
    ['with no branch', { ...parent, branch: null }],
  ]) {
    assert.equal(rules.decideOverlap({ files: ['src/a.ts'], others: [other], dependsOn: [6404] }).strategy, 'parallel', why);
  }
});

test('append-only shared files go ahead in parallel, named only when nothing else is shared', () => {
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
  const both = rules.decideOverlap({
    files: ['tests/baselines/test-durations.json', 'src/a.ts'],
    others: [
      { ...OTHER, sessionId: 8, files: ['tests/baselines/test-durations.json'] },
      { ...OTHER, sessionId: 9, files: ['tests/baselines/test-durations.json', 'src/a.ts'] },
    ],
  });
  assert.equal(both.strategy, 'parallel');
  assert.equal(both.with.sessionId, 9, 'the change that may really conflict is named first');
  assert.deepEqual(both.files, ['src/a.ts'], 'only the file that may really conflict');
});

test('a build held for an overlap before #6428 is the lane\'s to grant on its next pass', () => {
  // The lane's candidates: a hold for the payer's week still holds; one an
  // older build stored for an overlap does not.
  assert.match(rules.BUILD_CANDIDATES_SQL,
    /AND \(w\.data->'build'->>'heldUntil' IS NULL OR \(w\.data->'build'->>'heldUntil'\)::timestamptz <= NOW\(\)\s+OR w\.data->'build'->>'heldFor' = 'overlap'\)/);
});
