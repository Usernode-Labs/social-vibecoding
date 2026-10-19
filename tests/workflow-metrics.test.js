'use strict';

// The workflow's metrics (src/workflow/metrics.ts): what a Prometheus scrape
// of a conductor reads, and what the chart's alert rules name.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { render, serveMetrics } = require('../src/workflow/metrics.ts');

const health = (o = {}) => ({
  unclaimedOldestSeconds: 0, pendingOldestSeconds: 12.5, flagged: new Map([['faulted', 2]]), deadlinesOverdue: 1,
  exhaustedLastHour: 0, lapsedMostLastHour: 3, running: new Map([['app.deploy', 2]]),
  decisionP95Seconds: new Map([['proposal', 0.4]]), ...o,
});

test('the metrics are gauges in Prometheus\' text format, both flags always present', () => {
  const text = render(health());
  assert.match(text, /^# TYPE homeroom_workflow_unclaimed_oldest_seconds gauge$/m);
  assert.match(text, /^homeroom_workflow_pending_event_oldest_seconds 12\.5$/m);
  assert.match(text, /^homeroom_workflow_instances_flagged\{flag="faulted"\} 2$/m);
  assert.match(text, /^homeroom_workflow_instances_flagged\{flag="stalled"\} 0$/m, 'a rule sees 0, not no series');
  assert.match(text, /^homeroom_workflow_work_lapsed_most_last_hour 3$/m);
  assert.match(text, /^homeroom_workflow_work_running\{kind="app\.deploy"\} 2$/m);
  assert.match(text, /^homeroom_workflow_decision_seconds_p95\{machine="proposal"\} 0\.4$/m);
  assert.match(render(health({ running: new Map([['a"b\\c', 1]]) })), /kind="a\\"b\\\\c"/, 'label values escaped');
});

test('every metric an alert rule names is one the metrics serve', () => {
  const served = new Set([...render(health()).matchAll(/^# TYPE (\S+) gauge$/gm)].map((m) => m[1]));
  const rules = fs.readFileSync(path.join(__dirname, '../deploy/helm/social-vibecoding-platform/templates/monitoring.yaml'), 'utf8');
  const named = [...rules.matchAll(/\b(homeroom_workflow_[a-z0-9_]+)/g)].map((m) => m[1]);
  assert.ok(named.length >= 5);
  for (const name of named) assert.ok(served.has(name), `${name} is served`);
});

test('a scrape answers 200 with the metrics, 503 when they cannot be read, 404 elsewhere', async () => {
  const warned = [];
  let fail = false;
  const server = serveMetrics(0, async () => { if (fail) throw new Error('db down'); return health(); }, { warn: (...a) => warned.push(a) });
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${url}/metrics`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /text\/plain; version=0\.0\.4/);
    assert.match(await ok.text(), /homeroom_workflow_deadlines_overdue 1/);
    fail = true;
    assert.equal((await fetch(`${url}/metrics`)).status, 503);
    assert.equal(warned.length, 1);
    assert.equal((await fetch(`${url}/`)).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
