'use strict';

// The Chromium builds Playwright downloads are in no distro database and no
// lockfile, so the image scan never saw one: Chromium 141 sat in the worker
// image for a year (Nov 2026). scripts/playwright-browsers-inventory.js finds
// them inside the image; scripts/playwright-browser-findings.js judges each
// against every Chromium advisory in Trivy's offline database by the Chrome
// release that fixed it. tests/security-gate-baseline.test.js runs the whole
// image check with them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { inventory, browserRoots } = require('../scripts/playwright-browsers-inventory');
const { PACKAGE, TYPE, compareVersions, chromeFixedIn, querySbom, browserReport } = require('../scripts/playwright-browser-findings');
const { imageAssessment } = require('../scripts/security-findings');
const contract = require('../src/services/security-audit-report');

const NOW = Date.parse('2026-11-12T00:00:00Z');

function tree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playwright-browsers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (file, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), typeof body === 'string' ? body : JSON.stringify(body));
  };
  return { dir, write };
}

test('Chrome versions compare by their numbers, part by part', () => {
  assert.equal(compareVersions('157.0.8103.38', '157.0.8103.15'), 1);
  assert.equal(compareVersions('141.0.7390.37', '157.0.8103.38'), -1);
  assert.equal(compareVersions('158.0.8127.18', '158.0.8127.18'), 0);
  assert.equal(compareVersions('100.0.0.9', '99.9.9999.9'), 1, 'numbers, not strings');
});

test('an advisory\'s Chrome fix is read from its description, or it has none', () => {
  assert.equal(chromeFixedIn('Use after free in WebXR in Google Chrome prior to 157.0.8103.38 allowed a remote attacker'), '157.0.8103.38');
  assert.equal(chromeFixedIn('Memory corruption in GPU in Google Chrome on Android prior to 157.0.8103.38 allowed'), '157.0.8103.38');
  assert.equal(chromeFixedIn('Type confusion in V8 in Google Chrome prior to 120.0.6099.62 and ChromeOS prior to 15633.0'), '120.0.6099.62');
  assert.equal(chromeFixedIn('SQLite before 3.25.3, when the FTS3 extension is enabled, encounters an integer overflow'), null);
  assert.equal(chromeFixedIn(undefined), null);
});

test('the inventory finds each Playwright Chromium with the version its own Playwright gives it', (t) => {
  const { dir, write } = tree(t);
  const core = (version, revision, browserVersion) => ({ name: 'playwright-core', version, browsers: [
    { name: 'chromium', revision, browserVersion },
    { name: 'chromium-headless-shell', revision, browserVersion },
    { name: 'ffmpeg', revision: '1013' },
  ] });
  write('lib/@playwright/mcp/package.json', { name: '@playwright/mcp', version: '0.0.85' });
  write('lib/@playwright/mcp/node_modules/playwright-core/package.json', { name: 'playwright-core', version: '1.66.0-alpha-2026-11-09' });
  write('lib/@playwright/mcp/node_modules/playwright-core/browsers.json', core('1.66.0-alpha-2026-11-09', '1254', '158.0.8127.18'));
  for (const name of ['chromium-1254', 'chromium_headless_shell-1254', 'ffmpeg-1013', 'chromium-9999']) {
    fs.mkdirSync(path.join(dir, 'browsers', name), { recursive: true });
  }
  fs.mkdirSync(path.join(dir, 'home'));
  const found = inventory({ env: { PLAYWRIGHT_BROWSERS_PATH: path.join(dir, 'browsers') },
    nodeModules: [path.join(dir, 'lib')], homeRoot: path.join(dir, 'home') });
  // Only this tree's: the fixed roots (/ms-playwright, /root/.cache) are the machine's.
  assert.deepEqual(found.browsers.filter((b) => b.dir.startsWith(dir)).map(({ dir: d, ...rest }) => ({ name: path.basename(d), ...rest })), [
    { name: 'chromium-1254', kind: 'chromium', revision: '1254', version: '158.0.8127.18', installedBy: ['playwright-core@1.66.0-alpha-2026-11-09'] },
    // A revision no Playwright in the image names: found, with no version.
    { name: 'chromium-9999', kind: 'chromium', revision: '9999', version: null, installedBy: [] },
    { name: 'chromium_headless_shell-1254', kind: 'chromium-headless-shell', revision: '1254', version: '158.0.8127.18', installedBy: ['playwright-core@1.66.0-alpha-2026-11-09'] },
  ]);
  // An image without Playwright finds nothing.
  assert.deepEqual(inventory({ env: {}, nodeModules: [path.join(dir, 'none')], homeRoot: path.join(dir, 'none') }).browsers
    .filter((b) => b.dir.startsWith(dir)), []);
});

test('the inventory looks where Playwright keeps browsers, and nowhere it was told not to', () => {
  const roots = browserRoots({ PLAYWRIGHT_BROWSERS_PATH: '/home/node/.cache/ms-playwright', HOME: '/home/node' },
    [{ path: '/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright-core' }], '/nonexistent');
  assert.deepEqual(roots, ['/home/node/.cache/ms-playwright', '/root/.cache/ms-playwright', '/ms-playwright',
    '/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright-core/.local-browsers']);
  assert.ok(!browserRoots({ PLAYWRIGHT_BROWSERS_PATH: '0' }, [], '/nonexistent').includes(path.resolve('0')));
});

