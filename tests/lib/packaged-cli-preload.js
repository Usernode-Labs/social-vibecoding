'use strict';

// Mounted only by the verified disposable harness. This instruments the shipped
// entry points; it does not replace their decisions, executor or observations.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const settings = JSON.parse(fs.readFileSync('/fixture/process.json', 'utf8'));
assert.equal(settings.version, 1);
assert.equal(settings.fixtureId, process.env.PACKAGED_CLI_FIXTURE_ID);
assert.equal(settings.revision, process.env.GIT_SHA);
assert.equal(settings.databaseAddress, process.env.PACKAGED_CLI_DATABASE_HOST);
assert.equal(settings.apiServer, process.env.PACKAGED_CLI_API_SERVER);
assert.equal(settings.databaseIdentity, process.env.PACKAGED_CLI_DATABASE_IDENTITY);
assert.equal(settings.clusterIdentity, process.env.PACKAGED_CLI_CLUSTER_IDENTITY);
assert.equal(new URL(settings.environment.DATABASE_URL).hostname, settings.databaseAddress);
assert.equal(new URL(settings.environment.DB_ADMIN_URL).hostname, settings.databaseAddress);
assert.equal(settings.environment.KUBECONFIG, '/fixture/kubeconfig');
const yaml = require('js-yaml');
const kubeconfig = yaml.load(fs.readFileSync('/fixture/kubeconfig', 'utf8'));
assert.equal(kubeconfig.clusters[0].cluster.server, settings.apiServer);
assert.equal(kubeconfig['current-context'], `kind-c4-preview-${settings.fixtureId}`);
Object.assign(process.env, settings.environment);

// Recheck physical database ownership inside the packaged process before its
// pool can issue a mutation. This also covers the clone maintenance connection.
const { Client } = require('pg');
const connectDatabase = Client.prototype.connect;
const databaseQuery = Client.prototype.query;
async function verifyDatabase(client) {
  const result = await databaseQuery.call(client, 'SELECT system_identifier::text AS identity FROM pg_control_system()');
  assert.equal(result.rows[0].identity, settings.databaseIdentity, 'Disposable database physical identity changed');
}

Client.prototype.connect = function (callback) {
  if (callback) {
    return connectDatabase.call(this, error => {
      if (error) return callback(error);
      verifyDatabase(this).then(() => callback(null), callback);
    });
  }
  return connectDatabase.call(this).then(() => verifyDatabase(this));
};

const allowedHosts = new Set([
  settings.databaseAddress,
  new URL(settings.apiServer).hostname,
  '127.0.0.1',
  'localhost',
  ...(settings.privateCapture ? [settings.privateCapture.platformAddress] : []),
]);
const actualFetch = global.fetch;
global.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.ok(allowedHosts.has(url.hostname), `Fixture forbids HTTP destination: ${url.hostname}`);
  return actualFetch(input, options);
};
for (const protocol of ['node:http', 'node:https']) {
  const service = require(protocol);
  const request = service.request;
  service.request = (...args) => {
    const destination = args[0];
    const hostname = typeof destination === 'string' || destination instanceof URL
      ? new URL(destination).hostname : destination.hostname || destination.host || 'localhost';
    assert.ok(allowedHosts.has(hostname), `Fixture forbids HTTP destination: ${hostname}`);
    return request(...args);
  };
}

function record(kind, detail = {}) {
  fs.appendFileSync('/evidence/events.jsonl', `${JSON.stringify({ kind, detail, pid: process.pid })}\n`);
}

