// The BuildKit build lane: one Kubernetes Job per image build, running
// rootless `buildctl-daemonless.sh` against the app's Dockerfile.
//
// Why a second builder next to kpack. A kpack Build is six lifecycle
// containers in sequence (prepare, analyze, detect, restore, build, export),
// and on this cluster the four that talk to the registry spend ~50s of a
// ~70s build on sequential remote round trips — token, manifest, per-layer
// existence checks, cache re-publication — before and after the ~12s of
// actual `npm ci` + asset build (measured from the kpack Pods' container
// timestamps, Sep 2026; the Docker-host era's BuildKit build of the same
// tree was ~2s warm). BuildKit does one clone,
// one build with a registry-backed layer cache, one push, and prints a
// `#7 [shell 4/9] RUN npm ci` step stream the platform already knows how to
// read (services/docker.js parseDockerBuildLine, services/staging.js
// makeImageProgressReporter). kpack remains the builder for a tree without
// a Dockerfile, so nothing an agent can generate is left unbuildable.
//
// Isolation. Each build is its own Pod: no shared daemon, no shared cache
// directory, no way for one app's RUN step to poison another app's layers.
// The layer cache lives in the registry (`--export-cache type=registry,
// mode=max`) under the app's own cache repository, which is the same
// per-app boundary kpack's `cache.registry.tag` draws. The daemon runs
// rootless (uid 1000 under RootlessKit, no capabilities) with seccomp and
// AppArmor unconfined — what `unshare`/`mount` inside the user namespace
// need — in a namespace of its own whose Pod Security level admits that;
// `BUILDKIT_MODE=privileged` is the fallback for a cluster that cannot
// allow unprivileged user namespaces: buildkitd as root in a privileged
// container, RUN steps as real root behind runc's namespaces and the Pod
// boundary only. Rootless keeps RUN steps inside a user namespace as a
// mapped fake root; prefer it.
//
// Source. The Job fetches the pinned commit itself (shallow, by SHA) from
// the clone URL `github.getCloneUrl` hands out — the same seam the
// unit-suite Job clones through — carried in a Secret the Job owns, so a
// URL that one day carries a token is never part of the Pod spec. The
// tree is exported with `checkout-index --prefix` (no `.git`), so an app
// without a `.dockerignore` cannot COPY repository metadata into its image.
//
// Result. buildctl's `--metadata-file` carries the pushed manifest digest;
// the script copies just the digest into the container's termination
// message, which is where the platform reads it from (and records it on
// the Job as an annotation, so a later deploy of the same revision reuses
// the image without a build, as compatibleCompletedBuilds does for kpack).
//
// Availability. The lane is turned on in pieces — BUILD_ENGINE in the
// platform's environment, the namespace/RBAC/Secret from the foundation
// chart, the user-namespace sysctl on the nodes — and between any two of
// them a build must still produce an image. So the Job script checks that
// the daemon can start at all before it fetches anything and exits with
// PREFLIGHT_EXIT if not, and a 403/404 from the lane's namespace is read
// the same way; both surface as `err.engineUnavailable`, which
// services/kubernetes.js turns into a kpack build under `auto` (and
// remembers, see UNAVAILABLE_MEMO_MS). A failing Dockerfile never takes
// that path: it is the app's failure, reported as such.
//
// Everything Kubernetes-client-shaped is injected by services/kubernetes.js
// (`runtime` below) so this module stays testable with plain fakes and the
// two files do not import each other.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const stream = require('stream');
const k8s = require('@kubernetes/client-node');
const log = require('./logger');
const { parseDockerBuildLine } = require('./docker');

