'use strict';
const fs = require('node:fs');
const exceptions = require('../security/exceptions.json');
function excepted(name, version, ids, now = Date.now(), entries = exceptions, component) {
  return entries.some((e) => e.package === name && e.versions.includes(version)
    && e.ids.some((id) => ids.includes(id)) && e.reason
    && (!e.components || e.components.includes(component))
    && Date.parse(`${e.expires}T00:00:00Z`) > now);
}

// A gate blocks only what a change introduces. A HIGH or CRITICAL finding the
// exceptions do not cover is `blocking` when its package, at that exact
// version, is not in the baseline (what is live, or a pull request's base),
// and `preexisting` when the baseline already ships it: a newly published
// advisory on a package production already runs is reported, not a reason to
// stop every release. With no baseline (`null`) every finding blocks.
function split(findings, baseline) {
  const blocking = [];
  const preexisting = [];
  for (const f of findings) (baseline && baseline.has(`${f.name}@${f.version}`) ? preexisting : blocking).push(f.text);
  return { blocking: [...new Set(blocking)], preexisting: [...new Set(preexisting)] };
}

// Every package@version a lockfile installs.
function lockPackages(lock) {
  const set = new Set();
  for (const [key, entry] of Object.entries(lock?.packages || {})) {
    if (!key || !entry?.version) continue;
    set.add(`${key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)}@${entry.version}`);
  }
  return set;
}

// Every package@version an SPDX SBOM (BuildKit's attestation) lists.
function sbomPackages(sbom) {
  if (!sbom?.spdxVersion || !Array.isArray(sbom.packages) || !sbom.packages.length) throw new Error('Missing or empty baseline SPDX SBOM');
  return new Set(sbom.packages.filter((p) => p.name && p.versionInfo).map((p) => `${p.name}@${p.versionInfo}`));
}

function npmGate(audit, lock, { now, baseline = null } = {}) {
  if (!audit.metadata?.vulnerabilities || !audit.vulnerabilities || audit.error) throw new Error('Invalid or failed npm audit response');
  const findings = [];
  for (const [name, v] of Object.entries(audit.vulnerabilities)) {
    for (const advisory of v.via.filter((a) => typeof a === 'object' && /^(high|critical)$/.test(a.severity))) {
      const id = advisory.url?.split('/').pop();
      for (const node of v.nodes) {
        const version = lock.packages[node]?.version;
        if (!excepted(name, version, [id], now)) findings.push({ name, version, text: `${name}@${version}: ${id}` });
      }
    }
  }
  return split(findings, baseline);
}
function npmFindings(audit, lock, now) {
  return npmGate(audit, lock, { now }).blocking;
}

function imageGate(report, { now, component, baseline = null } = {}) {
  if (report.SchemaVersion !== 2 || !Array.isArray(report.Results) || report.Results.length === 0) throw new Error('Empty or invalid image scan');
  const findings = report.Results.flatMap((r) => (r.Vulnerabilities || [])
    .filter((v) => /^(HIGH|CRITICAL)$/.test(v.Severity) && v.FixedVersion
      && !excepted(v.PkgName, v.InstalledVersion, [v.VulnerabilityID, ...(v.References || []).map((u) => u.split('/').pop())], now, exceptions, component))
    .map((v) => ({ name: v.PkgName, version: v.InstalledVersion, text: `${r.Target}: ${v.PkgName}@${v.InstalledVersion}: ${v.VulnerabilityID} (fix ${v.FixedVersion})` })));
  return split(findings, baseline);
}
function imageFindings(report, now, component) {
  return imageGate(report, { now, component }).blocking;
}

// GitHub Actions annotations. The platform reads the first error annotation of
// a failed release job to say why a merged change has not gone live, so an
// error's message names the finding itself.
function escape(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function report(label, { blocking, preexisting }, { log = console.log, baselineName = 'the baseline' } = {}) {
  for (const text of blocking) log(`::error title=${escape(`Security gate: ${label}`)}::${escape(text)}`);
  for (const text of preexisting) log(`::warning title=${escape(`Already shipped: ${label}`)}::${escape(`${text} (already in ${baselineName}; not introduced by this change)`)}`);
  if (process.env.GITHUB_STEP_SUMMARY && (blocking.length || preexisting.length)) {
    const lines = [`### ${label}`, ''];
    if (blocking.length) lines.push('**Blocking: introduced by this change**', '', ...blocking.map((t) => `- ${t}`), '');
    if (preexisting.length) lines.push(`**Already shipped in ${baselineName}: reported, not blocking**`, '', ...preexisting.map((t) => `- ${t}`), '');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
}

if (require.main === module) {
  // usage: security-findings.js <trivy-report.json> <component> [<baseline-spdx.json>]
  try {
    const [file, component, baselineFile] = process.argv.slice(2);
    const baseline = baselineFile ? sbomPackages(JSON.parse(fs.readFileSync(baselineFile, 'utf8'))) : null;
    const result = imageGate(JSON.parse(fs.readFileSync(file, 'utf8')), { component, baseline });
    report(`${component} image`, result, { baselineName: baseline ? 'the live image' : 'the baseline' });
    if (result.blocking.length) { console.error(result.blocking.join('\n')); process.exitCode = 1; }
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { excepted, npmFindings, imageFindings, npmGate, imageGate, lockPackages, sbomPackages, report };
