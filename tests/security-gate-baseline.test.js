'use strict';

// The security gates block only what a change introduces (29 Oct 2026): a
// finding on a package the baseline (a pull request's base, or what is live)
// already ships at the same version is reported, not failed. Every release
// on main had failed for hours on an advisory published that afternoon
// against decode-uri-component 0.2.2, which production already ran.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const { npmGate, npmFindings, imageGate, imageFindings, lockPackages, sbomPackages, report } = require('../scripts/security-findings');
const { baselineLock } = require('../scripts/security-audit');
const { parseReleaseValues, liveRelease } = require('../scripts/live-release');

const ROOT = path.join(__dirname, '..');
const NOW = Date.parse('2026-10-29T19:00:00Z');

// An npm audit of the root lockfile, as `npm audit --json` shapes it.
function audit(name, node, severity = 'high', id = 'GHSA-qr28-fpjm-wq7f') {
  return {
    metadata: { vulnerabilities: { high: 1 } },
    vulnerabilities: { [name]: { nodes: [node], via: [{ severity, url: `https://github.com/advisories/${id}` }] } },
  };
}
const LOCK = { packages: {
  '': { name: 'social-vibecoding' },
  'node_modules/minio': { version: '8.0.7' },
  'node_modules/query-string': { version: '7.1.3' },
  'node_modules/query-string/node_modules/decode-uri-component': { version: '0.2.2' },
  'node_modules/@scope/pkg': { version: '1.0.0' },
} };

test('a lockfile lists every package@version it installs, nested and scoped', () => {
  assert.deepEqual([...lockPackages(LOCK)].sort(),
    ['@scope/pkg@1.0.0', 'decode-uri-component@0.2.2', 'minio@8.0.7', 'query-string@7.1.3']);
  assert.equal(lockPackages(null).size, 0);
});

test('a finding on a package the baseline already ships is reported, not blocking', () => {
  const findings = audit('decode-uri-component', 'node_modules/query-string/node_modules/decode-uri-component', 'high', 'GHSA-new-advisory');
  const shipped = npmGate(findings, LOCK, { now: NOW, baseline: lockPackages(LOCK) });
  assert.deepEqual(shipped, { blocking: [], preexisting: ['decode-uri-component@0.2.2: GHSA-new-advisory'] });
  // The change upgraded into it, or added it: blocking.
  const before = lockPackages({ packages: { 'node_modules/decode-uri-component': { version: '0.2.1' } } });
  assert.deepEqual(npmGate(findings, LOCK, { now: NOW, baseline: before }).blocking, ['decode-uri-component@0.2.2: GHSA-new-advisory']);
  // No baseline: every finding blocks, as before.
  assert.deepEqual(npmGate(findings, LOCK, { now: NOW }).blocking, ['decode-uri-component@0.2.2: GHSA-new-advisory']);
  assert.deepEqual(npmFindings(findings, LOCK, NOW), ['decode-uri-component@0.2.2: GHSA-new-advisory'], 'the strict wrapper keeps its meaning');
  // Moderate findings never gate.
  const moderate = audit('decode-uri-component', 'node_modules/query-string/node_modules/decode-uri-component', 'moderate', 'GHSA-new-advisory');
  assert.deepEqual(npmGate(moderate, LOCK, { now: NOW }), { blocking: [], preexisting: [] });
});

test('an exception still lets an introduced finding through', () => {
  const excepted = audit('zod', 'node_modules/zod', 'high', 'GHSA-mrhx-c7xc-m3w5');
  const lock = { packages: { 'node_modules/zod': { version: '3.25.76' } } };
  assert.deepEqual(npmGate(excepted, lock, { now: Date.parse('2026-10-29'), baseline: new Set() }), { blocking: [], preexisting: [] });
});

