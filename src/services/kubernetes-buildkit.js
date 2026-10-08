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
// per-app boundary kpack's `cache.registry.tag` draws. It is uploaded only
// when a build produced something a later build can reuse; see "The layer
// cache upload" below. The daemon runs
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
// the script copies the digest into the container's termination message,
// after a few lines saying what happened to the layer cache. The platform
// reads both from there and records them on the Job as annotations: the
// digest so a later deploy of the same revision reuses the image without a
// build (as compatibleCompletedBuilds does for kpack), the cache lines so
// the next build of the app knows which steps run on every build.
//
// The layer cache upload. `mode=max` writes every layer of every stage to
// the cache repository, and on a preview most of those are the commit's
// own: source copies and whatever is built from them. No later build can
// use them, and uploading them was a quarter of a preview build (12-15 s
// measured over 167 builds in October 2026, most of it after the image was
// already pushed). So the build itself only imports the cache, and the
// script uploads it afterwards, in a second buildctl run over the Pod's
// warm store, only when a step ran whose result a later build could have
// been served.
//
// Which steps those are cannot be read off one build: a lockfile that
// changed and source that changed look the same, a COPY that ran followed
// by a RUN that ran. It takes memory, and the memory is the app's finished
// Jobs. Each carries what its build saw (CACHE_STEPS_ANNOTATION): which
// steps ran, which the cache served, and whether the cache was uploaded.
// From those (settledCacheSteps):
//
// - A step the cache served at least as often as it ran is reusable, so
//   the build in which it runs uploads. That is a dependency install after
//   its lockfile changed, or after the base image moved.
// - A step no build has reported is new, so it uploads too.
// - A step that mostly runs bakes in the commit or reads the source. It
//   still gets CACHE_CHANCES uploads per CACHE_CHANCE_WINDOW_MS, and is
//   "settled" once it has had them: it causes no upload until they age
//   out. That retry is what keeps a reusable step from being written off
//   for good after an unlucky start, and "mostly" rather than "always" is
//   what keeps one rebuild of an already cached commit, which serves every
//   step, from making each of them look reusable.
//
// No history (a new app, or one whose Jobs have all expired), a failed
// lookup, or a trace the script cannot read all mean "upload", which is
// what every build did before.
//
// Only steps that do work are counted: RUN, ADD and anything unfamiliar.
// COPY, WORKDIR and FROM are not: redoing them costs a local copy or a pull
// from the image's own registry, and counting a COPY that is served on some
// builds and runs on others would upload on every source change.
// BUILDKIT_CACHE_UPLOAD=always turns the decision off.
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
const log = require('./logger');
const { parseDockerBuildLine } = require('./docker');

// Loaded on first use, as in kubernetes.js: most processes that load this
// file never patch a Job.
const kubernetesClient = () => require('@kubernetes/client-node');

const ENGINE = 'buildkit';
const MANAGED_BY = 'social-vibecoding-runtime';
const CONTAINER = 'buildkit';
const ENGINE_LABEL = 'social.usernode.io/build-engine';
const REVISION_LABEL = 'social.usernode.io/revision';
const RECIPE_LABEL = 'social.usernode.io/build-recipe';
const DIGEST_ANNOTATION = 'social.usernode.io/image-digest';
// What a finished build saw of the layer cache, as the lines its script put
// in the termination message: `cache-upload=<done|skipped|failed>`, then
// `cache-ran=<tokens>` and `cache-served=<tokens>` when it could tell. A
// token is the first twelve hex digits of the SHA-256 of a step's name (see
// STEPS_AWK), so no step text travels through the environment or a label.
const CACHE_STEPS_ANNOTATION = 'social.usernode.io/cache-steps';
// How many uploading builds a step may run in, within the window, before it
// is taken to run on every build.
const CACHE_CHANCES = 2;
const CACHE_CHANCE_WINDOW_MS = 24 * 60 * 60 * 1000;
// A build with more counted steps than this reports none and uploads: its
// report would not fit the 4 KiB termination message.
const CACHE_MAX_STEPS = 200;
const CACHE_TOKEN_RE = /^[a-f0-9]{12}$/;
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
  if (!['auto', 'always'].includes(cfg.buildkitCacheUpload || 'auto')) {
    throw new Error(`Unsupported BUILDKIT_CACHE_UPLOAD=${cfg.buildkitCacheUpload} (auto, always)`);
  }
  return cfg;
}

