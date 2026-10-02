# C4 integration isolation

Production is outside this experiment. Do not change the default kubeconfig,
deployed infrastructure, databases, registry artifacts, ArgoCD applications or
deployment settings. Do not push the branch or deploy this refactor. All actual
test mutations require a **new disposable local fixture** verified before the
test starts. A namespace name or a loopback URL alone is not sufficient.

The harness currently supports one narrow fixture layout: local Docker-backed
kind, a new Docker PostgreSQL container, and a registry Pod with emptyDir storage
inside that kind cluster. Other layouts fail closed. Provisioning is not performed
by the test runner. The fixture provisioner is a separate, explicit local command.
Live preflight and the bounded C4 actual-resource scenarios passed on 1 October 2026.

C7 adds the fixed `test-preparation <fixture-directory>` command. Its runner and
each restarted worker repeat the same preflight. `preparationSource` must match
the public health app/revision/branch pinned by the provisioner; a missing value
fails before schema creation, and mismatches fail destination validation. The
[complete-path contract](complete-preparation-contract.md) lists all fixture
substitutions and evidence limits. This command uses actual clone, Build and
runtime services through staging and does not substitute successful observations.

## Required manifest

Set `KPACK_RECOVERY_TEST_CONFIG` to the dedicated fixture's `fixture.json` and
`PREVIEW_FLOW_TEST_DATABASE_URL` to its explicit database URL. Both are required;
neither `DATABASE_URL`, `SQL_CHECK_CONNECTION_URL`, the default kubeconfig nor
in-cluster credentials are a fallback. The fixture directory must be newly created
under Node's `os.tmpdir()`, named `preview-recovery-test-<UUID>`. A fresh version-4
UUID ties names, labels, credentials and destinations together.

The JSON contains the existing `config`, `repoUrl`, full `revision` and `runScript`,
plus an `isolation` object with these fields:

| Field | Required value / evidence |
| --- | --- |
| `version`, `fixtureId`, `createdAt` | Version 1, fresh UUID, UTC timestamp at whole-second precision **before** provisioning; at most 24 hours old. |
| `directory` | Absolute path to the new temporary directory. |
| `kubeconfigPath`, `kubeconfigSha256` | Its `kubeconfig` file and SHA-256 of those exact bytes. |
| `dockerHost`, `dockerDaemonId` | Explicit local Unix socket and expected daemon ID. No ambient Docker context/SSH/TCP endpoint. |
| `cluster.name`, `cluster.context` | `c4-preview-<UUID>` and `kind-c4-preview-<UUID>`. The shorter cluster name keeps its node hostname within Docker's 64-character limit; namespace/directory names keep the full prefix. |
| `cluster.server`, `cluster.uid` | Explicit `https://127.0.0.1:<port>` and kube-system namespace UID read from the new cluster. |
| `cluster.nodeContainerIds` | Full Docker IDs of its newly created kind nodes. |
| `namespace.name`, `namespace.uid` | `preview-recovery-test-<UUID>` and its new namespace UID. |
| `database.url` | `postgresql://recovery_test:<explicit-test-password>@127.0.0.1:<port>/preview_recovery_<UUID-without-hyphens>`. |
| `database.containerId`, `database.image`, `database.systemIdentifier` | Full new container ID, digest-pinned standard PostgreSQL image and `pg_control_system()` system identifier. |
| `registry.host` | `registry.preview-recovery-test-<UUID>.svc.cluster.local:5000`. |
| `registry.serviceUid`, `registry.podUid`, `registry.image` | Dedicated Service/Pod UIDs and digest-pinned standard registry image. |

The kubeconfig must contain exactly one expected cluster/context/user, matching
the recorded API server, with embedded CA, client certificate and key. Exec/auth
helpers, tokens, credential files, impersonation, proxies and insecure TLS are
rejected **before** SDK credential loading. Create kind with an explicitly supplied
dedicated kubeconfig path; do not let provisioning write the default kubeconfig.

Every node must have kind's `io.x-k8s.kind.cluster` label for this cluster. Docker
inspection proves the recorded API port belongs exclusively to its node on
loopback. The PostgreSQL container must be named `<cluster-name>-postgres`, carry
`social.usernode.io/recovery-fixture=<UUID>`, use the recorded image, and exclusively
publish its PostgreSQL port on loopback. All containers and their volumes must
postdate `createdAt`. Reused host data/configuration bind mounts are rejected;
only kind's read-only `/lib/modules` mount is permitted. Use new volumes or writable
container storage. Bootstrap the dedicated database/user in that new container;
the user needs privileges for the disposable schema and identity inspection.

The namespace and `recovery-builder` service account need the same fixture label
and fresh creation timestamps. The account must contain no registry/Git secret or
image-pull secret references. Use a public pinned fixture source and the local
test registry, not production credentials.

