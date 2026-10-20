'use strict';

// The shots agent's brief in answers it can read whole (worker/shots-brief.js).
// Claude Code saves an MCP result over about 50,000 characters to a file and
// shows a 2,000-character preview, and a shots turn cannot read files: a
// 55 KB brief left proposal 10613's agent with no shots. A realistic large
// brief, built by the real shotsBrief(), must reach the agent in answers
// under the limit, and those answers together must be the whole brief.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const contract = require('../src/services/visible-changes');
const orchestrator = require('../src/services/shots-orchestrator');
const fixtures = require('./fixtures/shots');
const { ANSWER_LIMIT, PART_NAMES, briefAnswer } = require('../worker/shots-brief');

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

function largeBrief(t, { stories = [0, 1, 2].map((index) => story(index)) } = {}) {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-brief-'));
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
  const brief = orchestrator.shotsBrief({
    run: { id: '1'.repeat(32) },
    session: {
      pr_title: 'Needs you: say who is waiting and why',
      spec_md: `# Needs you\n\n${'The list says who waits on you and why, with the count beside each row. '.repeat(80)}`,
      testing_md: `1. Open the Workshop.\n${'2. Open Needs you and read each row. '.repeat(80)}`,
      testing_path: '/#app/usernode-2d5619/dev/needs',
    },
    revision: {
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
      files: Array.from({ length: 240 }, (_, index) =>
        `frontend/src/features/dev-board/workshop/needs-you/rows/needs-row-${index}.tsx`),
      filesComplete: true,
      diffSummary: { text: diff, fileCount: 240, truncated: true },
    },
    pair: { sides: { head: { checkout } } },
    deployment: {
      origins: { base: 'http://base.internal', head: 'http://head.internal' },
      availableFixtures: [{ id: 'member-session', persona: 'member', path: '/#messages/agent/9' }],
    },
    intent,
  });
  return { ...brief, eligibleHostedAppSlugs: ['hosted-app'] };
}

// Every answer get_brief can give for this brief, and the brief put back
// together from them.
function readAll(brief) {
  const core = briefAnswer(brief);
  const answers = [core];
  const rebuilt = structuredClone(core);
  delete rebuilt.moreParts;
  delete rebuilt.readingParts;
  const setAt = (object, keys, value) => {
    let node = object;
    for (const key of keys.slice(0, -1)) node = node[key] ??= {};
    node[keys.at(-1)] = value;
  };
  const paths = {
    declaredChecks: ['declaredChecks'], diff: ['changeContext', 'diff', 'text'],
    changedFiles: ['changedFiles', 'items'], specification: ['changeContext', 'specification'],
    testingSteps: ['changeContext', 'testingSteps'], availableFixtures: ['availableFixtures'],
    declaredChanges: ['declaredChanges'],
  };
  for (const { part, pages } of core.moreParts || []) {
    let items = [];
    let text = '';
    for (let page = 1; page <= pages; page += 1) {
      const answer = briefAnswer(brief, { part, page });
      assert.equal(answer.pages, pages);
      answers.push(answer);
      if (answer.items) items = items.concat(answer.items);
      else text += answer.text;
    }
    const first = answers.find((answer) => answer.part === part);
    setAt(rebuilt, paths[part], first.items ? items : text);
  }
  return { core, answers, rebuilt };
}

const sortedKeys = (value) => JSON.parse(JSON.stringify(value, (key, inner) =>
  (inner && typeof inner === 'object' && !Array.isArray(inner)
    ? Object.fromEntries(Object.keys(inner).sort().map((name) => [name, inner[name]])) : inner)));

test('a large brief reaches the agent in answers under the limit, and together they are the whole brief', (t) => {
  const brief = largeBrief(t);
  assert.equal(brief.declaredChecks.length, 80);
  assert.equal(brief.changedFiles.items.length, 200);
  assert.ok(JSON.stringify(brief).length > SAVED_TO_FILE_OVER,
    `the whole brief is ${JSON.stringify(brief).length} characters, over the save-to-file limit`);

  const { core, answers, rebuilt } = readAll(brief);
  for (const answer of answers) {
    assert.ok(JSON.stringify(answer).length <= ANSWER_LIMIT,
      `${answer.part || 'core'} page ${answer.page || 1} is ${JSON.stringify(answer).length} characters`);
  }
  assert.ok(ANSWER_LIMIT < SAVED_TO_FILE_OVER);
  // The declared changes come first, whole, then the list of the rest.
  assert.deepEqual(Object.keys(core).slice(0, 2), ['declaredChanges', 'moreParts']);
  assert.deepEqual(core.declaredChanges, brief.declaredChanges);
  assert.deepEqual(core.moreParts.map(({ part }) => part), ['declaredChecks', 'diff', 'changedFiles']);
  assert.ok(core.moreParts.every(({ pages, about }) => pages >= 1 && about));
  assert.equal(core.changeContext.specification, brief.changeContext.specification);
  assert.deepEqual(sortedKeys(rebuilt), sortedKeys(brief));
});

test('a brief whose declared changes alone are long still fits, with the declared changes as a part', (t) => {
  const brief = largeBrief(t, { stories: [0, 1, 2].map((index) => story(index, 40)) });
  const { core, answers, rebuilt } = readAll(brief);
  for (const answer of answers) assert.ok(JSON.stringify(answer).length <= ANSWER_LIMIT);
  const moved = core.moreParts.map(({ part }) => part);
  assert.ok(moved.includes('declaredChanges'));
  assert.equal('declaredChanges' in core, false);
  // Less important text left the core before the declared changes did.
  assert.ok(moved.indexOf('specification') < moved.indexOf('declaredChanges'));
  assert.deepEqual(sortedKeys(rebuilt), sortedKeys(brief));
});

test('a small brief is its core alone, and asking for a part it does not have is refused', () => {
  const brief = {
    declaredChanges: [story(0, 1)], origins: { base: 'http://base', head: 'http://head' },
    changedFiles: { items: [], complete: true, totalKnown: 0 }, declaredChecks: [],
  };
  assert.deepEqual(briefAnswer(brief), brief);
  assert.throws(() => briefAnswer(brief, { part: 'declaredChecks' }), { code: 'unknown_part' });
  const withChecks = { ...brief, declaredChecks: [{ name: 'Home', path: '/' }] };
  assert.deepEqual(briefAnswer(withChecks, { part: 'declaredChecks' }),
    { part: 'declaredChecks', page: 1, pages: 1, items: [{ name: 'Home', path: '/' }] });
  assert.throws(() => briefAnswer(withChecks, { part: 'declaredChecks', page: 2 }), { code: 'unknown_page' });
  assert.deepEqual(PART_NAMES, ['declaredChecks', 'diff', 'changedFiles', 'specification',
    'testingSteps', 'availableFixtures', 'declaredChanges']);
});
