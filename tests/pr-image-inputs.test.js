'use strict';

// scripts/pr-image-inputs.js: which pull requests the image scans are skipped
// for. The rule must fail closed, so most of what is pinned here is what
// still scans: an unknown path, a package manifest anywhere, an odd file
// mode, a diff that cannot be read, and everything an image is built from.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const YAML = require('yaml');

const { isCodeOnly, parseRaw, decide, changedEntries } = require('../scripts/pr-image-inputs');

const ROOT = path.join(__dirname, '..');
const plain = (...files) => files.map((file) => ({ file, modes: ['100644', '100644'] }));

test('a change to application code alone is not built', () => {
  const files = ['src/services/votes.js', 'src/workflow/platform.ts', 'src/db/migrations/a-change.sql',
    'src/db/migrations/manifest.json', 'frontend/src/Shell.tsx', 'frontend/@/components/ui/button.tsx',
    'frontend/locales/en/home.json', 'public/js/app.js', 'public/css/app.css', 'styles/tailwind-input.css',
    'tests/votes.test.js', 'tests/baselines/test-durations.json', 'docs/plans/versions.md', 'server.js',
    'dapp.json', 'AGENTS.md', 'public/brand/cloud.webp'];
  assert.deepEqual(files.filter((file) => !isCodeOnly(file)), []);
  assert.equal(decide(plain(...files)).scan, false);
});

test('one file it does not know makes the whole change scan', () => {
  for (const file of ['Dockerfile', 'Dockerfile.kubernetes', '.dockerignore', 'package.json', 'package-lock.json',
    'frontend/package.json', 'frontend/package-lock.json', 'frontend/vite.config.ts', 'frontend/scripts/build-shell.mjs',
    'tailwind.config.js', 'worker/run-cc.sh', 'worker/usernode-debug', 'capture/capture.js', 'capture/package.json',
    'shots/hosted-app-fixture.js', 'vendor/decode-uri-component/index.js', 'public/vendor/marked.min.js',
    'app-templates/tier/package.json', 'build-support/buildx/dependencies.patch', 'security/exceptions.json',
    'scripts/check-image-security.sh', 'scripts/pr-image-inputs.js', '.github/workflows/kubernetes-pr-checks.yml',
    '.github/actions/build-kubernetes-image/action.yml', 'deploy/helm/x/values.yaml', 'a-new-directory/file.js', 'new-file.js',
    // Inside a code directory, but a manifest, an SBOM, third-party, or a type no code here has.
    'src/package.json', 'src/a/package-lock.json', 'tests/fixtures/app/package.json', 'src/x/node_modules/y/index.js',
    'public/js/vendor/y.js', 'src/a.spdx.json', 'src/a.cdx.json', 'src/app.deps.json', 'src/composer.json', 'src/data.json',
    'src/requirements.txt', 'src/yarn.lock', 'src/lib.jar', 'src/mod.wasm', 'src/go.mod', 'src/no-extension', 'src/.npmrc',
    'tests/fixtures/data.json', 'public/manifest.webmanifest']) {
    assert.equal(isCodeOnly(file), false, file);
    const decision = decide(plain('src/services/votes.js', file));
    assert.equal(decision.scan, true, file);
    assert.ok(decision.reason.includes(file), 'the summary names it');
  }
});

test('a symlink, a submodule or a type change scans, whatever its path', () => {
  for (const modes of [['000000', '120000'], ['100644', '120000'], ['120000', '000000'], ['000000', '160000']]) {
    assert.equal(decide([{ file: 'src/services/votes.js', modes }]).scan, true, modes.join(' '));
  }
  assert.equal(decide([{ file: 'src/new.js', modes: ['000000', '100644'] }, { file: 'src/old.js', modes: ['100755', '000000'] }]).scan, false,
    'an added and a deleted regular file are ordinary');
});

test('a diff it cannot read exactly is an error, and no files at all scans', () => {
  const entry = `:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0src/a.js\0`;
  assert.deepEqual(parseRaw(entry), [{ file: 'src/a.js', modes: ['100644', '100644'] }]);
  assert.deepEqual(parseRaw(`:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} M\0src/a file\nwith a line.js\0`)[0].file, 'src/a file\nwith a line.js');
  for (const bad of ['src/a.js', entry.slice(0, -1), `${entry}:100644`, entry.replace(' M', ' R100'), entry.replace('a'.repeat(40), 'abc')]) {
    assert.throws(() => parseRaw(bad), /diff/, JSON.stringify(bad));
  }
  assert.equal(decide([]).scan, true);
});

// A repository with a pull request's merge commit, as GitHub checks one out.
function mergeRepo(t, change) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-image-inputs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.email=a@example.invalid', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
  git('init', '-q', '-b', 'main');
  write('src/a.js', '1'); write('package.json', '{}'); git('add', '-A'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'pr');
  change(write, git, dir);
  git('add', '-A'); git('commit', '-qm', 'change');
  git('checkout', '-q', 'main');
  // main moved on in a way the pull request did not make.
  write('worker/Dockerfile', 'FROM x'); git('add', '-A'); git('commit', '-qm', 'main moves');
  return { dir, git };
}
const run = (dir) => {
  const out = path.join(dir, '.github-output');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/pr-image-inputs.js')], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: path.join(dir, '.summary') },
  });
  return { status: result.status, output: fs.readFileSync(out, 'utf8').trim(), summary: fs.readFileSync(path.join(dir, '.summary'), 'utf8') };
};

