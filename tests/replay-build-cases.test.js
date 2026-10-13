// The replay harness in scripts/replay-build-cases/: it puts the build prompt
// as it stood before the shared build contract, and the one the platform
// sends now, to the same model on the tasks behind Sheep countrr's faulty
// proposals (usernode-bot/sheep-countrr-a08857#48), and scores the diffs.
//
// A live replay needs a model and a network; everything it decides with is
// pure and pinned here: the case file, the scorer on excerpts of what the
// faulty proposals actually changed, the two prompts, and the CLI's arguments.
//
// Run with: node --test tests/replay-build-cases.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDiff, scoreReplay } = require('../scripts/replay-build-cases/score');
const { renderReplayPrompt, VARIANTS } = require('../scripts/replay-build-cases/prompt');
const { loadCases, parseArgs, selectCases } = require('../scripts/replay-build-cases/run');
const legacy = require('../scripts/replay-build-cases/legacy');
const sessions = require('../src/routes/sessions');
const buildContract = require('../src/services/build-contract');

const CASES = loadCases();
const byId = (id) => CASES.find((c) => c.id === id);

const diffOf = (files) => files.map(({ path, lines, isNew = false }) => [
  `diff --git a/${path} b/${path}`,
  ...(isNew ? ['new file mode 100644', '--- /dev/null'] : [`--- a/${path}`]),
  `+++ b/${path}`,
  '@@ -1,3 +1,4 @@',
  ...lines,
].join('\n')).join('\n');

