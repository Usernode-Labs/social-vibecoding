// The request an imported pull request implements (#1217).
//
// A proposal built from a request has to be linked to it, in two places that
// do different jobs:
//
//   1. `Closes #N` in the PR BODY — GitHub is what actually closes the issue
//      on merge; the platform's post-merge watcher only polls for it having
//      happened (services/issue-close-watcher.js); and
//   2. `chat_sessions.linked_issues` — what that watcher expects to close,
//      what the merge path suppresses optimistically, and what the Dev board
//      reads to show a request as being worked on.
//
// A connector submission carried NEITHER. prepare_work has recorded the
// request number on the task since the beginning — the work order it prints
// even says "This implements request #N" — but the number stopped at the
// task, so #1217's own proposal opened with a prose reference and no link,
// and would not have closed the request it implemented.
//
// The trust boundary is the same one the testing metadata crosses: the route
// is reachable by any collaborator, so what arrives is sanitized HERE
// whatever the connector already did to it. And the property that makes it
// safe to ship is the same too — an import that says nothing about issues
// writes exactly the row it wrote before the field existed.
//
// Run with: node --test tests/pr-import-linked-issues.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const votes = require('../src/routes/votes');
const prMetadata = require('../src/services/pr-metadata');

const { parseImportLinkedIssues, MAX_IMPORT_LINKED_ISSUES } = votes;

const VOTES_SRC = fs.readFileSync(path.join(__dirname, '../src/routes/votes.js'), 'utf8');

test('nothing supplied means nothing written', () => {
  // The browser's own import button sends no such field, and every consumer
  // branches on the array being non-empty — so "no request" has to be the
  // empty array, which is exactly what the column defaulted to before.
  assert.deepEqual(parseImportLinkedIssues({}), []);
  assert.deepEqual(parseImportLinkedIssues({ pr: 12 }), []);
  assert.deepEqual(parseImportLinkedIssues(null), []);
  assert.deepEqual(parseImportLinkedIssues(undefined), []);
  assert.deepEqual(parseImportLinkedIssues({ linkedIssues: [] }), []);
  assert.deepEqual(parseImportLinkedIssues({ linkedIssues: 'nope' }), []);
});

test('the numbers are sanitized here, not trusted from the caller', () => {
  assert.deepEqual(parseImportLinkedIssues({ linkedIssues: [1217] }), [1217]);
  // Strings coerce, junk and non-positive values are dropped, duplicates
  // collapse, and the result is sorted — all of it pr-metadata's rules.
  assert.deepEqual(
    parseImportLinkedIssues({ linkedIssues: [42, '17', 17, 0, -3, null, 'x', 1.5] }),
    [17, 42]
  );
});

test('the same helper decides this as decides the PR body, so they cannot drift', () => {
  // A number the column would accept and the `Closes #N` block would not (or
  // the reverse) is a proposal that reports one link and acts on another.
  const messy = [1217, '1217', 0, -1, 'x', 88];
  assert.deepEqual(parseImportLinkedIssues({ linkedIssues: messy }),
    prMetadata.sanitizeIssueNumbers(messy));
  assert.equal(prMetadata.buildClosingBlock(parseImportLinkedIssues({ linkedIssues: [1217] })),
    'Closes #1217');
});

test('the list is capped', () => {
  const many = Array.from({ length: MAX_IMPORT_LINKED_ISSUES + 25 }, (_, i) => i + 1);
  assert.equal(parseImportLinkedIssues({ linkedIssues: many }).length, MAX_IMPORT_LINKED_ISSUES);
  assert.equal(MAX_IMPORT_LINKED_ISSUES, 50, "the local handoff route's cap");
});

test('the import writes the column, and an import without issues writes the empty array', () => {
  const insert = VOTES_SRC.slice(
    VOTES_SRC.indexOf('const importTesting = parseImportTesting(req.body)'),
    VOTES_SRC.indexOf('const sessionId = inserted[0].id')
  );
  assert.ok(insert.length > 0, 'the import route parses the body');
  assert.match(insert, /const importLinkedIssues = parseImportLinkedIssues\(req\.body\)/);
  assert.match(insert, /testing_paths, linked_issues/, 'the column is in the insert');
  // The column is INTEGER[] NOT NULL DEFAULT '{}', so the parameter is
  // always an array. A `null` here would make EVERY import without a request
  // — which is every browser import — fail on the not-null constraint.
  assert.match(insert, /^\s*importLinkedIssues,$/m);
  assert.doesNotMatch(insert, /importLinkedIssues[^,\n]*null/);
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  assert.match(schema, /linked_issues\s+INTEGER\[\] NOT NULL DEFAULT '\{\}'/,
    'which is what makes the array mandatory');
});

test('the connector carries the task’s request number into the import', () => {
  // Two producers, one fact. The service knows which request the work order
  // was prepared from; the tools module is only the transport.
  const tasks = fs.readFileSync(
    path.join(__dirname, '../src/services/external-agent-tasks.js'), 'utf8'
  );
  assert.match(tasks, /function linkedIssuesFor\(task\)/);
  assert.match(tasks, /importProposal\(slug, pr\.number, \{ linkedIssues: linkedIssuesFor\(task\) \}\)/);
  // And the closing keyword on the body, from pr-metadata's own builder so
  // the two closing blocks in the codebase cannot disagree.
  assert.match(tasks, /buildClosingBlock\(linkedIssuesFor\(task\)\)/);

  for (const [label, file] of [
    ['the connector', '../src/services/mcp-tools.js'],
    ['the browser twin', '../src/routes/dev-flow.js'],
  ]) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.match(src, /extra\.linkedIssues && extra\.linkedIssues\.length/,
      `${label} forwards the linked issues it is handed`);
    assert.match(src, /\{ linkedIssues: extra\.linkedIssues \}/, `${label} sends them under the route's own name`);
  }
});
