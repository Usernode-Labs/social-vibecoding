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
// CREATION is pinned below, by text like its sibling tests: it refuses what
// can never be applied — a deploy-owned key, a value that can't survive the
// .env line — and classifies `private` from the block that actually governs
// the platform (`platform_env`), not from `secrets`.
//
// The APPLY is the governance machine's (src/workflow/governance-proposal/),
// run against a real database in tests/workflow-governance-postgres.test.js:
// platform → platform-env DAO, no rebuild (and its audit event); child app →
// app_secrets and a rebuild; a key that became unwritable mid-vote refused
// and closed. Its wording is pinned here.
//
// Run with: node --test tests/platform-env-vote.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const issuesJs = fs.readFileSync(path.join(root, 'src/routes/issues.js'), 'utf8');
const machineTs = fs.readFileSync(path.join(root, 'src/workflow/governance-proposal/machine.ts'), 'utf8');
const stagingJs = fs.readFileSync(path.join(root, 'src/services/staging.js'), 'utf8');
const secretsUiJs = fs.readFileSync(path.join(root, 'frontend/src/features/dialogs/app-secrets-controller.js'), 'utf8');

// The `kind === 'secret_change'` validation block inside the issue-create
// route, sliced out by its opening line.
const createBlock = (() => {
  const start = issuesJs.indexOf("      if (kind === 'secret_change') {");
  assert.notStrictEqual(start, -1, 'secret_change creation block not found');
  const end = issuesJs.indexOf("      } else if (kind === 'close_issue') {", start);
  assert.notStrictEqual(end, -1, 'end of the secret_change creation block not found');
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

// ── Apply: what the machine says, and why it never rebuilds the platform ──

test('a platform apply never asks for a rebuild, and staging.js has no guard of its own', () => {
  assert.match(machineTs, /issue\.kind === 'secret_change' && !issue\.app\.selfHosted/,
    'the rebuild is asked only for a child app');
  assert.ok(!/self_hosted/.test(stagingJs),
    'if rebuildProduction ever grows its own guard this test should be revisited, '
    + 'but until then the governance machine is the only thing standing between a '
    + 'voted platform-variable change and a container rebuild of the platform');
});

test('the applied-change message says what actually happens next', () => {
  assert.match(machineTs, /takes effect on the platform's next deploy/);
  assert.match(machineTs, /redeploying…/, 'child apps keep their wording');
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
  const detail = appViewJs.slice(appViewJs.indexOf('_platformEnvNote(pr) {'));
  assert.match(detail.slice(0, 3000), /PlatformI18n\.t\('changes:envNote\.setNow'\) : PlatformI18n\.t\('changes:envNote\.proposeValue'\)/);
  assert.equal(message('changes:envNote.setNow'), 'Set them now');
  assert.equal(message('changes:envNote.proposeValue'), 'Propose a value');
  assert.match(detail.slice(0, 3000), /fn: 'openPlatformVariables'/);
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