const ADVISORIES = { SchemaVersion: 2, Results: [{ Target: 'query (debian 13.0)', Vulnerabilities: [
  { VulnerabilityID: 'CVE-2026-121076', Severity: 'HIGH', References: ['https://crbug.com/1'],
    Description: 'Use after free in WebXR in Google Chrome prior to 157.0.8103.38 allowed a remote attacker.' },
  { VulnerabilityID: 'CVE-2026-100001', Severity: 'CRITICAL', Description: 'Type confusion in V8 in Google Chrome prior to 150.0.7000.1 allowed.' },
  { VulnerabilityID: 'CVE-2026-100001', Severity: 'CRITICAL', Description: 'Type confusion in V8 in Google Chrome prior to 150.0.7000.1 allowed.' },
  { VulnerabilityID: 'CVE-2026-100002', Severity: 'MEDIUM', Description: 'Policy bypass in Google Chrome prior to 157.0.8103.38 allowed.' },
  { VulnerabilityID: 'CVE-2018-20346', Severity: 'HIGH', Description: 'SQLite before 3.25.3, when the FTS3 extension is enabled, overflows.' },
] }] };

function browser(version, extra = {}) {
  return { dir: `/home/node/.cache/ms-playwright/chromium-${version}`, kind: 'chromium', revision: '1', version,
    installedBy: ['playwright-core@1.0.0'], ...extra };
}

test('a browser carries the HIGH and CRITICAL advisories Chrome fixed after its version, each fixed in that release', () => {
  const report = browserReport({ browsers: [browser('141.0.7390.37'), browser('158.0.8127.18')] }, ADVISORIES);
  assert.equal(report.SchemaVersion, 2);
  assert.deepEqual(report.Results.map((r) => [r.Type, r.Target]), [
    [TYPE, '/home/node/.cache/ms-playwright/chromium-141.0.7390.37 (chromium 141.0.7390.37)'],
    [TYPE, '/home/node/.cache/ms-playwright/chromium-158.0.8127.18 (chromium 158.0.8127.18)'],
  ]);
  assert.deepEqual(report.Results[0].Vulnerabilities, [
    { VulnerabilityID: 'CVE-2026-121076', PkgName: PACKAGE, InstalledVersion: '141.0.7390.37', FixedVersion: '157.0.8103.38',
      Severity: 'HIGH', References: ['https://crbug.com/1'], BaselineKey: 'playwright-core@1.0.0' },
    { VulnerabilityID: 'CVE-2026-100001', PkgName: PACKAGE, InstalledVersion: '141.0.7390.37', FixedVersion: '150.0.7000.1',
      Severity: 'CRITICAL', References: [], BaselineKey: 'playwright-core@1.0.0' },
  ], 'once each; no MEDIUM; nothing that names no Chrome release');
  assert.deepEqual(report.Results[1].Vulnerabilities, [], 'a current browser has none');
  // Fixed in exactly its own release: not affected.
  assert.deepEqual(browserReport({ browsers: [browser('157.0.8103.38')] }, ADVISORIES).Results[0].Vulnerabilities, []);
});

test('a browser of unknown version, or an empty advisory list, is an error, never a clean result', () => {
  assert.throws(() => browserReport({ browsers: [browser(null)] }, ADVISORIES), /no version this scan can read/);
  assert.throws(() => browserReport({ browsers: [browser('141.0.7390.37')] }, { SchemaVersion: 2, Results: [] }), /no advisories/);
  assert.throws(() => browserReport({ browsers: [] }, {}), /Invalid Chromium advisory scan/);
});

test('the query asks for Debian\'s chromium at the lowest version, so every advisory comes back', () => {
  const sbom = querySbom();
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.deepEqual(sbom.components.map((c) => c.purl || `${c.type}:${c.name} ${c.version}`), [
    'operating-system:debian 13.0', 'pkg:deb/debian/chromium@1?arch=amd64&distro=debian-13.0',
  ]);
});

test('browser findings gate by their Playwright and fit the audit report', () => {
  const report = browserReport({ browsers: [browser('141.0.7390.37')] }, ADVISORIES);
  const shipped = imageAssessment([report], { component: 'worker', baseline: new Set(['playwright-core@1.0.0']), now: NOW });
  assert.equal(shipped.status, 'existing_findings');
  assert.deepEqual(shipped.blocking, []);
  const introduced = imageAssessment([report], { component: 'worker', baseline: new Set(['playwright-core@0.9.0']), now: NOW });
  assert.equal(introduced.status, 'regression');
  assert.equal(introduced.blocking.length, 2);
  // A browser no Playwright vouches for has no baseline identity: it blocks.
  const unvouched = browserReport({ browsers: [browser('141.0.7390.37', { installedBy: [] })] }, ADVISORIES);
  assert.equal(imageAssessment([unvouched], { component: 'worker', baseline: new Set(['playwright-core@1.0.0']), now: NOW }).status, 'regression');
  // The chromium and headless-shell directories of one install are one finding each.
  const twice = browserReport({ browsers: [browser('141.0.7390.37'), browser('141.0.7390.37', { kind: 'chromium-headless-shell' })] }, ADVISORIES);
  const audit = imageAssessment([twice], { component: 'worker', audit: true, now: NOW });
  assert.equal(audit.findings.length, 2);
  for (const f of audit.findings) assert.deepEqual(contract.finding(f), f, 'a finding the report contract accepts as it is');
});
