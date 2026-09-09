# Social Vibecoding Platform

This application-owned chart deploys the platform process and either its own
PostgreSQL StatefulSet or an externally managed PostgreSQL cluster into
`social-platform`. Generated applications, warm workers and capture Jobs are
created later by the platform through the scoped runtime service account.

The `Build Kubernetes images` workflow first publishes three immutable images,
then packages their exact digests into `values.release.yaml` and publishes this
chart to `oci://ghcr.io/adonagy-corp/charts`. The chart is the atomic release
marker: no chart version exists unless all three image builds succeeded.

`main` publishes stable `0.1.x` chart versions tracked by Argo CD. The
`feat/k8s` branch publishes `0.0.x-feat-k8s` candidates that can be pulled and
rendered manually but are outside Argo's stable version constraint. Cluster
configuration and SOPS-encrypted secrets remain in the infra repository and
are applied as external Helm values.

`config.domain` is the canonical platform hostname (`USERNODE_DOMAIN`).
`config.appsDomain` optionally sets a separate suffix for generated apps and
session previews (`USERNODE_APPS_DOMAIN`). When empty, it defaults to
`config.domain` and preserves existing deployments. For example:

```yaml
config:
  domain: my.onhomeroom.com
  appsDomain: onhomeroom.com
```

This serves the platform at `my.onhomeroom.com`, production apps at
`<slug>.onhomeroom.com`, and previews at `<slug>--s<sessionId>.onhomeroom.com`.
Platform links, CLI authentication, and access-grant redirects continue to use
`config.domain`. The platform hostname is reserved: app deployment rejects a
collision before writing Kubernetes resources, and app access parsing never
treats the platform as a generated app.

DNS and cert-manager must support both hostname sets before rollout. Keep
session cookies host-only. Update external OAuth callback URLs and any
registered origins for the platform hostname. This change does not migrate
existing generated-app Ingresses or persisted preview URLs automatically:
redeploy existing apps and rebuild active previews through their normal
platform workflows after the platform release. Keep the prior DNS records
until migration and rollback checks are complete. A deployment restart alone
does not reconcile existing child-app routes.

The bundled standalone Caddyfile still uses its existing single-domain layout;
the separate-domain configuration described here is for the Kubernetes chart.

The OCI chart package must be public for unauthenticated Argo CD pulls. If it
is kept private, Argo CD needs a read-only GHCR repository credential with OCI
support enabled. Runtime image visibility is independent and may use the
cluster's existing image pull Secret.

Resource ordering within the Application is:

1. Secret, service accounts and network policy at sync wave `-3`.
2. PostgreSQL Service and StatefulSet at sync wave `-2`.
3. Idempotent migration `Sync` hook at wave `-1`.
4. Platform Deployment, Service and Ingress at wave `0`.

The master `enabled` gate is split further into `platform.enabled`,
`migration.enabled`, and `postgresql.enabled`. All three default to `true` for
backward compatibility. To use CloudNativePG or another external database, set
`postgresql.enabled=false`, configure `postgresql.host`, `postgresql.port`, and
the narrow `postgresql.podSelector`, then let the database-owning deployment
control ingress to its Pods. This also permits a cutover-ready configuration
with the platform, migration Job, and ingress disabled until the database is
writable.

Platform upgrades use a Kubernetes-native blue/green equivalent: a
`RollingUpdate` Deployment creates a new ReplicaSet beside the live one,
requires two consecutive readiness successes plus `minReadySeconds`, and keeps
`maxUnavailable: 0`. The stable Service starts routing to the new Pod only
after it is Ready; Kubernetes removes and terminates the old Pod after the new
ReplicaSet is Available. Existing connections receive the platform's normal
pre-stop and SIGTERM drain budget.

Both Pods may serve independent requests during the brief overlap. That is safe
because `PLATFORM_LEADER_LOCK=1` uses the platform's PostgreSQL advisory-lock
coordinator: only one Pod runs singleton recovery, sweepers and reconcilers.
This is intentionally implemented with the built-in Deployment controller;
the cluster does not need Caddy, Argo Rollouts, or another rollout CRD.

If the candidate never becomes Ready, the Deployment times out without taking
the old ReplicaSet down. Roll back by restoring the previous OCI chart version
in the Argo CD source; the same readiness-gated rollout then moves traffic back
to the previous immutable image set.

PostgreSQL data is held by a retained `openebs-lvm-retain` PVC. Deleting the
StatefulSet or Argo Application does not delete the underlying volume. Take a
logical backup or VolumeSnapshot before database upgrades or data migration.

To inspect a published release without installing it:

```bash
helm pull oci://ghcr.io/adonagy-corp/charts/social-vibecoding-platform \
  --version 0.1.<release> --untar
helm template social-vibecoding-platform ./social-vibecoding-platform \
  -f ./social-vibecoding-platform/values.release.yaml \
  --set enabled=true \
  --set secrets.create=false \
  --set secrets.existingSecret=social-vibecoding
```


## Proposal checks in Kubernetes

Capture Jobs visit the generated app and preview HTTPS ingress hostnames. The
self-app's production capture uses the canonical platform hostname. Worker
namespace DNS and egress must reach these ingress endpoints with valid TLS;
there is no HTTP or certificate-verification fallback. This preserves Secure
session cookies in Paketo's production-mode previews. Docker captures retain
their existing network path.

When `WORKER_RUNTIME=kubernetes`, repo unit suites run as separate Jobs using
`KUBERNETES_WORKER_IMAGE`, pinned by the same chart release. That image includes
Node, git and a local disposable PostgreSQL 17 for repositories opting into SQL
checks. Each Job has no service-account token or shared workspace volume,
uses the existing worker service account for image pulls, and runs as UID 1000.
Clone credentials are in a temporary Secret owned by the Job and deleted when
the runner finishes. Jobs have no retries, a default ten-minute deadline, and
a one-hour cleanup TTL. The default limit is four CPUs / 2 GiB, with requests
of one CPU / 1 GiB; existing `UNIT_SUITE_CPUS`, `UNIT_SUITE_MEMORY` and
`UNIT_SUITE_TIMEOUT_MS` settings apply. Allow worker quota for simultaneous
capture and unit-suite Jobs. Unit-suite log reads are bounded to 32 MiB.

Failed Jobs preserve their exit code and available test output in the check
result; timeouts remain failures. Checks and earned merge gating are not
bypassed. Existing previews can be rechecked after the platform release; a
preview rebuild is not required just to change its capture URL.
