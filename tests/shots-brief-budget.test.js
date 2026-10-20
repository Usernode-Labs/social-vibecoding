'use strict';

// The shots brief's size budget (shots-orchestrator.js fitBrief). Claude
// Code saves an MCP result over about 50,000 characters to a file and shows
// the model a 2,000-character preview, and a shots turn cannot read files: a
// 55 KB brief left proposal 10613's agent with no shots. A realistic large
// proposal's brief, built by the real shotsBrief(), must come out within the
// budget with everything the agent acts on whole, and the reference lists
// cut best first, each saying so.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const contract = require('../src/services/visible-changes');
const orchestrator = require('../src/services/shots-orchestrator');
const fixtures = require('./fixtures/shots');

// Claude Code's save-to-file limit for an MCP result, as the 10613 run met it.
const SAVED_TO_FILE_OVER = 50_000;

function story(index, steps = 6) {
  return {
    id: `change-${index}`,
    claim: `The workshop's ${index === 0 ? 'Needs you' : 'proposal'} list now shows who is waiting and why, `
      + 'with the vote count beside each row and a quieter done state. '.repeat(3).trim(),
    persona: index === 2 ? 'read_only_admin' : 'member',
    viewports: [{ name: 'desktop', width: 1280, height: 800 }, { name: 'phone', width: 390, height: 844 }],
    intent: {
      startPath: `/#app/usernode-2d5619/dev/needs?story=${index}`,
      steps: Array.from({ length: steps }, (_, step) =>
        `Step ${step + 1}: open the row "Rename the weekly digest" and press "Vote" in the sheet that opens below it ${'.'.repeat(80)}`.slice(0, 200)),
      checkpoint: 'The Needs you list shows the new waiting line under each row and the vote count beside it',
      focus: 'Needs you list',
      animation: 'steps',
      hints: {
        setup: 'Open a proposal as the member first so the list has a row that waits on you.',
        expectText: ['Waiting on you', '3 to vote'],
        focusTarget: { by: 'css', value: '#workshop-needs-list .needs-row' },
      },
    },
  };
}

const serverFiles = Array.from({ length: 120 }, (_, index) => `src/services/needs-you/rows/needs-row-${index}.js`);
const screenFiles = Array.from({ length: 120 }, (_, index) =>
  `frontend/src/features/dev-board/workshop/needs-you/rows/needs-row-${index}.tsx`);

function largeBrief(t, { stories = [0, 1, 2].map((index) => story(index)), declaredChecks = null } = {}) {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-brief-budget-'));
  t.after(() => fs.rmSync(checkout, { recursive: true, force: true }));
  const tests = Array.from({ length: 120 }, (_, index) => ({
    id: `workshop-needs-${index}`,
    name: `#${4000 + index} Workshop needs you row ${index} shows the waiting line, the vote count and the done state on a phone`,
    path: `/?demo=1&ws=needs&row=${index}#app/usernode-2d5619/dev/proposals/${10000 + index}/checks/needs-you-${index}`,
    expectSelector: `#workshop-needs-list > .needs-row[data-row="${index}"] .needs-row-meta .needs-row-count`,
  }));
  fs.writeFileSync(path.join(checkout, 'dapp.json'), JSON.stringify({ tests }));
  const intent = contract.parseIntent(fixtures.intent({ stories }));
  const diff = Array.from({ length: 200 }, (_, line) =>
    `+    const label = t("workshop:needs.row.waiting", { count: ${line} }); // "quoted" \\ ${line}\n`).join('').slice(0, 8_000);
  const session = {
    pr_title: 'Needs you: say who is waiting and why',
    spec_md: `# Needs you\n\n${'The list says who waits on you and why, with the count beside each row. '.repeat(80)}`,
    testing_md: `1. Open the Workshop.\n${'2. Open Needs you and read each row. '.repeat(80)}`,
    testing_path: '/#app/usernode-2d5619/dev/needs',
  };
  const brief = orchestrator.shotsBrief({
    run: { id: '1'.repeat(32) },
    session,
    revision: {
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
      files: [...serverFiles, ...screenFiles],
      filesComplete: true,
      diffSummary: { text: diff, fileCount: 240, truncated: false },
    },
    pair: { sides: { head: { checkout } } },
    deployment: {
      origins: { base: 'http://base.internal', head: 'http://head.internal' },
      availableFixtures: [{ id: 'member-session', persona: 'member', path: '/#messages/agent/9' }],
    },
    intent,
    ...(declaredChecks ? { declaredChecks } : {}),
  });
  const ranked = orchestrator.declaredCheckSummary(checkout, intent, [session.testing_path]);
  return { brief, intent, session, diff, ranked };
}

