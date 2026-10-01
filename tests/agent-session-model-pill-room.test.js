'use strict';

// #3574: the agent-session composer's model pill and credits pill share one
// row, and on a phone the credits pill was drawn over the model's name.
//
//   1. SHORT NAMES. The closed pill says the model's short name
//      (model-choice.ts shortModelName): OpenRouter's "Provider: " prefix and a
//      leading "Claude" come off, an id is shortened the way the transcript
//      names one, and anything the rules cannot shorten comes back whole. The
//      full name stays the pill's tooltip and what a screen reader hears, and
//      the sheet keeps listing every model by its full name.
//   2. THE CREDITS KEEP THEIR WIDTH. The credits pill's room is a query
//      container, which is sized as if empty, so it could shrink to nothing
//      and the pill (shrink-0, justify-end) spilled out of its left edge over
//      the model pill. An invisible copy of the short label now shares the
//      room's grid cell, so the room is never narrower than the pill.
//   3. THE MODEL PILL GIVES WAY FROM THE INSIDE: the thinking level first and
//      whole (a clipped one-line wrap), then the name with an ellipsis, and on
//      a row under 18rem its padding drops to 12px.
//   4. WHILE A DRAFT IS SAVED (Stop and "Save draft" in Send's place) the
//      credits pill steps aside, so the name is not squeezed to nothing.
//
// The layout itself was measured in Chromium at 320, 375, 390 and 430px wide;
// these pin the markup that produces it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const choice = loadTsx('frontend/src/features/agent-session/model-choice.ts');
const parts = loadTsx('frontend/src/features/agent-session/composer-parts.tsx');
const panel = read('frontend/src/features/agent-session/index.tsx');

