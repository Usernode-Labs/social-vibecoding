'use strict';

// App bench context pack 4 ("frontend-design-kit" v2) made live
// (src/services/design-skill.js). In studio run 8 its build was picked as
// the best of all three briefs, blind, so every first version now gets it:
//
//   - the frontend-design skill in the new repository's first commit, at the
//     path the bench used (src/services/template.js getTemplateFiles, from
//     src/templates/app-scaffold/frontend-design/);
//   - the nudge to read it at the spec and the build, and the look-and-fix
//     loop at the build (src/prompts/design-skill-nudge.md,
//     src/prompts/first-version-look-loop.md), word for word, where the
//     bench said them (src/services/homeroom-bot-live.js);
//   - a later build of a repository with the skill: the nudge alone;
//   - the bench's pack 0 is all of that, and pack 4 on top says nothing twice.
//
// Run with: node --test tests/design-skill.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const designSkill = require('../src/services/design-skill');
const template = require('../src/services/template');
const appTemplates = require('../src/services/app-templates');
const live = require('../src/services/homeroom-bot-live');
const packs = require('../src/services/bench/packs');
const scaffold = require('../src/services/bench/scaffold');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Pack 4's and its parent pack 2's sha256, as the bench stored them
// (services/bench/packs.js hashOf over guidance, stage guidance and files).
const PACK_4_SHA = 'b6f8432f01512c04a2f90b14cc6e7880a7670f8afeb71b2ec905a23263b94577';
const PACK_2_SHA = 'a61e226385ef2e9c33c5bdcb932be415a42657941fbac83b9bd7e5dff215daff';
// The live skill is pack 4's with four edits about colour (7 October 2026):
// the colours a subject already has are its fit, not a cliché, so the
// palette is as many named colours as the subject needs, and a calibration
// trait is a default only where the subject does not call for it. Each pair
// is [pack 4's text, the live text]; undoing them gives pack 4 back byte for
// byte, and the live skill hashes to LIVE_SHA. A stored pack is never edited.
const COLOUR_EDITS = [
  ['Build with the brief\'s real content and subject matter throughout.\n',
    'Build with the brief\'s real content and subject matter throughout.\n\nColours the subject already has, the ones people already read in its world (a map\'s water and parks, team colours, card suits, traffic-light statuses), are the fit to the subject, not a cliché. Use them, and be distinctive in how you use them, not by avoiding them.\n'],
  ['so on a user\'s brief it reads as a tell);',
    'so on a user\'s brief it reads as a tell), when nothing in the subject calls for a warm page;'],
  ['and they appear regardless of subject. Where the brief pins down a visual direction, follow it exactly — the brief\'s own words always win, including when it asks for one of these looks. Where it leaves an axis free,',
    'and they appear regardless of subject. A trait is a default only when the subject does not call for it. Where the brief pins down a visual direction, follow it exactly — the brief\'s own words always win, including when it asks for one of these looks. A subject\'s own vernacular (the colours, materials and forms people already read in its world) pins that axis down too. Where the brief and the subject leave an axis free,'],
  ['- Color: the kit\'s tokens as 4–6 named colours, each with',
    '- Color: the kit\'s tokens as named colours, as many as the subject needs: the neutrals, one action colour, and any set of colours the subject itself uses, each with'],
];
const LIVE_SHA = 'c54317ceca8932b4c485dd6a89171a06696461236f40509bc4d264cc3f7fe6fe';
const LIVE_PACK_2_SHA = '37c5ea8a2cfce1378069a44d258063dd3d38c7060c65bf25446bf92f3ed78c14';

const { NUDGE, FIRST_VERSION_LOOP, SKILL_PATH } = designSkill;
const FIRST = { spec: designSkill.stageGuidance('spec', { firstVersion: true }), build: designSkill.stageGuidance('build', { firstVersion: true }) };
// Pack 4 and pack 2 as the bench's rows hold them.
const PACK_4 = { id: 4, guidance: '', stage_guidance: { spec: NUDGE, build: `${NUDGE}\n\n${FIRST_VERSION_LOOP}` }, files: designSkill.skillFiles() };
const PACK_2 = { id: 2, guidance: '', stage_guidance: { spec: NUDGE, build: NUDGE }, files: designSkill.skillFiles() };

const count = (text, part) => text.split(part).length - 1;
const SPEC = '# Title\n\n## User-facing changes\n\nx\n\n## Technical implementation\n\ny';

// ── What it is ───────────────────────────────────────────────────────────

