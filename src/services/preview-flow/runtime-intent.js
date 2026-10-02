'use strict';

const { z } = require('zod');
const { createHash } = require('node:crypto');
const { encrypt, decrypt } = require('../secrets');

const RUNTIME_OWNER = 'social-vibecoding-preview-experiment';
const SPEC_LABEL = 'social.usernode.io/preview-runtime-spec';
const RESOURCE_KINDS = ['secret', 'service', 'deployment'];
const resourceKind = z.enum(RESOURCE_KINDS);
const identity = {
  flowId: z.string().uuid(),
  generation: z.number().int().positive(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
};
const desiredRuntime = z.object({
  ...identity,
  imageRef: z.string().regex(/@sha256:[a-f0-9]{64}$/).max(1024),
  environmentEnc: z.string().startsWith('v1:').max(131072),
  command: z.array(z.string().min(1).max(4096)).max(32),
  serviceAccountName: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(63),
  cpuLimit: z.string().regex(/^[0-9]+m?$/).max(16),
  labels: z.record(z.string().max(63)),
  databaseAffinity: z.object({
    namespace: z.string().max(63),
    cluster: z.string().max(63),
    placement: z.literal('zone-and-host').optional(),
  }).strict().nullable(),
}).strict();
const resourceProgress = z.object({
  submitted: z.literal(true),
  uid: z.string().min(1).max(128).optional(),
}).strict();
const runtimeOperation = z.object({
  kind: z.literal('kubernetes-v1'),
  desired: desiredRuntime.optional(),
  resources: z.object({
    secret: resourceProgress.optional(),
    service: resourceProgress.optional(),
    deployment: resourceProgress.optional(),
  }).strict().default({}),
}).strict();
const environmentSchema = z.record(z.string().max(16384)).superRefine((env, ctx) => {
  if (Object.keys(env).length > 256 || Object.keys(env).some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
    ctx.addIssue({ code: 'custom', message: 'Invalid candidate environment' });
  }
});

function selectRuntime(config, identity, {
  app, sessionId, imageRef, env, command = [], cpus = '1', labels = {},
}) {
  // Preserve the existing adapter's self-app override and diagnostic labels.
  // Snapshot them here so recovery does not consult changed app configuration.
  const selectedEnvironment = {
    ...env,
    ...(config.selfAppSlug && app?.slug === config.selfAppSlug ? { USERNODE_SHELL_ASSETS_PREBUILT: '1' } : {}),
  };
  const environment = environmentSchema.parse(Object.fromEntries(
    Object.entries(selectedEnvironment).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, String(value)]),
  ));
  const cores = Number(cpus);
  if (!Number.isFinite(cores) || cores <= 0 || cores > 32 || !Number.isInteger(cores * 1000)) {
    throw new Error('Invalid candidate CPU limit');
  }
  const cfg = config.kubernetes;
  return desiredRuntime.parse({
    ...identity,
    imageRef,
    environmentEnc: encrypt(JSON.stringify(environment), config.dataEncryptionKey),
    command,
    serviceAccountName: cfg.generatedAppServiceAccount || 'default',
    cpuLimit: Number.isInteger(cores) ? String(cores) : `${cores * 1000}m`,
    labels: {
      ...labels,
      ...(app ? { 'social.usernode.io/app-id': String(app.id), 'social.usernode.io/environment': 'staging' } : {}),
      ...(sessionId ? { 'social.usernode.io/session-id': String(sessionId) } : {}),
    },
    databaseAffinity: cfg.previewDatabaseNamespace && cfg.previewDatabaseCluster
      ? {
        namespace: cfg.previewDatabaseNamespace,
        cluster: cfg.previewDatabaseCluster,
        placement: 'zone-and-host',
      }
      : null,
  });
}

