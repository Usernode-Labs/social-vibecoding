'use strict';

// #6869: a yes to the part the bot offered. Pure: which runs offered a part,
// which replies accept it, and the words that say it started.

const test = require('node:test');
const assert = require('node:assert/strict');

const part = require('../src/services/homeroom-bot-part');

test('#6869: a live person run that named a part to build offered it', () => {
  assert.equal(part.partOffered({
    mode: 'live', verdict: 'person', first_step: 'A clear reload message', go_ahead_decides: false, go_ahead_blocker: 'operator_work',
  }), true);
  assert.equal(part.partOffered({
    mode: 'live', verdict: 'person', first_step: 'A clear reload message', about_platform: true,
  }), true, 'a note about Homeroom itself offered a part too');
  assert.equal(part.partOffered({ mode: 'live', verdict: 'person', first_step: '' }), false);
  assert.equal(part.partOffered({ mode: 'shadow', verdict: 'person', first_step: 'x', about_platform: true }), false);
  assert.equal(part.partOffered({ mode: 'live', verdict: 'ready', first_step: 'x' }), false);
  assert.equal(part.partOffered(null), false);
});

test('#6869: the part\'s own words, a yes or a go-ahead accept it', () => {
  const step = 'A clear reload message when a screen fails to load';
  assert.equal(part.acceptsPart(step, step), true);
  assert.equal(part.acceptsPart(`${step}.`, step), true, 'a trailing full stop does not matter');
  assert.equal(part.acceptsPart(`  ${step.toUpperCase()} `, step), true);
  assert.equal(part.acceptsPart('Yes', step), true);
  assert.equal(part.acceptsPart('yes please', step), true);
  assert.equal(part.acceptsPart('Go ahead', step), true);
  assert.equal(part.acceptsPart('Build it', step), true);
  assert.equal(part.acceptsPart('What about the settings page?', step), false);
  assert.equal(part.acceptsPart('', step), false);
});

test('#6869: the answer names the part as its own request', () => {
  assert.equal(part.partStartedText('A clear reload message when a screen fails to load', 31),
    'Building a clear reload message when a screen fails to load now, as its own request #31. '
    + 'It\'s linked to this one, and its plan comes next.');
});