test('the skill and the texts are App bench context pack 4, byte for byte but for its colour edits', () => {
  assert.equal(packs.hashOf({ guidance: '', stageGuidance: FIRST, files: designSkill.skillFiles() }), LIVE_SHA);
  assert.equal(packs.hashOf({ guidance: '', stageGuidance: { spec: NUDGE, build: NUDGE }, files: designSkill.skillFiles() }), LIVE_PACK_2_SHA);
  // Undo the colour edits and it is pack 4 again; its parent, v1, was the
  // same files and the nudge at both stages.
  let skill = designSkill.skillFiles()[1].content;
  for (const [was, now] of COLOUR_EDITS) {
    assert.equal(skill.split(now).length, 2, `the edit is there once: ${now.slice(0, 60)}`);
    skill = skill.replace(now, was);
  }
  const pack4Files = [designSkill.skillFiles()[0], { ...designSkill.skillFiles()[1], content: skill }];
  assert.equal(packs.hashOf({ guidance: '', stageGuidance: FIRST, files: pack4Files }), PACK_4_SHA);
  assert.equal(packs.hashOf({ guidance: '', stageGuidance: { spec: NUDGE, build: NUDGE }, files: pack4Files }), PACK_2_SHA);
  // None of its examples is one of the App bench's starter briefs.
  assert.doesNotMatch(designSkill.skillFiles()[1].content, /bread|baking|proofing|RSS|feed reader|ear train|voxel|tier list|ranking/i);

  // Kept as reviewable text beside the design guidance.
  assert.equal(NUDGE, read('src/prompts/design-skill-nudge.md').trim());
  assert.equal(FIRST_VERSION_LOOP, read('src/prompts/first-version-look-loop.md').trim());
  assert.equal(FIRST.spec, NUDGE);
  assert.equal(FIRST.build, `${NUDGE}\n\n${FIRST_VERSION_LOOP}`);
  assert.match(NUDGE, /^Before you plan or build anything people will see, read the `frontend-design` skill \(`\.claude\/skills\/frontend-design\/SKILL\.md`\) and follow it\.$/);
  assert.match(FIRST_VERSION_LOOP, /at 390x844 and at 1280x800, in the light and the dark look/);
  assert.match(FIRST_VERSION_LOOP, /Stop after five rounds or about fifteen minutes/);
  assert.ok(read('src/prompts/design-guidance.md').includes('==== UI DESIGN'), 'the design guidance is left as it was');

  assert.equal(SKILL_PATH, '.claude/skills/frontend-design/SKILL.md');
  assert.deepEqual(designSkill.skillFiles().map((f) => f.path), [
    '.claude/skills/frontend-design/LICENSE.txt',
    '.claude/skills/frontend-design/SKILL.md',
  ]);
  assert.equal(designSkill.skillFiles()[1].content, read('src/templates/app-scaffold/frontend-design/SKILL.md'));
  assert.equal(designSkill.skillFiles()[0].content, read('src/templates/app-scaffold/frontend-design/LICENSE.txt'));
  assert.match(designSkill.skillFiles()[1].content, /^---\nname: frontend-design\n/);
  assert.match(designSkill.skillFiles()[0].content, /Apache License\n\s+Version 2\.0, January 2004/);
});

test('which stage says what: a first version the nudge and, at its build, the loop; a later one the nudge when the skill is there', () => {
  assert.equal(designSkill.stageGuidance('triage', { firstVersion: true }), '', 'pack 4 said nothing at the triage');
  for (const stage of ['spec', 'build']) {
    assert.equal(designSkill.stageGuidance(stage, { hasSkill: true }), NUDGE, `a later ${stage} with the skill`);
    assert.equal(designSkill.stageGuidance(stage, { hasSkill: false }), '', `a later ${stage} without it`);
    assert.equal(designSkill.stageGuidance(stage), '');
  }
  assert.ok(!designSkill.stageGuidance('build', { hasSkill: true }).includes(FIRST_VERSION_LOOP), 'the loop is a first version\'s');
});

// ── The new repository ───────────────────────────────────────────────────

test('a new repository\'s first commit carries the skill at the bench\'s path, from every starter; an import or a fork\'s scaffold does not', () => {
  for (const tpl of [null, ...appTemplates.TEMPLATE_IDS]) {
    const files = template.getTemplateFiles('Bread Bot', 'bread-bot', 'postgres://x/y', null, { template: tpl });
    for (const f of designSkill.skillFiles()) {
      const found = files.filter((x) => x.path === f.path);
      assert.equal(found.length, 1, `${tpl}: ${f.path} once`);
      assert.equal(found[0].content, f.content, `${tpl}: ${f.path} as the pack had it`);
    }
  }
  assert.ok(!template.getConnectorScaffoldFiles().some((f) => f.path.startsWith(designSkill.SKILL_DIR)));
});

test('the bench\'s first commit for pack 0 is the live template\'s, skill included', () => {
  const input = { appName: 'Bread Bot', brief: 'Bake bread' };
  const bench = scaffold.filesFor({ input });
  const live0 = template.getTemplateFiles('Bread Bot', 'bread-bot', '', null, { template: null, description: null, sketch: null });
  assert.deepEqual(bench, live0);
  for (const f of designSkill.skillFiles()) assert.ok(bench.some((x) => x.path === f.path && x.content === f.content), f.path);
});

