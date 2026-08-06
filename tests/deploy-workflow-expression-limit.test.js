// Guards the deploy workflow against the failure mode that silently
// stopped production from moving on 2026-07-28: GitHub rejected
// .github/workflows/deploy.yml outright with
//
//   Invalid workflow file (Line: 200, Col: 19):
//   Exceeded max expression length 21000
//
// so NO deploy run was created at all — merges landed on main, the
// platform kept serving the old sha for 22 h, and there was no failed
// run anywhere to notice.
//
// The mechanism: GitHub compiles any workflow string that carries a
// `${{ … }}` interpolation into ONE `format('…literal…{0}…', …)`
// expression, and a single expression may not exceed 21,000 characters.
// A string with no interpolation is a plain literal and has no such cap.
// The remote deploy script is ~28 KB, so the moment it also carried the
// interpolated `.env` heredoc it blew the cap and the whole file became
// invalid.
//
// The fix that must not regress: every interpolation lives in a SHORT
// step, and the long remote script receives values as forwarded env vars
// (base64 for anything multi-line). These are text pins in the style of
// tests/platform-env-deploy.test.js — deploy.yml is guardrailed and no
// test can execute it.
//
// Run with: node --test tests/deploy-workflow-expression-limit.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const WORKFLOW_DIR = path.join(root, '.github/workflows');

// GitHub Actions' hard limit on a single expression.
const MAX_EXPRESSION_LENGTH = 21000;
// Leave real headroom: a value that only just fits today is one comment
// line away from breaking the deploy again.
const BUDGET = Math.floor(MAX_EXPRESSION_LENGTH * 0.75);

// Collect every block scalar (`key: |` / `key: >`) with its size and how
// many interpolations it carries. Deliberately a tiny hand-rolled scan
// rather than a YAML dependency — this suite must run with nothing but
// node's stdlib, like the rest of the deploy pins.
function blockScalars(src) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)([A-Za-z_][\w-]*):\s*[|>][-+\d]*\s*$/);
    if (!m) continue;
    const indent = m[1].length;
    let chars = 0;
    let exprs = 0;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      const lead = line.length - line.replace(/^\s*/, '').length;
      if (line.trim() !== '' && lead <= indent) break;
      chars += line.length + 1;
      exprs += (line.match(/\$\{\{/g) || []).length;
    }
    out.push({ line: i + 1, key: m[2], chars, exprs });
    i = j - 1;
  }
  return out;
}

