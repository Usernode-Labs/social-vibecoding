'use strict';

// #6767: the platform's content rules, read once from the conventions section
// (services/content-rules-prompt.js) and shared by the picture tool, its
// thread tool and Homeroom bot's replies. #6675 changed what the rules allow
// and three prompts kept refusing it; these pin the one copy they now read.
//
// Run with: node --test tests/content-rules-prompt.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RULES = require('../src/services/content-rules-prompt');
const prompts = require('../src/services/prompts');

const ROOT = path.join(__dirname, '..');
const SECTION = fs.readFileSync(path.join(ROOT, 'src/prompts/app-conventions.md'), 'utf8');
const flat = SECTION.replace(/\*\*/g, '').replace(/\s+/g, ' ');

// A fresh copy of the module, so a stubbed section is read rather than the
// copy the first read cached. `restore` puts the shared one back.
function freshRead() {
  const file = require.resolve('../src/services/content-rules-prompt');
  const cached = require.cache[file];
  delete require.cache[file];
  const mod = require('../src/services/content-rules-prompt');
  return {
    mod,
    restore() {
      delete require.cache[file];
      if (cached) require.cache[file] = cached;
    },
  };
}

test('the lists are the conventions section\'s own bullets, one line each', () => {
  assert.equal(RULES.SLUG, 'content-rules-what-no-app-may-show');
  assert.equal(RULES.forbidden().length, 4);
  assert.equal(RULES.allowed().length, 4);
  for (const bullet of [...RULES.forbidden(), ...RULES.allowed()]) {
    assert.ok(flat.includes(bullet), `the section says: ${bullet}`);
    assert.doesNotMatch(bullet, /\*\*|\n/, bullet);
  }
  assert.ok(RULES.forbidden().some((b) => b.startsWith('Real-money gambling.')), 'real-money gambling is forbidden');
  assert.ok(RULES.allowed().some((b) => b.startsWith('Cartoon and fantasy violence in games:')),
    '#6675: cartoon combat and weapons in games are allowed');
  assert.ok(RULES.allowed().some((b) => b.startsWith('Pretend-currency games:')),
    '#6675: points-only bets are allowed');
});

test('the built-in copy is the section\'s, so a missing section changes nothing', () => {
  assert.deepEqual([...RULES.FALLBACK.forbidden], RULES.forbidden());
  assert.deepEqual([...RULES.FALLBACK.allowed], RULES.allowed());
  const original = prompts.getConventionSection;
  prompts.getConventionSection = () => null;
  const { mod, restore } = freshRead();
  try {
    assert.deepEqual(mod.forbidden(), [...RULES.FALLBACK.forbidden]);
    assert.deepEqual(mod.allowed(), [...RULES.FALLBACK.allowed]);
  } finally {
    prompts.getConventionSection = original;
    restore();
  }
});

test('a wrapped bullet is one line, and its bold lead names it', () => {
  const original = prompts.getConventionSection;
  prompts.getConventionSection = () => ({
    content: [
      '## Content rules',
      '',
      'Some prose before the lists.',
      '',
      '**Never build, generate, seed or ship:**',
      '',
      '- **A bad thing.** It is bad,',
      '  and worse.',
      '- **Another bad thing,** plainly.',
      '',
      '**Allowed, never a reason to refuse:**',
      '',
      '- **A fine thing:** yes.',
      '- **Fine too,** often.',
      '',
      '**This covers everything the app shows:** more prose.',
    ].join('\n'),
  });
  const { mod, restore } = freshRead();
  try {
    assert.deepEqual(mod.forbidden(), ['A bad thing. It is bad, and worse.', 'Another bad thing, plainly.']);
    assert.deepEqual(mod.allowed(), ['A fine thing: yes.', 'Fine too, often.']);
    assert.deepEqual(mod.heads(mod.forbidden()), ['A bad thing', 'Another bad thing']);
    assert.deepEqual(mod.heads(mod.allowed()), ['A fine thing', 'Fine too']);
    assert.equal(mod.declineSentence(),
      'Content rules: never A bad thing, Another bad thing. Allowed, never a reason to refuse: A fine thing, Fine too.');
  } finally {
    prompts.getConventionSection = original;
    restore();
  }
});

test('the sentence every prompt carries names both lists, with no em dash', () => {
  const said = RULES.declineSentence();
  assert.match(said, /^Content rules: never /);
  assert.match(said, /Real-money gambling/);
  assert.match(said, /\. Allowed, never a reason to refuse: /);
  assert.match(said, /Cartoon and fantasy violence in games/);
  assert.match(said, /Pretend-currency games/);
  assert.doesNotMatch(said, /—/);
  assert.doesNotMatch(said, /\*\*/);
});
