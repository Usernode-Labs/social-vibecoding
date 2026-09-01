// The three screens that were still showing the WORD "Loading…".
//
// ── What they showed, and why it is worse than nothing ────────────────
//
// A spinner or a line of grey text says "busy, somewhere". A skeleton says
// WHERE the content is going and roughly how much of it there is, which is
// the part that stops a half-drawn screen reading as a finished one — the
// argument card/skeleton.tsx made for the Dev board and that these three had
// never had applied to them:
//
//   Messages     a spinner beside "Loading conversations…", centred in an
//                otherwise empty list pane.
//   Leaderboard  "Loading…" on the standings — the pane the bare
//                `#leaderboard` address lands on, so the screen's first
//                impression — and again on the Kudos lists.
//   Profile      "Loading profile…" on an otherwise blank screen. The worst
//                of the three: unlike a list there is no chrome around it to
//                say what is coming.
//
// ── The shared part is the GREYS, not the row ─────────────────────────
//
// @/components/ui/skeleton.tsx is two variants and a wrapper. The row shapes
// stay local, because a 66px conversation row, a bordered leaderboard row, a
// standings table and a profile identity card have nothing in common except
// the colour — and each borrows the REAL class of the thing it stands in for,
// so a placeholder cannot drift from its row when that row changes.
//
// Run with: node --test tests/screen-skeletons.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const PRIMITIVE = read('frontend/@/components/ui/skeleton.tsx');
const MESSAGES = read('frontend/src/features/messages/index.tsx');
const KUDOS = read('frontend/src/features/leaderboard/kudos-pane.tsx');
const STANDINGS = read('frontend/src/features/leaderboard/topochain-standings.tsx');
const PROFILE = read('frontend/src/features/profile/profile-view.tsx');