const ENGINE = 'buildkit';
const MANAGED_BY = 'social-vibecoding-runtime';
const CONTAINER = 'buildkit';
const ENGINE_LABEL = 'social.usernode.io/build-engine';
const REVISION_LABEL = 'social.usernode.io/revision';
const RECIPE_LABEL = 'social.usernode.io/build-recipe';
const DIGEST_ANNOTATION = 'social.usernode.io/image-digest';
const POLL_MS = 1000;
const DIGEST_RE = /sha256:[a-f0-9]{64}/;
// How much of the build log a failure report keeps (the tail).
const FAILURE_LOG_BYTES = 64 * 1024;
// EX_TEMPFAIL from the Job script: the daemon itself could not start on the
// node, before any source was fetched. Distinguishes "this cluster cannot run
// BuildKit (yet)" from "this Dockerfile does not build".
const PREFLIGHT_EXIT = 75;
// How long one such verdict keeps `auto` on kpack before the lane is tried
// again — long enough that a cluster without user namespaces does not pay
// for a doomed Job per build, short enough that the sysctl landing on the
// nodes is picked up without a platform restart.
const UNAVAILABLE_MEMO_MS = 10 * 60 * 1000;

// The lane's last infrastructure verdict, if it is still fresh.
let _unavailable = null;

function unavailableReason(now = Date.now()) {
  if (_unavailable && _unavailable.until > now) return _unavailable.reason;
  _unavailable = null;
  return null;
}

function noteUnavailable(err, now = Date.now()) {
  _unavailable = { reason: String(err?.message || err || 'BuildKit unavailable'), until: now + UNAVAILABLE_MEMO_MS };
}

// A 403 or 404 from the API for the lane's own namespace: RBAC or the
// namespace itself is not there. That is the lane missing, not the build.
function isLaneMissing(err) {
  const code = err?.code || err?.response?.statusCode || err?.response?.status || err?.statusCode;
  return code === 403 || code === 404;
}

function markUnavailable(err, detail) {
  err.engineUnavailable = true;
  err.message = `BuildKit lane unavailable: ${detail}`;
  return err;
}

// The Dockerfile the tree carries, first candidate wins; null when none.
function selectDockerfile(config, sourceDir) {
  if (!sourceDir) return null;
  for (const name of config.kubernetes.buildkitDockerfiles || []) {
    try {
      if (fs.statSync(path.join(sourceDir, name)).isFile()) return name;
    } catch { /* not this one */ }
  }
  return null;
}

// Which builder this tree gets under the configured BUILD_ENGINE.
function selectEngine(config, sourceDir) {
  const engine = config.kubernetes.buildEngine || 'kpack';
  if (!['kpack', 'auto', 'buildkit'].includes(engine)) {
    throw new Error(`Unsupported BUILD_ENGINE=${engine} (kpack, auto, buildkit)`);
  }
  if (engine === 'kpack') return { engine: 'kpack', dockerfile: null };
  const dockerfile = selectDockerfile(config, sourceDir);
  if (dockerfile) return { engine: ENGINE, dockerfile };
  if (engine === 'buildkit') {
    const err = new Error(`BUILD_ENGINE=buildkit needs one of ${(config.kubernetes.buildkitDockerfiles || []).join(', ')} at the source root`);
    err.buildFailed = true;
    err.buildLog = err.message;
    throw err;
  }
  return { engine: 'kpack', dockerfile: null };
}

function requireConfig(config) {
  const cfg = config.kubernetes;
  const missing = [];
  for (const key of ['repositoryPrefix', 'cacheRepositoryPrefix', 'buildkitImage', 'buildkitNamespace', 'buildkitServiceAccount']) {
    if (!cfg[key]) missing.push(key);
  }
  if (missing.length) throw new Error(`BuildKit build configuration missing: ${missing.join(', ')}`);
  if (!/@sha256:[a-f0-9]{64}$/.test(cfg.buildkitImage)) {
    throw new Error('BUILDKIT_IMAGE must be an immutable digest');
  }
  if (!['rootless', 'privileged'].includes(cfg.buildkitMode || 'rootless')) {
    throw new Error(`Unsupported BUILDKIT_MODE=${cfg.buildkitMode} (rootless, privileged)`);
  }
  return cfg;
}