function runtimeManifests(intent, dataKey) {
  const desired = desiredRuntime.parse(intent.runtimeOperation?.desired);
  const plaintext = decrypt(desired.environmentEnc, dataKey);
  if (!plaintext) throw new Error('Candidate runtime environment is unavailable');
  const env = environmentSchema.parse(JSON.parse(plaintext));
  const specHash = createHash('sha256').update(JSON.stringify(desired)).digest('hex').slice(0, 40);
  const name = intent.runtimeName;
  const namespace = intent.namespace;
  const labels = {
    ...desired.labels,
    'app.kubernetes.io/managed-by': RUNTIME_OWNER,
    'social.usernode.io/preview-flow': desired.flowId,
    'social.usernode.io/preview-head': desired.headSha,
    'social.usernode.io/preview-runtime-operation': intent.attemptId,
    'social.usernode.io/runtime-name': name,
    [SPEC_LABEL]: specHash,
  };
  const metadata = resourceName => ({ name: resourceName, namespace, labels });
  const selector = { 'social.usernode.io/runtime-name': name };
  const probe = (periodSeconds, failureThreshold) => ({
    httpGet: { path: '/health', port: 'http', scheme: 'HTTP' },
    periodSeconds, failureThreshold, successThreshold: 1, timeoutSeconds: 1,
  });
  let affinity = null;
  if (desired.databaseAffinity) {
    const primary = {
      namespaces: [desired.databaseAffinity.namespace],
      labelSelector: {
        matchLabels: {
          'cnpg.io/cluster': desired.databaseAffinity.cluster,
          'cnpg.io/instanceRole': 'primary',
        },
      },
    };
    // Older persisted specs retain their original host-only manifest and hash.
    // New selection snapshots canonical placement; recovery never reselects it.
    const preferences = desired.databaseAffinity.placement === 'zone-and-host'
      ? [
        { weight: 100, podAffinityTerm: { ...primary, topologyKey: 'topology.kubernetes.io/zone' } },
        { weight: 50, podAffinityTerm: { ...primary, topologyKey: 'kubernetes.io/hostname' } },
      ]
      : [{ weight: 100, podAffinityTerm: { ...primary, topologyKey: 'kubernetes.io/hostname' } }];
    affinity = { podAffinity: { preferredDuringSchedulingIgnoredDuringExecution: preferences } };
  }
  return {
    secret: {
      apiVersion: 'v1', kind: 'Secret', metadata: metadata(`${name}-env`),
      immutable: true, type: 'Opaque',
      data: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, Buffer.from(value).toString('base64')])),
    },
    service: {
      apiVersion: 'v1', kind: 'Service', metadata: metadata(name),
      spec: { type: 'ClusterIP', selector, ports: [{ name: 'http', port: 3000, targetPort: 3000, protocol: 'TCP' }] },
    },
    deployment: {
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: metadata(name),
      spec: {
        replicas: 1, revisionHistoryLimit: 0, progressDeadlineSeconds: 600,
        strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
        selector: { matchLabels: selector },
        template: {
          metadata: { labels },
          spec: {
            serviceAccountName: desired.serviceAccountName,
            automountServiceAccountToken: false, enableServiceLinks: false,
            restartPolicy: 'Always', dnsPolicy: 'ClusterFirst', schedulerName: 'default-scheduler', terminationGracePeriodSeconds: 30,
            securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
            ...(affinity ? { affinity } : {}),
            containers: [{
              name: 'app', image: desired.imageRef, imagePullPolicy: 'IfNotPresent',
              ...(desired.command.length ? { command: desired.command } : {}),
              ports: [{ name: 'http', containerPort: 3000, protocol: 'TCP' }],
              envFrom: [{ secretRef: { name: `${name}-env`, optional: false } }],
              startupProbe: probe(1, 120), readinessProbe: probe(2, 3), livenessProbe: probe(15, 3),
              resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: desired.cpuLimit, memory: '1Gi' } },
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, readOnlyRootFilesystem: false },
              terminationMessagePath: '/dev/termination-log', terminationMessagePolicy: 'File',
            }],
          },
        },
      },
    },
  };
}

module.exports = { desiredRuntime, runtimeOperation, resourceKind, RESOURCE_KINDS, selectRuntime, runtimeManifests, SPEC_LABEL };
