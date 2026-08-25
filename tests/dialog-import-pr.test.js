// The Import-a-PR dialog, after #1078 chunk I made it a stateful island.
//
// Everything asserted here used to be asserted by driving
// AppView.openImportPrModal / .submitImportPr in a vm context
// (tests/pr-import-menu.test.js). That code is
// frontend/src/features/dialogs/import-pr.tsx now: the rows are JSX, the
// selection is a useState, the freeze is derived from `busy`, and the dismiss
// veto is useDialog's `canClose`. The root suite runs with no
// frontend/node_modules and no jsdom — the root install never touches that
// workspace — so this file asserts the component's SOURCE, the same split
// tests/dev-plus-menu.test.js, tests/standings-screen.test.js and
// tests/dialog-components.test.js use.
//
// What is covered, one test per contract the old vm tests held:
//   - one row per candidate, escaped by the renderer rather than by hand;
//   - #866 fork provenance: the label, its "unknown fork" fallback, and the
//     fact that it belongs to the row it is rendered in;
//   - the empty and GitHub-off (non-OK / 404) list states;
//   - #846: the import POST is awaited in place — progress row, dimmed list,
//     both buttons frozen, no navigation until the server confirms;
//   - a dismiss mid-import is refused, and a second submit is ignored;
//   - failure copy per status, with the server's own message winning;
//   - a 409 "already imported" reloads the stale list in place;
//   - a network error surfaces without navigating;
//   - a throwing navigation still closes the dialog and toasts;
//   - no selection submits nothing.
//
// Run with: node --test tests/dialog-import-pr.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(root, 'frontend', 'src', 'features', 'dialogs', 'import-pr.tsx'),
  'utf8',
);
const HTML = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

// Everything below the file header. The header narrates what moved and names
// the very identifiers some of these tests assert are gone, so the
// "no longer present" checks read the code rather than the prose.
const BODY = SRC.slice(SRC.indexOf('\n */\n') + 5);

/** The body of a named function declaration inside the component module. */
function fnBody(name) {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at > 0, `found function ${name}`);
  const end = SRC.indexOf('\n  }\n', at);
  assert.ok(end > at, `found the end of ${name}`);
  return SRC.slice(at, end);
}

// ── the list ─────────────────────────────────────────────────────────

