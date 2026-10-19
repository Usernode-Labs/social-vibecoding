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
// cache upload" below. The one cache apps share is a ready-made starter's,
// which only the platform's own build of that starter writes; see "The
// starter's shared cache" below. The daemon runs
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
// The starter's shared cache. Every app made from one ready-made starter
// (services/app-templates.js) gets the same package files
// (services/template.js), so its image's dependency installs are the same
// steps as every other copy's. Against its own cache alone, which a new
// app does not have yet, each new app ran them cold, inside the build its
// "Preparing it to run…" waits on. So a build of an app whose row names a
// ready-made starter (apps.template) imports that starter's cache too,
// `<cache prefix>/starter-<id>:buildkit-cache`, after its own. One build
// writes it: the app's first, of the commit services/app-creator.js has
// just made from the starter (`starterTree`). That build always uploads,
// to the app's cache and the starter's in one run. Every other build only
// reads it, so it holds what the starter itself builds and never one
// app's changes. The build that writes it runs nothing an app controls:
// the Dockerfile and the package files are the platform's, and a layer is
// only ever served to a step whose inputs are the same.
// A starter whose cache does not exist yet is what an app's own cache is
// on its first build: BuildKit notes the missing ref and builds.
// BUILDKIT_STARTER_CACHE=off goes back to per-app caches only.
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
const appTemplates = require('./app-templates');

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
  //
  // The check and the source fetch run side by side (0.8 s of daemon start
  // beside 2.7 s of fetch, measured in October 2026), and the verdict is
  // read before the fetch's: a node that cannot run the daemon exits 75
  // whether or not the fetch worked, and nothing is built before both are
  // in. The fetch runs in a subshell joined by `&&`, since `set -e` does
  // not apply to a command whose status `||` reads.
  '( buildctl-daemonless.sh debug workers >/workspace/preflight.log 2>&1 ) &',
  'preflight=$!',
  'say "fetching source $GIT_SHA"',
  'fetched=0',
  '( cd /workspace/repo \\',
  '  && git init -q \\',
  '  && git -c protocol.version=2 fetch -q --depth 1 "$REPO_URL" "$GIT_SHA" \\',
  '  && git read-tree FETCH_HEAD \\',
  '  && git checkout-index -a -f --prefix=/workspace/src/ ) || fetched=$?',
  'if ! wait "$preflight"; then',
  '  say "buildkitd cannot run here"',
  '  tail -n 40 /workspace/preflight.log',
  '  exit 75',
  'fi',
  'if [ "$fetched" -ne 0 ]; then say "fetching source failed"; exit "$fetched"; fi',
  'cd /workspace',
  'rm -rf /workspace/repo',
  // The starter's shared cache (see the header): read by both runs below
  // when STARTER_CACHE_REF names one, written by the upload only when
  // STARTER_CACHE_EXPORT=yes. Each is spliced in as `${x:+--flag "$x"}`,
  // which is nothing at all when x is empty.
  'starter_import=; starter_export=',
  'if [ -n "${STARTER_CACHE_REF:-}" ]; then',
  '  starter_import="type=registry,ref=$STARTER_CACHE_REF$REGISTRY_ATTRS"',
  '  if [ "${STARTER_CACHE_EXPORT:-}" = yes ]; then',
  '    starter_export="type=registry,ref=$STARTER_CACHE_REF,mode=max,image-manifest=true,oci-mediatypes=true$REGISTRY_ATTRS"',
  '  fi',
  'fi',
  'say "building $DOCKERFILE -> $IMAGE_TAG"',
  'buildctl-daemonless.sh build \\',
  '  --frontend dockerfile.v0 \\',
  '  --local context=/workspace/src \\',
  '  --local dockerfile=/workspace/src \\',
  '  --opt "filename=$DOCKERFILE" \\',
  '  --opt "build-arg:GIT_SHA=$GIT_SHA" \\',
  '  --output "type=image,name=$IMAGE_TAG,push=true$REGISTRY_ATTRS" \\',
  '  --import-cache "type=registry,ref=$CACHE_REF$REGISTRY_ATTRS" ${starter_import:+--import-cache "$starter_import"} \\',
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
  // settledCacheSteps), whenever that cannot be told, and always from the
  // build that writes the starter's shared cache.
  'upload=no',
  'if [ "${CACHE_UPLOAD:-auto}" = always ] || [ "$steps" != known ] || [ -n "$starter_export" ]; then',
  '  upload=yes',
  'else',
  '  for token in $ran; do',
  '    case " ${CACHE_SETTLED_STEPS:-} " in *" $token "*) ;; *) upload=yes ;; esac',
  '  done',
  'fi',
  'cache=skipped',
  'if [ "$upload" = yes ]; then',
  '  say "uploading the layer cache"',
  '  if [ -n "$starter_export" ]; then say "and the starter\'s shared cache, $STARTER_CACHE_REF"; fi',
  // The same solve over the Pod's now warm store, with nothing to output:
  // no step runs again and the pushed image cannot change. The imports
  // stay because layers a cache served are still lazy references to it.
  '  if timeout 300 buildctl-daemonless.sh build \\',
  '      --frontend dockerfile.v0 \\',
  '      --local context=/workspace/src \\',
  '      --local dockerfile=/workspace/src \\',
  '      --opt "filename=$DOCKERFILE" \\',
  '      --opt "build-arg:GIT_SHA=$GIT_SHA" \\',
  '      --import-cache "type=registry,ref=$CACHE_REF$REGISTRY_ATTRS" ${starter_import:+--import-cache "$starter_import"} \\',
  '      --export-cache "type=registry,ref=$CACHE_REF,mode=max,image-manifest=true,oci-mediatypes=true$REGISTRY_ATTRS" ${starter_export:+--export-cache "$starter_export"} \\',
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

