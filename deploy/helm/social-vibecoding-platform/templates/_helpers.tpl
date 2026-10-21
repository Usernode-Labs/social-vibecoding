{{- define "social-vibecoding-platform.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "social-vibecoding-platform.fullname" -}}
{{- default (printf "%s-%s" .Release.Name (include "social-vibecoding-platform.name" .)) .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "social-vibecoding-platform.labels" -}}
app.kubernetes.io/name: {{ include "social-vibecoding-platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: social-vibecoding
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}

{{- define "social-vibecoding-platform.selectorLabels" -}}
app.kubernetes.io/name: {{ include "social-vibecoding-platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "social-vibecoding-platform.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{- define "social-vibecoding-platform.secretName" -}}
{{- if .Values.secrets.create -}}
{{ include "social-vibecoding-platform.fullname" . }}
{{- else -}}
{{ required "secrets.existingSecret is required when secrets.create=false" .Values.secrets.existingSecret }}
{{- end -}}
{{- end -}}

{{- define "social-vibecoding-platform.image" -}}
{{- printf "%s@%s" .repository .digest -}}
{{- end -}}

{{- define "social-vibecoding-platform.postgresqlImage" -}}
{{- printf "%s:%s@%s" .repository .tag .digest -}}
{{- end -}}

{{- define "social-vibecoding-platform.postgresqlHost" -}}
{{- if .Values.postgresql.enabled -}}
{{- printf "%s-postgresql.%s.svc.%s" (include "social-vibecoding-platform.fullname" .) .Release.Namespace .Values.clusterDomain -}}
{{- else -}}
{{- required "postgresql.host is required when postgresql.enabled=false" .Values.postgresql.host -}}
{{- end -}}
{{- end -}}

{{- define "social-vibecoding-platform.postgresqlPodSelector" -}}
{{- if .Values.postgresql.enabled -}}
{{ include "social-vibecoding-platform.selectorLabels" . }}
app.kubernetes.io/component: postgresql
{{- else -}}
{{- if empty .Values.postgresql.podSelector -}}
{{- fail "postgresql.podSelector is required when external PostgreSQL egress is enabled" -}}
{{- end -}}
{{ toYaml .Values.postgresql.podSelector }}
{{- end -}}
{{- end -}}

{{- /*
The platform's own Pods (web and conductor) prefer the zone of the external
CloudNativePG primary, as previews and production apps do
(src/services/kubernetes.js databaseAffinity): every request and every leader
loop makes many sequential queries, and a Pod in another data centre pays that
round trip on each. Same switch and same cluster as PREVIEW_DATABASE_CLUSTER;
empty for bundled PostgreSQL or a database without the CNPG cluster selector.
A preference only: the Pod still schedules when that zone is full.
*/}}
{{- define "social-vibecoding-platform.databasePrimaryAffinity" -}}
{{- if and .Values.config.previewFollowDatabasePrimary (not .Values.postgresql.enabled) -}}
{{- $cluster := index .Values.postgresql.podSelector "cnpg.io/cluster" | default "" -}}
{{- if $cluster -}}
affinity:
  podAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          namespaces: [{{ default .Release.Namespace .Values.postgresql.namespace | quote }}]
          labelSelector:
            matchLabels:
              cnpg.io/cluster: {{ $cluster | quote }}
              cnpg.io/instanceRole: primary
          topologyKey: topology.kubernetes.io/zone
{{- end -}}
{{- end -}}
{{- end -}}

{{- /*
The connection budget (postgresql.platformConnections): the most connections
the platform's processes can hold at once on the main server must fit in the
share reserved for its user. Each role counts its serving Pods plus one more
(the Deployments' maxSurge 1), drainingMax replaced Pods per replica at
platform.drainPools, and five connections per process outside its pools
(the bus listener, presence, the lock connection, the debug pool, the
build-retention guard). The migration Job adds its pool plus two (its
administrative connection and a psql).
*/}}
{{- define "social-vibecoding-platform.connectionBudget" -}}
{{- $p := .Values.platform -}}
{{- $c := .Values.config -}}
{{- $d := $p.drainPools -}}
{{- if or (lt (int $d.dbPoolMax) 1) (lt (int $d.wfPoolMax) 2) (lt (int $d.databaseOperations) 1) -}}
  {{- fail "platform.drainPools needs dbPoolMax 1 or more, wfPoolMax 2 or more (its outcome listener and one more) and databaseOperations 1 or more" -}}
{{- end -}}
{{- $outside := 5 -}}
{{- $drainEach := add (int $d.dbPoolMax) (int $d.wfPoolMax) (int $d.databaseOperations) $outside -}}
{{- $roles := list -}}
{{- if $p.conductor.enabled -}}
  {{- $roles = append $roles (dict "name" "web" "replicas" (int $p.replicas) "serving" (add (int $c.dbPoolMax) (int $c.wfPoolMax) (int $c.databaseOperations) $outside)) -}}
  {{- $roles = append $roles (dict "name" "conductor" "replicas" (int $p.conductor.replicas) "serving" (add (int (default $c.dbPoolMax $p.conductor.dbPoolMax)) (int $p.conductor.wfPoolMax) (int $p.conductor.databaseOperations) $outside)) -}}
{{- else -}}
  {{- $roles = append $roles (dict "name" "platform" "replicas" (int $p.replicas) "serving" (add (int $c.dbPoolMax) (int $p.conductor.wfPoolMax) (int $p.conductor.databaseOperations) $outside)) -}}
{{- end -}}
{{- $total := 0 -}}
{{- $parts := list -}}
{{- range $roles -}}
  {{- $n := add (mul (add .replicas 1) .serving) (mul .replicas (int $p.drainingMax) $drainEach) -}}
  {{- $total = add $total $n -}}
  {{- $parts = append $parts (printf "%s %d" .name $n) -}}
{{- end -}}
{{- if .Values.migration.enabled -}}
  {{- $m := add (int .Values.migration.dbPoolMax) 2 -}}
  {{- $total = add $total $m -}}
  {{- $parts = append $parts (printf "migration %d" $m) -}}
{{- end -}}
{{- $reserve := int .Values.postgresql.platformConnections -}}
{{- if and (gt $reserve 0) (gt $total $reserve) -}}
  {{- fail (printf "the platform could hold %d connections at once on its database server (%s), more than postgresql.platformConnections (%d): lower a pool or platform.drainPools, or raise the reserve" $total (join ", " $parts) $reserve) -}}
{{- end -}}
{{- end -}}

{{- define "social-vibecoding-platform.validate" -}}
{{- if .Values.enabled -}}
  {{- if or .Values.platform.enabled .Values.migration.enabled -}}
    {{- if not (regexMatch "^[a-f0-9]{40}$" .Values.release.sourceRevision) -}}
      {{- fail "release.sourceRevision must be the full Git commit SHA when platform or migration is enabled" -}}
    {{- end -}}
    {{- if not (regexMatch "^sha256:[a-f0-9]{64}$" .Values.platform.image.digest) -}}
      {{- fail "platform.image.digest must be an immutable sha256 digest when platform or migration is enabled" -}}
    {{- end -}}
  {{- end -}}
  {{- if .Values.platform.enabled -}}
    {{- $drain := float64 .Values.platform.drainMinutes -}}
    {{- if or (lt $drain 5.0) (gt $drain 240.0) (ne (float64 (int $drain)) $drain) -}}
      {{- fail "platform.drainMinutes must be a whole number of minutes from 5 to 240" -}}
    {{- end -}}
    {{- $draining := float64 .Values.platform.drainingMax -}}
    {{- if or (lt $draining 0.0) (ne (float64 (int $draining)) $draining) -}}
      {{- fail "platform.drainingMax must be a whole number, 0 or more" -}}
    {{- end -}}
    {{- include "social-vibecoding-platform.connectionBudget" . -}}
    {{- if .Values.platform.conductor.enabled -}}
      {{- $conductors := float64 .Values.platform.conductor.replicas -}}
      {{- if or (lt $conductors 1.0) (ne (float64 (int $conductors)) $conductors) -}}
        {{- fail "platform.conductor.replicas must be a whole number, 1 or more" -}}
      {{- end -}}
    {{- end -}}
    {{- range $name, $image := dict "platform.workerImage" .Values.platform.workerImage "platform.captureImage" .Values.platform.captureImage -}}
      {{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $image.digest) -}}
        {{- fail (printf "%s.digest must be an immutable sha256 digest when platform is enabled" $name) -}}
      {{- end -}}
    {{- end -}}
  {{- end -}}
  {{- if and .Values.postgresql.enabled (not (regexMatch "^sha256:[a-f0-9]{64}$" .Values.postgresql.image.digest)) -}}
    {{- fail "postgresql.image.digest must be an immutable sha256 digest when postgresql is enabled" -}}
  {{- end -}}
  {{- if and (not .Values.postgresql.enabled) (or .Values.platform.enabled .Values.migration.enabled .Values.secrets.create) (empty .Values.postgresql.host) -}}
    {{- fail "postgresql.host is required when postgresql.enabled=false" -}}
  {{- end -}}
  {{- if or (lt (int .Values.postgresql.port) 1) (gt (int .Values.postgresql.port) 65535) -}}
    {{- fail "postgresql.port must be between 1 and 65535" -}}
  {{- end -}}
  {{- if and .Values.secrets.create (not (regexMatch "^[A-Za-z0-9._~-]+$" .Values.secrets.databasePassword)) -}}
    {{- fail "secrets.databasePassword must be non-empty and URL-safe" -}}
  {{- end -}}
  {{- if .Values.previewPostgresql.enabled -}}
    {{- if or (lt (int .Values.previewPostgresql.port) 1) (gt (int .Values.previewPostgresql.port) 65535) -}}
      {{- fail "previewPostgresql.port must be between 1 and 65535" -}}
    {{- end -}}
    {{- if and .Values.networkPolicy.enabled .Values.platform.enabled (empty .Values.previewPostgresql.podSelector) -}}
      {{- fail "previewPostgresql.podSelector is required when previewPostgresql and the network policy are enabled" -}}
    {{- end -}}
    {{- if .Values.secrets.create -}}
      {{- if or (empty .Values.previewPostgresql.host) (empty .Values.previewPostgresql.username) (empty .Values.previewPostgresql.database) -}}
        {{- fail "previewPostgresql.host, username and database are required when previewPostgresql is enabled with chart-created secrets" -}}
      {{- end -}}
      {{- if not (regexMatch "^[A-Za-z0-9._~-]+$" .Values.secrets.previewDatabasePassword) -}}
        {{- fail "secrets.previewDatabasePassword must be non-empty and URL-safe when previewPostgresql is enabled" -}}
      {{- end -}}
    {{- end -}}
  {{- end -}}
  {{- if and .Values.platform.enabled .Values.secrets.create (or (empty .Values.secrets.githubAppId) (empty .Values.secrets.githubPrivateKey) (empty .Values.secrets.githubBotToken)) -}}
    {{- fail "secrets.githubAppId, secrets.githubPrivateKey and secrets.githubBotToken are required when platform is enabled" -}}
  {{- end -}}
  {{- if and .Values.platform.enabled (or (empty .Values.config.nodeRpcUrl) (empty .Values.config.nativeSessionV2TestnetChainId)) -}}
    {{- fail "config.nodeRpcUrl and config.nativeSessionV2TestnetChainId are required when platform is enabled" -}}
  {{- end -}}
  {{- if and .Values.platform.enabled .Values.secrets.create (empty .Values.secrets.topochainPartnerApiKey) -}}
    {{- fail "secrets.topochainPartnerApiKey is required when chart-created secrets are enabled" -}}
  {{- end -}}
  {{- if and (or .Values.platform.enabled .Values.migration.enabled) (empty .Values.config.domain) -}}
    {{- fail "config.domain is required" -}}
  {{- end -}}
  {{- if and .Values.postgresql.enabled (empty .Values.clusterDomain) -}}
    {{- fail "clusterDomain is required" -}}
  {{- end -}}
{{- end -}}
{{- end -}}