test('a large proposal\'s brief stays within the budget, the declared changes whole and the lists cut best first', (t) => {
  const { brief, intent, session, diff, ranked } = largeBrief(t);
  // What the brief would have been without the budget: over the limit
  // Claude Code saves to a file.
  const unbudgeted = {
    ...brief,
    declaredChecks: ranked,
    changedFiles: { ...brief.changedFiles, items: [...screenFiles, ...serverFiles].slice(0, 200) },
    changeContext: { ...brief.changeContext, diff: { ...brief.changeContext.diff, text: diff } },
  };
  assert.ok(JSON.stringify(unbudgeted).length > SAVED_TO_FILE_OVER,
    `unbudgeted, this brief is ${JSON.stringify(unbudgeted).length} characters`);

  const length = JSON.stringify(brief).length;
  assert.ok(length <= orchestrator.BRIEF_BUDGET, `the brief is ${length} characters`);
  assert.ok(orchestrator.BRIEF_BUDGET < SAVED_TO_FILE_OVER);

  // Everything the agent acts on, whole.
  assert.deepEqual(brief.declaredChanges, intent.stories);
  assert.equal(brief.changeContext.specification, session.spec_md.trim().slice(0, 4_000));
  assert.equal(brief.changeContext.testingSteps, session.testing_md.trim().slice(0, 2_000));
  assert.ok(brief.browsers.member && brief.addresses.before && brief.screenBrowsers);

  // The checks: the best-ranked first, and how many were left out.
  assert.ok(brief.declaredChecks.length > 0);
  assert.deepEqual(brief.declaredChecks, ranked.slice(0, brief.declaredChecks.length));
  assert.equal(brief.declaredChecksLeftOut, ranked.length - brief.declaredChecks.length);
  assert.ok(brief.declaredChecks.every((check) => !('testedAs' in check)));

  // The files: the screens' own first, and the list says it is not complete.
  assert.ok(brief.changedFiles.items.length > 0);
  assert.deepEqual(brief.changedFiles.items, screenFiles.slice(0, brief.changedFiles.items.length));
  assert.equal(brief.changedFiles.complete, false);
  assert.equal(brief.changedFiles.totalKnown, 240);

  // The diff: its start, marked truncated.
  assert.ok(brief.changeContext.diff.text.length > 0);
  assert.ok(diff.startsWith(brief.changeContext.diff.text));
  assert.equal(brief.changeContext.diff.truncated, true);
});

test('declared changes that alone fill the budget stay whole, and the brief stays under the save-to-file limit', (t) => {
  const { brief, intent } = largeBrief(t, { stories: [0, 1, 2].map((index) => story(index, 40)) });
  assert.deepEqual(brief.declaredChanges, intent.stories);
  const length = JSON.stringify(brief).length;
  assert.ok(length < SAVED_TO_FILE_OVER - 5_000, `the brief is ${length} characters`);
  assert.equal(brief.declaredChecks.length, 0);
  assert.ok(brief.declaredChecksLeftOut > 0);
});

test('a small brief is left whole, and the ranked checks passed in are not changed', (t) => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-brief-small-'));
  t.after(() => fs.rmSync(checkout, { recursive: true, force: true }));
  fs.writeFileSync(path.join(checkout, 'dapp.json'), JSON.stringify({ tests: [{ name: 'Home', path: '/' }] }));
  const brief = orchestrator.shotsBrief({
    run: { id: '1'.repeat(32) },
    session: { pr_title: 'Small' },
    revision: {
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), files: ['public/js/app.js'], filesComplete: true,
      diffSummary: { text: 'diff --git a/public/js/app.js', fileCount: 1, truncated: false },
    },
    pair: { sides: { head: { checkout } } },
    deployment: { origins: { base: 'http://base.internal', head: 'http://head.internal' } },
    intent: contract.parseIntent(fixtures.intent()),
  });
  assert.deepEqual(brief.declaredChecks, [{ name: 'Home', path: '/' }]);
  assert.equal('declaredChecksLeftOut' in brief, false);
  assert.deepEqual(brief.changedFiles, { items: ['public/js/app.js'], complete: true, totalKnown: 1 });
  assert.deepEqual(brief.changeContext.diff, { text: 'diff --git a/public/js/app.js', fileCount: 1, truncated: false });

  // The run ranks once and hands the list in: the brief trims its own copy,
  // and the diagnostics keep every ranked check.
  const { ranked } = largeBrief(t);
  const handed = structuredClone(ranked);
  const { brief: trimmed } = largeBrief(t, { declaredChecks: handed });
  assert.ok(trimmed.declaredChecks.length < handed.length);
  assert.deepEqual(handed, ranked);
});
