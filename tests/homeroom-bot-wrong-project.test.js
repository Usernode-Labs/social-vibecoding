'use strict';

// #6752: a request filed on the wrong project. The triage checks that the
// request is about this app (`wrong_project`), its note says where it seems
// to belong and quotes what points there, and Propose to close under it opens
// the same close vote a finished request gets. These are the pieces a
// database is not needed for: the verdict, the note's sentences, the close
// reason, and the prompt.
//
// Run with: node --test tests/homeroom-bot-wrong-project.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');

const reply = (verdict) => `I read the request.\n\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``;
const WHY = 'It asks for "Plant Pal\'s watering screen", which Recipe Box does not have.';

test('#6752: a person verdict with wrong_project carries it, and offers no Go ahead', () => {
  const parsed = bot.parseVerdict(reply({
    verdict: 'person', reason: 'Watering reminders are not this project.',
    wrong_project: { project: 'Plant Pal', why: WHY },
    first_step: 'Just the reminder', go_ahead: true,
  }));
  assert.deepEqual(parsed.wrongProject, { project: 'Plant Pal', why: WHY });
  assert.equal(parsed.firstStep, null, 'no smaller first step is offered');
  assert.equal(parsed.goAheadDecides, null, 'no Go ahead is offered');
  assert.equal(parsed.platform, false);
  assert.equal(parsed.done, false);
});

test('#6752: the project is optional when the read cannot name it', () => {
  const parsed = bot.parseVerdict(reply({
    verdict: 'person', reason: 'x', wrong_project: { why: WHY },
  }));
  assert.deepEqual(parsed.wrongProject, { project: null, why: WHY });
});

test('#6752: wrong_project is dropped with platform, done, an empty why, or a non-person verdict', () => {
  const wrong = { project: 'Plant Pal', why: WHY };
  assert.equal(bot.parseVerdict(reply({ verdict: 'person', reason: 'x', wrong_project: wrong, platform: true })).wrongProject, null);
  assert.equal(bot.parseVerdict(reply({ verdict: 'person', reason: 'x', wrong_project: wrong, done: true })).wrongProject, null);
  assert.equal(bot.parseVerdict(reply({ verdict: 'person', reason: 'x', wrong_project: { project: 'Plant Pal', why: '  ' } })).wrongProject, null);
  assert.equal(bot.parseVerdict(reply({ verdict: 'ready', build_note: 'x', wrong_project: wrong })).wrongProject, null);
  assert.equal(bot.parseVerdict(reply({ verdict: 'empty', reason: 'x', wrong_project: wrong })).wrongProject, null);
  assert.equal(bot.parseVerdict(reply({ verdict: 'person', reason: 'x' })).wrongProject, null);
});

test('#6752: the note says where it seems to belong, quotes what points there, and offers no Go ahead', () => {
  const text = live.wrongProjectHomeroomText({ wrongProject: { project: 'Plant Pal', why: WHY }, project: 'Recipe Box' });
  assert.match(text, /^Wrong project\? This seems to be about Plant Pal, not Recipe Box: It asks for "Plant Pal's watering screen", which Recipe Box does not have\./);
  assert.match(text, /Tap Propose to close below to start a vote\. It stays open until the group votes for it, or reply here if it does belong here\.$/);
  assert.doesNotMatch(text, /—/);
  assert.doesNotMatch(text, /Go ahead/);
});

test('#6752: with no project named, the note says another project', () => {
  const text = live.wrongProjectHomeroomText({ wrongProject: { project: null, why: WHY }, project: 'Recipe Box' });
  assert.match(text, /This seems to be about another project, not Recipe Box:/);
});

test('#6752: the close reason names the project, or says another project, within the close reason limit', () => {
  assert.equal(live.wrongProjectReason({ project: 'Plant Pal', why: WHY }),
    `Filed on the wrong project: it seems to belong to Plant Pal. ${WHY}`);
  assert.match(live.wrongProjectReason({ project: null, why: WHY }), /^Filed on the wrong project: it seems to belong to another project\./);
  assert.ok(live.wrongProjectReason({ project: 'Plant Pal', why: 'x'.repeat(900) }).length <= 501);
});

test('#6752: no Go ahead is offered under a wrong-project note', () => {
  assert.deepEqual(live.personSuggestions({ wrongProject: true }), []);
});

test('#6752: GitHub\'s copy says it was filed on the wrong project and offers the close vote', () => {
  const text = live.personText({ reason: 'x', project: 'Recipe Box', wrongProject: { project: 'Plant Pal', why: WHY } });
  assert.match(text, /^Homeroom bot thinks this was filed on the wrong project: It asks for "Plant Pal's watering screen"/);
  assert.match(text, /It seems to belong to Plant Pal, not Recipe Box\. Anyone in the project can propose to close it, or reply here if it belongs here\.$/);
  assert.doesNotMatch(text, /—/);
});

test('#6752: the triage checks the project, and names wrong_project in its rules and shape', () => {
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'src/prompts/homeroom-bot-triage.md'), 'utf8');
  assert.match(prompt, /Before you choose, check that the request is about this app\./);
  assert.match(prompt, /`wrong_project`: ONLY with `person`, when the request is about another project/);
  assert.match(prompt, /It omits `go_ahead` and `first_step`/);
  assert.match(prompt, /"wrong_project": \{"project":/);
});

test('#6752: the run records the wrong project, and its migration is tracked', () => {
  const root = path.join(__dirname, '..');
  const sql = fs.readFileSync(path.join(root, 'src/db/migrations/homeroom-bot-run-wrong-project.sql'), 'utf8');
  assert.match(sql, /ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS wrong_project JSONB;/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/db/migrations/manifest.json'), 'utf8'));
  assert.ok(manifest.migrations.some((m) => m.id === 'homeroom-bot-run-wrong-project'));
  const src = fs.readFileSync(path.join(root, 'src/services/homeroom-bot.js'), 'utf8');
  assert.match(src, /UPDATE homeroom_bot_runs SET wrong_project = \$2 WHERE id = \$1/);
});
