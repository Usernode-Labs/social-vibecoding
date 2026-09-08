// Check my status, on the screen (#1538).
//
// Anyone can now read where they stand from a device that never joined: enter
// the address, get a six-digit code by mail, type it in. The reply carries the
// row's state and the confirm panel prints it instead of the one fixed
// sentence it used to print.
//
// This file pins the parts a runtime check cannot reach on its own: that the
// panel reads off the response rather than hardcoding an outcome, that the
// three-state vocabulary has exactly one definition, that the states a
// screenshot needs are reachable by URL, and that a staging preview has the
// data to show them.
//
// Source-text assertions, same idiom as tests/waitlist-copy-length.test.js:
// these are contracts about how the screen is WRITTEN, and the declared
// checks in dapp.json cover what it renders.
//
// Run with: node --test tests/waitlist-status-panel.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const WAITLIST = read('frontend/src/features/auth/waitlist.tsx');
const MORE = read('frontend/src/features/auth/more.tsx');
const SHARED = read('frontend/src/features/auth/waitlist-shared.tsx');
const LANDING = read('frontend/src/features/auth/landing.tsx');
const APP = read('public/js/app.js');
const MIGRATE = read('src/db/migrate.js');
const DAPP = JSON.parse(read('dapp.json'));

// ─── One definition of the three states ──────────────────────────────

