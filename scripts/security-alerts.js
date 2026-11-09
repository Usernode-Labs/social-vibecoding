'use strict';
// Only the trusted daily/manual audit publishes issues. PR scanner jobs have
// no issue-write token. --dry-run inspects local reports without network I/O.
const fs = require('node:fs');
const path = require('node:path');
const COMPONENTS = ['platform', 'standalone', 'worker', 'capture', 'starter'];
const LABEL = 'security-audit';
const BEGIN = '<!-- security-audit:begin -->';
const END = '<!-- security-audit:end -->';
const LEVELS = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const IMAGE = /^(?:sha256:[a-f0-9]{64}|ghcr\.io\/[a-z0-9._/-]+@sha256:[a-f0-9]{64})$/;
const marker = (id) => `<!-- usernode-security-alert:${id} -->`;
const inline = (value) => String(value || '').replace(/[\r\n]/g, ' ').replace(/[\\`*_[\]<>|]/g, '\\$&');
function validFinding(f) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,149}$/.test(f.id || '') && typeof f.package === 'string'
    && f.package && typeof f.version === 'string' && f.version && LEVELS.includes(f.severity)
    && (!f.acceptedUntil || (/^\d{4}-\d{2}-\d{2}$/.test(f.acceptedUntil) && Number.isFinite(Date.parse(f.acceptedUntil))));
}

function readAssessments(dir, { revision, runId, runAttempt } = {}) {
  const reports = new Map();
  const errors = [];
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name === 'assessment.json') {
        try {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (data.version !== 1 || !COMPONENTS.includes(data.component) || reports.has(data.component)
            || data.mode !== 'audit' || data.complete !== true || !['clean', 'findings'].includes(data.status)
            || !Array.isArray(data.findings) || !IMAGE.test(data.image || '')
            || (data.status === 'clean' && data.findings.length !== 0)
            || !Number.isFinite(Date.parse(data.checkedAt))
            || (revision && data.revision !== revision) || (runId && data.runId !== runId)
            || (runAttempt && data.runAttempt !== runAttempt)) throw new Error('Incomplete or mismatched audit');
          for (const f of data.findings) {
            if (!validFinding(f)) throw new Error('Invalid finding');
          }
          reports.set(data.component, data);
        } catch (err) { errors.push(`${file}: ${err.message}`); }
      }
    }
  }
  if (fs.existsSync(dir)) walk(dir);
  for (const component of COMPONENTS) if (!reports.has(component)) errors.push(`${component}: assessment unavailable`);
  return { reports: [...reports.values()], complete: errors.length === 0, errors };
}

function alertPlan(audit, issues, { now = new Date(), assignee = '', runUrl = '' } = {}) {
  const managed = new Map();
  for (const issue of issues) {
    const id = /<!-- usernode-security-alert:([A-Za-z0-9._:-]+) -->/.exec(issue.body || '')?.[1];
    if (id && !issue.pull_request) managed.set(id, issue);
  }
  const groups = new Map();
  for (const report of audit.reports) for (const finding of report.findings) {
    if (!['HIGH', 'CRITICAL'].includes(finding.severity) && !managed.has(finding.id)) continue;
    const list = groups.get(finding.id) || [];
    list.push({ ...finding, component: report.component, image: report.image });
    groups.set(finding.id, list);
  }
  const actions = [];
  for (const [id, observed] of groups) {
    const issue = managed.get(id);
    let findings = observed;
    if (issue && !audit.complete) {
      // Retain the union across successive partial audits. Only a complete
      // audit can remove an earlier affected component/package/version.
      const encoded = /<!-- coverage:([A-Za-z0-9+/=]+) -->/.exec(issue.body || '')?.[1];
      if (!encoded) throw new Error(`Missing retained coverage for ${id}; run a complete audit`);
      const previous = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      if (!Array.isArray(previous) || previous.some((f) => !validFinding(f) || f.id !== id
        || !COMPONENTS.includes(f.component) || !IMAGE.test(f.image || ''))) throw new Error(`Invalid retained coverage for ${id}`);
      const union = new Map();
      for (const f of [...previous, ...observed]) {
        const key = `${f.component}:${f.package}:${f.version}`;
        const old = union.get(key);
        union.set(key, old && LEVELS.indexOf(old.severity) > LEVELS.indexOf(f.severity) ? old : f);
      }
      findings = [...union.values()];
    }
    const recorded = /<!-- first-seen:([^ ]+) -->/.exec(issue?.body || '')?.[1];
    const firstSeen = recorded && Number.isFinite(Date.parse(recorded)) && Date.parse(recorded) <= now.getTime()
      ? recorded : now.toISOString();
    const severity = LEVELS[Math.max(...findings.map((f) => LEVELS.indexOf(f.severity)))];
    let due = Date.parse(firstSeen) + (severity === 'CRITICAL' ? 1 : 7) * 86400000;
    for (const f of findings) if (f.acceptedUntil) due = Math.min(due, Date.parse(`${f.acceptedUntil}T00:00:00Z`));
    for (const match of (issue?.body || '').matchAll(/<!-- due-at:([^ ]+) -->/g)) {
      if (Number.isFinite(Date.parse(match[1]))) due = Math.min(due, Date.parse(match[1]));
    }
    const coverage = Buffer.from(JSON.stringify(findings)).toString('base64');
    const assigned = (issue?.assignees || []).map((a) => a.login).filter((login) => /^[A-Za-z0-9-]{1,39}$/.test(login));
    const owner = assigned.length ? assigned.map((login) => `@${login}`).join(', ')
      : assignee ? `@${assignee}` : 'Repository maintainers; assign during triage';
    const lines = [BEGIN, marker(id), `<!-- first-seen:${firstSeen} -->`, `<!-- due-at:${new Date(due).toISOString()} -->`,
      `<!-- coverage:${coverage} -->`, `Severity: **${severity}**`,
      `Owner: ${owner}`,
      `First seen: ${firstSeen}`, `Last seen: ${now.toISOString()}`,
      `Remediation target: ${new Date(due).toISOString().slice(0, 10)}${due < now.getTime() ? ' **OVERDUE**' : ''}`,
      ...(!audit.complete ? ['', '**Audit incomplete: affected coverage retains earlier observations until every component is reassessed.**'] : []),
      '', '| Component | Package | Installed | Fixed |', '| --- | --- | --- | --- |'];
    for (const f of findings) lines.push(`| ${f.component} | ${inline(f.package)} | ${inline(f.version)} | ${inline(f.fixedVersion || 'No fix published')} |`);
    for (const f of findings) {
      lines.push('', `${f.component} image: ${inline(f.image)}`);
      if (f.acceptedUntil) lines.push(`Reviewed exception until ${inline(f.acceptedUntil)}: ${inline(f.acceptanceReason)}`);
    }
    if (runUrl) lines.push('', `[Audit evidence](${runUrl})`);
    lines.push('', 'Existing findings are tracked here without stopping unrelated releases. Triage urgent exposure as an incident.', END);
    const block = lines.join('\n');
    const oldBody = issue?.body || '';
    const body = oldBody.includes(BEGIN) && oldBody.includes(END)
      ? oldBody.slice(0, oldBody.indexOf(BEGIN)) + block + oldBody.slice(oldBody.indexOf(END) + END.length)
      : `${block}\n\nTriage notes:\n${oldBody}`;
    actions.push({ operation: issue ? 'update' : 'create', number: issue?.number,
      payload: { title: `[Security] ${id} (${severity})`, body, state: 'open',
        ...(!issue ? { labels: [LABEL] } : {}), ...(assignee && !issue?.assignees?.length ? { assignees: [assignee] } : {}) } });
  }
  // A partial/failed scan can discover findings, but cannot prove resolution.
  if (audit.complete) for (const [id, issue] of managed) {
    if (!groups.has(id) && issue.state === 'open') actions.push({ operation: 'close', number: issue.number,
      payload: { state: 'closed', state_reason: 'completed' } });
  }
  return actions;
}

async function publishAlerts(audit, { repo, revision, runId, assignee = '', request, now = new Date() }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[a-f0-9]{40}$/.test(revision)
    || !/^\d+$/.test(runId) || (assignee && !/^[A-Za-z0-9-]{1,39}$/.test(assignee))) throw new Error('Invalid alert publisher identity');
  const root = `/repos/${repo}`;
  const main = await request('GET', `${root}/git/ref/heads/main`);
  if (main.object?.sha !== revision) throw new Error('Audit revision is stale; rerun on current main before publishing');
  try { await request('GET', `${root}/labels/${LABEL}`); }
  catch (err) {
    if (err.status !== 404) throw err;
    await request('POST', `${root}/labels`, { name: LABEL, color: 'b60205', description: 'Tracked image vulnerability findings' });
  }
  const issues = [];
  for (let page = 1; ; page += 1) {
    const batch = await request('GET', `${root}/issues?labels=${LABEL}&state=all&per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('Invalid GitHub issue listing');
    issues.push(...batch);
    if (batch.length < 100) break;
  }
  const actions = alertPlan(audit, issues, { now, assignee, runUrl: `https://github.com/${repo}/actions/runs/${runId}` });
  for (const action of actions) await request(action.operation === 'create' ? 'POST' : 'PATCH',
    action.operation === 'create' ? `${root}/issues` : `${root}/issues/${action.number}`, action.payload);
  return actions;
}