// What the build did, read from buildctl's `--trace` file: one JSON status
// per line, a step being `{"digest":…,"inputs":[…],"name":…,"started":…,
// "completed":…,"cached":true}` with the fields it has, in that order. The
// plain progress log cannot answer this: a step the cache served prints no
// CACHED line when its layers were then downloaded for a later step. The
// image has busybox awk and no JSON tool, hence the string matching.
//
// Prints `S <stage> <command>` for a step the imported cache served,
// `R <stage> <command>` for one that ran here, then `V <n>`, how many steps
// it recognised at all (the caller reads 0, or no such line, as "cannot
// tell"). A step is named without its `n/m` counter, which differs between
// two proposals' Dockerfiles, and with the commit id spelled GIT_SHA: the
// frontend expands build arguments in the name it shows.
const STEPS_AWK = String.raw`
BEGIN { sha = ENVIRON["GIT_SHA"]; n = 0 }
{
  line = $0
  while ((at = index(line, "{\"digest\":\"sha256:")) > 0) {
    line = substr(line, at + 18)
    if (!match(line, /^[0-9a-f]+"(,"inputs":\[[^]]*\])?,"name":"/)) continue
    d = substr(line, 1, 64)
    rest = substr(line, RLENGTH + 1)
    if (!match(rest, /^([^"\\]|\\.)*"/)) continue
    name[d] = substr(rest, 1, RLENGTH - 1)
    tail = substr(rest, RLENGTH + 1)
    if (tail ~ /^(,"started":"[^"]*")?(,"completed":"[^"]*")?,"cached":true/) served[d] = 1
    if (tail ~ /^(,"started":"[^"]*")?,"completed":"/) done[d] = 1
    if (!(d in seen)) { seen[d] = 1; ids[++n] = d }
  }
}
END {
  steps = 0
  for (i = 1; i <= n; i++) {
    d = ids[i]; s = name[d]
    if (!match(s, /^\[[^]]* +[0-9]+\/[0-9]+\] /)) continue
    steps++
    stage = substr(s, 2, RLENGTH - 3); sub(/ +[0-9]+\/[0-9]+$/, "", stage)
    command = substr(s, RLENGTH + 1)
    kind = command; sub(/ .*$/, "", kind)
    if (kind == "COPY" || kind == "WORKDIR" || kind == "FROM") continue
    if (sha != "") gsub(sha, "GIT_SHA", command)
    if (d in served) print "S " stage " " command
    else if (d in done) print "R " stage " " command
  }
  print "V " steps
}`.trim();

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
  '  --progress plain \\',
  '  --trace /workspace/trace.json \\',
  '  --metadata-file /workspace/metadata.json',
  // buildctl's metadata file is pretty-printed JSON, one key per line.
  'digest=$(grep -o \'"containerimage.digest": *"sha256:[0-9a-f]*"\' /workspace/metadata.json | head -n 1 | grep -o \'sha256:[0-9a-f]*\')',
  'test -n "$digest"',
  // The image is pushed. Nothing from here to the termination message may
  // fail the build: the worst a mistake below can do is upload a cache
  // nobody needed, or leave one for the next build to upload.
  'set +e',
  'cat > /workspace/steps.awk <<\'AWK\'',
  STEPS_AWK,
  'AWK',
  'ran=; served=; steps=unknown',
  'if awk -f /workspace/steps.awk /workspace/trace.json > /workspace/steps.txt 2>/dev/null \\',
  '    && grep -q \'^V [1-9]\' /workspace/steps.txt; then',
  '  steps=known',
  '  while IFS= read -r step; do',
  '    case "$step" in',
  '      \'R \'*|\'S \'*) token=$(printf \'%s\' "${step#? }" | sha256sum | cut -c1-12) ;;',
  '      *) continue ;;',
  '    esac',
  '    case "$step" in',
  '      \'R \'*) ran="$ran $token" ;;',
  '      *) served="$served $token" ;;',
  '    esac',
  '  done < /workspace/steps.txt',
  '  ran=${ran# }; served=${served# }',
  `  if [ "$(printf '%s' "$ran $served" | wc -w)" -gt ${CACHE_MAX_STEPS} ]; then steps=unknown; fi`,
  'fi',
  // Upload when a step ran that is not known to run on every build (see
  // settledCacheSteps), and whenever that cannot be told.
  'upload=no',
  'if [ "${CACHE_UPLOAD:-auto}" = always ] || [ "$steps" != known ]; then',
  '  upload=yes',
  'else',
  '  for token in $ran; do',
  '    case " ${CACHE_SETTLED_STEPS:-} " in *" $token "*) ;; *) upload=yes ;; esac',
  '  done',
  'fi',
  'cache=skipped',
  'if [ "$upload" = yes ]; then',
  '  say "uploading the layer cache"',
  // The same solve over the Pod's now warm store, with nothing to output:
  // no step runs again and the pushed image cannot change. The import
  // stays because layers the cache served are still lazy references to it.
  '  if timeout 300 buildctl-daemonless.sh build \\',
  '      --frontend dockerfile.v0 \\',
  '      --local context=/workspace/src \\',
  '      --local dockerfile=/workspace/src \\',
  '      --opt "filename=$DOCKERFILE" \\',
  '      --opt "build-arg:GIT_SHA=$GIT_SHA" \\',
  '      --import-cache "type=registry,ref=$CACHE_REF$REGISTRY_ATTRS" \\',
  '      --export-cache "type=registry,ref=$CACHE_REF,mode=max,image-manifest=true,oci-mediatypes=true$REGISTRY_ATTRS" \\',
  '      --progress plain > /workspace/cache-upload.log 2>&1; then',
  '    cache=done',
  '  else',
  '    cache=failed',
  '    say "the layer cache was not uploaded; the image is pushed and the build stands"',
  '    tail -n 15 /workspace/cache-upload.log | sed \'s/^/[buildkit] cache: /\'',
  '  fi',
  'else',
  '  say "layer cache not uploaded: nothing a later build can reuse was rebuilt"',
  'fi',
  // The termination message is capped at 4KiB and the kubelet keeps its
  // end, so the digest goes last. Without it the build has no result.
  '{',
  '  printf \'cache-upload=%s\\n\' "$cache"',
  '  if [ "$steps" = known ]; then printf \'cache-ran=%s\\ncache-served=%s\\n\' "$ran" "$served"; fi',
  '  printf \'%s\' "$digest"',
  '} > /dev/termination-log || exit 1',
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
  settledSteps = [],
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
    // `auto`: the script uploads the layer cache unless every step that ran
    // is in CACHE_SETTLED_STEPS. `always`: after every build.
    { name: 'CACHE_UPLOAD', value: cfg.buildkitCacheUpload || 'auto' },
    { name: 'CACHE_SETTLED_STEPS', value: settledSteps.join(' ') },
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

