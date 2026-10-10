'use strict';

// The Homeroom bot's notes, in its own voice in Homeroom
// (src/services/homeroom-bot-words.js). Every fixed note the bot posts on a
// request or a change goes through firstPerson for its Homeroom copy; GitHub
// keeps it as written. A new note that still speaks about the bot in the
// third person fails here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { firstPerson } = require('../src/services/homeroom-bot-words');
const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');
const holds = require('../src/services/homeroom-bot-holds');
const dm = require('../src/services/homeroom-bot-dm');

const SPEC = '# Hourly feed refresh\n\nRefresh every hour.';
const BOT = { id: 1, username: 'homeroom_bot' };

function notes() {
  const now = new Date('2026-10-09T12:00:00Z');
  const held = [{ kind: 'claim', username: 'ada', since: '2026-10-08T12:00:00Z' }];
  return [
    live.lookingText(),
    live.questionText({ question: 'Which list?' }),
    live.questionText({ question: 'a', plan: { questions: [{ question: 'One?' }, { question: 'Two?' }] } }),
    live.personText({ reason: 'That changes sign-in.' }),
    live.emptyText({ reason: 'Nothing named.' }),
    live.proposalText({ link: 'https://x/1', prNumber: 12 }),
    live.buildFailedText('budget: wall clock'),
    live.buildFailedText('the turn produced no change'),
    live.buildFailedText('restarted mid-build'),
    live.heldText({ cap: 'proposals_per_app', limit: 5 }),
    live.heldText({ cap: 'proposals_total', limit: 100 }),
    live.heldText({ cap: 'question_tripwire', verdict: 'question', limit: 10 }),
    live.heldText({ cap: 'question_tripwire', verdict: 'plan', limit: 10 }),
    live.blockedText('That needs a payment provider.'),
    live.specCommentText(SPEC),
    live.specCommentText(SPEC, { approved: true }),
    live.planCommentText({ spec: SPEC, questions: [{ question: 'Hourly?', answers: ['Yes'] }] }),
    live.specCard({ sessionId: 1, version: 1, spec: SPEC, bot: BOT }).content,
    live.specCard({ sessionId: 1, version: 1, spec: SPEC, bot: BOT, asking: true }).content,
    live.specCard({ sessionId: 1, version: 1, spec: SPEC, bot: BOT, approved: true }).content,
    followup.answerText({ reply: 'It sorts by date now.' }),
    followup.askText({ reply: 'Which header?' }),
    followup.personText({ reply: 'That is a product call.' }),
    followup.revisedText({ summary: 'Moved the bar into the header.', reply: 'Done.' }),
    followup.revisionFailedText({ why: 'revise: the turn produced no change' }),
    followup.revisionFailedText({ why: 'x', canRevise: false }),
    followup.workingText(),
    followup.waitText('session_busy'),
    followup.waitText('allowance'),
    followup.waitText('budget'),
    followup.waitText('paused'),
    followup.replyFailedText({ why: 'it ran out of time', retrying: true }),
    followup.replyFailedText({ why: 'it ran out of time' }),
    followup.checksRevisedText({ summary: 'Seeded the demo list.' }),
    followup.checksRevisedText({ summary: 'Fixed the save.', broken: true, failing: false }),
    followup.checksRetryText(),
    followup.checksPersonText({ why: 'That needs a decision', failingCount: 2 }),
    followup.checksPersonText({ why: 'x', broken: [{ claim: 'Save works' }] }),
    followup.checksNotChangeText({ failingCount: 1 }),
    holds.leavingText(held, now),
    holds.leavingText([{ kind: 'proposal', username: 'ada', since: '2026-10-08T12:00:00Z' }], now),
    holds.goingText({ asker: 'evan' }),
    holds.goingText({ asker: 'evan', holders: held }),
    dm.updateFailedWords('budget: wall clock', 'this change', 'bot'),
  ];
}

test('every fixed note reads in the bot\'s own voice in Homeroom', () => {
  for (const note of notes()) {
    const own = firstPerson(note);
    assert.doesNotMatch(own, /Homeroom bot/, `still about the bot: ${own}`);
    assert.doesNotMatch(own, /\bit will (look|try) again\b/, `still "it will": ${own}`);
    assert.doesNotMatch(own, /\bIt (will|is|builds)\b/, `still "It": ${own}`);
  }
});

test('the words people and the model wrote pass through unchanged', () => {
  assert.equal(firstPerson('It changes sign-in, so a person decides.'), 'It changes sign-in, so a person decides.');
  assert.equal(firstPerson('The Homeroom bot docs say so.'), 'The Homeroom bot docs say so.');
  assert.equal(firstPerson(''), '');
  assert.equal(firstPerson(null), null);
  assert.equal(
    firstPerson(live.questionText({ question: 'Which list should it use?' })),
    'I have a question before I can build this:\n\nWhich list should it use?\n\nReply here (or on the GitHub issue) and I\'ll look again.',
  );
});

test('a follow-up\'s answer loses its header: the bubble already says who is talking', () => {
  assert.equal(firstPerson(followup.answerText({ reply: 'It sorts by date now.' })), 'It sorts by date now.');
  assert.equal(
    firstPerson(followup.revisedText({ summary: 'Moved the bar into the header.' })),
    'I updated this change: Moved the bar into the header.\n\nEarlier approvals were cleared, so it needs a fresh look.',
  );
});