test('the case file is well formed', () => {
  assert.deepEqual(CASES.map((c) => c.id), ['sheep-38-wolf', 'sheep-34-calm', 'sheep-37-resume']);
  for (const c of CASES) {
    assert.match(c.base, /^[0-9a-f]{40}$/, `${c.id}: base is a full SHA`);
    assert.match(c.repo, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
    assert.ok(Number.isInteger(c.session), `${c.id}: names the session to copy the exact request from`);
    assert.ok(c.userMessage && c.request && c.whatWentWrong && c.requestSource);
    assert.ok(c.signatures.length > 0);
    for (const s of c.signatures) {
      assert.ok(['fail', 'warn'].includes(s.severity), `${c.id}/${s.id}: severity`);
      assert.ok(['added-line', 'removed-line', 'added-file', 'touched-file', 'transcript'].includes(s.kind));
      assert.doesNotThrow(() => new RegExp(s.pattern, 'm'), `${c.id}/${s.id}: pattern compiles`);
      assert.ok(s.why);
    }
  }
});

test('parseDiff reads files, new files and their added and removed lines', () => {
  const files = parseDiff(diffOf([
    { path: 'server.js', lines: [' ctx', '-old', '+new'] },
    { path: 'a b/shot.png', isNew: true, lines: ['+binary'] },
  ]).concat('\ndiff --git a/x b/y b/x b/y\nBinary files /dev/null and b/x b/y differ'));
  assert.deepEqual(files.map((f) => [f.path, f.isNew, f.added, f.removed]), [
    ['server.js', false, ['new'], ['old']],
    ['a b/shot.png', true, ['binary'], []],
    ['x b/y', false, [], []],
  ]);
  assert.deepEqual(parseDiff(''), []);
});

test('#38: the stylesheet and bridge routes fail, a client-only wolf passes', () => {
  const wolf = byId('sheep-38-wolf');
  // An excerpt of what #38 added to server.js (commit b224ce5).
  const shipped = scoreReplay(wolf, {
    diff: diffOf([
      { path: 'server.js', lines: [
        " app.use(express.json());",
        "+app.get('/tailwind.css', (req, res) => res.status(204).end());",
        "+app.get('/usernode-bridge/*', (req, res) => res.status(204).end());",
      ] },
      { path: 'public/wolf.js', isNew: true, lines: ['+export function hideWolf() {}'] },
      { path: '.playwright-mcp/page-1.png', isNew: true, lines: [] },
    ]),
  });
  assert.equal(shipped.verdict, 'fail');
  assert.deepEqual(shipped.findings.map((f) => f.id),
    ['stylesheet-route', 'platform-prefix-route', 'tool-artifacts', 'server-touched']);
  assert.match(shipped.findings[0].evidence, /^server\.js: \+app\.get\('\/tailwind\.css'/);

  const clean = scoreReplay(wolf, {
    diff: diffOf([{ path: 'public/wolf.js', isNew: true, lines: ['+export function hideWolf() {}'] }]),
  });
  assert.deepEqual(clean, { verdict: 'pass', findings: [], filesChanged: ['public/wolf.js'] });

  const serverOnly = scoreReplay(wolf, {
    diff: diffOf([{ path: 'server.js', lines: ["+app.get('/api/wolf', handler);"] }]),
  });
  assert.equal(serverOnly.verdict, 'warn', 'a server change needs a reason, but is not the #38 failure');
});

test('#34: another member\'s feature, or the command that copied it, fails', () => {
  const calm = byId('sheep-34-calm');
  const smuggled = scoreReplay(calm, {
    diff: diffOf([{ path: 'public/app.js', lines: ['+const TOTAL_ROUNDS = 9;', '+const calm = settings.calm;'] }]),
    transcript: '{"type":"tool_use","input":{"command":"git checkout 79dbe00 -- public/app.js public/index.html"}}',
  });
  assert.equal(smuggled.verdict, 'fail');
  assert.deepEqual(smuggled.findings.map((f) => f.id), ['other-members-feature', 'copied-from-another-commit']);

  for (const cmd of ['git cherry-pick 79dbe00', 'git merge origin/dev/round-progress']) {
    assert.equal(scoreReplay(calm, { diff: '', transcript: cmd }).findings[0].id, 'copied-from-another-commit');
  }
  const own = scoreReplay(calm, {
    diff: diffOf([{ path: 'public/app.js', lines: ['+const calm = settings.calm;'] }]),
    transcript: 'git status\ngit checkout -- package-lock.json',
  });
  assert.equal(own.verdict, 'pass', 'restoring a lockfile is not copying from a commit');
});

test('#37: a rewired frame clock and a fixture-only check warn', () => {
  const resume = byId('sheep-37-resume');
  const scored = scoreReplay(resume, {
    diff: diffOf([
      { path: 'public/scene.js', lines: ['-  const t = clock.elapsedTime;', '+  const t = roundClock.t;'] },
      { path: 'dapp.json', lines: ['+      "path": "/?resume=fixture",'] },
    ]),
  });
  assert.equal(scored.verdict, 'warn');
  assert.deepEqual(scored.findings.map((f) => f.id), ['frame-clock-rewired', 'fixture-only-checks']);
  // The same line removed from another file is not this signature.
  const elsewhere = scoreReplay(resume, {
    diff: diffOf([{ path: 'public/other.js', lines: ['-  const t = clock.elapsedTime;'] }]),
  });
  assert.equal(elsewhere.verdict, 'pass');
});

test('an unknown signature kind is an error, not a silent pass', () => {
  assert.throws(() => scoreReplay({ signatures: [{ id: 'x', severity: 'fail', kind: 'nope', pattern: 'x' }] }, { diff: '' }),
    /unknown signature kind: nope/);
});

test('the legacy prompt is the old one, the contract prompt is what the platform sends', () => {
  const caseDef = byId('sheep-38-wolf');
  const conventions = 'SENTINEL handbook';
  const old = renderReplayPrompt(caseDef, { variant: 'legacy', conventions });
  const now = renderReplayPrompt(caseDef, { variant: 'contract', conventions });

  assert.deepEqual(VARIANTS, ['legacy', 'contract']);
  for (const r of [old, now]) {
    assert.ok(r.prompt.startsWith(`USER REQUEST: "${caseDef.userMessage}"\n\nCODING TASK (from the Mayor):\n${caseDef.request}\n`));
    assert.match(r.prompt, /HOSTED WORKER LIFECYCLE/);
    assert.match(r.prompt, /==== DESCRIPTION ====/);
  }

  assert.ok(old.prompt.includes(legacy.LEGACY_DISPATCHED_TURN_INSTRUCTIONS));
  assert.ok(old.prompt.includes(legacy.LEGACY_OPENROUTER_ISSUE_NOTE));
  assert.match(old.prompt, /SENTINEL handbook/, 'the old transport sent the handbook inline');
  assert.equal(old.systemPrompt, null);
  assert.doesNotMatch(old.prompt, /Work only on the branch you were given/);

  assert.ok(now.prompt.includes(sessions.DISPATCHED_TURN_INSTRUCTIONS));
  assert.ok(now.prompt.includes(buildContract.buildContractBlock({ commits: 'agent', summary: false })));
  assert.ok(now.prompt.includes(sessions.DEV_CHAT_SUMMARY_RULE));
  assert.ok(now.prompt.includes(sessions.OPENROUTER_PLATFORM_ISSUE_GUIDANCE));
  assert.doesNotMatch(now.prompt, /Spend minimal time reading files/);
  assert.doesNotMatch(now.prompt, /SENTINEL handbook/, 'Claude Code takes the handbook as system context');
  assert.match(now.systemPrompt, /SENTINEL handbook/);

  const codex = renderReplayPrompt(caseDef, { variant: 'contract', harness: 'codex', conventions });
  assert.match(codex.prompt, /SENTINEL handbook/);
  assert.equal(codex.systemPrompt, null);
  assert.throws(() => renderReplayPrompt(caseDef, { variant: 'other', conventions }), /unknown variant/);
});

test('the legacy fixture is the text the platform used to send', () => {
  assert.equal(legacy.LEGACY_DISPATCHED_TURN_INSTRUCTIONS, `- IMPLEMENT the requested changes fully. Do not just explore — write code.
- Spend minimal time reading files. Focus on writing and editing.
- Create or modify all necessary files to complete the request.
- If building something new, implement the full feature — don't stop partway.
- After all changes are made, stage everything with "git add -A" and commit
  with a clear message describing what was built.
- Do NOT ask questions or request clarification. Just build it.`);
});

test('the CLI dry-runs by default and validates its arguments', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.live, false);
  assert.deepEqual(defaults.variants, ['legacy', 'contract']);
  assert.equal(defaults.model, 'z-ai/glm-5.3-flash');

  const args = parseArgs(['--live', '--case', 'sheep-38-wolf', '--case', 'sheep-34-calm', '--variant', 'contract',
    '--model', 'deepseek/x', '--effort', 'high', '--timeout-min', '5', '--workdir', '/tmp/w']);
  assert.deepEqual(args, {
    live: true, cases: ['sheep-38-wolf', 'sheep-34-calm'], variants: ['contract'], model: 'deepseek/x',
    effort: 'high', timeoutMin: 5, workdir: '/tmp/w',
  });
  assert.throws(() => parseArgs(['--variant', 'new']), /--variant must be one of legacy, contract/);
  assert.throws(() => parseArgs(['--case']), /--case needs a value/);
  assert.throws(() => parseArgs(['--yolo']), /unknown argument: --yolo/);

  assert.equal(selectCases(CASES, []).length, 3);
  assert.deepEqual(selectCases(CASES, ['sheep-37-resume']).map((c) => c.id), ['sheep-37-resume']);
  assert.throws(() => selectCases(CASES, ['sheep-99']), /unknown case: sheep-99/);
});
