'use strict';

// What a visible declaration's answer says about the data the before &
// after copies hold (src/services/shots-ready-states.js): the ready-made
// states by name, where anything else comes from, and a warning only for a
// change whose own words name a state no ready-made state holds and that
// says nothing of how to make it (hints.setup). The words of the changes
// that ended with no shots for want of data are the cases here.

const test = require('node:test');
const assert = require('node:assert/strict');
const readyStates = require('../src/services/shots-ready-states');
const demoStates = require('../src/services/shots-demo-states');

const story = (id, claim, { persona = 'member', steps = ['Open it'], setup = null } = {}) => ({
  id, claim, persona,
  intent: { startPath: '/', steps, checkpoint: 'It shows', focus: 'It', ...(setup ? { hints: { setup } } : {}) },
});
const declare = (...stories) => ({ version: 1, impact: 'ui', rationale: 'A change.', stories });
const warned = (intent, selfApp) => readyStates.declarationAdvice(intent, { selfApp }).warnings;

test('every demo state is a ready-made state with a name, in the same order, for its persona', () => {
  assert.deepEqual(readyStates.READY_STATES.map((state) => state.id), demoStates.STATE_IDS);
  for (const [index, state] of readyStates.READY_STATES.entries()) {
    assert.equal(state.personas[0], demoStates.STATES[index].persona, state.id);
    assert.ok(state.name.length > 10 && state.name.length < 90, state.id);
  }
  const ids = new Set(demoStates.STATE_IDS);
  for (const need of readyStates.NEEDS) {
    assert.ok(need.states.every((id) => ids.has(id)), need.needs);
  }
});

test('Homeroom\'s answer lists the ready-made states; a child app\'s says it has none and where its data comes from', () => {
  const own = readyStates.declarationAdvice(declare(story('a', 'The settings page groups its rows.')), { selfApp: true });
  assert.equal(own.availableStates.length, demoStates.STATE_IDS.length);
  assert.deepEqual(Object.keys(own.availableStates[0]), ['name', 'personas']);
  assert.match(own.dataNote, /src\/db\/migrate\.js/);
  assert.match(own.dataNote, /hints\.setup/);
  assert.match(own.dataNote, /reaches only the after copy/);
  assert.deepEqual(own.warnings, []);

  const child = readyStates.declarationAdvice(declare(story('a', 'The list shows its items.')), { selfApp: false });
  assert.deepEqual(child.availableStates, []);
  assert.match(child.dataNote, /IS_STAGING seed/);
  assert.match(child.dataNote, /no ready-made states/);
  assert.deepEqual(child.warnings, []);

  // Nothing to shoot, nothing to say.
  assert.equal(readyStates.declarationAdvice({ version: 1, impact: 'none', rationale: 'x', stories: [] }), null);
  assert.equal(readyStates.declarationAdvice(null), null);
  assert.equal(readyStates.declarationAdvice({ impact: 'ui', stories: 'nope' }), null);
});

test('the states that cost changes their shots are ready-made on Homeroom\'s copies, and named on a child app\'s', () => {
  const held = declare(
    story('approval-chip', 'Hide Build it now while a change awaits approval.'),
    story('activity-times', 'Points activities show when they happened.',
      { steps: ['Open the Leaderboard standings', 'Open a row'] }),
    story('bot-thanks', 'Homeroom bot thanks you for answering its plan, with your app\'s card.'),
  );
  assert.deepEqual(warned(held, true), [], 'each has a ready-made state');
  const child = warned(held, false);
  assert.equal(child.length, 3);
  assert.match(child[0], /^approval-chip seems to need a change waiting for approval, and this app's copies have no ready-made states\./);
  assert.match(child[0], /seed it in the app's own staging seed \(its IS_STAGING seed\) in a change merged before this one/);
  assert.match(child[1], /^activity-times seems to need standings rows with recorded activities/);
  assert.match(child[2], /^bot-thanks seems to need an answered first-version plan/);
});

test('a change needing a state no ready-made state holds is warned about, once per state', () => {
  const warnings = warned(declare(
    story('tour-plan', 'The tour\'s last card names the plan.'),
    story('invited-home', 'An invited private member who has not been Home yet sees a welcome.'),
    story('waitlisted', 'A signed-in private member on the waitlist sees when they get in.'),
    story('tour-again', 'Only the first-session tour says it.'),
  ), true);
  assert.deepEqual(warnings.map((w) => w.split(' to need ')[0]), [
    'tour-plan, tour-again seem',
    'invited-home seems',
    'invited-home seems',
    'waitlisted seems',
  ]);
  assert.match(warnings[0], /a member in their first session \(its tour\), and no ready-made state on these copies holds it \(see availableStates\)/);
  assert.match(warnings[0], /seed it in the staging seeds in src\/db\/migrate\.js/);
  assert.match(warnings[0], /a seed this proposal adds reaches only the after copy\.$/);
  assert.match(warnings[1], /an account somebody invited/);
  assert.match(warnings[2], /an empty state, or an account with nothing of its own yet/);
  assert.match(warnings[3], /an account on the waitlist/);

  // A child app's empty state its own seed fills (Todo List #90).
  assert.equal(warned(declare(story('no-lists', 'A new user with no lists sees how to start one.')), false).length, 1);
});

test('no warning when the author says how to make it, for the guest\'s own state, or for ordinary words', () => {
  assert.deepEqual(warned(declare(story('empty', 'No lists yet shows a Start button.',
    { setup: 'Delete every list from its menu first' })), false), []);
  assert.deepEqual(warned(declare(story('landing', 'A first-time visitor sees the landing page.',
    { persona: 'guest' })), true), []);
  for (const claim of [
    'The settings page groups notifications under one heading.',
    'Say plan where people read spec.',
    'The Invite people sheet shows a QR code.',
    'Requests board rows say how long ago each was asked.',
    'The proposal card shows its vote tally on one line.',
    'Messages are drawn with the new avatar ring.',
  ]) {
    assert.deepEqual(warned(declare(story('ordinary', claim)), true), [], claim);
    assert.deepEqual(warned(declare(story('ordinary', claim)), false), [], claim);
  }
  // The steps and the checkpoint are its words too.
  assert.equal(warned(declare(story('steps', 'The card has a new line.',
    { steps: ['Open the hub as a member on the waitlist'] })), true).length, 1);
});
