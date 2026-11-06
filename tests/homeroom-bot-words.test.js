'use strict';

// The Homeroom bot's notes, in its own voice in Homeroom
// (src/services/homeroom-bot-words.js). Every fixed note the bot posts on a
// request or a change goes through firstPerson for its Homeroom copy; GitHub
// keeps it as written. A new note that still speaks about the bot in the
// third person fails here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { firstPerson, plainWords } = require('../src/services/homeroom-bot-words');
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
    live.personText({ reason: 'Sign-in is a platform setting', platform: true, project: 'Plant Pal' }),
    // #6395: a go-ahead cannot settle it, so the copy offers none.
    live.personText({ reason: 'Moving credentials outside this app is operator work.', goAheadDecides: false, firstStep: 'Remove the dead line' }),
    live.personHomeroomText({ reason: 'Moving credentials outside this app is operator work.', goAheadDecides: false, firstStep: 'Remove the dead line' }),
    live.goAheadCannotText({ reason: 'Moving credentials outside this app is operator work.', firstStep: 'Remove the dead line' }),
    live.goAheadCannotText({ reason: 'The whole thing is too big for one build.' }),
    live.emptyText({ reason: 'Nothing named.' }),
    live.proposalText({ link: 'https://x/1', prNumber: 12 }),
    live.liveText({ title: 'Dark mode' }),
    live.retryCommentText(),
    live.buildFailedText('budget: wall clock'),
    live.buildFailedText('the turn produced no change'),
    live.buildFailedText('restarted mid-build'),
    live.buildFailedText('the change was built but could not be proposed: x'),
    live.buildFailedText('the change was built but could not be proposed: x', { firstVersion: true }),
    live.heldText({ cap: 'proposals_per_app', limit: 5 }),
    live.heldText({ cap: 'proposals_per_app', limit: 5, project: 'Plant Pal' }),
    live.heldText({ cap: 'proposals_total', limit: 100 }),
    live.heldText({ cap: 'builds_per_app', limit: 5, project: 'Plant Pal' }),
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
    followup.checksRevisedText({ failing: [{ name: 'Saving a list keeps it' }] }),
    followup.checksRevisedText({ failing: [{ name: 'a' }, { name: 'b' }], broken: [{ claim: 'Save works' }] }),
    followup.checksRevisedText({ broken: [{ claim: 'Save works' }] }),
    followup.checksRetryText(),
    // #6234: the fix's start line (checksFixingText), in each of its shapes.
    followup.checksFixingText({ failing: [{ name: 'Saving a list keeps it' }] }),
    followup.checksFixingText({ failing: [{ name: 'a' }, { name: 'b' }] }),
    followup.checksFixingText({ failing: [{ name: 'Saving a list keeps it' }], broken: [{ claim: 'Save works' }] }),
    followup.checksFixingText({ broken: [{ claim: 'Save works' }] }),
    followup.checksFixingText({ skipped: [{ claim: 'The list shows ten items' }] }),
    followup.checksPersonText({ why: 'That needs a decision', failingCount: 2 }),
    followup.checksPersonText({ why: 'x', broken: [{ claim: 'Save works' }] }),
    followup.checksPersonText({ why: 'it has already updated this change 3 times, as many as it may on its own', failingCount: 1 }),
    followup.checksPersonText({ why: 'its attempt to fix them ran out of time', failingCount: 2 }),
    followup.checksRetryText({ skipped: true, failing: false }),
    followup.checksRevisedText({ skipped: [{ claim: 'The list shows ten items' }] }),
    followup.checksRevisedText({ skipped: [{}, {}] }),
    followup.replyFailedText({ why: 'it ran out of time' }),
    followup.replyFailedText({ why: 'something went wrong while it worked on it', retrying: true }),
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

