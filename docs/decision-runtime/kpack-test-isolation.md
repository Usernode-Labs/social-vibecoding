# C4 integration isolation

Production is outside this experiment. Do not change the default kubeconfig,
deployed infrastructure, databases, registry artifacts, ArgoCD applications or
deployment settings. Do not push the branch or deploy this refactor. All actual
test mutations require a **new disposable local fixture** verified before the
test starts. A namespace name or a loopback URL alone is not sufficient.

The harness currently supports one narrow fixture layout: local Docker-backed
kind, a new Docker PostgreSQL container, and a registry Pod with emptyDir storage
inside that kind cluster. Other layouts fail closed. Provisioning is not performed
by the test runner. No local cluster or fixture has yet been provisioned for C4.

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
| `cluster.name`, `cluster.context` | `preview-recovery-test-<UUID>` and `kind-preview-recovery-test-<UUID>`. |
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
never a fixture. A successful source revision and a predictable failing revision
are still needed for C4's actual-resource scenarios.

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

## Current blocker

No new local kind cluster, dedicated kubeconfig/isolation manifest, new container
database or local registry fixture is available. No integration mutations ran.
The previously used native PostgreSQL instance is **not** accepted by this new
harness. Establish and verify the above local fixture before resuming C4. Actual
terminal failures, delayed creation and successor-preserving retirement remain
pending alongside the unrun worker-interruption/lost-acknowledgment job.
