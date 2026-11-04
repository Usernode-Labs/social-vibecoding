'use strict';

// #6220/#6221 (3 Nov 2026, from Evan's plan card review). A plan's card was
// cut out of its spec: the first sentence or bold lead of each point,
// clipped at 120 characters ('The status line says "Your plan is ready'),
// bare sub-headings ("On a message"), repeats, and pictures of the whole
// screen at a fifth of its size. Now the plan writer writes the card's text
// (its summary and one whole numbered line per change, with the box around
// each change), the server checks it and never clips it, and the card shows
// one readable crop per change behind a fold-out.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { message } = require('./lib/platform-i18n');
const { loadTsx } = require('./lib/render-tsx');
const specHtml = require('../src/services/spec-html');

const spec = (lines, summary = 'Plan rows open their request&#39;s page. Main Chat is unchanged.') => `<article data-spec>
  <h1>Open a plan row on its request's page</h1>
  <p>${summary}</p>
  <section data-spec-tab="user">
    <figure data-screens>
      <ol data-changes>${lines}</ol>
      <template data-screen data-size="desktop"><div data-change="1">a</div><div data-side="after" data-change="2">b</div></template>
    </figure>
  </section>
  <section data-spec-tab="tech"><p>Files.</p></section>
</article>`;

test('the card is read from the summary and the numbered changes, as written', () => {
  const card = specHtml.specCard(spec(
    '<li data-change="1" data-area="0 60 360 120">A ▷ Build it row opens its request\'s page beside the list.</li>'
    + '<li data-change="2">That page shows this plan, with Build it and Change something.</li>',
  ));
  assert.deepEqual(card, {
    summary: 'Plan rows open their request\'s page. Main Chat is unchanged.',
    lines: [
      { n: 1, text: 'A ▷ Build it row opens its request\'s page beside the list.' },
      { n: 2, text: 'That page shows this plan, with Build it and Change something.' },
    ],
    problems: [],
    summaryProblems: [],
    lineProblems: [],
    kinds: [],
  });
});

test('a summary over its limit is its own problem, so the numbered lines can still be used', () => {
  const long = `${'The summary '.repeat(29)}stays.`;
  const card = specHtml.specCard(spec(
    '<li data-change="1">A ▷ Build it row opens its request\'s page beside the list.</li>'
    + '<li data-change="2">That page shows this plan, with Build it and Change something.</li>',
    long,
  ));
  assert.equal(card.summary.length, long.length);
  assert.deepEqual(card.summaryProblems, [`the summary is ${long.length} characters`]);
  assert.deepEqual(card.lineProblems, []);
  assert.deepEqual(card.kinds, ['summary_long']);
  assert.deepEqual(card.problems, card.summaryProblems, 'the union keeps today\'s order');
});

test('a card that fails its checks is not used, and is never clipped to pass', () => {
  const long = 'x'.repeat(130);
  const bad = specHtml.specCard(spec(
    `<li data-change="1">The status line says "Your plan is ready</li><li data-change="2">${long}.</li><li data-change="3">A change no screen marks.</li>`,
  ));
  assert.deepEqual(bad.problems, ['line 1 is not a whole sentence', 'line 2 is 131 characters', 'no screen marks change 3']);
  assert.deepEqual(bad.summaryProblems, []);
  assert.deepEqual(bad.lineProblems, bad.problems);
  assert.deepEqual(bad.kinds, ['line_not_sentence', 'line_long', 'line_unmarked']);
  assert.equal(bad.lines[1].text.length, 131, 'kept whole, not cut');
  assert.equal(specHtml.specCard('<article data-spec><h1>t</h1><section data-spec-tab="user"></section></article>'), null);
  // A failing line falls back (homeroom-bot.js planCardOf); a failing
  // summary only drops the summary.
  const bot = read('src/services/homeroom-bot.js');
  assert.match(bot, /if \(card\.lineProblems\.length\) return null;/);
  assert.match(bot, /return \{ summary: card\.summaryProblems\.length \? '' : card\.summary, lines: card\.lines \};/);
  assert.match(bot, /\.\.\.\(card \? \{ card \} : \{\}\),/);
});

