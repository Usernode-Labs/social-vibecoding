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
  // EVERY app-defined code evaluation inside the copy ran as a role whose
  // name ends _owner — the data load's (pg_restore authenticates as the
  // copy's own owner role, so its CHECK validation, generated columns and
  // triggers run as that role) and the redaction passes'. Not one
  // administrator row is permitted: one would mean app-defined code ran with
  // the platform's rights inside the copy.
  const owner = probe.filter((r) => /_owner$/.test(r.ran_as));
  const admin = probe.filter((r) => !/_owner$/.test(r.ran_as));
  assert.ok(owner.length > 0, `${expectDb}: the copy evaluated app code as its owner (so the proof is live)`);
  assert.deepEqual(admin, [],
    `${expectDb}: app-defined code evaluated as the administrator during the copy: ${JSON.stringify(admin)}`);
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

  // The owner role is left unable to log in again and without the temporary
  // password (templates/prepared sources are NOLOGIN and passwordless at
  // rest; the stored password is visible only in pg_authid).
  const tmplRole = `${template}_owner`;
  const left = (await admin.query(
    'SELECT r.rolcanlogin AS can_login, a.rolpassword IS NULL AS passwordless'
    + ' FROM pg_roles r JOIN pg_authid a ON a.oid = r.oid WHERE r.rolname = $1',
    [tmplRole])).rows[0];
  assert.equal(left.can_login, false, 'the template role is returned to NOLOGIN after the build');
  assert.equal(left.passwordless, true, 'the template role kept the temporary password after the build');
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