test('#3574: a model\'s short name drops the provider prefix and "Claude", and never comes back empty', () => {
  const short = choice.shortModelName;
  // OpenRouter's catalog names, as it publishes them.
  assert.equal(short('Z.ai: GLM 5.3 Flash'), 'GLM 5.3 Flash');
  assert.equal(short('DeepSeek: DeepSeek V4.1 Flash'), 'DeepSeek V4.1 Flash', 'the family name inside the model\'s own name stays');
  assert.equal(short('OpenAI: GPT-6 Astra'), 'GPT-6 Astra');
  assert.equal(short('MoonshotAI: Kimi K3'), 'Kimi K3');
  assert.equal(short('Anthropic: Claude Opus 5'), 'Opus 5', 'an Opus through OpenRouter reads like the platform\'s own');
  assert.equal(short('Qwen: Qwen3 Coder 480B A35B (exacto)'), 'Qwen3 Coder 480B A35B (exacto)');
  // The platform's own labels (services/models.js) are short already.
  assert.equal(short('Opus 5.5'), 'Opus 5.5');
  assert.equal(short('Sonnet 5'), 'Sonnet 5');
  assert.equal(short('Claude Opus 5.5'), 'Opus 5.5');
  // An option the catalog has no name for carries its id (pickerOptions).
  assert.equal(short('claude-opus-5-5'), 'Opus 5.5', 'an id, the way the transcript names it');
  assert.equal(short('openai/gpt-5.3-codex'), 'gpt-5.3-codex');
  assert.equal(short('anthropic/claude-opus-5'), 'Opus 5');
  // Nothing to shorten, or nothing left after: the name as given.
  assert.equal(short('GPT-5'), 'GPT-5');
  assert.equal(short('Claude'), 'Claude');
  assert.equal(short('Weird: '), 'Weird:', 'a prefix with nothing after it is not stripped');
  assert.equal(short(''), '');
  assert.equal(short(null), '');

  const source = read('frontend/src/features/agent-session/model-choice.ts');
  assert.match(source, /import \{ prettyModel \} from '\.\/transcript';/, 'ids are shortened by the transcript\'s own rule, not a copy of it');
  assert.doesNotMatch(source.slice(source.indexOf('export function shortModelName')), /'glm|'deepseek|'kimi/i, 'derived, not a table of models');
});

test('#3574: the closed pill shows the short name; the full one stays its tooltip, its spoken name and the sheet\'s', () => {
  const pill = (label, effort = '') => renderToHtml(createElement(parts.ModelPill, {
    label, effort, disabled: false, open: false, onOpen() {}, pillRef: { current: null },
  }));
  const glm = pill('Z.ai: GLM 5.3 Flash', 'Extra high');
  assert.match(glm, /<span class="truncate">GLM 5\.3 Flash<\/span>/, 'the short name on the pill');
  assert.match(glm, /aria-label="Model: Z\.ai: GLM 5\.3 Flash, thinking Extra high"/, 'the full name to a screen reader');
  assert.match(glm, /title="Z\.ai: GLM 5\.3 Flash"/, 'and as the tooltip');

  const opus = pill('Opus 5.5');
  assert.match(opus, /<span class="truncate">Opus 5\.5<\/span>/);
  assert.doesNotMatch(opus, /title=/, 'no tooltip that only repeats the pill');

  const sheet = renderToHtml(createElement(parts.ModelSheetBody, {
    options: [{ value: 'openrouter:z-ai/glm-5.3-flash', label: 'Z.ai: GLM 5.3 Flash' }],
    value: 'openrouter:z-ai/glm-5.3-flash', onPick() {}, effort: null, credit: null,
  }));
  assert.match(sheet, />Z\.ai: GLM 5\.3 Flash</, 'the open list has the room for the full name, and keeps it');
});

test('#3574: the model pill gives way from the inside, the thinking level first', () => {
  const html = renderToHtml(createElement(parts.ModelPill, {
    label: 'Z.ai: GLM 5.3 Flash', effort: 'Extra high', disabled: false, open: false, onOpen() {}, pillRef: { current: null },
  }));
  // One line tall, clipped, wrapping: a level with no room beside the name
  // wraps onto the hidden second line, whole, instead of squeezing the name.
  const block = /<span class="([^"]*)"><span class="truncate">/.exec(html)[1].split(' ');
  for (const cls of ['flex-wrap', 'h-6', 'leading-6', 'overflow-hidden', 'min-w-0', 'justify-center', 'gap-x-1.5']) {
    assert.ok(block.includes(cls), `the label block carries ${cls}`);
  }
  assert.ok(!block.includes('gap-1.5'), 'a column gap only: the hidden line is not pushed down a gap');
  assert.match(html, /<button[^>]*class="[^"]*\bmin-w-0 max-w-\[14rem\][^"]*"/, 'the pill itself still shrinks');
  assert.match(html, /<button[^>]*class="[^"]*\bpx-4 [^"]*\[@container\(max-width:18rem\)\]:px-3/, '12px of padding on the narrowest rows');
  assert.match(panel, /<div className="flex items-center gap-2 \[container-type:inline-size\]">\s*\{\/\* One picker, no menu of our own/,
    'the composer row is the size container that query reads');
});

test('#3574: the credits pill\'s room is never narrower than the pill, so it cannot spill over the model', () => {
  const credit = parts.creditView({ limitCents: 5000, remainingCents: 4700, spentCents: 300, byokCents: 0, weekly: true, level: 'ok' });
  const html = renderToHtml(createElement(parts.CreditPill, { credit, onOpen() {} }));
  const room = /^<div class="([^"]*)" data-agent-session-credits-room="true">/.exec(html);
  assert.ok(room, 'the room is still the row\'s spacer');
  assert.deepEqual(room[1].split(' ').sort(), ['flex-1', 'grid', 'justify-items-end'], 'a one-cell grid with no min-w-0: as wide as what is in it, at least');
  // Its sizer: the short label, in the button's own type and padding, unseen.
  const sizer = /^<div[^>]*><span class="([^"]*)" aria-hidden="true">\$47 left<\/span>/.exec(html);
  assert.ok(sizer, 'an invisible copy of the short label comes first');
  for (const cls of ['invisible', 'h-0', 'whitespace-nowrap', 'col-start-1', 'row-start-1', 'px-3', 'text-sm', 'font-semibold', 'tabular-nums']) {
    assert.ok(sizer[1].split(' ').includes(cls), `the sizer carries ${cls}`);
  }
  assert.doesNotMatch(sizer[1], /overflow-hidden/, 'a clipped grid item contributes no minimum width');
  const button = /<button[^>]*class="([^"]*)"/.exec(html)[1].split(' ');
  for (const cls of ['px-3', 'text-sm', 'font-semibold', 'tabular-nums']) {
    assert.ok(button.includes(cls), `the sizer matches the pill's ${cls}`);
  }
  // The query container sits in the same cell, one layer in.
  assert.match(html, /<\/span><div class="col-start-1 row-start-1 flex w-full justify-end \[container-type:inline-size\]"><button/);
});

test('#3574: while a draft is being saved, the credits pill steps aside for Stop and "Save draft"', () => {
  const composer = panel.slice(panel.indexOf('function Composer('), panel.indexOf('// ── The changes drawer'));
  assert.match(composer, /const kind = saving \? 'save' : running \? 'stop' : 'send';/);
  assert.match(composer, /\{credit && kind !== 'save' \? <CreditPill credit=\{credit\} onOpen=\{\(\) => openSheet\('homeroom'\)\} \/> : <div className="min-w-0 flex-1" \/>\}/,
    'the row keeps its spacer, without the pill');
});