// The shared layer cache of the ready-made starter the app was made from
// (see "The starter's shared cache"), as `{ id, ref }`; null when it was
// made from none, or BUILDKIT_STARTER_CACHE is off.
function starterCache(cfg, runtime, app) {
  if (cfg.buildkitStarterCache === false) return null;
  const id = app?.template;
  if (!appTemplates.isReadyMade(id)) return null;
  const repository = `starter-${runtime.dnsName(id)}`;
  // Beside the apps' own cache repositories, which are named by slug. A
  // slug ends in a random suffix (app-manifest buildAppSlug), so none
  // reads like this; an old one that did keeps its cache to itself.
  if (repository === runtime.dnsName(app.slug)) return null;
  return { id, ref: `${cfg.cacheRepositoryPrefix}/${repository}:buildkit-cache` };
}

function jobManifest(cfg, runtime, {
  app, revision, environment, sessionId, dockerfile, name, tag, cacheRef, recipe, inputSecretName,
  settledSteps = [], starterCacheRef = null, starterExport = false,
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
    // The starter's shared cache: imported when named, and uploaded to
    // with the app's own when STARTER_CACHE_EXPORT is `yes`.
    { name: 'STARTER_CACHE_REF', value: starterCacheRef || '' },
    { name: 'STARTER_CACHE_EXPORT', value: starterCacheRef && starterExport ? 'yes' : '' },
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
//
// `app.template` names the starter the app was made from, if any, and
// `starterTree` says the revision is that starter as the platform has just
// generated it, which makes this the build that writes the starter's shared
// cache (see the header). Only the caller that made the commit can say so.
async function createBuild(config, params, runtime) {
  const started = await startBuild(config, { ...params, dockerfile: selectDockerfile(config, params.sourceDir) }, runtime);
  return finishBuild(started, { onProgress: params.onProgress || null }, runtime);
}

// The first half of createBuild: the Secret and the Job, or an earlier
// build of the same revision to reuse. Returns the handle finishBuild waits
// on, and cancelBuild removes. `dockerfile` is the one the tree carries
// (selectDockerfile), or the one a caller expects it to carry when it
// starts the build before it has the tree (services/kubernetes.js
// startEarlyBuild); that caller checks the guess against the tree before it
// waits, and cancels when it was wrong.
async function startBuild(config, {
  app, revision, environment, sessionId, dockerfile, starterTree = false,
}, runtime) {
  if (!/^[a-f0-9]{40}$/i.test(revision || '')) {
    throw new Error('Kubernetes builds require a full 40-character Git commit SHA');
  }
  const repo = repoOwnerAndName(app.repo_url);
  if (!repo) throw new Error('Kubernetes builds require an HTTPS GitHub repository URL');
  const cfg = requireConfig(config);
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
      revision, dockerfile, cfg, name: previous.job.metadata.name, createdHere: false,
      result: {
        buildRef: `${cfg.buildkitNamespace}/${previous.job.metadata.name}`,
        imageRef: `${repository}@${previous.digest}`, requestedTag: tag, phases: [], reused: true, engine: ENGINE,
      },
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
  const starter = starterCache(cfg, runtime, app);
  const starterExport = Boolean(starter && starterTree);
  const inputSecretName = runtime.withSuffix(name, 'input');
  const cloneUrl = await runtime.getCloneUrl(repo.owner, repo.name);
  const body = jobManifest(cfg, runtime, {
    app, revision, environment, sessionId, dockerfile, name, tag, cacheRef, recipe, inputSecretName, settledSteps,
    starterCacheRef: starter ? starter.ref : null, starterExport,
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
  // No Job of ours will own the Secret when the create is refused or never
  // gets a turn, so its clone credential goes before the build fails.
  const deleteInputSecret = () => runtime.deleteIfPresent(core, 'deleteNamespacedSecret', inputSecretName, namespace)
    .catch((err) => log.warn('kubernetes', 'BuildKit input Secret cleanup failed', { name: inputSecretName, err: err.message }));
  const createDeadline = Date.now() + 60000;
  // Whether this call made the Job, rather than finding one an earlier
  // attempt of the same name made: only a Job it made is its to cancel.
  let createdHere = false;
  while (true) {
    try {
      created = await batch.createNamespacedJob({ namespace, body });
      createdHere = true;
      break;
    } catch (err) {
      if (!isConflict(err)) {
        await deleteInputSecret();
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
      if (Date.now() >= createDeadline) {
        await deleteInputSecret();
        throw new Error(`Timed out waiting to recreate BuildKit Job ${name}`);
      }
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
  return {
    revision, dockerfile, cfg, name, createdHere, inputSecretName, repository, tag, appId: app.id,
    starter: starter ? { starter: starter.id, export: starterExport } : null,
  };
}

// The second half: wait for the Job, then record its result on it.
async function finishBuild(handle, { onProgress = null } = {}, runtime) {
  if (handle.result) return handle.result;
  const { cfg, name, repository, tag, appId } = handle;
  const namespace = cfg.buildkitNamespace;
  const clients = runtime.getClients();
  const { batch } = clients;
  try {
    const clock = stepClock();
    const { digest, cache } = await waitForJob(cfg, runtime, clients, name, { onProgress, clock });
    const imageRef = `${repository}@${digest}`;
    const annotations = { [DIGEST_ANNOTATION]: digest };
    // The next build of the app reads this; a build that reported nothing
    // (an older script) leaves nothing to read.
    if (cache) annotations[CACHE_STEPS_ANNOTATION] = cacheReportText(cache);
    if (cache?.upload === 'failed') {
      log.warn('kubernetes', 'BuildKit layer cache upload failed; the image is pushed and the next build tries again', { name, appId });
    }
    // Not waited for: the deploy needs the digest, which is in hand. The
    // annotations serve later builds (image reuse, the cache history), and
    // both readers fall back to the Pod's termination message while the Job
    // keeps it, so a patch that lands late, or never, loses nothing.
    try {
      const k8s = kubernetesClient();
      batch.patchNamespacedJob(
        { name, namespace, body: { metadata: { annotations } } },
        k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch)
      ).catch((err) => log.warn('kubernetes', 'BuildKit Job digest annotation not written', { name, err: err.message }));
    } catch (err) {
      log.warn('kubernetes', 'BuildKit Job digest annotation not written', { name, err: err.message });
    }
    // `steps`: the slowest steps as BuildKit timed them (stepClock), for a
    // caller that records where a build went (services/app-creator.js).
    // `starterCache`: which starter's shared cache it read, and whether it
    // also wrote it (in the upload `cacheUpload` reports on).
    return {
      buildRef: `${namespace}/${name}`, imageRef, requestedTag: tag, phases: null, engine: ENGINE,
      steps: clock.slowest(SLOWEST_STEPS_KEPT), cachedSteps: clock.cached,
      cacheUpload: cache ? cache.upload : null,
      starterCache: handle.starter,
    };
  } catch (err) {
    await runtime.deleteIfPresent(batch, 'deleteNamespacedJob', name, namespace, { propagationPolicy: 'Background' })
      .catch((cleanupErr) => log.warn('kubernetes', 'Failed BuildKit Job cleanup failed', { name, err: cleanupErr.message }));
    throw err;
  }
}

// A started build nobody will wait for: its Job, and with it the Pod and
// the input Secret it owns, go now, and the Secret by name in case its owner
// reference was never set. Only a Job this start made is removed; one it
// found (an earlier attempt of the same name, which may still be waiting on
// it) and a reused build are left alone. Never throws.
async function cancelBuild(handle, runtime) {
  if (!handle || handle.result || !handle.createdHere) return false;
  const namespace = handle.cfg.buildkitNamespace;
  const { batch, core } = runtime.getClients();
  await runtime.deleteIfPresent(batch, 'deleteNamespacedJob', handle.name, namespace, { propagationPolicy: 'Background' })
    .catch((err) => log.warn('kubernetes', 'Cancelled BuildKit Job cleanup failed', { name: handle.name, err: err.message }));
  await runtime.deleteIfPresent(core, 'deleteNamespacedSecret', handle.inputSecretName, namespace)
    .catch((err) => log.warn('kubernetes', 'Cancelled BuildKit input Secret cleanup failed', { name: handle.inputSecretName, err: err.message }));
  return true;
}

// Which Dockerfile the app's newest BuildKit build used, as its Job's
// DOCKERFILE says; null when it has none, or names a file this platform
// would not pick. What an early start (services/kubernetes.js
// startEarlyBuild) expects the next tree to carry.
async function previousDockerfile(config, appId, runtime) {
  const cfg = config.kubernetes;
  const { batch } = runtime.getClients();
  const list = await batch.listNamespacedJob({
    namespace: cfg.buildkitNamespace,
    labelSelector: `app.kubernetes.io/managed-by=${MANAGED_BY},social.usernode.io/app-id=${appId},${ENGINE_LABEL}=${ENGINE}`,
  });
  const jobs = (list?.items || []).slice()
    .sort((a, b) => Date.parse(b.metadata?.creationTimestamp || 0) - Date.parse(a.metadata?.creationTimestamp || 0));
  for (const job of jobs) {
    const env = job.spec?.template?.spec?.containers?.find((c) => c.name === CONTAINER)?.env || [];
    const value = env.find((e) => e.name === 'DOCKERFILE')?.value;
    if (value) return (cfg.buildkitDockerfiles || []).includes(value) ? value : null;
  }
  return null;
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

// Where a build's time went, in BuildKit's own words (#4895). Plain progress
// names each step on its first line (`#9 [css 3/7] RUN npm ci`) and closes
// it with its duration (`#9 DONE 6.2s`, or `#9 CACHED` for a cache hit).
// Those durations, not the gaps between lines, are the account: the stages
// run side by side, and exporting the image and the cache, which a cold
// first build pays for, print no step counter at all.
const STEP_NAME_MAX = 60;
const SLOWEST_STEPS_KEPT = 6;
function stepClock() {
  const names = new Map();
  const closed = new Set();
  const done = [];
  let cached = 0;
  return {
    line(raw) {
      const m = /^#(\d+) (.+)$/.exec(String(raw || '').trim());
      if (!m) return;
      const [, id, rest] = m;
      const finished = /^DONE (\d+(?:\.\d+)?)s$/.exec(rest);
      if (finished || rest === 'CACHED') {
        if (closed.has(id)) return;
        closed.add(id);
        if (!finished) cached += 1;
        else if (names.has(id)) done.push({ name: names.get(id), ms: Math.round(Number(finished[1]) * 1000) });
        return;
      }
      if (!names.has(id) && !/^(ERROR|CANCELED)\b/.test(rest)) {
        names.set(id, rest.length > STEP_NAME_MAX ? `${rest.slice(0, STEP_NAME_MAX - 1)}…` : rest);
      }
    },
    slowest(n) {
      return done.slice().sort((a, b) => b.ms - a.ms).slice(0, n);
    },
    get cached() { return cached; },
  };
}

// What a Pod's own container status says of the build: its digest and
// cache report once the container has exited 0, null while it runs or when
// it failed (the Job's failure, read as before, reports that).
//
// This is the termination message the Job's Pod has always been read for,
// only without waiting for the Job controller to agree. A container that
// exited 0 ran the script to its end, which writes the message after the
// image is pushed and exits non-zero when it cannot. It is the channel
// the platform has always trusted for the digest; reading it from the Pod
// rather than after the Job agrees neither widens nor narrows that.
// The Job's verdict lagged the container by about three seconds (October
// 2026: the kubelet moving the Pod to Succeeded, then the Job controller,
// then this loop's poll).
function finishedPod(pod, name) {
  const code = exitCodeFromPod(pod);
  if (code !== 0) return null;
  const digest = digestFromPod(pod);
  if (!digest) throw new Error(`BuildKit Job ${name} finished without an image digest`);
  return { digest, cache: cacheReportFromPod(pod) };
}

// The script's last line. Seen in the log, it only says when to look: a
// build's own output shares the stream and can print it too, so the result
// is still read from the Pod's status (finishedPod), and a look that finds
// the container running costs one read and nothing else.
const PUSHED_LINE_RE = /^\[buildkit\] pushed /;
// How often the Pod is read once the log says the build has ended, and for
// how long after the last such sign.
const SETTLE_POLL_MS = 200;
const SETTLE_WINDOW_MS = 10000;

async function waitForJob(cfg, runtime, clients, name, { onProgress = null, clock = null } = {}) {
  const namespace = cfg.buildkitNamespace;
  const { batch, core } = clients;
  const deadline = Date.now() + (cfg.activeDeadlineSeconds + 60) * 1000;
  // Set when the log says the build has ended (its last line, or the log
  // stream closing): the loop then reads the Pod every SETTLE_POLL_MS.
  let endedAt = 0;
  let streamEnded = false;
  let wake = null;
  const signalEnd = () => { endedAt = Date.now(); if (wake) wake(); };
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
        if (PUSHED_LINE_RE.test(clean.trim())) signalEnd();
        if (clock) { try { clock.line(clean); } catch { /* observer only */ } }
        if (!report) return;
        const image = progressFromLine(clean);
        if (image) { try { onProgress(image); } catch { /* observer only */ } }
      });
      // A followed log ends when the container does (or when the API
      // server drops it, which costs one look at the Pod).
      sink.on('end', () => { streamEnded = true; signalEnd(); });
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
        if (!digest) throw new Error(`BuildKit Job ${name} finished without an image digest`);
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
      // The container's own status, ahead of the Job's. Read on every tick
      // while no log is followed or the followed one has closed (nothing
      // would say when to look), and after the log has said the build
      // ended; otherwise the follow says when.
      const settling = endedAt && Date.now() - endedAt < SETTLE_WINDOW_MS;
      if (podName && (settling || !following || streamEnded)) {
        const pod = await core.readNamespacedPod({ name: podName, namespace }).catch(() => null);
        const done = pod ? finishedPod(pod, name) : null;
        if (done) return done;
      }
      const pause = endedAt && Date.now() - endedAt < SETTLE_WINDOW_MS ? SETTLE_POLL_MS : POLL_MS;
      await new Promise((resolve) => {
        const timer = setTimeout(finish, pause);
        function finish() { clearTimeout(timer); wake = null; resolve(); }
        wake = finish;
      });
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
  startBuild,
  finishBuild,
  cancelBuild,
  previousDockerfile,
  deleteBuilds,
  deleteFailedBuilds,
  selectEngine,
  selectDockerfile,
  laneEnabled,
  unavailableReason,
  noteUnavailable,
  _forTest: {
    BUILD_SCRIPT, PREFLIGHT_EXIT, UNAVAILABLE_MEMO_MS, jobManifest, recipeOf, progressFromLine, stepClock, digestFromPod, exitCodeFromPod,
    repoOwnerAndName, requireConfig, finishedPod, POLL_MS, SETTLE_POLL_MS, SETTLE_WINDOW_MS,
    STEPS_AWK, CACHE_STEPS_ANNOTATION, CACHE_CHANCES, CACHE_CHANCE_WINDOW_MS, CACHE_MAX_STEPS,
    cacheReport, cacheReportText, settledCacheSteps, starterCache,
    resetUnavailable() { _unavailable = null; },
  },
};
