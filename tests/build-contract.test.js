// The build contract (src/services/build-contract.js): the one set of rules
// every on-platform coding turn that may change an app's code works under.
//
// Pins three things:
//   1. The rules that came from the Homeroom bot's shadow builds keep their
//      exact text (tests/homeroom-bot-question-bar.test.js pins them in the
//      bot's prompt too), and the rules added from Sheep countrr's faulty
//      proposals (usernode-bot/sheep-countrr-a08857#48) say what they must.
//   2. Both callers use it: the bot's buildPrompt, and the dev chat's build
//      INSTRUCTIONS, which no longer carry the platform's first prompt.
//   3. The two commit modes differ only in the commit line.
//
// Run with: node --test tests/build-contract.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const buildContract = require('../src/services/build-contract');
const sessions = require('../src/routes/sessions');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the bot-derived rules keep their exact text', () => {
  const block = buildContract.buildContractBlock();
  for (const line of [
    "- Read the repository's own agent instructions (AGENTS.md, CLAUDE.md) first, and follow them.",
    '- Keep the change as small as the request needs. Do not refactor or tidy unrelated code.',
    '- Run the tests that cover what you changed, if the repository has them.',
    '- Do not change a lockfile (package-lock.json, yarn.lock, pnpm-lock.yaml and the like) unless the change',
    '- A test or check you add must fail without your change: assert what the change makes true, not only that',
    '  the page loads. Where you can run it, run it against the code as it was before your edit and see it fail.',
    '- Do not loosen, skip, delete or rewrite an existing test or check to make it pass. Change one only where',
    '- A database query you add or change must run in a test against a real database, where the repository has',
    '- Do not add reports, notes or other documents to the repository unless the spec asks for that file.',
    '- If the request reports a bug, find where in the code it happens before changing anything. If you cannot',
    '- If you find you cannot make the change safely, stop and say why instead of changing code.',
  ]) {
    assert.ok(block.split('\n').includes(line), `missing verbatim line: ${line}`);
  }
});

test('the rules Sheep countrr showed were missing are present', () => {
  const block = buildContract.buildContractBlock();
  // #38: 204 for the app's own compiled stylesheet, from an agent that never
  // read the Dockerfile, to quiet a sandbox error.
  assert.match(block, /read how the code you are changing is used/);
  assert.match(block, /package\.json scripts and Dockerfile\)\. Do not assume a file or path is\n\s+served by the platform: check\./);
  assert.match(block, /is not yours to fix in this change unless your change caused it/);
  assert.match(block, /Never silence an error or empty a response to make a check pass\./);
  // #34: `git checkout <another member's commit> -- …`.
  // A request that names one (build on a proposal) is the user's choice.
  assert.match(block, /Never check out, cherry-pick, merge or copy files from another\n\s+branch or commit the request does not name/);
  assert.match(block, /other `dev\/\*` branches are other people's unfinished work/);
  assert.match(block, /If your edits seem to have gone missing, stop and say so\./);
  // #37: the frame loop every round runs on, rewired and frozen; checks
  // that loaded frozen fixtures.
  assert.match(block, /main loop, shared state, routing, server setup or\n\s+startup\), exercise the app's existing main flow afterwards/);
  assert.match(block, /`\?scene=` route\) does not test\n\s+your feature: at least one check must run the real code path/);
});

test('rules are ordered: understand, scope, prove, hand off', () => {
  const block = buildContract.buildContractBlock();
  const at = (re) => {
    const i = block.search(re);
    assert.notEqual(i, -1, `missing ${re}`);
    return i;
  };
  const order = [
    /Read the repository's own agent instructions/,
    /Before you edit, read how the code/,
    /Keep the change as small/,
    /A problem the request does not ask about/,
    /Work only on the branch you were given/,
    /Run the tests that cover/,
    /exercise the app's existing main flow/,
    /Browser features that need a user gesture/,
    /Do not change a lockfile/,
    /A test or check you add must fail/,
    /does not test\n\s+your feature/,
    /Do not loosen, skip, delete/,
    /A database query you add/,
    /Do not add reports/,
    /If the request reports a bug/,
    /Commit on the session branch/,
    /If you find you cannot make the change safely/,
  ].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(block.split('\n').every((l) => l.length <= 110), 'lines stay pre-wrapped');
});

