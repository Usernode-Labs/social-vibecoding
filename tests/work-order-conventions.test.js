// The offline conventions appendix carried inside a connector work order.
//
// Every Usernode app's notes tell a coding agent to fetch the platform
// conventions from the Usernode site at the start of a session. A hosted
// agent's container BLOCKS that host, so it never reads them — and then
// reasons its way to the very things the document forbids. The observed run
// came within one decision of vendoring the three centrally hosted assets
// into an app repo to "fix" the styling, which two automated checks reject.
//
// So the work order carries a compact excerpt with it. These tests pin the
// two properties that make that safe:
//
//   1. The excerpt is a REGION OF app-conventions.md, not a copy. A copy
//      would drift, and drifted platform rules are worse than none.
//   2. It EXCLUDES "Don't `git push` yourself" — a section addressed to
//      Usernode's own credential-less build worker. Pasted at an agent
//      pushing to the user's own fork, it forbids the required step.
//
// Run with: node --test tests/work-order-conventions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const prompts = require('../src/services/prompts');
const svc = require('../src/services/external-agent-tasks');

const CONVENTIONS = fs.readFileSync(
  path.join(__dirname, '../src/prompts/app-conventions.md'), 'utf8'
);

// The excerpt has to survive a host model that may truncate the work order,
// and it is background guidance — generous, but not unbounded.
const MAX_ESSENTIALS_BYTES = 6 * 1024;

test('the work-order markers exist in app-conventions.md, exactly once each', () => {
  const begins = CONVENTIONS.split(prompts.WORK_ORDER_BEGIN).length - 1;
  const ends = CONVENTIONS.split(prompts.WORK_ORDER_END).length - 1;
  assert.equal(begins, 1, 'one begin marker');
  assert.equal(ends, 1, 'one end marker');
  assert.ok(
    CONVENTIONS.indexOf(prompts.WORK_ORDER_BEGIN) < CONVENTIONS.indexOf(prompts.WORK_ORDER_END),
    'and they are the right way round'
  );
});

test('the extracted region is non-empty, bounded, and really a slice of the document', () => {
  const essentials = prompts.getWorkOrderEssentials();
  assert.ok(essentials.length > 500, 'there is actually guidance in there');
  assert.ok(
    Buffer.byteLength(essentials, 'utf8') < MAX_ESSENTIALS_BYTES,
    `the excerpt is ${Buffer.byteLength(essentials, 'utf8')} bytes, over the ${MAX_ESSENTIALS_BYTES} bound`
  );
  // One source of truth: editing the conventions edits the excerpt. A
  // second copy of these rules would drift silently.
  assert.ok(CONVENTIONS.includes(essentials), 'the excerpt is a verbatim slice, never a copy');
  assert.ok(!essentials.includes(prompts.WORK_ORDER_BEGIN));
  assert.ok(!essentials.includes(prompts.WORK_ORDER_END));
});

test('the excerpt covers what an offline agent gets wrong, in priority order', () => {
  const essentials = prompts.getWorkOrderEssentials();
  // Ranked by how badly it goes wrong, so a truncation loses the least.
  assert.match(essentials, /centrally hosted/i);
  assert.match(essentials, /never vendor/i);
  assert.match(essentials, /cdn/i);
  assert.match(essentials, /USERNODE_ENV/);
  assert.match(essentials, /IS_STAGING/);
  assert.match(essentials, /seed/i);
  assert.match(essentials, /staging:private/);
  assert.match(essentials, /dapp\.json/);
  assert.match(essentials, /checks GATE MERGE|Checks GATE MERGE/i);
  assert.match(essentials, /RS256/);
  assert.match(essentials, /USERNODE_JWT_PUBLIC_KEY/);
  assert.match(essentials, /LLM proxy|USERNODE_LLM_PROXY_URL/);
  assert.match(essentials, /SIGTERM/);
});

