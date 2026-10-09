'use strict';

// What the Homeroom bot writes for people has no em dashes (5 Oct 2026).
//
// Its change descriptions, which every member reads on the change page and
// which lead the pull request's body, kept them: "Members do nothing extra —
// finishing a book happens by picking the next one." The prompts now say
// "no em dashes", and, because a model does not always do as it is told,
// the text is made dash-free where it is saved (src/services/em-dashes.js,
// pinned on its own in tests/em-dashes.test.js):
//   - the change's description and name, and what the build said
//     (homeroom-bot-live.js buildDescription, proposalTitle, prepareProposal);
//   - the spec, its card and the half that can become the description
//     (readSpec), and why it could not be built (specBlocked);
//   - a follow-up's reply, summary, new name and suggested answers
//     (homeroom-bot-followup.js parseFollowUp);
//   - a triage's question, its answers, a first version's plan and why a
//     person should decide (homeroom-bot.js parseVerdict);
//   - the bot's DM replies and the requests it offers to file
//     (homeroom-bot-mayor.js cleanReply, offer_request).
//
// Run with: node --test tests/homeroom-bot-no-em-dashes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');
const bot = require('../src/services/homeroom-bot');
const mayor = require('../src/services/homeroom-bot-mayor');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const EM = '—';
const DASH = /—/;

const BUILD_TEXT = [
  'Done. Committed as e1d33fa. Ran `npm test` and it passed.',
  '',
  '==== DESCRIPTION ====',
  `Members do nothing extra ${EM} finishing a book happens by picking the next one.`,
  `Everything else on the card ${EM} the hosting label, the date, the 7:00 pm time and the countdown ${EM} is unchanged.`,
  '==== END DESCRIPTION ====',
].join('\n');

const SPEC = [
  `# Pick the next book ${EM} finishing the current one`,
  '',
  '## User-facing changes',
  '',
  `Members pick the next book from the card ${EM} the old one is marked finished.`,
  '',
  '### Assumptions',
  '',
  `- Only members can pick ${EM} anyone else sees the card.`,
  '',
  '## Technical implementation',
  '',
  `Edit \`public/app.js\`: the \`next ${EM} book\` handler.`,
].join('\n');

test('the change\'s description, as the group reads it, has no em dash: the 5 October sentences', () => {
  const built = live.buildDescription({ text: BUILD_TEXT, spec: SPEC });
  assert.equal(built.description, [
    'Members do nothing extra: finishing a book happens by picking the next one.',
    'Everything else on the card (the hosting label, the date, the 7:00 pm time and the countdown) is unchanged.',
  ].join('\n'));
  assert.doesNotMatch(built.ccOutput, DASH);
  assert.match(built.ccOutput, /`npm test`/, 'what the build said keeps its code');
  // Without a DESCRIPTION block, the spec's user-facing half is the description: also without.
  const fromSpec = live.buildDescription({ text: 'Done.', spec: SPEC });
  assert.equal(live.buildDescription({ text: '', spec: SPEC }).description,
    'Members pick the next book from the card: the old one is marked finished.');
  assert.doesNotMatch(String(fromSpec.description), DASH);
  // Nothing to say is still nothing.
  assert.deepEqual(live.buildDescription({ text: '', spec: null }), { ccOutput: '', description: null });
});

test('the change\'s name has no em dash, and the labels it drops are still dropped', () => {
  assert.equal(live.proposalTitle(SPEC), 'Pick the next book: finishing the current one');
  assert.equal(live.proposalTitle(`# Climbing sessions ${EM} who's in and who drives`), 'Climbing sessions: who\'s in and who drives');
  assert.equal(live.proposalTitle(`# Show quota changes as a sentence ${EM} #3233`), 'Show quota changes as a sentence');
  assert.equal(live.proposalTitle(`# Spec ${EM} Show the reason beside each credit`), 'Show the reason beside each credit');
});

test('prepareProposal saves the name and the description without em dashes', async () => {
  const seq = [];
  const pool = { async query(sql, params) { seq.push({ sql: String(sql), params }); return { rows: [] }; } };
  const out = await live.prepareProposal({
    pool, bot: { id: 77 }, sessionId: 5001, spec: SPEC, buildText: BUILD_TEXT, model: 'm',
  });
  assert.equal(out.title, 'Pick the next book: finishing the current one');
  assert.doesNotMatch(out.description, DASH);
  const row = seq.find((q) => /INSERT INTO chat_session_messages/.test(q.sql));
  const meta = JSON.parse(row.params[2]);
  assert.doesNotMatch(meta.proposalDescription, DASH);
  assert.doesNotMatch(meta.ccOutput, DASH);
  const named = seq.find((q) => /SET proposed_pr_title = \$1/.test(q.sql));
  assert.equal(named.params[0], 'Pick the next book: finishing the current one');
});

