'use strict';

// Agent sessions on a phone (#3016), and what the green dot on the Homeroom
// mark means (#3015).
//
// #3016: at 390px the session bar's five controls (focus, change, Build,
// Changes, ⋯) came to 537px, and a bar that could not wrap made the whole
// conversation that wide. The screen clips its overflow, so the right edge of
// every message and the Send button were simply gone. The bar wraps now, the
// panel may shrink below its content, and an empty message box is as tall as
// its hint, which wraps on a phone and was cut off mid-line.
//
// #3015: the working cue on the mark (a pulsing emerald dot then, a blue
// corner spinner since the #2779 follow-up, and for the viewer's own changes
// only) means an agent is mid-turn. It said so nowhere. The mark says it on hover,
// and the menu the mark opens says it in words, which is what a touch screen
// gets.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, createElement, renderToHtml } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const panel = read('frontend/src/features/agent-session/index.tsx');

test('#3016: the session bar wraps on every surface, and the panel cannot outgrow the screen', () => {
  const bar = panel.slice(panel.indexOf('function SessionBar('), panel.indexOf('function SessionMenu('));
  assert.match(bar, /<div className="flex flex-wrap items-center gap-x-2 gap-y-2 [^"]*" data-agent-session-bar>/,
    'wrapping is not the embedded variant\'s alone any more');
  assert.doesNotMatch(bar, /embedded \? 'flex-wrap' : ''/);
  assert.match(bar, /data-agent-session-change-pill\s+className=\{`inline-flex shrink-0 items-center whitespace-nowrap /,
    'the change pill stays one line');
  // Below `sm` Build starts the second row and Changes and the ⋯ end it.
  assert.match(bar, /<VenuePicker [^>]*className=\{embedded \? '' : 'sm:ml-auto'\} \/>/);
  assert.match(bar, /data-agent-session-changes-button\s+className="ml-auto [^"]*whitespace-nowrap[^"]* sm:ml-0 /);
  assert.match(read('frontend/src/features/agent-session/handoff.tsx'),
    /inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border/, 'and Build: Homeroom too');

  assert.match(panel, /<div ref=\{root\} className=\{`relative flex min-h-0 min-w-0 flex-1 /,
    'the panel shrinks below its content, so nothing inside can widen the screen');
  assert.match(panel, /className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-agent-session-chat/);
});

test('#3016: an empty message box is sized to its hint, measured without an input event', () => {
  const composer = panel.slice(panel.indexOf('// The field grows with what it holds'), panel.indexOf('function submit('));
  assert.match(composer, /if \(!field\.value && field\.placeholder\) \{\s*field\.value = field\.placeholder;\s*height = field\.scrollHeight;\s*field\.value = '';\s*\}/);
  assert.match(composer, /\}, \[value, placeholder\]\);/, 're-measured when the hint changes (working, archived)');
  assert.match(panel, /placeholder=\{placeholder\}/);
});

test('#3015: the mark says what its green dot means on hover, and keeps its name', () => {
  const mark = read('frontend/src/features/header/platform-mark.tsx');
  assert.match(mark, /const WORKING_TITLE = 'One of your changes is building';/);
  assert.match(mark, /title=\{working \? WORKING_TITLE : undefined\}/, 'only while the dot is showing');
  assert.match(mark, /aria-label="Homeroom menu"/, 'the name the empty board\'s note uses is unchanged');
});

test('#3015: the menu says it in words, after mount only', () => {
  const actions = loadTsx('frontend/src/features/improve/actions.tsx');
  assert.equal(actions.WORKING_NOTE, 'One of your changes is building right now. The Homeroom mark shows it until it finishes.');
  const src = read('frontend/src/features/improve/actions.tsx');
  assert.match(src, /if \(mounted && working\) \{/, 'the lowest priority of the four states, and never in the prerender');
  assert.match(src, /data-improve-working-note/);

  // The prerender, and the hydrating render that must match it, print
  // nothing here even when a turn is already running. The store is handed in
  // so the component reads the very instance the test sets.
  const store = loadTsx('frontend/src/features/improve/improve-store.js');
  const wired = loadTsx('frontend/src/features/improve/actions.tsx', { stubs: { './improve-store.js': store } });
  store.improveStore.set({ ...store.improveStore.get(), working: true });
  assert.equal(store.improveStore.get().working, true);
  assert.equal(renderToHtml(createElement(wired.UpdateStatus)), '');
  // The same render with a build under way does print, so the empty string
  // above is the mounted gate and not a store the component never read.
  store.improveStore.set({ ...store.improveStore.get(), deploying: true });
  assert.match(renderToHtml(createElement(wired.UpdateStatus)), /A new version of this app is being built\./);
});