async function main() {
  const [dir, flag] = process.argv.slice(2);
  if (!dir) throw new Error('Usage: security-alerts.js REPORT_DIR [--dry-run]');
  const audit = readAssessments(dir, { revision: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT });
  if (flag === '--dry-run') { console.log(JSON.stringify({ complete: audit.complete, errors: audit.errors, actions: alertPlan(audit, []) }, null, 2)); return; }
  if (!['schedule', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME) || process.env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Alert writes are allowed only from the main-branch scheduled/manual audit');
  }
  if (!process.env.GH_TOKEN) throw new Error('Missing GitHub issue-write token');
  const request = async (method, endpoint, body) => {
    const response = await fetch(`https://api.github.com${endpoint}`, { method,
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    if (!response.ok) { const err = new Error(`GitHub ${method} ${endpoint}: ${response.status}`); err.status = response.status; throw err; }
    return response.json();
  };
  const actions = await publishAlerts(audit, { repo: process.env.GITHUB_REPOSITORY, revision: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID, assignee: process.env.SECURITY_ALERT_ASSIGNEE || '', request });
  console.log(`Security audit: ${actions.length} issue update(s); complete=${audit.complete}`);
  if (!audit.complete) { console.error(audit.errors.join('\n')); process.exitCode = 1; }
}
if (require.main === module) main().catch((err) => { console.error(err.message); process.exitCode = 1; });
module.exports = { readAssessments, alertPlan, publishAlerts };
