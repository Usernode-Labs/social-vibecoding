'use strict';
// Audit all lockfiles, including development dependencies and vendored inputs.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { npmFindings } = require('./security-findings');
function main() {
  const root = path.join(__dirname, '..');
  const out = path.resolve(process.env.SECURITY_REPORT_DIR || 'security-reports');
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
      const failures = npmFindings(audit, JSON.parse(fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8')));
      console.log(`${name}: ${JSON.stringify(audit.metadata.vulnerabilities)}`);
      if (failures.length) throw new Error(failures.join('\n'));
    } catch (err) { console.error(`${name}: ${err.message}`); process.exitCode = 1; }
  }
}
if (require.main === module) main();