The registry Service is named `registry`, type ClusterIP, with only TCP port/target
5000. Its one ready registry Pod must match the pinned UID/image, fixture label and
`app=registry`. Use one emptyDir volume mounted at `/var/lib/registry`, no command,
arguments, environment, extra containers or remote-storage/proxy configuration.
Set `automountServiceAccountToken: false` to avoid an extra projected volume. Both
Endpoints and EndpointSlices must route only to that verified Pod UID/IP. Seed
the fixture builder and dependencies locally; namespace-local registry DNS/image
pulls must work for the controller, build Pods and kind nodes. No production
registry repositories or credentials may be used for fixture seeding.

In `config.kubernetes`, both namespaces must equal the fixture namespace and
`buildServiceAccount` must be `recovery-builder`. With
`<prefix> = <registry.host>/preview-recovery-<UUID>`:

- `repositoryPrefix` must be `<prefix>/images`.
- `cacheRepositoryPrefix` must be `<prefix>/cache`.
- `builderImage` must be `<prefix>/builder@sha256:<digest>`.

Keep node version/deadline and the remaining recipe settings explicit. Provision
compatible kpack into the new local cluster only. The production installation is
never a fixture. The fixture pins a successful public source revision. A deliberately unsupported
Node version produces a real build-phase failure against the same revision.
Paketo skips requested scripts missing from package.json, so a missing script
is not a reliable failure fixture.

## Admission to the test

`scripts/test-recoverable-preview-build.js` verifies the manifest, dedicated TLS
credentials, local Docker identities/ports/fresh storage, live cluster and
namespace UIDs, actual node membership, registry routing/storage, and PostgreSQL
system identifier/database/server address/port/start time. Kubernetes probes and
the PostgreSQL identity SELECT are read-only. No schema/Build/registry write happens
until the complete preflight returns successfully.

The test process repeats preflight before creating its schema. The interrupted
worker repeats it before claiming work, including the scoped database URL. Only
the generated `execution_<digits>` search-path option is accepted; connection
destination overrides are rejected. Every process receives explicit clients;
SDK defaults are never used. Worker/test environments retain only local process
essentials and the two explicit fixture inputs, removing ambient Kubernetes,
Docker, database, registry, proxy and Node preload variables.

Ordinary offline suites skip the actual-resource test. An explicitly requested
runner fails with exit 1 when inputs/proofs are missing or mismatched. Setting its
run flag directly cannot bypass preflight. Offline guard tests use injected
read-only observations and local temporary files; their success does not establish
actual fixture isolation or C4 integration evidence.

## Reproducible local provisioner

`scripts/kpack-local-fixture.js` supports Darwin ARM64 with Docker Desktop on an
**explicit local Unix socket**. It records a fresh UUID, creation boundary and
Docker daemon ID before provisioning. No Docker or Kubernetes context is selected
implicitly. Commands are:

```sh
node scripts/kpack-local-fixture.js init unix:///absolute/path/to/local/docker.sock
# Use exactly the new directory printed by init:
node scripts/kpack-local-fixture.js setup /absolute/path/to/preview-recovery-test-UUID
node scripts/kpack-local-fixture.js test /absolute/path/to/preview-recovery-test-UUID
node scripts/kpack-local-fixture.js test-runtime /absolute/path/to/preview-recovery-test-UUID
node scripts/kpack-local-fixture.js teardown /absolute/path/to/preview-recovery-test-UUID
```

Setup downloads checksum-verified kind 0.33.0 and crane 0.20.3 inside that
private temporary directory, copies the installed kubectl there, and downloads
kpack 0.17.2. It creates one dedicated kind node, one tmpfs-backed PostgreSQL 15.15
container, one labelled Docker network and one registry 2.8.3 Pod with emptyDir.
Resolved infrastructure image digests, physical IDs and credentials are recorded
in private fixture files. Default kubeconfig, host daemon settings and deployment
configuration are never edited. Public image reads require no ambient credentials.

