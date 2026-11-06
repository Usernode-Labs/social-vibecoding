'use strict';

// 4 Nov 2026 (#6272): a reply that still wrote its suggested replies into its
// text, under a "Suggestions:" or "You could say:" heading, has them moved
// into the reply tool's suggestions field before anyone sees it. Pinned here:
// what is moved, what is left alone, the button limits, the warning that
// measures the prompt fix, and the prompt that sends them to the field.
//
// Run with: node --test tests/homeroom-bot-lift-suggestions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const mayor = require('../src/services/homeroom-bot-mayor');
const log = require('../src/services/logger');

const HEAD = 'Once it is built, the change runs its checks. When they pass, it goes up for a vote.';

test('the #6209 reply\'s Suggestions: list becomes the buttons, and the text ends before it', () => {
  const text = `${HEAD}\n\nSuggestions:\n`
    + '- So once the checks pass I can vote on it?\n'
    + '- Where do I see the checks?\n'
    + '- Does it build straight away for a simple plan?';
  const out = mayor.liftTextSuggestions(text, [], { appId: 1, thread: '1:issue:7' });
  assert.equal(out.moved, true);
  assert.equal(out.text, HEAD);
  assert.deepEqual(out.suggestions, [
    'So once the checks pass I can vote on it?',
    'Where do I see the checks?',
    'Does it build straight away for a simple plan?',
  ]);
});

test('You could say:, in any case and in bold, is recognised, and markers and quotes are removed', () => {
  for (const heading of ['You could say:', '**Suggestions:**', '**you could say**', '_Suggestions_']) {
    const out = mayor.liftTextSuggestions(
      `${HEAD}\n\n${heading}\n* "Where do I see the checks?"\n* Does it build straight away?`, [], {});
    assert.equal(out.moved, true, heading);
    assert.equal(out.text, HEAD, heading);
    assert.deepEqual(out.suggestions, ['Where do I see the checks?', 'Does it build straight away?'], heading);
  }
  // A numbered list is a list too.
  const numbered = mayor.liftTextSuggestions(`${HEAD}\nSuggestions:\n1. One\n2) Two`, [], {});
  assert.deepEqual(numbered.suggestions, ['One', 'Two']);
});

test('at most three items, each at most 60 characters, a repeat dropped', () => {
  const long = 'x'.repeat(61);
  const four = mayor.liftTextSuggestions(`${HEAD}\nSuggestions:\n- One\n- Two\n- Three\n- Four`, [], {});
  assert.deepEqual(four.suggestions, ['One', 'Two', 'Three']);
  const tooLong = mayor.liftTextSuggestions(`${HEAD}\nSuggestions:\n- ${long}\n- Kept`, [], {});
  assert.deepEqual(tooLong.suggestions, ['Kept']);
  assert.equal(tooLong.text, HEAD, 'the list still goes when an item is too long for a button');
  const allDropped = mayor.liftTextSuggestions(`${HEAD}\nSuggestions:\n- ${long}`, [], {});
  assert.equal(allDropped.moved, true, 'the list is still stripped');
  assert.deepEqual(allDropped.suggestions, []);
  const dupes = mayor.liftTextSuggestions(`${HEAD}\nSuggestions:\n- Go ahead\n- go ahead\n- Not now`, [], {});
  assert.deepEqual(dupes.suggestions, ['Go ahead', 'Not now']);
});

test('what is left alone: suggestions already given, a list mid-text, prose, a list-only reply', () => {
  const given = mayor.liftTextSuggestions(`${HEAD}\nSuggestions:\n- One`, ['Kept as given'], {});
  assert.deepEqual(given, { text: `${HEAD}\nSuggestions:\n- One`, suggestions: ['Kept as given'], moved: false });
  const mid = `${HEAD}\nSuggestions:\n- One\n\nThen more words after it.`;
  assert.equal(mayor.liftTextSuggestions(mid, [], {}).moved, false, 'only a list at the very end moves');
  const prose = `${HEAD}\nSuggestions:\nPlease tell me what you think.`;
  assert.equal(mayor.liftTextSuggestions(prose, [], {}).moved, false, 'a heading over prose is not a list');
  assert.equal(mayor.liftTextSuggestions('Suggestions:\n- One', [], {}).moved, false, 'an empty reply stays as written');
  assert.equal(mayor.liftTextSuggestions(`${HEAD}\nSuggestions:`, [], {}).moved, false, 'a heading with no list');
  assert.equal(mayor.liftTextSuggestions(HEAD, [], {}).moved, false, 'no heading at all');
});

test('a move is logged once, naming the app and thread, so the prompt fix can be measured', () => {
  const warnings = [];
  const realWarn = log.warn;
  log.warn = (component, message, detail) => warnings.push({ component, message, detail });
  try {
    const out = mayor.liftTextSuggestions(`${HEAD}\nSuggestions:\n- ${'x'.repeat(61)}`, [], { appId: 4, thread: '4:issue:7' });
    assert.equal(out.moved, true);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].component, 'homeroom-bot-mayor');
    assert.equal(warnings[0].message, 'Moved a suggestions list out of a reply\'s text');
    assert.deepEqual(warnings[0].detail, { appId: 4, thread: '4:issue:7', count: 0 });
    mayor.liftTextSuggestions(HEAD, [], { appId: 4, thread: '4:issue:7' });
    assert.equal(warnings.length, 1, 'nothing is logged when nothing moves');
  } finally {
    log.warn = realWarn;
  }
});

test('the mayor\'s reply tool stores the lifted text and suggestions', async () => {
  const ctx = { user: { id: 9 }, conversationId: 3, reply: null };
  await mayor.runTool({}, ctx, 'reply', { text: `${HEAD}\nSuggestions:\n- A question?`, cards: [] });
  assert.equal(ctx.reply.text, HEAD);
  assert.deepEqual(ctx.reply.suggestions, ['A question?']);
  assert.deepEqual(ctx.reply.cards, []);
});

test('both prompts send suggestions to the field and forbid a list in the text', () => {
  const mayorPrompt = mayor.systemPrompt({ username: 'ada' });
  assert.match(mayorPrompt, /up to 3 suggestions in the reply tool's suggestions field/);
  assert.match(mayorPrompt, /They are shown as buttons\. Never write them in the text\./);

  const voice = require('../src/services/homeroom-bot-voice');
  const prompt = voice.systemPrompt({
    app: { slug: 'x', name: 'X' },
    place: { type: 'issue', ref: 1 },
    tools: voice.toolsFor({ type: 'issue', ref: 1 }),
  });
  assert.match(prompt, /the\s+reply tool's suggestions field/);
  assert.match(prompt, /They are shown as buttons/);
  assert.match(prompt, /Never\s+write them in the text/);
  assert.doesNotMatch(prompt, /End the reply with one to three short things/);
});