// ── The prompts ──────────────────────────────────────────────────────────

test('a first version\'s spec says the nudge, and its build the nudge and the loop, under the guidance heading, once', () => {
  for (const html of [false, true]) {
    const spec = live.specPrompt({ seed: 'ISSUE', buildNote: 'plan', firstVersion: true, html });
    assert.ok(spec.includes(live.guidanceLines(NUDGE).join('\n')), `html ${html}`);
    assert.equal(count(spec, NUDGE), 1);
    assert.ok(!spec.includes(FIRST_VERSION_LOOP), 'the loop is the build\'s');
  }
  for (const s of [null, SPEC]) {
    const build = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', spec: s, firstVersion: true });
    assert.ok(build.includes(live.guidanceLines(`${NUDGE}\n\n${FIRST_VERSION_LOOP}`).join('\n')));
    assert.equal(count(build, NUDGE), 1);
    assert.equal(count(build, FIRST_VERSION_LOOP), 1);
    const at = build.indexOf(NUDGE);
    assert.ok(build.indexOf(live.FIRST_VERSION_DESIGN_LINES.join('\n')) < at, 'after the first version\'s design lines');
    assert.ok(at < build.indexOf('Make exactly that change, and nothing else:'), 'before the build contract');
  }
});

test('any other build, and a repository without the skill, reads what it did before', () => {
  for (const html of [false, true]) {
    const spec = live.specPrompt({ seed: 'ISSUE', buildNote: 'plan', html });
    assert.doesNotMatch(spec, /ADDITIONAL GUIDANCE|frontend-design/);
  }
  const build = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', spec: SPEC });
  assert.doesNotMatch(build, /ADDITIONAL GUIDANCE|frontend-design/);
  assert.ok(!build.includes(FIRST_VERSION_LOOP));
});

// ── Through buildAndPropose ──────────────────────────────────────────────

function harness({ github } = {}) {
  const calls = { prompts: [], reads: [] };
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
    seesImages: true,
    ...(github ? { github } : {}),
  };
  return { pool, deps, calls };
}

const ARGS = {
  config: { dataEncryptionKey: 'k' }, bot: { id: 77, username: 'homeroom_bot' }, app: { id: 9, slug: 'bread-bot' },
  repo: { owner: 'o', repo: 'r' }, issueNumber: 13, issue: { title: 'Show the proofing timeline' }, seed: 'ISSUE',
  buildNote: 'x', turnBudgetMs: 60_000, propose: false, model: 'm',
};

const promptFor = (calls, mode) => calls.prompts.find((c) => c.mode === mode).prompt;

async function run({ github, ...extra } = {}) {
  const h = harness({ github });
  await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, ...extra });
  return { spec: promptFor(h.calls, 'scout'), build: promptFor(h.calls, 'build'), calls: h.calls };
}

function repoWith(files) {
  const reads = [];
  return {
    reads,
    async getFileContent(owner, repo, filePath, ref) {
      reads.push([owner, repo, filePath, ref]);
      if (files instanceof Error) throw files;
      return Object.prototype.hasOwnProperty.call(files, filePath) ? files[filePath] : null;
    },
  };
}

test('a later build of a repository with the skill gets the nudge alone, at its spec and its build', async () => {
  const github = repoWith({ [SKILL_PATH]: designSkill.skillFiles()[1].content });
  const later = await run({ github });
  assert.deepEqual(github.reads, [['o', 'r', SKILL_PATH, 'b5001']], 'read once, at the branch its turns run on');
  for (const p of [later.spec, later.build]) {
    assert.ok(p.includes(live.guidanceLines(NUDGE).join('\n')));
    assert.equal(count(p, NUDGE), 1);
    assert.ok(!p.includes(FIRST_VERSION_LOOP), 'not the first version\'s loop');
    assert.doesNotMatch(p, /FIRST VERSION/);
  }
  // The nudge is the only difference from a build of a repository without it.
  const without = await run({ github: repoWith({}) });
  const block = `\n${live.guidanceLines(NUDGE).join('\n')}`;
  assert.equal(later.spec.replace(block, ''), without.spec);
  assert.equal(later.build.replace(block, ''), without.build);
});

test('without the skill, or when GitHub cannot say, a later build is told nothing new', async () => {
  const before = { spec: null, build: null };
  for (const github of [undefined, repoWith({}), repoWith(new Error('rate limited')), { getFileContent: async () => '  ' }]) {
    // eslint-disable-next-line no-await-in-loop
    const got = await run({ github });
    for (const p of [got.spec, got.build]) assert.doesNotMatch(p, /ADDITIONAL GUIDANCE|frontend-design/);
    before.spec = before.spec ?? got.spec;
    before.build = before.build ?? got.build;
    assert.equal(got.spec, before.spec);
    assert.equal(got.build, before.build);
  }
});

