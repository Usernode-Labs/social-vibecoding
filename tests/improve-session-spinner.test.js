// #1597 — an in-progress change in Improve spins the platform's arc.
//
// The report was about consistency, and it was right: everywhere else on the
// platform that something is happening RIGHT NOW, the same 12px arc turns —
// the dev screen's session list, a proposal running its checks, "Preview
// building…" on a board card, "Proposing…" in a transcript, the merge-status
// badges, the app-launch cover. All of them are `.dc-status-spinner-arc` out
// of public/css/app.css. The Improve row was the one surface that said it a
// different way, by pulsing its tile badge, so a reader who had learned the
// arc everywhere else had to learn a second vocabulary for one list.
//
// What these tests pin is the part a screenshot cannot check:
//
//   1. The arc is the SHARED class, not a second spinner drawn locally. A
//      lookalike would drift the moment app.css retunes the real one.
//   2. It is gated on `busy`. A row that is Ready or Handed off must not
//      turn — a handed-off work order especially, whose agent runs where
//      this side cannot see whether a turn is in flight (#1417).
//   3. The pulse is GONE rather than joined. One fact wants one cue; the
//      badge keeps its amber, which is what makes a column of tiles
//      scannable, and gives up the motion the pill now carries.
//   4. The arc is recoloured to the pill's own ink. The shared class borders
//      in `var(--accent)`, which is blue, and a blue arc in an amber pill is
//      off-palette in both themes.
//
// Source assertions, because the whole thing is a class string: the rendered
// evidence is dapp.json's declared check on the busy mock row, retargeted in
// the same commit.
//
// Run with: node --test tests/improve-session-spinner.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ROW_TSX = read('frontend/src/features/improve/session-row.tsx');
const CONTROLLER = read('frontend/src/features/improve/improve-controller.js');
const DEV_CHAT_LIST = read('frontend/src/features/dev-chat/session-list.tsx');
const APP_CSS = read('public/css/app.css');
const MANIFEST = JSON.parse(read('dapp.json'));

/** The `stateOf` table on its own — three branches, one per state. */
function stateOfBody() {
  const start = ROW_TSX.indexOf('function stateOf(');
  assert.ok(start > 0, 'stateOf is where the row decides all of this');
  // `\n}\n`, not `\n}` — the return-type annotation closes with `} {` on its
  // own line, so the looser needle cuts the table off before the first branch.
  const end = ROW_TSX.indexOf('\n}\n', start);
  assert.ok(end > start, 'the table closes at column 0');
  return ROW_TSX.slice(start, end);
}

// ── The arc is the platform's, not a local lookalike ───────────────────