// The whole build, as one POSIX sh script. Parameters arrive as environment
// so the script itself is a constant (and REPO_URL, which may carry a
// token, is never part of a command line or a log line).
const BUILD_SCRIPT = [
  'set -eu',
  'umask 022',
  'say() { printf \'[buildkit] %s\\n\' "$*"; }',
  'mkdir -p /workspace/repo /workspace/src',
  // Can the daemon run on this node at all? Under RootlessKit that is
  // "can uid 1000 create a user namespace" (user.max_user_namespaces),
  // which is a property of the node, not of the Dockerfile. A distinct
  // exit code lets the platform tell the two apart and build with kpack
  // instead of failing the app's preview; see PREFLIGHT_EXIT.
  'if ! buildctl-daemonless.sh debug workers >/workspace/preflight.log 2>&1; then',
  '  say "buildkitd cannot run here"',
  '  tail -n 40 /workspace/preflight.log',
  '  exit 75',
  'fi',
  'say "fetching source $GIT_SHA"',
  'cd /workspace/repo',
  'git init -q',
  'git -c protocol.version=2 fetch -q --depth 1 "$REPO_URL" "$GIT_SHA"',
  'git read-tree FETCH_HEAD',
  'git checkout-index -a -f --prefix=/workspace/src/',
  'cd /workspace',
  'rm -rf /workspace/repo',
  'say "building $DOCKERFILE -> $IMAGE_TAG"',
  'buildctl-daemonless.sh build \\',
  '  --frontend dockerfile.v0 \\',
  '  --local context=/workspace/src \\',
  '  --local dockerfile=/workspace/src \\',
  '  --opt "filename=$DOCKERFILE" \\',
  '  --opt "build-arg:GIT_SHA=$GIT_SHA" \\',
  '  --output "type=image,name=$IMAGE_TAG,push=true$REGISTRY_ATTRS" \\',
  '  --import-cache "type=registry,ref=$CACHE_REF$REGISTRY_ATTRS" \\',
  '  --export-cache "type=registry,ref=$CACHE_REF,mode=max,image-manifest=true,oci-mediatypes=true$REGISTRY_ATTRS" \\',
  '  --progress plain \\',
  '  --metadata-file /workspace/metadata.json',
  // buildctl's metadata file is pretty-printed JSON, one key per line; the
  // termination message is capped at 4KiB, so only the digest goes there.
  'digest=$(grep -o \'"containerimage.digest": *"sha256:[0-9a-f]*"\' /workspace/metadata.json | head -n 1 | grep -o \'sha256:[0-9a-f]*\')',
  'test -n "$digest"',
  'printf \'%s\' "$digest" > /dev/termination-log',
  'say "pushed $IMAGE_TAG@$digest"',
].join('\n');

function resources() {
  return {
    requests: {
      cpu: process.env.BUILDKIT_REQUESTS_CPU || '1',
      memory: process.env.BUILDKIT_REQUESTS_MEMORY || '2Gi',
      'ephemeral-storage': process.env.BUILDKIT_REQUESTS_EPHEMERAL_STORAGE || '4Gi',
    },
    limits: {
      cpu: process.env.BUILDKIT_LIMITS_CPU || '4',
      memory: process.env.BUILDKIT_LIMITS_MEMORY || '6Gi',
      'ephemeral-storage': process.env.BUILDKIT_LIMITS_EPHEMERAL_STORAGE || '20Gi',
    },
  };
}

function securityContexts(cfg) {
  if (cfg.buildkitMode === 'privileged') {
    // As root, buildctl-daemonless.sh starts buildkitd directly instead of
    // under RootlessKit, so this mode needs no user namespaces at all —
    // which is the point of it on a node with user.max_user_namespaces=0.
    // RUN steps then execute as real root inside runc's mount/pid
    // namespaces in a privileged container: the Pod boundary is the
    // isolation, not a user namespace.
    return { pod: { runAsUser: 0, runAsGroup: 0 }, container: { privileged: true } };
  }
  return {
    // RootlessKit maps uid 1000 to root inside the user namespace and needs
    // setuid newuidmap/newgidmap, so no capability drop and privilege
    // escalation left at its default; unconfined seccomp/AppArmor for the
    // unshare and mount calls inside that namespace (docs/rootless.md).
    pod: {
      runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000,
      seccompProfile: { type: 'Unconfined' },
      appArmorProfile: { type: 'Unconfined' },
    },
    container: { runAsNonRoot: true },
  };
}

