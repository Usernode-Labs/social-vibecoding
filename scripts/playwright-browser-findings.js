'use strict';
// Known vulnerabilities of the Chromium builds Playwright installed in an
// image (scripts/playwright-browsers-inventory.js finds them). Trivy matches
// distro packages and lockfiles; a downloaded browser is neither, so the
// image scan alone never saw one (Chromium 141 in the worker image, a year).
//
// Trivy's own offline database already holds every Chromium advisory Debian
// tracks, and each says which Chrome release fixed it ("... in Google Chrome
// prior to 157.0.8103.38 allowed ..."). So the scan asks it once for all of
// them (--query: a one-package SBOM, Debian's chromium at version 1) and
// keeps, for each browser, those whose Chrome fix is later than the browser's
// own version (--report). Debian's own fix versions never decide: the
// browser is Google's build, not Debian's package. An advisory that names no
// Chrome release (a bundled library's, written another way) is left out.
//
// Only HIGH and CRITICAL advisories are kept: they are the ones that file a
// request or gate a release, and a browser a dozen releases behind matches
// thousands of advisories (Chromium 141: 3,953, of them 1,899 HIGH or
// CRITICAL), which would push an image's assessment past the report's 1 MB.
//
// The result is an ordinary Trivy-shaped report, so the findings flow
// through security-findings.js like any other: the audit lists them, and the
// release gate blocks a fixed HIGH or CRITICAL one unless the baseline
// installs the same Playwright (its playwright-core@version, in the SBOM).
const fs = require('node:fs');

const PACKAGE = 'playwright-chromium';
const TYPE = 'playwright-browser';
// Debian's current stable: the longest-supported Chromium advisory list.
const DISTRO = { name: 'debian', version: '13.0', purl: 'debian-13.0' };
const VERSION = /^\d+(?:\.\d+){3}$/;

// Dotted numeric versions; a missing part is 0.
function compareVersions(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// The Chrome release that fixed an advisory, from its description.
function chromeFixedIn(description) {
  const match = /Google Chrome[^.]*?prior to (\d+(?:\.\d+){3})\b/.exec(String(description || ''));
  return match ? match[1] : null;
}

function browsersOf(inventory) {
  const browsers = Array.isArray(inventory?.browsers) ? inventory.browsers : [];
  for (const b of browsers) {
    if (!b || !VERSION.test(String(b.version || ''))) {
      throw new Error(`A Playwright browser in the image has no version this scan can read (${b?.dir || 'unknown directory'})`);
    }
  }
  return browsers;
}

// The one-package SBOM that asks Trivy for every Debian Chromium advisory.
function querySbom() {
  return {
    bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: { component: { type: 'container', name: 'playwright-browsers', 'bom-ref': 'root' } },
    components: [
      { type: 'operating-system', name: DISTRO.name, version: DISTRO.version, 'bom-ref': 'os' },
      { type: 'library', name: 'chromium', version: '1',
        purl: `pkg:deb/debian/chromium@1?arch=amd64&distro=${DISTRO.purl}`, 'bom-ref': 'chromium' },
    ],
    dependencies: [{ ref: 'root', dependsOn: ['os'] }, { ref: 'os', dependsOn: ['chromium'] }],
  };
}

function browserReport(inventory, advisories) {
  if (advisories?.SchemaVersion !== 2 || !Array.isArray(advisories.Results)) throw new Error('Invalid Chromium advisory scan');
  const known = new Map();
  for (const result of advisories.Results) for (const v of result.Vulnerabilities || []) {
    const fixedIn = chromeFixedIn(v.Description);
    if (!v.VulnerabilityID || !fixedIn || !/^(HIGH|CRITICAL)$/.test(v.Severity || '') || known.has(v.VulnerabilityID)) continue;
    known.set(v.VulnerabilityID, { id: v.VulnerabilityID, fixedIn, severity: v.Severity, references: v.References || [] });
  }
  if (!known.size) throw new Error('The Chromium advisory scan returned no advisories');
  return {
    SchemaVersion: 2,
    Results: browsersOf(inventory).map((browser) => ({
      Target: `${browser.dir} (${browser.kind} ${browser.version})`,
      Class: 'custom',
      Type: TYPE,
      Vulnerabilities: [...known.values()]
        .filter((a) => compareVersions(a.fixedIn, browser.version) > 0)
        .map((a) => ({
          VulnerabilityID: a.id, PkgName: PACKAGE, InstalledVersion: browser.version,
          FixedVersion: a.fixedIn, Severity: a.severity, References: a.references,
          // The gate's baseline identity: the Playwright that installed it.
          BaselineKey: browser.installedBy?.[0] || null,
        })),
    })),
  };
}

if (require.main === module) {
  try {
    const [operation, inventoryFile, second, third] = process.argv.slice(2);
    const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8') || '{}');
    if (operation === '--query') {
      // usage: --query <inventory.json> <query.cdx.json>; prints the browser count.
      const browsers = browsersOf(inventory);
      if (browsers.length) fs.writeFileSync(second, JSON.stringify(querySbom()));
      console.log(browsers.length);
    } else if (operation === '--report') {
      // usage: --report <inventory.json> <advisories.json> <browser-vulnerabilities.json>
      fs.writeFileSync(third, JSON.stringify(browserReport(inventory, JSON.parse(fs.readFileSync(second, 'utf8')))));
    } else {
      throw new Error('usage: playwright-browser-findings.js --query|--report ...');
    }
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { PACKAGE, TYPE, compareVersions, chromeFixedIn, querySbom, browserReport };
