-- Read-only PostgreSQL 17 migration contract. No setting values or row data leave
-- the server. Custom metadata is rejected rather than discarded by --no-acl.
WITH db AS (
  SELECT d.*, r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
    r.rolreplication, r.rolbypassrls, r.rolinherit, r.rolconnlimit, r.rolvaliduntil
  FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=current_database()
), namespaces AS (
  SELECT * FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema')
    AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%'
), relations AS (
  SELECT c.* FROM pg_class c JOIN namespaces n ON n.oid=c.relnamespace
), statistics AS (
  SELECT * FROM pg_extension WHERE extname='pg_stat_statements'
), members AS (
  SELECT dep.classid,dep.objid FROM pg_depend dep JOIN statistics e ON e.oid=dep.refobjid
  WHERE dep.refclassid='pg_extension'::regclass AND dep.deptype='e'
), expected_members(kind,name,definition) AS (
  -- PostgreSQL 17 / pg_stat_statements 1.11 definitions with search_path=pg_catalog.
  -- Fingerprints reject changed extension code as well as added/removed members.
  VALUES ('pg_class','pg_stat_statements','7331192f4496b29423ad75c52753cf701e45651c37b7cfc4a5a2853e64f3a75e'),
    ('pg_class','pg_stat_statements_info','c72f556e65aed272dd3106056b90ff69cce02a3a6eb9406cae29d7c406b3a413'),
    ('pg_proc','pg_stat_statements','d9defb7688ce68d1f926b94e8aff0935c9b4155d9f713dbb7780798f204a0528'),
    ('pg_proc','pg_stat_statements_info','043eb974c4d96e4a5f1487346983acf7721c1bf8847b2271a42f3cfaa864ff33'),
    ('pg_proc','pg_stat_statements_reset','c81885d058c163e01de033db11d90d1a5da2a88c0dd7b5eb097043ad1b47a383'),
    ('pg_type','pg_stat_statements','type'),('pg_type','_pg_stat_statements','type'),
    ('pg_type','pg_stat_statements_info','type'),('pg_type','_pg_stat_statements_info','type')
), actual_members AS (
  SELECT 'pg_class' AS kind,c.relname AS name,c.relnamespace AS namespace,c.relowner AS owner,
    CASE WHEN c.relkind='v' THEN encode(sha256(convert_to(pg_get_viewdef(c.oid,false),'UTF8')),'hex') END AS definition
    FROM pg_class c JOIN members m ON m.classid='pg_class'::regclass AND m.objid=c.oid
  UNION ALL SELECT 'pg_proc',p.proname,p.pronamespace,p.proowner,
    CASE WHEN p.prokind='f' THEN encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') END
    FROM pg_proc p JOIN members m ON m.classid='pg_proc'::regclass AND m.objid=p.oid
  UNION ALL SELECT 'pg_type',t.typname,t.typnamespace,t.typowner,'type'
    FROM pg_type t JOIN members m ON m.classid='pg_type'::regclass AND m.objid=t.oid
), legacy_public AS (
  SELECT n.oid FROM namespaces n,db d WHERE n.nspname='public' AND pg_get_userbyid(n.nspowner)='usernode'
    AND n.nspacl @> ARRAY[format('%I=UC/%I',pg_get_userbyid(n.nspowner),pg_get_userbyid(n.nspowner))::aclitem,format('%I=UC/%I',d.rolname,pg_get_userbyid(n.nspowner))::aclitem,format('=UC/%I',pg_get_userbyid(n.nspowner))::aclitem]
    AND n.nspacl <@ ARRAY[format('%I=UC/%I',pg_get_userbyid(n.nspowner),pg_get_userbyid(n.nspowner))::aclitem,format('%I=UC/%I',d.rolname,pg_get_userbyid(n.nspowner))::aclitem,format('=UC/%I',pg_get_userbyid(n.nspowner))::aclitem]
), acls AS (
  SELECT c.relacl AS actual, CASE WHEN c.relkind='S' THEN ARRAY[format('%I=rwU/%I',pg_get_userbyid(c.relowner),pg_get_userbyid(c.relowner))::aclitem] ELSE acldefault('r',c.relowner) END AS expected
    FROM relations c WHERE c.relacl IS NOT NULL AND NOT EXISTS(SELECT FROM members WHERE classid='pg_class'::regclass AND objid=c.oid)
  UNION ALL SELECT p.proacl, acldefault('f',p.proowner) FROM pg_proc p JOIN namespaces n ON n.oid=p.pronamespace WHERE p.proacl IS NOT NULL AND NOT EXISTS(SELECT FROM members WHERE classid='pg_proc'::regclass AND objid=p.oid)
  UNION ALL SELECT t.typacl, acldefault('T',t.typowner) FROM pg_type t JOIN namespaces n ON n.oid=t.typnamespace WHERE t.typacl IS NOT NULL
  UNION ALL SELECT COALESCE(n.nspacl,acldefault('n',n.nspowner)),
    acldefault('n',n.nspowner) || CASE WHEN n.nspname='public'
      THEN ARRAY[format('=U/%I',pg_get_userbyid(n.nspowner))::aclitem] ELSE ARRAY[]::aclitem[] END
    FROM namespaces n WHERE n.oid NOT IN (SELECT oid FROM legacy_public)
  UNION ALL SELECT COALESCE(d.datacl,acldefault('d',d.datdba)),
    ARRAY[format('%I=CTc/%I',d.rolname,d.rolname)::aclitem,format('=T/%I',d.rolname)::aclitem] FROM db d
), extension_acls AS (
  SELECT c.relacl AS actual,acldefault('r',c.relowner)||ARRAY[format('=r/%I',pg_get_userbyid(c.relowner))::aclitem] AS expected
    FROM pg_class c JOIN members m ON m.classid='pg_class'::regclass AND m.objid=c.oid
  UNION ALL SELECT COALESCE(p.proacl,acldefault('f',p.proowner)),
    CASE WHEN p.proname='pg_stat_statements_reset' THEN
      ARRAY[format('%I=X/%I',pg_get_userbyid(p.proowner),pg_get_userbyid(p.proowner))::aclitem] ||
      CASE WHEN p.proowner<>d.datdba AND has_function_privilege(d.datdba,p.oid,'EXECUTE')
        THEN ARRAY[format('%I=X/%I',d.rolname,pg_get_userbyid(p.proowner))::aclitem] ELSE ARRAY[]::aclitem[] END
    ELSE acldefault('f',p.proowner) END
    FROM pg_proc p JOIN members m ON m.classid='pg_proc'::regclass AND m.objid=p.oid CROSS JOIN db d
), checks AS (
  SELECT reason, failed FROM db d CROSS JOIN LATERAL (VALUES
    ('DATABASE_OWNER',d.rolname<>d.datname||'_owner'),
    ('ROLE_ATTRIBUTES',d.rolsuper OR d.rolcreatedb OR d.rolcreaterole OR d.rolreplication OR d.rolbypassrls OR NOT d.rolinherit OR (d.rolvaliduntil IS NOT NULL AND d.rolvaliduntil<>'infinity'::timestamptz)),
    ('CONNECTION_LIMITS',d.datconnlimit<>-1 OR d.rolconnlimit<>-1),
    ('DATABASE_SETTINGS',EXISTS(SELECT FROM pg_db_role_setting s WHERE s.setdatabase=d.oid OR (s.setdatabase=0 AND s.setrole IN (0,d.datdba)))),
    ('ROLE_MEMBERSHIPS',EXISTS(SELECT FROM pg_auth_members WHERE roleid=d.datdba OR member=d.datdba)),
    ('SHARED_OWNER',EXISTS(SELECT FROM pg_database WHERE datdba=d.datdba AND oid<>d.oid)),
    ('CUSTOM_PRIVILEGES',EXISTS(SELECT FROM acls WHERE NOT(actual @> expected AND actual <@ expected))
      OR EXISTS(SELECT FROM pg_attribute a JOIN relations c ON c.oid=a.attrelid WHERE cardinality(a.attacl)>0)),
    ('DEFAULT_PRIVILEGES',EXISTS(SELECT FROM pg_default_acl)),
    ('FOREIGN_OBJECT_OWNER',EXISTS(SELECT FROM relations c WHERE relowner<>d.datdba AND NOT EXISTS(SELECT FROM members WHERE classid='pg_class'::regclass AND objid=c.oid))
      OR EXISTS(SELECT FROM pg_proc p JOIN namespaces n ON n.oid=p.pronamespace WHERE p.proowner<>d.datdba AND NOT EXISTS(SELECT FROM members WHERE classid='pg_proc'::regclass AND objid=p.oid))
      OR EXISTS(SELECT FROM pg_type t JOIN namespaces n ON n.oid=t.typnamespace WHERE t.typowner<>d.datdba AND NOT EXISTS(SELECT FROM members WHERE classid='pg_type'::regclass AND objid=t.oid))
      OR EXISTS(SELECT FROM namespaces n WHERE n.nspowner<>d.datdba AND n.oid NOT IN (SELECT oid FROM legacy_public) AND NOT(n.nspname='public' AND pg_get_userbyid(n.nspowner)='pg_database_owner'))),
    ('EXTENSIONS',EXISTS(SELECT FROM pg_extension WHERE extname NOT IN ('plpgsql','pg_stat_statements'))),
    ('STATISTICS_EXTENSION',EXISTS(SELECT FROM statistics WHERE extversion<>'1.11' OR extnamespace<>'public'::regnamespace
        OR pg_get_userbyid(extowner) NOT IN ('postgres','usernode',d.rolname))
      OR (EXISTS(SELECT FROM statistics) AND (
        (SELECT count(*) FROM members)<>9 OR (SELECT count(*) FROM actual_members)<>9
        OR EXISTS((SELECT kind,name,definition FROM expected_members EXCEPT ALL SELECT kind,name,definition FROM actual_members)
          UNION ALL (SELECT kind,name,definition FROM actual_members EXCEPT ALL SELECT kind,name,definition FROM expected_members))
        OR EXISTS(SELECT FROM actual_members WHERE namespace<>'public'::regnamespace OR pg_get_userbyid(owner) NOT IN ('postgres','usernode',d.rolname))
        OR EXISTS(SELECT FROM extension_acls WHERE actual IS NULL OR NOT(actual @> expected AND actual <@ expected))))),
    ('LANGUAGES',EXISTS(SELECT FROM pg_language WHERE lanname NOT IN ('internal','c','sql','plpgsql'))
      OR EXISTS(SELECT FROM pg_language WHERE lanacl IS NOT NULL AND NOT(lanacl @> acldefault('l',lanowner) AND lanacl <@ acldefault('l',lanowner)))),
    ('ROW_SECURITY',EXISTS(SELECT FROM relations WHERE relrowsecurity OR relforcerowsecurity)),
    ('LARGE_OBJECTS',EXISTS(SELECT FROM pg_largeobject_metadata)),
    ('FOREIGN_DATA',EXISTS(SELECT FROM pg_foreign_server) OR EXISTS(SELECT FROM relations WHERE relkind='f')),
    ('LOGICAL_REPLICATION',EXISTS(SELECT FROM pg_publication) OR EXISTS(SELECT FROM pg_subscription)),
    ('TABLESPACES',d.dattablespace<>(SELECT oid FROM pg_tablespace WHERE spcname='pg_default') OR EXISTS(SELECT FROM relations WHERE reltablespace<>0)),
    ('SECURITY_LABELS',EXISTS(SELECT FROM pg_seclabel) OR EXISTS(SELECT FROM pg_shseclabel WHERE objoid IN(d.oid,d.datdba))),
    ('DATABASE_COMMENT',shobj_description(d.oid,'pg_database') IS NOT NULL),
    ('SIZE_LIMIT',pg_database_size(d.oid)>268435456)
  ) c(reason,failed)
)
SELECT json_build_object('version',2,'database',d.datname,'owner',d.rolname,
  'databaseBytes',pg_database_size(d.oid),
  'legacyPublic',EXISTS(SELECT FROM legacy_public),
  'statistics',(SELECT json_build_object('version',e.extversion,'resetAccess',
    COALESCE((SELECT has_function_privilege(d.datdba,p.oid,'EXECUTE') FROM pg_proc p JOIN members m ON m.classid='pg_proc'::regclass AND m.objid=p.oid WHERE p.proname='pg_stat_statements_reset'),false)) FROM statistics e),
  'reasons',COALESCE((SELECT json_agg(reason ORDER BY reason) FROM checks WHERE failed),'[]'::json),
  'analyzeTables',COALESCE((SELECT json_agg(json_build_object('schema',n.nspname,'name',c.relname) ORDER BY n.nspname,c.relname)
    FROM relations c JOIN namespaces n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','m','p')),'[]'::json),
  'tables',COALESCE((SELECT json_agg(json_build_object('schema',n.nspname,'name',c.relname) ORDER BY n.nspname,c.relname)
    FROM relations c JOIN namespaces n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','m')),'[]'::json)) AS inspection
FROM db d;
