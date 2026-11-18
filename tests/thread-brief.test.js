'use strict';

// #6784 (17 Nov 2026): the brief a project made from an idea thread is built
// from (services/homeroom-bot-dm.js threadBrief), pure: the plan agreed in
// the thread, the person's answers and their own words, never an earlier
// reply the bot took back.

const test = require('node:test');
const assert = require('node:assert/strict');

const dm = require('../src/services/homeroom-bot-dm');

const BOT = 9;
const ME = 4;

function said(id, senderId, content, metadata = {}) {
  return { id, sender_id: senderId, content, metadata };
}

const PLAN_LATER = [
  'Here is the plan as it now stands, with a real map and real place search kept.',
  '- Home page: popular public lists, ranked by how many people saved them',
  '- Lists: public or private, who can see each',
  '- Adding places: search, results on a real map, tap one to add it',
  '- Sharing: invite link with a role, or by username; viewer and editor',
].join('\n');

test('the brief holds the newest plan reply, their answers and their own words, and what they sent first', () => {
  const messages = [
    said(10, ME, 'I want an app for saving places into lists.'),
    // An earlier plan the bot took back ("no real maps"): never included.
    said(11, BOT, 'A plan for saved places:\n- Lists only\n- No real maps, use a list of names'),
    said(12, ME, 'Real maps are the whole point.'),
    said(13, BOT, 'You are right, a real map is possible.', { homeroomBot: { newProject: true } }),
    said(14, BOT, 'Before I write the request, two questions.', {
      homeroomBot: {
        card: {
          type: 'questions', v: 1,
          questions: [{ question: 'Who can see a list?' }, { question: 'Who can edit it?' }],
          answered: ['Only people it is shared with', 'Viewers and editors'],
        },
      },
    }),
    said(15, ME, 'Yes, both of those.'),
  ];
  const out = dm.threadBrief({ said: 'Make the plan real.', messages, userId: ME, botId: BOT });
  assert.match(out.brief, /^Make the plan real\./, 'what they sent comes first');
  assert.match(out.brief, /it wins/, 'and the brief says it wins where they differ');
  assert.match(out.brief, /The plan agreed with Homeroom bot in their thread:\nYou are right, a real map is possible\./);
  assert.doesNotMatch(out.brief, /No real maps/, 'an earlier reply the bot took back is left out');
  assert.match(out.brief, /Their answers:\n- Who can see a list\? Only people it is shared with\n- Who can edit it\? Viewers and editors/);
  assert.match(out.brief, /Their own words in the thread \(newest first\):\n- Yes, both of those\.\n- Real maps are the whole point\./);
  assert.equal(out.planText, 'You are right, a real map is possible.', 'the plan text is the same reply, for the source message');
});

test('the newest reply that offered New project is the plan; without one, the newest reply', () => {
  const offered = dm.threadBrief({
    messages: [
      said(1, BOT, 'The plan:\n- One', { homeroomBot: { newProject: true } }),
      said(2, BOT, 'A later remark, no offer'),
    ],
    userId: ME, botId: BOT,
  });
  assert.equal(offered.planText, 'The plan:\n- One', 'its newest offer, not a later aside');

  const none = dm.threadBrief({
    messages: [said(1, BOT, 'The plan:\n- One'), said(2, BOT, 'A later remark')],
    userId: ME, botId: BOT,
  });
  // Neither offered one: the last reply stands for the thread's plan.
  assert.equal(none.planText, 'A later remark');
});

test('nothing said, no bot reply, no answers: the brief is only what there is', () => {
  assert.equal(dm.threadBrief({ messages: [], userId: ME, botId: BOT }).brief, '');
  const own = dm.threadBrief({ messages: [said(1, ME, 'A thought')], userId: ME, botId: BOT });
  assert.equal(own.brief, 'Their own words in the thread (newest first):\n- A thought');
  assert.equal(own.planText, '');
});

test('the brief is cut to 4000 characters', () => {
  const messages = [said(1, BOT, `The plan:\n${'x'.repeat(3800)}`)];
  for (let i = 0; i < 5; i += 1) messages.push(said(10 + i, ME, `${i}${'y'.repeat(399)}`));
  const out = dm.threadBrief({ said: 'z'.repeat(1900), messages, userId: ME, botId: BOT });
  assert.equal(out.brief.length, 4000);
});

test('only an answered questions card gives answers, and each question is named', () => {
  const messages = [
    said(1, ME, 'Answer them'),
    said(2, BOT, 'Two questions, unanswered.', {
      homeroomBot: { card: { type: 'questions', v: 1, questions: [{ question: 'Which?' }], answered: null } },
    }),
    said(3, BOT, 'One answered.', {
      homeroomBot: { card: { type: 'questions', v: 1, questions: [{ question: 'Which?' }], answered: ['That one'] } },
    }),
  ];
  const out = dm.threadBrief({ messages, userId: ME, botId: BOT });
  assert.match(out.brief, /Their answers:\n- Which\? That one/);
  assert.doesNotMatch(out.brief, /unanswered/);
});
