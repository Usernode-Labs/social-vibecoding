'use strict';

// The redaction passes (TRUNCATE + UPDATE) make PostgreSQL evaluate
// app-defined code attached to the private tables — triggers, CHECK
// functions, STORED generated columns, index expressions and ON UPDATE rules.
// This proves that code runs WITHOUT the platform administrator's rights:
//   - it runs as the copy's own owner role, which is not a superuser, so a
//     superuser-only action (reading pg_authid) attempted inside it fails;
//   - user triggers are switched off during the passes and put back exactly;
//   - an AFTER UPDATE trigger that would copy a private value into another
//     private table (an audit log) does not leak it into the copy;
//   - on every path: the direct copy, the template build, the template copy.
//
// Opt in with a real PostgreSQL server whose admin role is a SUPERUSER (so
// the boundary is meaningful) and a `usernode` maintenance database. Set
// TEST_DATABASE_URL to require it; skipped otherwise. Run once per version:
//   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5502/postgres (17)
//   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5503/postgres (18)

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

const BASE = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const REQUIRED = !!process.env.TEST_DATABASE_URL;
const at = (dsn, db) => { const u = new URL(dsn); u.pathname = `/${db}`; return String(u); };

async function connect(dsn) {
  const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 3000 });
  client.on('error', () => {});
  await client.connect();
  return client;
}

async function reachable(t) {
  try { const c = await connect(BASE); await c.end(); return true; }
  catch (err) { if (REQUIRED) throw err; t.skip('a PostgreSQL server is needed; set TEST_DATABASE_URL to require this check'); return false; }
}

// Source schema: one table with a private column (acct.secret) wearing every
// kind of app-defined code, a users/audit_log pair for the refill case, and a
// fully private table. redaction_probe is NOT private: it records, per run,
// who the code ran as and whether it could do the superuser-only thing.
const SEED = `
CREATE TABLE public.redaction_probe (
  id bigserial PRIMARY KEY, label text, ran_as text, was_super bool,
  saw_restricted bool, db text NOT NULL DEFAULT current_database());

-- Volatile recorder, for the contexts that allow a side effect (trigger,
-- CHECK, rule): it records who ran it and whether it could do the
-- superuser-only read.
CREATE FUNCTION public.rprobe(label text) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE s bool; r bool := false; n int;
BEGIN
  SELECT rolsuper INTO s FROM pg_roles WHERE rolname = current_user;
  BEGIN
    SELECT count(*) INTO n FROM pg_authid;   -- superuser-only
    r := true;
  EXCEPTION WHEN OTHERS THEN r := false; END;
  INSERT INTO public.redaction_probe(label, ran_as, was_super, saw_restricted)
    VALUES (label, current_user, COALESCE(s, false), r);
  RETURN true;
END $$;

-- Read-only escalation probe, for the contexts that require an IMMUTABLE
-- function (a STORED generated column, an index expression). It cannot write,
-- so its answer is OBSERVED in the stored column/index value: true only if the
-- session could do the superuser-only read.
CREATE FUNCTION public.rprobe_ro(x text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE r bool := false; n int;
BEGIN
  BEGIN SELECT count(*) INTO n FROM pg_authid; r := true; EXCEPTION WHEN OTHERS THEN r := false; END;
  RETURN r;
END $$;

CREATE FUNCTION public.rprobe_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM public.rprobe('trigger'); RETURN NEW; END $$;

CREATE TABLE public.acct (
  id int PRIMARY KEY,
  secret text,
  gen boolean GENERATED ALWAYS AS (public.rprobe_ro(secret)) STORED,
  CONSTRAINT acct_chk CHECK (public.rprobe('check::' || COALESCE(secret, '~')))
);
-- An index expression is also an IMMUTABLE context; recomputed on UPDATE. If
-- it could escalate as a superuser this index would carry true values; it
-- recomputes as the owner here.
CREATE INDEX acct_secret_idx ON public.acct ((public.rprobe_ro(secret)));
CREATE TRIGGER acct_before BEFORE UPDATE ON public.acct FOR EACH ROW EXECUTE FUNCTION public.rprobe_trg();
CREATE TRIGGER acct_always AFTER UPDATE ON public.acct FOR EACH ROW EXECUTE FUNCTION public.rprobe_trg();
ALTER TABLE public.acct ENABLE ALWAYS TRIGGER acct_always;
CREATE RULE acct_rule AS ON UPDATE TO public.acct DO ALSO SELECT public.rprobe('rule');
INSERT INTO public.acct(id, secret) VALUES (1, 'alpha'), (2, 'beta');
COMMENT ON COLUMN public.acct.secret IS 'staging:private';

CREATE TABLE public.users (id int PRIMARY KEY, email text);
INSERT INTO public.users VALUES (1, 'ann@prod.example'), (2, 'bob@prod.example');
COMMENT ON COLUMN public.users.email IS 'staging:private';
CREATE TABLE public.audit_log (email text);
COMMENT ON TABLE public.audit_log IS 'staging:private';
CREATE FUNCTION public.audit_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO public.audit_log(email) VALUES (OLD.email); RETURN NEW; END $$;
CREATE TRIGGER users_audit AFTER UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.audit_email();

CREATE TABLE public.only_private (id int PRIMARY KEY, body text);
INSERT INTO public.only_private VALUES (1, 'gone');
COMMENT ON TABLE public.only_private IS 'staging:private';
`;