// The app controls what a session inside its own database resolves an
// unqualified name to: it may set search_path on its own database, and app
// code running during the data load can set it on the copy too. With
// `search_path = public, pg_catalog` a same-named function in public is found
// BEFORE the built-in — so a fake pg_relation_size that always answers 0
// would hide a private table refilled during the column pass from the
// emptiness proof. The platform's own sessions pin the built-ins, so the
// refill is caught and the copy refused, whatever the app set.
test('an app-set database search_path cannot redirect the platform\'s own queries', { timeout: 120000 }, async (t) => {
  if (!(await reachable(t))) return;
  const dbManager = harness(t);
  const tok = crypto.randomBytes(4).toString('hex');
  const source = `app_spp${tok}`;
  const target = `${source}_staging_s1_abcdef`;
  const { admin, created } = await adminControl();
  const wipe = async () => {
    for (const { datname } of (await admin.query("SELECT datname FROM pg_database WHERE datname LIKE $1", [`%${tok}%`])).rows) {
      await admin.query(`ALTER DATABASE ${datname} WITH ALLOW_CONNECTIONS true`).catch(() => {});
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
  await src.query(SEED);
  // The poison, in the source's own schema: a fake that answers 0 for every
  // size, a rule that refills a private table during the column pass (rules
  // are not triggers, so they are not switched off), and a CHECK whose
  // function sets the database's search_path with public FIRST — pg_restore
  // validates CHECK constraints while loading the copy's data, so the copy
  // arrives poisoned whatever ran the load.
  await src.query(`
    CREATE FUNCTION public.pg_relation_size(relation regclass) RETURNS bigint
      LANGUAGE sql IMMUTABLE PARALLEL SAFE AS 'SELECT 0::bigint';
    CREATE RULE acct_refill AS ON UPDATE TO public.acct DO ALSO
      INSERT INTO public.only_private(id, body) VALUES (99, 'refilled');
    CREATE FUNCTION public.poison_and_true() RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
      BEGIN EXECUTE 'ALTER DATABASE ' || quote_ident(current_database())
        || ' SET search_path = public, pg_catalog';
        RETURN true; END $$;
    ALTER TABLE public.acct ADD CONSTRAINT acct_poison CHECK (public.poison_and_true());`);
  // The seed's own CHECK firings recorded probe rows; clear them (and only
  // them) so the copy's probe table starts empty, as the multi-path check
  // does.
  await src.query('TRUNCATE public.redaction_probe');
  await src.end();
  // With the built-ins pinned, the refill is caught and the copy refused;
  // without the pin the fake would have answered 0 for the refilled table
  // and the copy would have been handed out with the row in it.
  await assert.rejects(dbManager.cloneDatabase(source, target),
    /refilled during the column pass/);
  // The poison really took in the copy, so this check exercised the pin and
  // not an unpoisoned copy.
  const settings = (await admin.query(
    'SELECT setconfig::text AS setconfig FROM pg_db_role_setting'
    + ' WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = $1) AND setrole = 0',
    [target])).rows;
  assert.ok(settings.some((r) => /search_path/.test(r.setconfig) && /public/.test(r.setconfig)),
    `the copy's database search_path was never poisoned; the pin was not exercised: ${JSON.stringify(settings)}`);
});

// The shared role a template (or prepared source) is built as is NOLOGIN and
// passwordless at rest. The build gives it a login and a fresh password and
// must take both away on every path — a failed build included, which is when
// a leftover login-capable shared role is at its most likely.
test('a failed template build returns the shared role to NOLOGIN without the temporary password', { timeout: 120000 }, async (t) => {
  if (!(await reachable(t))) return;
  const dbManager = harness(t);
  const tok = crypto.randomBytes(4).toString('hex');
  const source = `app_rlf${tok}`;
  const template = dbManager.stagingTemplateDbName(source);
  const { admin, created } = await adminControl();
  const wipe = async () => {
    for (const { datname } of (await admin.query("SELECT datname FROM pg_database WHERE datname LIKE $1", [`%${tok}%`])).rows) {
      await admin.query(`ALTER DATABASE ${datname} WITH ALLOW_CONNECTIONS true`).catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`).catch(() => {});
    }
    for (const { rolname } of (await admin.query("SELECT rolname FROM pg_roles WHERE rolname LIKE $1", [`%${tok}%`])).rows) {
      await admin.query(`DROP ROLE IF EXISTS ${rolname}`).catch(() => {});
    }
  };
  t.after(async () => {
    await dbManager._templateIdleForTest(source).catch(() => {});
    await wipe();
    if (created) await admin.query('DROP DATABASE IF EXISTS usernode WITH (FORCE)').catch(() => {});
    await admin.end();
  });
  await admin.query(`CREATE DATABASE ${source}`);
  const src = await connect(at(BASE, source));
  // A private column on a table whose row-level security is FORCEd, so the
  // redaction refuses the build (the same refusal the direct-path test
  // asserts), this time from inside the template build.
  await src.query(`
    CREATE TABLE public.people (id int PRIMARY KEY, email text);
    INSERT INTO public.people VALUES (1, 'ann@prod.example');
    COMMENT ON COLUMN public.people.email IS 'staging:private';
    ALTER TABLE public.people ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.people FORCE ROW LEVEL SECURITY;
    CREATE POLICY hide_all ON public.people USING (false);`);
  await src.end();
  await assert.rejects(dbManager.refreshStagingTemplate(source),
    /row-level security|Failed to scrub/i);
  const left = (await admin.query(
    'SELECT r.rolcanlogin AS can_login, a.rolpassword IS NULL AS passwordless'
    + ' FROM pg_roles r JOIN pg_authid a ON a.oid = r.oid WHERE r.rolname = $1',
    [`${template}_owner`])).rows[0];
  assert.equal(left.can_login, false, 'the shared role is still login-capable after the failed build');
  assert.equal(left.passwordless, true, 'the shared role kept the temporary password after the failed build');
});

// An extension the app itself could have installed (a trusted one) is
// recreated by the owner-authenticated restore and commented by its owner —
// the comment pg_dump carries is evaluated as the copy's own owner, not the
// administrator. An extension only a superuser could have installed is the
// next test's.
test('a trusted extension is restored as the copy\'s own owner, comment and all', { timeout: 120000 }, async (t) => {
  if (!(await reachable(t))) return;
  const dbManager = harness(t);
  const tok = crypto.randomBytes(4).toString('hex');
  const source = `app_ext${tok}`;
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
  await src.query('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public');
  await src.end();
  await dbManager.cloneDatabase(source, target);
  // pg_extension is per database; read it inside the copy.
  const clone = await connect(at(BASE, target));
  const there = (await clone.query(
    'SELECT extowner::regrole::text AS owner, obj_description(oid, $1) IS NOT NULL AS commented'
    + ' FROM pg_extension WHERE extname = $2', ['pg_extension', 'pg_trgm'])).rows[0];
  await clone.end();
  assert.ok(there, 'the trusted extension was restored into the copy');
  assert.equal(there.owner, `${target}_owner`, `the extension is owned by the copy's own role (${there.owner}), not the administrator`);
  assert.equal(there.commented, true, 'the extension\'s comment was restored too');
});

// The database operator installs pg_stat_statements, which only a superuser
// may create, in every app database. The copy's own role cannot recreate it,
// so the administrator creates it in the still-empty copy and the dump leaves
// it out; everything else is still restored as the copy's own role. Without
// that, every copy of a production database failed to restore.
test('an extension only a superuser can create is made by the administrator, on every clone path', { timeout: 120000 }, async (t) => {
  if (!(await reachable(t))) return;
  const dbManager = harness(t);
  const tok = crypto.randomBytes(4).toString('hex');
  const source = `app_sux${tok}`;
  const direct = `${source}_staging_s1_abcdef`;
  const viaTmpl = `${source}_staging_s2_abcdef`;
  const { admin, created } = await adminControl();
  const wipe = async () => {
    for (const { datname } of (await admin.query("SELECT datname FROM pg_database WHERE datname LIKE $1", [`%${tok}%`])).rows) {
      await admin.query(`ALTER DATABASE ${datname} WITH ALLOW_CONNECTIONS true`).catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`).catch(() => {});
    }
    for (const { rolname } of (await admin.query("SELECT rolname FROM pg_roles WHERE rolname LIKE $1", [`%${tok}%`])).rows) {
      await admin.query(`DROP ROLE IF EXISTS ${rolname}`).catch(() => {});
    }
  };
  t.after(async () => {
    await dbManager._templateIdleForTest(source).catch(() => {});
    await wipe();
    if (created) await admin.query('DROP DATABASE IF EXISTS usernode WITH (FORCE)').catch(() => {});
    await admin.end();
  });
  const offered = (await admin.query(
    "SELECT 1 FROM pg_available_extension_versions WHERE name = 'pg_stat_statements' AND superuser AND NOT trusted")).rowCount > 0;
  if (!offered) { if (REQUIRED) assert.fail('this server does not offer pg_stat_statements'); t.skip('pg_stat_statements is not offered'); return; }
  await admin.query(`CREATE DATABASE ${source}`);
  const src = await connect(at(BASE, source));
  await src.query(SEED);
  await src.query('CREATE EXTENSION pg_stat_statements WITH SCHEMA public');
  await src.query('CREATE EXTENSION pg_trgm WITH SCHEMA public');
  await src.query('TRUNCATE public.redaction_probe');
  await src.end();

  await dbManager.cloneDatabase(source, direct);
  const res = await dbManager.cloneDatabase(source, viaTmpl, { viaTemplate: true });
  assert.equal(res.via, 'template', 'the template path made the second copy');
  for (const db of [direct, viaTmpl]) {
    const clone = await connect(at(BASE, db));
    const exts = new Set((await clone.query('SELECT extname FROM pg_extension')).rows.map((r) => r.extname));
    assert.ok(exts.has('pg_stat_statements'), `${db}: the administrator's extension is in the copy`);
    assert.ok(exts.has('pg_trgm'), `${db}: the trusted extension is in the copy`);
    // The rest was still loaded, and redacted, as the copy's own role.
    await assertRedacted(clone, db);
    await clone.end();
  }
});

// pg_restore can stop (--exit-on-error, or a refused login) while pg_dump is
// still writing. The pipe between them then fails with EPIPE; unhandled, that
// error took the whole process down (the conductor crash-looped on it). It
// must come back as the restore's own failure.
test('a restore that stops early fails the copy without taking the process down', { timeout: 120000 }, async (t) => {
  if (!(await reachable(t))) return;
  const dbManager = harness(t);
  const tok = crypto.randomBytes(4).toString('hex');
  const source = `app_epp${tok}`;
  const target = `${source}_staging_s1_abcdef`;
  const role = `${target}_owner`;
  const { admin, created } = await adminControl();
  t.after(async () => {
    for (const db of [target, source]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    if (created) await admin.query('DROP DATABASE IF EXISTS usernode WITH (FORCE)').catch(() => {});
    await admin.end();
  });
  await admin.query(`CREATE DATABASE ${source}`);
  const src = await connect(at(BASE, source));
  // Several megabytes that do not compress, far past what the pipe buffers.
  await src.query(`CREATE TABLE public.bulk AS
    SELECT g AS id, md5(random()::text) || md5(random()::text) || md5(random()::text) AS body
      FROM generate_series(1, 100000) g`);
  await src.end();
  // A role that may not log in, refused whatever the server's
  // authentication (a trust rule lets a wrong password in): pg_restore reads
  // the archive's header, fails to connect and exits, with nearly all of the
  // dump still to come.
  await admin.query(`CREATE ROLE ${role} NOLOGIN PASSWORD 'unused'`);
  await admin.query(`CREATE DATABASE ${target} TEMPLATE template0 OWNER ${role}`);
  await assert.rejects(dbManager.dumpRestore(source, target, [], { as: { user: role, password: 'unused' } }),
    /pg_restore=1/);
});
