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
//                `#leaderboard` address landed on until #2374, so the
//                screen's first impression — and again on the Kudos lists.
//   Profile      "Loading profile…" on an otherwise blank screen. The worst
//                of the three: unlike a list there is no chrome around it to
//                say what is coming.
//
// #2440 adds the fourth, and it is the Leaderboard screen's THIRD pane: the
// Challenges tab, which #2374 made that screen's default section, so its
// three lines ("Loading challenges…", "Loading participants…", "Loading…")
// were what the screen opened on while the two tabs beside it had already
// been fixed. Its section is at the foot of this file.
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

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const PRIMITIVE = read('frontend/@/components/ui/skeleton.tsx');
const MESSAGES = read('frontend/src/features/messages/index.tsx');
const KUDOS = read('frontend/src/features/leaderboard/kudos-pane.tsx');
const STANDINGS = read('frontend/src/features/leaderboard/topochain-standings.tsx');
const PROFILE = read('frontend/src/features/profile/profile-view.tsx');
const CHALLENGES_PATH = 'frontend/src/features/leaderboard/challenges-pane.tsx';
const CHALLENGES = read(CHALLENGES_PATH);
const CHALLENGE_CARD = read('frontend/src/features/leaderboard/challenge-card.tsx');

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
    ['standings', STANDINGS], ['profile', PROFILE], ['challenges', CHALLENGES]]) {
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
  assert.match(PROFILE, /rounded-2xl bg-white dark:bg-zinc-900 p-4 mb-3/,
    'profile: the identity card’s face, verbatim');
  assert.match(PROFILE, /rounded-2xl bg-white dark:bg-zinc-900 px-2 py-3/,
    'and the stat cards’ face');
});

test('each stands in for what that screen actually renders', () => {
  // Not "some grey rectangles" — the shapes a viewer is about to see.
  assert.match(MESSAGES, /shape="block" className="w-11 h-11 rounded-xl"/,
    'messages: the lg square UserAvatar’s 44px box — the widget language’s '
    + 'avatar for a person speaking in a conversation');
  assert.match(MESSAGES, /shape="muted" className="ml-auto w-8"/,
    'and the timestamp, pushed right the way the real row’s <time> is');
  assert.match(KUDOS, /shape="circle" className="w-9 h-9"/, 'kudos: the 36px avatar');
  assert.match(KUDOS, /shape="block" className="w-12 h-6 rounded-full"/,
    'and the kudos pill — a row whose right edge is empty and then suddenly '
    + 'is not is the jump this avoids');
  // Profile is the prototype's Me: the card, three stat cards, then two lists
  // of rows with a tile — and all of them are stood in for.
  assert.match(PROFILE, /shape="circle" className="w-14 h-14"/, 'profile: the card’s 56px avatar');
  assert.match(PROFILE, /shape="block" className="w-24 h-8 rounded-full"/,
    'and the Edit button, which is the widest thing in the identity row');
  assert.match(PROFILE, /grid grid-cols-3 gap-2/, 'the three stat cards, in their own grid');
  assert.match(PROFILE, /shape="block" className="w-11 h-11 rounded-xl"/,
    'and the rows’ leading tile, the 44px IconTile the More and contributions rows draw');
});

// ── The fourth: the Challenges pane (#2440) ────────────────────────────
//
// The Leaderboard screen's three tabs are one strip (features/leaderboard/
// index.tsx), and after the two above were fixed the Challenges tab was still
// the odd one out — on the tab that #2374 made the screen's DEFAULT section,
// so its three grey lines ("Loading challenges…", "Loading participants…",
// "Loading…") were the screen's first impression rather than an inner state.
//
// Anchored PER SLOT: three loading branches, in three different components,
// and a whole-file regex would let any one of them quietly go back to a line
// of text while the other two kept the suite green.

/** The source between two markers, asserted to exist. */
function slot(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a !== -1 && b > a, `source slot ${from} … ${to} located`);
  return src.slice(a, b);
}

const DETAIL = {
  key: '5',
  eyebrow: null,
  goal: 'Join block production',
  task: null,
  illustration: null,
  illustrationTone: null,
  deadline: null,
  amount: null,
  state: 'progress',
  stateLabel: '180/500 blocks',
  fill: 0.36,
  counted: true,
  cta: null,
  description: null,
  requirements: null,
  scoring: null,
  participants: 'Participants · 34',
  pointsTotal: null,
  moreLabel: 'Show all 34 →',
  entries: { kind: 'loading' },
};

/** The pane, rendered over one store value. */
function paneHtml(state) {
  const api = loadTsx('tests/fixtures/challenges-pane-api.ts');
  api.topochainChallengesStore.set({ mounted: true, grid: null, detail: null, profile: null, ...state });
  return renderToHtml(createElement(api.ChallengesPane));
}

/**
 * The rendered markup with the group's sr-only label removed.
 *
 * That label SHOULD say "Loading …" — it is the one thing a screen reader is
 * meant to hear. What must be gone is the VISIBLE line, and stripping the
 * label is what lets a plain `Loading` assertion mean exactly that.
 */
const visible = (html) => html.replace(/<div class="sr-only" role="status">[^<]*<\/div>/g, '');

