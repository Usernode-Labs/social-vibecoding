'use strict';

// #6220: a plan carries its own card text, written with the plan.
//
// The plan card in Main Chat used to cut its lines out of the plan's prose
// (live.specCardLines): the title again, bare sub-headings, and lines
// clipped at 120 characters. The plan writer now writes a summary and one
// whole numbered line per change, in a `<template data-card>` block
// (spec-html.js reads and checks it). A faulty plan gets exactly one repair
// turn; a plan that still fails publishes its first spec as it was and the
// card keeps the lines it derives. Nothing is ever shortened to fit.
//
// Run with: node --test tests/homeroom-bot-plan-card-text.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const live = require('../src/services/homeroom-bot-live');

const CARD_OK = `<article data-spec>
  <h1>Show who voted on a request</h1>
  <p>A request shows who has voted.</p>
  <template data-card>
    <p data-card-summary>A request's page names who has voted, so you can see who is still to answer.</p>
    <ol data-card-lines>
      <li data-card-line="1">The Votes card lists each member who has voted, newest first.</li>
      <li data-card-line="2">Members still to vote are named under it, with the day voting closes.</li>
    </ol>
  </template>
  <section data-spec-tab="user">
    <figure data-screens>
      <ol data-changes>
        <li data-change="1">The Votes card lists who voted</li>
        <li data-change="2">Members still to vote are named</li>
      </ol>
      <template data-screen data-size="desktop"><div><p data-change="1">x</p><p data-change="2">y</p></div></template>
    </figure>
  </section>
</article>`;
// Its numbers are 1 and 3, so its card fails the check.
const CARD_BAD = CARD_OK.replace('data-card-line="2"', 'data-card-line="3"');

/** draftSpec's deps, answering with one spec text per turn. */
function harness(responses) {
  const calls = [];
  const published = [];
  let turn = 0;
  const deps = {
    worker: {
      async execInWorker(_sessionId, args) { calls.push(args); return {}; },
      async stopTurn() {},
      async stopTurnByJournal() {},
    },
    sessions: {
      async runCodexAttemptLoop(opts) {
        await opts.dispatchOnce({});
        const text = responses[Math.min(turn, responses.length - 1)];
        turn += 1;
        return {
          result: { lastResultText: text, agentThreadId: `thread-${turn}` },
          estimatedCostUsd: 0.5,
          logicalTurnId: turn,
        };
      },
      async persistScoutPublication(args) { published.push(args); return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return { resumeSessionId: null }; } },
  };
  return { deps, calls, published };
}

function args(deps) {
  return {
    pool: { async query() { return { rows: [] }; } },
    config: { htmlSpecApps: ['*'] },
    bot: { id: 2 },
    session: { id: 1, app_slug: 'app', app_self_hosted: false, branch_name: 'b' },
    containerName: 'c',
    seed: 'Make it.', buildNote: 'Show who voted.', turnBudgetMs: 120000,
    model: 'm', deps, planCard: true,
  };
}

test('#6220: a faulty card runs exactly one repair turn, and the repaired plan is published', async () => {
  const { deps, calls, published } = harness([CARD_BAD, CARD_OK]);
  const out = await live.draftSpec(args(deps));
  assert.equal(out.ok, true);
  assert.deepEqual(out.planCard, {
    summary: "A request's page names who has voted, so you can see who is still to answer.",
    changes: [
      { n: 1, text: 'The Votes card lists each member who has voted, newest first.' },
      { n: 2, text: 'Members still to vote are named under it, with the day voting closes.' },
    ],
  });
  assert.equal(calls.length, 2, 'the spec turn, then one repair turn');
  assert.match(calls[1].prompt, /plan-card block/, 'the repair prompt names the card');
  assert.match(calls[1].prompt, /must run 1 to N in order/, 'and every fault it found');
  assert.equal(calls[1].resumeSessionId, 'thread-1', 'it continues the spec\'s conversation');
  assert.match(calls[1].prompt, /^Make it\./, 'a fresh runtime gets the whole original prompt first');
  assert.equal(published.length, 1);
  assert.match(published[0].contentHtml, /data-card-line="2"/, 'the repaired card is the one stored');
  assert.equal(out.costUsd, 1, 'both turns are on the bill');
});

test('#6220: if the repair fails too the first spec is published as it was, and the card falls back', async () => {
  const { deps, calls, published } = harness([CARD_BAD, CARD_BAD]);
  const out = await live.draftSpec(args(deps));
  assert.equal(out.ok, true);
  assert.equal(out.planCard, undefined, 'no card text: the card uses its derived lines');
  assert.equal(calls.length, 2, 'exactly one repair turn, never a second');
  assert.equal(published.length, 1);
  assert.equal(published[0].contentHtml, CARD_BAD, 'the first spec, whole and not shortened to fit');
});

test('#6220: a plan written with no card block gets the one repair turn, then falls back', async () => {
  const LEGACY = `<article data-spec><h1>Show who voted</h1><p>Words.</p><section data-spec-tab="user"><p>Prose.</p></section></article>`;
  const { deps, calls, published } = harness([LEGACY]);
  const out = await live.draftSpec(args(deps));
  assert.equal(out.ok, true);
  assert.equal(out.planCard, undefined);
  assert.equal(calls.length, 2, 'the missing block is a fault, repaired once');
  assert.equal(published[0].contentHtml, LEGACY, 'and the first spec is kept when the repair adds nothing');
});

test('#6220: a markdown spec, or one with planCard off, is never checked', async () => {
  const md = '# Show who voted\n\n## User-facing changes\n\n- It names who voted.\n\n## Technical implementation\n\n- x\n';
  const { deps, calls } = harness([md]);
  const out = await live.draftSpec({ ...args(deps), config: { htmlSpecApps: [] } });
  assert.equal(out.ok, true);
  assert.equal(out.planCard, undefined);
  assert.equal(calls.length, 1, 'a markdown spec has no card block to check');
});

test('#6220: the spec prompt asks for the card text only for a plan-only spec', () => {
  const prompt = (extra) => live.specPrompt({ seed: 'Make it.', buildNote: 'Show who voted.', html: true, ...extra });
  assert.match(prompt({ planCard: true }), /<template data-card>/);
  assert.match(prompt({ planCard: true }), /ONE whole sentence of at most 100 characters/);
  assert.ok(prompt({ planCard: true }).includes(live.PLAN_CARD_BRIEF));
  assert.doesNotMatch(prompt({}), /THE PLAN CARD/);
  assert.doesNotMatch(prompt({ firstVersion: true, planCard: true }), /THE PLAN CARD/, 'a first version keeps its own 3 to 5 lines');
});

test('#6220: the repair prompt lists every fault in plain words', () => {
  const faults = [
    { code: 'summary_empty', message: 'The summary is empty.' },
    { code: 'line_long', n: 2, message: 'Line 2 is 134 characters; at most 100.' },
  ];
  const said = live.planCardRepairPrompt(faults);
  assert.match(said, /^- The summary is empty\.$/m);
  assert.match(said, /^- Line 2 is 134 characters; at most 100\.$/m);
  assert.match(said, /changing only <template data-card>/);
});
