'use strict';

// Trusted EXPORT policy, loaded by the deployed platform, never by the
// proposed checkout. Comments on the source database cannot approve data.
const crypto = require('node:crypto');
const fs = require('node:fs');
const policy = require('./platform-preview-data-policy.json');
const schema = require('./platform-preview-schema.json');
const PLATFORM_SLUG = 'usernode-2d5619';
const PLATFORM_DATABASE = 'app_usernode_2d5619';
const LABEL = 'social.usernode.io/preview-data-policy';
const RECEIPT_LABEL = 'social.usernode.io/preview-data-receipt';
const APP_ID_LABEL = 'social.usernode.io/app-id';
// Includes code, not just the inventory: changing filtering or verification
// invalidates templates and serving previews even without a manual bump.
const DIGEST = crypto.createHash('sha256').update(fs.readFileSync(__filename))
  .update(JSON.stringify(policy)).update(JSON.stringify(schema))
  .update(fs.readFileSync(require.resolve('../db/schema.sql')))
  .update(fs.readFileSync(require.resolve('./db-manager')))
  .update(fs.readFileSync(require.resolve('./application-runtime')))
  .update(fs.readFileSync(require.resolve('./platform-preview-retirement'))).digest('hex').slice(0, 40);
// PostgreSQL 18 also records column NOT NULL in pg_constraint. Nullability
// is already captured by attnotnull below; exclude that duplicate so the
// same schema has the same inventory on production 17 and preview 18.
const CATALOG_SQL = `SELECT jsonb_build_object(
'schemas', (SELECT jsonb_agg(nspname ORDER BY nspname) FROM pg_namespace n WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' ),
'relations', (SELECT jsonb_agg(x ORDER BY x->>'name') FROM (SELECT jsonb_build_object(
'name', n.nspname || '.' || c.relname, 'kind', c.relkind, 'rls', c.relrowsecurity, 'forceRls', c.relforcerowsecurity,
'inherits', EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid),
'columns', (SELECT jsonb_object_agg(a.attname, jsonb_build_array(format_type(a.atttypid,a.atttypmod), a.attnotnull, pg_get_expr(d.adbin,d.adrelid), a.attidentity, a.attgenerated)) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
'constraints', ARRAY(SELECT pg_get_constraintdef(k.oid) FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype <> 'n' ORDER BY pg_get_constraintdef(k.oid))
) AS x FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f') AND (c.relkind <> 'v' OR NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e'))) t),
'sequences', (SELECT jsonb_agg(jsonb_build_object('name', n.nspname||'.'||c.relname, 'type',format_type(s.seqtypid,NULL), 'start',s.seqstart::text, 'increment',s.seqincrement::text, 'min',s.seqmin::text, 'max',s.seqmax::text, 'cache',s.seqcache::text, 'cycle',s.seqcycle) ORDER BY n.nspname,c.relname) FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')),
'largeObjects', (SELECT count(*)::integer FROM pg_largeobject_metadata))::text AS inventory;`;
const ident = value => '"' + value.replaceAll('"', '""') + '"';
const qualified = name => name.split('.').map(ident).join('.');
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const stable = value => JSON.stringify(canonical(value));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function refuse(message) {
  return Object.assign(new Error(`Platform preview data policy: ${message}`), { noFallback: true, platformPreviewPolicy: true });
}
function sourceIdentity(name) {
  // Templates and frozen sources keep the full source prefix. Also cover a
  // differently named primary platform database on self-hosted installations.
  let primary = null;
  try { primary = new URL(process.env.DATABASE_URL).pathname.slice(1); } catch { /* no configured platform database */ }
  return [PLATFORM_DATABASE, primary].filter(Boolean).find(source => name === source
    || name === `${source}_stgtmpl` || name === `${source}_stgtmpl_next`
    || new RegExp(`^${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_evsrc_[0-9a-f]{12}$`).test(name)) || null;
}
const fingerprint = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
function relationShape(relation) {
  const { name, kind, rls, forceRls, inherits, columns } = relation;
  return { name, kind, rls, forceRls, inherits, columns, constraints: [...(relation.constraints || [])].sort() };
}
function inventoryShape(catalog) {
  return { schemas: [...(catalog.schemas || [])].sort(),
    relations: (catalog.relations || []).map(relationShape).sort(byName),
    sequences: [...(catalog.sequences || [])].sort(byName) };
}
// One compact compatibility checksum replaces a second copy of schema.sql.
// Only the named, independently fingerprinted legacy omissions and exact
// column alternatives are normalized. This never approves a data export:
// every retained column still needs its own decision in the small policy.
function schemaFingerprint(catalog) {
  const core = inventoryShape(catalog);
  core.relations = core.relations.filter(r => !Object.hasOwn(schema.optionalTables, r.name)).map(r => {
    const columns = { ...r.columns };
    for (const [name, variants] of Object.entries(schema.columnVariants[r.name] || {})) {
      if ([variants.canonical, ...variants.alternatives].some(v => stable(v) === stable(columns[name]))) {
        columns[name] = variants.canonical;
      }
    }
    return { ...r, columns };
  });
  core.sequences = core.sequences.filter(s => !Object.hasOwn(schema.optionalSequences, s.name));
  return fingerprint(core);
}
function verifyCatalog(catalog) {
  const problems = [];
  if (policy.default !== 'empty') problems.push('unlisted data must be empty');
  if (catalog.largeObjects !== 0) problems.push('large objects are not approved');
  const seen = new Set();
  for (const relation of catalog.relations || []) {
    const name = relation.name;
    seen.add(name);
    if (relation.kind !== 'r' || relation.rls || relation.forceRls || relation.inherits) problems.push(`unsupported relation ${name}`);
    if (Object.hasOwn(schema.optionalTables, name) && fingerprint(relationShape(relation)) !== schema.optionalTables[name]) {
      problems.push(`review legacy relation ${name}`);
    }
    const approved = policy.tables[name];
    if (!approved) continue; // default-deny is independent of schema approval
    if (Object.hasOwn(schema.optionalTables, name)) problems.push(`legacy relation must remain empty ${name}`);
    for (const column of new Set([...Object.keys(relation.columns || {}), ...Object.keys(approved.columns || {})])) {
      const action = approved.columns?.[column];
      if (!Object.hasOwn(relation.columns || {}, column) || !Object.hasOwn(approved.columns || {}, column)
          || typeof action !== 'string' || !action.trim()) problems.push(`missing column policy ${name}.${column}`);
    }
  }
  for (const name of Object.keys(policy.tables)) if (!seen.has(name)) problems.push(`missing retained relation ${name}`);
  for (const sequence of catalog.sequences || []) {
    if (Object.hasOwn(schema.optionalSequences, sequence.name) && fingerprint(sequence) !== schema.optionalSequences[sequence.name]) {
      problems.push(`review legacy sequence ${sequence.name}`);
    }
  }
  const actual = schemaFingerprint(catalog);
  if (actual !== schema.fingerprint) problems.push(`review schema fingerprint ${actual}`);
  if (problems.length) throw refuse(problems.slice(0, 12).join('; '));
  return { digest: DIGEST, schema: fingerprint(inventoryShape(catalog)) };
}
async function inspect(db, execute) {
  const raw = await execute(db, CATALOG_SQL, { tuplesOnly: true });
  let catalog;
  try { catalog = JSON.parse(String(raw)); } catch { throw refuse('cannot read complete schema inventory'); }
  return { catalog, ...verifyCatalog(catalog) };
}
function exclusions(catalog) {
  return catalog.relations.filter(r => !Object.hasOwn(policy.tables, r.name)).map(r => r.name).sort();
}
function stamp(source, schema, copySchema) { return ` preview_policy=${DIGEST} preview_source=${source} preview_schema=${schema} preview_copy_schema=${copySchema}`; }
function validStamp(comment, source) {
  return String(comment).includes(` preview_policy=${DIGEST} `)
    && String(comment).includes(` preview_source=${source} `)
    && / preview_schema=[0-9a-f]{64}(?:\s|$)/.test(String(comment))
    && / preview_copy_schema=[0-9a-f]{64}(?:\s|$)/.test(String(comment));
}
// The caller supplies an owner-authenticated, single-connection executor.
// All data changes and trigger restoration are atomic. No proposal code has
// started, and no usable clone credential is returned until this completes.
async function sanitize(db, execute) {
  const inspected = await inspect(db, execute);
  const empty = exclusions(inspected.catalog);
  const tables = inspected.catalog.relations.map(r => qualified(r.name));
  const retained = inspected.catalog.relations.filter(r => Object.hasOwn(policy.tables, r.name));
  const updates = retained.flatMap(r => {
    const assignments = Object.entries(policy.tables[r.name].columns).filter(([,a]) => a !== 'keep')
      .map(([column, action]) => `${ident(column)} = ${action}`).join(', ');
    return assignments ? [`UPDATE ${qualified(r.name)} SET ${assignments};`] : [];
  });
  const checks = empty.map(name => `IF EXISTS (SELECT 1 FROM ${qualified(name)}) THEN RAISE EXCEPTION 'preview policy: nonempty ${name}'; END IF;`);
  // Verify *values*, including nullable columns; IS DISTINCT FROM handles
  // NULL and JSON/arrays without converting them to ambiguous strings.
  for (const r of retained) {
    for (const [column, action] of Object.entries(policy.tables[r.name].columns)) if (action !== 'keep') {
      checks.push(`IF EXISTS (SELECT 1 FROM ${qualified(r.name)} WHERE ${ident(column)} IS DISTINCT FROM (${action})) THEN RAISE EXCEPTION 'preview policy: unsanitized ${r.name}.${column}'; END IF;`);
    }
  }
  const resetSequences = inspected.catalog.sequences.map(s => `ALTER SEQUENCE ${qualified(s.name)} RESTART;`);
  // Retained identity sequences start after their remaining IDs. Empty-table
  // sequences restart too, so they do not disclose production cardinalities.
  const retainedSequences = ['users','apps','communities'].map(table =>
    `PERFORM setval(pg_get_serial_sequence('public.${table}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM public.${table}), 0), 1), EXISTS (SELECT 1 FROM public.${table}));`);
  const sql = `BEGIN;
    SET LOCAL statement_timeout = '90s';
    CREATE TEMP TABLE preview_trigger_state ON COMMIT DROP AS
      SELECT tgrelid, tgname, tgenabled FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid IN (${inspected.catalog.relations.map(r => `${literal(r.name)}::regclass`).join(',')});
    ${tables.map(table => `ALTER TABLE ${table} DISABLE TRIGGER USER;`).join('\n')}
    TRUNCATE ${empty.map(qualified).join(',')} RESTART IDENTITY;
    DO $preview_identity$ BEGIN
      IF (SELECT count(*) FROM public.apps WHERE slug = ${literal(PLATFORM_SLUG)} AND self_hosted IS TRUE) <> 1
        THEN RAISE EXCEPTION 'preview policy: missing or ambiguous platform identity'; END IF;
    END $preview_identity$;
    DELETE FROM public.apps WHERE slug <> ${literal(PLATFORM_SLUG)} OR self_hosted IS NOT TRUE;
    DELETE FROM public.communities WHERE id NOT IN (SELECT community_id FROM public.apps WHERE community_id IS NOT NULL);
    CREATE TEMP TABLE preview_user_names ON COMMIT DROP AS
      SELECT id, CASE WHEN username IN ('usernode-capture','usernode-capture-admin') THEN username
        ELSE 'preview-user-' || id::text END AS username FROM public.users;
    UPDATE public.users SET username = '${crypto.randomBytes(16).toString('hex')}-preview-tmp-' || id::text;
    UPDATE public.users u SET username = n.username FROM preview_user_names n WHERE u.id = n.id;
    ${updates.join('\n')}
    ${resetSequences.join('\n')}
    DO $preview_verify$ BEGIN
      ${retainedSequences.join('\n')}
      ${checks.join('\n')}
    END $preview_verify$;
    DO $preview_triggers$ DECLARE t record; BEGIN
      FOR t IN SELECT * FROM preview_trigger_state LOOP
        EXECUTE format('ALTER TABLE %s %s TRIGGER %I', t.tgrelid::regclass,
          CASE t.tgenabled WHEN 'D' THEN 'DISABLE' WHEN 'A' THEN 'ENABLE ALWAYS' WHEN 'R' THEN 'ENABLE REPLICA' ELSE 'ENABLE' END, t.tgname);
      END LOOP;
    END $preview_triggers$;
    COMMIT;`;
  try { await execute(db, sql); } catch (err) {
    await execute(db, 'ROLLBACK').catch(() => {});
    throw refuse(`sanitization refused (${err.code || 'copy rejected'})`);
  }
  return inspected;
}
// Only the two exact, reserved capture identities keep their handles.
// Other production handles may be undiscoverable or historically contain
// email addresses. Their deterministic preview aliases preserve sign-in
// without making the production account directory enumerable.
function previewIdentity(user) {
  if (!Number.isSafeInteger(user?.id) || user.id < 1) throw refuse('invalid preview user identity');
  const capture = ['usernode-capture', 'usernode-capture-admin'].includes(user.username);
  return { ...user, username: capture ? user.username : `preview-user-${user.id}`, usernode_pubkey: null, locale: null };
}
function isOpaqueDockerPreview(name) {
  return /^usernode-(shots|evidence)-[0-9a-f]{16}-(base|head)$/.test(name);
}
// Docker inherits image LABELs. Public policy labels therefore cannot attest
// a clone. Only the trusted orchestrator can sign its exact runtime, app and
// injected connection URL. This key never enters a preview; do not fall back
// to SESSION_SECRET or any other preview-known key. Labels contain no URL.
function runtimeReceipt(config, { appId, runtimeName, policyTag, databaseUrl }) {
  const secret = config?.edgeJwtSecret || process.env.EDGE_JWT_SECRET;
  if (typeof secret !== 'string' || !secret) throw refuse('runtime receipt key is unavailable');
  if (!/^[1-9][0-9]*$/.test(String(appId)) || typeof runtimeName !== 'string' || !runtimeName
      || ![DIGEST, 'authored'].includes(policyTag) || typeof databaseUrl !== 'string' || !databaseUrl) {
    throw refuse('invalid runtime receipt inputs');
  }
  const key = crypto.createHmac('sha256', secret).update('homeroom:preview-runtime-receipt:v1').digest();
  const connection = crypto.createHash('sha256').update(databaseUrl).digest('hex');
  return crypto.createHmac('sha256', key)
    .update(JSON.stringify(['v1', DIGEST, String(appId), runtimeName, policyTag, connection]))
    .digest('hex').slice(0, 40);
}
function verifyRuntimeReceipt(config, inputs, receipt) {
  if (typeof receipt !== 'string' || !/^[0-9a-f]{40}$/.test(receipt)) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(receipt, 'hex'), Buffer.from(runtimeReceipt(config, inputs), 'hex'));
  } catch { return false; }
}
function retainedTables() { return Object.keys(policy.tables); }
function runtimeLabels(result) {
  if (!result?.platformPreviewPolicy) return {};
  if (result.platformPreviewPolicy !== DIGEST) throw refuse('clone was built with another policy');
  return { [LABEL]: DIGEST };
}
module.exports = { policy, schema, schemaFingerprint, DIGEST, LABEL, RECEIPT_LABEL, APP_ID_LABEL, PLATFORM_SLUG, PLATFORM_DATABASE, CATALOG_SQL,
  isOpaqueDockerPreview, runtimeReceipt, verifyRuntimeReceipt,
  sourceIdentity, verifyCatalog, inspect, exclusions, sanitize, stamp, validStamp, runtimeLabels, previewIdentity, retainedTables, refuse };