// What a build said about the layer cache, from its termination message or
// from the copy of it on the Job (CACHE_STEPS_ANNOTATION); null when there
// is nothing of the kind. `known` is false when the build could not tell
// which steps ran, in which case it uploaded and names none.
function cacheReport(text) {
  const lines = String(text || '').split('\n');
  const value = (key) => {
    const line = lines.find((l) => l.startsWith(`cache-${key}=`));
    return line === undefined ? null : line.slice(key.length + 7).trim();
  };
  const upload = value('upload');
  if (!['done', 'skipped', 'failed'].includes(upload)) return null;
  const tokens = (key) => {
    const list = value(key);
    return list === null ? null : list.split(/\s+/).filter((token) => CACHE_TOKEN_RE.test(token));
  };
  const ran = tokens('ran');
  const served = tokens('served');
  return { upload, known: Boolean(ran && served), ran: ran || [], served: served || [] };
}

function cacheReportText(report) {
  const lines = [`cache-upload=${report.upload}`];
  if (report.known) lines.push(`cache-ran=${report.ran.join(' ')}`, `cache-served=${report.served.join(' ')}`);
  return lines.join('\n');
}

function cacheReportFromPod(pod) {
  const status = pod?.status?.containerStatuses?.find((c) => c.name === CONTAINER);
  return cacheReport(status?.state?.terminated?.message);
}

