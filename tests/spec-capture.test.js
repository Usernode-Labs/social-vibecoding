'use strict';

// A spec turn's final message, captured whole or not at all (7 Oct 2026),
// from the two shapes the App bench caught GLM 5.3 Flash leaving:
//
//   - run 8, trial 1240: the message began with stray markup,
//     `<aside support id="x-0"></aside><article data-spec>`, so the HTML spec
//     was not seen as one and its raw HTML was stored as if it were markdown;
//   - run 9, trial 1246: the stored spec was the document's last ~2,200
//     characters, starting mid-list at "<li>Short stages (a 2 minute boil)
//     keep the 12 percent minimum segment width" and ending
//     "</ul>\n</section>\n</artic​le>", a zero-width space INSIDE the
//     closing tag. Claude Code continues an answer cut at the output-token
//     limit in a new message and reports only that last message as the
//     turn's result; the worker now keeps every text block since the turn's
//     last tool call (answerParts) and the capture puts them back together.
//
// A fragment (no "# " title, no <article data-spec>) is never kept as the
// spec: with no whole answer to read, the capture fails and the build goes
// on from the plan, saying why.
//
// Run with: node --test tests/spec-capture.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const specHtml = require('../src/services/spec-html');
const { finalAnswerText, joinContinuation } = require('../src/services/agent-result-text');
const live = require('../src/services/homeroom-bot-live');
const worker = require('../src/services/worker');

const ZWSP = '​';

const ARTICLE = `<article data-spec>
<h1>Plan each session on a timeline</h1>
<section data-spec-tab="user">
<h3>Design</h3>
<p>One timeline per session, its stages as segments.</p>
<h3>Assumptions</h3>
<ul><li>Times are local.</li></ul>
</section>
<section data-spec-tab="tech">
<h3>Edge cases</h3>
<ul>
<li>A stage with no duration is left out.</li>
<li>Short stages (a 2 minute boil) keep the 12 percent minimum segment width, so their label still fits.</li>
<li>Overlapping stages stack.</li>
</ul>
</section>
</article>`;

// Trial 1246's two messages: the answer cut mid-word at the output limit,
// then the continuation, which wrote the cut list item again from its start
// (as Claude Code asks) and carried a zero-width space inside </article>.
const CUT_AT = ARTICLE.indexOf('minute boil');
const PART_1 = ARTICLE.slice(0, CUT_AT + 'minute bo'.length);
const PART_2 = ARTICLE.slice(ARTICLE.indexOf('<li>Short stages')).replace('</article>', `</artic${ZWSP}le>`);