// One request, one story: in Homeroom the bot speaks of itself in the first
// person and in whole sentences, and in Homeroom's words: a request, a
// change, never an issue or a proposal, and no pull request number.
test('every fixed note uses Homeroom\'s words, and the bot never speaks of itself as "it"', () => {
  for (const note of notes()) {
    const own = firstPerson(note);
    assert.doesNotMatch(own, /\bissue\b|\bproposal\b|PR #\d/i, `not Homeroom's words: ${own}`);
    assert.doesNotMatch(own, /\bits attempt\b|\bit ran out of time\b|\bas many as it may\b|\bwhile it worked\b/, `still "it": ${own}`);
  }
});

// #6234: the fix's start line, said by the bot.
test('#6234: the fix\'s start line and the hand-off\'s ending are said in the first person', () => {
  assert.equal(firstPerson(followup.checksFixingText({ failing: [{ name: 'Saving a list keeps it' }] })),
    'I\'m fixing the failing check "Saving a list keeps it". I\'ll say here when it\'s done.');
  assert.equal(firstPerson(followup.checksFixingText({ failing: [{ name: 'a' }, { name: 'b' }] })),
    'I\'m fixing the 2 failing checks on this change. I\'ll say here when it\'s done.');
  assert.equal(firstPerson(followup.checksFixingText({ skipped: [{}] })),
    'I\'m adding the sample data this change\'s before and after screens need. I\'ll say here when it\'s done.');
  assert.equal(firstPerson(followup.checksPersonText({ why: 'That needs a decision', failingCount: 2 })),
    'I can\'t get this change past its checks on my own: 2 checks are still failing. That needs a decision. '
    + 'The person who asked for it, or any member of this project, can take it from here.');
});

test('the words people and the model wrote pass through unchanged', () => {
  assert.equal(firstPerson('It changes sign-in, so a person decides.'), 'It changes sign-in, so a person decides.');
  assert.equal(firstPerson('The Homeroom bot docs say so.'), 'The Homeroom bot docs say so.');
  assert.equal(firstPerson(''), '');
  assert.equal(firstPerson(null), null);
  assert.equal(
    firstPerson(live.questionText({ question: 'Which list should it use?' })),
    // "Issue" is GitHub's word: in Homeroom the request is where you reply.
    'I have a question before I can build this:\n\nWhich list should it use?\n\nReply here and I\'ll look again.',
  );
});

// #6311: a note's reason is said in plain words, and the platform note says
// what the copy does. None of the bot's own instructions reach a member.
test('#6311: a note built from internal words comes out in plain words, first person', () => {
  const reason = 'Per the platform conventions, in this checkout the live head commit is fine, '
    + 'this build agent cannot change it, and Homeroom bot confirmed a person must authorize/route the check.';
  const own = live.personHomeroomText({ reason, platform: true, project: 'Plant Pal' });
  for (const word of ['checkout', 'head commit', 'build agent', 'platform conventions', 'Homeroom bot', 'authorize/route']) {
    assert.doesNotMatch(own, new RegExp(word.replace('/', '\\/'), 'i'), `still internal: ${own}`);
  }
  assert.match(own, /I confirmed a person needs to decide the check/, 'the bot speaks as I');
  assert.match(own, /I can put it on Homeroom's own board too and keep this request open here\.$/);
  // The question and the empty note go through the same rewrite.
  assert.doesNotMatch(firstPerson(live.questionText({ question: 'In this checkout, which list?' })), /checkout/i);
  assert.doesNotMatch(firstPerson(live.emptyText({ reason: 'The head commit names nothing.' })), /head commit/i);
  assert.equal(plainWords('in this checkout'), 'in the project\'s code');
  assert.equal(plainWords(''), '');
});

test('#6395: a go-ahead that cannot settle it says what can be built, and names no Go ahead', () => {
  const own = live.personHomeroomText({
    reason: 'It moves credentials outside this app.', goAheadDecides: false,
    firstStep: 'Remove the dead bot token line',
  });
  assert.equal(own, 'I can\'t build all of this one: It moves credentials outside this app. '
    + 'I can do this part here: Remove the dead bot token line.');
  assert.doesNotMatch(own, /Go ahead/i);
  assert.doesNotMatch(own, /@/, 'it names nobody who can say Go ahead');
  assert.equal(live.goAheadCannotText({ reason: 'It moves credentials outside this app.', firstStep: 'Remove the dead line' }),
    'A go-ahead can\'t change this one: It moves credentials outside this app. '
    + 'I can do this part here: Remove the dead line.');
  assert.equal(live.goAheadCannotText({ reason: 'The whole thing is too big for one build.' }),
    'A go-ahead can\'t change this one: The whole thing is too big for one build. '
    + 'Reply here if a smaller part would help.');
  assert.doesNotMatch(live.goAheadCannotText({ reason: 'x', firstStep: 'Do the small part' }), /—/);
});

test('a follow-up\'s answer loses its header: the bubble already says who is talking', () => {
  assert.equal(firstPerson(followup.answerText({ reply: 'It sorts by date now.' })), 'It sorts by date now.');
  assert.equal(
    firstPerson(followup.revisedText({ summary: 'Moved the bar into the header.' })),
    // One note per update: the cleared votes are the platform's line to say.
    'I updated this change: Moved the bar into the header.',
  );
});
