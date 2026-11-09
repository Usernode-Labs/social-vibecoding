{{/* Database identities, enabled only after their encrypted values are provisioned. */}}
{{- define "social-vibecoding-platform.databaseRoleEnv" -}}
- {name: DATABASE_ROLE_SPLIT, value: {{ .Values.databaseRoles.enabled | quote }}}
{{- range $kind := list "web" "conductor" "migrator" "provisioner" }}
- {name: DATABASE_{{ upper $kind }}_USER, value: {{ index $.Values.databaseRoles $kind | quote }}}
{{- end }}
{{- end -}}

{{- define "social-vibecoding-platform.databaseRoleUrl" -}}
{{- $root := .root -}}
{{- $host := include "social-vibecoding-platform.postgresqlHost" $root -}}
{{- $port := $root.Values.postgresql.port -}}
{{- $passwords := dict "web" "webDatabasePassword" "conductor" "conductorDatabasePassword" "migrator" "migratorDatabasePassword" "provisioner" "provisionerDatabasePassword" -}}
{{- $password := index $root.Values.secrets (index $passwords .role) -}}
{{- if .preview -}}
  {{- $host = $root.Values.previewPostgresql.host -}}
  {{- $port = $root.Values.previewPostgresql.port -}}
  {{- $password = ternary $root.Values.secrets.previewReadDatabasePassword $root.Values.secrets.previewProvisionerDatabasePassword (eq .role "web") -}}
{{- end -}}
{{- printf "postgres://%s:%s@%s:%d/%s" (index $root.Values.databaseRoles .role) $password $host (int $port) .database -}}
{{- end -}}

{{- define "social-vibecoding-platform.databaseMigrationSecret" -}}
{{- if .Values.secrets.create -}}
{{- include "social-vibecoding-platform.fullname" . -}}-database-migrator
{{- else -}}
{{- .Values.databaseRoles.existingMigrationSecret -}}
{{- end -}}
{{- end -}}

{{- define "social-vibecoding-platform.databaseBootstrapSecret" -}}
{{- if .Values.secrets.create -}}
{{- include "social-vibecoding-platform.fullname" . -}}-database-bootstrap
{{- else -}}
{{- .Values.databaseRoles.existingBootstrapSecret -}}
{{- end -}}
{{- end -}}

{{- define "social-vibecoding-platform.databaseRoleValidate" -}}
{{- if and .Values.enabled .Values.databaseRoles.enabled -}}
  {{- if .Values.postgresql.enabled -}}
    {{- fail "databaseRoles.enabled requires an externally managed PostgreSQL server" -}}
  {{- end -}}
  {{- if or (not .Values.platform.conductor.enabled) (not .Values.migration.enabled) -}}
    {{- fail "databaseRoles.enabled requires the conductor and migration jobs" -}}
  {{- end -}}
  {{- $seen := list -}}
  {{- range $kind := list "web" "conductor" "migrator" "provisioner" -}}
    {{- $user := index $.Values.databaseRoles $kind -}}
    {{- if or (not (regexMatch "^[a-z_][a-z0-9_]{0,62}$" $user)) (has $user $seen) -}}
      {{- fail "databaseRoles needs four distinct lowercase PostgreSQL role names" -}}
    {{- end -}}
    {{- $seen = append $seen $user -}}
  {{- end -}}
  {{- if .Values.secrets.create -}}
    {{- $keys := list "webDatabasePassword" "conductorDatabasePassword" "migratorDatabasePassword" "provisionerDatabasePassword" -}}
    {{- if .Values.previewPostgresql.enabled -}}
      {{- $keys = concat $keys (list "previewReadDatabasePassword" "previewProvisionerDatabasePassword") -}}
    {{- end -}}
    {{- range $key := $keys -}}
      {{- if not (regexMatch "^[A-Za-z0-9._~-]{32,}$" (index $.Values.secrets $key)) -}}
        {{- fail (printf "secrets.%s must be at least 32 URL-safe characters when databaseRoles is enabled" $key) -}}
      {{- end -}}
    {{- end -}}
  {{- else -}}
    {{- $secretNames := list (include "social-vibecoding-platform.secretName" .) -}}
    {{- range $key := list "existingConductorSecret" "existingMigrationSecret" "existingBootstrapSecret" -}}
      {{- if empty (index $.Values.databaseRoles $key) -}}
        {{- fail (printf "databaseRoles.%s is required with externally managed secrets" $key) -}}
      {{- end -}}
      {{- $name := index $.Values.databaseRoles $key -}}
      {{- if has $name $secretNames -}}
        {{- fail "databaseRoles requires distinct shared, conductor, migration and bootstrap Secrets" -}}
      {{- end -}}
      {{- $secretNames = append $secretNames $name -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- end -}}