// What the app's finished builds reported, each with when it finished.
// Builds from before the reports existed, and builds that could not tell
// which steps ran, say nothing here.
async function cacheHistory(cfg, clients, appId) {
  const list = await clients.batch.listNamespacedJob({
    namespace: cfg.buildkitNamespace,
    labelSelector: `app.kubernetes.io/managed-by=${MANAGED_BY},social.usernode.io/app-id=${appId},${ENGINE_LABEL}=${ENGINE}`,
  });
  const reports = [];
  for (const job of list?.items || []) {
    if (!jobSucceeded(job) || job.metadata?.deletionTimestamp) continue;
    const report = cacheReport(job.metadata?.annotations?.[CACHE_STEPS_ANNOTATION]);
    const at = Date.parse(job.status?.completionTime || '');
    if (report?.known && Number.isFinite(at)) reports.push({ ...report, at });
  }
  return reports;
}

// The steps that need no upload when they run, as far as the history
// shows: they ran more often than the cache served them, and they have
// already run in CACHE_CHANCES builds that uploaded it within the window.
// Everything else that runs causes an upload: a step the cache serves at
// least as often as it runs, a step nobody has reported, and a step that
// has not had its chances (or whose chances have aged out).
function settledCacheSteps(reports, now = Date.now()) {
  const count = (map, token) => map.set(token, (map.get(token) || 0) + 1);
  const ran = new Map();
  const served = new Map();
  const chances = new Map();
  for (const report of reports) {
    const here = new Set(report.ran);
    for (const token of here) count(ran, token);
    for (const token of new Set(report.served)) count(served, token);
    if (report.upload !== 'done' || now - report.at > CACHE_CHANCE_WINDOW_MS) continue;
    for (const token of here) count(chances, token);
  }
  return [...chances.keys()]
    .filter((token) => chances.get(token) >= CACHE_CHANCES && ran.get(token) > (served.get(token) || 0))
    .sort();
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

  // No history, or none that can be read, is a build that uploads the layer
  // cache if anything ran: what every build did before there was a choice.
  let settledSteps = [];
  if ((cfg.buildkitCacheUpload || 'auto') !== 'always') {
    try {
      settledSteps = settledCacheSteps(await cacheHistory(cfg, clients, app.id));
    } catch (err) {
      log.warn('kubernetes', 'BuildKit layer cache history lookup failed; this build uploads the cache', { appId: app.id, err: err.message });
    }
  }
  const inputSecretName = runtime.withSuffix(name, 'input');
  const cloneUrl = await runtime.getCloneUrl(repo.owner, repo.name);
  const body = jobManifest(cfg, runtime, {
    app, revision, environment, sessionId, dockerfile, name, tag, cacheRef, recipe, inputSecretName, settledSteps,
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
    const { digest, cache } = await waitForJob(cfg, runtime, clients, name, { onProgress });
    const imageRef = `${repository}@${digest}`;
    const annotations = { [DIGEST_ANNOTATION]: digest };
    // The next build of the app reads this; a build that reported nothing
    // (an older script) leaves nothing to read.
    if (cache) annotations[CACHE_STEPS_ANNOTATION] = cacheReportText(cache);
    if (cache?.upload === 'failed') {
      log.warn('kubernetes', 'BuildKit layer cache upload failed; the image is pushed and the next build tries again', { name, appId: app.id });
    }
    try {
      const k8s = kubernetesClient();
      await batch.patchNamespacedJob(
        { name, namespace, body: { metadata: { annotations } } },
        k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch)
      );
    } catch (err) {
      log.warn('kubernetes', 'BuildKit Job digest annotation not written', { name, err: err.message });
    }
    return {
      buildRef: `${namespace}/${name}`, imageRef, requestedTag: tag, phases: null, engine: ENGINE,
      cacheUpload: cache ? cache.upload : null,
    };
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
        return { digest, cache: cacheReportFromPod(pod) };
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
    STEPS_AWK, CACHE_STEPS_ANNOTATION, CACHE_CHANCES, CACHE_CHANCE_WINDOW_MS, CACHE_MAX_STEPS,
    cacheReport, cacheReportText, settledCacheSteps,
    resetUnavailable() { _unavailable = null; },
  },
};
