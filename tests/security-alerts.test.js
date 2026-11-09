'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readAssessments, alertPlan, publishAlerts } = require('../scripts/security-alerts');
const NOW = new Date('2026-11-09T15:00:00Z');
const REVISION = 'a'.repeat(40);
const RUN = '123';
const COMPONENTS = ['platform', 'standalone', 'worker', 'capture', 'starter'];
const FINDING = { id: 'CVE-2026-78661', package: 'golang.org/x/net', version: 'v0.59.0', fixedVersion: '0.62.0', severity: 'HIGH' };
const report = (component, findings = []) => ({ version: 1, component, mode: 'audit', complete: true,
  revision: REVISION, runId: RUN, runAttempt: '1', checkedAt: NOW.toISOString(), image: `sha256:${'b'.repeat(64)}`,
  status: findings.length ? 'findings' : 'clean', findings });
const full = (findings = []) => ({ complete: true, reports: COMPONENTS.map((c) => report(c, c === 'standalone' ? findings : [])) });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-alerts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(dir, data) {
  const folder = path.join(dir, data.component);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'assessment.json'), JSON.stringify(data));
}

test('only five complete current same-run audit reports can establish resolution', (t) => {
  const dir = fixture(t);
  for (const component of COMPONENTS) write(dir, report(component));
  const read = () => readAssessments(dir, { revision: REVISION, runId: RUN, runAttempt: '1' });
  assert.equal(read().complete, true);
  for (const change of [
    { complete: false, status: 'unavailable' }, { mode: 'regression' }, { revision: 'c'.repeat(40) },
    { runId: '124' }, { runAttempt: '2' }, { findings: [{ ...FINDING, id: 'bad\nidentifier' }] }, { image: null }, { image: 'mutable:tag' },
  ]) {
    write(dir, { ...report('worker'), ...change });
    assert.equal(read().complete, false, JSON.stringify(change));
  }
  write(dir, report('worker'));
  fs.rmSync(path.join(dir, 'starter'), { recursive: true });
  assert.equal(read().complete, false);
});

test('one CVE aggregates components; daily updates retain first seen, deadline, assignees and human notes', () => {
  const audit = full([FINDING]);
  audit.reports.find((r) => r.component === 'worker').findings = [FINDING];
  const first = alertPlan(audit, [], { now: NOW, assignee: 'security-owner' });
  assert.equal(first.length, 1);
  assert.equal(first[0].operation, 'create');
  assert.match(first[0].payload.body, /\| standalone \|/);
  assert.match(first[0].payload.body, /\| worker \|/);
  assert.match(first[0].payload.body, /Remediation target: 2026-11-16/);
  assert.deepEqual(first[0].payload.assignees, ['security-owner']);
  const issue = { number: 17, state: 'open', ...first[0].payload, assignees: [{ login: 'human-owner' }],
    body: `${first[0].payload.body}\nKeep these investigation notes.` };
  const next = alertPlan(audit, [issue], { now: new Date('2026-11-12T00:00:00Z'), assignee: 'security-owner' });
  assert.equal(next.length, 1);
  assert.equal(next[0].number, 17);
  assert.equal(next[0].payload.assignees, undefined);
  assert.match(next[0].payload.body, /Owner: @human-owner/);
  assert.match(next[0].payload.body, /first-seen:2026-11-09T15:00:00.000Z/);
  assert.match(next[0].payload.body, /Remediation target: 2026-11-16/);
  assert.match(next[0].payload.body, /Keep these investigation notes\./);
});

test('recurrence reopens the same issue; partial scans and severity downgrades never claim a fix', () => {
  const created = alertPlan(full([FINDING]), [], { now: NOW })[0];
  const issue = { ...created.payload, number: 23, state: 'closed' };
  const reopened = alertPlan(full([FINDING]), [issue], { now: NOW });
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].operation, 'update');
  assert.equal(reopened[0].number, 23);
  assert.equal(reopened[0].payload.state, 'open');
  issue.state = 'open';
  assert.equal(alertPlan({ ...full(), complete: false }, [issue], { now: NOW }).length, 0);
  const downgraded = alertPlan(full([{ ...FINDING, severity: 'LOW' }]), [issue], { now: NOW });
  assert.equal(downgraded[0].payload.state, 'open');
  const fixed = alertPlan(full(), [issue], { now: NOW });
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0].operation, 'close');
});

