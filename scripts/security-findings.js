'use strict';
const fs = require('node:fs');
const exceptions = require('../security/exceptions.json');
function excepted(name, version, ids, now = Date.now(), entries = exceptions, component) {
  return entries.some((e) => e.package === name && e.versions.includes(version)
    && e.ids.some((id) => ids.includes(id)) && e.reason
    && (!e.components || e.components.includes(component))
    && Date.parse(`${e.expires}T00:00:00Z`) > now);
}
function npmFindings(audit, lock, now) {
  if (!audit.metadata?.vulnerabilities || !audit.vulnerabilities || audit.error) throw new Error('Invalid or failed npm audit response');
  const failures = [];
  for (const [name, v] of Object.entries(audit.vulnerabilities)) {
    for (const advisory of v.via.filter((a) => typeof a === 'object' && /^(high|critical)$/.test(a.severity))) {
      const id = advisory.url?.split('/').pop();
      for (const node of v.nodes) {
        const version = lock.packages[node]?.version;
        if (!excepted(name, version, [id], now)) failures.push(`${name}@${version}: ${id}`);
      }
    }
  }
  return [...new Set(failures)];
}
function imageFindings(report, now, component) {
  if (report.SchemaVersion !== 2 || !Array.isArray(report.Results) || report.Results.length === 0) throw new Error('Empty or invalid image scan');
  return report.Results.flatMap((r) => (r.Vulnerabilities || [])
    .filter((v) => /^(HIGH|CRITICAL)$/.test(v.Severity) && v.FixedVersion
      && !excepted(v.PkgName, v.InstalledVersion, [v.VulnerabilityID, ...(v.References || []).map((u) => u.split('/').pop())], now, exceptions, component))
    .map((v) => `${r.Target}: ${v.PkgName}@${v.InstalledVersion}: ${v.VulnerabilityID} (fix ${v.FixedVersion})`));
}
if (require.main === module) {
  try {
    const failures = imageFindings(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), undefined, process.argv[3]);
    if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { excepted, npmFindings, imageFindings };
