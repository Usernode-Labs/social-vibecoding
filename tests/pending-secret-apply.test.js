// The merge-time half of the declare-a-new-variable flow: where
// routes/votes.js finalizeMerge() applies the value a proposal carried,
// and how the staging build and the pre-merge check treat a value that
// hasn't landed yet.
//
// ORDER IS THE WHOLE POINT of the first test. A child app's newly
// `required` secret must be in `app_secrets` BEFORE
// staging.rebuildProduction runs mergeForDeploy — otherwise the merge
// throws MissingSecretsError and parks the app in `awaiting_secrets` over
// its own change, which looks exactly like a broken feature.
//
// finalizeMerge needs a live pool, a GitHub merge and the whole
// broadcast fan-out to run, so this is text-pinning like
// tests/platform-env-vote.test.js.
//
// Run with: node --test tests/pending-secret-apply.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const votesJs = fs.readFileSync(path.join(root, 'src/routes/votes.js'), 'utf8');
const stagingJs = fs.readFileSync(path.join(root, 'src/services/staging.js'), 'utf8');
const lifecycleJs = fs.readFileSync(path.join(root, 'src/services/session-lifecycle.js'), 'utf8');

const finalizeMerge = (() => {
  const start = votesJs.indexOf('async function finalizeMerge(');
  assert.notStrictEqual(start, -1, 'finalizeMerge not found');
  const end = votesJs.indexOf('\nasync function checkAndMerge(', start);
  assert.notStrictEqual(end, -1, 'end of finalizeMerge not found');
  return votesJs.slice(start, end);
})();

test('the pending value is applied BEFORE the production rebuild', () => {
  const applyAt = finalizeMerge.indexOf('pendingSecrets.applyForSession');
  const rebuildAt = finalizeMerge.indexOf('staging.rebuildProduction');
  assert.ok(applyAt > 0, 'finalizeMerge must apply pending declarations');
  assert.ok(rebuildAt > 0, 'and still rebuild production');
  assert.ok(applyAt < rebuildAt,
    'a newly required secret must exist before mergeForDeploy looks for it');
});

test('the apply is best-effort — a failure never breaks a merge that already happened', () => {
  const block = finalizeMerge.slice(
    finalizeMerge.indexOf('pendingSecrets.applyForSession') - 400,
    finalizeMerge.indexOf('staging.rebuildProduction')
  );
  assert.match(block, /try \{/);
  assert.match(block, /catch \(err\) \{/);
  assert.match(block, /log\.error\('votes', 'Pending secret-declaration apply failed'/);
});

test('the chat wording tells the truth about when each scope takes effect', () => {
  // Promising a redeploy the platform path deliberately never performs is
  // how someone concludes the feature is broken while watching for an
  // immediate change.
  assert.match(finalizeMerge, /takes effect on the platform's next deploy/);
  assert.match(finalizeMerge, /was declared and set by this proposal; redeploying…/);
});

test('a platform apply records the platform-env event with its own appliedBy', () => {
  assert.match(finalizeMerge, /EVENT_TYPES\.PLATFORM_ENV_CHANGED/);
  assert.match(finalizeMerge, /appliedBy: 'declaration-proposal'/,
    'so the audit trail distinguishes it from admin-direct and group-vote');
  const eventBlock = finalizeMerge.slice(finalizeMerge.indexOf("appliedBy: 'declaration-proposal'") - 400,
    finalizeMerge.indexOf("appliedBy: 'declaration-proposal'") + 60);
  assert.ok(!/value/.test(eventBlock.replace(/valueApplied|hadValue/g, '')),
    'the event carries the key and its privacy flag — never the value');
});

test('only the platform branch skips the rebuild (unchanged behaviour)', () => {
  assert.match(finalizeMerge, /if \(!app\.self_hosted\) \{/);
  const selfHostedNote = finalizeMerge.slice(finalizeMerge.indexOf('} else {'), finalizeMerge.indexOf('} else {') + 400);
  assert.match(selfHostedNote, /host deployer will roll/);
});

test('staging injects pending NON-private values into the proposal\'s own preview', () => {
  const build = stagingJs.slice(
    stagingJs.indexOf('const stagingStored = await appSecrets.getRawValues('),
    stagingJs.indexOf('const stagingMerge = appSecrets.mergeForDeploy(')
  );
  assert.match(build, /pendingSecrets\.rawValuesForSession\(/);
  assert.match(build, /session\.id/, 'scoped to THIS proposal, not every pending row');
  assert.ok(!/includePrivate/.test(build),
    'the default omits private values — an unreviewed PR container never gets a credential');
  assert.match(build, /hasOwnProperty\.call\(stagingStored, k\)/,
    'a real stored value still wins over a proposed one');
  assert.match(build, /catch \(err\)/, 'best-effort: never fails a build that would otherwise succeed');
});

test('a withdrawn proposal discards its held value', () => {
  const archive = lifecycleJs.slice(
    lifecycleJs.indexOf('async function archiveSession('),
    lifecycleJs.indexOf('// Reverse an archive')
  );
  assert.match(archive, /discardForSession\(pool, sessionId\)/);
  assert.match(archive, /catch/, 'and never fails the archive itself');
});

test('the pre-merge check counts a value carried by THIS session', () => {
  const checkJs = fs.readFileSync(path.join(root, 'src/services/platform-env-check.js'), 'utf8');
  assert.match(checkJs, /pendingSecrets\.keysForSession\(pool, session\.id\)/);
  assert.match(checkJs, /p\.scope === 'platform' && p\.hasValue && wanted\.has\(p\.key\)/,
    'platform scope only, value only, and only for a key this branch adds');
  assert.match(checkJs, /!stored\.has\(e\.key\) && !pendingValues\.has\(e\.key\)/,
    'a carried value is not "missing", so the proposal cannot block itself');
  assert.match(checkJs, /pendingValues: carried/, 'and the Checks card is told which ones');
});
