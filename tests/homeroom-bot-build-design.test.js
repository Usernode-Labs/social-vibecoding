// #3737: the Homeroom bot's build writes every first version, and it was the
// one build on the platform given neither the UI design guidance (#2817)
// nor the in-loop browser's instructions. These pin what it reads now:
//
//   - the same design guidance the dev chat builds with, its self-check
//     chosen by whether the build's model reads images (OpenRouter's
//     catalog, read as the Mayor reads it);
//   - the dev chat's in-loop browser block, and one rule of the bot's own:
//     a change a person will see is looked at, in both looks, before the
//     turn ends;
//   - for a project's first version, a design brief of its own in the
//     triage note and the spec, and a `Design:` note the build records in
//     the app's CLAUDE.md for every later change to follow.
//
// Run with: node --test tests/homeroom-bot-build-design.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const prompts = require('../src/services/prompts');
const { IN_LOOP_BROWSER_GUIDANCE } = require('../src/services/in-loop-browser');
const credentialStore = require('../src/services/credential-store');
const agentModels = require('../src/services/agent-models');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SPEC = '# Title\n\n## User-facing changes\n\nx\n\n## Technical implementation\n\ny';

// ── The build prompt ─────────────────────────────────────────────────────

test('the build carries the design guidance, its self-check by whether the model reads images', () => {
  for (const spec of [null, SPEC]) {
    const images = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', spec, readsImages: true });
    assert.ok(images.includes(prompts.getDesignGuidance({ readsImages: true })), 'the image self-check, whole');
    const text = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', spec, readsImages: false });
    assert.ok(text.includes(prompts.getDesignGuidance({ readsImages: false })), 'the text self-check, whole');
    assert.ok(!text.includes(prompts.getDesignGuidance({ readsImages: true })));
    // Unknown is text: a model is never told to look at what it cannot see.
    assert.equal(live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', spec }), text);
    for (const p of [images, text]) {
      assert.ok(p.indexOf('Do not commit or push yourself') < p.indexOf('==== UI DESIGN'), 'after the build contract');
      assert.ok(p.indexOf('==== END UI DESIGN ====') < p.indexOf('==== DESCRIPTION ===='), 'before the summary block');
    }
  }
});

test('the build carries the dev chat\'s in-loop browser block and the bot\'s expected visual check', () => {
  const images = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', readsImages: true });
  const text = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', readsImages: false });
  for (const p of [images, text]) {
    assert.ok(p.includes(IN_LOOP_BROWSER_GUIDANCE), 'the block the dev chat gives an OpenRouter turn, as written');
    assert.match(p, /For you, "commit" in it means finishing your turn,\nsince your working tree is committed for you/,
      'its "commit" is the harness\'s here: the contract says not to commit');
    assert.match(p, /- For you, the Homeroom bot, that visual check is EXPECTED, not optional, when the change is one a person will\n  see\. Boot the app, then/);
    assert.match(p, /at 390x844 and at a desktop width, in both looks \(`\?un-theme=light` and `\?un-theme=dark`, unless the app keeps\n  one fixed look\), and in its empty and error states\. Fix what is wrong, and only then finish\./);
    assert.match(p, /Skip it only when\n  the app cannot boot promptly, and then say why in your summary\. Stay within the time budget above\./);
    assert.ok(p.indexOf(IN_LOOP_BROWSER_GUIDANCE) < p.indexOf('EXPECTED, not optional, when the change'), 'the rule follows the block');
    assert.doesNotMatch(p.slice(p.indexOf('The in-loop browser, as'), p.indexOf(IN_LOOP_BROWSER_GUIDANCE)), /—/);
  }
  assert.match(images, /Boot the app, then\n  take screenshots \(`browser_take_screenshot`\) of each changed screen\n/);
  assert.match(text, /Boot the app, then\n  walk each changed screen through its accessibility snapshot \(`browser_snapshot`; you read text, not images\)\n/);
});

test('the dev chat\'s browser guidance is left as it was', () => {
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /browserGuidance: IN_LOOP_BROWSER_GUIDANCE,/);
  assert.doesNotMatch(IN_LOOP_BROWSER_GUIDANCE, /Homeroom bot/);
  assert.doesNotMatch(IN_LOOP_BROWSER_GUIDANCE, /un-theme/);
});

