'use strict';

// The complete catalog of a database's own schema, as JSON: schemas,
// relations with their columns and constraints, sequences, and a count of
// large objects. Two databases built the same way read the same.
// PostgreSQL 18 also records column NOT NULL in pg_constraint. A validated,
// inheritable constraint duplicates attnotnull; exclude only that form so
// NOT VALID and NO INHERIT still change the inventory on production/previews.
const CATALOG_SQL = `SELECT jsonb_build_object(
'schemas', (SELECT jsonb_agg(nspname ORDER BY nspname) FROM pg_namespace n WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ),
'relations', (SELECT jsonb_agg(x ORDER BY x->>'name') FROM (SELECT jsonb_build_object(
'name', n.nspname || '.' || c.relname, 'kind', c.relkind, 'rls', c.relrowsecurity, 'forceRls', c.relforcerowsecurity,
'inherits', EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid),
'columns', (SELECT jsonb_object_agg(a.attname, jsonb_build_array(format_type(a.atttypid,a.atttypmod), a.attnotnull, pg_get_expr(d.adbin,d.adrelid), a.attidentity, a.attgenerated)) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
'constraints', ARRAY(SELECT pg_get_constraintdef(k.oid) FROM pg_constraint k WHERE k.conrelid=c.oid AND (k.contype <> 'n' OR NOT k.convalidated OR k.connoinherit) ORDER BY pg_get_constraintdef(k.oid))
) AS x FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f') AND (c.relkind <> 'v' OR NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e'))) t),
'sequences', (SELECT jsonb_agg(jsonb_build_object('name', n.nspname||'.'||c.relname, 'type',format_type(s.seqtypid,NULL), 'start',s.seqstart::text, 'increment',s.seqincrement::text, 'min',s.seqmin::text, 'max',s.seqmax::text, 'cache',s.seqcache::text, 'cycle',s.seqcycle) ORDER BY n.nspname,c.relname) FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')),
'largeObjects', (SELECT count(*)::integer FROM pg_largeobject_metadata))::text AS inventory;`;

module.exports = { CATALOG_SQL };
