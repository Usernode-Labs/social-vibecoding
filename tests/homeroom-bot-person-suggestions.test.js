'use strict';

// 3 Nov 2026 (#6213): the "a person needs to decide" note ends in suggested
// replies the person it names taps to send as their own: Go ahead, a smaller
// first step and Not now. Pinned here: the labels (and that Go ahead is the
// primary one), the first step the triage may give, that neither a note about
// Homeroom itself nor one saying the request is done offers them, and which
// people the note stores them for.

const test = require('node:test');
const assert = require('node:assert/strict');

const live = require('../src/services/homeroom-bot-live');
const bot = require('../src/services/homeroom-bot');

test('the note offers Go ahead first and primary, the smaller step, then Not now', () => {
  const actions = live.personSuggestions({ firstStep: 'Just the triage part' });
  assert.deepEqual(actions.map((a) => a.label), ['Go ahead', 'Just the triage part', 'Not now']);
  assert.deepEqual(actions.map((a) => a.style), ['primary', 'secondary', 'secondary']);
  assert.ok(actions.every((a) => a.type === 'prompt'), 'a tap sends the words as the person\'s own reply');
  assert.deepEqual(actions.map((a) => a.id), ['go_ahead', 'smaller', 'not_now']);
});

test('the smaller step has a fixed label when the triage named none', () => {
  const actions = live.personSuggestions({});
  assert.deepEqual(actions.map((a) => a.label), ['Go ahead', 'Start with a smaller first step', 'Not now']);
});

test('a step too long for a button is dropped rather than cut, keeping the fixed label', () => {
  const actions = live.personSuggestions({ firstStep: 'x'.repeat(61) });
  assert.deepEqual(actions.map((a) => a.label), ['Go ahead', 'Start with a smaller first step', 'Not now']);
  assert.ok(actions.every((a) => a.label.length <= 60));
});

test('a note about Homeroom itself, or one saying the request is done, offers none', () => {
  assert.deepEqual(live.personSuggestions({ platform: true, firstStep: 'Just the triage part' }), []);
  assert.deepEqual(live.personSuggestions({ done: true, firstStep: 'Just the triage part' }), []);
});

// 6 Nov 2026 (#6395): a go-ahead cannot settle these, so it is not offered.
test('when a go-ahead cannot settle it, the smaller step leads and Go ahead is gone', () => {
  const actions = live.personSuggestions({ firstStep: 'Remove the dead bot token line', goAheadDecides: false });
  assert.deepEqual(actions.map((a) => a.label), ['Remove the dead bot token line', 'Not now']);
  assert.deepEqual(actions.map((a) => a.style), ['primary', 'secondary']);
  assert.deepEqual(actions.map((a) => a.id), ['smaller', 'not_now']);
  assert.ok(actions.every((a) => a.type === 'prompt'));
});

test('without a first step, the fixed smaller step is the primary one', () => {
  const actions = live.personSuggestions({ goAheadDecides: false });
  assert.deepEqual(actions.map((a) => a.label), ['Start with a smaller first step', 'Not now']);
  assert.equal(actions[0].style, 'primary');
});

test('true or a missing go_ahead keeps today\'s three buttons', () => {
  for (const goAheadDecides of [true, undefined]) {
    const actions = live.personSuggestions({ firstStep: 'Just the triage part', goAheadDecides });
    assert.deepEqual(actions.map((a) => a.label), ['Go ahead', 'Just the triage part', 'Not now']);
    assert.deepEqual(actions.map((a) => a.style), ['primary', 'secondary', 'secondary']);
  }
});

test('the triage reads go_ahead as false, true, or absent; only a plain person verdict carries it', () => {
  const no = bot.parseVerdict('{"verdict":"person","reason":"x","go_ahead":false,"first_step":"Remove the dead line"}');
  assert.equal(no.goAheadDecides, false);
  assert.equal(no.firstStep, 'Remove the dead line');
  assert.equal(bot.parseVerdict('{"verdict":"person","reason":"x","go_ahead":true}').goAheadDecides, true);
  assert.equal(bot.parseVerdict('{"verdict":"person","reason":"x"}').goAheadDecides, true,
    'a missing key is today\'s behaviour: a go-ahead settles it');
  assert.equal(bot.parseVerdict('{"verdict":"ready","build_note":"x","go_ahead":false}').goAheadDecides, null);
  assert.equal(bot.parseVerdict('{"verdict":"person","reason":"x","platform":true,"go_ahead":false}').goAheadDecides, null);
  assert.equal(bot.parseVerdict('{"verdict":"person","reason":"x","done":true,"go_ahead":false}').goAheadDecides, null);
});

