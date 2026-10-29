'use strict';
// Audit all lockfiles, including development dependencies and vendored inputs.
//
// SECURITY_BASELINE_REVISION names the commit a finding is compared against:
// a pull request's base, or the source revision of the release that is live.
// A finding on a package that commit already locks, at the same version, is
// reported as already shipped and does not fail the audit; with no readable
// baseline every finding fails, as before (scripts/security-findings.js).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { npmGate, lockPackages, report } = require('./security-findings');

function baselineLock(root, revision, dir) {
  if (!revision) return null;
  const file = dir === '.' ? 'package-lock.json' : `${dir}/package-lock.json`;
  const shown = spawnSync('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (shown.status !== 0) return null;
  try { return lockPackages(JSON.parse(shown.stdout)); } catch { return null; }
}

function main() {
  const root = path.join(__dirname, '..');
  const out = path.resolve(process.env.SECURITY_REPORT_DIR || 'security-reports');
  const revision = /^[a-f0-9]{40}$/.test(process.env.SECURITY_BASELINE_REVISION || '') ? process.env.SECURITY_BASELINE_REVISION : '';
  const baselineName = process.env.SECURITY_BASELINE_NAME || (revision ? revision.slice(0, 9) : 'the baseline');
  fs.mkdirSync(out, { recursive: true });
  for (const [name, dir] of [['root', '.'], ['frontend', 'frontend'], ['starter', 'src/templates/node-app']]) {
    try {
      const cwd = path.join(root, dir);
      const result = spawnSync('npm', ['audit', '--package-lock-only', '--include=dev', '--json'], {
        cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024,
      });
      if (result.error || result.status === null || result.status > 1) throw new Error(result.error?.message || result.stderr || `audit exit ${result.status}`);
      fs.writeFileSync(path.join(out, `${name}-npm-audit.json`), result.stdout);
      const audit = JSON.parse(result.stdout);
      const baseline = baselineLock(root, revision, dir);
      if (revision && !baseline) console.log(`::warning title=${name} lockfile::No baseline lockfile at ${baselineName}; every finding blocks.`);
      const gate = npmGate(audit, JSON.parse(fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8')), { baseline });
      fs.writeFileSync(path.join(out, `${name}-gate.json`), JSON.stringify({ baseline: baseline ? revision : null, ...gate }, null, 2));
      console.log(`${name}: ${JSON.stringify(audit.metadata.vulnerabilities)}`);
      report(`${name} lockfile`, gate, { baselineName });
      if (gate.blocking.length) throw new Error(gate.blocking.join('\n'));
    } catch (err) { console.error(`${name}: ${err.message}`); process.exitCode = 1; }
  }
}
if (require.main === module) main();
module.exports = { baselineLock };
