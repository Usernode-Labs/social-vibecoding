// #1330 — an imported proposal's before/after screenshots must be shot on
// the routes the submission named, not on the app's home page.
//
// The defect: POST /api/apps/:slug/pr-import wrote testing_md / testing_path
// / testing_paths into the row correctly, then built a SEPARATE in-memory
// session literal for the build kick that carried none of them. That literal
// — not the row — is what reaches visuals.captureForSession, which derives
// both `pathDefaulted` and `capturePaths` from `session.testing_paths` /
// `session.testing_path`. Both were undefined, so every connector submission
// defaulted to '/' however carefully its testingPaths named the screen that
// changed, and submit_work still reported the routes as accepted — because
// they were: the row had them the whole time.
//
// That split is also why only the FIRST capture was wrong.
// syncImportedProposal re-captures from a session loaded with `SELECT cs.*`,
// so a later re-shoot used the routes; the one the voters actually look at
// never did.
//
// Guarded the way tests/pr-import-linked-issues.test.js guards the sibling
// field on the same route: the route is not unit-mountable here, so the
// contract is pinned at both ends — what the producer puts on the object,
// and what the consumer reads off it — plus a real check that the shape
// handed over is the shape the capture can actually read.
//
// Run with: node --test tests/pr-import-capture-routes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VOTES_SRC = fs.readFileSync(path.join(__dirname, '../src/routes/votes.js'), 'utf8');
const VISUALS_SRC = fs.readFileSync(path.join(__dirname, '../src/services/visuals.js'), 'utf8');

// The session literal the import route hands to kickImportedChecks.
function importedSessionLiteral() {
  const from = VOTES_SRC.indexOf('const sessionId = inserted[0].id');
  assert.ok(from > 0, 'the import route still builds its session from the INSERT');
  const to = VOTES_SRC.indexOf('kickImportedChecks(session, appForBuild, headSha)', from);
  assert.ok(to > from, 'and still hands it to the checks kick');
  return VOTES_SRC.slice(from, to);
}

test('the session handed to the capture carries the routes the INSERT just wrote', () => {
  const literal = importedSessionLiteral();
  // All three columns, not just the list: testing_path is the single-route
  // fallback captureForSession reads when testing_paths is empty, and
  // testing_md is the instructions panel shown beside the preview.
  assert.match(literal, /testing_md:\s*importTesting\.testingMd/);
  assert.match(literal, /testing_path:\s*importTesting\.testingPath/);
  assert.match(literal, /testing_paths:\s*importTesting\.testingPaths/);
});

test('they come from the same parse that feeds the INSERT, not a second one', () => {
  // One sanitizer, one source of truth. A second parse here could accept
  // something the column rejected (or the reverse), and then the screenshots
  // and the stored routes would describe different things.
  assert.match(VOTES_SRC, /const importTesting = parseImportTesting\(req\.body\)/);
  assert.equal(
    (VOTES_SRC.match(/parseImportTesting\(req\.body\)/g) || []).length, 1,
    'the import body is parsed exactly once'
  );
  const literal = importedSessionLiteral();
  assert.doesNotMatch(literal, /parseImportTesting/, 'the literal reuses that parse');
});