test('an image finding on a package the live image already ships is reported, not blocking', () => {
  const scan = { SchemaVersion: 2, Results: [{ Target: 'usr/local/bin/node', Vulnerabilities: [
    { Severity: 'HIGH', PkgName: 'libssl3', InstalledVersion: '3.0.15-1~deb12u1', VulnerabilityID: 'CVE-2026-1', FixedVersion: '3.0.16-1~deb12u1' },
    { Severity: 'CRITICAL', PkgName: 'newlib', InstalledVersion: '1.0.0', VulnerabilityID: 'CVE-2026-2', FixedVersion: '1.0.1' },
    { Severity: 'HIGH', PkgName: 'unfixable', InstalledVersion: '1.0.0', VulnerabilityID: 'CVE-2026-3' },
  ] }] };
  const live = sbomPackages({ spdxVersion: 'SPDX-2.3', packages: [
    { name: 'libssl3', versionInfo: '3.0.15-1~deb12u1' }, { name: 'unfixable', versionInfo: '1.0.0' }, { name: 'noversion' },
  ] });
  assert.deepEqual(imageGate(scan, { now: NOW, component: 'platform', baseline: live }), {
    blocking: ['usr/local/bin/node: newlib@1.0.0: CVE-2026-2 (fix 1.0.1)'],
    preexisting: ['usr/local/bin/node: libssl3@3.0.15-1~deb12u1: CVE-2026-1 (fix 3.0.16-1~deb12u1)'],
  });
  assert.equal(imageFindings(scan, NOW, 'platform').length, 2, 'the strict wrapper still blocks both fixable findings');
  assert.throws(() => sbomPackages({ spdxVersion: 'SPDX-2.3', packages: [] }), /Missing or empty baseline SPDX SBOM/);
});

test('the gate writes the annotations the platform reads to say why a release is blocked', () => {
  const lines = [];
  const summary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-summary-')), 'summary.md');
  const previous = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summary;
  try {
    report('root lockfile', { blocking: ['a@1.0.0: GHSA-x'], preexisting: ['b@2.0.0: GHSA-y'] },
      { log: (line) => lines.push(line), baselineName: 'the live release (a5f91bc5f)' });
  } finally {
    if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = previous;
  }
  assert.deepEqual(lines, [
    '::error title=Security gate: root lockfile::a@1.0.0: GHSA-x',
    '::warning title=Already shipped: root lockfile::b@2.0.0: GHSA-y (already in the live release (a5f91bc5f); not introduced by this change)',
  ]);
  const text = fs.readFileSync(summary, 'utf8');
  assert.match(text, /\*\*Blocking: introduced by this change\*\*\n\n- a@1\.0\.0: GHSA-x/);
  assert.match(text, /\*\*Already shipped in the live release \(a5f91bc5f\): reported, not blocking\*\*\n\n- b@2\.0\.0: GHSA-y/);
});

test('the baseline lockfile is read at the baseline commit; one that cannot be read is no baseline', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-baseline-'));
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q');
  fs.mkdirSync(path.join(repo, 'frontend'));
  fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify(LOCK));
  fs.writeFileSync(path.join(repo, 'frontend', 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/react': { version: '19.2.0' } } }));
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  assert.ok(baselineLock(repo, sha, '.').has('decode-uri-component@0.2.2'));
  assert.deepEqual([...baselineLock(repo, sha, 'frontend')], ['react@19.2.0']);
  assert.equal(baselineLock(repo, sha, 'src/templates/node-app'), null, 'no lockfile there at that commit');
  assert.equal(baselineLock(repo, 'f'.repeat(40), '.'), null, 'a commit the clone does not have');
  assert.equal(baselineLock(repo, '', '.'), null);
});

// The values.release.yaml the release job packages, as the live chart held it.
const VALUES = [
  '# Generated by .github/workflows/build-kubernetes-images.yml.',
  'release:',
  '  sourceRevision: "a5f91bc5ff8ebc2c255754663d48e62b699bcbea"',
  'platform:',
  '  image:',
  '    repository: ghcr.io/usernode-labs/social-vibecoding-platform',
  `    digest: sha256:${'f'.repeat(64)}`,
  '  workerImage:',
  '    repository: ghcr.io/usernode-labs/social-vibecoding-worker',
  `    digest: sha256:${'7'.repeat(64)}`,
  '  captureImage:',
  '    repository: ghcr.io/usernode-labs/social-vibecoding-capture',
  `    digest: sha256:${'4'.repeat(64)}`,
  '',
].join('\n');