test('the spec, its card and its BLOCKED line have no em dash outside code', () => {
  const spec = live.readSpec(SPEC);
  assert.equal(spec.ok, true);
  assert.equal(spec.specMd.split('\n')[0], '# Pick the next book: finishing the current one');
  assert.match(spec.specMd, /Members pick the next book from the card: the old one is marked finished\./);
  assert.match(spec.specMd, /- Only members can pick: anyone else sees the card\./);
  assert.ok(spec.specMd.includes(`\`next ${EM} book\``), 'code in the spec is as it was');
  assert.equal(live.specBlocked(`BLOCKED: there is no calendar ${EM} the app stores no dates.`),
    'there is no calendar: the app stores no dates.');
});

test('a follow-up\'s reply, summary, name and answers have no em dash', () => {
  const block = (obj) => `Notes.\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
  const revised = followup.parseFollowUp(block({
    action: 'revise',
    reply: `Done ${EM} the In button is green now.`,
    summary: `Made the In button green ${EM} and the Out button grey.`,
    title: `Green In button ${EM} grey Out button`,
  }));
  assert.equal(revised.reply, 'Done: the In button is green now.');
  assert.equal(revised.summary, 'Made the In button green, and the Out button grey.');
  assert.equal(revised.title, 'Green In button: grey Out button');
  const ask = followup.parseFollowUp(block({
    action: 'ask', reply: `Which colour ${EM} green or blue?`, answers: [`Green ${EM} like the logo`, 'Blue'],
  }));
  assert.equal(ask.reply, 'Which colour: green or blue?');
  assert.deepEqual(ask.answers, ['Green, like the logo', 'Blue']);
  // The turn is asked for it too, in both prompts.
  const prompt = followup.followUpPrompt({ seed: 'S', replies: [], canRevise: true });
  assert.match(prompt, /without em dashes: use a comma, a colon or a full stop\./);
  assert.match(followup.checksFixPrompt({ seed: 'S', failing: [{ name: 'x', reason: 'y' }], total: 1 }),
    /without em dashes: use a comma, a colon or a full stop\./);
});

test('a triage\'s question, answers, plan and reason have no em dash', () => {
  const verdict = (obj) => bot.parseVerdict(`\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``);
  const question = verdict({
    verdict: 'question', blocker: 'user_facing', why_default_fails: 'x',
    question: `Who drives ${EM} the host or anyone?`, default: `Anyone ${EM} first come`, answers: ['The host'],
  });
  assert.equal(question.question, 'Who drives: the host or anyone?');
  assert.deepEqual(question.questionAnswers, ['Anyone: first come', 'The host']);
  const ready = verdict({
    verdict: 'ready', build_note: 'Edit a.js.',
    plan: [`A countdown ${EM} days to the next session`, 'Who is in'],
    choices: [{ question: `Show drivers ${EM} or not?`, answers: ['Yes', `No ${EM} not yet`], default: 'Yes' }],
  });
  assert.deepEqual(ready.plan.bullets, ['A countdown: days to the next session', 'Who is in']);
  assert.equal(ready.plan.questions[0].question, 'Show drivers, or not?');
  assert.deepEqual(ready.plan.questions[0].answers, ['Yes', 'No, not yet']);
  const person = verdict({ verdict: 'person', reason: `It is a policy choice ${EM} the group decides.` });
  assert.equal(person.reason, 'It is a policy choice: the group decides.');
  assert.equal(bot.parseVerdict('no verdict here'), null);
  assert.match(read('src/prompts/homeroom-bot-triage.md'), /no em dashes \(use a comma, a colon or a full stop\): people read them\./);
});

test('the build and the spec are asked for no em dashes', () => {
  const build = live.buildPrompt({ seed: 'ISSUE', buildNote: 'Edit a.js.', spec: SPEC });
  assert.match(build, /No em dashes: use a comma, a colon or a full stop\./);
  const spec = live.specPrompt({ seed: 'ISSUE', buildNote: 'Edit a.js.' });
  assert.match(spec, /- Written without em dashes: use a comma, a colon or a full stop\./);
});

test('the bot\'s DM replies, and the requests it offers to file, have no em dash', () => {
  assert.equal(mayor.cleanReply(`[about x] It's on your list ${EM} I'll start it next.`), 'It\'s on your list. I\'ll start it next.');
  const src = read('src/services/homeroom-bot-mayor.js');
  // #4605: the normaliser moved into draftFromArgs, which the offer_request
  // case and its failed-attempt record both share.
  assert.match(src, /title: clip\(withoutEmDashes\(String\(args\.title \|\| ''\)/);
});
