'use strict';

// Agent sessions on a phone (#3016), and what the green dot on the Homeroom
// mark means (#3015).
//
// #3016: at 390px the session bar's five controls (focus, change, Build,
// Changes, ⋯) came to 537px, and a bar that could not wrap made the whole
// conversation that wide. The screen clips its overflow, so the right edge of
// every message and the Send button were simply gone. The panel may shrink
// below its content, and an empty message box is as tall as its hint, which
// wraps on a phone and was cut off mid-line.
//
// #3577: the bar wrapped too much, dropping Changes and the ⋯ to a second row
// on a phone. The last two now stay on the pills' row: the outer bar still
// wraps so the Messages pane's title can take its own row, but the controls
// sit in one non-wrapping cluster where only the app pill gives way. The state
// pill leaves off its "· PR #n" below `sm` to make the room.
//
// #3559: the same failure from inside the transcript. A row holding one
// unbroken run of text (a pasted link, a path) made the conversation wider
// than the phone, and since it scrolls it slid sideways instead of clipping.
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

test('#3577: the bar wraps only for the Messages title; the pills and controls stay on one line', () => {
  const bar = panel.slice(panel.indexOf('function SessionBar('), panel.indexOf('function SessionMenu('));
  // The outer bar may still wrap: the embedded title is basis-full on a
  // phone, so it takes a row of its own and the cluster follows.
  assert.match(bar, /<div className="flex flex-wrap items-center gap-x-2 gap-y-2 [^"]*" data-agent-session-bar>/,
    'the outer bar still wraps for the embedded title');
  assert.match(bar, /<div className="mr-auto min-w-0 basis-full sm:basis-auto">/);
  // The controls cluster fills the bar's width. On a phone it never wraps;
  // from `sm` up it may, as the whole bar did before: the Messages pane beside
  // the inbox is only ~256px wide in a 900px window, where four fixed controls
  // cannot fit, and wrapping keeps Changes and the ⋯ on screen.
  assert.match(bar, /<div className="flex min-w-0 flex-1 flex-nowrap items-center gap-x-1\.5 sm:flex-wrap sm:gap-x-2">/,
    'the cluster takes the row, stays on one line on a phone, and only wraps where a narrow pane leaves no room');
  // The app pill is the only flexible item, so it shortens instead of
  // pushing a control off the row.
  assert.match(bar, /data-agent-session-focus\s+className="inline-flex min-w-0 max-w-\[10rem\][^"]*"/);
  assert.match(bar, /<span className="truncate">\{about\?\.focusApp\?\.name \|\| 'Any app'\}<\/span>/);
  assert.match(bar, /data-agent-session-change-pill\s+className=\{`inline-flex shrink-0 items-center whitespace-nowrap /,
    'the change pill stays one line');
  // The PR number is the room the phone row does not have: hidden there, and
  // back from `sm` up. It is still on the staging card and in the drawer.
  assert.match(bar, /active\.prNumber \? <span className="hidden sm:inline"> · PR #\{active\.prNumber\}<\/span> : null/);
  // Changes and the ⋯ end the row. Build left the bar for the composer's
  // "Build with" (#3078).
  assert.doesNotMatch(bar, /VenuePicker/);
  assert.match(bar, /data-agent-session-changes-button\s+className="ml-auto [^"]*shrink-0[^"]*whitespace-nowrap[^"]*"/);
  assert.doesNotMatch(bar, /data-agent-session-changes-button\s+className="[^"]*sm:ml-0/, 'nothing before it to push it right any more');

  assert.match(panel, /<div ref=\{root\} className=\{`relative flex min-h-0 min-w-0 flex-1 /,
    'the panel shrinks below its content, so nothing inside can widen the screen');
  assert.match(panel, /className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-agent-session-chat/);
});

test('#3016: an empty message box is sized to its hint, measured without an input event', () => {
  const composer = panel.slice(panel.indexOf('// The field grows with what it holds'), panel.indexOf('function submit('));
  assert.match(composer, /if \(!field\.value && field\.placeholder\) \{\s*field\.value = field\.placeholder;\s*height = field\.scrollHeight;\s*field\.value = '';\s*\}/);
  assert.match(composer, /useEffect\(\(\) => \{ fitField\(\); \}, \[value, placeholder, fitField\]\);/,
    're-measured when the hint changes (working, archived), and on a width change (tests/agent-session-attachments.test.js)');
  assert.match(panel, /placeholder=\{placeholder\}/);
});