test('the commit modes differ only in who commits', () => {
  const agent = buildContract.buildContractBlock({ commits: 'agent' });
  const harness = buildContract.buildContractBlock({ commits: 'harness' });
  assert.equal(
    agent.replace(buildContract.RULES.agentCommits, '<COMMIT>'),
    harness.replace(buildContract.RULES.harnessCommits, '<COMMIT>'),
  );
  assert.match(agent, /Commit only the files you changed\n\s+for this request: check `git status` first/);
  assert.doesNotMatch(agent, /git add -A/, 'the agent never stages everything blind');
  assert.match(harness, /Do not commit or push yourself/);
  assert.doesNotMatch(harness, /Commit on the session branch/);
  assert.throws(() => buildContract.buildContractBlock({ commits: 'nobody' }), /unknown commits mode/);
});

test('the heading and closing summary are the caller\'s', () => {
  const bot = buildContract.buildContractBlock({ heading: 'Make exactly that change, and nothing else:' });
  assert.ok(bot.startsWith('Make exactly that change, and nothing else:\n- Read'));
  assert.ok(bot.endsWith(buildContract.SUMMARY_LINE));
  assert.match(buildContract.SUMMARY_LINE, /^End with a short, plain-language summary of what you changed/);
  assert.match(buildContract.SUMMARY_LINE, /list each file you changed with one\nline on why, and anything you noticed but left alone\./);
  const devChat = buildContract.buildContractBlock({ summary: false });
  assert.ok(devChat.startsWith('When you change files, work under these rules:\n'));
  assert.ok(!devChat.includes(buildContract.SUMMARY_LINE));
});

test('the Homeroom bot builds from the contract', () => {
  const src = read('src/services/homeroom-bot-live.js');
  assert.match(src, /const buildContract = require\('\.\/build-contract'\);/);
  assert.match(src, /buildContract\.buildContractBlock\(\{\s*heading: 'Make exactly that change, and nothing else:',\s*commits: 'harness',\s*\}\)/);
  // No second copy of a rule left behind in the bot.
  assert.doesNotMatch(src, /'- Keep the change as small as the request needs\./);
  assert.doesNotMatch(src, /'- Do not commit or push yourself/);
});

test('a dev chat build carries the contract, and the first prompt is gone', () => {
  const src = read('src/routes/sessions.js');
  assert.match(src, /const buildContractBlock = `\$\{buildContract\.buildContractBlock\(\{ commits: 'agent', summary: false \}\)\}\n\$\{DEV_CHAT_SUMMARY_RULE\}`;/);
  assert.match(src, /INSTRUCTIONS:\n\$\{workflowGuidance\}\n\$\{turnInstructions\}\n\$\{buildContractBlock\}\n\$\{guidance\.browserGuidance\}/);
  assert.match(src, /\n {4}: DISPATCHED_TURN_INSTRUCTIONS;/);
  // The first prompt's lines survive only in comments and the replay fixture.
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /Spend minimal time reading files/);
  assert.doesNotMatch(code, /Just build it\./);
  assert.doesNotMatch(code, /stage everything with "git add -A"/);

  const dispatched = sessions.DISPATCHED_TURN_INSTRUCTIONS;
  assert.match(dispatched, /IMPLEMENT the requested change fully/);
  assert.match(dispatched, /do not ask questions/);
  assert.match(dispatched, /choose the reading that changes the least existing behaviour, and say which you chose/);
  assert.match(sessions.DEV_CHAT_SUMMARY_RULE, /before any block it ends with/);
  assert.match(sessions.DEV_CHAT_SUMMARY_RULE, /name anything you noticed but left alone/);
});

test('#3426: a feature that needs a user gesture is started in a tap handler', () => {
  // gym-tracker #42: the end-of-rest beep created its AudioContext from the
  // 1 Hz timer, which phones keep silent.
  assert.equal(buildContract.RULES.userGesture, [
    '- Browser features that need a user gesture (sound through an AudioContext, notification permission,',
    '  clipboard, fullscreen) must be started or unlocked inside a tap or click handler. Started later, from a',
    '  timer or a render, phones refuse them or keep them silent.',
  ].join('\n'));
  for (const commits of ['agent', 'harness']) {
    assert.ok(buildContract.buildContractBlock({ commits }).includes(buildContract.RULES.userGesture));
  }
});
