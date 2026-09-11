# Kubernetes runtime operations

Use this runbook when `APP_RUNTIME=kubernetes`. The standalone Compose and
host-deployer instructions in `README.md` and `SELF-HOSTING.md` describe the
Docker installation. Kubernetes platform, worker, and capture images have no
Docker daemon or socket. Talos workloads are observed through Kubernetes APIs.

## Ownership and releases

The `Build Kubernetes images` workflow builds the platform, worker and capture
Dockerfiles in CI and publishes one OCI Helm chart containing all three image
digests. `main` produces the stable `0.1.*` releases tracked by Argo CD. The
platform's own release uses this workflow; generated child apps use kpack and
Paketo from exact Git revisions. Child-app Dockerfiles are not executed by kpack.

Argo owns the platform Deployment, database, namespaces, service accounts and
runtime permissions. The platform owns generated apps, previews, workers and
check Jobs. Keep each change with its owner; source commits do not themselves
change the cluster. Review the normal release/GitOps diff before deployment.

See the [platform chart](../deploy/helm/social-vibecoding-platform/README.md)
for configuration and the `infra/prototype/bare-metal-platform` runbooks for
cluster foundation and database operations. Read the installed image and Argo
revision when comparing source behavior with a live failure.

## Shared app and preview TLS

Generated apps and previews share the installation-owned TLS Secret named by
`APP_TLS_SECRET_NAME` (default `social-apps-wildcard-tls`) in `APP_NAMESPACE`.
Provision a trusted wildcard covering `*.USERNODE_APPS_DOMAIN` before deploying
this runtime version. The foundation chart owns its Certificate and DNS-01
renewal. App Ingresses have no certificate issuer annotation; ordinary preview
rebuilds, failed-start cleanup and idle teardown neither request certificates
nor delete TLS Secrets. An installation can also supply an existing wildcard
Secret with the same ownership and coverage contract.

This is a rollout prerequisite, not an optional per-host fallback. Deploying
the runtime before the Secret is ready can leave new/rebuilt previews without
working HTTPS even when their Pods are Ready. Existing Ingresses keep their old
TLS references until reconciled or migrated. The infra runbook
`docs/23-social-vibecoding-shared-tls.md` includes a read-only migration planner,
issuance-limit recovery and explicit retirement of legacy Certificates.

## HTTP keep-alive ordering

The platform server (including self-previews) and newly scaffolded Node apps
set `server.keepAliveTimeout` to 75 seconds. This gives the ingress's 60-second
upstream idle timeout a 15-second margin to retire unused connections before
Node closes them. Preserve this ordering if the ingress timeout changes.
Node's default keep-alive buffer remains in effect; request and header timeouts
are separate and unchanged.

The platform setting takes effect when the updated server is deployed. Existing
child-app repositories and previews built from older commits retain their own
server code; changing the scaffold does not retrofit them.

## Read-only inventory and logs

These examples use the organization namespace and Deployment names. Substitute
the configured names for another installation. Resource names come from API
inventory; a Docker container ID or old single-server name is not a Pod name.

```sh
kubectl -n social-platform get deployment social-vibecoding
kubectl -n social-platform logs deployment/social-vibecoding -c platform --tail=200
kubectl -n social-apps get deployments,pods,services,ingresses
kubectl -n social-workers get deployments,pods,jobs,pvc
kubectl -n social-builds get builds.kpack.io,pods
kubectl -n social-builds get resourcequota
```

For one preview or worker, select `social.usernode.io/session-id=<session id>`.
For one application, select `social.usernode.io/app-id=<app id>`. For example:

```sh
kubectl -n social-workers get pods -l social.usernode.io/session-id=42
kubectl -n social-apps get pods -l social.usernode.io/session-id=42
```

Once the inventory gives the actual Pod name:

```sh
kubectl -n social-apps logs POD_NAME -c app --tail=200
kubectl -n social-apps logs POD_NAME -c app --previous --tail=200
kubectl -n social-workers logs WORKER_POD_NAME -c worker --tail=200
kubectl -n social-workers describe pod WORKER_POD_NAME
```