const workflows = fs.readdirSync(WORKFLOW_DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ file: f, src: fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf8') }));

test('there is at least one workflow to check', () => {
  assert.ok(workflows.length >= 1);
  assert.ok(workflows.some((w) => w.file === 'deploy.yml'));
});

test('no interpolated block scalar comes anywhere near the 21000-char expression cap', () => {
  for (const { file, src } of workflows) {
    for (const b of blockScalars(src)) {
      if (b.exprs === 0) continue; // a pure literal is not an expression
      assert.ok(b.chars <= BUDGET,
        `${file}:${b.line} (${b.key}) is ${b.chars} chars with ${b.exprs} interpolation(s). `
        + `GitHub compiles it into one format() expression capped at ${MAX_EXPRESSION_LENGTH}; `
        + `keep interpolations in a short step and forward values as env vars instead.`);
    }
  }
});

test('the remote step stays a tiny expression-free delegator to scripts/deploy.sh', () => {
  // The deploy logic itself now lives in scripts/deploy.sh (shared with
  // the host deployer), so the ssh step should never grow back into a
  // multi-hundred-line script that could approach the cap — it only
  // exports the forwarded inputs and delegates.
  const deploy = workflows.find((w) => w.file === 'deploy.yml').src;
  assert.match(deploy, /^\s*bash scripts\/deploy\.sh\s*$/m,
    'the ssh step must delegate to the shared deploy script');
  const start = deploy.indexOf('- name: Write .env and run docker compose');
  const end = deploy.indexOf('- name: Signal deploy finished');
  assert.ok(start !== -1 && end > start);
  const step = deploy.slice(start, end);
  const script = step.slice(step.indexOf('script: |'));
  assert.ok(script.length < 1000,
    `the ssh script block is ${script.length} chars — deploy logic belongs in scripts/deploy.sh, not here`);
  assert.ok(!/\$\{\{/.test(script), 'the remote script must stay expression-free');
});

test('every ${{ }} in deploy.yml is balanced on its own line', () => {
  // An unclosed interpolation makes the parser swallow the rest of the
  // file as one expression — the same "max expression length" error with
  // a completely different cause.
  const deploy = workflows.find((w) => w.file === 'deploy.yml').src;
  deploy.split('\n').forEach((line, idx) => {
    const opens = (line.match(/\$\{\{/g) || []).length;
    if (!opens) return;
    const closes = (line.match(/\}\}/g) || []).length;
    assert.ok(closes >= opens,
      `deploy.yml:${idx + 1} opens ${opens} interpolation(s) and closes ${closes}: ${line.trim()}`);
  });
});

// ── The wiring that keeps the remote script expression-free ────────────

test('the base .env is composed in its own short step and forwarded as base64', () => {
  const deploy = workflows.find((w) => w.file === 'deploy.yml').src;
  const compose = deploy.indexOf('- name: Compose base .env');
  assert.notStrictEqual(compose, -1, 'the composition step must exist');
  const sshStep = deploy.indexOf('- name: Write .env and run docker compose');
  assert.ok(compose < sshStep, 'the .env must be composed before the ssh step consumes it');

  const step = deploy.slice(compose, deploy.indexOf('- name: Sync repo to VPS'));
  assert.match(step, /cat > "\$OUT_FILE" <<'ENVEOF'/,
    'single-quoted heredoc: no shell expansion over GitHub-substituted values');
  assert.match(step, /BASE_ENV_B64=\$\(base64 -w0 < "\$OUT_FILE"\)/,
    'single-line base64 survives $GITHUB_ENV and the ssh-action envs: forwarding');
  // The multi-line PEM is exactly why this cannot be a plain env var.
  assert.match(step, /GITHUB_PRIVATE_KEY='\$\{\{ secrets\.USERNODE_GITHUB_PRIVATE_KEY \}\}'/);
  assert.match(step, /GIT_SHA=\$\{\{ github\.sha \}\}/);
});

test('the ssh step forwards the blob and the target sha into the remote shell', () => {
  const deploy = workflows.find((w) => w.file === 'deploy.yml').src;
  const step = deploy.slice(deploy.indexOf('- name: Write .env and run docker compose'),
    deploy.indexOf('- name: Signal deploy finished'));
  assert.match(step, /BASE_ENV_B64: \$\{\{ env\.BASE_ENV_B64 \}\}/);
  assert.match(step, /DEPLOY_SHA: \$\{\{ github\.sha \}\}/);
  const envs = step.match(/envs: ([^\n]+)/);
  assert.ok(envs, 'the ssh step must declare envs:');
  for (const name of ['BASE_ENV_B64', 'DEPLOY_SHA', 'GH_PLATFORM_ENV_B64']) {
    assert.ok(envs[1].includes(name),
      `${name} must be listed in envs: or it never reaches the remote shell`);
  }
});

test('the deploy script never truncates .env unless the blob is present', () => {
  // The guard moved into scripts/deploy.sh when the remote logic did —
  // and its meaning widened: a missing blob is now the host-deployer
  // path (keep .env, patch GIT_SHA), and only a missing blob AND a
  // missing .env is a hard failure.
  const deploySh = fs.readFileSync(path.join(root, 'scripts/deploy.sh'), 'utf8');
  const guard = deploySh.indexOf('if [ -n "${BASE_ENV_B64:-}" ]');
  const write = deploySh.indexOf('echo "$BASE_ENV_B64" | base64 -d > .env');
  assert.notStrictEqual(guard, -1, 'the rewrite must be conditional on the blob existing');
  assert.notStrictEqual(write, -1);
  assert.ok(guard < write, 'the guard has to run before the redirect truncates .env');
  assert.match(deploySh, /No BASE_ENV_B64 and no existing \.env/,
    'blob-less with no .env on disk must fail loudly, not boot unconfigured');
});

test('the .env keys the platform cannot boot without are still all written', () => {
  const deploy = workflows.find((w) => w.file === 'deploy.yml').src;
  const step = deploy.slice(deploy.indexOf('- name: Compose base .env'),
    deploy.indexOf('- name: Sync repo to VPS'));
  for (const key of [
    'USERNODE_DOMAIN', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'SESSION_SECRET',
    'USERNODE_DB_PASSWORD', 'GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY',
    'GITHUB_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'GIT_SHA', 'LOG_LEVEL',
    // config.js REQUIRED_PROD — boot exits 1 without any of these.
    'DATA_ENCRYPTION_KEY', 'IFRAME_JWT_PRIVATE_KEY', 'IFRAME_JWT_PUBLIC_KEY',
    'WORKER_JWT_SECRET', 'EDGE_JWT_SECRET',
  ]) {
    // Indented inside the YAML block scalar; the block's own indentation
    // is stripped before the runner shell sees the heredoc.
    assert.ok(new RegExp(`^\\s*${key}=`, 'm').test(step),
      `${key} missing from the composed .env`);
  }
});

// The retired shared secret. Nothing in the platform process verifies with
// it any more, so writing it into the platform .env would only leave the
// old value sitting under a name whose meaning changed (child containers
// now receive JWT_SECRET = the RSA PUBLIC key, injected by
// services/app-identity-env.js — never from this file).
test('the retired shared JWT_SECRET is not written into the platform .env', () => {
  const deploy = workflows.find((w) => w.file === 'deploy.yml').src;
  const step = deploy.slice(deploy.indexOf('- name: Compose base .env'),
    deploy.indexOf('- name: Sync repo to VPS'));
  assert.ok(!/^\s*JWT_SECRET=/m.test(step),
    'JWT_SECRET must not be composed into the platform .env');
});
