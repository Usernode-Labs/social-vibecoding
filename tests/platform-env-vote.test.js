// The propose-by-vote path for PLATFORM variables: `kind='secret_change'`
// against the self-hosted app row (src/routes/issues.js).
//
// Before this existed, that proposal was reachable but broken in two ways at
// once. It wrote the value into `app_secrets` — a table the platform never
// reads for itself, so the change had literally no effect — and then called
// `staging.rebuildProduction()` on the self-app row, i.e. tried to rebuild
// the platform as if it were one of its own child containers. Nothing guarded
// it: `routes/issues.js` had no `self_hosted` check anywhere, and
// `services/staging.js` still has none, so the guard has to live here.
//
// Two halves are pinned below, and neither can be checked by running the
// function (it needs a live pool, a live express request and a governance
// gate), so this is text-pinning like its sibling tests:
//
//   1. CREATION refuses what can never be applied — a deploy-owned key, a
//      value that can't survive the .env line — and classifies `private`
//      from the block that actually governs the platform (`platform_env`),
//      not from `secrets`.
//   2. APPLY branches: platform → platform-env DAO, no rebuild, "next
//      deploy" wording; child app → app_secrets, rebuild, unchanged wording.
//      Plus the refusal path for a key that became unwritable mid-vote.
//
// Run with: node --test tests/platform-env-vote.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const issuesJs = fs.readFileSync(path.join(root, 'src/routes/issues.js'), 'utf8');
const stagingJs = fs.readFileSync(path.join(root, 'src/services/staging.js'), 'utf8');
const secretsUiJs = fs.readFileSync(path.join(root, 'public/js/app-secrets.js'), 'utf8');

// The `kind === 'secret_change'` validation block inside the issue-create
// route, and the vote-apply function, sliced out by their opening lines.
const createBlock = (() => {
  const start = issuesJs.indexOf("      if (kind === 'secret_change') {");
  assert.notStrictEqual(start, -1, 'secret_change creation block not found');
  const end = issuesJs.indexOf("      } else if (kind === 'close_issue') {", start);
  assert.notStrictEqual(end, -1, 'end of the secret_change creation block not found');
  return issuesJs.slice(start, end);
})();

const applyFn = (() => {
  const start = issuesJs.indexOf('async function maybeApplySecretChangeProposal(');
  assert.notStrictEqual(start, -1, 'maybeApplySecretChangeProposal not found');
  const end = issuesJs.indexOf('\n}\n', start);
  assert.notStrictEqual(end, -1, 'end of maybeApplySecretChangeProposal not found');
  return issuesJs.slice(start, end);
})();

// ── Creation ──────────────────────────────────────────────────────────

test('a deploy-owned key cannot even be PROPOSED on the platform', () => {
  assert.match(createBlock, /app\.self_hosted && !platformEnv\.isWritableKey\(key\)/,
    'JWT_SECRET / ADMIN_PASSWORD / the GitHub App credentials are in '
    + 'PLATFORM_ENV_UNWRITABLE; a vote to rotate one must never open');
  assert.match(createBlock, /cannot be edited here/,
    'and the refusal says why, in the same words the direct write uses');
});

test('an unrepresentable value is refused at proposal time, not at apply', () => {
  assert.match(createBlock, /platformEnv\.validateValue\(value\)/,
    'a single quote cannot be escaped inside a single-quoted .env value, so a '
    + 'value carrying one would be silently dropped by the deploy days later');
});

test('the value cap still binds, and is the tighter of the two', () => {
  assert.match(issuesJs, /const MAX_SECRET_VALUE_LENGTH = 4096/);
  const platformEnv = require('../src/services/platform-env');
  assert.ok(4096 <= platformEnv.MAX_VALUE_LEN,
    'the proposal cap must not exceed what the store will accept, or a voted '
    + 'proposal could fail at the write');
});

test('private is read from platform_env for the platform, secrets otherwise', () => {
  assert.match(createBlock, /manifest\.platform_env \|\| \[\]/);
  assert.match(createBlock, /manifest\.secrets \|\| \[\]/);
  // An undeclared platform key defaults to private, matching
  // platform-env.setValue() — so no last-4 is captured into the payload for
  // something nothing has classified yet.
  assert.match(createBlock, /declared \? !!declared\.private : true/);
});

test('the proposal description promises a deploy, not a redeploy', () => {
  assert.match(createBlock, /the value reaches the platform on its next deploy/);
  assert.match(createBlock, /Auto-applies \+ redeploys/,
    'an ordinary app secret still says what it always said');
});

// ── Apply: the store branch ───────────────────────────────────────────

test('the apply resolves self_hosted once, before the transaction', () => {
  assert.match(applyFn, /SELECT id, self_hosted FROM apps WHERE id = \$1/);
  assert.match(applyFn, /const selfHosted = !!appRows\[0\]\?\.self_hosted/,
    'both the write branch and the side-effect branch must read the same flag');
});

