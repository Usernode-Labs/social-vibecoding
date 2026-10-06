'use strict';

// The App bench studio's context packs (services/bench/packs.js) and a
// trial's progress (services/bench/progress.js), pure: what a pack may hold,
// where its text goes in the bot's prompts, how its files sit on the
// starter's, what a version changed from its parent, and how a trial's
// watch learns which skills it reached for.

const test = require('node:test');
const assert = require('node:assert/strict');

const packs = require('../src/services/bench/packs');
const progress = require('../src/services/bench/progress');
const live = require('../src/services/homeroom-bot-live');
const bot = require('../src/services/homeroom-bot');

test('a pack writes only relative paths outside .git/ and .github/', () => {
  for (const ok of ['CLAUDE.md', '.claude/skills/warm-theme/SKILL.md', 'design/notes.md', 'public/theme.css']) {
    assert.equal(packs.validPath(ok), true, ok);
  }
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', '.git/config', '.github/workflows/ci.yml', 'a b', 'x'.repeat(201)]) {
    assert.equal(packs.validPath(bad), false, bad);
  }
});

test('validate: names, sizes, stages and files are checked; an empty pack is refused', () => {
  assert.equal(packs.validate({ name: '', guidance: 'x' }).status, 400);
  assert.equal(packs.validate({ name: 'warm theme' }).ok, false, 'a pack needs something in it');
  assert.equal(packs.validate({ name: 'warm', guidance: 'x'.repeat(packs.MAX_GUIDANCE_CHARS + 1) }).ok, false);
  assert.equal(packs.validate({ name: 'warm', stageGuidance: { deploy: 'x' } }).ok, false, 'only the three first-version stages');
  assert.equal(packs.validate({ name: 'warm', files: [{ path: 'a.md', content: 'x' }, { path: 'a.md', content: 'y' }] }).ok, false, 'no path twice');
  assert.equal(packs.validate({ name: 'warm', files: Array.from({ length: packs.MAX_FILES + 1 }, (_, i) => ({ path: `f${i}.md`, content: 'x' })) }).ok, false);
  const big = 'x'.repeat(packs.MAX_FILE_CHARS);
  assert.equal(packs.validate({ name: 'warm', files: [1, 2, 3].map((i) => ({ path: `f${i}.md`, content: big })) }).ok, false, 'the whole pack is capped');

  const v = packs.validate({
    name: '  warm   theme ', guidance: 'Use warm colours.\r\nRound corners.',
    stageGuidance: { build: 'Load the warm-theme skill first.', spec: '   ' },
    files: [{ path: 'z.md', content: 'z' }, { path: '.claude/skills/warm-theme/SKILL.md', content: '---\nname: warm-theme\n---\n' }],
  });
  assert.equal(v.ok, true);
  assert.equal(v.pack.name, 'warm theme');
  assert.equal(v.pack.guidance, 'Use warm colours.\nRound corners.');
  assert.deepEqual(v.pack.stageGuidance, { build: 'Load the warm-theme skill first.' }, 'blank stage text is dropped');
  assert.deepEqual(v.pack.files.map((f) => f.path), ['.claude/skills/warm-theme/SKILL.md', 'z.md'], 'files are sorted');
});

test('the same content hashes the same, whatever order its files came in', () => {
  const a = packs.validate({ name: 'a', guidance: 'g', files: [{ path: 'x', content: '1' }, { path: 'y', content: '2' }] }).pack;
  const b = packs.validate({ name: 'b', guidance: 'g', files: [{ path: 'y', content: '2' }, { path: 'x', content: '1' }] }).pack;
  assert.equal(packs.hashOf(a), packs.hashOf(b), 'the name is not content');
  assert.notEqual(packs.hashOf(a), packs.hashOf({ ...a, guidance: 'h' }));
});

test('a pack\'s guidance goes to each stage, with the stage\'s own after it, under one heading in the prompt', () => {
  const row = { guidance: 'Warm colours.', stage_guidance: { build: 'Load the skill.' } };
  assert.equal(packs.guidanceFor(row, 'triage'), 'Warm colours.');
  assert.equal(packs.guidanceFor(row, 'build'), 'Warm colours.\n\nLoad the skill.');
  assert.equal(packs.guidanceFor(null, 'build'), '');

  assert.deepEqual(live.guidanceLines(''), [], 'no pack, no heading: today\'s prompt is unchanged');
  const lines = live.guidanceLines('Warm colours.').join('\n');
  assert.match(lines, /==== ADDITIONAL GUIDANCE FOR THIS BUILD/);
  assert.match(lines, /Warm colours\.\n\n==== END ADDITIONAL GUIDANCE ====/);

  const spec = live.specPrompt({ seed: { title: 'Bread', body: 'Bake bread' }, buildNote: 'n', firstVersion: true, guidance: 'Warm colours.' });
  assert.match(spec, /ADDITIONAL GUIDANCE[\s\S]*Warm colours\./);
  assert.doesNotMatch(live.specPrompt({ seed: { title: 'Bread', body: 'Bake bread' }, buildNote: 'n', firstVersion: true }), /ADDITIONAL GUIDANCE/);
});

