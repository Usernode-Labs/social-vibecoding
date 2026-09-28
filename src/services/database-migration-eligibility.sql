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
), acls AS (
  SELECT c.relacl AS actual, CASE WHEN c.relkind='S' THEN ARRAY[format('%I=rwU/%I',pg_get_userbyid(c.relowner),pg_get_userbyid(c.relowner))::aclitem] ELSE acldefault('r',c.relowner) END AS expected
    FROM relations c WHERE c.relacl IS NOT NULL
  UNION ALL SELECT p.proacl, acldefault('f',p.proowner) FROM pg_proc p JOIN namespaces n ON n.oid=p.pronamespace WHERE p.proacl IS NOT NULL
  UNION ALL SELECT t.typacl, acldefault('T',t.typowner) FROM pg_type t JOIN namespaces n ON n.oid=t.typnamespace WHERE t.typacl IS NOT NULL
  UNION ALL SELECT COALESCE(n.nspacl,acldefault('n',n.nspowner)),
    acldefault('n',n.nspowner) || CASE WHEN n.nspname='public'
      THEN ARRAY[format('=U/%I',pg_get_userbyid(n.nspowner))::aclitem] ELSE ARRAY[]::aclitem[] END
    FROM namespaces n
  UNION ALL SELECT COALESCE(d.datacl,acldefault('d',d.datdba)),
    ARRAY[format('%I=CTc/%I',d.rolname,d.rolname)::aclitem,format('=T/%I',d.rolname)::aclitem] FROM db d
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
    ('FOREIGN_OBJECT_OWNER',EXISTS(SELECT FROM relations WHERE relowner<>d.datdba)
      OR EXISTS(SELECT FROM pg_proc p JOIN namespaces n ON n.oid=p.pronamespace WHERE p.proowner<>d.datdba)
      OR EXISTS(SELECT FROM pg_type t JOIN namespaces n ON n.oid=t.typnamespace WHERE t.typowner<>d.datdba)
      OR EXISTS(SELECT FROM namespaces n WHERE n.nspowner<>d.datdba AND NOT(n.nspname='public' AND pg_get_userbyid(n.nspowner)='pg_database_owner'))),
    ('EXTENSIONS',EXISTS(SELECT FROM pg_extension WHERE extname<>'plpgsql')),
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
SELECT json_build_object('version',1,'database',d.datname,'owner',d.rolname,
  'databaseBytes',pg_database_size(d.oid),
  'reasons',COALESCE((SELECT json_agg(reason ORDER BY reason) FROM checks WHERE failed),'[]'::json),
  'analyzeTables',COALESCE((SELECT json_agg(json_build_object('schema',n.nspname,'name',c.relname) ORDER BY n.nspname,c.relname)
    FROM relations c JOIN namespaces n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','m','p')),'[]'::json),
  'tables',COALESCE((SELECT json_agg(json_build_object('schema',n.nspname,'name',c.relname) ORDER BY n.nspname,c.relname)
    FROM relations c JOIN namespaces n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','m')),'[]'::json)) AS inspection
FROM db d;