test('what is live comes off the newest stable chart, and an unreadable chart is no baseline', () => {
  const live = {
    revision: 'a5f91bc5ff8ebc2c255754663d48e62b699bcbea',
    platform: `sha256:${'f'.repeat(64)}`, worker: `sha256:${'7'.repeat(64)}`, capture: `sha256:${'4'.repeat(64)}`,
  };
  assert.deepEqual(parseReleaseValues(VALUES), live);
  assert.equal(parseReleaseValues(VALUES.replace(/ {2}captureImage:[\s\S]*$/, '')), null, 'a digest missing');
  assert.equal(parseReleaseValues(VALUES.replace(/sourceRevision: .*/, 'sourceRevision: "main"')), null);

  const calls = [];
  const helm = (file, args) => {
    calls.push([file, ...args]);
    const dir = args[args.indexOf('--untardir') + 1];
    fs.mkdirSync(path.join(dir, 'social-vibecoding-platform'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'social-vibecoding-platform', 'values.release.yaml'), VALUES);
    return { status: 0 };
  };
  assert.deepEqual(liveRelease('usernode-labs', { run: helm }), live);
  assert.deepEqual(calls[0].slice(0, 5), ['helm', 'pull', 'oci://ghcr.io/usernode-labs/charts/social-vibecoding-platform', '--version', '0.1.*'],
    'the newest stable chart: the one the plan job reads as published');
  assert.equal(liveRelease('usernode-labs', { run: () => ({ status: 1 }) }), null);
});

test('the workflow gives each gate its baseline, and a gate with none stays strict', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/build-kubernetes-images.yml'), 'utf8'));
  const step = (job, name) => workflow.jobs[job].steps.find((s) => s.name === name);
  // Lockfiles: a pull request's base, or the live release.
  const lockfiles = workflow.jobs['security-lockfiles'];
  assert.equal(step('security-lockfiles', 'Read the live release').if, "github.event_name != 'pull_request'");
  const baseline = step('security-lockfiles', 'Fetch the baseline commit');
  assert.equal(baseline.env.BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  assert.equal(baseline.env.LIVE_SHA, '${{ steps.live.outputs.revision }}');
  assert.match(baseline.run, /git fetch --no-tags --depth=1 origin "\$revision"/);
  const auditStep = lockfiles.steps.find((s) => s.run === 'node scripts/security-audit.js');
  assert.deepEqual(auditStep.env, {
    SECURITY_BASELINE_REVISION: '${{ steps.baseline.outputs.revision }}',
    SECURITY_BASELINE_NAME: '${{ steps.baseline.outputs.name }}',
  });
  // Images: the live image of the same component, by digest.
  const prScan = step('security-images', 'Build and scan the finished image');
  assert.equal(prScan.env.LIVE_DIGEST, '${{ steps.live.outputs[matrix.component] }}');
  assert.match(prScan.run, /export BASELINE_IMAGE="ghcr\.io\/\$\{GITHUB_REPOSITORY_OWNER,,\}\/social-vibecoding-\$COMPONENT@\$LIVE_DIGEST"/);
  const releaseScan = step('build', 'Verify runtime and scan the exact image SBOM');
  assert.equal(releaseScan.env.LIVE_DIGEST, '${{ steps.live.outputs[matrix.component] }}');
  assert.match(releaseScan.run, /export BASELINE_IMAGE="ghcr\.io\/\$REGISTRY_OWNER\/social-vibecoding-\$\{\{ matrix\.component \}\}@\$LIVE_DIGEST"/);
  assert.match(releaseScan.run, /sh scripts\/check-published-image\.sh "\$IMAGE" "\$REPORT" "\$\{\{ matrix\.component \}\}"/);
  // The live release is read before the scan in both jobs.
  for (const job of ['security-images', 'build']) {
    const names = workflow.jobs[job].steps.map((s) => s.name || s.uses);
    assert.ok(names.indexOf('Read the live release') > names.indexOf('azure/setup-helm@v4'), `${job}: helm is set up first`);
  }
  // The image check passes the baseline SBOM to the findings, and only when read.
  const check = fs.readFileSync(path.join(ROOT, 'scripts/check-image-security.sh'), 'utf8');
  assert.match(check, /docker buildx imagetools inspect "\$BASELINE_IMAGE" --format '\{\{json \.SBOM\}\}'/);
  assert.match(check, /node scripts\/security-findings\.js "\$out\/vulnerabilities\.json" "\$component" \$baseline \|\| status=1/);
  assert.match(check, /node scripts\/security-findings\.js "\$out\/image-vulnerabilities\.json" "\$component" \$baseline \|\| status=1/);
});

// A fake `docker` that records each call and writes what the scan steps read:
// Trivy's reports into the mounted /output, an SBOM attestation, a saved tar.
function fakeDocker(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "${path.join(dir, 'calls.log')}"
out=; prev=; report=
for a in "$@"; do
  case "$prev" in -v) case "$a" in *:/output) out="\${a%:/output}" ;; esac ;; --output) report="\${a#/output/}" ;; -o) touch "$a" ;; esac
  prev="$a"