/** Source with comments stripped — prose names the strings these ban. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── The primitive ──────────────────────────────────────────────────────

test('the primitive is a shell component, in the shell palette', () => {
  // It lives in @/components/ui/, which is the platform surface — so it is
  // zinc, and tests/admin-ui-registry.test.js's palette rule covers it for
  // free. Named here because the alternative (a fourth bespoke skeleton) is
  // what this file exists to prevent.
  assert.match(PRIMITIVE, /from 'class-variance-authority'/,
    'variants are a cva table, like every other primitive here');
  assert.ok(!/\bgray-|\bindigo-/.test(PRIMITIVE),
    'no stock hues: zinc and violet are overridden in tailwind.config.js, so '
    + 'a gray-* here renders an untuned shade beside the platform’s');
  // Complete literals: Tailwind's extractor is a regex over source text.
  // Comment-stripped, because the note above the cva table explains the rule
  // by writing out the very shape it bans.
  assert.ok(!/bg-zinc-\$\{|\bh-\$\{|\bw-\$\{/.test(code(PRIMITIVE)),
    'no computed class names — a computed class is one that never compiles');
});

test('the pulse and the label belong to the GROUP, not to each bar', () => {
  // Per-element animation drifts out of phase and reads as several things
  // loading independently, which is what a skeleton is trying not to say.
  const group = PRIMITIVE.slice(PRIMITIVE.indexOf('export function SkeletonGroup'));
  assert.match(group, /animate-pulse/, 'the group carries the pulse');
  assert.match(group, /role="status"/, 'and one live-region label');
  assert.match(group, /aria-hidden="true"/,
    'over geometry that is hidden from assistive tech — a reader should hear '
    + 'the label once, not a description of the rectangles');
  // The bars themselves must NOT animate: two clocks is the bug above.
  const bars = PRIMITIVE.slice(
    PRIMITIVE.indexOf('const skeleton = cva('),
    PRIMITIVE.indexOf('export function SkeletonGroup'),
  );
  assert.ok(!/animate-pulse/.test(bars), 'the variants carry no animation of their own');
});

// ── Each screen borrows the real thing's geometry ──────────────────────

test('every one of the three uses the primitive, and none still says "Loading…"', () => {
  for (const [name, src] of [['messages', MESSAGES], ['kudos', KUDOS],
    ['standings', STANDINGS], ['profile', PROFILE]]) {
    assert.match(src, /from '@\/components\/ui\/skeleton'/,
      `${name} imports the shared primitive rather than rolling its own greys`);
    assert.match(src, /<SkeletonGroup/, `${name} renders one`);
  }
  // The literal placeholder text is gone from the LOADING branches. Checked on
  // code, since each file's comment records the string it replaced.
  assert.ok(!/Loading conversations…/.test(code(MESSAGES)),
    'messages no longer renders the words');
  assert.ok(!/>Loading…</.test(code(KUDOS).replace(/'Loading…' : 'Load more'/, '')),
    'the kudos LIST no longer renders the words — the Load-more BUTTON still '
    + 'may, and should: a button that is working is not a skeleton');
  assert.ok(!/Loading profile…/.test(code(PROFILE)), 'profile no longer renders them');
});

test('the placeholders borrow the REAL row classes, so they cannot drift', () => {
  // THE POINT OF THE WHOLE FILE. A hand-rolled imitation of a row is a second
  // definition of that row's geometry, and it goes wrong silently the first
  // time the real one moves. Each of these names the same class the loaded
  // row is drawn with.
  assert.match(MESSAGES, /<div key=\{i\} className="messages-conversation-row">/,
    'messages: the row class itself — which owns the 66px height, the padding '
    + 'and the inset separator, all in app.css');
  assert.match(KUDOS, /<div key=\{i\} className=\{ROW\}>/,
    'kudos: ROW, the constant all four of that pane’s lists draw with');
  assert.match(STANDINGS, /rounded-lg border border-zinc-200 dark:border-zinc-800/,
    'standings: the table’s own container');
  assert.match(STANDINGS, /bg-zinc-50 dark:bg-zinc-900/,
    'and the <thead>’s own ground for the header strip');
  assert.match(PROFILE, /rounded-2xl bg-white dark:bg-zinc-900 p-4 mb-5/,
    'profile: the identity card’s face, verbatim');
});

test('each stands in for what that screen actually renders', () => {
  // Not "some grey rectangles" — the shapes a viewer is about to see.
  assert.match(MESSAGES, /shape="circle" className="w-11 h-11"/,
    'messages: the lg UserAvatar’s 44px box');
  assert.match(MESSAGES, /shape="muted" className="ml-auto w-8"/,
    'and the timestamp, pushed right the way the real row’s <time> is');
  assert.match(KUDOS, /shape="circle" className="w-9 h-9"/, 'kudos: the 36px avatar');
  assert.match(KUDOS, /shape="block" className="w-12 h-6 rounded-full"/,
    'and the kudos pill — a row whose right edge is empty and then suddenly '
    + 'is not is the jump this avoids');
  // Profile is three things stacked, and all three are stood in for.
  assert.match(PROFILE, /shape="block" className="w-24 h-9"/, 'profile: the points figure');
  assert.match(PROFILE, /shape="block" className="w-24 h-8 rounded-full"/,
    'and the Edit button, which is the widest thing in the identity row');
});

test('a skeleton is never a tap target', () => {
  // The launcher's placeholder learned this the hard way (see
  // features/apps/tile-skeleton.tsx): anything answering the queries a real
  // row answers is a row that can be clicked, dragged or opened, with nothing
  // behind it. These are plain divs — no href, no onClick, no data-* the
  // controllers select on.
  for (const [name, src] of [['messages', MESSAGES], ['kudos', KUDOS],
    ['standings', STANDINGS], ['profile', PROFILE]]) {
    const at = src.indexOf('<SkeletonGroup');
    const body = src.slice(at, src.indexOf('</SkeletonGroup>', at));
    assert.ok(!/onClick|href=|data-lb-|data-slug/.test(body),
      `${name}: the placeholder rows are inert`);
  }
});
