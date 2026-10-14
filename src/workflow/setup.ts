// What a process that runs the machines' work and notifiers sets up before
// its runtime starts: the configuration and clients that the code behind
// their calls reads. A process booted without it would not fail: GitHub
// would read as "not configured", a badge sync would do nothing, a worker
// would start for a deleted account. So it is one function, run by every
// process that runs the machines: server.js at boot, in two halves so its
// order stays what it was, and a process that runs only the workflow
// (tests/lib/workflow-child.js) whole.
//
// It holds nothing only the web server has: its sockets, the Workshop's
// board-change listener, the leader's sweepers and loops. A machine that
// relies on one of those fails its two-process tests
// (tests/workflow-processes-postgres.test.js), and its list entry says why.

import { legacy } from './legacy.ts';

// Configuration read by later calls; synchronous, so server.js runs it as
// its module loads.
export function configureWorkflowProcess(config: any): void {
  legacy('services/activity-mail').init(config);
  // A worker never starts for an account being deleted.
  legacy('services/worker').setAccountDeletionGuard((sessionId: number) => legacy('services/account-deletion-cleanup')
    .assertWorkerAllowed(legacy('db/pool').getPool(config), sessionId));
}

// The clients of outside services, made from the config: the phone push
// sender, GitHub, the model.
export async function startWorkflowClients(config: any): Promise<void> {
  await legacy('services/mobile-push').initialize(config);
  await legacy('services/github').init(config);
  // The telemetry kill switch is configured even with no Anthropic client:
  // OpenRouter and local coding runs need the provider-neutral collector.
  legacy('services/llm-telemetry').init(config);
  await legacy('services/llm').init(config);
}

export async function setupWorkflowProcess(config: any): Promise<void> {
  configureWorkflowProcess(config);
  await startWorkflowClients(config);
}