test('a platform apply writes through the DAO; a child app writes app_secrets', () => {
  assert.match(applyFn, /if \(selfHosted\) \{[\s\S]{0,600}platformEnv\.setValue\(client,/,
    'through the DAO so isWritableKey is re-checked, the IV is fresh, and '
    + '`private` comes from the declaration rather than the proposal payload');
  assert.match(applyFn, /platformEnv\.deleteValue\(client, issue\.app_id, key\)/);
  assert.match(applyFn, /INSERT INTO app_secrets/,
    'the child-app path is unchanged');
  assert.match(applyFn, /DELETE FROM app_secrets WHERE app_id = \$1 AND key = \$2/);
});

test('a platform apply NEVER calls staging.rebuildProduction', () => {
  // The one defect this path existed to carry. Assert structurally: the
  // rebuild must sit inside the `else` of the selfHosted branch.
  const rebuildAt = applyFn.indexOf('staging.rebuildProduction');
  assert.notStrictEqual(rebuildAt, -1, 'the child-app rebuild must still happen');

  const branchAt = applyFn.indexOf('if (selfHosted) {', applyFn.indexOf("await client.query('COMMIT')"));
  assert.notStrictEqual(branchAt, -1, 'the side-effect branch must exist');
  const elseAt = applyFn.indexOf('} else {', branchAt);
  assert.ok(elseAt !== -1 && elseAt < rebuildAt,
    'rebuildProduction must be reachable only from the non-self-hosted branch — '
    + 'services/staging.js has no self_hosted guard of its own');

  assert.match(applyFn, /NEVER for the self-hosted row/,
    'and the reason is written down where the next reader will look');
});

test('staging.js still has no guard of its own, which is why this one matters', () => {
  assert.ok(!/self_hosted/.test(stagingJs),
    'if rebuildProduction ever grows its own guard this test should be revisited, '
    + 'but until then routes/issues.js is the only thing standing between a voted '
    + 'platform-variable change and a container rebuild of the platform');
});

test('the applied-change message says what actually happens next', () => {
  assert.match(applyFn, /takes effect on the platform's next deploy/);
  assert.match(applyFn, /redeploying…/, 'child apps keep their wording');
});

test('a platform apply is auditable as a platform-env change', () => {
  assert.match(applyFn, /EVENT_TYPES\.PLATFORM_ENV_CHANGED/,
    'one event type for a platform-variable change however it was applied');
  assert.match(applyFn, /appliedBy: force \? 'admin-force-apply' : 'group-vote'/);
  // And the value never travels with it.
  const eventCall = applyFn.slice(applyFn.indexOf('EVENT_TYPES.PLATFORM_ENV_CHANGED'));
  assert.ok(!/plaintext|valueEnc/.test(eventCall.slice(0, 500)),
    'no ciphertext and no plaintext in the audit event');
});

// ── Apply: the mid-vote refusal ───────────────────────────────────────

test('a key that became unwritable mid-vote is refused and CLOSED', () => {
  assert.match(applyFn, /selfHosted && !platformEnv\.isWritableKey\(key\)/);
  assert.match(applyFn, /appliedBy: 'refused:unwritable'/);
  const refusal = applyFn.slice(applyFn.indexOf("appliedBy: 'refused:unwritable'"));
  assert.match(refusal.slice(0, 900), /status = 'closed'/,
    'leaving it open would re-run the failure, and re-post its message, on '
    + 'every subsequent vote');
  assert.match(refusal.slice(0, 1500), /sendSystemMessage/,
    'and whoever voted finds out why nothing happened');
});

// ── The gate still gates ──────────────────────────────────────────────

test('a pending proposal does not satisfy the pre-merge check', () => {
  const checkJs = fs.readFileSync(path.join(root, 'src/services/platform-env-check.js'), 'utf8');
  assert.match(checkJs, /SELECT key FROM platform_env_values WHERE app_id = \$1 AND key = ANY/,
    'the gate reads stored VALUES, so a proposal still collecting votes has '
    + 'not yet cleared the block');
  assert.match(checkJs, /does not count/,
    'the block message has to say so, or someone waits on a vote expecting the '
    + 'merge to unblock by itself');
});

test('the block message points at the panel and names both paths', () => {
  const checkJs = fs.readFileSync(path.join(root, 'src/services/platform-env-check.js'), 'utf8');
  const describe = checkJs.slice(checkJs.indexOf('function describeBlock('));
  assert.match(describe, /Platform variables panel/);
  assert.match(describe, /propose one by vote/,
    'a non-admin reading the block needs a route that is open to them');
  assert.ok(!/admin console/.test(describe),
    'the console section it used to point at no longer exists');
});

test('the Checks card offers the fix in place, for admins and non-admins', () => {
  const appViewJs = fs.readFileSync(path.join(root, 'public/js/app-view.js'), 'utf8');
  const detail = appViewJs.slice(appViewJs.indexOf('_platformEnvDetailHtml(pr) {'));
  assert.match(detail.slice(0, 3000), /'Set them now' : 'Propose a value'/);
  assert.match(detail.slice(0, 3000), /AppView\.openPlatformVariables\(\)/);
  assert.ok(!/#admin\/platform-env/.test(appViewJs),
    'the deep link into the deleted console section must be gone');
});

// ── The UI offers the vote path where it is allowed ───────────────────

test('the propose buttons exist for a writable row and vanish for a managed one', () => {
  const row = secretsUiJs.slice(secretsUiJs.indexOf('renderRow(s, canWrite) {'));
  assert.match(row.slice(0, 8000), /data-action="propose-set"/);
  // if/else since the branch grew a 'proposed' case (a key whose
  // declaration is still up for vote links to that proposal instead).
  assert.match(row.slice(0, 8000), /else if \(s\.unwritable\) \{\s*\n\s*actions = '';/,
    'a deploy-managed row gets neither path — the server refuses both');
});