`--previous` reads the preceding container incarnation in that Pod; it cannot
recover an already deleted Pod. Inspect current and previous termination
reasons, restart counts, scheduling conditions and readiness together. An old
ready replica can still serve while the desired image is failing to start.
ResourceQuota reports reservations and object counts, not measured CPU or
memory consumption. Do not substitute Docker host statistics for cluster usage.

Capture Jobs default to an 8-CPU / 4Gi limit for eight concurrent browser groups,
with 1 CPU / 3Gi requested. The foundation worker LimitRange must allow at least
8 CPUs per container. `CAPTURE_CPUS`, `CAPTURE_MEMORY` and `TEST_CONCURRENCY`
override these settings on the platform; keep CPU capacity aligned with browser
concurrency when tuning them. CPU requests are scheduling reservations, so the
larger limit allows bursts but does not guarantee eight idle cores. Check
historical CPU throttling as well as completion: a successful Job can still
produce timing-sensitive assertion failures under CPU contention. Unit-suite
and coding-worker resource settings are independent.

Self-app previews (`USERNODE_ENV=staging`) do not build worker images, inspect
Docker or Kubernetes workloads, or read the parent's deployment status. Their
status API reports `runtimeKind: preview` and `runtimeAvailable: false`; fleet
counters are null and the UI labels runtime status unavailable. Cloned app and
session rows do not establish live workload readiness. Preview isolation does
not require forwarding runtime credentials or a Kubernetes service-account token.

The authorized `usernode-debug containers` and `usernode-debug logs <name>`
interfaces accept managed runtime names such as `sv-worker-s42` and
`sv-preview-7-s42`. Their inventory includes readiness but leaves CPU/memory
usage null when measured usage is unavailable.

## Build and startup failures

Find the kpack lifecycle Pod through the Build's `status.podName`, then inspect
the init-container names and logs for the failing phase:

```sh
kubectl -n social-builds get build BUILD_NAME -o jsonpath='{.status.podName}{"\n"}'
kubectl -n social-builds get pod BUILD_POD_NAME -o jsonpath='{.spec.initContainers[*].name}{"\n"}'
kubectl -n social-builds logs BUILD_POD_NAME -c build --tail=200
```

The runtime captures bounded, redacted build and preview failure logs before
cleanup. Once the Pod is deleted, use the persisted build/check failure and
platform diagnostic log. Retention and its read-only preview are documented in
[kpack Build retention](kpack-build-retention.md). Build diagnostics need `get`
on `pods` and `pods/log` in `social-builds`; the foundation owns those grants.

Worker setup reports clone/checkout phases before readiness. A fatal setup
marker, scheduling problem or admission failure is a bootstrap failure, before
agent dispatch. Worker readiness requires the container-local bootstrap marker;
Deployment availability by itself is not enough. Turn OOM attribution uses Pod
termination evidence from the current turn, including a container restart.

Database connection exhaustion is an infrastructure error, not a failing app
diff. Check the configured database Service and namespace. The cluster runtime
uses networked PostgreSQL clients; do not run `docker exec usernode-db` on a
cluster node or assume the historical standby is the active writer.

## Platform deployment reporting

`/api/version` and admin status observe the platform Deployment. The chart
grants only `get` on that Deployment. Rollout, failed, paused and unavailable
states are distinct; API failure is not reported as an idle, healthy rollout.
The response's `scope: rollout` excludes image build and chart publication.
Use the source repository's `Build Kubernetes images` workflow for those stages
and Argo CD for chart sync/migration-hook failures before a Deployment update.

Self-app merges trigger the normal GitHub workflow. The cluster does not use
the host's `deploy-status.json`, deploy-nudge file, systemd poller, Caddy reload
or Compose blue/green scripts. Rollback is a reviewed GitOps/image revision
change; the single-server `rollback.sh` is not a cluster rollback mechanism.
