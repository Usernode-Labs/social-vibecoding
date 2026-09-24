'use strict';

const crypto = require('node:crypto');
const { loadPolicy } = require('./database-control-plane');
const GROUP = 'database.social.usernode.io';
const RESOURCE = 'appdatabasemigrations';
const ACTIVE = ['Pending', 'Running', 'NeedsAttention'];
const ID = /^sv-move-\d{8}-[a-f0-9]{8}$/;
const invalid = (message, status = 409) => Object.assign(new Error(message), { status });

function publicOperation(o) {
  return { id: o.metadata.name, binding: o.spec.binding, target: o.spec.target,
    revision: o.spec.expectedRevision, requestedBy: o.spec.requestedBy,
    createdAt: o.metadata.creationTimestamp, phase: o.status?.observedAttempt === o.spec.attempt ? o.status.phase : 'Pending',
    stage: o.status?.stage || 'Queued', command: o.spec.command,
    attempt: o.spec.attempt, ...(o.status?.result ? { result: o.status.result } : {}) };
}

function createMigrations({ store, execute, getPolicy = loadPolicy }) {
  function selected(policy, name, target) {
    const binding = policy?.bindingTargets?.find(b => b.bindingName === name);
    if (!binding || (target !== 'central' && !policy.runtimeTargets?.some(t => t.id === target
      && policy.targets.some(c => c.id === target && c.profile === 'retained')))) {
      throw invalid('Choose a selected app and configured retained destination', 400);
    }
    return binding;
  }
  async function inventory() {
    const policy = getPolicy();
    const bindings = [];
    for (const b of policy.bindingTargets) {
      const live = await store.binding(b.bindingName);
      if (!live || live.metadata.deletionTimestamp || live.spec.database !== b.database) throw invalid('Binding unavailable', 503);
      const current = live.status?.current || { targetId: 'central', revision: 0 };
      bindings.push({ name: b.bindingName, appId: b.appId, slug: b.slug, database: b.database,
        phase: live.status?.phase || 'Ready', current });
    }
    return { enabled: true, bindings, targets: [{ id: 'central', displayName: 'Central shared cluster' },
      ...policy.targets.filter(t => t.profile === 'retained' && policy.runtimeTargets?.some(r => r.id === t.id))
        .map(t => ({ id: t.id, displayName: t.displayName || t.id }))],
      operations: (await store.list()).map(publicOperation).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')) };
  }
  async function plan(body) {
    const policy = getPolicy();
    if (!body || Object.keys(body).some(k => !['binding', 'target'].includes(k))) throw invalid('Invalid plan', 400);
    const b = selected(policy, body.binding, body.target);
    const id = 'sv-move-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-' + crypto.randomBytes(4).toString('hex');
    const result = await execute('plan', { id, binding: b.bindingName, target: body.target });
    return { id, binding: b.bindingName, slug: b.slug, target: body.target,
      expectedRevision: result.from.revision, from: result.from.targetId,
      archivesPreviousCopy: !!result.previousDestination?.databaseOid,
      downtime: 'The staging platform and selected app pause during the move. This maintenance page stays available.' };
  }
  async function submit(body, userId) {
    const policy = getPolicy();
    if (!body || Object.keys(body).some(k => !['id', 'binding', 'target', 'expectedRevision', 'confirmation'].includes(k))
      || !ID.test(body.id) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw invalid('Invalid migration request', 400);
    const b = selected(policy, body.binding, body.target);
    if (body.confirmation !== b.slug) throw invalid('Type the app slug to confirm downtime', 400);
    const spec = { binding: b.bindingName, target: body.target, expectedRevision: body.expectedRevision,
      requestedBy: String(userId), command: 'start', attempt: 1 };
    const existing = await store.get(body.id);
    if (existing) {
      if (['binding', 'target', 'expectedRevision', 'requestedBy'].some(k => existing.spec[k] !== spec[k])) throw invalid('Operation ID already belongs to another request');
      return publicOperation(existing);
    }
    if ((await store.list()).some(o => ACTIVE.includes(o.status?.phase || 'Pending'))) throw invalid('Finish the active migration first');
    const live = await store.binding(b.bindingName);
    const current = live?.status?.current || { targetId: 'central', revision: 0 };
    if (!live || (live.status?.phase || 'Ready') !== 'Ready' || current.revision !== body.expectedRevision
      || current.targetId === body.target) throw invalid('Placement changed; review a new plan');
    return publicOperation(await store.create(body.id, spec));
  }
  async function action(id, body) {
    if (!ID.test(id) || !body || Object.keys(body).some(k => !['action', 'attempt'].includes(k))
      || !['resume', 'abort'].includes(body.action) || !Number.isSafeInteger(body.attempt)) throw invalid('Invalid recovery action', 400);
    const o = await store.get(id);
    if (!o) throw invalid('Migration not found', 404);
    if (o.status?.phase !== 'NeedsAttention' || o.status?.observedAttempt !== o.spec.attempt || o.spec.attempt !== body.attempt) throw invalid('Migration changed; refresh before continuing');
    return publicOperation(await store.update(o, { ...o.spec, command: body.action, attempt: o.spec.attempt + 1 }));
  }
  return { inventory, plan, submit, action };
}

// Running attempts are never silently replayed after process loss. Recovery is
// explicit, using the durable copy Job/checkpoints maintained by the operator.
async function reconcile(o, { store, execute }) {
  if (o.status?.phase === 'Running') {
    await store.status(o, { ...o.status, phase: 'NeedsAttention', stage: 'Worker restarted; inspect and resume or abort' });
    return;
  }
  if (o.status?.observedAttempt === o.spec.attempt) return;
  const running = await store.status(o, { phase: 'Running', stage: o.spec.command === 'abort' ? 'Aborting' : 'Planned-downtime move in progress', observedAttempt: o.spec.attempt });
  try {
    let command = o.spec.command;
    // A start may have recorded a Job just before the worker disappeared.
    if (command === 'resume' && !await store.hasJob(o.metadata.name)) command = 'start';
    if (command === 'abort' && !await store.hasJob(o.metadata.name)) {
      await store.status(running, { phase: 'Aborted', stage: 'Cancelled before maintenance', observedAttempt: o.spec.attempt });
      return;
    }
    const result = await execute(command, { id: o.metadata.name, binding: o.spec.binding, target: o.spec.target, expectedRevision: o.spec.expectedRevision });
    await store.status(running, { phase: command === 'abort' ? 'Aborted' : 'Completed',
      stage: command === 'abort' ? 'Source restored' : 'Move verified; workloads restored', observedAttempt: o.spec.attempt,
      result: { target: (result.current || result.bindingState?.current)?.targetId || o.spec.target, revision: (result.current || result.bindingState?.current)?.revision ?? o.spec.expectedRevision } });
  } catch {
    await store.status(running, { phase: 'NeedsAttention', stage: 'Operation stopped; resume or abort to recover', observedAttempt: o.spec.attempt });
  }
}

module.exports = { GROUP, RESOURCE, ID, ACTIVE, publicOperation, createMigrations, reconcile };