test('it reads the change the merge commit makes to the base, not what main did meanwhile', (t) => {
  const code = mergeRepo(t, (write) => write('src/a.js', '2'));
  code.git('merge', '-q', '--no-ff', '-m', 'merge', 'pr');
  assert.deepEqual(run(code.dir), { status: 0, output: 'scan=false', summary: 'Not built: All 1 changed file is application code; the images keep the packages of the base.\n' });
  const lock = mergeRepo(t, (write) => { write('src/a.js', '2'); write('package.json', '{"dependencies":{}}'); });
  lock.git('merge', '-q', '--no-ff', '-m', 'merge', 'pr');
  const locked = run(lock.dir);
  assert.equal(locked.output, 'scan=true');
  assert.match(locked.summary, /^Building and scanning: package\.json may change/);
  // A rename out of a scanned directory is a delete there and an add here.
  const renamed = mergeRepo(t, (write, git) => git('mv', 'package.json', 'src/renamed.js'));
  renamed.git('merge', '-q', '--no-ff', '-m', 'merge', 'pr');
  assert.equal(run(renamed.dir).output, 'scan=true');
});

test('a checkout it cannot compare scans, and does not fail the job', (t) => {
  const { dir, git } = mergeRepo(t, (write) => write('src/a.js', '2'));
  const notMerged = run(dir);
  assert.deepEqual([notMerged.status, notMerged.output], [0, 'scan=true'], 'HEAD is not a merge commit');
  fs.rmSync(path.join(dir, '.github-output'));
  git('merge', '-q', '--no-ff', '-m', 'merge', 'pr');
  fs.rmSync(path.join(dir, '.git'), { recursive: true });
  // The directory is under the system temp directory, outside any repository.
  const noRepo = run(dir);
  assert.deepEqual([noRepo.status, noRepo.output], [0, 'scan=true']);
  assert.throws(() => changedEntries(() => `${'a'.repeat(40)} ${'b'.repeat(40)}\n`), /not a pull request's merge commit/);
});

test('every manifest, Dockerfile and lockfile in this repository scans, and so does what the worker and capture images copy', () => {
  const manifests = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (['.git', 'node_modules', '.worktrees'].includes(entry.name)) continue;
      const file = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(file);
      else if (/^(Dockerfile.*|.*\.dockerfile|package\.json|package-lock\.json|\.npmrc|\.dockerignore)$|\.lock$/i.test(entry.name)) manifests.push(file);
    }
  };
  walk('');
  assert.ok(manifests.includes('worker/Dockerfile') && manifests.includes('frontend/package-lock.json'), 'the walk found them');
  assert.deepEqual(manifests.filter(isCodeOnly), []);
  for (const [dockerfile, context] of [['worker/Dockerfile', 'worker/'], ['capture/Dockerfile', '']]) {
    const copies = fs.readFileSync(path.join(ROOT, dockerfile), 'utf8').split('\n')
      .map((line) => /^COPY\s+(?!--from=)(?:--\S+\s+)*(\S+)\s+\S+\s*$/.exec(line)?.[1]).filter(Boolean).map((file) => context + file);
    assert.ok(copies.length > 3, `${dockerfile} copies files`);
    assert.deepEqual(copies.filter(isCodeOnly), [], `${dockerfile}: a change to what it copies is scanned`);
  }
});

test('the workflow asks the rule in every image job but the starter, and only an explicit false skips', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/kubernetes-pr-checks.yml'), 'utf8'));
  const { steps, if: condition, strategy } = workflow.jobs['security-images'];
  assert.equal(condition, undefined, 'the required check of each image always reports');
  assert.deepEqual(strategy.matrix.include.map(({ component }) => component), ['platform', 'standalone', 'worker', 'capture', 'starter']);
  const asked = steps.findIndex((step) => step.id === 'inputs');
  assert.deepEqual(steps[asked], {
    name: "Check whether the change can reach an image's packages",
    if: "matrix.component != 'starter'", id: 'inputs', run: 'node scripts/pr-image-inputs.js',
  });
  assert.deepEqual(steps.slice(0, asked).map((step) => step.uses), ['actions/checkout@v6', 'actions/setup-node@v6']);
  assert.equal(steps[0].with['fetch-depth'], 2, 'the merge commit and its parents');
  for (const step of steps.slice(asked + 1)) {
    const name = step.name || step.uses || step.run;
    assert.match(String(step.if), /(^|&& )steps\.inputs\.outputs\.scan != 'false'$/, name);
    assert.doesNotMatch(String(step.if), /\|\|/, name);
  }
  // The daily audit builds and scans every image, and asks nothing.
  const audit = fs.readFileSync(path.join(ROOT, '.github/workflows/security-audit.yml'), 'utf8');
  assert.doesNotMatch(audit, /pr-image-inputs/);
});
