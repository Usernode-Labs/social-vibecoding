// The workflow's metrics, for the Prometheus that alerts on them
// (docs/kubernetes-operations.md, "Workflow alerts"): served by a process
// that runs the workflow, on a port of its own (WF_METRICS_PORT), which the
// Service and the Ingress never reach. Each scrape reads them from Postgres
// (kernel/inspect.ts health), so every replica reports the same numbers and
// the rules take their max; a scrape whose reads fail answers 503.

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Health } from './kernel/inspect.ts';

const label = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

function gauge(out: string[], name: string, help: string, values: Iterable<[Record<string, string> | null, number]>) {
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
  for (const [labels, value] of values) {
    const l = labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${label(v)}"`).join(',')}}` : '';
    out.push(`${name}${l} ${Number.isFinite(value) ? value : 0}`);
  }
}

export function render(h: Health): string {
  const out: string[] = [];
  gauge(out, 'homeroom_workflow_unclaimed_oldest_seconds',
    'How long the oldest work item a process could take now has waited for one (0: none waits).',
    [[null, h.unclaimedOldestSeconds]]);
  gauge(out, 'homeroom_workflow_pending_event_oldest_seconds',
    'How long the oldest event due to be decided has waited (0: none waits).', [[null, h.pendingOldestSeconds]]);
  // Both flags always, so a rule sees 0 rather than no series.
  const flags = new Map([['faulted', 0], ['stalled', 0], ...h.flagged]);
  gauge(out, 'homeroom_workflow_instances_flagged', 'Instances faulted or stalled, by flag.',
    [...flags].map(([flag, n]) => [{ flag }, n] as [Record<string, string>, number]));
  gauge(out, 'homeroom_workflow_deadlines_overdue', 'Instances whose deadline passed over a minute ago without firing.',
    [[null, h.deadlinesOverdue]]);
  gauge(out, 'homeroom_workflow_work_exhausted_last_hour', 'Work items that ran out of tries in the last hour.',
    [[null, h.exhaustedLastHour]]);
  gauge(out, 'homeroom_workflow_work_quarantined_last_hour',
    'Work items taken off in the last hour because their process died on each of their last attempts.',
    [[null, h.quarantinedLastHour]]);
  gauge(out, 'homeroom_workflow_work_running', 'Work items running on a live lease, by kind.',
    [...h.running].map(([kind, n]) => [{ kind }, n] as [Record<string, string>, number]));
  gauge(out, 'homeroom_workflow_decision_seconds_p95',
    'How long people\'s events waited for their decision over the last 15 minutes (95th percentile), by machine.',
    [...h.decisionP95Seconds].map(([machine, s]) => [{ machine }, s] as [Record<string, string>, number]));
  return `${out.join('\n')}\n`;
}

export function serveMetrics(port: number, read: () => Promise<Health>, log: { warn: (...a: any[]) => void }): Server {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || (req.url || '').split('?')[0] !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    read().then((h) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' }).end(render(h));
    }, (err: Error) => {
      log.warn('workflow', 'Workflow metrics could not be read', { message: err.message });
      res.writeHead(503).end();
    });
  });
  server.listen(port);
  server.unref();
  return server;
}
