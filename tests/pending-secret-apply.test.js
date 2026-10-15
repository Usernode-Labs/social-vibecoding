// The merge-time half of the declare-a-new-variable flow: where
// routes/votes.js finalizeMerge() applies the value a proposal carried
// (applyDeclaredValues),
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

// The apply itself is its own function, applyDeclaredValues, because the
// boot heal of a merge a restart cut off (server.js recoverStuckMerges) runs
// it too.
const applyDeclared = (() => {
  const start = votesJs.indexOf('async function applyDeclaredValues(');
  assert.notStrictEqual(start, -1, 'applyDeclaredValues not found');
  const end = votesJs.indexOf('\nasync function finalizeMerge(', start);
  assert.notStrictEqual(end, -1, 'end of applyDeclaredValues not found');
  return votesJs.slice(start, end);
})();

test('the pending value is applied BEFORE the production rebuild', () => {
  assert.match(applyDeclared, /pendingSecrets\.applyForSession\(config, pool, session\.id\)/,
    'applyDeclaredValues applies pending declarations');
  const applyAt = finalizeMerge.indexOf('await applyDeclaredValues({ config, pool, session, dstep })');
  const rebuildAt = finalizeMerge.indexOf('staging.rebuildProduction');
  assert.ok(applyAt > 0, 'finalizeMerge must apply pending declarations');
  assert.ok(rebuildAt > 0, 'and still rebuild production');
  assert.ok(applyAt < rebuildAt,
    'a newly required secret must exist before mergeForDeploy looks for it');
});

test('a merge healed after a restart applies them before it is recorded, so the redelivery has them', () => {
  const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const heal = serverJs.slice(serverJs.indexOf('async function recoverStuckMerges('),
    serverJs.indexOf('// Boot-time auto-merge reconcile sweep (#390).'));
  const applyAt = heal.indexOf('votes.applyDeclaredValues({ config, pool, session: { id: row.id, app_id: row.app_id } })');
  const recordAt = heal.indexOf("SET status = 'merged',");
  assert.ok(applyAt > 0 && recordAt > applyAt);
});

test('the apply is best-effort — a failure never breaks a merge that already happened', () => {
  assert.match(applyDeclared, /try \{/);
  assert.match(applyDeclared, /catch \(err\) \{/);
  assert.match(applyDeclared, /log\.error\('votes', 'Pending secret-declaration apply failed'/);
});

test('the chat wording tells the truth about when each scope takes effect', () => {
  // Promising a redeploy the platform path deliberately never performs is
  // how someone concludes the feature is broken while watching for an
  // immediate change.
  assert.match(applyDeclared, /takes effect on the platform's next deploy/);
  assert.match(applyDeclared, /was declared and set by this proposal; redeploying…/);
});

test('a platform apply records the platform-env event with its own appliedBy', () => {
  assert.match(applyDeclared, /EVENT_TYPES\.PLATFORM_ENV_CHANGED/);
  assert.match(applyDeclared, /appliedBy: 'declaration-proposal'/,
    'so the audit trail distinguishes it from admin-direct and group-vote');
  const eventBlock = applyDeclared.slice(applyDeclared.indexOf("appliedBy: 'declaration-proposal'") - 400,
    applyDeclared.indexOf("appliedBy: 'declaration-proposal'") + 60);
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