// What the clone (or template) must look like after redaction.
async function assertRedacted(client, expectDb) {
  // Every probe row in this copy (a template build redacts in a `_next`
  // database that is then renamed, so its rows' recorded db differs; the owner
  // filter below is what scopes to redaction-pass executions).
  const probe = (await client.query(
    'SELECT label, ran_as, was_super, saw_restricted FROM public.redaction_probe')).rows;
  // The REDACTION passes run as the copy's owner role (name ends _owner); any
  // app code they evaluate is in these rows. (pg_restore's own COPY, on the
  // paths that dump and restore, enforces CHECK and computes generated
  // columns as the administrator — a separate, pre-existing matter this change
  // does not touch; those rows are not from a redaction pass and are excluded
  // by the owner filter.)
  const owner = probe.filter((r) => /_owner$/.test(r.ran_as));
  assert.ok(owner.length > 0, `${expectDb}: the redaction passes evaluated app code (so the proof is live)`);
  for (const row of owner) {
    assert.equal(row.was_super, false, `${expectDb}: ${row.label} ran as a superuser during redaction`);
    assert.equal(row.saw_restricted, false, `${expectDb}: ${row.label} did a superuser-only read during redaction`);
  }
  const ownerKinds = new Set(owner.map((r) => r.label.split('::')[0]));
  // CHECK and the ON UPDATE rule are not triggers and still evaluate during
  // the scrub UPDATE — they fired, as the owner, on the redacted value.
  for (const kind of ['check', 'rule']) {
    assert.ok(ownerKinds.has(kind), `${expectDb}: ${kind} did not run as the owner during redaction`);
  }
  assert.ok(owner.some((r) => r.label === 'check::~'),
    `${expectDb}: the scrub-time CHECK did not run as the owner on the redacted value`);
  // The STORED generated column and the index expression are IMMUTABLE
  // contexts the scrub UPDATE recomputes; their function could do the
  // superuser-only read only as a superuser. Recomputed as the owner, every
  // value is false.
  const genTrue = (await client.query('SELECT count(*)::int n FROM public.acct WHERE gen')).rows[0].n;
  assert.equal(genTrue, 0, `${expectDb}: a generated-column expression escalated during redaction`);
  // User triggers are off during the passes, so the trigger-based refill does
  // not happen: the audit log is empty, and the trigger did not fire as owner.
  assert.equal(ownerKinds.has('trigger'), false, `${expectDb}: a user trigger fired during redaction`);
  assert.equal((await client.query('SELECT count(*)::int n FROM public.audit_log')).rows[0].n, 0,
    `${expectDb}: audit_log refilled`);
  // The redaction itself still holds.
  assert.equal((await client.query('SELECT count(*)::int n FROM public.only_private')).rows[0].n, 0);
  const emails = (await client.query('SELECT email FROM public.users ORDER BY id')).rows.map((r) => r.email);
  assert.ok(emails.every((e) => e === null), `${expectDb}: users.email not scrubbed: ${JSON.stringify(emails)}`);
  // Triggers are put back exactly: the ordinary one ENABLEd (O), the ALWAYS
  // one still ALWAYS (A); FK/RI internal triggers untouched.
  const trg = (await client.query(
    `SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'public.acct'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows;
  assert.deepEqual(trg, [
    { tgname: 'acct_always', tgenabled: 'A' },
    { tgname: 'acct_before', tgenabled: 'O' },
  ], `${expectDb}: triggers not restored exactly`);
  const usersTrg = (await client.query(
    `SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND NOT tgisinternal`)).rows;
  assert.ok(usersTrg.every((r) => r.tgenabled === 'O'), `${expectDb}: users trigger not restored`);
}

function harness(t) {
  const saved = {};
  for (const k of ['DB_ADMIN_URL', 'DATABASE_URL', 'STAGING_DB_ADMIN_URL', 'STAGING_DB_SERVER_DRAIN']) saved[k] = process.env[k];
  process.env.DB_ADMIN_URL = at(BASE, 'usernode');
  process.env.DATABASE_URL = BASE;
  delete process.env.STAGING_DB_ADMIN_URL;
  delete process.env.STAGING_DB_SERVER_DRAIN;
  delete require.cache[require.resolve('../src/services/db-manager')];
  const dbManager = require('../src/services/db-manager');
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  return dbManager;
}

// db-manager's administrative connection uses a `usernode` maintenance
// database. Create it if the server does not have one (as the two-server
// postgres suite does), connecting on the default database. Returns a control
// connection on the default database and whether we created usernode (so the
// caller drops it on cleanup).
async function adminControl() {
  const admin = await connect(BASE);
  let created = (await admin.query("SELECT 1 FROM pg_database WHERE datname = 'usernode'")).rowCount === 0;
  if (created) {
    // Another postgres suite on the same server may create it first; that is
    // not ours to drop.
    try { await admin.query('CREATE DATABASE usernode'); }
    catch (err) { if (/already exists/.test(err.message)) created = false; else throw err; }
  }
  return { admin, created };
}

test('app code on private tables runs without the admin role, on every clone path', async (t) => {
  if (!(await reachable(t))) return;
  const dbManager = harness(t);
  const tok = crypto.randomBytes(4).toString('hex');
  const source = `app_bnd${tok}`;
  const direct = `${source}_staging_s1_abcdef`;
  const viaTmpl = `${source}_staging_s2_abcdef`;
  const template = dbManager.stagingTemplateDbName(source);
  const { admin, created } = await adminControl();
  const wipe = async () => {
    const dbs = (await admin.query("SELECT datname FROM pg_database WHERE datname LIKE $1", [`%${tok}%`])).rows;
    for (const { datname } of dbs) {
      await admin.query(`ALTER DATABASE ${datname} WITH ALLOW_CONNECTIONS true`).catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`).catch(() => {});
    }
    const roles = (await admin.query("SELECT rolname FROM pg_roles WHERE rolname LIKE $1", [`%${tok}%`])).rows;
    for (const { rolname } of roles) await admin.query(`DROP ROLE IF EXISTS ${rolname}`).catch(() => {});
  };
  t.after(async () => {
    await dbManager._templateIdleForTest(source).catch(() => {});
    await wipe();
    if (created) await admin.query('DROP DATABASE IF EXISTS usernode WITH (FORCE)').catch(() => {});
    await admin.end();
  });

  // Build the source and seed it.
  await admin.query(`CREATE DATABASE ${source}`);
  let src = await connect(at(BASE, source));
  await src.query(SEED);
  // The admin IS a superuser here, so the proof has teeth: the same probe run
  // by the admin sees pg_authid and reports super.
  await src.query("SELECT public.rprobe('admin-control')");
  const ctrl = (await src.query("SELECT was_super, saw_restricted FROM public.redaction_probe WHERE label='admin-control'")).rows[0];
  assert.equal(ctrl.was_super, true, 'the admin used here must be a superuser for this check to mean anything');
  assert.equal(ctrl.saw_restricted, true, 'the admin must be able to read the restricted catalog');
  await src.query('TRUNCATE public.redaction_probe');   // clear control + seed-time rows
  await src.end();

  // Path 1 — direct copy (cloneDatabaseDirect, redaction over owner psql).
  await dbManager.cloneDatabase(source, direct);
  let clone = await connect(at(BASE, direct));
  await assertRedacted(clone, direct);
  await clone.end();

  // Clear the source's evidence so the template build's own rows are its own.
  src = await connect(at(BASE, source));
  await src.query('TRUNCATE public.redaction_probe');
  await src.end();

  // Path 2 + 3 — template build (buildRedactedCopy) then template copy
  // (cloneFromTemplate). One call does both.
  const res = await dbManager.cloneDatabase(source, viaTmpl, { viaTemplate: true });
  assert.equal(res.via, 'template');
  // The template copy's redaction ran as viaTmpl's owner.
  clone = await connect(at(BASE, viaTmpl));
  await assertRedacted(clone, viaTmpl);
  await clone.end();
  // The template build's redaction ran as the template's owner. Peek inside
  // the template (connections are disabled on it).
  await admin.query(`ALTER DATABASE ${template} WITH ALLOW_CONNECTIONS true`);
  const tmpl = await connect(at(BASE, template));
  await assertRedacted(tmpl, template);
  await tmpl.end();
  await admin.query(`ALTER DATABASE ${template} WITH ALLOW_CONNECTIONS false`);

  // The owner roles are left unable to log in again (templates/prepared
  // sources are NOLOGIN at rest).
  const tmplRole = `${template}_owner`;
  const canLogin = (await admin.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1', [tmplRole])).rows[0];
  assert.equal(canLogin.rolcanlogin, false, 'the template role is returned to NOLOGIN after the build');
});