test('the triage keeps a person verdict\'s first step, and only that verdict\'s', () => {
  const person = bot.parseVerdict('{"verdict":"person","reason":"too big","first_step":"Just the triage part"}');
  assert.equal(person.firstStep, 'Just the triage part');
  const ready = bot.parseVerdict('{"verdict":"ready","build_note":"do it","first_step":"Just the triage part"}');
  assert.equal(ready.firstStep, null, 'only a person verdict carries it');
  const long = bot.parseVerdict(`{"verdict":"person","reason":"x","first_step":"${'y'.repeat(61)}"}`);
  assert.equal(long.firstStep, null, 'dropped when too long for a button');
  const blank = bot.parseVerdict('{"verdict":"person","reason":"x","first_step":"  "}');
  assert.equal(blank.firstStep, null);
});

// ── The note's branch stores them for the people it names ────────────────

test('the person branch stores the note\'s suggestions for the deciders it names', async () => {
  const says = [];
  const realPost = live.post;
  const realSeen = live.advanceSeen;
  const realTargets = live.mentionTargets;
  live.post = async (args) => { says.push(args); return {}; };
  live.advanceSeen = async () => ({});
  live.mentionTargets = async () => [];
  try {
    const pool = {
      async query(sql, params) {
        const s = String(sql);
        if (/FROM users WHERE username = ANY/.test(s)) {
          assert.deepEqual(params[0], ['ada', 'sam']);
          return { rows: [{ id: 11, username: 'ada' }, { id: 12, username: 'sam' }] };
        }
        if (/FROM homeroom_bot_requesters/.test(s)) return { rows: [] };
        return { rows: [] };
      },
    };
    await bot.actOnVerdict({
      pool, config: {}, bot: { id: 2 }, app: { id: 1, slug: 'x', name: 'X' },
      repo: { owner: 'o', repo: 'r' }, issueNumber: 7, issue: {},
      parsed: {
        verdict: 'person', reason: 'too large and open-ended', platform: false, done: false,
        firstStep: 'Just the triage part',
      },
      decider: { requesterDecides: false, deciders: [{ username: 'ada' }, { username: 'sam' }] },
      capSuppressed: null, runId: 3, seed: '', seedReadAt: 'now', postedAt: [], turnBudgetMs: 1000, model: 'm',
      deps: { github: {}, ws: {} },
    });
  } finally {
    live.post = realPost;
    live.advanceSeen = realSeen;
    live.mentionTargets = realTargets;
  }
  assert.equal(says.length, 1);
  const meta = says[0].metadata.homeroomBot;
  assert.equal(meta.kind, 'note');
  assert.deepEqual(meta.suggest, { status: 'open', forUserIds: [11, 12] });
  assert.deepEqual(meta.actions.map((a) => a.label), ['Go ahead', 'Just the triage part', 'Not now']);
  // #6391: the other members get a set of their own, with no Go ahead in it.
  assert.deepEqual(meta.othersActions.map((a) => a.label), ["I'd like this too", "What's left to do?"]);
  assert.ok(meta.othersActions.every((a) => a.type === 'prompt' && a.id !== 'go_ahead'));
});

test('with nobody deciding alone, the note stores them for the requester', async () => {
  const says = [];
  const realPost = live.post;
  const realSeen = live.advanceSeen;
  const realTargets = live.mentionTargets;
  live.post = async (args) => { says.push(args); return {}; };
  live.advanceSeen = async () => ({});
  live.mentionTargets = async () => [];
  try {
    const pool = {
      async query(sql) {
        if (/FROM homeroom_bot_requesters/.test(sql)) {
          return { rows: [{ user_id: 9, username: 'evan', first_version: false, has_platform_access: true }] };
        }
        return { rows: [] };
      },
    };
    await bot.actOnVerdict({
      pool, config: {}, bot: { id: 2 }, app: { id: 1, slug: 'x', name: 'X' },
      repo: { owner: 'o', repo: 'r' }, issueNumber: 7, issue: {},
      parsed: { verdict: 'person', reason: 'needs a person', platform: false, done: false },
      decider: { requesterDecides: true },
      capSuppressed: null, runId: 3, seed: '', seedReadAt: 'now', postedAt: [], turnBudgetMs: 1000, model: 'm',
      deps: { github: {}, ws: {} },
    });
  } finally {
    live.post = realPost;
    live.advanceSeen = realSeen;
    live.mentionTargets = realTargets;
  }
  assert.equal(says.length, 1);
  assert.deepEqual(says[0].metadata.homeroomBot.suggest.forUserIds, [9]);
  assert.deepEqual(says[0].metadata.homeroomBot.actions.map((a) => a.label),
    ['Go ahead', 'Start with a smaller first step', 'Not now']);
});