function recipeOf(cfg, dockerfile) {
  return crypto.createHash('sha256').update(JSON.stringify({
    engine: ENGINE, image: cfg.buildkitImage, dockerfile, mode: cfg.buildkitMode || 'rootless',
    insecure: !!cfg.buildkitInsecureRegistry,
  })).digest('hex').slice(0, 12);
}

function jobManifest(cfg, runtime, {
  app, revision, environment, sessionId, dockerfile, name, tag, cacheRef, recipe, inputSecretName,
}) {
  const jobLabels = {
    ...runtime.labels({ appId: app.id, sessionId, environment }),
    [ENGINE_LABEL]: ENGINE,
    [REVISION_LABEL]: revision,
    [RECIPE_LABEL]: recipe,
  };
  const security = securityContexts(cfg);
  const rootless = cfg.buildkitMode !== 'privileged';
  const env = [
    { name: 'REPO_URL', valueFrom: { secretKeyRef: { name: inputSecretName, key: 'REPO_URL' } } },
    { name: 'GIT_SHA', value: revision },
    { name: 'DOCKERFILE', value: dockerfile },
    { name: 'IMAGE_TAG', value: tag },
    { name: 'CACHE_REF', value: cacheRef },
    { name: 'REGISTRY_ATTRS', value: cfg.buildkitInsecureRegistry ? ',registry.insecure=true' : '' },
    // Rootless: Kubernetes has no `systempaths=unconfined`, and this is the
    // documented trade for it (examples/kubernetes/job.rootless.yaml). As
    // root the daemon can build its process sandbox, so it keeps it.
    { name: 'BUILDKITD_FLAGS', value: rootless ? '--oci-worker-no-process-sandbox' : '' },
  ];
  const volumeMounts = [
    { name: 'workspace', mountPath: '/workspace' },
    // The daemon's store must be a real volume: the image's VOLUME does
    // not survive a nosuid,nodev mount on some node images. Where the
    // store is depends on who runs the daemon.
    { name: 'buildkitd', mountPath: rootless ? '/home/user/.local/share/buildkit' : '/var/lib/buildkit' },
  ];
  const volumes = [
    { name: 'workspace', emptyDir: {} },
    { name: 'buildkitd', emptyDir: {} },
  ];
  if (cfg.buildkitRegistrySecret) {
    env.push({ name: 'DOCKER_CONFIG', value: '/var/run/buildkit-registry' });
    volumeMounts.push({ name: 'registry-auth', mountPath: '/var/run/buildkit-registry', readOnly: true });
    volumes.push({
      name: 'registry-auth',
      secret: { secretName: cfg.buildkitRegistrySecret, items: [{ key: '.dockerconfigjson', path: 'config.json' }] },
    });
  }
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: cfg.buildkitNamespace, labels: jobLabels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: cfg.activeDeadlineSeconds,
      // A finished Job stays around for image reuse (its digest annotation),
      // then Kubernetes removes it and its Pod.
      ttlSecondsAfterFinished: Math.max(60, Math.round((cfg.buildkitSuccessRetentionHours || 48) * 3600)),
      template: {
        metadata: { labels: jobLabels },
        spec: {
          restartPolicy: 'Never',
          serviceAccountName: cfg.buildkitServiceAccount,
          automountServiceAccountToken: false,
          securityContext: security.pod,
          containers: [{
            name: CONTAINER,
            image: cfg.buildkitImage,
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', BUILD_SCRIPT],
            env,
            volumeMounts,
            resources: resources(),
            securityContext: security.container,
            terminationMessagePolicy: 'File',
          }],
          volumes,
        },
      },
    },
  };
}

function repoOwnerAndName(repoUrl) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repoUrl || '');
  return m ? { owner: m[1], name: m[2] } : null;
}

function jobFailed(job) {
  return !!(job?.status?.failed || job?.status?.conditions?.some((c) => c.type === 'Failed' && c.status === 'True'));
}

function jobSucceeded(job) {
  return !!(job?.status?.succeeded || job?.status?.conditions?.some((c) => c.type === 'Complete' && c.status === 'True'));
}