test('partial discoveries retain previously affected components and clearly mark incomplete coverage', () => {
  const original = full([FINDING]);
  original.reports.find((r) => r.component === 'platform').findings = [FINDING];
  const created = alertPlan(original, [], { now: NOW })[0];
  const issue = { ...created.payload, number: 31, state: 'open', body: `${created.payload.body}\nHuman notes stay.` };
  const partial = { complete: false, reports: [report('standalone', [{ ...FINDING, severity: 'CRITICAL' }])] };
  const first = alertPlan(partial, [issue], { now: NOW })[0];
  assert.match(first.payload.body, /\| platform \|/);
  assert.match(first.payload.body, /Audit incomplete/);
  assert.match(first.payload.body, /Remediation target: 2026-11-10/);
  issue.body = first.payload.body;
  const again = alertPlan({ complete: false, reports: [report('capture', [FINDING])] }, [issue], { now: NOW })[0];
  assert.match(again.payload.body, /\| platform \|/);
  assert.match(again.payload.body, /\| standalone \|/);
  assert.match(again.payload.body, /\| capture \|/);
  assert.equal((again.payload.body.match(/<!-- coverage:/g) || []).length, 1);
  assert.match(again.payload.body, /due-at:2026-11-10/);
  issue.body = again.payload.body;
  const complete = alertPlan(full([FINDING]), [issue], { now: NOW })[0];
  assert.doesNotMatch(complete.payload.body, /\| platform \||\| capture \||Audit incomplete/);
  assert.match(complete.payload.body, /Human notes stay\./);
  assert.match(complete.payload.body, /Remediation target: 2026-11-10/);
});

test('unfixable and reviewed-exception findings stay visible; critical risk shortens the target', () => {
  const findings = [{ ...FINDING, severity: 'CRITICAL', fixedVersion: null, acceptedUntil: '2026-11-13', acceptanceReason: 'Scoped review' }];
  const action = alertPlan(full(findings), [], { now: NOW })[0];
  assert.match(action.payload.body, /No fix published/);
  assert.match(action.payload.body, /Reviewed exception until 2026-11-13/);
  assert.match(action.payload.body, /Remediation target: 2026-11-10/);
  const issue = { ...action.payload, number: 24, state: 'open' };
  const downgraded = alertPlan(full([{ ...FINDING }]), [issue], { now: NOW })[0];
  assert.match(downgraded.payload.body, /Remediation target: 2026-11-10/, 'lower severity cannot postpone an established target');
});

test('publisher paginates all issue states and reopens a managed CVE rather than creating a duplicate', async () => {
  const initial = alertPlan(full([FINDING]), [], { now: NOW })[0];
  const calls = [];
  const request = async (method, endpoint, payload) => {
    calls.push({ method, endpoint, payload });
    if (endpoint.endsWith('/git/ref/heads/main')) return { object: { sha: REVISION } };
    if (endpoint.includes('/issues?')) {
      assert.match(endpoint, /state=all/);
      return endpoint.endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => ({ number: i + 1000, body: '' }))
        : [{ ...initial.payload, number: 42, state: 'closed' }];
    }
    return {};
  };
  await publishAlerts(full([FINDING]), { repo: 'org/repo', revision: REVISION, runId: RUN, request, now: NOW });
  const mutations = calls.filter((c) => c.method !== 'GET');
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].method, 'PATCH');
  assert.match(mutations[0].endpoint, /issues\/42$/);
  assert.equal(mutations[0].payload.state, 'open');
});

test('stale audits cannot mutate issues, and local dry-run requires no token or network', async (t) => {
  const calls = [];
  await assert.rejects(publishAlerts(full([FINDING]), { repo: 'org/repo', revision: REVISION, runId: RUN,
    request: async (method) => { calls.push(method); return { object: { sha: 'c'.repeat(40) } }; } }), /stale/);
  assert.deepEqual(calls, ['GET']);
  const dir = fixture(t);
  for (const component of COMPONENTS) write(dir, report(component, component === 'standalone' ? [FINDING] : []));
  const result = spawnSync(process.execPath, ['scripts/security-alerts.js', dir, '--dry-run'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, GH_TOKEN: '', GITHUB_SHA: REVISION, GITHUB_RUN_ID: RUN, GITHUB_RUN_ATTEMPT: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.complete, true);
  assert.equal(plan.actions.length, 1);
  const refused = spawnSync(process.execPath, ['scripts/security-alerts.js', dir], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, GH_TOKEN: 'must-not-use', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge' },
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /only from the main-branch/);
});