test('a pack\'s files sit on the starter\'s, replacing one of the same path', () => {
  const starter = [{ path: 'CLAUDE.md', content: 'starter' }, { path: 'app.js', content: 'js' }];
  assert.equal(packs.withPackFiles(starter, null), starter);
  const out = packs.withPackFiles(starter, { files: [{ path: 'CLAUDE.md', content: 'pack' }, { path: '.claude/skills/t/SKILL.md', content: 's' }] });
  assert.deepEqual(out.map((f) => [f.path, f.content]), [['app.js', 'js'], ['CLAUDE.md', 'pack'], ['.claude/skills/t/SKILL.md', 's']]);
});

test('a version\'s diff from its parent: the guidance\'s lines, and files added, removed and changed', () => {
  const parent = { id: 1, version: 1, guidance: 'a\nb\nc', stage_guidance: {}, files: [{ path: 'x', content: '1' }, { path: 'y', content: '2' }] };
  const pack = { id: 2, version: 2, guidance: 'a\nB\nc', stage_guidance: { build: 'new' }, files: [{ path: 'x', content: '1!' }, { path: 'z', content: '3' }] };
  const d = packs.diffFrom(parent, pack);
  assert.equal(d.parentVersion, 1);
  assert.equal(d.guidance, ' a\n-b\n+B\n c');
  assert.match(d.stageGuidance, /\+\[build\]/);
  assert.deepEqual(d.filesAdded, ['z']);
  assert.deepEqual(d.filesRemoved, ['y']);
  assert.deepEqual(d.filesChanged, ['x']);
  assert.equal(packs.diffFrom(null, pack), null);
  assert.equal(packs.lineDiff('same', 'same'), '');
});

test('the plan is approved as a creator tapping Build it would approve it', () => {
  const note = bot.creatorChoiceNote([{ question: 'Units?', answer: 'Grams' }]);
  assert.equal(typeof note, 'string');
  assert.ok(note.length > 0);
});

test('a progress line names a skill invoked or a skill file read, apart', () => {
  assert.deepEqual(progress.skillIn('Using skill warm-theme'), { kind: 'invoked', name: 'warm-theme' });
  assert.deepEqual(progress.skillIn('Reading .claude/skills/warm-theme/SKILL.md'), { kind: 'read', name: 'warm-theme' });
  assert.deepEqual(progress.skillIn('Reading .agents/skills/usernode-api/SKILL.md'), { kind: 'read', name: 'usernode-api' });
  assert.equal(progress.skillIn('Editing app.js'), null);
  assert.equal(progress.skillIn('Reading .claude/skills/warm-theme/notes.md'), null);
});

test('a tracker writes a step at once, notes later, keeps the last four lines, and never throws on a failed write', async () => {
  const writes = [];
  let fail = false;
  const pool = {
    async query(sql, params) {
      if (fail) throw new Error('db down');
      writes.push(JSON.parse(params[1]));
      return { rows: [] };
    },
  };
  let t = 0;
  const tr = progress.tracker(pool, 7, { now: () => t, writeEveryMs: 10 });
  await tr.step('triage');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].step, 'triage');
  await tr.step('triage');
  assert.equal(writes.length, 1, 'the same step twice writes once');
  await tr.step('deploy');
  assert.equal(writes.length, 1, 'only the known steps');
  for (const line of ['one', 'one', 'Using skill warm-theme', 'three', 'four', 'five']) tr.note(line);
  assert.deepEqual(tr.snapshot().lines, ['Using skill warm-theme', 'three', 'four', 'five'], 'a repeat is dropped; four are kept');
  assert.deepEqual(tr.skills(), { invoked: ['warm-theme'], read: [] });
  await new Promise((r) => { setTimeout(r, 30); });
  assert.equal(writes.length, 2, 'notes are written together, later');
  t = 5000;
  fail = true;
  tr.note('six');
  await tr.close();
  fail = false;
  await tr.step('build');
  tr.note('seven');
  assert.equal(writes.length, 2, 'nothing after close');
});
