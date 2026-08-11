// #990: "Thinking about what came back..." — the step line that covers the
// silent window between a data-tool batch resolving and the model's reply
// starting to stream.
//
// The reporter watched an explore turn sit on "Fetching github.com..." for
// ~22s (of which at most ~10s could be fetching — web-fetch.js caps a fetch
// at FETCH_TIMEOUT_MS = 10_000) and then a reply appeared with no thinking
// cue in between. The cause was structural: phase 1 emitted a status BEFORE
// resolving the batch and nothing after, so the ladder's last live row kept
// spinning a stale label through the whole compose window.
//
// Guarded here:
//   1. The new status text is exported and non-empty.
//   2. It is emitted AFTER the batch's Promise.all resolves (so the client
//      freezes the fetch row with a truthful "(took Xs)") and BEFORE the
//      re-invocation it covers.
//   3. dataToolStatusLine's four pre-existing outputs are byte-identical —
//      the fix adds a rung to the ladder, it does not reword one.
//
// Run with: node --test tests/mayor-web-fetch-thinking-status.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  dataToolStatusLine,
  DATA_TOOL_THINKING_STATUS,
} = require('../src/routes/sessions.js');

const sessionsSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8'
);

// ── 1. The status text ──────────────────────────────────────────────────

test('#990: DATA_TOOL_THINKING_STATUS is exported and non-empty', () => {
  assert.equal(typeof DATA_TOOL_THINKING_STATUS, 'string');
  assert.ok(DATA_TOOL_THINKING_STATUS.trim().length > 0,
    'the thinking status line must carry text — an empty row is exactly the '
    + 'invisible state #990 is about');
  assert.equal(DATA_TOOL_THINKING_STATUS, 'Thinking about what came back...');
});

test('#990: the thinking status is distinct from every fetch-phase line', () => {
  // Same text would mean the client sees no new row, so it would never
  // freeze the fetch row or restart its elapsed ticker.
  const before = [
    dataToolStatusLine([{ name: 'web_fetch', input: { url: 'https://github.com/x' } }]),
    dataToolStatusLine([{ name: 'list_github_issues' }]),
    dataToolStatusLine([{ name: 'get_prod_status' }]),
    dataToolStatusLine([{ name: 'draft_issue_report' }]),
  ];
  for (const line of before) {
    assert.notEqual(line, DATA_TOOL_THINKING_STATUS);
  }
});

// ── 2. Emission point inside the phase-1 loop ───────────────────────────
//
// Ordering is the whole fix, so assert on positions rather than mere
// presence. The window is the phase-1 data-tool block: from the
// dataToolStatusLine call that opens the fetch step to the mayorConvo
// reassignment that feeds the results back to the model.

test('#990: the thinking status lands between the batch resolving and the re-invocation', () => {
  const openIdx = sessionsSrc.indexOf('await sendStatus(dataToolStatusLine(dataCalls));');
  assert.ok(openIdx > 0, 'phase-1 fetch-step status line not found');

  const convoIdx = sessionsSrc.indexOf('mayorConvo = [', openIdx);
  assert.ok(convoIdx > openIdx, 'phase-1 mayorConvo reassignment not found');

  const block = sessionsSrc.slice(openIdx, convoIdx);

  const awaitIdx = block.indexOf('const dataResults = await Promise.all(');
  assert.ok(awaitIdx > 0, 'phase-1 data-tool batch await not found');

  const thinkingIdx = block.indexOf('await sendStatus(DATA_TOOL_THINKING_STATUS);');
  assert.ok(thinkingIdx > 0,
    'phase 1 must emit DATA_TOOL_THINKING_STATUS before re-invoking the model');
  assert.ok(thinkingIdx > awaitIdx,
    'the thinking status must be emitted AFTER the batch resolves — emitting it '
    + 'first would leave the fetch row with a fake duration and put the dots up '
    + 'while the fetch is what is actually running');

  // And it is the LAST thing before the re-invocation: nothing else may
  // slip a status in after it, or the ladder would end on a stale rung again.
  assert.equal(
    block.indexOf('await sendStatus(', thinkingIdx + 1), -1,
    'no further status may be emitted between the thinking row and the re-invocation'
  );
});

test('#990: the emission is a persisted sendStatus, not a bare send()', () => {
  // sendStatus both streams the event AND inserts the system row, which is
  // what makes the rung survive a reload — the reporter's window is long
  // enough that a reload during it is realistic.
  assert.match(sessionsSrc, /await sendStatus\(DATA_TOOL_THINKING_STATUS\);/);
  assert.ok(
    !/send\('status',\s*\{[^}]*DATA_TOOL_THINKING_STATUS/.test(sessionsSrc),
    'the thinking row must not be emitted as an unpersisted status event'
  );
});

// ── 3. dataToolStatusLine is unchanged ──────────────────────────────────

test('#990: dataToolStatusLine keeps its four outputs byte-identical', () => {
  assert.equal(
    dataToolStatusLine([{ name: 'draft_issue_report', input: { title: 't' } }]),
    'Drafting an issue report...'
  );
  assert.equal(
    dataToolStatusLine([{ name: 'get_prod_status' }]),
    'Checking production status...'
  );
  assert.equal(
    dataToolStatusLine([{ name: 'web_fetch', input: { url: 'https://github.com/org/repo/pull/1' } }]),
    'Fetching github.com...'
  );
  assert.equal(
    dataToolStatusLine([{ name: 'web_fetch', input: { url: 'not a url' } }]),
    'Fetching a web page...'
  );
  assert.equal(
    dataToolStatusLine([{ name: 'list_github_issues' }]),
    "Reading the repo's GitHub issues..."
  );
  assert.equal(
    dataToolStatusLine([{ name: 'get_github_issue', input: { number: 990 } }]),
    "Reading the repo's GitHub issues..."
  );
  // Precedence, also unchanged: the draft names a mixed batch, then prod.
  assert.equal(
    dataToolStatusLine([
      { name: 'list_github_issues' },
      { name: 'draft_issue_report' },
    ]),
    'Drafting an issue report...'
  );
  assert.equal(
    dataToolStatusLine([
      { name: 'web_fetch', input: { url: 'https://example.com/' } },
      { name: 'get_prod_status' },
    ]),
    'Checking production status...'
  );
});