test('a first version reads pack 4\'s texts without asking GitHub, and a bench trial on pack 0 reads the same', async () => {
  const github = repoWith({ [SKILL_PATH]: 'x' });
  const first = await run({ github, firstVersion: true });
  assert.deepEqual(github.reads, [], 'its repository was made with the skill');
  assert.equal(count(first.spec, NUDGE), 1);
  assert.equal(count(first.build, NUDGE), 1);
  assert.equal(count(first.build, FIRST_VERSION_LOOP), 1);
  assert.ok(!first.spec.includes(FIRST_VERSION_LOOP));

  // A studio trial without a pack passes no guidance (lane.js studioContext);
  // one with pack 4 or its parent passes theirs, and says nothing twice.
  const pack0 = await run({ firstVersion: true });
  assert.equal(pack0.spec, first.spec);
  assert.equal(pack0.build, first.build);
  for (const pack of [PACK_4, PACK_2]) {
    // eslint-disable-next-line no-await-in-loop
    const withPack = await run({
      firstVersion: true, specGuidance: packs.guidanceFor(pack, 'spec'), buildGuidance: packs.guidanceFor(pack, 'build'),
    });
    assert.equal(withPack.spec, pack0.spec, `pack ${pack.id}'s spec is pack 0's`);
    assert.equal(withPack.build, pack0.build, `pack ${pack.id}'s build is pack 0's`);
  }
});

// ── The bench: pack 4 on top of pack 0 ───────────────────────────────────

test('pack 4 on the bench adds nothing pack 0 has: no paragraph twice, and its files replace identical ones', () => {
  for (const pack of [PACK_4, PACK_2]) {
    for (const html of [false, true]) {
      const spec0 = live.specPrompt({ seed: 'ISSUE', buildNote: 'plan', firstVersion: true, html });
      assert.equal(live.specPrompt({ seed: 'ISSUE', buildNote: 'plan', firstVersion: true, html, guidance: packs.guidanceFor(pack, 'spec') }), spec0);
    }
    const build0 = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', spec: SPEC, firstVersion: true });
    assert.equal(live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', spec: SPEC, firstVersion: true, guidance: packs.guidanceFor(pack, 'build') }), build0);

    const input = { appName: 'Bread Bot', brief: 'Bake bread' };
    const files0 = scaffold.filesFor({ input });
    const filesP = scaffold.filesFor({ input, pack });
    assert.equal(filesP.length, files0.length, 'no path twice');
    const byPath = (list) => Object.fromEntries(list.map((f) => [f.path, f.content]));
    assert.deepEqual(byPath(filesP), byPath(files0), 'the same tree');
  }
});

test('a pack\'s own text still follows the platform\'s, kept as written; only a repeated paragraph is dropped', () => {
  const own = FIRST.build;
  assert.equal(designSkill.guidanceWith(own, ''), own);
  assert.equal(designSkill.guidanceWith('', 'Warm colours.\n\n\n  Round corners.'), 'Warm colours.\n\n\n  Round corners.', 'no platform text: the pack as written');
  assert.equal(designSkill.guidanceWith(own, 'Warm colours.\n\n\nRound corners.'), `${own}\n\nWarm colours.\n\n\nRound corners.`, 'nothing repeated: kept as written');
  assert.equal(designSkill.guidanceWith(own, `Warm colours.\n\n${NUDGE}\n\nRound corners.`), `${own}\n\nWarm colours.\n\nRound corners.`);
  // A repeat is a repeat however it is wrapped.
  assert.equal(designSkill.guidanceWith(own, NUDGE.replace(/ read the /, '\nread the ')), own);
  assert.equal(designSkill.guidanceWith(NUDGE, FIRST_VERSION_LOOP), `${NUDGE}\n\n${FIRST_VERSION_LOOP}`, 'a paragraph the platform does not say is kept');

  const prompt = live.buildPrompt({ seed: 'ISSUE', buildNote: 'plan', firstVersion: true, guidance: `${NUDGE}\n\nUse warm colours.` });
  assert.equal(count(prompt, NUDGE), 1);
  assert.ok(prompt.indexOf(FIRST_VERSION_LOOP) < prompt.indexOf('Use warm colours.'), 'the pack\'s after the platform\'s');
  assert.equal(count(prompt, '==== ADDITIONAL GUIDANCE'), 1, 'under one heading');
});

test('the bench\'s later builds ask GitHub as a live build does', () => {
  const runner = read('src/services/bench/runner.js');
  const buildStage = runner.slice(runner.indexOf('async function buildStage('), runner.indexOf('function observedRuntime('));
  assert.match(buildStage, /github: deps\.github,/);
});
