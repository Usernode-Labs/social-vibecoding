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
  {{- if and .Values.platform.enabled .Values.secrets.create (or (empty .Values.secrets.githubAppId) (empty .Values.secrets.githubPrivateKey) (empty .Values.secrets.githubBotToken)) -}}
    {{- fail "secrets.githubAppId, secrets.githubPrivateKey and secrets.githubBotToken are required when platform is enabled" -}}
  {{- end -}}
  {{- if and (or .Values.platform.enabled .Values.migration.enabled) (empty .Values.config.domain) -}}
    {{- fail "config.domain is required" -}}
  {{- end -}}
  {{- if and .Values.postgresql.enabled (empty .Values.clusterDomain) -}}
    {{- fail "clusterDomain is required" -}}
  {{- end -}}
{{- end -}}
{{- end -}}
