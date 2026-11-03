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
  });
});

test('a card that fails its checks is not used, and is never clipped to pass', () => {
  const long = 'x'.repeat(130);
  const bad = specHtml.specCard(spec(
    `<li data-change="1">The status line says "Your plan is ready</li><li data-change="2">${long}.</li><li data-change="3">A change no screen marks.</li>`,
  ));
  assert.deepEqual(bad.problems, ['line 1 is not a whole sentence', 'line 2 is 131 characters', 'no screen marks change 3']);
  assert.equal(bad.lines[1].text.length, 131, 'kept whole, not cut');
  assert.equal(specHtml.specCard('<article data-spec><h1>t</h1><section data-spec-tab="user"></section></article>'), null);
  // The plan keeps its card only when it passes (homeroom-bot.js planCardOf).
  const bot = read('src/services/homeroom-bot.js');
  assert.match(bot, /if \(card\.problems\.length\) \{[\s\S]{0,300}return null;\s+\}\s+return \{ summary: card\.summary, lines: card\.lines \};/);
  assert.match(bot, /\.\.\.\(card \? \{ card \} : \{\}\),/);
});

test('the plan writer is told to write the card\'s text, with the box around each change', () => {
  const { specHtmlContract } = require('../src/services/prompts');
  const contract = specHtmlContract(true);
  assert.match(contract, /THE PLAN'S CARD is written from two parts of this document, word for word/);
  assert.match(contract, /ONE whole sentence of at most 100 characters/);
  assert.match(contract, /data-area="x y w h": the box around that change on the first screen that marks it/);
  assert.match(contract, /<li data-change="1" data-steps="[^"]+" data-area="840 60 440 160">/);
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
  assert.match(read('frontend/src/features/dev-board/topic/request-plan.tsx'), /planSpec=\{<PlanCrops html=\{specHtml\} \/>\}/);
  assert.match(read('frontend/src/features/messages/bot-plan.tsx'), /card=\{meta\.plan\.card \|\| null\}/);
  assert.match(read('src/services/homeroom-bot-dm.js'), /\.\.\.\(plan\.card \? \{ card: plan\.card \} : \{\}\)/);
  // The words.
  assert.equal(message('messages:bot.plan.crops.summary_other', { count: 3 }), 'Before and after · 3 changes');
  assert.equal(message('messages:bot.plan.crops.notBefore'), 'Not there before');
  assert.equal(message('messages:bot.plan.crops.goneAfter'), 'Gone after');
});
