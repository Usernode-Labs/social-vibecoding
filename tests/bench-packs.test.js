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

test('a progress line names a look the in-loop browser took, in either harness\'s words', () => {
  assert.equal(progress.lookIn('Using mcp__playwright__browser_take_screenshot'), 'screenshots', 'Claude Code');
  assert.equal(progress.lookIn('Using browser_take_screenshot'), 'screenshots', 'Codex');
  assert.equal(progress.lookIn('Using mcp__playwright__browser_snapshot'), 'snapshots');
  assert.equal(progress.lookIn('Using browser_navigate'), 'navigations');
  assert.equal(progress.lookIn('Using mcp__playwright__browser_resize'), null, 'a resize is not a look');
  assert.equal(progress.lookIn('  ⎿ mcp__playwright__browser_take_screenshot: image'), null, 'a result is not a second look');
  assert.equal(progress.lookIn('Reading browser_take_screenshot.md'), null);
});

test('a tracker counts every look, repeats included, and starts from an earlier claim\'s', () => {
  const pool = { async query() { return { rows: [] }; } };
  const tr = progress.tracker(pool, 7, { writeEveryMs: 60_000 });
  assert.deepEqual(tr.looks(), { screenshots: 0, snapshots: 0, navigations: 0 });
  for (const line of ['Using browser_navigate', 'Using browser_take_screenshot', 'Using browser_take_screenshot', 'Using browser_snapshot']) tr.note(line);
  assert.deepEqual(tr.looks(), { screenshots: 2, snapshots: 1, navigations: 1 });
  assert.deepEqual(tr.snapshot().looks, { screenshots: 2, snapshots: 1, navigations: 1 }, 'written with the watch');
  const again = progress.tracker(pool, 7, { writeEveryMs: 60_000, looks: { screenshots: 3, snapshots: 'x', navigations: -2 } });
  assert.deepEqual(again.looks(), { screenshots: 3, snapshots: 0, navigations: 0 });
  tr.close();
  again.close();
});

test('a turn\'s replayed lines are counted as a tracker counts them', () => {
  const lines = ['Using browser_navigate', '  Using mcp__playwright__browser_take_screenshot  ', 'Using browser_take_screenshot',
    '  ⎿ mcp__playwright__browser_take_screenshot: image', 'Using mcp__playwright__browser_resize', 'Editing app.js'];
  assert.deepEqual(progress.looksIn(lines), { screenshots: 2, snapshots: 0, navigations: 1 });
  const tr = progress.tracker({ async query() { return { rows: [] }; } }, 7, { writeEveryMs: 60_000 });
  for (const line of lines) tr.note(line);
  assert.deepEqual(tr.looks(), progress.looksIn(lines), 'the same lines, the same counts');
  tr.close();
  assert.deepEqual(progress.looksIn(null), { screenshots: 0, snapshots: 0, navigations: 0 });
});

test('a tracker keeps its looks on the checkpoint at each step and at most every interval as they change, never after close', async () => {
  const kept = [];
  let failing = false;
  const warned = [];
  const keep = async (part) => {
    if (failing) throw new Error('db down');
    kept.push(part);
  };
  const log = { warn: (_c, msg) => warned.push(msg) };
  let t = 0;
  const pool = { async query() { return { rows: [] }; } };
  const tr = progress.tracker(pool, 7, {
    now: () => t, writeEveryMs: 60_000, keepEveryMs: 20, keep, log, looks: { screenshots: 1, snapshots: 0, navigations: 2 },
  });
  const settle = () => new Promise((r) => { setImmediate(r); });

  // A step: kept at once, with the counts its turn starts from.
  await tr.step('build');
  assert.deepEqual(kept, [{ stepLooks: { step: 'build', screenshots: 1, snapshots: 0, navigations: 2 } }]);
  await tr.step('build');
  assert.equal(kept.length, 1, 'the same step keeps nothing again');

  // The first look: kept at once. Lines that are no look and no new skill: nothing.
  tr.note('Editing public/app.js');
  await settle();
  assert.equal(kept.length, 1);
  tr.note('Using browser_navigate');
  await settle();
  assert.equal(kept.length, 2, 'the first change is kept at once');
  assert.deepEqual(kept[1], {}, 'the caller adds the counts as it writes');

  // More within the interval: held back, then kept once for all of them.
  t = 5;
  tr.note('Using browser_take_screenshot');
  tr.note('Using browser_take_screenshot');
  tr.note('Using skill warm-theme');
  await settle();
  assert.equal(kept.length, 2, 'not on every line');
  await new Promise((r) => { setTimeout(r, 40); });
  assert.equal(kept.length, 3, 'once, when the interval is up');
  assert.deepEqual(tr.looks(), { screenshots: 3, snapshots: 0, navigations: 3 });

  // Past the interval: at once again.
  t = 1000;
  tr.note('Using browser_snapshot');
  await settle();
  assert.equal(kept.length, 4);

  // A step keeps what a held-back look would have, and the hold is dropped.
  tr.note('Using browser_snapshot');
  await tr.step('capture');
  assert.deepEqual(kept[4], { stepLooks: { step: 'capture', screenshots: 3, snapshots: 2, navigations: 3 } });
  await new Promise((r) => { setTimeout(r, 40); });
  assert.equal(kept.length, 5, 'its looks rode on the step\'s keep');

  // A keep that fails is logged and never thrown.
  failing = true;
  t = 2000;
  tr.note('Using browser_navigate');
  await settle();
  await settle();
  assert.deepEqual(warned, ['Could not keep a trial\'s looks on its checkpoint']);
  failing = false;

  // Close drops a held-back keep: the trial's record has the counts.
  t = 2005;
  tr.note('Using browser_navigate');
  await tr.close();
  await new Promise((r) => { setTimeout(r, 40); });
  tr.note('Using browser_navigate');
  await settle();
  assert.equal(kept.length, 5, 'nothing after close');

  // Without `keep`, a tracker keeps nothing anywhere but its watch.
  const plain = progress.tracker(pool, 8, { writeEveryMs: 60_000 });
  plain.note('Using browser_navigate');
  await plain.step('build');
  await plain.close();
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
