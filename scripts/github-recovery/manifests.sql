-- Each app's dapp.json as the platform last read it (apps.manifest_snapshot),
-- for recover-apps.js --manifests: a Dockerfile-built image leaves dapp.json
-- out (services/template.js .dockerignore), so it is restored from here.
-- Read-only. One line per app: slug, a tab, the JSON in base64.
--
--   psql ... -d app_usernode_2d5619 < scripts/github-recovery/manifests.sql > manifests.tsv
\set ON_ERROR_STOP on
\set QUIET on
\pset pager off
\pset format unaligned
\pset tuples_only on
\pset fieldsep '\t'
BEGIN TRANSACTION READ ONLY;
-- encode() wraps base64 at 76 characters; the newlines are taken out.
SELECT slug, translate(encode(convert_to(manifest_snapshot::text, 'UTF8'), 'base64'), E'\n', '')
  FROM apps
 WHERE manifest_snapshot IS NOT NULL
 ORDER BY slug;
ROLLBACK;