// ── A first version's look, and the note that records it ───────────────

test('a first version\'s triage plans a look of its own; every other triage is unchanged', () => {
  const flat = (text) => text.replace(/\s+/g, ' ');
  const first = flat(bot.triagePromptFor({ seed: 'SEED', issueNumber: 1, firstVersion: true }));
  const other = flat(bot.triagePromptFor({ seed: 'SEED', issueNumber: 1 }));
  assert.match(first, /Plan a look of its own, too: the starter's screen is placeholder, so there is no existing screen for it to look like\./);
  assert.match(first, /Say in `build_note` the screen's one job and its one primary action/);
  assert.match(first, /an accent colour plus neutrals that work in both looks \(not the starter's default zinc and violet, unless chosen on purpose\)/);
  assert.match(first, /ONE signature element drawn from the app's subject \(for example a staff or a keyboard for an ear trainer, a proofing timeline for a bread app\)/);
  assert.match(first, /and a rough layout\. The spec settles the details; never ask about them\./);
  assert.ok(first.indexOf('Plan a look of its own') > first.indexOf('never ask about it.'), 'after the light and dark rule');
  assert.doesNotMatch(other, /Plan a look of its own|ONE signature element/);
  assert.doesNotMatch(first.slice(first.indexOf('Plan a look of its own'), first.indexOf('never ask about them.')), /—/);
});

test('a first version\'s spec decides accent, signature element and layout; every other spec keeps its brief', () => {
  const brief = prompts.FIRST_VERSION_SPEC_DESIGN_BRIEF;
  assert.match(brief, /there is no existing screen for it to look like/);
  assert.match(brief, /the main screen's one job and its one primary action/);
  assert.match(brief, /an accent colour plus the neutrals around it, chosen for this app and working in both the light and the dark look \(not the starter's default zinc and violet, unless you choose them on purpose and say why\)/);
  assert.match(brief, /ONE signature element drawn from the app's subject/);
  assert.match(brief, /a staff or a keyboard for an ear trainer, a proofing timeline for a bread app/);
  assert.match(brief, /a rough sketch of the main screen's layout at phone width/);
  assert.match(brief, /records it in the app's CLAUDE\.md/);
  assert.doesNotMatch(brief, /which existing screen of this app it should look/);
  assert.doesNotMatch(brief, /—/);

  // The brief every other spec reads, the dev chat's scout included, as it was.
  assert.match(prompts.SPEC_DESIGN_BRIEF, /which existing screen of this app it should look and behave like/);
  assert.doesNotMatch(prompts.SPEC_DESIGN_BRIEF, /signature element|zinc/);

  const first = live.specPrompt({ seed: 'ISSUE', buildNote: 'plan', firstVersion: true });
  const other = live.specPrompt({ seed: 'ISSUE', buildNote: 'plan' });
  assert.ok(first.includes(`- ${brief}`));
  assert.ok(other.includes(`- ${prompts.SPEC_DESIGN_BRIEF}`));
  assert.ok(!other.includes(brief));
  assert.equal(first.replace(brief, prompts.SPEC_DESIGN_BRIEF), other, 'the brief is the only difference');
  assert.equal(live.specPrompt({ seed: 'ISSUE', buildNote: 'plan', firstVersion: false }), other);
});

test('a first version\'s build records its look in CLAUDE.md; later builds are told to follow it', () => {
  const lines = live.FIRST_VERSION_DESIGN_LINES.join('\n');
  assert.match(lines, /record the look in the app's `CLAUDE\.md`: replace the placeholder under\n"## App-specific conventions" with a short `Design:` note/);
  assert.match(lines, /naming the accent and the neutrals,\nnotes on type and spacing, the signature element, and the one fixed look if the app keeps one\. Every later\nchange follows that note\./);
  assert.match(lines, /Define the accent and the neutrals once, each with a light and a dark value unless the app\nkeeps one fixed look/);
  assert.match(lines, /the design guidance's "no new\ncolours" means none beyond them/,
    'the colours it defines are the app\'s own palette, not the kind the guidance bans');
  for (const line of live.FIRST_VERSION_DESIGN_LINES) assert.ok(!/—/.test(line), line);

  for (const spec of [null, SPEC]) {
    const first = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', spec, firstVersion: true });
    const other = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', spec });
    assert.ok(first.includes(lines));
    assert.ok(first.indexOf(lines) < first.indexOf('Make exactly that change, and nothing else:'),
      'part of "that change", before the contract that forbids adding notes');
    assert.equal(first.replace(`${lines}\n`, ''), other, 'the record is the only difference');
    // Every build, a later one included, reads the note through the guidance.
    for (const p of [first, other]) {
      assert.match(p, /If the app's `CLAUDE\.md` has a `Design:` note \(under "App-specific conventions"\), that is this app's look/);
    }
  }
});

// ── Through buildAndPropose ──────────────────────────────────────────────

function buildHarness() {
  const calls = { prompts: [] };
  const pool = { async query(sql) { return /INSERT INTO chat_sessions/.test(String(sql)) ? { rows: [{ id: 5001 }] } : { rows: [] }; } };
  const deps = {
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'w'; },
      async execInWorker(_id, opts) {
        calls.prompts.push({ mode: opts.mode, prompt: opts.prompt });
        return opts.mode === 'scout' ? { lastResultText: SPEC } : { pushOk: true, ahead: 1 };
      },
      stopTurn() { return Promise.resolve(); },
    },
    sessions: {
      async runCodexAttemptLoop(args) { return { result: await args.dispatchOnce({}), estimatedCostUsd: 0.01 }; },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `b${sessionId}` }; } },
    activeWorkers: new Set(),
  };
  return { pool, deps, calls };
}

const ARGS = {
  config: { dataEncryptionKey: 'k' }, bot: { id: 77, username: 'homeroom_bot' }, app: { id: 9, slug: 'pulse' },
  repo: { owner: 'o', repo: 'r' }, issueNumber: 13, issue: { title: 'Ear trainer' }, seed: 'ISSUE',
  buildNote: 'x', turnBudgetMs: 60_000, propose: false,
};

const promptFor = (calls, mode) => calls.prompts.find((c) => c.mode === mode).prompt;

test('the build reads the model\'s image input from the catalog, with the key its turn runs on', async (t) => {
  const real = {
    readMetadata: credentialStore.readMetadata,
    readSecret: credentialStore.readSecret,
    resolveModelPricing: agentModels.resolveModelPricing,
  };
  t.after(() => Object.assign(credentialStore, { readMetadata: real.readMetadata, readSecret: real.readSecret })
    && Object.assign(agentModels, { resolveModelPricing: real.resolveModelPricing }));
  const asked = [];
  credentialStore.readMetadata = async (args) => { asked.push(['meta', args.userId, args.provider, args.purpose]); return { status: 'valid', revision: 4 }; };
  credentialStore.readSecret = async (args) => { asked.push(['secret', args.userId, args.expectedRevision]); return 'sk-or-test'; };
  agentModels.resolveModelPricing = async ({ apiKey, modelId }) => {
    asked.push(['catalog', apiKey, modelId]);
    return { 'z-ai/glm-5.3-flash': { supportsImages: true }, 'text/only': { supportsImages: false } }[modelId] || null;
  };

  const sees = buildHarness();
  await live.buildAndPropose({ pool: sees.pool, deps: sees.deps, ...ARGS, model: 'z-ai/glm-5.3-flash' });
  assert.deepEqual(asked, [
    ['meta', 77, 'openrouter', 'coding_agent'],
    ['secret', 77, 4],
    ['catalog', 'sk-or-test', 'z-ai/glm-5.3-flash'],
  ], 'the bot\'s own coding key, as the Mayor reads it');
  assert.ok(promptFor(sees.calls, 'build').includes(prompts.getDesignGuidance({ readsImages: true })));

  for (const model of ['text/only', 'not/in-catalog']) {
    const h = buildHarness();
    await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, model });
    assert.ok(promptFor(h.calls, 'build').includes(prompts.getDesignGuidance({ readsImages: false })), model);
  }

  // No key, or a catalog that cannot be read: text, and the build goes on.
  credentialStore.readMetadata = async () => null;
  assert.equal(await live.buildSeesImages({ pool: {}, config: {}, userId: 77, model: 'z-ai/glm-5.3-flash' }), false);
  credentialStore.readMetadata = async () => { throw new Error('db down'); };
  assert.equal(await live.buildSeesImages({ pool: {}, config: {}, userId: 77, model: 'z-ai/glm-5.3-flash' }), false);
});

test('a first version reaches its spec and its build; any other build reads the usual brief', async () => {
  const first = buildHarness();
  first.deps.seesImages = true;
  await live.buildAndPropose({ pool: first.pool, deps: first.deps, ...ARGS, model: 'm', firstVersion: true });
  assert.ok(promptFor(first.calls, 'scout').includes(prompts.FIRST_VERSION_SPEC_DESIGN_BRIEF));
  assert.ok(promptFor(first.calls, 'build').includes(live.FIRST_VERSION_DESIGN_LINES.join('\n')));

  const other = buildHarness();
  other.deps.seesImages = true;
  await live.buildAndPropose({ pool: other.pool, deps: other.deps, ...ARGS, model: 'm' });
  assert.ok(promptFor(other.calls, 'scout').includes(prompts.SPEC_DESIGN_BRIEF));
  assert.ok(!promptFor(other.calls, 'scout').includes(prompts.FIRST_VERSION_SPEC_DESIGN_BRIEF));
  assert.ok(!promptFor(other.calls, 'build').includes('FIRST VERSION'));
});

test('a live first version passes the flag to its build, and a benchmark trial replays it', async (t) => {
  const realBuild = live.buildAndPropose;
  const realPost = live.post;
  t.after(() => { live.buildAndPropose = realBuild; live.post = realPost; });
  live.post = async () => ({});
  const seen = [];
  live.buildAndPropose = async (args) => { seen.push(args.firstVersion); return { ok: false, error: 'stop here', costUsd: 0 }; };
  const pool = { async query() { return { rows: [] }; } };
  for (const firstVersion of [true, false]) {
    await bot.actOnVerdict({
      pool, config: {}, bot: { id: 77, username: 'homeroom_bot' }, app: { id: 9, slug: 'pulse' }, repo: { owner: 'o', repo: 'r' },
      issueNumber: 13, issue: { title: 'x' }, parsed: { verdict: 'ready', buildNote: 'x' }, capSuppressed: null, runId: 900,
      seed: 's', seedReadAt: '2026-09-28T10:00:00Z', postedAt: [], turnBudgetMs: 1000, model: 'm', firstVersion,
      deps: {
        github: { getBotUsername: async () => 'usernode-bot', async fetchIssueComments() { return { comments: [] }; } },
        ws: {}, threadContext: { async loadIssueThread() { return { messages: [] }; } },
        limits: { async recordSpend() {} }, managedOpenRouter: { async usesIncludedKey() { return false; } }, domain: 'x',
      },
    });
  }
  assert.deepEqual(seen, [true, false]);

  const runner = read('src/services/bench/runner.js');
  const specStage = runner.slice(runner.indexOf('async function specStage('), runner.indexOf('async function buildResult('));
  const buildStage = runner.slice(runner.indexOf('async function buildStage('), runner.indexOf('function followupTurn('));
  for (const stage of [specStage, buildStage]) assert.match(stage, /firstVersion: !!snapshot\.extra\?\.firstVersion,/);
});
