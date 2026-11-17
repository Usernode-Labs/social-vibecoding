'use strict';

// #6771: a request filed on one project's board that is really about another
// app. The triage names the app (`elsewhere`), the server resolves it against
// what the requester can see, and the note offers a move there. These are the
// pieces a database is not needed for: the verdict, the resolution (with the
// project lookup stood in for), the card's words and the note's sentences.
//
// Run with: node --test tests/homeroom-bot-elsewhere.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const move = require('../src/services/homeroom-bot-move');
const cards = require('../src/services/bot-cards');
const mayor = require('../src/services/homeroom-bot-mayor');

const reply = (verdict) => `I read the request.\n\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``;

test('#6771: a bread-timer bug on Homeroom\'s board naming Bread Bot is about another project', () => {
  const parsed = bot.parseVerdict(reply({
    verdict: 'person',
    reason: 'The timer that skips the second rise is Bread Bot\'s, not Homeroom.',
    elsewhere: 'Bread Bot',
  }));
  assert.equal(parsed.verdict, 'person');
  assert.equal(parsed.elsewhere, 'Bread Bot');
  assert.deepEqual(parsed.elsewhereCandidates, []);
  assert.equal(parsed.platform, false);
  assert.equal(parsed.done, false, 'a request elsewhere is never "done here"');
  assert.equal(parsed.withdrawn, false);
  assert.equal(parsed.goAheadDecides, null, 'no Go ahead is offered');
});

test('#6771: candidates come back when the read cannot tell which app it is', () => {
  const parsed = bot.parseVerdict(reply({
    verdict: 'person',
    reason: 'It is about a brewing timer, but the request does not say which app.',
    elsewhere_candidates: ['Brew Buddy', 'Coffee Clock', 'Brew Buddy'],
  }));
  assert.equal(parsed.elsewhere, null);
  assert.deepEqual(parsed.elsewhereCandidates, ['Brew Buddy', 'Coffee Clock', 'Brew Buddy']);
});

test('#6771: platform wins when a read says both, and elsewhere is dropped', () => {
  const parsed = bot.parseVerdict(reply({
    verdict: 'person',
    reason: 'About the platform.',
    platform: true,
    elsewhere: 'Bread Bot',
    elsewhere_candidates: ['Bread Bot'],
  }));
  assert.equal(parsed.platform, true);
  assert.equal(parsed.elsewhere, null);
  assert.deepEqual(parsed.elsewhereCandidates, []);
});

test('#6771: resolveElsewhere names the project the request names, and asks to join when needed', async () => {
  const source = { id: 1, slug: 'homeroom', name: 'Homeroom' };
  const target = { id: 2, slug: 'bread-bot', name: 'Bread Bot', view_visibility: 'public' };
  const real = { findApp: mayor.findApp, canView: mayor.canView, canFile: mayor.canFile };
  let canFile = true;
  mayor.findApp = async (_pool, name) => (String(name).toLowerCase() === 'bread bot' ? target : null);
  mayor.canView = async (_pool, app) => Number(app.id) === Number(target.id);
  mayor.canFile = async () => canFile;
  try {
    assert.deepEqual(await move.resolveElsewhere(new (class { query() {} })(), { app: source, name: 'Bread Bot' }),
      { target, join: false });
    canFile = false;
    assert.deepEqual(await move.resolveElsewhere({}, { app: source, name: 'Bread Bot' }),
      { target, join: true }, 'a project they can see but have not joined is joined first');
    // Never the board it is already on; an app they cannot see is not named.
    assert.equal(await move.resolveElsewhere({}, { app: target, name: 'Bread Bot' }), null);
    assert.equal(await move.resolveElsewhere({}, { app: source, name: 'Homeroom' }), null);
  } finally {
    Object.assign(mayor, real);
  }
});

test('#6771: resolveElsewhere falls back to the candidates it can show', async () => {
  const real = { findApp: mayor.findApp, canView: mayor.canView, canFile: mayor.canFile };
  const apps = {
    'brew buddy': { id: 2, slug: 'brew-buddy', name: 'Brew Buddy' },
    'coffee clock': { id: 3, slug: 'coffee-clock', name: 'Coffee Clock' },
  };
  mayor.findApp = async (_pool, name) => apps[String(name).toLowerCase()] || null;
  mayor.canView = async (_pool, app) => Number(app.id) === 2;
  mayor.canFile = async () => false;
  try {
    assert.deepEqual(
      await move.resolveElsewhere({}, { app: { id: 1 }, candidates: ['Brew Buddy', 'Coffee Clock'] }),
      { candidates: ['Brew Buddy'] },
    );
  } finally {
    Object.assign(mayor, real);
  }
});

test('#6771: a move offer names its project, and offers to join first', () => {
  assert.deepEqual(
    cards.offerActions('move_request', 7, { targetName: 'Bread Bot' }).map((a) => a.label),
    ['Move it to Bread Bot', 'Keep it here'],
  );
  assert.deepEqual(
    cards.offerActions('move_request', 7, { targetName: 'Bread Bot', join: true }).map((a) => a.label),
    ['Join Bread Bot and move it', 'Keep it here'],
  );
  assert.deepEqual(
    cards.offerActions('move_request', 7).map((a) => a.label),
    ['Move it to Homeroom', 'Keep it here'],
  );
});

test('#6771: an elsewhere note says where it belongs, or asks which app', () => {
  const offered = live.personHomeroomText({
    reason: 'The timer that skips the second rise is Bread Bot\'s.', project: 'Homeroom', elsewhere: 'Bread Bot',
  });
  assert.match(offered, /I think this is about Bread Bot, not Homeroom/);
  assert.match(offered, /I can move it to Bread Bot's board, with its discussion, and close it here\./);
  const join = live.personHomeroomText({
    reason: 'It is Bread Bot\'s.', project: 'Homeroom', elsewhere: 'Bread Bot', elsewhereJoin: true,
  });
  assert.match(join, /You are not a member of Bread Bot yet, so tapping below joins you first\./);
  const asked = live.personHomeroomText({
    reason: 'It is about a brewing timer.', project: 'Homeroom', candidates: ['Brew Buddy', 'Coffee Clock'],
  });
  assert.match(asked, /Which one is it: Brew Buddy or Coffee Clock\?/);
  const github = live.personText({ reason: 'Bread Bot\'s timer.', project: 'Homeroom', elsewhere: 'Bread Bot' });
  assert.match(github, /It can move it to Bread Bot's board/);
});

test('#6771: no Go ahead is offered under an elsewhere note', () => {
  assert.deepEqual(live.personSuggestions({ firstStep: 'Just the triage part', elsewhere: true }), []);
  assert.deepEqual(live.personSuggestions({ firstStep: 'Just the triage part', candidates: ['Bread Bot'] }), []);
});

test('#6771: the moved body carries the people\'s discussion, and never a private project\'s', () => {
  const messages = [{ username: 'sam', content: 'Same here' }, { username: 'ada', content: 'It skips the rise' }];
  const publicBody = move.discussionSection({ app: { view_visibility: 'public' }, messages });
  assert.match(publicBody, /@sam: Same here/);
  assert.match(publicBody, /@ada: It skips the rise/);
  assert.equal(move.discussionSection({ app: { view_visibility: 'invited' }, messages }), '');
  assert.equal(move.discussionSection({ app: { view_visibility: 'solo' }, messages }), '');
});