test('one row per candidate, with the renderer doing the escaping', () => {
  // `list.rows.map` IS the "one row per PR" contract — a single radio per
  // candidate, keyed by its number.
  assert.match(SRC, /list\.rows\.map\(\(c\) => \{/, 'rows render from the fetched array');
  assert.match(SRC, /name="import-pr-choice"/, 'the radio group name is unchanged');
  assert.equal((SRC.match(/name="import-pr-choice"/g) || []).length, 1,
    'exactly one radio, rendered once per row by the map');
  assert.match(SRC, /key=\{num\}/, 'keyed by PR number');
  // The old renderer built an innerHTML string and threaded escapeHtml /
  // escapeAttr through it; a title like `[Mock] add a <b>widget</b>` is now
  // escaped because it is a JSX child, so the manual pair must be gone AND no
  // raw-HTML escape hatch may have replaced it.
  assert.doesNotMatch(BODY, /dangerouslySetInnerHTML/, 'no raw HTML injection anywhere');
  assert.doesNotMatch(BODY, /escapeHtml|escapeAttr/, 'escaping is the renderer’s job now');
  assert.doesNotMatch(BODY, /innerHTML/, 'the list is not painted by innerHTML');
  // The row still shows number, title, author and both branches.
  assert.match(SRC, /#\{num\} · \{String\(c\.title \|\| ''\)\}/, 'number and title');
  assert.match(SRC, /String\(c\.author \|\| 'unknown'\)/, 'author, with a fallback');
  assert.match(SRC, /String\(c\.headBranch \|\| ''\)\} → \{String\(c\.baseBranch \|\| ''\)/,
    'head → base branches');
});

// #866: a fork-headed PR's branch lives in someone else's repo — the preview
// is built from refs/pull/<N>/head and the code is an outside contributor's —
// so the picker says so BEFORE the import, not after.
test('the fork label is per-row and never renders blank', () => {
  const at = SRC.indexOf('{c.fromFork ? (');
  assert.ok(at > 0, 'the label is gated on the candidate’s own fromFork flag');
  const label = SRC.slice(at, SRC.indexOf(') : null}', at));
  assert.match(label, /from a fork/, 'the caution is the point');
  assert.match(label, /String\(c\.headRepo \|\| 'unknown fork'\)/,
    'missing metadata reads as unknown, not empty');
  // It sits inside the row's own <span>, after the number/title line — so it
  // can only ever belong to the row it labels.
  assert.ok(SRC.indexOf('#{num} · ') < at, 'the label follows its own PR number');
  assert.ok(at < SRC.indexOf('{c.htmlUrl ? ('), '…and precedes that row’s GitHub link');
  assert.equal((SRC.match(/from a fork: /g) || []).length, 1,
    'exactly one fork label in the component, rendered per fork-headed row');
});

test('the empty and GitHub-off responses are distinct list states', () => {
  const load = fnBody('loadCandidates');
  // A 404 means GitHub isn't configured for this app — a state the user can't
  // act on is worse than a plain sentence saying so.
  assert.match(load, /if \(!ok\) \{[\s\S]*GitHub isn’t configured for this app/,
    'non-OK renders the GitHub-off note');
  assert.match(load, /rows\.length === 0[\s\S]*No open pull requests are available/,
    'an empty candidate list renders the empty note');
  assert.match(load, /kind: 'error', text: 'Couldn’t load pull requests/,
    'a thrown fetch is its own state, not an empty list');
  assert.match(SRC, /list\.kind === 'note' \? \([\s\S]*NOTE_CLASS/, 'notes render in the note style');
  assert.match(SRC, /list\.kind === 'error' \? \([\s\S]*ERROR_CLASS/, 'errors render in the error style');
});

test('the list only fetches once the dialog is open', () => {
  // Data loads in an effect, never in the initial render: the prerendered
  // document must be byte-identical to the hand-written shell's, and a
  // divergence is a hydration mismatch — React #418, a console.error on every
  // route, which fails proposal checks.
  assert.match(SRC, /onOpen: \(\) => \{[\s\S]*void loadCandidates\(\);/,
    'the fetch is kicked off by the open lifecycle');
  assert.match(SRC, /\{!dialog\.isOpen \? null :/, 'nothing inside the list prerenders');
  const shipped = HTML.slice(HTML.indexOf('id="import-pr-list"'));
  assert.match(shipped.slice(0, 400), /id="import-pr-list"[^>]*>\s*<\/div>/,
    'the shipped list host is empty, exactly as the hand-written shell had it');
});

// ── #846: the import is awaited in place ─────────────────────────────

test('the freeze covers the list, both buttons and the progress row', () => {
  // Cancel is DISABLED rather than hidden so the footer doesn’t reflow.
  assert.match(SRC, /id="import-pr-cancel"[\s\S]{0,400}disabled=\{busy\}/, 'cancel frozen while busy');
  assert.match(SRC, /id="import-pr-submit"[\s\S]{0,400}disabled=\{busy \|\| selected == null\}/,
    'submit frozen while busy, and until a PR is picked');
  assert.match(SRC, /busy\s*\?\s*'max-h-80[^']*pointer-events-none opacity-50'/,
    'the list is inert and dimmed mid-import');
  assert.match(SRC, /useHiddenClass\(progressRef, !busy\)/, 'the progress row follows busy');
  assert.match(SRC, /useHiddenClass\(slowRef, !slow\)/, 'and the slow line follows its own state');
  assert.match(SRC, /\{busy \? 'Importing…' : 'Import'\}/, 'the submit label says what is happening');

  const freeze = fnBody('setImportBusy');
  assert.match(freeze, /Importing PR #\$\{prNumber\}: checking it on GitHub/, 'progress names the PR');
  assert.match(freeze, /clearTimeout\(slowTimer\.current\)/, 'every call clears the slow timer first');
  assert.match(freeze, /if \(!on\) return;/, 'unfreezing never arms a new one');
  assert.match(freeze, /setTimeout\(\(\) => \{[\s\S]*setSlow\(true\);[\s\S]*\}, 8000\)/,
    '~8s before a slow GitHub reads as "still working"');
  assert.match(SRC, /if \(slowTimer\.current\) clearTimeout\(slowTimer\.current\)/,
    'and unmount clears it too');
});

test('a dismiss mid-import is refused and a second submit is ignored', () => {
  // The veto is the dialog's, so the backdrop, the Cancel button and a
  // kit-initiated Escape all respect it from one place — where the legacy
  // code repeated the check in closeImportPrModal AND the backdrop listener.
  assert.match(SRC, /canClose: \(\) => !busyRef\.current/, 'busy vetoes every close path');
  const submit = fnBody('submit');
  assert.match(submit, /if \(busy\) return;/, 'a second submit mid-flight is a no-op');
  assert.match(submit, /if \(pr == null\) return setError\('Pick a pull request to import\.'\)/,
    'no selection submits nothing and says why');
});

test('only a server-confirmed import navigates, using the returned lifecycle state', () => {
  const submit = fnBody('submit');
  assert.match(submit, /method: 'POST'/, 'the import is a POST');
  assert.match(submit, /\/pr-import`/, 'to the app’s pr-import endpoint');
  assert.match(submit, /body: JSON\.stringify\(\{ pr \}\)/, 'with just the PR number');
  assert.match(submit, /encodeURIComponent\(slug\)/, 'slug is encoded into the path');
  // Browser imports are active and open their public discussion; explicit
  // automated promote imports retain the proposal-topic fallback.
  assert.match(submit, /status = data\.status \|\| 'active'/, 'defaults to In progress');
  assert.match(submit, /status === 'promoted' \? 'proposal' : 'session'/,
    'routes from the state the server actually created');
  // Navigation is downstream of the ok branch: every failure path returns
  // before `sessionId` is read.
  const okAt = submit.indexOf('sessionId = data.sessionId;');
  assert.ok(okAt > submit.indexOf('if (!res.ok) {'), 'the failure branch returns first');
  assert.ok(submit.indexOf('openTopic') > okAt, 'navigation happens after the server confirms');
  // …and the dialog closes AFTER the navigation, so it covers the transition
  // instead of flashing the screen the user came from.
  assert.ok(submit.indexOf('dialog.close()') > submit.indexOf('openTopic'),
    'the dialog closes after the route change');
});

// ── failure copy ─────────────────────────────────────────────────────

test('each failure names its own cause instead of "Import failed (HTTP N)"', () => {
  const map = SRC.slice(
    SRC.indexOf('export function importPrErrorMessage('),
    SRC.indexOf('export function ImportPrDialog('),
  );
  // The server's own 404/409 strings are already user-grade, so they win.
  assert.match(map, /if \(serverError\) return serverError;/, 'a server message wins');
  assert.match(map, /status === 404[\s\S]{0,120}wasn’t found on GitHub/, '404 without a message');
  assert.match(map, /status === 409[\s\S]{0,120}can’t be imported right now/, '409 without a message');
  assert.match(map, /status === 503[\s\S]{0,120}platform is restarting/, '503 is the drain guard');
  assert.match(map, /return 'Something went wrong importing this PR\. Please try again\.'/,
    'anything else still says something actionable');
});

test('a failed import keeps the dialog open, unfrozen, with the message inline', () => {
  const submit = fnBody('submit');
  const fail = submit.slice(submit.indexOf('if (!res.ok) {'), submit.indexOf('sessionId = data.sessionId;'));
  assert.match(fail, /importPrErrorMessage\(res\.status, data\.error, pr\)/, 'copy comes from the map');
  assert.match(fail, /setImportBusy\(false\)/, 'the dialog unfreezes');
  assert.match(fail, /setError\(msg\)/, 'and shows the message inline');
  assert.match(fail, /return;/, 'without navigating');
  // #846: an already-imported 409 means the list is stale — it reloads so the
  // row the user just tried disappears.
  assert.match(fail, /res\.status === 409 && \/already been imported\/i\.test/,
    'the already-imported 409 is recognised');
  assert.match(fail, /if \(alreadyImported\) await loadCandidates\(\);/, 'and reloads the list in place');
  assert.match(SRC, /useHiddenClass\(errorRef, !error\)/, 'the error region follows the message');
});

test('a network error surfaces without navigating', () => {
  const submit = fnBody('submit');
  const net = submit.slice(submit.indexOf('} catch {'));
  assert.match(net, /setImportBusy\(false\)/, 'unfrozen');
  assert.match(net, /setError\('Network error\. Please try again\.'\)/, 'named for what it was');
  assert.match(net, /return;/, 'and nothing is navigated to');
});

// The import succeeded server-side even if the navigation blew up, so the
// user is told where to find it rather than left staring at a frozen dialog.
test('a throwing navigation still closes the dialog and toasts', () => {
  const submit = fnBody('submit');
  const tail = submit.slice(submit.indexOf('setImportBusy(false);\n    try {'));
  assert.match(tail, /PlatformUI\?\.toast\?\.\(/, 'the user is told');
  assert.match(tail, /PR #\$\{pr\} was imported/, 'by PR number');
  // #866: and told that the Preview button isn't there yet — the staging
  // build takes minutes.
  assert.match(tail, /Its preview is being built now/, 'with the preview expectation set');
  assert.ok(tail.indexOf('dialog.close()') > tail.indexOf('toast'), 'the dialog closes either way');
});