done
case "$*" in
  *"imagetools inspect"*) cat "${path.join(dir, 'attestation.json')}" ;;
  *"--entrypoint node"*) cat > /dev/null; echo '{}' ;;
  *" sbom "*|*" image --skip-db-update"*) cp "${path.join(dir, 'report.json')}" "$out/$report" ;;
esac
`, { mode: 0o755 });
  return bin;
}

test('an image with the same digest as the live image is not pulled, saved or rescanned, and cannot block', () => {
  const live = 'ghcr.io/usernode-labs/social-vibecoding-worker@sha256:' + 'c'.repeat(64);
  const other = 'ghcr.io/usernode-labs/social-vibecoding-worker@sha256:' + 'd'.repeat(64);
  const sbom = { spdxVersion: 'SPDX-2.3', packages: [{ name: 'libssl3', versionInfo: '3.0.15-1~deb12u1' }] };
  // A fixable HIGH on a package the image ships: only the live image's own
  // SBOM makes it "already shipped".
  const report = { SchemaVersion: 2, Results: [{ Target: 'worker', Vulnerabilities: [
    { Severity: 'HIGH', PkgName: 'libssl3', InstalledVersion: '3.0.15-1~deb12u1', VulnerabilityID: 'CVE-2026-9', FixedVersion: '3.0.16-1~deb12u1' },
  ] }] };
  const run = (image, baselineImage, attestation) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-check-'));
    const out = path.join(dir, 'out');
    fs.writeFileSync(path.join(dir, 'sbom.spdx.json'), JSON.stringify(sbom));
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report));
    fs.writeFileSync(path.join(dir, 'attestation.json'), JSON.stringify(attestation));
    const res = spawnSync('sh', ['scripts/check-image-security.sh', image, out, path.join(dir, 'sbom.spdx.json'), 'worker'], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeDocker(dir)}:${process.env.PATH}`, BASELINE_IMAGE: baselineImage, GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md') },
    });
    return { res, dir, out, calls: fs.readFileSync(path.join(dir, 'calls.log'), 'utf8') };
  };

  // The live image, reused: no probe, no save, no second SBOM read; it passes.
  const same = run(live, live, {});
  assert.equal(same.res.status, 0, same.res.stderr);
  assert.doesNotMatch(same.calls, /--entrypoint node/, 'not run for the runtime probes');
  assert.doesNotMatch(same.calls, /image save/, 'not saved to a tar');
  assert.doesNotMatch(same.calls, /imagetools inspect/, 'its own SBOM is the live SBOM');
  assert.match(same.calls, / sbom --skip-db-update/, 'the SBOM scan still runs');
  assert.match(same.res.stdout, /::notice title=worker image is the live image::Same digest as the live image \(sha256:c{64}\)/);
  assert.match(same.res.stdout, /::warning title=Already shipped: worker image::worker: libssl3@3\.0\.15-1~deb12u1: CVE-2026-9/);
  assert.ok(fs.existsSync(path.join(same.out, 'live-image.txt')));
  assert.match(fs.readFileSync(path.join(same.dir, 'summary.md'), 'utf8'), /### worker image\n\nSame digest as the live image/);

  // A different image keeps every check, against the live image's attestation.
  const changed = run(other, live, { SPDX: sbom });
  assert.equal(changed.res.status, 0, changed.res.stderr);
  assert.equal((changed.calls.match(/--entrypoint node/g) || []).length, 2, 'both runtime probes');
  assert.match(changed.calls, /image save -o/);
  assert.match(changed.calls, /imagetools inspect ghcr\.io\/usernode-labs\/social-vibecoding-worker@sha256:c{64}/);
  assert.match(changed.calls, / image --skip-db-update/, 'the full-image scan');
  assert.ok(!fs.existsSync(path.join(changed.out, 'live-image.txt')));

  // A different image with no readable live SBOM blocks on the finding.
  const strict = run(other, live, {});
  assert.equal(strict.res.status, 1);
  assert.match(strict.res.stdout, /::warning title=worker image::The live image's SBOM could not be read; every finding blocks\./);
  assert.match(strict.res.stdout, /::error title=Security gate: worker image::worker: libssl3/);
});
