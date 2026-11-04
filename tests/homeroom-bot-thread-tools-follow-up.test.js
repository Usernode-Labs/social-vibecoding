'use strict';

// #6264: "tell me when it's done" in the bot's chat and private threads.
// The tool is offered only in a private turn (the voice has the same one in
// a public place), says the same thing the voice's prompt does, and stores
// its promise through services/thread-followups.js, whose flow against a
// real database is tests/thread-followups-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const tool = require('../src/services/homeroom-bot-thread-tools/follow-up');
const threadTools = require('../src/services/homeroom-bot-thread-tools');

test('offered in a private chat with the bot, never in a public place', () => {
  const ctx = { user: { id: 3 }, deps: {} };
  assert.equal(tool.offered(ctx), true);
  assert.deepEqual(tool.tools(ctx).map((t) => t.function.name), ['tell_me_when']);
  assert.deepEqual(tool.tools({ ...ctx, inPublic: true }), []);
  assert.deepEqual(tool.tools({ deps: {} }), [], 'nobody signed in: nothing to promise them');
  assert.ok(threadTools.toolsFor(ctx).map((t) => t.function.name).includes('tell_me_when'));
  assert.ok(!threadTools.toolsFor({ ...ctx, inPublic: true }).map((t) => t.function.name).includes('tell_me_when'));
});

test('the promise is one of the five moments, and it names the request', () => {
  const [told] = tool.tools({ user: { id: 3 }, deps: {} });
  assert.deepEqual(told.function.parameters.required, ['project', 'number', 'event']);
  assert.deepEqual(told.function.parameters.properties.event.enum, ['update', 'checks', 'vote', 'merged', 'live']);
  assert.match(told.function.description, /stored and kept/);
});

test('its prompt lines say the same as the voice\'s, and are absent in public', () => {
  const lines = tool.promptLines({ user: { id: 3 }, deps: {} }).join('\n');
  assert.match(lines, /call tell_me_when with that one moment and say its/);
  assert.match(lines, /Never tell them you cannot message them later/);
  assert.match(lines, /offer to tell them here when it is ready to vote/);
  assert.deepEqual(tool.promptLines({ user: { id: 3 }, deps: {}, inPublic: true }), []);
});

test('a second promise in one turn is refused', async () => {
  const ctx = { user: { id: 3 }, deps: {}, followedUp: true };
  const out = await tool.run({}, ctx, 'tell_me_when', { project: 'clubs', number: 1, event: 'vote' });
  assert.deepEqual(out, { error: 'One promise per reply: that one is stored.' });
});

test('another module\'s tool is not this one\'s to run', async () => {
  assert.equal(await tool.run({}, { user: { id: 3 }, deps: {} }, 'add_to_build', {}), undefined);
});