test('the queue pill is defined once and rendered by both screens', () => {
  // The stage-2 survey had this table to itself. Duplicating it for the
  // confirm panel is how the same row starts being described two different
  // ways, so it moved into the shared module and both screens import it.
  assert.match(SHARED, /export const QUEUE_PILL = \{/);
  assert.match(SHARED, /export function StatusPill\(\{\s*id,\s*status,/);
  assert.match(SHARED, /export interface WaitlistStatus \{/);

  for (const [name, src] of [['waitlist.tsx', WAITLIST], ['more.tsx', MORE]]) {
    assert.doesNotMatch(src, /const QUEUE_PILL/, `${name} redefines the pill table`);
    assert.doesNotMatch(src, /function StatusPill/, `${name} redefines the pill`);
    assert.match(src, /StatusPill/, `${name} does not render the shared pill`);
  }
  // The id is a prop precisely because there are two hosts now.
  assert.match(MORE, /<StatusPill id="more-status-pill"/);
  assert.match(WAITLIST, /<StatusPill\s*\n\s*id="waitlist-status-pill"/);
});

test('the pill drops its note where the panel already says it', () => {
  // The note is the survey screen's only guidance, so it stays on there. On
  // check-my-status it would restate the body copy a line later, and for an
  // admitted reader it would point at a mail instead of the button beside it.
  assert.match(WAITLIST, /id="waitlist-status-pill"\s*\n\s*status=\{codeOnly \? status : null\}\s*\n\s*note=\{false\}/);
  assert.doesNotMatch(MORE, /note=\{false\}/, 'the survey screen lost its guidance');
  assert.match(SHARED, /note: showNote = true,/, 'the note is opt-out, not opt-in');
});

test('every pill tint is a whole class literal', () => {
  // Tailwind's extractor is a regex over source text, so a tint assembled at
  // runtime is a tint that never gets compiled and a pill with no colour.
  const table = SHARED.slice(SHARED.indexOf('export const QUEUE_PILL'));
  const body = table.slice(0, table.indexOf('} as const;'));
  assert.doesNotMatch(body, /`/, 'a template literal in a class string');
  assert.doesNotMatch(body, /\+\s*$/m, 'a concatenated class string');
  for (const state of ['pending', 'confirmed', 'admitted']) {
    assert.ok(body.includes(`${state}: {`), `${state} is missing from the table`);
  }
});

// ─── The panel reads the row, it does not assume one ─────────────────

test('the confirmed panel branches on the response, not on a constant', () => {
  const panel = WAITLIST.slice(WAITLIST.indexOf('id="waitlist-confirmed"'));
  const body = panel.slice(0, panel.indexOf('id="waitlist-more-offer"'));
  // Headline, body copy and the action all move with the row.
  assert.match(body, /admitted \? "You\\u2019re in/);
  assert.match(body, /status\?\.has_account/);
  assert.match(body, /id="waitlist-status-pill"/);
  assert.match(body, /id="waitlist-status-since"/);
  assert.match(body, /id="waitlist-status-action"/);
});

test('the status comes off the confirm response in one round trip', () => {
  // The route hands the block back with the confirmation, so the screen
  // never makes a second read that could answer differently.
  assert.match(WAITLIST, /const next: WaitlistStatus \| null = \(data && data\.status\) \|\| null;/);
  assert.match(WAITLIST, /setStatus\(next\);/);
  // And the stage-2 offer retires the moment there is nothing left to
  // improve: it is an offer to move up a queue an admitted row has left.
  assert.match(WAITLIST, /setOffer\(!next\?\.admitted\);/);
  assert.match(WAITLIST, /hiddenFirst\(\s*!offer \|\| admitted,/);
});

test('the panel offers a date, never a queue position', () => {
  // services/waitlist-signals.js computes no rank on purpose. A position is a
  // promise, and it can go backwards.
  assert.match(WAITLIST, /function formatJoinedOn\(/);
  assert.match(WAITLIST, /'On the list since '/);
  const panel = WAITLIST.slice(WAITLIST.indexOf('id="waitlist-confirmed"'));
  // Comments in here explain WHY there is no rank, so scan what renders:
  // block comments out, then the remaining source.
  const body = panel.slice(0, panel.indexOf('id="waitlist-more-offer"'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const word of ['position', 'in line', 'ahead of', 'you are #']) {
    assert.doesNotMatch(body.toLowerCase(), new RegExp(word),
      `the panel implies a rank via "${word}"`);
  }
});

test('a malformed or missing joined_at collapses instead of printing junk', () => {
  const fn = WAITLIST.slice(WAITLIST.indexOf('function formatJoinedOn('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(!iso\) return '';/);
  assert.match(body, /Number\.isNaN\(at\.getTime\(\)\)/);
  // toLocaleDateString can throw on a bad options bag in old engines, and a
  // boot path is the worst place to learn that.
  assert.match(body, /catch \{/);
});

// ─── Hydration: every new node ships in the prerender ────────────────

test('the new nodes are always in the markup, hidden until there is an answer', () => {
  // An island's first render must emit exactly the prerendered shape.
  // Rendering the pill's contents any earlier is a hydration mismatch, and a
  // mismatch console.errors, which fails proposal checks on every route.
  for (const id of ['waitlist-status-since', 'waitlist-status-action']) {
    const at = WAITLIST.indexOf(`id="${id}"`);
    assert.ok(at > 0, `${id} is missing`);
    const decl = WAITLIST.slice(at, at + 400);
    assert.match(decl, /hiddenFirst\(/, `${id} is rendered conditionally, not hidden`);
  }
  // The pill's own host is unconditional; StatusPill hides itself.
  assert.match(SHARED, /until there is something to say/);
});

// ─── Ways in ─────────────────────────────────────────────────────────

test('the landing card offers the way in, and only to a visitor', () => {
  const at = LANDING.indexOf('id="landing-status-link"');
  assert.ok(at > 0, 'the landing link is missing');
  const block = LANDING.slice(Math.max(0, at - 400), at + 400);
  assert.match(block, /hiddenLast\(\s*session,/, 'a signed-in visitor is shown it anyway');
  assert.match(block, /href="#waitlist\?confirm=1"/);
  assert.match(block, /Check your status/);
});

test('the confirm step is reachable without a join, on any device', () => {
  // No new screen and no new route: `#waitlist?confirm=1` is the existing
  // confirm step with the address field shown, which is exactly what someone
  // arriving from a mail on a second device needs.
  assert.match(WAITLIST, /hashQuery\.get\('confirm'\) === '1'/);
  assert.match(WAITLIST, /setCodeOnly\(true\)/);
});

test('the admitted state is reachable by URL for a screenshot', () => {
  // The before/after shots and the "Test this change" button can only
  // navigate. Admitted is the one settled state no other route can paint,
  // because it needs a released_at behind it.
  assert.match(WAITLIST, /shot === 'waitlist-admitted'/);
  assert.match(APP, /shot !== 'waitlist-admitted'/, 'the shot is not allowlisted in app.js');
  assert.match(APP, /shot === 'waitlist-admitted'/, 'the hash is not normalised to #waitlist');
  // Deterministic: a fixed joined_at, so two shots of the same path compare.
  const block = WAITLIST.slice(WAITLIST.indexOf('if (shotAdmitted) {'));
  assert.match(block.slice(0, 500), /joined_at: '2026-03-14T10:00:00\.000Z'/);
});

test('the declared checks cover the states the panel can be in', () => {
  const paths = new Set(DAPP.tests.map((t) => t.path));
  assert.ok(paths.has('/?shot=waitlist-admitted'), 'the admitted state is unchecked');
  const admitted = DAPP.tests.filter((t) => t.path === '/?shot=waitlist-admitted');
  const selectors = admitted.map((t) => t.expectSelector).join(' ');
  for (const id of ['waitlist-status-pill', 'waitlist-status-action', 'waitlist-status-since']) {
    assert.match(selectors, new RegExp(id), `#${id} is not asserted on`);
  }
  // The offer must be gone in that state, and a check says so.
  assert.match(selectors, /#waitlist-more-offer\.hidden/);
  // And the landing way in is checked too, or it can vanish silently.
  assert.ok(DAPP.tests.some((t) => (t.expectSelector || '').includes('landing-status-link')),
    'the landing entry point is unchecked');
});

// ─── Staging has something to show ───────────────────────────────────

test('staging seeds a known code for the two confirmed demo addresses', () => {
  // Both addresses end in .invalid, so the mail this flow sends can never be
  // delivered. Without a seeded code the confirmed and admitted panels are
  // unreachable in a preview.
  const seed = MIGRATE.slice(MIGRATE.indexOf('async function seedStagingPlatformMail'));
  const body = seed.slice(0, seed.indexOf('\n}\n'));
  assert.match(body, /INSERT INTO waitlist_verification_codes/);
  assert.match(body, /const DEMO_STATUS_CODE = '000000';/);
  // Hashed, never stored in the clear: the seed goes through the same column
  // the real mint writes, so the real bcrypt.compare still runs.
  assert.match(body, /bcrypt\.hash\(DEMO_STATUS_CODE, 10\)/);
  // Idempotent by the same one-live-code-per-address rule issueVerificationCode
  // rests on, so a rebuilt container does not accumulate rows.
  assert.match(body, /WHERE NOT EXISTS \([\s\S]*?consumed_at IS NULL/);
  // Fake identities only, never whoever opened the preview.
  assert.match(body, /staging-demo-waitlist-confirmed@example\.invalid/);
  assert.match(body, /staging-demo-waitlist-admitted@example\.invalid/);
  assert.doesNotMatch(body, /req\.user/);
});

test('the seed cannot run outside staging and cannot break a boot', () => {
  const seed = MIGRATE.slice(MIGRATE.indexOf('async function seedStagingPlatformMail'));
  const body = seed.slice(0, seed.indexOf('\n}\n'));
  // Same contract as every other fixture in this file: wrapped in the
  // try/catch that downgrades a failure to a warning.
  assert.match(body, /log\.warn\('migrate', 'Staging platform-mail seed skipped'/);
  // Every fixture in this file gates itself on the first line rather than
  // trusting its caller, and this one is no exception.
  assert.match(seed.slice(0, 200), /if \(process\.env\.USERNODE_ENV !== 'staging'\) return;/);
});

test('the state is stated once: the celebration is the join\u2019s, the pill is the read\u2019s', () => {
  // Both arrivals land on #waitlist-confirmed, and they want different
  // sentences. Somebody who just typed the code from a joining mail is being
  // congratulated; somebody who typed their address to READ their state
  // joined weeks ago, so "You\u2019re on the list \ud83c\udf89" above a pill that says
  // "On the waitlist" is the same fact twice and the wrong tone once.
  // `codeOnly` already separates the two arrivals for the section label and
  // the step copy, so it separates them here too.
  assert.match(WAITLIST, /id="waitlist-confirmed-headline"\s*\n\s*className=\{hiddenFirst\(\s*codeOnly,/);
  assert.match(WAITLIST, /status=\{codeOnly \? status : null\}/);
});

test('the headline is visible in the prerender, so hydration matches', () => {
  // hiddenFirst on `codeOnly`, which is false at first render, is the
  // document the hand-written shell shipped: the line was always visible.
  // A gate that started hidden would console.error on hydration and fail
  // every proposal check.
  assert.match(WAITLIST, /const \[codeOnly, setCodeOnly\] = useState\(false\)/);
});

test('both halves of the split are photographable, and declared', () => {
  // One shot cannot photograph both, so there are two, and each is pinned
  // by a check that fails if the other one\u2019s copy leaks into it.
  assert.match(WAITLIST, /shot === 'waitlist-status'/);
  assert.match(APP, /shot !== 'waitlist-status'/);
  // The status shot is a WAITING signup read back, not a released one: that
  // is the state most people checking their status are in, and no other
  // route paints it.
  const block = WAITLIST.slice(WAITLIST.indexOf('if (shotStatus) {'));
  const body = block.slice(0, block.indexOf('\n    }'));
  assert.match(body, /setCodeOnly\(true\)/);
  assert.match(body, /setOffer\(true\)/);
  assert.match(body, /state: 'confirmed'/);
  assert.match(body, /joined_at: '/, 'a fixed date, so the two shots are comparable');

  const paths = DAPP.tests.filter((t) => t.path === '/?shot=waitlist-status');
  assert.ok(paths.length >= 2, 'the status shot carries checks of its own');
  assert.ok(
    paths.some((t) => /#waitlist-confirmed-headline\.hidden/.test(t.expectSelector || '')),
    'one of them holds the congratulations out of the status read');
  assert.ok(
    DAPP.tests.some((t) => t.path === '/?shot=waitlist-confirmed'
      && /#waitlist-confirmed-headline:not\(\.hidden\)/.test(t.expectSelector || '')),
    'and one holds it IN for a fresh confirmation');
});
