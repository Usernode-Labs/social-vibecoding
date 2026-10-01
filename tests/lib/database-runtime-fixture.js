'use strict';

const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { createCloneOperations } = require('../../src/services/preview-flow/clone-operation');
const { candidateResources } = require('../../src/services/preview-flow/candidate-resources');
const { decrypt } = require('../../src/services/secrets');
const { fixtureFor } = require('./runtime-integration-fixture');
const { verifyIsolatedBuildFixture } = require('./isolated-kpack-fixture');
const { runtimeTestWorker } = require('./runtime-test-worker');

// HTTP is healthy only when the actual per-attempt database query succeeds.
const DATABASE_SERVER = ['node', '-e', `
  const { Pool } = require('/opt/evidence/node_modules/pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 2000, query_timeout: 2000 });
  require('http').createServer(async (request, response) => {
    try {
      const result = await pool.query('SELECT value FROM evidence');
      if (result.rows[0]?.value !== process.env.EVIDENCE) throw new Error('Wrong database');
      response.end(process.env.TOKEN);
    } catch { response.statusCode = 503; response.end('database unavailable'); }
  }).listen(3000, '0.0.0.0');
`];

function credentialUrl(fixture, intent, password, address) {
  const url = new URL(fixture.isolation.database.url);
  url.pathname = `/${intent.dbName}`;
  url.username = `${intent.dbName}_owner`;
  url.password = password;
  url.search = '';
  if (address) {
    url.hostname = address;
    url.port = '5432';
  }
  return url.toString();
}

function cloneService(fixture, onPhase) {
  return createCloneOperations({
    databaseUrl: fixture.isolation.database.url,
    maintenanceDatabase: new URL(fixture.isolation.database.url).pathname.slice(1),
    // Only source-template selection is injected. Copy, ownership, redaction,
    // credential fencing and forced removal use the actual PostgreSQL server.
    ensureTemplate: async source => ({ template: `${source}_stgtmpl` }),
    onPhase,
  });
}

function databaseWorker(pool, fixture, clients, databaseAddress, options = {}) {
  return runtimeTestWorker(pool, fixture, clients, {
    command: DATABASE_SERVER,
    clones: cloneService(fixture, options.onPhase),
    runtimeEnvironment: (intent, password) => ({
      DATABASE_URL: credentialUrl(fixture, intent, password, databaseAddress),
      EVIDENCE: fixture.isolation.fixtureId,
    }),
    ...options,
  });
}

async function databaseFixture(t) {
  // Fail before even creating the execution schema if the dedicated SQL client
  // image or inspected PostgreSQL address was not provisioned/verified.
  const verified = await verifyIsolatedBuildFixture();
  assert.ok(verified.fixture.databaseRuntimeImage, 'Dedicated database runtime image required');
  assert.ok(verified.databaseAddress, 'Verified disposable PostgreSQL address required');
  return fixtureFor(t, async ({ pool, fixture, clients, sessionId, databaseAddress }) => {
    fixture.runtimeImage = fixture.databaseRuntimeImage;
    // The dedicated registry recipe uses app slug demo. Keep the seeded
    // template identity aligned with that pinned test recipe.
    const sourceDb = 'app_demo';
    const template = `${sourceDb}_stgtmpl`;
    const templateRole = `${template}_owner`;
    const admin = new Client({ connectionString: fixture.isolation.database.url });
    await admin.connect();
    const databases = new Set([template]);
    const roles = new Set([templateRole]);
    const opened = [];
    t.after(async () => {
      for (const client of opened) await client.end().catch(() => {});
      // This server is preflight-verified and disposable. Only identities
      // created/remembered by this case are removed, never a wildcard inventory.
      for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      for (const name of roles) await admin.query(`DROP ROLE IF EXISTS ${name}`);
      await admin.end();
    });
    await admin.query(`CREATE ROLE ${templateRole} NOLOGIN`);
    await admin.query(`CREATE DATABASE ${template} TEMPLATE template0 OWNER ${templateRole}`);
    const seedUrl = new URL(fixture.isolation.database.url);
    seedUrl.pathname = `/${template}`;
    const seed = new Client({ connectionString: seedUrl.toString() });
    await seed.connect();
    await seed.query('CREATE TABLE evidence (value TEXT)');
    await seed.query('INSERT INTO evidence VALUES ($1)', [fixture.isolation.fixtureId]);
    await seed.query(`ALTER TABLE evidence OWNER TO ${templateRole}`);
    await seed.end();
    await admin.query(`ALTER DATABASE ${template} ALLOW_CONNECTIONS false`);

    function remember(intent) {
      databases.add(intent.dbName);
      roles.add(`${intent.dbName}_owner`);
    }
    const servingIntent = {
      ...candidateResources(fixture.config, sessionId + 1, randomUUID()),
      cloneOperation: { kind: 'template-v1', sourceDb },
    };
    const servingPassword = randomBytes(24).toString('hex');
    remember(servingIntent);
    const clones = cloneService(fixture);
    const servingDatabase = await clones.prepare(servingIntent, servingPassword);
    assert.equal(servingDatabase.status, 'complete');

    async function credentials(intent) {
      remember(intent);
      const { rows: [resource] } = await pool.query(`SELECT clone_credential_enc
        FROM preview_flow_resources WHERE intent->>'attemptId' = $1`, [intent.attemptId]);
      return decrypt(resource.clone_credential_enc, 'c5-disposable-only');
    }
    async function connectOwner(intent, password = null) {
      const client = new Client({
        connectionString: credentialUrl(fixture, intent, password || await credentials(intent)),
        connectionTimeoutMillis: 5000,
      });
      client.on('error', () => {});
      opened.push(client);
      await client.connect();
      return client;
    }
    async function assertDatabase(intent, expectedOid, password) {
      const result = await clones.inspect(intent);
      assert.equal(result.status, 'complete');
      assert.equal(result.databaseOid, expectedOid);
      const client = await connectOwner(intent, password);
      assert.equal((await client.query('SELECT value FROM evidence')).rows[0].value, fixture.isolation.fixtureId);
      await client.end();
    }
    return {
      worker: {
        clones,
        command: DATABASE_SERVER,
        runtimeEnvironment: (intent, password) => {
          remember(intent);
          return {
            DATABASE_URL: credentialUrl(fixture, intent, password, databaseAddress),
            EVIDENCE: fixture.isolation.fixtureId,
          };
        },
      },
      servingEnvironment: {
        DATABASE_URL: credentialUrl(fixture, servingIntent, servingPassword, databaseAddress),
        EVIDENCE: fixture.isolation.fixtureId,
      },
      evidence: {
        admin, clones, databaseAddress, credentials, connectOwner, remember,
        assertDatabase,
        assertServingDatabase: () => assertDatabase(servingIntent, servingDatabase.databaseOid, servingPassword),
        recovery: options => databaseWorker(pool, fixture, clients, databaseAddress, options),
      },
    };
  });
}

module.exports = { DATABASE_SERVER, credentialUrl, cloneService, databaseWorker, databaseFixture };
