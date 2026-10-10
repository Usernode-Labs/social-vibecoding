'use strict';

// The Homeroom bot's written replies are pinned to English (10 Oct 2026,
// issue #4645). A person wrote to the bot in English and its follow-up reply
// came back in Chinese: none of the prompts that produce text people read
// said which language to write in, so the model sometimes picked another
// one. Each such prompt now carries a short English line, worded beside the
// existing "no em dashes" instruction, and this test pins it so the rule is
// not lost later. Quotes of people's own words are still written as the
// person wrote them.
//
// Run with: node --test tests/homeroom-bot-english.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');
const review = require('../src/services/bot-review');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SPEC = [
  '# Pick the next book',
  '',
  '## User-facing changes',
  '',
  'Members pick the next book from the card.',
  '',
  '## Technical implementation',
  '',
  'Edit `public/app.js`.',
].join('\n');

test('the follow-up reply turn and the checks-fix turn ask for English', () => {
  const prompt = followup.followUpPrompt({ seed: 'S', replies: [], canRevise: true });
  assert.match(prompt, /in English/);
  assert.match(prompt, /quote people's own words as they wrote them/);
  const fix = followup.checksFixPrompt({ seed: 'S', failing: [{ name: 'x', reason: 'y' }], total: 1 });
  assert.match(fix, /in English/);
});

test('the triage prompt asks for English in every string', () => {
  assert.match(read('src/prompts/homeroom-bot-triage.md'), /Write every string in English/);
});

test('the spec prompts, both variants, are written in English', () => {
  const markdown = live.specPrompt({ seed: 'ISSUE', buildNote: 'Edit a.js.' });
  assert.match(markdown, /- Written in English\./);
  const html = live.specPrompt({ seed: 'ISSUE', buildNote: 'Edit a.js.', html: true });
  assert.match(html, /- Written in English\./);
});

test('the revised-plan format, both variants, is written in English', () => {
  const markdown = live.followUpPlanFormat({});
  assert.match(markdown, /Written in English\./);
  const html = live.followUpPlanFormat({ config: { htmlSpecApps: ['*'] }, app: { slug: 'x' } });
  assert.match(html, /Written in English\./);
});

test('the build prompt\'s description block asks for English', () => {
  const build = live.buildPrompt({ seed: 'ISSUE', buildNote: 'Edit a.js.', spec: SPEC });
  assert.match(build, /Write it in English\./);
});

test('the design-review prompts ask for English', () => {
  assert.match(review.reviewerSystemPrompt(), /in English/);
  assert.match(review.fixPrompt({}), /in English/);
});