async function pause(phase, detail) {
  record(phase, detail);
  if (settings.pause !== phase) return;
  const marker = path.join('/evidence', `${phase}.json`);
  try {
    fs.writeFileSync(marker, JSON.stringify(detail), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return;
    throw error;
  }
  // Freeze the event loop before the parent's SIGKILL. An unresolved promise
  // leaves other execution slots running, and namespace PID 1 ignores a
  // self-sent SIGSTOP. The test must interrupt the process at this boundary.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

if (settings.role === 'edge') {
  require('./https-private-edge').start(settings);
  return;
}

const configuration = require('../../src/config');
configuration.runsClusterMaintenance = () => false; // Request-serving follower.
const github = require('../../src/services/github');
github.compareCommitAncestry = async () => ({ status: 'ahead', aheadBy: 1 });
github.advanceBranchToSha = async () => record('github_branch_advance');
github.getBranchSha = async () => settings.source.revision;
github.getCloneUrl = async () => settings.source.repoUrl;
github.listChangedFiles = async () => ['frontend/fixture.js'];
github.getFileContent = async (_owner, _repo, filename) => {
  if (filename === 'dapp.json') return JSON.stringify({ tests: [{
    name: 'Packaged worker checks the real candidate', path: settings.httpsCapture ? '/proof' : '/health',
    expectText: settings.httpsCapture ? 'Read-only assertions' : 'Ok',
  }] });
  if (filename === 'package.json') return JSON.stringify({ scripts: { test: 'node --test' } });
  throw new Error(`Unconfigured fixture GitHub file: ${filename}`);
};
// Initialization itself is real and constructs a client with generated local keys.
require('../../src/services/merge-queue').enqueue = async (_config, appId) => {
  if (!fs.existsSync('/evidence/allow-gate')) {
    record('gate_dependency_unavailable', { appId });
    throw new Error('Injected gate dependency unavailable until final restart');
  }
  record('merge_policy_invoked', { appId });
};
require('../../src/services/homeroom-bot').noteProposalChecks = async (_pool, { sessionId }) => {
  if (!fs.existsSync('/evidence/allow-gate')) {
    record('gate_dependency_unavailable', { sessionId });
    throw new Error('Injected bot dependency unavailable until final restart');
  }
  record('bot_policy_invoked', { sessionId });
};


const application = require('../../src/services/application-runtime');
application.probeHealth = async (config, ref) => {
  try {
    const clients = require('../../src/services/kubernetes')._getClients();
    const body = await clients.core.connectGetNamespacedServiceProxyWithPath({
      namespace: ref.namespace || config.kubernetes.appNamespace,
      name: `${ref.runtimeName}:3000`, path: 'health',
    });
    return body === 'Ok\n' || body === 'serving';
  } catch { return false; }
};
const staging = require('../../src/services/staging');
staging.warmStagingCert = async () => {};
staging.verifyStagingEdge = async session => ({
  ok: await application.probeHealth(require('../../src/config').load(), {
    runtimeName: session.staging_runtime_name,
  }), code: 200,
});
require('../../src/services/handoff-pipeline').notifyStagingReady = () => {};

const kubernetes = require('../../src/services/kubernetes');
const getClients = kubernetes._getClients;
let verifiedClients;
kubernetes._getClients = () => {
  const clients = getClients();
  if (!verifiedClients) {
    verifiedClients = clients.core.readNamespace({ name: 'kube-system' }).then(namespace => {
      assert.equal(namespace.metadata.uid, settings.clusterIdentity, 'Disposable cluster physical identity changed');
    });
    for (const lane of ['core', 'apps', 'batch', 'networking', 'custom']) {
      for (const method of Object.getOwnPropertyNames(Object.getPrototypeOf(clients[lane]))) {
        if (!/^(create|replace|patch|delete)/.test(method)) continue;
        const mutate = clients[lane][method].bind(clients[lane]);
        clients[lane][method] = async parameters => {
          await verifiedClients;
          assert.equal(parameters.namespace, settings.namespace, 'Mutation must stay in the disposable namespace');
          if (settings.httpsCapture && method === 'createNamespacedJob'
              && parameters.body.metadata.name.startsWith('sv-capture-')) {
            const tls = settings.tlsDestination;
            assert.ok(tls, 'Verified TLS destination required before capture creation');
            assert.equal(tls.fixtureId, settings.fixtureId);
            assert.equal(tls.sessionId, Number(parameters.body.metadata.labels['social.usernode.io/session-id']));
            parameters.body.spec.template.spec.hostAliases = [{ ip: tls.address, hostnames: [tls.hostname] }];
          }
          const result = await mutate(parameters);
          if (method === 'createNamespacedJob') {
            record('job_created', {
              name: result.metadata.name,
              uid: result.metadata.uid,
              runId: result.metadata.labels['social.usernode.io/preview-run-id'],
            });
          }
          if (method === 'createNamespacedJob' && result.metadata.name.startsWith('sv-unit-suite-')) {
            await pause('checks_created', { name: result.metadata.name, uid: result.metadata.uid });
          }
          return result;
        };
      }
    }
  }
  return clients;
};
// Internal adapters hold the same client instances; verify/wrap them now.
kubernetes._getClients();
const capture = kubernetes.runCaptureJob;
kubernetes.runCaptureJob = async (config, options) => {
  if (settings.httpsCapture) {
    const env = { ...options.env, MEDIA: '1', HOME: '/home/node' };
    const targets = JSON.parse(env.TARGETS);
    env.TARGETS = JSON.stringify(targets.map(target => ({ ...target, beforeUrl: '', still: true, companion: undefined })));
    return capture(config, { ...options, env, cpus: '1', memory: '1g' });
  }
  const pool = require('../../src/db/pool').getPool(config);
  const row = (await pool.query('SELECT staging_runtime_name FROM chat_sessions WHERE id = $1',
    [options.sessionId])).rows[0];
  const publicOrigin = `https://demo--s${options.sessionId}.fixture.invalid`;
  const localOrigin = `http://${row.staging_runtime_name}.${config.kubernetes.appNamespace}.svc:3000`;
  const translate = value => String(value).replaceAll(publicOrigin, localOrigin);
  const env = Object.fromEntries(Object.entries(options.env).map(([key, value]) => [key, translate(value)]));
  const stdinPayload = translate(options.stdinPayload || env.TESTS);
  env.TESTS = '@stdin';
  return capture(config, { ...options, env, stdinPayload, cpus: '1', memory: '1g' });
};
const unit = kubernetes.runUnitSuiteJob;
kubernetes.runUnitSuiteJob = (config, options) => unit(config, {
  ...options,
  env: { ...options.env, REPO_URL: settings.unitSuite.repoUrl, GIT_REF: settings.unitSuite.revision, UNIT_FIXTURE_TOKEN: 'isolated-secret' },
  cpus: '1', memory: '512m',
});

const bindings = require('../../src/services/preview-flow/binding-adapters');
const activate = bindings.activate;
bindings.activate = async (...args) => {
  const result = await activate(...args);
  await pause('activation_written', { target: args[3].runtimeName });
  return result;
};
const handoff = require('../../src/services/cli-preview-handoff/work');
const createHandoff = handoff.createCliHandoffWork;

handoff.createCliHandoffWork = (...args) => {
  const work = createHandoff(...args);
  const admit = work.admit;
  work.admit = async (...input) => {
    const accepted = await admit(...input);
    if (accepted.accepted) await pause('admitted', { workId: accepted.work.id });
    return accepted;
  };

  const settle = work.store.settle;
  work.store.settle = async (...input) => {
    const result = await settle(...input);
    if (input[0].workflow === 'native-preview-kubernetes-prepare' && result?.result?.accepted) {
      await pause('candidate_committed', { workId: input[0].id });
    }
    return result;
  };
  return work;
};
const settlement = require('../../src/services/cli-preview-handoff/settlement');
const createSettlement = settlement.createChecksSettlement;

settlement.createChecksSettlement = (...args) => {
  const owner = createSettlement(...args);
  const settle = owner.settle;
  owner.settle = async action => {
    const result = await settle(action);
    if (result.decision.accepted) await pause('verdict_committed', { runId: action.runId, state: action.result.state });
    return result;
  };
  return owner;
};
record('entry_preloaded', { uid: process.getuid(), admission: process.env.PREVIEW_CLI_HANDOFF_ENABLED });
