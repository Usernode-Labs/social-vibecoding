'use strict';

// Consume the trusted daily workflow's data, never GitHub issues. Existing
// platform-signals owns native request creation, quiet windows and bot limits.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { COMPONENTS, LEVELS, MAX_BYTES, finding, readReport } = require('../security-audit-report');
const DAY = 86400000;
const MAX_AGE = 36 * 3600000;
const WORKFLOW = '.github/workflows/security-audit.yml';
const REPORT_FILE = 'security-audit-report.json';
const PREVIOUS_SQL = `SELECT kind, subject, fixer, first_seen_at FROM platform_signals
  WHERE kind IN ('security', 'security_audit') AND state IN ('pending', 'open', 'clearing') AND app_id = $1`;
let cache = null;

function unzipReport(bytes) {
  if (bytes.length > MAX_BYTES) throw new Error('Oversized security archive');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeroom-security-'));
  try {
    const file = path.join(dir, 'report.zip');
    fs.writeFileSync(file, bytes);
    // execFileSync waits for exit even after a limit is exceeded. unzip handles
    // SIGTERM, so force this disposable child to stop; finally owns cleanup.
    return execFileSync('/usr/bin/unzip', ['-p', file, REPORT_FILE], {
      encoding: 'utf8', maxBuffer: MAX_BYTES, timeout: 10000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function download(location, { fetchImpl = fetch } = {}) {
  const url = new URL(location);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !/(?:^|\.)(?:blob\.core\.windows\.net|actions\.githubusercontent\.com)$/.test(url.hostname)) throw new Error('Unexpected artifact host');
  // No GitHub authorization or cookies are forwarded to the signed storage URL.
  const response = await fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok || !response.body) throw new Error('Security artifact download unavailable');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('Oversized security artifact');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function load(repo, { github = require('../github'), now = Date.now(), fetchImpl, unzip = unzipReport } = {}) {
  const octokit = await github.getReadOctokit(repo.owner);
  const base = { owner: repo.owner, repo: repo.repo };
  const { data } = await octokit.rest.actions.listWorkflowRuns({ ...base, workflow_id: 'security-audit.yml', branch: 'main', per_page: 1 });
  const run = data?.workflow_runs?.[0];
  if (!run) return { reason: 'missing', delay: MAX_AGE };
  const full = `${repo.owner}/${repo.repo}`;
  if (run.path !== WORKFLOW || run.head_branch !== 'main' || !['schedule', 'workflow_dispatch'].includes(run.event)
    || run.head_repository?.full_name?.toLowerCase() !== full.toLowerCase()
    || !/^[a-f0-9]{40}$/.test(run.head_sha || '') || !Number.isSafeInteger(run.id) || run.id <= 0
    || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error('Untrusted security workflow');
  const ref = await octokit.rest.git.getRef({ ...base, ref: 'heads/main' });
  if (run.status !== 'completed') return { reason: 'running', delay: 3600000, run };
  const key = `${full}:${run.id}:${run.run_attempt}`;
  let report = cache?.key === key ? cache.report : null;
  if (!report) {
    const listed = await octokit.rest.actions.listWorkflowRunArtifacts({ ...base, run_id: run.id, per_page: 100 });
    const artifacts = (listed.data?.artifacts || []).filter((a) => a.name === `homeroom-security-audit-${run.run_attempt}` && !a.expired);
    if (artifacts.length !== 1) throw new Error('Security report artifact unavailable');
    const artifact = artifacts[0];
    if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0 || !Number.isFinite(artifact.size_in_bytes)
      || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > MAX_BYTES
      || (artifact.workflow_run && (artifact.workflow_run.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha))) {
      throw new Error('Invalid security artifact identity');
    }
    const redirect = await octokit.rest.actions.downloadArtifact({ ...base, artifact_id: artifact.id,
      archive_format: 'zip', request: { redirect: 'manual' } });
    if (redirect.status !== 302 || !redirect.headers?.location) throw new Error('Security artifact redirect unavailable');
    const bytes = await download(redirect.headers.location, { fetchImpl });
    report = readReport(unzip(bytes), { repository: full, revision: run.head_sha,
      runId: run.id, runAttempt: run.run_attempt });
    cache = { key, report };
  }
  const ages = [report.generatedAt, ...report.components.map((c) => c.checkedAt)].map((at) => now - Date.parse(at));
  if (ages.some((age) => age < -300000)) throw new Error('Invalid security report clock');
  if (ages.some((age) => age > MAX_AGE)) return { reason: 'stale', delay: 0, run };
  return { report, run, complete: report.complete && run.conclusion === 'success' && ref.data?.object?.sha === run.head_sha,
    reason: !report.complete || run.conclusion !== 'success' ? 'incomplete' : null, delay: 0 };
}

const WHERE = {
  platform: 'Dockerfile.kubernetes', standalone: 'Dockerfile', worker: 'worker/Dockerfile',
  capture: 'capture/Dockerfile', starter: 'src/services/template.js',
};

// One finding per advisory, component, package and version: a repeat (a
// retained finding seen again) keeps the higher severity, any published fix
// and the earlier exception expiry.
function mergeFindings(raw) {
  const byIdentity = new Map();
  for (const value of raw) {
    if (!COMPONENTS.includes(value.component)) throw new Error('Invalid retained security component');
    const f = { ...finding(value), component: value.component };
    const key = `${f.id}:${f.component}:${f.package}:${f.version}`;
    const old = byIdentity.get(key);
    byIdentity.set(key, old ? { ...f,
      severity: LEVELS[Math.max(LEVELS.indexOf(old.severity), LEVELS.indexOf(f.severity))],
      fixedVersion: f.fixedVersion || old.fixedVersion,
      ...(old.acceptedUntil && (!f.acceptedUntil || old.acceptedUntil < f.acceptedUntil) ? { acceptedUntil: old.acceptedUntil } : {}),
    } : f);
  }
  return [...byIdentity.values()];
}

// The upgrades: packages linked by the advisories they share, each with its
// findings. One Chromium release fixes a dozen advisories, and a request per
// advisory filed a dozen requests for one bump (17 on 11 Nov 2026); Debian's
// openssl and libssl3 come from one source package and share every advisory,
// so they are one upgrade too. Pure.
function upgradesOf(findings) {
  const parent = new Map();
  const root = (p) => {
    let r = p;
    while (parent.get(r) !== r) r = parent.get(r);
    for (let x = p; x !== r;) { const next = parent.get(x); parent.set(x, r); x = next; }
    return r;
  };
  const byAdvisory = new Map();
  for (const f of findings) {
    if (!parent.has(f.package)) parent.set(f.package, f.package);
    const first = byAdvisory.get(f.id);
    if (first === undefined) byAdvisory.set(f.id, f.package);
    else parent.set(root(f.package), root(first));
  }
  const groups = new Map();
  for (const f of findings) {
    const r = root(f.package);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(f);
  }
  return [...groups.values()].map((list) => {
    const sorted = list.sort((a, b) => `${a.package}:${a.component}:${a.version}:${a.id}`.localeCompare(`${b.package}:${b.component}:${b.version}:${b.id}`));
    return { packages: [...new Set(sorted.map((f) => f.package))].sort(), findings: sorted };
  });
}

// Which earlier request an upgrade continues: the oldest one that named any
// of its packages, so an upgrade that gains a package keeps its request and
// its target date. A key two upgrades both claim (one upgrade split in two)
// stays with the first, and the other is new. Pure.
function keysFor(upgrades, prior) {
  const used = new Set();
  const oldest = [...prior.values()].sort((a, b) => new Date(a.first_seen_at) - new Date(b.first_seen_at));
  return upgrades.map((u) => {
    const named = new Set(u.packages);
    const old = oldest.find((r) => !used.has(r.subject.upgrade) && (r.subject.packages || []).some((p) => named.has(p)));
    let key = old ? old.subject.upgrade : u.packages[0];
    if (used.has(key)) key = u.packages.find((p) => !used.has(p)) || `${u.packages[0]}#${used.size}`;
    used.add(key);
    return { key, old: old && old.subject.upgrade === key ? old : null };
  });
}

function listWords(list) {
  return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// What to upgrade, one line per installed version that has a published fix:
// the public tier, which the bot's request on the board shows. The shared
// evidence scrubber removes @mentions, so an npm scope is spelled out as
// typed data and the bot still knows exactly which package. Pure.
function upgradeLines(findings) {
  const byVersion = new Map();
  for (const f of findings) {
    if (!f.fixedVersion) continue;
    const key = `${f.package}\u0000${f.version}`;
    if (!byVersion.has(key)) byVersion.set(key, { package: f.package, version: f.version, components: new Set(), fixes: new Set() });
    const v = byVersion.get(key);
    v.components.add(f.component);
    v.fixes.add(f.fixedVersion);
  }
  const packageName = (name) => name.replace(/^@([^/]+)\//, 'npm scope $1, package ');
  return [...byVersion.values()].map((v) => `${listWords([...v.components].sort())}: ${packageName(v.package)} ${v.version}, `
    + `upgrade to ${[...v.fixes].sort().join(' or ')} or later.`);
}

const LISTED_ADVISORIES = 30;

// The request's private lines: one per installed version, with the
// components that run it, the fix and its advisories. Pure.
function privateLines(findings) {
  const byVersion = new Map();
  for (const f of findings) {
    const key = `${f.package}\u0000${f.version}`;
    if (!byVersion.has(key)) byVersion.set(key, { package: f.package, version: f.version, components: new Set(), fixes: new Set(), ids: new Map(), until: null });
    const v = byVersion.get(key);
    v.components.add(f.component);
    if (f.fixedVersion) v.fixes.add(f.fixedVersion);
    const was = v.ids.get(f.id);
    if (!was || LEVELS.indexOf(f.severity) > LEVELS.indexOf(was)) v.ids.set(f.id, f.severity);
    if (f.acceptedUntil && (!v.until || f.acceptedUntil < v.until)) v.until = f.acceptedUntil;
  }
  return [...byVersion.values()].map((v) => {
    const ids = [...v.ids].sort((a, b) => LEVELS.indexOf(b[1]) - LEVELS.indexOf(a[1]) || a[0].localeCompare(b[0]));
    const listed = ids.slice(0, LISTED_ADVISORIES).map(([id, severity]) => `${id} (${severity})`).join(', ');
    const more = ids.length > LISTED_ADVISORIES ? ` and ${ids.length - LISTED_ADVISORIES} more` : '';
    const fix = v.fixes.size ? `fixed in ${[...v.fixes].sort().join(' or ')}` : 'no published fix';
    const until = v.until ? `; reviewed exception until ${v.until}` : '';
    return `${v.package} ${v.version} in ${listWords([...v.components].sort())}, ${fix}${until}: ${listed}${more}.`;
  });
}

function itemsFrom(result, previous, app, now) {
  const security = previous.filter((r) => r.kind === 'security' && r.subject);
  const prior = new Map(security.filter((r) => typeof r.subject.upgrade === 'string').map((r) => [r.subject.upgrade, r]));
  // Requests filed per advisory before findings were grouped by upgrade:
  // what they knew is kept (the audit may be incomplete the first time) and
  // so is the target they set.
  const legacyDue = new Map(security.filter((r) => typeof r.subject.advisory === 'string' && Number.isFinite(Date.parse(r.subject.dueAt)))
    .map((r) => [r.subject.advisory, Date.parse(r.subject.dueAt)]));
  const raw = [];
  // Missing/incomplete/stale data retains every known finding, including rows
  // already clearing. Re-raising them cancels an unconfirmed resolution.
  if (!result.complete) for (const row of security) raw.push(...(row.subject.findings || []));
  for (const c of result.report?.components || []) for (const f of c.findings) raw.push({ ...f, component: c.component });
  const upgrades = upgradesOf(mergeFindings(raw));
  const keys = keysFor(upgrades, prior);
  const auditRun = result.run ? `https://github.com/${result.report?.repository || 'Usernode-Labs/social-vibecoding'}/actions/runs/${result.run.id}` : null;
  const items = [];
  upgrades.forEach(({ packages, findings }, i) => {
    const { key, old } = keys[i];
    const severity = LEVELS[Math.max(...findings.map((f) => LEVELS.indexOf(f.severity)))];
    const first = old?.first_seen_at ? new Date(old.first_seen_at).getTime() : now;
    let due = first + (severity === 'CRITICAL' ? DAY : 7 * DAY);
    if (Number.isFinite(Date.parse(old?.subject?.dueAt))) due = Math.min(due, Date.parse(old.subject.dueAt));
    for (const f of findings) {
      if (f.acceptedUntil) due = Math.min(due, Date.parse(f.acceptedUntil));
      if (legacyDue.has(f.id)) due = Math.min(due, legacyDue.get(f.id));
    }
    const fixer = findings.some((f) => f.fixedVersion) ? 'bot' : 'person';
    const components = [...new Set(findings.map((f) => f.component))].sort();
    // An npm scope's @ would read as a mention in a title and is scrubbed
    // from a body, so the words name a package without it; the public lines
    // spell it out exactly.
    const named = (name) => name.replace(/^@/, '');
    // The key keeps an earlier request's identity, and may name a package
    // the images no longer have (Debian 12's libperl5.36, kept by the Perl
    // 5.40 group through perl and perl-base): the title names one found now.
    const head = packages.includes(key) ? key : packages[0];
    const lead = packages.length > 1 ? `${named(head)} and ${packages.length - 1} related package${packages.length > 2 ? 's' : ''}` : named(head);
    const where = listWords(components);
    const title = `Upgrade ${lead} in ${where}`;
    // The title counts as a change, so a request filed under an old one is
    // rewritten with the new.
    const materialKey = createHash('sha256').update(JSON.stringify({ findings, due, fixer, title })).digest('hex');
    items.push({ kind: 'security', key, appId: app.id, fixer, title,
      subject: { upgrade: key, packages, severity, findings, dueAt: new Date(due).toISOString(), materialKey,
        publishedKey: old?.subject?.publishedKey, publishedFixer: old?.subject?.publishedFixer,
        noFile: !['HIGH', 'CRITICAL'].includes(severity) },
      // The summary, the done line and the public lines are what the bot's
      // upgrade request on the board says, so they name what to upgrade and
      // nothing else; the advisories, the severity and the target are in the
      // private tier, which only the private request shows.
      summary: `Homeroom's ${where} ${components.length === 1 ? 'image runs' : 'images run'} versions of ${listWords(packages.map(named))} that have newer releases to move to.`,
      done: 'A complete current audit no longer finds the old versions in any of Homeroom\'s components.',
      evidence: { lines: upgradeLines(findings), where: components.map((c) => WHERE[c]) },
      evidencePrivate: { lines: [
        `Severity: ${severity}. Remediation target: ${new Date(due).toISOString().slice(0, 10)}${due < now ? ' (overdue)' : ''}.`,
        result.complete ? 'The audit is complete.' : 'The audit is not complete: known findings are kept until a complete current audit can confirm resolution.',
        ...privateLines(findings),
        ...(auditRun ? [`Audit run: ${auditRun}.`] : []),
      ] } });
  });
  const health = previous.find((r) => r.kind === 'security_audit');
  let delay = result.delay || 0;
  if (result.reason === 'running' && Number.isFinite(Date.parse(result.run?.run_started_at))) {
    const first = health?.first_seen_at ? new Date(health.first_seen_at).getTime() : now;
    delay = Math.max(0, Date.parse(result.run.run_started_at) + 3600000 - first);
  }
  if (result.reason) items.push({ kind: 'security_audit', key: 'unavailable', appId: app.id, fixer: 'person',
    title: 'Homeroom security audit needs attention', fileAfterMs: delay,
    subject: { materialKey: `${result.reason}:${result.run?.id || ''}:${result.run?.run_attempt || ''}`,
      publishedKey: health?.subject?.publishedKey },
    summary: 'The security audit cannot confirm the current dependency state. Existing remediation requests stay open.',
    done: 'A complete successful security audit is available again.',
    evidence: { lines: [`Assessment state: ${result.reason}.`], where: ['.github/workflows/security-audit.yml'] } });
  return { items, ok: new Set(result.complete ? ['security', 'security_audit'] : ['security_audit']) };
}

async function run(pool, { now = Date.now(), github, fetchImpl, unzip } = {}) {
  const { rows: [app] } = await pool.query('SELECT id, repo_url, github_repo_url, main_sha FROM apps WHERE self_hosted = TRUE ORDER BY id LIMIT 1');
  if (!app) return { items: [], ok: new Set() };
  const { rows: previous } = await pool.query(PREVIOUS_SQL, [app.id]);
  const repo = require('../repo-ref').parse(app.github_repo_url || app.repo_url);
  if (!repo || repo.host !== 'github') return itemsFrom({ reason: 'source_unavailable', delay: 0 }, previous, app, now);
  if (!require('../github-budget').budgetAllows('background')) throw new Error('Security audit read budget unavailable');
  let result;
  try {
    result = await load(repo, { github, now, fetchImpl, unzip });
    result.complete = result.complete && app.main_sha === result.run?.head_sha;
  } catch { result = { reason: 'read_failed', delay: 0 }; }
  return itemsFrom(result, previous, app, now);
}

module.exports = { run, load, itemsFrom, download, unzipReport, MAX_AGE, resetCache: () => { cache = null; } };
