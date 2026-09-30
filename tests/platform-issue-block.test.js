// The "==== PLATFORM ISSUE ====" block (src/services/platform-issue-block.js):
// how an OpenRouter build turn, which holds only a push-scoped token and so
// cannot run `usernode-report-platform-issue`, still escalates a problem
// outside the app instead of working around it (Sheep countrr's #38 answered
// the app's own stylesheet with 204 to quiet one; #48 there).
//
// Pins the parser, that the prompt's own example parses, and that the build
// turn files the same draft card the helper's route does.
//
// Run with: node --test tests/platform-issue-block.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const subject = require('../src/services/platform-issue-block');
const issueDraft = require('../src/services/issue-draft');
const { OPENROUTER_PLATFORM_ISSUE_GUIDANCE } = require('../src/routes/sessions');

const SESSIONS = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8');

test('a block becomes a title and body, and leaves the message', () => {
  const text = [
    'I added the wolf.',
    '',
    '==== PLATFORM ISSUE ====',
    'The bridge answers 401 in the preview',
    '',
    'GET /usernode-bridge/ returns 401 in a plain local boot.',
    'The app needs the preview to serve it.',
    '==== END PLATFORM ISSUE ====',
    '',
    'Files: public/wolf.js',
  ].join('\n');
  const { cleanedText, issue } = subject.extract(text);
  assert.deepEqual(issue, {
    title: 'The bridge answers 401 in the preview',
    body: 'GET /usernode-bridge/ returns 401 in a plain local boot.\nThe app needs the preview to serve it.',
  });
  assert.equal(cleanedText, 'I added the wolf.\n\nFiles: public/wolf.js');
  assert.doesNotMatch(cleanedText, /PLATFORM ISSUE/);
});

test('no block, no issue, text untouched', () => {
  for (const text of ['Plain summary.', '', 'The PLATFORM ISSUE is mentioned inline.']) {
    assert.deepEqual(subject.extract(text), { cleanedText: text, issue: null });
  }
  assert.deepEqual(subject.extract(undefined), { cleanedText: '', issue: null });
});

test('the prompt\'s own example parses with the real parser', () => {
  const { issue, cleanedText } = subject.extract(OPENROUTER_PLATFORM_ISSUE_GUIDANCE);
  assert.equal(issue.title, 'One-line title');
  assert.match(issue.body, /^What is broken or missing/);
  assert.match(cleanedText, /Homeroom turns it into a draft report/);
});

test('marker variants the other blocks accept, title shapes, the last block, a missing end', () => {
  const bold = subject.extract('**PLATFORM ISSUE**\nTitle: Checks cannot reach the DB\nbody\n**END PLATFORM ISSUE**');
  assert.equal(bold.issue.title, 'Checks cannot reach the DB');
  assert.equal(bold.cleanedText, '');

  const heading = subject.extract('==== PLATFORM ISSUE ====\n\n## No wallet API for X\nwhy');
  assert.equal(heading.issue.title, 'No wallet API for X');
  assert.equal(heading.issue.body, 'why');

  const two = subject.extract([
    '==== PLATFORM ISSUE ====', 'first', '==== END PLATFORM ISSUE ====',
    'middle',
    '==== PLATFORM ISSUE ====', 'second', 'detail', '==== END PLATFORM ISSUE ====',
  ].join('\n'));
  assert.equal(two.issue.title, 'second', 'the last block is the one filed');

  const empty = subject.extract('before\n==== PLATFORM ISSUE ====\n\n==== END PLATFORM ISSUE ====');
  assert.equal(empty.issue, null, 'no title line, nothing to file');
  assert.equal(empty.cleanedText, 'before', 'but the markers still leave the message');
});

test('title and body are clipped to what the draft service accepts', () => {
  assert.equal(subject.TITLE_MAX, issueDraft.TITLE_MAX, 'kept in step with the draft service');
  assert.equal(subject.BODY_MAX, issueDraft.BODY_MAX);
  const { issue } = subject.extract(`==== PLATFORM ISSUE ====\n${'t'.repeat(400)}\n${'b'.repeat(20000)}\n==== END PLATFORM ISSUE ====`);
  assert.ok(issue.title.length <= subject.TITLE_MAX);
  assert.ok(issue.body.length <= subject.BODY_MAX);
  assert.ok(issue.title.endsWith('…'));
});

test('OpenRouter turns are told to escalate with the block, not only that the helper is missing', () => {
  const g = OPENROUTER_PLATFORM_ISSUE_GUIDANCE;
  assert.match(g, /do not work around it in\nthe app/);
  assert.match(g, /`usernode-report-platform-issue` helper is not available on this backend/);
  assert.match(g, /before its description and testing blocks/);
  assert.match(g, /never for something you can fix in this app/);
  assert.match(SESSIONS, /const platformIssueHelperNote = isCodexSession\n\s+\? OPENROUTER_PLATFORM_ISSUE_GUIDANCE\n/);
  assert.doesNotMatch(SESSIONS, /helper is NOT available on this backend; do not call it/);
});

test('the build turn files the block as the helper\'s draft card, OpenRouter turns only', () => {
  assert.match(SESSIONS, /const escalation = isCodexSession\n\s+\? platformIssueBlock\.extract\(described\.cleanedText\)/);
  const call = SESSIONS.slice(SESSIONS.indexOf('if (escalation.issue) {'));
  assert.ok(call.length > 0);
  assert.match(call, /^if \(escalation\.issue\) \{\n\s+issueDraft\.createDraft\(pool, config, \{\n\s+sessionId: session\.id,\n\s+title: escalation\.issue\.title,\n\s+body: escalation\.issue\.body,\n\s+target: 'platform',\n\s+source: 'agent',\n\s+\}\)/,
    'the same destination and source the helper route uses (routes/internal.js)');
  // Best effort: a failed draft never fails the turn.
  assert.match(call, /\.catch\(\(err\) => \{\n\s+log\.warn\('sessions', 'Platform-issue block draft failed'/);
  // A recovered headless turn still strips the markers from its timeline text.
  assert.match(SESSIONS, /testing\.cleanedText = platformIssueBlock\.extract\(\n\s+proposalDescription\.extract\(testing\.cleanedText\)\.cleanedText,\n\s+\)\.cleanedText;/);
});
