const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { validateCopy, assertIdentities, normalizeSchema, copyDatabase } = require('../src/services/database-copy');
const connection = (host, database) => ({ host, port: 5432, database, user: `${database}_owner`,
  password: 'do-not-log-this', ca: '-----BEGIN CERTIFICATE-----\nfixture' });
const config = () => ({ source: connection('source.svc', 'app_source'),
  destination: connection('destination.svc', 'app_copy_test'), maxBytes: 256 * 1024 * 1024, timeoutMs: 60000 });
const identity = (c, address) => ({ database: c.database, owner: c.user, address, owns_database: true,
  rolsuper: false, rolcreatedb: false, rolcreaterole: false, recovery: false,
  version: 17, encoding: 'UTF8', datcollate: 'C', datctype: 'C' });

test('copy refuses invalid endpoints, owner credentials and unbounded resource budgets', () => {
  assert.doesNotThrow(() => validateCopy(config()));
  for (const mutate of [c => c.source.host = c.destination.host, c => c.destination.database = 'postgres',
    c => c.source.host = 'source; rm -rf /', c => c.destination.user = 'postgres', c => c.source.ca = '',
    c => c.source.password = '', c => c.maxBytes *= 2, c => c.timeoutMs = 0, c => c.timeoutMs = 600000]) {
    const c = config(); mutate(c); assert.throws(() => validateCopy(c), /^Error: COPY_/);
  }
});

test('actual server identity prevents aliasing, replica and privileged-role copies', () => {
  const c = config(), source = identity(c.source, '10.0.0.1'), target = identity(c.destination, '10.0.0.2');
  assert.doesNotThrow(() => assertIdentities(source, target, c));
  for (const patch of [{address: source.address}, {address: null}, {recovery: true}, {rolsuper: true},
    {rolcreatedb: true}, {rolcreaterole: true}, {owns_database: false}, {owner: 'other'}, {database: 'other'},
    {version: 16}, {encoding: 'LATIN1'}, {datcollate: 'en_US'}, {datctype: 'en_US'}]) {
    assert.throws(() => assertIdentities(source, {...target, ...patch}, c), /^Error: COPY_/);
  }
});

test('schema comparison excludes random psql tokens while retaining app schema comments', () => {
  const text = "-- app-private field\n\\restrict abc\nCREATE TABLE x (id int);\n\\unrestrict abc\n";
  assert.equal(normalizeSchema(text), '-- app-private field\nCREATE TABLE x (id int);\n');
});

function clients(c, overrides = {}) {
  const created = [];
  const makeClient = options => {
    const dest = options.host === c.destination.host;
    const client = new EventEmitter();
    Object.assign(client, { options, ended: false, statements: [], connect: async () => {},
      end: async () => { client.ended = true; }, query: async sql => {
        client.statements.push(sql);
        if (sql.includes('current_database() AS database')) return {rows: [identity(dest ? c.destination : c.source, dest ? '10.0.0.2' : '10.0.0.1')]};
        if (sql.includes('pg_try_advisory_lock')) return {rows: [{locked: overrides.locked !== false}]};
        if (sql.includes('c.relkind, c.relrowsecurity')) return {rows: dest && overrides.occupied ? [{relkind:'r'}] : []};
        if (sql.includes('pg_extension')) return {rows: [{found: !!overrides.unsupported}]};
        if (sql.includes('count(*)::integer AS n')) return {rows: [{n: 0}]};
        if (sql.includes('pg_database_size')) return {rows: [{bytes: String(overrides.bytes || 100)}]};
        if (sql.includes('pg_export_snapshot')) return {rows: [{snapshot: '00000001-00000002-1'}]};
        if (sql.includes('c.relkind=') || sql.includes('c.relkind IN')) return {rows: []};
        if (sql.includes('pg_get_userbyid(c.relowner)')) return {rows: [{found: false}]};
        if (sql.startsWith('BEGIN') || sql === 'COMMIT') return {rows: []};
        throw new Error('unexpected query');
      } });
    created.push(client); return client;
  };
  return {makeClient, created};
}

test('busy, occupied, unsupported and oversized databases fail before invoking transfer', async () => {
  for (const [patch, code] of [[{locked: false}, 'COPY_DESTINATION_BUSY'], [{occupied: true}, 'COPY_DESTINATION_NOT_EMPTY'],
    [{unsupported: true}, 'COPY_UNSUPPORTED_OBJECTS'], [{bytes: 300 * 1024 * 1024}, 'COPY_SIZE_LIMIT']]) {
    const c = config(), fake = clients(c, patch);
    await assert.rejects(copyDatabase(c, {...fake, transfer: () => assert.fail('must not copy')}), {code});
    assert.ok(fake.created.every(v => v.ended));
    assert.ok(fake.created.every(v => v.options.ssl.rejectUnauthorized));
  }
});

test('copy binds transfer to its read-only snapshot and reports only verification hashes', async () => {
  const c = config(), fake = clients(c); let invoked = false;
  const result = await copyDatabase(c, {...fake, schema: async () => 'hash', transfer: async (src, dst, snapshot) => {
    invoked = true;
    assert.equal(snapshot, '00000001-00000002-1');
    assert.equal(src.PGSSLMODE, 'verify-full');
    assert.equal(dst.PGSSLMODE, 'verify-full');
    assert.match(src.PGOPTIONS, /read_only=on/);
    assert.equal(src.PGUSER, c.source.user); assert.equal(dst.PGUSER, c.destination.user);
    assert.equal(src.DATABASE_URL, undefined); assert.equal(src.DB_ADMIN_URL, undefined);
  }});
  assert.ok(invoked); assert.equal(result.rowCount, '0');
  assert.ok(fake.created[0].statements.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.ok(fake.created.every(v => v.ended));
  assert.doesNotMatch(JSON.stringify(result), /do-not-log-this|CERTIFICATE|source.svc/);
});

test('failed transfer and schema mismatch cannot report success or expose tool diagnostics', async () => {
  for (const mismatch of [false, true]) {
    const c = config(), fake = clients(c); let calls = 0;
    await assert.rejects(copyDatabase(c, {...fake, schema: async () => mismatch ? String(calls++) : 'same',
      transfer: async () => { if (!mismatch) throw Error('password do-not-log-this and private row'); }}),
    error => error.code === (mismatch ? 'COPY_VERIFICATION_FAILED' : 'COPY_DATABASE_OPERATION_FAILED')
      && !error.message.includes('do-not-log-this'));
    assert.ok(fake.created.every(v => v.ended));
    assert.ok(!fake.created[0].statements.includes('COMMIT'));
  }
});