test('a card whose only failure is its summary keeps its two numbered lines, with no summary', () => {
  const bot = require('../src/services/homeroom-bot');
  const long = `Plan rows open their request&#39;s page. ${'Main Chat is unchanged. '.repeat(15)}`;
  const lines = '<li data-change="1" data-area="0 60 360 120">A ▷ Build it row opens its request\'s page beside the list.</li>'
    + '<li data-change="2">That page shows this plan, with Build it and Change something.</li>';
  const good = bot.planCardOf(spec(lines));
  assert.deepEqual(good, {
    summary: 'Plan rows open their request\'s page. Main Chat is unchanged.',
    lines: [
      { n: 1, text: 'A ▷ Build it row opens its request\'s page beside the list.' },
      { n: 2, text: 'That page shows this plan, with Build it and Change something.' },
    ],
  });
  const partial = bot.planCardOf(spec(lines, long));
  assert.equal(partial.summary, '', 'the failing summary is left out, not shortened');
  assert.deepEqual(partial.lines, good.lines, 'the good lines are kept');
  assert.equal(bot.planCardOf(spec('<li data-change="1">The status line says "Your plan is ready</li>')), null,
    'a failing line falls back to the older lines');
});

test('the plan writer is told the summary\'s limit as plainly as the lines\', and how to repair one part', () => {
  const { specHtmlContract, cardRepairPrompt } = require('../src/services/prompts');
  const contract = specHtmlContract(true);
  assert.match(contract, /THE PLAN'S CARD is written from two parts of this document, word for word/);
  assert.match(contract, /at most two plain sentences and at most 280 characters/);
  assert.match(contract, /ONE whole sentence of at most 100 characters/);
  assert.match(contract, /data-area="x y w h": the box around that change on the first screen that marks it/);
  assert.match(contract, /<li data-change="1" data-steps="[^"]+" data-area="840 60 440 160">/);
  const repair = cardRepairPrompt({
    title: 'Open a plan row on its request\'s page',
    summary: 'A summary',
    lines: [{ n: 1, text: 'A line.' }, { n: 2, text: 'Another line.' }],
    problems: ['the summary is 341 characters'],
  });
  assert.match(repair, /fixing only the card text/);
  assert.match(repair, /the summary is 341 characters/);
  assert.match(repair, /at most two plain sentences and at most 280 characters/);
  assert.match(repair, /ONLY the part or parts that broke/);
  assert.match(repair, /<li data-change="N">/);
  assert.doesNotMatch(repair, /—/, 'no em dashes');
});

test('the card: the plan\'s title once, who it waits for, its lines numbered as its crops, then Build it with no note', () => {
  const view = read('frontend/src/features/messages/bot-plan-view.tsx');
  assert.match(view, /\{sub \? \(\s+<div className="mt-0\.5 flex min-w-0" data-bot-plan-sub="">/);
  assert.match(view, /\{line\.n \? <span aria-hidden="true" className=\{LINE_BADGE\}>\{line\.n\}<\/span> : null\}/);
  assert.match(view, /\{open && plan\.complicated && !sub \? \(/, 'no note above Build it on the new card');
  // The fold-out: closed at first, one crop per change, from the box the plan named.
  const crops = read('frontend/src/features/messages/plan-crops.tsx');
  assert.match(crops, /<details className="[^"]*" data-plan-crops=\{crops\.length\}>/);
  assert.doesNotMatch(crops, /<details[^>]*\bopen\b/, 'it starts closed');
  assert.match(crops, /sandbox=""/, 'the frames stay script-free and cross-origin');
  assert.match(crops, /const scale = width \? Math\.min\(MAX_SCALE, width \/ w\) : 0;/);
  const lib = read('frontend/src/lib/spec-html.ts');
  assert.match(lib, /focus: parseArea\(li\.getAttribute\('data-area'\), g\.width, g\.height\) \|\| g\.focus,/);
  assert.match(lib, /const missing = sides\.size === 1 && sides\.has\('after'\) \? 'before' : sides\.size === 1 && sides\.has\('before'\) \? 'after' : null;/);
  // Drawn on the request's page, and its text carried to the chat's card.
  const requestPlan = read('frontend/src/features/dev-board/topic/request-plan.tsx');
  assert.match(requestPlan, /planSpec=\{<PlanCrops html=\{specHtml\} lines=\{plan\.lines\} \/>\}/);
  assert.match(read('frontend/src/features/messages/bot-plan.tsx'), /card=\{meta\.plan\.card \|\| null\}/);
  assert.match(read('src/services/homeroom-bot-dm.js'), /\.\.\.\(plan\.card \? \{ card: plan\.card \} : \{\}\)/);
  // #6269: the count only beside the changes' own lines.
  assert.match(crops, /t\('messages:bot\.plan\.crops\.summaryPlain'\)/);
  const { planCropsNumbered } = loadTsx('frontend/src/features/messages/plan-crops.tsx', {
    stubs: {
      '@/components/ui/icons': { ChevronDownIcon: () => null },
      '../../lib/i18n/react': { useMessages: () => (key) => key },
      '../../lib/spec-html': { specChangeCrops: () => [] },
    },
  });
  const numbered = [{ n: 1 }, { n: 2 }];
  assert.equal(planCropsNumbered(numbered, [{ n: 1 }, { n: 2 }]), true, 'the changes\' own lines are counted');
  assert.equal(planCropsNumbered(numbered, [{ n: null }, { n: null }]), false, 'the older unnumbered lines are not');
  assert.equal(planCropsNumbered(numbered, [{ n: 1 }, { n: 3 }]), false, 'a count must name the lines showing');
  assert.equal(planCropsNumbered(numbered, [{ n: 1 }]), false);
  // The words.
  assert.equal(message('messages:bot.plan.crops.summary_other', { count: 3 }), 'Before and after · 3 changes');
  assert.equal(message('messages:bot.plan.crops.summaryPlain'), 'Before and after');
  assert.equal(message('messages:bot.plan.crops.notBefore'), 'Not there before');
  assert.equal(message('messages:bot.plan.crops.goneAfter'), 'Gone after');
  // #6269: Read the whole plan and its length have a dot between them.
  assert.equal(message('project:topic.request.botPlan.readWholeLength', { chars: '25,000' }),
    'Read the whole plan <1>· about 25,000 characters</1>');
  assert.match(requestPlan, /<RichMessage\s+id="project:topic\.request\.botPlan\.readWholeLength"/);
  assert.doesNotMatch(requestPlan, /readLength/, 'the separator-less message is retired');
});

test('a repair reply swaps only the failing part, keeps every attribute, and never shortens', () => {
  const summary = 'The summary is far too long. '.repeat(12);
  const html = spec(
    '<li data-change="1" data-area="0 60 360 120" data-steps="A → B">The status line says "Your plan is ready</li>'
    + '<li data-change="2">That page shows this plan, with Build it and Change something.</li>',
    summary,
  );
  const reply = '<p>A short summary. It stays the same.</p><li data-change="1">The status line says the plan is ready.</li>';
  const { html: fixed, changed } = specHtml.applyCardRepair(html, reply);
  assert.equal(changed, true);
  assert.doesNotMatch(fixed, /The summary is far too long/);
  assert.match(fixed, /<p>A short summary\. It stays the same\.<\/p>/);
  assert.match(fixed, /<li data-change="1" data-area="0 60 360 120" data-steps="A → B">The status line says the plan is ready\.<\/li>/);
  assert.match(fixed, /That page shows this plan, with Build it and Change something\./);
  assert.deepEqual(specHtml.specCard(fixed).problems, [], 'every part now passes');

  // A replacement that still fails is refused: nothing is cut to fit.
  const tooLong = `${'x'.repeat(120)}.`;
  const refused = specHtml.applyCardRepair(html, `<p>Still short.</p><li data-change="2">${tooLong}</li>`);
  assert.match(refused.html, /Still short\./, 'the passing summary is taken');
  assert.match(refused.html, /That page shows this plan, with Build it and Change something\./, 'the failing line keeps its text');
  assert.doesNotMatch(refused.html, new RegExp(tooLong));
  assert.equal(specHtml.applyCardRepair(html, '<li data-change="2">no stop</li>').changed, false);
  assert.equal(specHtml.applyCardRepair(html, 'not html text').changed, false);
});

test('a plan saved with a failing card gets exactly one repair turn, and its repaired text is kept', async () => {
  const live = require('../src/services/homeroom-bot-live');
  const long = `Plan rows open their request&#39;s page. ${'Main Chat is unchanged. '.repeat(15)}`;
  const specText = spec(
    '<li data-change="1" data-area="0 60 360 120">A ▷ Build it row opens its request\'s page beside the list.</li>'
    + '<li data-change="2">That page shows this plan, with Build it and Change something.</li>',
    long,
  );
  const prompts = [];
  const persisted = [];
  const calls = [];
  const deps = {
    worker: {
      async execInWorker(_id, { prompt }) {
        prompts.push(prompt);
        if (prompt.includes('fixing only the card text')) {
          return { lastResultText: '<p>A short summary. It stays the same.</p>' };
        }
        return { lastResultText: specText };
      },
      async stopTurn() {},
    },
    sessions: {
      async runCodexAttemptLoop({ dispatchOnce }) { return { result: await dispatchOnce({}), estimatedCostUsd: 0.4 }; },
      async persistScoutPublication(args) { persisted.push(args); return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
  };
  const pool = { async query(sql, params) { calls.push({ sql: String(sql), params }); return { rows: [] }; } };
  const out = await live.draftSpec({
    pool, config: {}, bot: { id: 1 }, session: { id: 7, app_id: 9, app_slug: 'club-votes', branch_name: 'b' },
    containerName: 'w-7', seed: 's', buildNote: 'n', turnBudgetMs: 60000, model: 'm', deps, repairCard: true,
  });
  assert.equal(out.ok, true, out.error);
  assert.equal(prompts.length, 2, 'one spec turn and one repair turn');
  assert.equal(prompts.filter((p) => p.includes('fixing only the card text')).length, 1);
  assert.match(prompts[1], /the summary is 3\d\d characters/);
  assert.match(persisted[0].contentHtml, /A short summary\. It stays the same\./, 'the repaired summary is stored');
  assert.ok(Math.abs(out.costUsd - 0.8) < 1e-9, 'the repair turn\'s cost is added');
  const event = calls.find((c) => /INSERT INTO events/.test(c.sql));
  assert.ok(event, 'the card failure is counted');
  assert.equal(event.params[3], 'bot_plan_card');
  const metadata = JSON.parse(event.params[4]);
  assert.deepEqual(metadata.kinds, ['summary_long']);
  assert.equal(metadata.repaired, true);
  assert.deepEqual(metadata.kindsAfter, []);
  assert.equal(metadata.used, 'whole');
});

test('a card that passes its checks costs no repair turn', async () => {
  const live = require('../src/services/homeroom-bot-live');
  const prompts = [];
  const calls = [];
  const deps = {
    worker: { async execInWorker(_id, { prompt }) { prompts.push(prompt); return { lastResultText: spec('<li data-change="1">A ▷ Build it row opens its request\'s page beside the list.</li>') }; }, async stopTurn() {} },
    sessions: {
      async runCodexAttemptLoop({ dispatchOnce }) { return { result: await dispatchOnce({}), estimatedCostUsd: 0.4 }; },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
  };
  const pool = { async query(sql, params) { calls.push({ sql: String(sql), params }); return { rows: [] }; } };
  const out = await live.draftSpec({
    pool, config: {}, bot: { id: 1 }, session: { id: 8, app_id: 9, app_slug: 'club-votes', branch_name: 'b' },
    containerName: 'w-8', seed: 's', buildNote: 'n', turnBudgetMs: 60000, model: 'm', deps, repairCard: true,
  });
  assert.equal(out.ok, true, out.error);
  assert.equal(prompts.length, 1);
  assert.equal(calls.filter((c) => /INSERT INTO events/.test(c.sql)).length, 0);
});

// 4 Nov 2026: #6276 gave draftSpec's dispatch a second parameter, the prompt,
// for the repair turn. A durable step calls dispatch(extra, { budgetMs })
// (durable-turn.js), so on every production build the clock went out as the
// prompt and the plan writer was sent "[object Object]". The tests above run
// the inert context, which passes one argument, so they stayed green. This
// one runs the same plan on a durable context too.
test('on a durable build the spec turn and the repair turn are each sent their own prompt, never the clock', async () => {
  const live = require('../src/services/homeroom-bot-live');
  const durableSteps = require('../src/services/durable-steps');
  const long = `Plan rows open their request&#39;s page. ${'Main Chat is unchanged. '.repeat(15)}`;
  const specText = spec(
    '<li data-change="1" data-area="0 60 360 120">A ▷ Build it row opens its request\'s page beside the list.</li>'
    + '<li data-change="2">That page shows this plan, with Build it and Change something.</li>',
    long,
  );
  const draft = async (durable) => {
    const prompts = [];
    const deps = {
      worker: {
        async execInWorker(_id, { prompt }) {
          prompts.push(prompt);
          if (typeof prompt === 'string' && prompt.includes('fixing only the card text')) {
            return { lastResultText: '<p>A short summary. It stays the same.</p>' };
          }
          return { lastResultText: specText };
        },
        async stopTurn() {},
        async finishTurn() { return true; },
      },
      sessions: {
        async runCodexAttemptLoop({ dispatchOnce }) { return { result: await dispatchOnce({}), estimatedCostUsd: 0.4 }; },
        async persistScoutPublication() { return { specVersion: 1 }; },
      },
      agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
      ...(durable ? { durable } : {}),
    };
    const pool = { async query() { return { rows: [] }; } };
    const out = await live.draftSpec({
      pool, config: {}, bot: { id: 1 }, session: { id: 9, app_id: 9, app_slug: 'club-votes', branch_name: 'b' },
      containerName: 'w-9', seed: 's', buildNote: 'n', turnBudgetMs: 60000, model: 'm', deps, repairCard: true,
    });
    return { out, prompts };
  };
  const inert = await draft(null);
  const saves = [];
  const durable = durableSteps.durable({
    resumeFrom: null, signal: new AbortController().signal, checkpoint: async (v) => { saves.push(v); },
  });
  assert.equal(durableSteps.of({ durable }).active, true, 'this build runs on a durable context');
  const kept = await draft(durable);
  assert.equal(kept.out.ok, true, kept.out.error);
  assert.equal(kept.prompts.length, 2, 'one spec turn and one repair turn');
  for (const p of kept.prompts) assert.equal(typeof p, 'string', 'a prompt is text, never the step\'s options');
  assert.equal(kept.prompts[0], inert.prompts[0], 'the spec turn is sent the plan prompt, as on the inert context');
  assert.match(kept.prompts[1], /fixing only the card text/);
  assert.equal(kept.prompts[1], inert.prompts[1]);
  assert.ok(saves.length > 0, 'the turns ran as durable steps');
});