test('the after-the-column-pass re-check fails a copy whose private table was refilled', async (t) => {
  if (!(await reachable(t))) return;
  const dbManager = harness(t);
  const tok = crypto.randomBytes(4).toString('hex');
  const db = `app_rfl${tok}`;
  const { admin, created } = await adminControl();
  t.after(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    if (created) await admin.query('DROP DATABASE IF EXISTS usernode WITH (FORCE)').catch(() => {});
    await admin.end();
  });
  await admin.query(`CREATE DATABASE ${db}`);
  const c = await connect(at(BASE, db));
  await c.query(`
    CREATE TABLE public.secrets (id int PRIMARY KEY, body text);
    COMMENT ON TABLE public.secrets IS 'staging:private';
    INSERT INTO public.secrets VALUES (1, 'leaked');`);
  const execute = async (dbName, sql, options = {}) => {
    const result = await c.query({ text: sql, rowMode: 'array' });
    if (!options.tuplesOnly) return '';
    return result.rows.map((row) => row.map((v) => v === true ? 't' : v === false ? 'f' : v == null ? '' : String(v)).join('|')).join('\n');
  };
  // A private table that still holds a row (as a refill after the column pass
  // would leave it) is caught by the re-check, which fails closed.
  await assert.rejects(dbManager.verifyPrivateTablesEmpty(db, execute).then((r) => {
    if (r.length) throw new Error(`still holding: ${r.join(', ')}`);
  }), /still holding: public\.secrets/);
  await c.query('TRUNCATE public.secrets');
  assert.deepEqual(await dbManager.verifyPrivateTablesEmpty(db, execute), [], 'an empty table passes the re-check');
  await c.end();
});

