'use strict';

const { Client } = require('pg');
const { z } = require('zod');
const db = require('../db-manager');

const identifier = z.string().regex(/^[a-z_][a-z0-9_]*$/).max(63);
const operationSchema = z.object({
  operationId: z.string().uuid(),
  dbName: identifier,
  sourceDb: identifier,
}).strict();

function cloneOperation(intent) {
  if (intent.cloneOperation?.kind !== 'template-v1') throw new Error('Template clone intent required');
  const operation = operationSchema.parse({
    operationId: intent.attemptId,
    dbName: intent.dbName,
    sourceDb: intent.cloneOperation.sourceDb,
  });
  if (!new RegExp(`^app_p_s[1-9][0-9]*_${operation.operationId.replace(/-/g, '')}$`).test(operation.dbName)) {
    throw new Error('Clone database must belong to its isolated attempt');
  }
  identifier.parse(db.ownerRoleName(operation.dbName));
  return operation;
}

function createCloneOperations({
  databaseUrl = process.env.DB_ADMIN_URL || process.env.DATABASE_URL,
  maintenanceDatabase = 'usernode',
  ensureTemplate = db.ensureStagingTemplate,
  onPhase = async () => {},
} = {}) {
  identifier.parse(maintenanceDatabase);

  async function connect(database) {
    const url = new URL(databaseUrl);
    url.pathname = `/${database}`;
    // Never inherit the platform fixture's search_path or a pool's session.
    url.searchParams.delete('options');
    const client = new Client({
      connectionString: url.toString(),
      connectionTimeoutMillis: 5000,
      statement_timeout: 120000,
      lock_timeout: 1000,
      application_name: 'preview-template-operation',
    });
    let lost;
    client.on('error', error => { lost = error; });
    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
    return {
      query(text, values) {
        if (lost) throw lost;
        return client.query(text, values);
      },
      assertConnected() {
        if (lost) throw lost;
      },
      close: () => client.end(),
    };
  }

  const guardName = operation => `preview-clone:${operation.dbName}`;

  async function acquire(client, operation, transactional = false) {
    const sql = transactional
      ? 'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired'
      : 'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired';
    return (await client.query(sql, [guardName(operation)])).rows[0].acquired;
  }

  async function guarded(intent, run) {
    const operation = cloneOperation(intent);
    const client = await connect(maintenanceDatabase);
    try {
      if (!await acquire(client, operation)) return { status: 'uncertain', reason: 'busy' };
      return await run(client, operation);
    } finally {
      await client.close();
    }
  }

  function marker(operation, phase, extra = {}) {
    return { version: 1, ...operation, phase, ...extra };
  }

  function matches(value, operation) {
    return value?.version === 1 && value.operationId === operation.operationId
      && value.dbName === operation.dbName && value.sourceDb === operation.sourceDb;
  }

  function parseMarker(value) {
    try { return JSON.parse(value); } catch { return null; }
  }

  function literal(value) {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }

  async function observe(client, operation) {
    const roleName = db.ownerRoleName(operation.dbName);
    const role = (await client.query(`SELECT oid::text, rolcanlogin, shobj_description(oid, 'pg_authid') AS marker
      FROM pg_roles WHERE rolname = $1`, [roleName])).rows[0];
    const database = (await client.query(`SELECT oid::text, datdba::text,
      shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1`,
    [operation.dbName])).rows[0];

    if (!role && !database) return { status: 'absent' };
    const roleMarker = parseMarker(role?.marker);
    if (!matches(roleMarker, operation) || (database && database.datdba !== role?.oid)) {
      return { status: 'uncertain', reason: 'ownership_conflict' };
    }
    if (roleMarker.databaseOid && database && roleMarker.databaseOid !== database.oid) {
      return { status: 'uncertain', reason: 'ownership_conflict' };
    }
    if (roleMarker.phase === 'retired') return { status: 'retired', role, database };
    if (roleMarker.phase !== 'copying') return { status: 'uncertain', reason: 'ownership_conflict' };
    if (roleMarker.databaseOid && !database) return { status: 'uncertain', reason: 'resource_missing', role };
    const completed = parseMarker(database?.marker);
    if (completed?.phase === 'complete') {
      if (!matches(completed, operation) || completed.databaseOid !== database.oid || completed.roleOid !== role.oid) {
        return { status: 'uncertain', reason: 'ownership_conflict' };
      }
      return { status: 'complete', databaseOid: database.oid, role, database };
    }
    return { status: 'incomplete', role, database };
  }

  async function targetTransaction(control, operation, run) {
    const target = await connect(operation.dbName);
    try {
      control.assertConnected();
      await target.query('BEGIN');
      if (!await acquire(target, operation, true)) return { status: 'uncertain', reason: 'busy' };
      const result = await run(target);
      control.assertConnected();
      await target.query('COMMIT');
      return result;
    } finally {
      // Closing also rolls back after an error or a busy guard. There is no
      // detached target transaction after releasing the maintenance guard.
      await target.close();
    }
  }

  async function inspect(intent) {
    return guarded(intent, async (control, operation) => {
      const observed = await observe(control, operation);
      if (!observed.database) return observed;
      return targetTransaction(control, operation, async () => observed);
    });
  }

  async function prepare(intent, password) {
    z.string().regex(/^[a-f0-9]{48}$/).parse(password);
    return guarded(intent, async (control, operation) => {
      let observed = await observe(control, operation);
      if (observed.status === 'complete') {
        return targetTransaction(control, operation, async () => observed);
      }
      if (observed.status === 'retired' || observed.status === 'uncertain') return observed;
      const targetRole = db.ownerRoleName(operation.dbName);
      const templateRole = db.ownerRoleName(db.stagingTemplateDbName(operation.sourceDb));

      if (!observed.database) {
        const template = await ensureTemplate(operation.sourceDb);
        identifier.parse(template.template);
        if (template.template !== db.stagingTemplateDbName(operation.sourceDb)) {
          throw new Error('Unexpected clone template identity');
        }
        control.assertConnected();
        if (!observed.role) {
          await control.query('BEGIN');
          await control.query(`CREATE ROLE ${targetRole} NOLOGIN PASSWORD '${password}'`);
          await control.query(`COMMENT ON ROLE ${targetRole} IS ${literal(marker(operation, 'copying'))}`);
          await control.query('COMMIT');
        }
        await onPhase('before_copy');
        await control.query(`CREATE DATABASE ${operation.dbName} TEMPLATE ${template.template} OWNER ${targetRole}`);
        await onPhase('copy_committed');
        observed = await observe(control, operation);
      }

      await control.query(`COMMENT ON ROLE ${targetRole} IS ${literal(marker(operation, 'copying', {
        databaseOid: observed.database.oid,
      }))}`);

      const finalized = await targetTransaction(control, operation, async target => {
        // Recheck physical identity on the target connection, not just a name
        // observed before connecting. Finalization and its receipt are atomic.
        const current = await observe(target, operation);
        if (current.status === 'complete') return current;
        if (current.status !== 'incomplete' || current.database?.oid !== observed.database?.oid) {
          return { status: 'uncertain', reason: 'ownership_conflict' };
        }
        const execute = async (database, sql, options = {}) => {
          if (database !== operation.dbName) throw new Error('Clone finalization database mismatch');
          control.assertConnected();
          const result = await target.query(sql);
          if (!options.tuplesOnly) return '';
          return result.rows.map(row => Object.values(row).map(value => value === true ? 't'
            : value === false ? 'f' : value == null ? '' : String(value)).join('|')).join('\n');
        };

        await db.reassignUserObjectsTo(operation.dbName, templateRole, targetRole, execute);
        await onPhase('ownership_changed', { target, operation });
        await db.truncatePrivateTables(operation.dbName, execute);
        await db.scrubPrivateColumns(operation.dbName, execute);
        await execute(operation.dbName, `REVOKE CONNECT ON DATABASE ${operation.dbName} FROM PUBLIC`);
        await execute(operation.dbName, `GRANT ALL PRIVILEGES ON DATABASE ${operation.dbName} TO ${targetRole}`);
        await execute(operation.dbName, `ALTER DATABASE ${operation.dbName} CONNECTION LIMIT ${db.stagingConnectionLimit()}`);
        await execute(operation.dbName, `ALTER ROLE ${targetRole} LOGIN`);
        const databaseOid = current.database.oid;
        await execute(operation.dbName, `COMMENT ON DATABASE ${operation.dbName} IS ${literal(marker(operation, 'complete', {
          databaseOid,
          roleOid: current.role.oid,
        }))}`);
        await onPhase('before_finalize_commit');
        return { status: 'complete', databaseOid };
      });
      if (finalized.status === 'complete') await onPhase('finalize_committed');
      return finalized;
    });
  }

  async function remove(intent) {
    return guarded(intent, async (control, operation) => {
      const observed = await observe(control, operation);
      if (observed.status === 'uncertain' && observed.reason !== 'resource_missing') return observed;
      if (observed.database) {
        const checked = await targetTransaction(control, operation, async () => ({ status: 'idle' }));
        if (checked.status !== 'idle') return checked;
      }

      const roleName = db.ownerRoleName(operation.dbName);
      await control.query('BEGIN');
      if (!observed.role) await control.query(`CREATE ROLE ${roleName} NOLOGIN`);
      else await control.query(`ALTER ROLE ${roleName} NOLOGIN`);
      const databaseOid = observed.database?.oid || parseMarker(observed.role?.marker)?.databaseOid;
      await control.query(`COMMENT ON ROLE ${roleName} IS ${literal(marker(operation, 'retired', {
        ...(databaseOid ? { databaseOid } : {}),
      }))}`);
      await control.query('COMMIT');
      await onPhase('retirement_committed');
      if (observed.database) await control.query(`DROP DATABASE ${operation.dbName} WITH (FORCE)`);
      await onPhase('database_removed');
      const released = await observe(control, operation);
      if (released.status !== 'retired' || released.database || released.role.rolcanlogin
          || (observed.role && released.role.oid !== observed.role.oid)) {
        return { status: 'uncertain', reason: 'release_unconfirmed' };
      }
      // Keep the role even after absence. It rejects delayed creation using
      // this operation ID; absence alone cannot revoke earlier external work.
      return { status: 'removed' };
    });
  }

  return { inspect, prepare, remove };
}

module.exports = { cloneOperation, createCloneOperations };