It seeds a pinned ARM64 Paketo Noble builder into the local registry and derives
a fixture-only configuration with `CNB_INSECURE_REGISTRIES` set to exactly that
registry host. This is required by the [buildpack lifecycle](https://github.com/buildpacks/spec/blob/main/platform.md)
for local HTTP; it does not change production recipes or registry security.
Containerd DNS/HTTP configuration is changed only inside the new fixture node.
Kpack CRDs must reach Established before applying the lifecycle object. Builder
source digest and sample revision are constants in the provisioner; dependency
resolution remains non-hermetic.

Every bootstrap phase rechecks its recorded cluster/container identities. Resumed
setup refuses namespace/registry successors or replaced database storage. A
completed teardown cannot be reused; init must create another fresh fixture.
Setup/test logs and credential/configuration files remain in the private temporary
directory for inspection. Treat those files as local secrets, not repository inputs.

Teardown verifies daemon, exact container IDs, labels/names/images and creation
boundaries, network ownership/membership, volume creation and consumers **before
any removal**. It deletes by immutable IDs. Same-name successors and volumes with
unrelated consumers are refused. Missing recorded IDs are tolerated after partial
teardown without adopting replacements; repeat teardown is safe. It does not
prune images, other networks or other volumes. Shared base-image download caches
remain. Registry artifacts disappear with the owned node/emptyDir, not by remote
registry deletion. Fixture files/tooling/logs are retained.

## Actual evidence and limits

The isolated job now covers actual worker SIGKILL/reclaim, lost decision reply,
lost Build-create reply, a terminal build-phase failure, and creation arriving
after cleanup records absence. It checks the retained SQL cleanup obligation,
revisits the actual late Build, defers retirement while running, and preserves the
successor Build UID/output and stored serving-preview tuple. All three integration
tests passed without skips. The ledger records concrete UIDs/digests and log paths.

Delay and reply loss are injected at the client/service boundary; Builds, Pods,
completion/output and PostgreSQL persistence are real. Clone/checkout/runtime
preparation remains injected. This does not demonstrate real serving traffic,
runtime deployment/activation, arbitrary API-server timing or production fleet
compatibility. Offline guard tests are separate evidence. Admission stays
experimental; no caller migration, production rollout, generic executor or old
lock/timer removal is part of this fixture checkpoint.


C5's `test-runtime` job uses the same full live preflight and a dedicated runtime
image seeded into the fixture's own registry. Setup resolves and records the ARM64
Node 22.15.0-alpine source digest, copies it locally, and derives a non-root image;
that immutable local digest is the test input. Runtime-image destinations and
service account are checked before mutation. The subprocess/worker never obtains
ambient credentials or a default database connection. Only fixed test entry points
are selectable.

The runtime job separately demonstrates actual Secret/Service/Deployment creation,
controller Pods/Endpoints, HTTP health, worker interruption and UID-preserving
recovery, SQL persistence, foreground cleanup and successor protection. Its
clone/Build inputs and delayed POST/reply-loss timing are injected. The runtime
contract and ledger record precise evidence and retained-dependency limitations;
it does not extend C4's actual Build proof to a full production pipeline.

C6's fixed `test-release` job uses the same parent/child live preflight. Setup adds
`max_prepared_transactions=10` only to the new disposable PostgreSQL container,
so a real forced-drop blocker can be tested. It also appends the repository's
installed pure-JS `pg` client/dependencies to the dedicated non-root runtime image,
under `/opt/evidence/node_modules`, using fixture-local files and registry artifacts.
The extra digest must use the same verified dedicated registry/account. A verified
server address from PostgreSQL identity inspection connects test Pods to that
owned container; it is not an ambient database destination. Missing image/address
fails before C6 schema or resource creation. Existing fixture manifests remain
usable for other fixed jobs, while C6 requires its extra prerequisites.

```sh
node scripts/kpack-local-fixture.js test-release /absolute/path/to/preview-recovery-test-UUID
```

The job proves actual clone/database ownership, SQL-backed runtime health,
connections, delayed Pods, forced drop, interruption/restart and retained cleanup.
Build output/template selection and reply-loss/timing injections are identified
separately. It does not establish a complete actual kpack preparation path or
production compatibility. No default credentials, contexts or deployment settings
are changed; teardown uses the existing immutable ownership verification.

## C9 actual capture/browser-check Job

After normal fixture setup, provision the repository's capture image and run the
fixed checks entry point:

```sh
node scripts/kpack-local-fixture.js setup-checks /absolute/path/to/preview-recovery-test-UUID
node scripts/kpack-local-fixture.js test-checks /absolute/path/to/preview-recovery-test-UUID
```

`setup-checks` passes live preflight before building. It copies only named capture
sources into the private fixture directory, pins the ARM64 Node base digest,
builds an image labelled with the fixture UUID, and pushes only to the dedicated
registry's fixture `/capture` repository through a verified local forward. The
manifest records its immutable digest, namespace and service account; parent and
child refuse a missing marker or mismatched capture destination. No ambient Docker
config/kubeconfig/registry credentials are loaded.

Teardown verifies the exact recorded local image ID, UUID label and sole fixture
tag before deleting it. If setup died before saving that ID, only the exact tagged,
labelled fixture image can be adopted for removal. Base-image caches stay. Actual
Chromium assertions, PNGs, Jobs/logs and SQL settlement are distinguished from
manifest, internal HTTP transport, unauthenticated-user and timing substitutions
in the C9 contract. The fixture app has no unit-suite script; no actual unit-suite
Job proof is claimed. Local integration does not establish production compatibility.