test('FORCE row-level security on a private column fails the copy closed when redacting as the owner', async (t) => {
  if (!(await reachable(t))) return;
  const dbManager = harness(t);
  const tok = crypto.randomBytes(4).toString('hex');
  const source = `app_rls${tok}`;
  const target = `${source}_staging_s1_abcdef`;
  const { admin, created } = await adminControl();
  const wipe = async () => {
    for (const { datname } of (await admin.query("SELECT datname FROM pg_database WHERE datname LIKE $1", [`%${tok}%`])).rows) {
      await admin.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`).catch(() => {});
    }
    for (const { rolname } of (await admin.query("SELECT rolname FROM pg_roles WHERE rolname LIKE $1", [`%${tok}%`])).rows) {
      await admin.query(`DROP ROLE IF EXISTS ${rolname}`).catch(() => {});
    }
  };
  t.after(async () => {
    await wipe();
    if (created) await admin.query('DROP DATABASE IF EXISTS usernode WITH (FORCE)').catch(() => {});
    await admin.end();
  });
  await admin.query(`CREATE DATABASE ${source}`);
  const src = await connect(at(BASE, source));
  // A private column on a table whose row-level security is FORCEd (so it
  // applies even to the table owner), with a policy that hides every row.
  await src.query(`
    CREATE TABLE public.people (id int PRIMARY KEY, email text);
    INSERT INTO public.people VALUES (1, 'ann@prod.example');
    COMMENT ON COLUMN public.people.email IS 'staging:private';
    ALTER TABLE public.people ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.people FORCE ROW LEVEL SECURITY;
    CREATE POLICY hide_all ON public.people USING (false);`);
  await src.end();
  // As the owner, RLS applies: the scrub cannot prove the column cleared, so
  // the copy is refused rather than handed out with a value that a policy
  // might have hidden from the scrub. (As a BYPASSRLS superuser the scrub
  // would have run blind.)
  await assert.rejects(dbManager.cloneDatabase(source, target),
    /row-level security|Failed to scrub/i);
});
