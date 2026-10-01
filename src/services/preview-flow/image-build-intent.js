'use strict';

const { z } = require('zod');
const { createHash } = require('node:crypto');

const OPERATION_LABEL = 'social.usernode.io/preview-build-operation';
const RECIPE_LABEL = 'social.usernode.io/preview-build-recipe';
const BUILD_OWNER = 'social-vibecoding-preview-experiment';
const runScript = z.enum(['ensure:shell', 'build']).nullable();
const quantity = z.string().min(1).max(64);
const resources = z.object({
  requests: z.object({ cpu: quantity, memory: quantity, 'ephemeral-storage': quantity }).strict(),
  limits: z.object({ cpu: quantity, memory: quantity, 'ephemeral-storage': quantity }).strict(),
}).strict();
const imageBuildOperation = z.object({
  kind: z.literal('kpack-v1'),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  repoUrl: z.string().regex(/^https:\/\/github\.com\/[^/]+\/[^/]+$/),
  namespace: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(63),
  builderImage: z.string().regex(/@sha256:[a-f0-9]{64}$/).max(1024),
  serviceAccountName: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(63),
  repository: z.string().min(1).max(512),
  cacheRepository: z.string().min(1).max(512),
  nodeVersion: z.string().min(1).max(64),
  activeDeadlineSeconds: z.number().int().min(1).max(3600),
  resources,
  runScript: runScript.optional(),
  receipt: z.object({
    uid: z.string().min(1).max(128),
    imageRef: z.string().regex(/@sha256:[a-f0-9]{64}$/).max(1024),
  }).strict().optional(),
}).strict();

function reserveImageBuild(config, app, revision) {
  if (config.appRuntime !== 'kubernetes' || config.kubernetes?.buildEngine !== 'kpack') {
    throw new Error('Recoverable image admission requires an explicit Kubernetes kpack runtime');
  }
  const cfg = config.kubernetes;
  const slug = require('../kubernetes').dnsName(app.slug);
  return imageBuildOperation.parse({
    kind: 'kpack-v1',
    revision,
    repoUrl: app.repo_url.replace(/\.git$/, ''),
    namespace: cfg.buildNamespace,
    builderImage: cfg.builderImage,
    serviceAccountName: cfg.buildServiceAccount,
    repository: `${cfg.repositoryPrefix}/${slug}`,
    cacheRepository: `${cfg.cacheRepositoryPrefix}/${slug}`,
    nodeVersion: cfg.nodeVersion,
    activeDeadlineSeconds: cfg.activeDeadlineSeconds,
    resources: {
      requests: {
        cpu: process.env.BUILD_REQUESTS_CPU || '500m',
        memory: process.env.BUILD_REQUESTS_MEMORY || '1Gi',
        'ephemeral-storage': process.env.BUILD_REQUESTS_EPHEMERAL_STORAGE || '2Gi',
      },
      limits: {
        cpu: process.env.BUILD_LIMITS_CPU || '2',
        memory: process.env.BUILD_LIMITS_MEMORY || '2Gi',
        'ephemeral-storage': process.env.BUILD_LIMITS_EPHEMERAL_STORAGE || '8Gi',
      },
    },
  });
}

// Data-only recipe: the reducer and external adapter agree on the same bytes.
function buildManifest(intent) {
  const operation = imageBuildOperation.parse(intent.buildOperation);
  const attemptId = z.string().uuid().parse(intent.attemptId);
  if (!Object.hasOwn(operation, 'runScript')) throw new Error('Image recipe has not been authorized');
  const env = [
    { name: 'BP_NODE_VERSION', value: operation.nodeVersion },
    { name: 'NODE_ENV', value: 'production' },
    { name: 'GIT_SHA', value: operation.revision },
    { name: 'BPE_OVERRIDE_GIT_SHA', value: operation.revision },
  ];
  if (operation.runScript) env.push({ name: 'BP_NODE_RUN_SCRIPTS', value: operation.runScript });
  const spec = {
    tags: [`${operation.repository}:attempt-${attemptId}`],
    serviceAccountName: operation.serviceAccountName,
    builder: { image: operation.builderImage },
    cache: { registry: { tag: `${operation.cacheRepository}:attempt-${attemptId}` } },
    source: { git: { url: operation.repoUrl, revision: operation.revision } },
    activeDeadlineSeconds: operation.activeDeadlineSeconds,
    env,
    resources: operation.resources,
  };
  const recipeHash = createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 40);
  return {
    apiVersion: 'kpack.io/v1alpha2',
    kind: 'Build',
    metadata: {
      namespace: operation.namespace,
      name: `sv-p-${attemptId.replace(/-/g, '')}`,
      labels: {
        'app.kubernetes.io/managed-by': BUILD_OWNER,
        [OPERATION_LABEL]: attemptId,
        [RECIPE_LABEL]: recipeHash,
      },
    },
    spec,
  };
}

module.exports = {
  OPERATION_LABEL,
  RECIPE_LABEL,
  BUILD_OWNER,
  runScript,
  imageBuildOperation,
  reserveImageBuild,
  buildManifest,
};