function digestFromPod(pod) {
  const status = pod?.status?.containerStatuses?.find((c) => c.name === CONTAINER);
  const message = status?.state?.terminated?.message;
  const m = DIGEST_RE.exec(String(message || ''));
  return m ? m[0] : null;
}

// The build container's exit code once it has terminated, else null.
function exitCodeFromPod(pod) {
  const status = pod?.status?.containerStatuses?.find((c) => c.name === CONTAINER);
  const code = status?.state?.terminated?.exitCode;
  return Number.isInteger(code) ? code : null;
}

async function findPod(core, namespace, jobName) {
  const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${jobName}` });
  const items = Array.isArray(pods?.items) ? pods.items : [];
  // The newest Pod is the one whose outcome the Job reports.
  items.sort((a, b) => Date.parse(b.metadata?.creationTimestamp || 0) - Date.parse(a.metadata?.creationTimestamp || 0));
  return items[0] || null;
}

// The digest a finished Job produced: the annotation the platform wrote,
// else the termination message of its Pod (a Job whose platform died
// between success and the annotation).
async function completedDigest(core, job) {
  const annotated = DIGEST_RE.exec(job?.metadata?.annotations?.[DIGEST_ANNOTATION] || '');
  if (annotated) return annotated[0];
  const pod = await findPod(core, job.metadata.namespace, job.metadata.name).catch(() => null);
  return pod ? digestFromPod(pod) : null;
}

// A previous successful Job for this exact revision and recipe, newest first.
async function reusableJob(cfg, clients, { appId, revision, recipe }) {
  const { batch, core } = clients;
  try {
    const list = await batch.listNamespacedJob({
      namespace: cfg.buildkitNamespace,
      labelSelector: `app.kubernetes.io/managed-by=${MANAGED_BY},social.usernode.io/app-id=${appId},${ENGINE_LABEL}=${ENGINE},${REVISION_LABEL}=${revision},${RECIPE_LABEL}=${recipe}`,
    });
    const jobs = (list?.items || []).filter((job) => jobSucceeded(job) && !job.metadata?.deletionTimestamp);
    jobs.sort((a, b) => Date.parse(b.status?.completionTime || 0) - Date.parse(a.status?.completionTime || 0));
    for (const job of jobs) {
      const digest = await completedDigest(core, job);
      if (digest) return { job, digest };
    }
  } catch (err) {
    log.warn('kubernetes', 'Previous BuildKit build lookup failed; building without image reuse', { appId, err: err.message });
  }
  return null;
}

// `onProgress(image)` receives `{ phase, index, total, detail }` per step
// line, exactly what services/docker.js reports for its BuildKit build, so
// staging's per-step timing works unchanged. The Job's own `[buildkit] ...`
// lines come through as `phase: 'source'` with no step counter.
async function createBuild(config, { app, revision, environment, sessionId, sourceDir, onProgress = null }, runtime) {
  if (!/^[a-f0-9]{40}$/i.test(revision || '')) {
    throw new Error('Kubernetes builds require a full 40-character Git commit SHA');
  }
  const repo = repoOwnerAndName(app.repo_url);
  if (!repo) throw new Error('Kubernetes builds require an HTTPS GitHub repository URL');
  const cfg = requireConfig(config);
  const dockerfile = selectDockerfile(config, sourceDir);
  if (!dockerfile) {
    const err = new Error(`No Dockerfile (${(cfg.buildkitDockerfiles || []).join(', ')}) at the source root`);
    err.buildFailed = true;
    err.buildLog = err.message;
    throw err;
  }
  const repository = `${cfg.repositoryPrefix}/${runtime.dnsName(app.slug)}`;
  const cacheRef = `${cfg.cacheRepositoryPrefix}/${runtime.dnsName(app.slug)}:buildkit-cache`;
  const recipe = recipeOf(cfg, dockerfile);
  const tag = `${repository}:git-${revision}-${recipe}`;
  const suffix = sessionId ? `s${sessionId}-` : '';
  const name = runtime.dnsName(`bk-${app.id}-${suffix}${revision.slice(0, 12)}-${recipe}`);
  const clients = runtime.getClients();
  const { batch, core } = clients;

  const previous = await reusableJob(cfg, clients, { appId: app.id, revision, recipe });
  if (previous) {
    return {
      buildRef: `${cfg.buildkitNamespace}/${previous.job.metadata.name}`,
      imageRef: `${repository}@${previous.digest}`, requestedTag: tag, phases: [], reused: true, engine: ENGINE,
    };
  }

  const inputSecretName = runtime.withSuffix(name, 'input');
  const cloneUrl = await runtime.getCloneUrl(repo.owner, repo.name);
  const body = jobManifest(cfg, runtime, {
    app, revision, environment, sessionId, dockerfile, name, tag, cacheRef, recipe, inputSecretName,
  });
  const namespace = cfg.buildkitNamespace;
  let created = null;
  const secretBody = {
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: inputSecretName, namespace, labels: body.metadata.labels },
    type: 'Opaque', stringData: { REPO_URL: String(cloneUrl) },
  };
  try {
    await core.createNamespacedSecret({ namespace, body: secretBody });
  } catch (err) {
    if (!isConflict(err)) {
      if (isLaneMissing(err)) markUnavailable(err, `cannot create Secrets in ${namespace} (${err.message})`);
      err.buildFailed = true;
      err.buildLog = runtime.boundedText(err.message);
      err.message = runtime.boundedText(err.message);
      throw err;
    }
    // Left by an earlier attempt of this exact name; a fresh token replaces it.
    await core.replaceNamespacedSecret({ name: inputSecretName, namespace, body: secretBody }).catch(() => {});
  }
  const createDeadline = Date.now() + 60000;
  while (true) {
    try {
      created = await batch.createNamespacedJob({ namespace, body });
      break;
    } catch (err) {
      if (!isConflict(err)) {
        await runtime.deleteIfPresent(core, 'deleteNamespacedSecret', inputSecretName, namespace).catch(() => {});
        if (isLaneMissing(err)) markUnavailable(err, `cannot create Jobs in ${namespace} (${err.message})`);
        err.buildFailed = true;
        err.buildLog = runtime.boundedText(err.message);
        err.message = runtime.boundedText(err.message);
        throw err;
      }
      const existing = await batch.readNamespacedJob({ name, namespace }).catch((readErr) => {
        if (runtime.isNotFound(readErr)) return null;
        throw readErr;
      });
      if (existing && !existing.metadata?.deletionTimestamp) {
        if (jobFailed(existing)) {
          // An earlier attempt failed after reuse discovery ran; make room.
          await runtime.deleteIfPresent(batch, 'deleteNamespacedJob', name, namespace, { propagationPolicy: 'Background' });
        } else {
          created = existing; // running or already complete: wait on it
          break;
        }
      }
      if (Date.now() >= createDeadline) throw new Error(`Timed out waiting to recreate BuildKit Job ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  // A platform restart must not orphan the clone credential: the Job's
  // TTL garbage-collects the Secret through this owner reference.
  if (created?.metadata?.uid) {
    try {
      const secret = await core.readNamespacedSecret({ name: inputSecretName, namespace });
      secret.metadata.ownerReferences = [{ apiVersion: 'batch/v1', kind: 'Job', name, uid: created.metadata.uid }];
      await core.replaceNamespacedSecret({ name: inputSecretName, namespace, body: secret });
    } catch (err) {
      log.warn('kubernetes', 'BuildKit input Secret owner reference not set', { name, err: err.message });
    }
  }
  try {
    const digest = await waitForJob(cfg, runtime, clients, name, { onProgress });
    const imageRef = `${repository}@${digest}`;
    try {
      await batch.patchNamespacedJob(
        { name, namespace, body: { metadata: { annotations: { [DIGEST_ANNOTATION]: digest } } } },
        k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch)
      );
    } catch (err) {
      log.warn('kubernetes', 'BuildKit Job digest annotation not written', { name, err: err.message });
    }
    return { buildRef: `${namespace}/${name}`, imageRef, requestedTag: tag, phases: null, engine: ENGINE };
  } catch (err) {
    await runtime.deleteIfPresent(batch, 'deleteNamespacedJob', name, namespace, { propagationPolicy: 'Background' })
      .catch((cleanupErr) => log.warn('kubernetes', 'Failed BuildKit Job cleanup failed', { name, err: cleanupErr.message }));
    throw err;
  }
}