test('#3015: the mark says what its green dot means on hover, and keeps its name', () => {
  const mark = read('frontend/src/features/header/platform-mark.tsx');
  assert.match(mark, /const WORKING_TITLE = 'One of your changes is building';/);
  assert.match(mark, /title=\{working \? WORKING_TITLE : undefined\}/, 'only while the dot is showing');
  assert.match(mark, /aria-label="Homeroom menu"/, 'the name the empty board\'s note uses is unchanged');
});

test('#3075: the menu no longer says it in words; the mark\'s own spinner stays', () => {
  const actions = loadTsx('frontend/src/features/improve/actions.tsx');
  assert.equal(actions.WORKING_NOTE, undefined, 'the note is gone');
  const src = read('frontend/src/features/improve/actions.tsx');
  assert.doesNotMatch(src, /building right now|data-improve-working-note|The Homeroom mark shows it/);
  assert.match(read('frontend/src/features/header/platform-mark.tsx'), /id="improve-working-dot"/,
    'the corner spinner on the Homeroom mark is kept');

  // A change of the viewer's working prints nothing here, before mount or
  // after; the build lines are unchanged. The store is handed in so the
  // component reads the very instance the test sets.
  const store = loadTsx('frontend/src/features/improve/improve-store.js');
  const wired = loadTsx('frontend/src/features/improve/actions.tsx', { stubs: { './improve-store.js': store } });
  store.improveStore.set({ ...store.improveStore.get(), working: true });
  assert.equal(renderToHtml(createElement(wired.UpdateStatus)), '');
  store.improveStore.set({ ...store.improveStore.get(), deploying: true });
  assert.match(renderToHtml(createElement(wired.UpdateStatus)), /A new version of this app is being built\./);
  store.improveStore.set({ ...store.improveStore.get(), deploying: false, versionState: 'downloading' });
  assert.match(renderToHtml(createElement(wired.UpdateStatus)), /A new version of the platform is downloading\./);
  store.improveStore.set({ ...store.improveStore.get(), versionState: 'ready' });
  assert.match(renderToHtml(createElement(wired.UpdateStatus)), /There is a new version available\./);
});

// #3559: "can overscroll horizontally on mobile on agent chats". The
// transcript scrolls down, and `overflow-y: auto` makes `overflow-x` auto
// too, so one unbroken run of text held the whole conversation wider than a
// phone and it slid sideways under a finger. Measured at 390px: a staging
// link pasted into the reader's own bubble took the scroller to 690px; a
// failed turn's note and a card titled with a path did the same. The
// Mayor's markdown never did (`.dc-msg-content` breaks its words); the rows
// around it did, because nothing told them to.
test('#3559: the transcript breaks a long word in its own row instead of growing sideways', () => {
  const scroller = panel.match(/<div ref=\{scroll\} className="([^"]*)"/);
  assert.ok(scroller, 'the transcript scroller is found');
  const classes = scroller[1].split(/\s+/);
  assert.ok(classes.includes('[overflow-wrap:anywhere]'),
    'set once on the scroller and inherited by every row, including rows added later');
  assert.ok(!classes.includes('break-words'),
    'anywhere, not break-word: the note beside Retry is a flex item and a request title a centred block, held at their longest word otherwise');
  assert.ok(classes.includes('overflow-y-auto'), 'it still scrolls down');
  assert.ok(!classes.some((c) => /^overflow-(x-)?(hidden|clip)$/.test(c)),
    'nothing is hidden to get there: the rows fit, so there is nothing to clip');

  // The two boxes that SHOULD scroll sideways still do, inside themselves,
  // because overflow-wrap cannot reach text that never wraps.
  const css = read('public/css/app.css');
  const code = css.match(/\.dc-code-block \{[^}]*\}/)[0];
  assert.match(code, /overflow-x: auto;/, 'a long code line scrolls inside its block');
  assert.doesNotMatch(code, /white-space|overflow-wrap/, 'and the block is a <pre> that never wraps');
  assert.match(css, /\.dc-table \{[^}]*display: block; overflow-x: auto; \}/, 'a wide table scrolls inside itself');
});