test('the excerpt does NOT forbid the one thing the agent has to do', () => {
  const essentials = prompts.getWorkOrderEssentials();

  // "Don't `git push` yourself" addresses Usernode's own build worker,
  // which runs with no GitHub credentials at all. A fork-pushing agent that
  // reads it as its own instruction stops dead on the required step — so
  // the SECTION is excluded from the excerpt.
  assert.match(CONVENTIONS, /## Don't `git push` yourself/, 'the full document still has it');
  assert.doesNotMatch(essentials, /## Don't `git push` yourself/, 'but the excerpt does not carry the section');
  // None of its prohibition text comes across either.
  assert.doesNotMatch(essentials, /just commit .* and stop/i);
  assert.doesNotMatch(essentials, /zero GitHub credentials in env/i);
  assert.doesNotMatch(essentials, /the harness handles the push for you/i);

  // The one mention that IS allowed: naming the section in order to
  // NEUTRALISE it, for an agent that has seen the full document elsewhere.
  // The mention and the neutralisation have to travel together.
  const mention = essentials.indexOf("Don't `git push` yourself");
  assert.ok(mention > 0, 'the excerpt names the section explicitly');
  assert.match(essentials.slice(mention), /does not apply to a\s+coding agent working in the user's own fork/);
  assert.match(essentials.slice(mention), /pushing your branch is\s+exactly what you are being asked to do/);
  assert.match(essentials.slice(mention), /build\s+worker/);
});

test('a missing marker degrades to an empty appendix rather than throwing', () => {
  // The appendix is background guidance. Losing it must never cost the
  // base commit, the push commands or the task id — so nothing in this
  // path is allowed to throw.
  assert.equal(svc.buildWorkOrder({
    appName: 'A', appSlug: 'a', upstreamUrl: 'u', upstreamSlug: 'o/a', forkUrl: 'f',
    forkCloneUrl: 'f.git', forkRepo: 'a', forkPageUrl: 'p', forkStatus: 'ready',
    branch: 'b', baseSha: 's', brief: 'x', platformRules: '',
  }).includes('PLATFORM RULES'), false);
});

test('the work order names all three hosted assets and the full document URL', () => {
  const order = svc.buildWorkOrder({
    appName: 'Recipe Box', appSlug: 'recipe-box',
    upstreamUrl: 'https://github.com/usernode-bot/recipe-box',
    upstreamSlug: 'usernode-bot/recipe-box',
    forkUrl: 'https://github.com/someuser/recipe-box',
    forkCloneUrl: 'https://github.com/someuser/recipe-box.git',
    forkRepo: 'recipe-box',
    forkPageUrl: 'https://github.com/usernode-bot/recipe-box/fork',
    forkStatus: 'ready',
    branch: 'usernode/recipe-box-issue-4-abc123',
    baseSha: `ba5e${'0'.repeat(34)}fe`,
    brief: 'x',
    webPath: 'https://usernode.example/#app/recipe-box',
    taskId: 31,
    platformRules: prompts.getWorkOrderEssentials(),
  });

  // The three files whose absence made the app render unstyled in a
  // sandbox browser and one declared check fail.
  assert.equal(svc.HOSTED_ASSETS.length, 3);
  for (const url of svc.HOSTED_ASSETS) {
    assert.ok(order.includes(url), `the work order names ${url}`);
    assert.match(url, /^https:\/\/social-vibecoding\.usernodelabs\.org\//);
  }
  assert.ok(svc.HOSTED_ASSETS.some((u) => u.includes('usernode-bridge')));
  assert.ok(svc.HOSTED_ASSETS.some((u) => u.includes('usernode-native')));
  assert.ok(svc.HOSTED_ASSETS.some((u) => u.includes('usernode-tailwind')));

  // The diagnosis, so a less careful agent does not "fix" the sandbox.
  assert.match(order, /may not be able to reach that host/);
  assert.match(order, /rejected by two of the app's own automated/);
  assert.match(order, /staging preview Usernode builds/);

  // And a pointer to the always-current full document, derived from the
  // deployment's own origin rather than hardcoded.
  assert.match(order, /https:\/\/usernode\.example\/claude\.md/);

  // The appendix is genuinely appended, not merged into the instructions.
  assert.ok(order.indexOf('PLATFORM RULES') > order.indexOf('WHEN YOU ARE DONE'));
});

test('the excerpt survives round-tripping through the work order intact', () => {
  // A rule that arrives mangled is worse than one that does not arrive:
  // the appendix is pasted verbatim, so it must not be re-wrapped.
  const essentials = prompts.getWorkOrderEssentials();
  const order = svc.buildWorkOrder({
    appName: 'A', appSlug: 'a', upstreamUrl: 'u', upstreamSlug: 'o/a', forkUrl: 'f',
    forkCloneUrl: 'f.git', forkRepo: 'a', forkPageUrl: 'p', forkStatus: 'ready',
    branch: 'b', baseSha: 's', brief: 'x', platformRules: essentials,
  });
  assert.ok(order.includes(essentials));
  // And it brings no fence with it — the host wraps the whole work order in
  // one, and a nested fence closes it early.
  assert.ok(!essentials.includes('```'), 'the excerpt carries no triple-backtick fence');
  assert.ok(!order.includes('```'));
});