test('the consumer still reads its routes off the session object', () => {
  // The other half of the contract. If captureForSession ever starts loading
  // the row itself, the fields above become redundant rather than wrong —
  // but until it does, dropping them silently re-breaks every screenshot.
  assert.match(VISUALS_SRC, /const pathDefaulted = !\(Array\.isArray\(session\.testing_paths\)/);
  assert.match(VISUALS_SRC, /\?\s*session\.testing_paths\s*\n?\s*:\s*\[session\.testing_path \|\| '\/'\]/);
});

test('a session with no routes still defaults to root (the browser import path)', () => {
  // The browser's own import button sends no testing metadata, so the three
  // fields are null and the capture must fall back exactly as before. This
  // is the property that makes the change safe to ship: an import that says
  // nothing about routes writes the row it always wrote.
  const derive = (session) => ({
    pathDefaulted: !(Array.isArray(session.testing_paths) && session.testing_paths.length)
      && !session.testing_path,
    raw: (Array.isArray(session.testing_paths) && session.testing_paths.length)
      ? session.testing_paths
      : [session.testing_path || '/'],
  });

  assert.deepEqual(derive({ testing_md: null, testing_path: null, testing_paths: null }),
    { pathDefaulted: true, raw: ['/'] });
  // And the pre-fix shape — the fields absent entirely — is what produced
  // the bug: indistinguishable from "the agent named no routes".
  assert.equal(derive({}).pathDefaulted, true);
});

test('the shape the route hands over is the shape the capture can read', () => {
  // parseSubmitted returns the stored { path, viewport } object form, and
  // normalizeStoredPath is what the capture puts it through. A string/object
  // mismatch here would drop the routes just as silently as omitting them.
  const notes = require('../src/services/testing-notes');
  const parsed = notes.parseSubmitted({
    testingPaths: ['/board?demo=1', '/settings @mobile'],
  });
  assert.equal(parsed.dropped.length, 0);
  assert.ok(Array.isArray(parsed.testingPaths) && parsed.testingPaths.length === 2);

  const session = { testing_paths: parsed.testingPaths, testing_path: parsed.testingPath };
  const pathDefaulted = !(Array.isArray(session.testing_paths) && session.testing_paths.length)
    && !session.testing_path;
  assert.equal(pathDefaulted, false, 'a submission with routes is never treated as defaulted');

  const shaped = session.testing_paths.map((p) => notes.normalizeStoredPath(p));
  assert.deepEqual(shaped.map((s) => s && s.path), ['/board?demo=1', '/settings']);
  assert.deepEqual(shaped.map((s) => s && s.viewport), ['desktop', 'mobile']);
});

// ── The other half of #1330: the `row=` capture link on a detail head ─────
//
// #1324 declared a check driving ?shot=card-menu&row=assignee on a topic
// route and expecting the attribute picker. It could not pass:
// _proposalMenuItems gates the attribute rows behind `if (!st.noNav)`, so the
// detail head deliberately has no "Change assignee…" row — it renders all
// three chips instead (`omitUnset: !noNav`). `row=` names the PICKER, not one
// affordance for opening it, so it now falls back to the chip.

const APPVIEW_SRC = fs.readFileSync(
  path.join(__dirname, '../public/js/app-view.js'), 'utf8'
);

test('row= falls back to the field chip when the menu has no such row', () => {
  const from = APPVIEW_SRC.indexOf("if (wantRow && AppView._openCardMenu) {");
  assert.ok(from > 0, 'the shot hook still resolves row= through the open menu');
  const block = APPVIEW_SRC.slice(from, from + 1600);
  // The menu row still wins where one exists — that is the board's path and
  // the existing card-menu checks ride on it.
  assert.match(block, /data-menu-row="\$\{wantRow\}"\]:not\(\[disabled\]\)/);
  assert.match(block, /if \(menuRow\) \{ menuRow\.click\(\); return; \}/);
  // Fallback: close the menu, then click the chip, preferring the topic head.
  assert.match(block, /AppView\._closeCardMenu\(\)/);
  assert.match(block, /\[data-attr-chip\]\[data-attr-field="\$\{wantRow\}"\]/);
  assert.match(block, /#gc-thread-head \$\{chipSel\}/);
});

test('the detail head really does omit the rows this falls back for', () => {
  // The reason the fallback exists, pinned so a later change to either side
  // shows up here rather than as a check that quietly stops asserting.
  assert.match(APPVIEW_SRC, /if \(!st\.noNav\) \{\s*\n\s*items\.push\(\.\.\.AppView\._attrMenuItems\('proposal', pr\.id, pr\)\);/);
  // …and that it renders the chips instead, which is what the fallback clicks.
  assert.match(APPVIEW_SRC, /_attrChipSpecs\('proposal', pr\.id, pr, \{ omitUnset: !noNav \}\)/);
});
