'use strict';

// Read the live catalog on every release. A previous success or a policy
// hash cannot prove that an operator has not changed the role since then.
async function readOnlyRoleCurrent(pool, { role, login, timeoutMs }) {
  const { rows: [r] } = await pool.query(`
    SELECT r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
           r.rolinherit, r.rolreplication, r.rolbypassrls,
           r.rolconfig,
           has_database_privilege(r.oid, current_database(), 'CONNECT') AS connects,
           has_database_privilege(r.oid, current_database(), 'CREATE') AS creates,
           has_schema_privilege(r.oid, 'public', 'USAGE') AS uses_public,
           EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS member,
           EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) setting
             WHERE s.setrole = r.oid AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
               AND split_part(setting, '=', 1) IN ('default_transaction_read_only','statement_timeout')) AS overrides,
           EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
             WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
               AND (has_schema_privilege(r.oid, n.oid, 'CREATE')
                 OR (n.nspname <> 'public' AND has_schema_privilege(r.oid, n.oid, 'USAGE')))) AS schema_authority,
           EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname !~ '^pg_' AND CASE WHEN c.relkind = 'S'
               THEN has_sequence_privilege(r.oid, c.oid, 'SELECT,UPDATE,USAGE') ELSE FALSE END) AS sequence_authority,
           EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d
             CROSS JOIN LATERAL aclexplode(d.defaclacl) a
             WHERE (d.defaclobjtype IN ('r','S') AND a.grantee IN (0, r.oid))
               OR (d.defaclobjtype = 'f' AND a.grantee = r.oid)) AS future_grants,
           EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
               AND (p.proowner = r.oid OR (p.prosecdef AND has_function_privilege(r.oid, p.oid, 'EXECUTE')))) AS function_authority,
           EXISTS (SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
             WHERE (a.grantee = r.oid AND a.is_grantable)
               OR (a.grantee IN (0, r.oid) AND a.privilege_type = 'MAINTAIN')
             UNION ALL SELECT 1 FROM pg_catalog.pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a
             WHERE a.grantee = r.oid AND a.is_grantable
             UNION ALL SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
             WHERE a.grantee = r.oid) AS delegates
      FROM pg_catalog.pg_roles r WHERE r.rolname = $1`, [role]);
  if (!r || r.rolcanlogin !== login || !r.connects || !r.uses_public) return false;
  if (['rolsuper','rolcreatedb','rolcreaterole','rolinherit','rolreplication','rolbypassrls',
    'creates','member','overrides','schema_authority','sequence_authority','future_grants','function_authority','delegates'].some(k => r[k])) return false;
  const settings = Object.fromEntries((r.rolconfig || []).map(s => {
    const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)];
  }));
  const time = /^(\d+)(ms|s|min)?$/.exec(settings.statement_timeout || '');
  const ms = time && Number(time[1]) * ({ ms: 1, s: 1000, min: 60000 }[time[2] || 'ms']);
  return settings.default_transaction_read_only === 'on' && ms === timeoutMs;
}

