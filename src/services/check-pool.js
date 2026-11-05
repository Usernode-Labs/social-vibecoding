'use strict';

// Read before queue admission, never while a SQL transaction is held. Reserve
// the main-watch suite and node services before admitting whole proposal runs.
const Gi = 1024 ** 3;
function quantity(raw) {
  const m = String(raw ?? '').match(/^(\d+(?:\.\d+)?)(m|Ki|Mi|Gi|Ti|k|M|G)?$/);
  if (!m) return NaN;
  return Number(m[1]) * ({ m: .001, Ki: 1024, Mi: 1024 ** 2, Gi, Ti: 1024 ** 4,
    k: 1000, M: 1e6, G: 1e9 }[m[2]] ?? 1);
}
function required(config) {
  return config?.kubernetes?.checkNodePoolRequired ?? process.env.CHECK_NODE_POOL_REQUIRED === 'true';
}
function budgets() {
  const count = (raw) => Math.max(1, Math.min(8, Number.parseInt(raw, 10) || 3));
  const unit = count(process.env.UNIT_SUITE_SHARDS);
  const capture = count(process.env.CAPTURE_SHARDS);
  const unitCpu = Math.max(4, unit * quantity(process.env.UNIT_SUITE_SHARD_CPU_REQUEST || '1500m'));
  const captureCpu = Math.max(4, capture * quantity(process.env.CAPTURE_SHARD_CPU_REQUEST || '2'));
  return { mainCpu: unitCpu, mainMemory: unit * Gi,
    cpu: unitCpu + captureCpu, memory: (unit + capture * 3) * Gi, pods: unit + capture };
}
function plan(nodes, { budget = budgets() } = {}) {
  const ready = (nodes || []).filter((n) => !n.spec?.unschedulable && !n.metadata?.deletionTimestamp
    && n.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')
    && !(n.spec?.taints || []).some((t) => ['NoSchedule', 'NoExecute'].includes(t.effect)));
  const perNode = ready.map((n) => {
    const a = n.status?.allocatable || {};
    // Eight CPUs/eight GiB for services, plus the two build namespaces'
    // 8-CPU/16-GiB request budgets. Builds and checks share this batch pool.
    return Math.max(0, Math.floor(Math.min(
      (quantity(a.cpu) - 24 - budget.mainCpu) / budget.cpu,
      (quantity(a.memory) - 40 * Gi - budget.mainMemory) / budget.memory,
      (quantity(a.pods) - 34 - Math.ceil(budget.mainMemory / Gi)) / budget.pods,
    )) || 0);
  });
  return { available: perNode.some((n) => n > 0), cap: perNode.reduce((a, b) => a + b, 0), nodes: ready.length };
}

function metricsQuery(pool) {
  const label = `label_${pool.key.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const key = JSON.stringify(pool.key); const value = JSON.stringify(pool.value);
  return `kube_node_status_allocatable and on(node) kube_node_labels{${label}=${value}}`
    + ' and on(node) (kube_node_status_condition{condition="Ready",status="true"} == 1)'
    + ' and on(node) (kube_node_spec_unschedulable == 0)'
    + ' and on(node) ((time() - timestamp(kube_node_status_condition{condition="Ready",status="true"})) < 90)'
    + ` unless on(node) (kube_node_spec_taint{effect="NoExecute"}`
    + ` or kube_node_spec_taint{effect="NoSchedule",key!=${key}}`
    + ` or kube_node_spec_taint{effect="NoSchedule",key=${key},value!=${value}})`;
}

function fromMetrics(result) {
  const nodes = new Map();
  for (const row of result) {
    const node = row.metric?.node; const resource = row.metric?.resource;
    if (!node || !['cpu', 'memory', 'pods'].includes(resource)) continue;
    const value = Number(row.value?.[1]);
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid check-pool capacity metric');
    if (!nodes.has(node)) nodes.set(node, { metadata: { name: node }, spec: {}, status: {
      allocatable: {}, conditions: [{ type: 'Ready', status: 'True' }],
    } });
    nodes.get(node).status.allocatable[resource] = String(value);
  }
  return plan([...nodes.values()]);
}

module.exports = { quantity, required, budgets, plan, metricsQuery, fromMetrics };