function isConflict(err) {
  return err?.code === 409 || err?.response?.statusCode === 409 || err?.response?.status === 409;
}

function progressFromLine(line) {
  const text = log.redactString(String(line || '').replace(/\x1b\[[0-9;]*m/g, '')).trimEnd();
  if (!text.trim()) return null;
  const own = /^\[buildkit\] (.*)$/.exec(text.trim());
  if (own) return { phase: 'source', index: null, total: null, detail: own[1] };
  return parseDockerBuildLine(text);
}

async function waitForJob(cfg, runtime, clients, name, { onProgress = null } = {}) {
  const namespace = cfg.buildkitNamespace;
  const { batch, core } = clients;
  const deadline = Date.now() + (cfg.activeDeadlineSeconds + 60) * 1000;
  const report = typeof onProgress === 'function';
  const tail = [];
  let tailBytes = 0;
  const remember = (line) => {
    const bytes = Buffer.byteLength(line, 'utf8') + 1;
    tail.push(line);
    tailBytes += bytes;
    while (tailBytes > FAILURE_LOG_BYTES && tail.length > 1) tailBytes -= Buffer.byteLength(tail.shift(), 'utf8') + 1;
  };
  let podName = null;
  let followAbort = null;
  let following = false;
  const stopFollow = () => {
    if (followAbort && typeof followAbort.abort === 'function') { try { followAbort.abort(); } catch { /* closed */ } }
    followAbort = null;
  };
  const startFollow = async () => {
    if (following) return;
    try {
      if (!podName) {
        const pod = await findPod(core, namespace, name);
        podName = pod?.metadata?.name || null;
        if (!podName) return;
      }
      const logApi = runtime.clientsLogApi(clients);
      if (!logApi) return;
      const sink = new stream.PassThrough();
      runtime.attachLineObserver(sink, (line) => {
        const clean = log.redactString(String(line || '').replace(/\x1b\[[0-9;]*m/g, ''));
        remember(clean);
        if (!report) return;
        const image = progressFromLine(clean);
        if (image) { try { onProgress(image); } catch { /* observer only */ } }
      });
      // Refused until the container has started; the next tick retries.
      followAbort = await logApi.log(namespace, podName, CONTAINER, sink, { follow: true });
      following = true;
    } catch { /* next tick */ }
  };
  let lastJob = null;
  try {
    while (Date.now() < deadline) {
      const job = await batch.readNamespacedJob({ name, namespace });
      lastJob = job;
      if (jobSucceeded(job)) {
        const pod = await findPod(core, namespace, name);
        const digest = pod ? digestFromPod(pod) : null;
        if (!digest) {
          const err = new Error(`BuildKit Job ${name} finished without an image digest`);
          throw err;
        }
        return digest;
      }
      if (jobFailed(job)) {
        const reason = job.status?.conditions?.find((c) => c.type === 'Failed')?.reason;
        const err = new Error(`BuildKit Job ${name} failed${reason ? `: ${reason}` : ''}`);
        if (reason === 'DeadlineExceeded') {
          err.killed = true;
          err.buildTimeoutSeconds = cfg.activeDeadlineSeconds;
        } else {
          const pod = await findPod(core, namespace, name).catch(() => null);
          if (pod) podName = podName || pod.metadata?.name || null;
          if (exitCodeFromPod(pod) === PREFLIGHT_EXIT) {
            markUnavailable(err, `buildkitd cannot start on ${pod?.spec?.nodeName || 'the node'} (Job ${name} preflight)`);
          }
        }
        throw err;
      }
      if (!following) await startFollow();
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    const err = new Error(`Timed out waiting for BuildKit Job ${name}`);
    err.killed = true;
    err.buildTimeoutSeconds = cfg.activeDeadlineSeconds + 60;
    throw err;
  } catch (err) {
    // Same buildFailed/buildLog contract as the kpack and Docker builders,
    // captured before createBuild removes the Job and its Pod.
    if (!podName) {
      const pod = await findPod(core, namespace, name).catch(() => null);
      podName = pod?.metadata?.name || null;
    }
    const diagnostics = podName
      ? await runtime.collectPodDiagnostics(core, { namespace, podName, container: CONTAINER })
      : { logs: '', details: '', unavailable: 'Job did not schedule a Pod' };
    if (diagnostics.deadlineExceeded) {
      err.killed = true;
      err.buildTimeoutSeconds = cfg.activeDeadlineSeconds;
    }
    err.buildFailed = true;
    err.buildRef = `${namespace}/${name}`;
    err.message = runtime.boundedText(err.message);
    const followedTail = tail.join('\n');
    err.buildLog = runtime.boundedText([err.message, diagnostics.details, diagnostics.logs || followedTail].filter(Boolean).join('\n'));
    if (diagnostics.unavailable) {
      log.warn('kubernetes', 'BuildKit build failure diagnostics incomplete', {
        buildRef: err.buildRef, detail: diagnostics.unavailable, lastJobStatus: lastJob?.status?.conditions?.map((c) => c.type) || null,
      });
    }
    throw err;
  } finally {
    stopFollow();
  }
}

// Every BuildKit Job of one app, when the app is deleted.
// Whether this cluster has a BuildKit lane to clean up after at all. Under
// the kpack-only default the namespace need not exist, and an app deletion
// must not fail on a 404 from a builder that was never used.
function laneEnabled(config) {
  const cfg = config.kubernetes;
  return (cfg.buildEngine || 'kpack') !== 'kpack' && Boolean(cfg.buildkitNamespace);
}

async function deleteBuilds(config, appId, runtime) {
  if (!laneEnabled(config)) return;
  const cfg = config.kubernetes;
  const { batch } = runtime.getClients();
  if (typeof batch?.deleteCollectionNamespacedJob !== 'function') return;
  try {
    await batch.deleteCollectionNamespacedJob({
      namespace: cfg.buildkitNamespace,
      labelSelector: `social.usernode.io/app-id=${appId},${ENGINE_LABEL}=${ENGINE}`,
      propagationPolicy: 'Background',
    });
  } catch (err) {
    if (!runtime.isNotFound(err)) throw err;
  }
}

// Failed Jobs a crashed platform left behind (a live createBuild deletes
// its own failure after collecting diagnostics).
async function deleteFailedBuilds(config, runtime) {
  if (!laneEnabled(config)) return { examined: 0, deleted: 0 };
  const cfg = config.kubernetes;
  const { batch } = runtime.getClients();
  if (typeof batch?.listNamespacedJob !== 'function') return { examined: 0, deleted: 0 };
  const list = await batch.listNamespacedJob({
    namespace: cfg.buildkitNamespace,
    labelSelector: `app.kubernetes.io/managed-by=${MANAGED_BY},${ENGINE_LABEL}=${ENGINE}`,
  });
  const items = list?.items || [];
  const failed = items.filter((job) => jobFailed(job) && !job.metadata?.deletionTimestamp);
  for (const job of failed) {
    await runtime.deleteIfPresent(batch, 'deleteNamespacedJob', job.metadata.name, cfg.buildkitNamespace, { propagationPolicy: 'Background' });
  }
  return { examined: items.length, deleted: failed.length };
}

module.exports = {
  ENGINE,
  createBuild,
  deleteBuilds,
  deleteFailedBuilds,
  selectEngine,
  selectDockerfile,
  laneEnabled,
  unavailableReason,
  noteUnavailable,
  _forTest: {
    BUILD_SCRIPT, PREFLIGHT_EXIT, UNAVAILABLE_MEMO_MS, jobManifest, recipeOf, progressFromLine, digestFromPod, exitCodeFromPod,
    repoOwnerAndName, requireConfig,
    resetUnavailable() { _unavailable = null; },
  },
};