test('trial 1240: an <article data-spec> after stray markup is the spec, and the markup goes', () => {
  const message = `<aside support id="x-0"></aside>${ARTICLE}`;
  assert.equal(specHtml.isHtmlSpec(message), true);
  assert.equal(specHtml.extractHtmlSpec(message), ARTICLE);
  const out = specHtml.normalizeSpecOutput(message);
  assert.equal(out.html, ARTICLE);
  assert.match(out.markdown, /^# Plan each session on a timeline\n/);
  const read = live.readSpec(message);
  assert.equal(read.ok, true);
  assert.match(read.specMd, /^# Plan each session on a timeline/);
  assert.equal(read.specHtml, ARTICLE);
});

test('an article is found after a short preamble or inside a fence, and trailing text is dropped', () => {
  assert.equal(specHtml.extractHtmlSpec(`Here is the spec.\n${ARTICLE}\nDone.`), ARTICLE);
  assert.equal(specHtml.extractHtmlSpec(`Here is the spec:\n\`\`\`html\n${ARTICLE}\n\`\`\``), ARTICLE);
  assert.equal(specHtml.extractHtmlSpec(`${ARTICLE}\n<p>stray</p>`), ARTICLE);
  // At the top, as it always was, an unclosed one is still kept from there.
  assert.equal(specHtml.extractHtmlSpec('<article data-spec><h1>T</h1>'), '<article data-spec><h1>T</h1>');
});

test('a markdown spec that only mentions the format is never read as one', () => {
  assert.equal(specHtml.isHtmlSpec('# Use HTML specs\n\nWrap it in <article data-spec> and close with </article>.'), false);
  assert.equal(specHtml.isHtmlSpec('Wrap it in `<article data-spec>` and close with </article>.'), false);
  assert.equal(specHtml.isHtmlSpec('It writes <article data-spec> tags, then </article>.'), false);
  assert.equal(specHtml.isHtmlSpec('Before\n<article data-spec><h1>never closed</h1>'), false, 'one found further in must close');
  assert.equal(specHtml.isHtmlSpec(`${'x'.repeat(5000)}\n${ARTICLE}`), false, 'not after a long text');
});

test('invisible characters go before the spec is read; visible text and meaningful joiners stay', () => {
  assert.equal(specHtml.stripInvisible(`</artic${ZWSP}le>`), '</article>');
  assert.equal(specHtml.stripInvisible('﻿a⁠b‌c‍d'), 'abcd');
  // A family emoji's joiners and a Persian word's non-joiner do something.
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  const persian = 'می‌خواهم';
  assert.equal(specHtml.stripInvisible(`${family} ${persian}`), `${family} ${persian}`);
  assert.equal(specHtml.stripInvisible('Plain text, “quotes” and é stay.'), 'Plain text, “quotes” and é stay.');
  // A zero-width space before the article no longer hides it.
  assert.equal(specHtml.isHtmlSpec(`${ZWSP}${ARTICLE}`), true);
  const read = live.readSpec(ARTICLE.replace('</article>', `</artic${ZWSP}le>`));
  assert.equal(read.ok, true);
  assert.ok(read.specHtml.endsWith('</article>'));
});

test('trial 1246: the last message alone is a fragment, never kept as the spec', () => {
  assert.ok(PART_2.startsWith('<li>Short stages (a 2 minute boil) keep the 12 percent minimum segment width'));
  assert.ok(PART_2.endsWith(`</ul>\n</section>\n</artic${ZWSP}le>`));
  const read = live.readSpec(PART_2);
  assert.equal(read.ok, false);
  assert.equal(read.fragment, true);
  assert.match(read.error, /only part of a spec \(no "# " title and no <article data-spec>\), so it was not kept/);
  assert.equal(read.specMd, undefined);
  // A markdown message with no title is a fragment too; BLOCKED and an empty
  // message keep their own answers.
  assert.equal(live.readSpec('- the end of a list\n- and its last item').fragment, true);
  assert.deepEqual(live.readSpec('BLOCKED: no such screen'), { ok: false, blocked: 'no such screen', error: 'blocked: no such screen' });
  assert.deepEqual(live.readSpec('  '), { ok: false, error: 'the spec turn returned nothing' });
});

test('trial 1246: the answer is put back together from its messages, the cut item written once', () => {
  const whole = joinContinuation(PART_1, PART_2);
  assert.equal(specHtml.stripInvisible(whole), ARTICLE);
  const read = live.readSpec(PART_2, { parts: [PART_1, PART_2] });
  assert.equal(read.ok, true);
  assert.equal(read.joined, true);
  assert.equal(read.specHtml, ARTICLE);
  assert.match(read.specMd, /^# Plan each session on a timeline/);
  assert.equal((read.specMd.match(/Short stages/g) || []).length, 1, 'the item written again is not doubled');
  // Narration before the document is not part of it.
  const narrated = live.readSpec(PART_2, { parts: ['All the code I need is read. Writing the spec now.', PART_1, PART_2] });
  assert.equal(narrated.specHtml, ARTICLE);
  // A whole message reads as it always did: the parts are not consulted.
  assert.deepEqual(live.readSpec(`# Title\n\n## User-facing changes\n\nx`, { parts: ['junk'] }), {
    ok: true, specMd: '# Title\n\n## User-facing changes\n\nx',
  });
});

test('pieces of one answer join as the continuation wrote them', () => {
  // Written again from the start of the cut line.
  assert.equal(joinContinuation('a\n<li>Short stages (a 2 min', '<li>Short stages (two minutes) keep</li>'), 'a\n<li>Short stages (two minutes) keep</li>');
  // Picked up mid-word.
  assert.equal(joinContinuation('the timeli', 'ne shows'), 'the timeline shows');
  // A finished sentence, then a new block.
  assert.equal(joinContinuation('Writing it now.', '# Title'), 'Writing it now.\n# Title');
  assert.equal(finalAnswerText([]), '');
  assert.equal(finalAnswerText(['a', null, 'b']), 'ab');
  assert.equal(finalAnswerText(['x.', '# T', 'y'], { opens: (p) => p.startsWith('# ') }), '# Ty');
  assert.equal(finalAnswerText(['x.', '# T\n', '# not a title'], { opens: (p) => p.startsWith('# ') }), '# T\n# not a title', 'from the first opening');
});

test('the worker keeps every text block since the last tool call, and the result is still the last one', () => {
  const state = worker.newWatchState();
  const line = (event) => worker.parseLine(JSON.stringify(event), () => {}, state);
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the template.' }] } });
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'server.js' }] } });
  line({ type: 'assistant', message: { content: [{ type: 'text', text: PART_1 }] } });
  // Claude Code's note to go on, which the stream may carry as a user message.
  line({ type: 'user', message: { content: 'Your response was cut off because it exceeded the output token limit.' } });
  line({ type: 'assistant', message: { content: [{ type: 'text', text: PART_2 }] } });
  line({ type: 'result', subtype: 'success', result: PART_2 });
  assert.equal(state.lastResultText, PART_2);
  assert.deepEqual(state.answerParts, [PART_1, PART_2], 'the narration before the tool call is not kept');
  const read = live.readSpec(state.lastResultText, { parts: state.answerParts });
  assert.equal(read.ok, true);
  assert.equal(read.specHtml, ARTICLE);
});