test('the busy row draws the shared arc, by the shared class name', () => {
  assert.match(ROW_TSX, /className="dc-status-icon dc-status-spinner-arc"/,
    'both classes: dc-status-icon sizes the 14px box, the arc draws in it');
  // The same pair the dev screen's own session list renders for the same
  // fact — that list is the closest comparable surface, and matching it is
  // the whole of #1597.
  assert.match(DEV_CHAT_LIST, /dc-status-icon dc-status-spinner-arc/);
  // And it is a real class with real keyframes behind it, not a name that
  // resolves to nothing.
  assert.match(APP_CSS, /\.dc-status-spinner-arc\s*\{/);
  assert.match(APP_CSS, /@keyframes dc-spin/);
});

test('nothing here re-implements the spinner', () => {
  assert.doesNotMatch(ROW_TSX, /@keyframes|animate-spin|<svg/,
    'a second spinner drifts from app.css the first time the real one is tuned');
});

// ── It turns only while a turn is in flight ────────────────────────────

test('the spinner is gated on the busy state alone', () => {
  const body = stateOfBody();
  assert.equal((body.match(/spinner: true/g) || []).length, 1,
    'exactly one branch spins');
  assert.equal((body.match(/spinner: false/g) || []).length, 2,
    'and the other two say so explicitly rather than leaving it undefined');

  // The `spinner: true` must be the branch guarded by session.busy — the
  // first one — not whichever branch happens to be listed first.
  const busyBranch = body.slice(body.indexOf('if (session.busy)'),
    body.indexOf("if (session.kind === 'task')"));
  assert.match(busyBranch, /label: 'Working'/);
  assert.match(busyBranch, /spinner: true/);

  const taskBranch = body.slice(body.indexOf("if (session.kind === 'task')"));
  assert.match(taskBranch, /label: 'Handed off'[\s\S]{0,200}?spinner: false/,
    'a work order runs on the user own machine; an arc turning here would '
    + 'claim a liveness this side has no way to observe (#1417)');
});

test('the row renders the arc behind that flag, not unconditionally', () => {
  assert.match(ROW_TSX,
    /\{state\.spinner \? \([\s\S]{0,240}?dc-status-spinner-arc[\s\S]{0,120}?\) : null\}/,
    'a Ready row must show no spinner at all');
});

test('what counts as busy is untouched', () => {
  // The change is presentational. If the states that mean "in flight" moved
  // with it, the check on the mock busy row would still pass while every
  // real row said something different.
  assert.match(CONTROLLER, /BUSY_STATES = new Set\(\['running', 'starting', 'queued'\]\)/);
  assert.match(CONTROLLER, /busy: false/,
    'and a work order is still never busy (#1417)');
});

// ── One fact, one cue ──────────────────────────────────────────────────

test('the tile badge keeps its amber and gives up its pulse', () => {
  const body = stateOfBody();
  assert.match(body, /badge: 'bg-amber-400',/,
    'the colour stays — it is what makes a column of tiles scannable');
  assert.doesNotMatch(ROW_TSX, /animate-pulse/,
    'the motion is the pill spinner now; two cues for one fact is the thing '
    + '#1610 already removed from the button that opens this panel');
});

// ── The arc takes the pill's ink ───────────────────────────────────────

test('the spinner is recoloured to the pill rather than left accent-blue', () => {
  assert.match(ROW_TSX, /\[&>\.dc-status-spinner-arc\]:border-current/,
    'one literal covers every state and both themes');
  assert.match(ROW_TSX, /\[&>\.dc-status-spinner-arc\]:border-r-transparent/,
    'border-current would otherwise close the ring and stop it reading as an arc');
  // The base class really is accent-coloured, which is why the override has
  // to exist at all.
  const rule = APP_CSS.slice(APP_CSS.indexOf('.dc-status-spinner-arc {'));
  assert.match(rule.slice(0, 300), /border:\s*2px solid var\(--accent\)/);
  // Scoped to this pill, exactly as .dc-pr-btn-promote scopes its own
  // recolour — the shared class stays untouched for everyone else.
  assert.match(APP_CSS, /\.dc-pr-btn-promote \.dc-status-spinner-arc/);
});

test('the pill lays its two children out like the platform\'s other one', () => {
  const pill = ROW_TSX.slice(ROW_TSX.indexOf('const PILL_BASE'));
  assert.match(pill.slice(0, 400), /inline-flex items-center gap-1/,
    'gap-1 is the 4px .gc-checks-running-badge puts between the same arc and '
    + 'the same 11px semibold label');
  assert.match(APP_CSS, /\.gc-checks-running-badge[\s\S]{0,200}?gap:\s*4px/);
});

// ── The declared check follows the markup ──────────────────────────────

test('the Improve busy-row check selects the arc, and no check was added', () => {
  const busy = MANIFEST.tests.filter((t) =>
    /improve-panel a\[href\$="\/sessions\/990102"\]/.test(t.expectSelector || ''));
  assert.equal(busy.length, 1, 'one check owns the busy mock row');
  assert.match(busy[0].expectSelector, /\.dc-status-spinner-arc$/,
    'retargeted with the markup — .animate-pulse now matches nothing there');
  assert.equal(busy[0].path, '/?shot=improve&demo=1#app/usernode-2d5619/dev');

  // The manifest is near its ceiling (MAX_DECLARED_TESTS, and the suite
  // reserves 20 more on top), so this change retargets rather than adds.
  assert.ok(MANIFEST.tests.length <= 459,
    `declared checks grew to ${MANIFEST.tests.length}; #1597 adds none`);
});
