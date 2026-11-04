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
  assert.match(lines, /request still being built or queued/);
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

// ── #6255: a request still being built, before any change is up for a vote ──

const followupsLib = require('../src/services/thread-followups');

function ctxWith() {
  const calls = [];
  const app = { id: 7, slug: 'clubs', name: 'Clubs' };
  const ctx = {
    user: { id: 3 }, settings: {}, config: {}, conversationId: 41,
    deps: {
      dm: { botAccount: async () => ({ id: 99 }) },
      live: { openBotProposal: async () => null },
      mayor: {
        findApp: async () => app,
        canView: async () => true,
        progressOf: async () => ({ rightNow: [] }),
      },
      followups: {
        register: async (_pool, opts) => {
          calls.push(opts);
          return { ok: true, id: 1, promise: followupsLib.promiseFor(opts.event) };
        },
      },
    },
  };
  return { ctx, calls };
}

test('a request still being built can be promised, and its update is its vote', async () => {
  const { ctx, calls } = ctxWith();
  ctx.deps.mayor.progressOf = async () => ({ rightNow: [{ project: 'clubs', number: 1, doing: 'building it' }] });
  const out = await tool.run({}, ctx, 'tell_me_when', { project: 'clubs', number: 1, event: 'update' });
  assert.equal(out.ok, true);
  assert.equal(out.promise, "I'll tell you here when it's ready to vote.");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, null);
  assert.equal(calls[0].issueNumber, 1);
  assert.equal(calls[0].event, 'vote');
  assert.deepEqual(calls[0].place, { type: 'dm', ref: null });
  assert.equal(calls[0].conversationId, 41);
  assert.equal(ctx.followedUp, true);
});

test('checks on a request still being built means vote, and later moments are kept', async () => {
  const one = ctxWith();
  one.ctx.deps.mayor.progressOf = async () => ({ rightNow: [{ project: 'clubs', number: 1 }] });
  await tool.run({}, one.ctx, 'tell_me_when', { project: 'clubs', number: 1, event: 'checks' });
  assert.equal(one.calls[0].event, 'vote');
  const two = ctxWith();
  two.ctx.deps.mayor.progressOf = async () => ({ rightNow: [{ project: 'clubs', number: 1 }] });
  await tool.run({}, two.ctx, 'tell_me_when', { project: 'clubs', number: 1, event: 'merged' });
  assert.equal(two.calls[0].event, 'merged');
});

test('a request the bot started in this reply is in progress, without reading progress', async () => {
  const { ctx, calls } = ctxWith();
  ctx.started = 'Clubs request #1';
  ctx.cards = [{ type: 'issue', appId: 7, issueNumber: 1 }];
  let read = false;
  ctx.deps.mayor.progressOf = async () => { read = true; return { rightNow: [] }; };
  const out = await tool.run({}, ctx, 'tell_me_when', { project: 'clubs', number: 1, event: 'vote' });
  assert.equal(out.ok, true);
  assert.equal(calls[0].issueNumber, 1);
  assert.equal(read, false, 'what it started this turn is already known');
});

test('with nothing being built, the promise is refused and nothing is stored', async () => {
  const { ctx, calls } = ctxWith();
  const out = await tool.run({}, ctx, 'tell_me_when', { project: 'clubs', number: 1, event: 'vote' });
  assert.equal(out.ok, false);
  assert.match(out.error, /Nothing is being built on Clubs request #1/);
  assert.match(out.error, /Nothing was stored\. Offer to start it\./);
  assert.equal(calls.length, 0);
  assert.equal(ctx.followedUp, undefined);
});

test('work on another request or project is not this request', async () => {
  const { ctx, calls } = ctxWith();
  ctx.deps.mayor.progressOf = async () => ({ rightNow: [{ project: 'chores', number: 1 }, { project: 'clubs', number: 2 }] });
  const out = await tool.run({}, ctx, 'tell_me_when', { project: 'clubs', number: 1, event: 'vote' });
  assert.equal(out.ok, false);
  assert.match(out.error, /Nothing is being built/);
  assert.equal(calls.length, 0);
});

test('a change already up for a vote is still stored by its session', async () => {
  const { ctx, calls } = ctxWith();
  ctx.deps.live.openBotProposal = async () => ({ id: 55 });
  const out = await tool.run({}, ctx, 'tell_me_when', { project: 'clubs', number: 1, event: 'update' });
  assert.equal(out.ok, true);
  assert.equal(calls[0].sessionId, 55);
  assert.equal(calls[0].issueNumber, null);
  assert.equal(calls[0].event, 'update');
});