test('challenges: the grid stands in for the CARDS, at the card’s own face', () => {
  const src = slot(CHALLENGES, 'function GridSkeleton(', 'function Grid({');
  assert.match(src, /<SkeletonGroup label="Loading challenges">/, 'one group, one label');
  assert.match(src, /<div className=\{GRID\}>/,
    'the pane’s own grid constant, so the placeholders stand in the columns the cards will');
  assert.match(src, /className=\{CHALLENGE_CARD_FACE\}/,
    'and the SHARED card’s face, exported from ./challenge-card.tsx rather than '
    + 'copied — a second copy goes wrong silently the first time the card moves');
  assert.match(CHALLENGE_CARD, /export const CHALLENGE_CARD_FACE = /, 'which that file exports');
  assert.match(CHALLENGE_CARD, /const CARD = CHALLENGE_CARD_FACE\n?\s*\+ ' cursor-pointer/,
    'and the real card is that face plus the affordances, so neither can drift');
  // The card's three parts, at their real sizes.
  assert.match(src, /shape="block" className="h-20 w-20 rounded-2xl"/,
    'the 5rem artwork tile — IconTile’s `xl`');
  assert.match(src, /shape="block" className="h-9 w-full rounded-\[0\.6875rem\]"/,
    'and the rail at the card’s 36px height and 11px corners (RAIL_SIZE.md)');
  assert.match(src, /<Skeleton shape="muted" className="h-\[5px\] w-full rounded-full" \/>/,
    'the season progress leads, as it does in the loaded grid: without it the '
    + 'whole grid jumps up by that block’s height when the payload lands');

  const html = visible(paneHtml({ grid: { kind: 'loading' } }));
  assert.doesNotMatch(html, /Loading/, 'and no visible line of text is left');
  assert.match(html, /animate-pulse/, 'the placeholders are drawn instead');
});

test('challenges: the participant list stands in for the ENTRY ROW', () => {
  const src = slot(CHALLENGES, 'function EntriesSkeleton(', 'function Entries({');
  assert.match(src, /<SkeletonGroup label="Loading participants" className="flex flex-col">/,
    'the list’s own column');
  assert.match(src, /className=\{ENTRY_BOX\}/,
    'at the real row’s box — the 44px minimum, the outdent and the padding');
  assert.match(CHALLENGES, /const ENTRY_BOX = '-mx-2 flex min-h-11 /, 'which is that row’s, split off');
  assert.match(CHALLENGES, /const ENTRY_ROW = `tc-se-entry \$\{ENTRY_BOX\} `/,
    'and the row itself is still that box plus its hook and affordances');

  const html = visible(renderToHtml(createElement(loadTsx(CHALLENGES_PATH).DetailPage, { view: DETAIL })));
  assert.doesNotMatch(html, /Loading/, 'no visible line of text');
  assert.match(html, /animate-pulse/);
  assert.doesNotMatch(html, /tc-se-entry/,
    'and the placeholder does not claim the row’s selector hook');
});

test('challenges: the profile overlay stands in for the PANEL’s three parts', () => {
  const src = slot(CHALLENGES, 'function ProfileSkeleton(', 'function ProfileBody({');
  assert.match(src, /<SkeletonGroup label="Loading the profile">/);
  assert.match(src, /shape="block" className="h-5 w-40 mb-3"/, 'the name');
  assert.match(src, /<div className="grid grid-cols-2 gap-2 mb-4">/,
    'the stat grid’s own two columns and spacing');

  const html = visible(paneHtml({ profile: { kind: 'loading' } }));
  assert.doesNotMatch(html, /Loading/, 'no visible line of text');
  assert.match(html, /animate-pulse/);
});

test('challenges: all three loading branches hand off to a skeleton, and only those', () => {
  // The branches themselves, so a component that exists but is never returned
  // cannot pass the three tests above.
  for (const [where, from, to, call] of [
    ['the grid', 'function Grid({', 'function Cta(', '<GridSkeleton />'],
    ['the entries', 'function Entries({', 'function PageSection(', '<EntriesSkeleton />'],
    ['the profile', 'function ProfileBody({', '// ── The pane', '<ProfileSkeleton />'],
  ]) {
    const body = slot(CHALLENGES, from, to);
    assert.ok(body.includes(`if (view.kind === 'loading') return ${call};`),
      `${where}: its loading branch returns the skeleton`);
  }
  // The three strings this replaced, gone from the code. Comment-stripped,
  // because each component's note records the line it stands in for.
  for (const gone of ['Loading challenges…', 'Loading participants…']) {
    assert.ok(!code(CHALLENGES).includes(gone), `"${gone}" is no longer rendered`);
  }
  assert.ok(!/>Loading…</.test(code(CHALLENGES)), 'nor the bare "Loading…" the overlay showed');
});

test('a skeleton is never a tap target', () => {
  // The launcher's placeholder learned this the hard way (see
  // features/apps/tile-skeleton.tsx): anything answering the queries a real
  // row answers is a row that can be clicked, dragged or opened, with nothing
  // behind it. These are plain divs — no href, no onClick, no data-* the
  // controllers select on.
  for (const [name, src] of [['messages', MESSAGES], ['kudos', KUDOS],
    ['standings', STANDINGS], ['profile', PROFILE], ['challenges', CHALLENGES]]) {
    // EVERY group in the file, not the first: the Challenges pane has three,
    // and checking one of three is checking none of the other two.
    let at = src.indexOf('<SkeletonGroup');
    assert.ok(at !== -1, `${name}: has a skeleton at all`);
    for (let n = 0; at !== -1; n += 1, at = src.indexOf('<SkeletonGroup', at + 1)) {
      const body = src.slice(at, src.indexOf('</SkeletonGroup>', at));
      assert.ok(!/onClick|href=|data-lb-|data-slug|tc-se-card|tc-se-entry/.test(body),
        `${name}: placeholder group ${n} is inert`);
    }
  }
});
