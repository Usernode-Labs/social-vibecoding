'use strict';

// Pins the production graduation of the #687 PR-import feature. The flag
// itself must stay off-by-default in code (tests/pr-import-flag.test.js
// guards that dark-launch contract for self-hosting forks), so the ONLY
// thing turning the feature on in production is the deploy workflow
// writing PR_IMPORT_ENABLED into the platform's .env. This is a
// text-pinning test (same pattern as tests/caddy-deploy-grace.test.js):
// the workflow is config, not code, so the strongest cheap guard is
// asserting the load-bearing line survives edits to the env template. If
// it fails, the next deploy silently re-darkens PR-import — no UI entry
// point, all /pr-import routes 404.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const workflow = fs.readFileSync(
  path.join(root, '.github', 'workflows', 'deploy.yml'), 'utf8'
);

// Slice out the .env heredoc so the assertions can't be satisfied by a
// stray mention elsewhere in the workflow (a comment, an `envs:` list).
function envHeredoc() {
  const start = workflow.indexOf("cat > .env <<'ENVEOF'");
  assert.notStrictEqual(start, -1, '.env heredoc start marker not found');
  // The closing ENVEOF is YAML-indented in the raw file (the block
  // scalar's indentation is stripped before the shell sees it), so find
  // the next line that is exactly ENVEOF once trimmed.
  const rest = workflow.slice(start).split('\n');
  const endIdx = rest.findIndex((l, i) => i > 0 && l.trim() === 'ENVEOF');
  assert.notStrictEqual(endIdx, -1, '.env heredoc end marker not found');
  return rest.slice(0, endIdx).join('\n');
}

test('deploy workflow writes PR_IMPORT_ENABLED into the production .env, defaulting to true', () => {
  const heredoc = envHeredoc();
  const lines = heredoc.split('\n').map((l) => l.trim());
  const line = lines.find((l) => l.startsWith('PR_IMPORT_ENABLED='));
  assert.ok(line, 'PR_IMPORT_ENABLED line missing from the .env heredoc — production would boot with PR-import dark');

  // Repo-variable override with a committed 'true' default, matching the
  // scaling-tunable pattern. isPrImportEnabled() only accepts the exact
  // string "true", so the default must be exactly that.
  assert.strictEqual(
    line,
    "PR_IMPORT_ENABLED=${{ vars.PR_IMPORT_ENABLED || 'true' }}",
    'PR_IMPORT_ENABLED must default to the exact string \'true\' with a vars.PR_IMPORT_ENABLED override'
  );
});

test('deploy workflow does NOT enable the mock-GitHub adapter in production', () => {
  // PR_IMPORT_MOCK_GITHUB must stay unset in the production .env so the
  // imported-PR flow always uses the real github.js client there (the
  // mock is a staging-preview affordance via dapp.json staging_default).
  assert.ok(
    !envHeredoc().includes('PR_IMPORT_MOCK_GITHUB'),
    'PR_IMPORT_MOCK_GITHUB must not be written to the production .env'
  );
});