// Remove direct drift on surfaces owned by these internal read-only roles.
// PUBLIC/inherited privileges we cannot safely revoke remain a failed policy
// check; a failed repair must never publish an available capability.
async function repairReadOnlyDrift(pool, role, admin = pool) {
  const { rows: parents } = await pool.query(`SELECT format('REVOKE %I FROM %I', p.rolname, r.rolname) AS statement
    FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles p ON p.oid = m.roleid
    JOIN pg_catalog.pg_roles r ON r.oid = m.member WHERE r.rolname = $1`, [role]);
  if (parents.length) await admin.query(parents.map(r => r.statement).join(';\n'));
  const { rows: overrides } = await pool.query(`
    SELECT format('ALTER ROLE %I IN DATABASE %I RESET %I', r.rolname, current_database(), split_part(setting, '=', 1)) AS statement
    FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_db_role_setting s ON s.setrole = r.oid
    CROSS JOIN LATERAL unnest(s.setconfig) setting
    WHERE r.rolname = $1 AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND split_part(setting, '=', 1) IN ('default_transaction_read_only','statement_timeout')`, [role]);
  if (overrides.length) await admin.query(overrides.map(r => r.statement).join(';\n'));
  const { rows } = await pool.query(`
    WITH r AS (SELECT oid, rolname FROM pg_catalog.pg_roles WHERE rolname = $1)
    SELECT format('REVOKE ALL ON SCHEMA %I FROM %I', n.nspname, r.rolname) AS statement
      FROM pg_catalog.pg_namespace n CROSS JOIN r CROSS JOIN LATERAL aclexplode(n.nspacl) a
     WHERE n.nspname !~ '^pg_' AND n.nspname NOT IN ('public','information_schema') AND a.grantee = r.oid
    UNION
    SELECT format('REVOKE ALL ON TABLE %I.%I FROM %I', n.nspname, c.relname, r.rolname)
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN r LEFT JOIN pg_catalog.pg_attribute col ON col.attrelid = c.oid AND col.attnum > 0
      CROSS JOIN LATERAL (SELECT a.grantee FROM aclexplode(c.relacl) a
        UNION ALL SELECT a.grantee FROM aclexplode(col.attacl) a) a
     WHERE n.nspname !~ '^pg_' AND n.nspname NOT IN ('public','information_schema')
       AND c.relkind IN ('r','p','v','m','f') AND a.grantee = r.oid
    UNION
    SELECT format('REVOKE ALL ON SEQUENCE %I.%I FROM %I', n.nspname, c.relname, r.rolname)
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN r CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE n.nspname !~ '^pg_' AND c.relkind = 'S' AND a.grantee = r.oid
    UNION
    SELECT format('REVOKE ALL ON ROUTINE %s FROM %I', p.oid::regprocedure, r.rolname)
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN r CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND p.prokind <> 'a' AND a.grantee = r.oid
    UNION
    SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I %s REVOKE ALL ON %s FROM %I', owner.rolname,
             CASE WHEN n.oid IS NULL THEN '' ELSE format('IN SCHEMA %I', n.nspname) END,
             CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' ELSE 'FUNCTIONS' END, r.rolname)
      FROM pg_catalog.pg_default_acl d JOIN pg_catalog.pg_roles owner ON owner.oid = d.defaclrole
      LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN r CROSS JOIN LATERAL aclexplode(d.defaclacl) a
     WHERE d.defaclobjtype IN ('r','S','f') AND a.grantee = r.oid`, [role]);
  if (rows.length) await pool.query(rows.map(r => r.statement).join(';\n'));
}

// One catalog scan for the console's whole live column policy, including
// grants on views, unexpected columns and write grants made by hand.
async function consolePermissionsCurrent(pool, role, scope, deniedColumns) {
  const expected = new Map(scope.map(r => [r.table, r.columns]));
  const { rows } = await pool.query(`
    SELECT n.nspname AS schema, c.relname AS table, c.relkind AS kind,
           has_table_privilege($1, c.oid, 'SELECT') AS table_select,
           has_table_privilege($1, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS table_write,
           COALESCE(array_agg(a.attname::text ORDER BY a.attnum)
             FILTER (WHERE a.attnum IS NOT NULL AND has_column_privilege($1, c.oid, a.attnum, 'SELECT')), ARRAY[]::text[]) AS selected,
           COALESCE(bool_or(has_column_privilege($1, c.oid, a.attnum, 'INSERT,UPDATE,REFERENCES')), FALSE) AS column_write,
           EXISTS (SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
             WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
               AND d.refclassid = 'pg_extension'::regclass AND e.extname = 'pg_stat_statements') AS operator_statistics
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f')
     GROUP BY n.nspname, c.oid, c.relname, c.relkind`, [role]);
  const found = new Set();
  for (const r of rows) {
    if (r.table_write || r.column_write) return false;
    if (r.operator_statistics && r.kind === 'v') continue;
    const columns = r.schema === 'public' && ['r','p'].includes(r.kind) ? expected.get(r.table) : null;
    if (!columns) { if (r.table_select || r.selected.length) return false; continue; }
    found.add(r.table);
    if (r.table_select !== !(deniedColumns[r.table]?.length)
        || JSON.stringify([...r.selected].sort()) !== JSON.stringify([...columns].sort())) return false;
  }
  return found.size === expected.size;
}

module.exports = { readOnlyRoleCurrent, consolePermissionsCurrent, repairReadOnlyDrift };
