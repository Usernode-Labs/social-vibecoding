# PostgreSQL-only test ownership

The focused runner and directly invoked PostgreSQL suites must verify disposable
ownership before creating schemas, roles, databases or work records. An explicit
URL, test flag, loopback hostname or generated schema name is insufficient.
This corrects the PostgreSQL-only gap introduced during canonical CI consolidation;
it changes test infrastructure, not production admission or execution.

## Required proof

`tests/lib/disposable-postgres.js` checks a fresh, private, current-user-owned
manifest inside a dedicated temporary directory. It records the fixture UUID,
creation time, explicit local Docker socket/daemon, full container ID, pinned
PostgreSQL image digest, database URL and PostgreSQL system identifier.

Before connecting, the verifier requires the exact database/user/password/port,
matching daemon, running container, fixture label/name/image/creation time and
exclusive IPv4 loopback binding. Data must use exactly the declared tmpfs;
bind mounts, persistent volumes and additional storage are rejected. Docker may
report tmpfs only in `HostConfig.Tmpfs`; an empty `Mounts` list does not waive the
storage check.

A bounded, read-only PostgreSQL query then verifies database name, physical server
identifier, internal container address/port and postmaster start time. That
connection closes on success or failure. Only then may test mutations begin.
Verification is repeated at each independent fixture/child-process entry; there is
no environment variable that asserts the database is already trusted.

The shared schema factory and inline database fixtures enforce this independently
of the focused runner. Clone tests verify the base fixture before using its
maintenance database, and their child processes reverify before clone operations.
Only the original URL or the generated `execution_*` schema option is accepted;
maintenance connections require explicit permission and retain the same endpoint
and credentials. Removing the Underway suite's default database probe closes its
ambient destination path.

## Running and retiring the fixture

The test-only `scripts/preview-postgres-fixture.js` supports:

```sh
node scripts/preview-postgres-fixture.js create unix:///path/to/local/docker.sock
node scripts/preview-postgres-fixture.js run /absolute/path/to/fixture.json node scripts/test-preview-flow.js
node scripts/preview-postgres-fixture.js run /absolute/path/to/fixture.json node --test tests/preview-admission.test.js
node scripts/preview-postgres-fixture.js teardown /absolute/path/to/fixture.json
```

Creation uses a random credential/database, pinned image, labelled new container,
loopback-only port and tmpfs. A manifest pointer can be supplied as a second create
argument; it is saved before readiness verification so setup failures retain an
owned cleanup locator. Teardown verifies daemon and exact resource ownership before
deleting; repeated teardown does not delete by name. Configuration/evidence remain
private in the temporary directory.

The runner verifies before spawning suites, passes the manifest, and sets all test
and maintenance URLs to the verified destination. Its environment allowlist removes
ambient PostgreSQL defaults, application database URLs, Kubernetes contexts and
cloud credentials. Direct suites still require their own preflight. CI provisions
this container instead of trusting an anonymous service URL; SQL validation also
runs through the verified fixture wrapper. GitHub execution remains unverified
until a separately authorized push.

## Actual-resource boundary and limits

The existing kpack fixture path still verifies its dedicated kubeconfig, cluster,
namespace, registry, Docker containers and physical PostgreSQL identity. A kpack
configuration selects that complete preflight, including when an injected worker
uses its database; it cannot fall back to PostgreSQL-only proof. No cluster or
registry check has been removed or weakened.

The proof assumes exclusive administration of the owned local fixture throughout
the test. It is not protection against a malicious host administrator swapping
resources between verification and a later connection. Failed/missing verification
stops tests; it never falls back to production or a default local database. This
checkpoint proves real PostgreSQL admission and recovery tests with external
operations injected. It does not provide new actual Kubernetes/build evidence or
production compatibility.

## Local evidence

On 2 October, the final focused runner passed **918 tests, zero failures/skips**
using a newly provisioned, ownership-verified PostgreSQL container. Direct-suite
rejection subprocesses, real admission/recovery mutations and false physical-server
identity rejection (unchanged schema count) all passed. Affected-suite mapping
passed **482 tests**, with three actual kpack tests intentionally skipped in this
PostgreSQL-only fixture. Verified-wrapper SQL validation passed **3,214 statements /
4,109 static variants**. All three setup/test containers were retired by exact
identity; repeated teardown and explicit absence checks passed. Logs and source
hashes remain private in the local ledger's fixture evidence directory.