test('a note about Homeroom itself, or one saying it is done, posts with no suggestions', async () => {
  for (const parsed of [
    { verdict: 'person', reason: 'about Homeroom', platform: true, done: false },
    { verdict: 'person', reason: 'already there', platform: false, done: true },
  ]) {
    const says = [];
    const realPost = live.post;
    const realSeen = live.advanceSeen;
    const realTargets = live.mentionTargets;
    live.post = async (args) => { says.push(args); return {}; };
    live.advanceSeen = async () => ({});
    live.mentionTargets = async () => [];
    try {
      await bot.actOnVerdict({
        pool: { async query(sql) { return /FROM homeroom_bot_requesters/.test(sql) ? { rows: [] } : { rows: [] }; } },
        config: {}, bot: { id: 2 }, app: { id: 1, slug: 'x', name: 'X' },
        repo: { owner: 'o', repo: 'r' }, issueNumber: 7, issue: {}, parsed,
        decider: { requesterDecides: true },
        capSuppressed: null, runId: 3, seed: '', seedReadAt: 'now', postedAt: [], turnBudgetMs: 1000, model: 'm',
        deps: { github: {}, ws: {} },
      });
    } finally {
      live.post = realPost;
      live.advanceSeen = realSeen;
      live.mentionTargets = realTargets;
    }
    assert.equal(says.length, 1);
    assert.equal(says[0].metadata, undefined, 'no buttons on this note');
  }
});

// 6 Nov 2026 (#6395): the go-ahead the note could not act on gets one plain
// line, not the note again, and no Go ahead button.
test('a go-ahead that meets a read saying it cannot settle it posts one plain reply', async () => {
  const says = [];
  const realPost = live.post;
  const realSeen = live.advanceSeen;
  const realTargets = live.mentionTargets;
  live.post = async (args) => { says.push(args); return {}; };
  live.advanceSeen = async () => ({});
  live.mentionTargets = async () => [];
  try {
    const pool = {
      async query(sql) {
        if (/FROM homeroom_bot_requesters/.test(sql)) {
          return { rows: [{ user_id: 9, username: 'evan', first_version: false, has_platform_access: true }] };
        }
        return { rows: [] };
      },
    };
    await bot.actOnVerdict({
      pool, config: {}, bot: { id: 2 }, app: { id: 1, slug: 'x', name: 'X' },
      repo: { owner: 'o', repo: 'r' }, issueNumber: 7, issue: {},
      parsed: {
        verdict: 'person', reason: 'moving App secrets is operator work outside this app.',
        firstStep: 'Remove the dead bot token line', platform: false, done: false, goAheadDecides: false,
      },
      goAhead: { by: 'evan' },
      decider: { requesterDecides: true },
      capSuppressed: null, runId: 3, seed: '', seedReadAt: 'now', postedAt: [], turnBudgetMs: 1000, model: 'm',
      deps: { github: {}, ws: {} },
    });
  } finally {
    live.post = realPost;
    live.advanceSeen = realSeen;
    live.mentionTargets = realTargets;
  }
  assert.equal(says.length, 1);
  assert.match(says[0].homeroomText,
    /^A go-ahead can't change this one: moving App secrets is operator work outside this app\. I can do this part here: Remove the dead bot token line\.$/);
  assert.doesNotMatch(says[0].homeroomText, /Go ahead/);
  assert.deepEqual(says[0].metadata.homeroomBot.actions.map((a) => a.label),
    ['Remove the dead bot token line', 'Not now']);
});
