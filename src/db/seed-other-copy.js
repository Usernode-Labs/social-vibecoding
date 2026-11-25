'use strict';

// Run a change's own staging seeds against the pair's BEFORE copy.
//
// A shots pair is two throwaway copies of a redacted production database,
// each booted by its own revision, so each runs its own staging seeds
// (src/db/migrate.js). A change that adds demo rows for its own shots
// therefore had that data only on the after copy, and a change whose before
// side needs the same rows could not be photographed at all. This module
// runs the head revision's seeds against the base copy's database, so both
// copies hold the data when the base schema can hold it.
//
// The head revision's schema is never applied here. Each seed gets its own
// transaction, and one that cannot apply on the before copy (a table or
// column it lacks, or a media file only the after copy holds) is rolled
// back and recorded, so the seed's rows go in whole or not at all. The only
// database this opens is the base copy's disposable one; the seed runtime
// checks that its name is the run's base shots database before it starts.

const { Client } = require('pg');
const log = require('../services/logger');
const stagingMedia = require('../services/staging-media-store');
const { runStagingSeeds } = require('./migrate');

const SAVEPOINT = 'seed_other_copy';

// The pool a seed sees is the caller's client, with two differences: every
// failed statement is recorded even when the seed catches it, and the
// BEGIN/COMMIT/ROLLBACK a seed or withStagingMedia issues become savepoints
// inside the seed's own transaction.
function seedPool(client, onError) {
  const query = async (sql, params) => {
    try {
      if (typeof sql !== 'string') return await client.query(sql, params);
      const normalized = sql.trim().toUpperCase();
      if (normalized === 'BEGIN') return await client.query(`SAVEPOINT ${SAVEPOINT}`);
      if (normalized === 'COMMIT') return await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      if (normalized === 'ROLLBACK') return await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      return await client.query(sql, params);
    } catch (error) {
      onError(error);
      throw error;
    }
  };
  return {
    query,
    // Eight staging seeds open their own connection; give them this one.
    connect: async () => ({ query, release() {} }),
  };
}

function whyOf(error) {
  return error instanceof stagingMedia.StagingMediaNotShared
    || error?.code === 'staging_media_not_shared' ? 'media' : 'schema';
}

/**
 * Runs every staging seed (except one that reaches beyond the database)
 * against `databaseUrl`, one transaction per seed. Resolves
 * `{ version: 1, applied: [name], leftOut: [{ name, why }] }`.
 */
async function applySeedsToOtherCopy(databaseUrl, config, { seeds = null } = {}) {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 60_000,
    query_timeout: 60_000,
    application_name: require('./connection-options').connectionName('shots-seeds'),
  });
  // A second connection: a seed's own uncommitted media_objects row must not
  // make the file look present on the before copy.
  const reader = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 60_000,
    query_timeout: 60_000,
    application_name: require('./connection-options').connectionName('shots-seeds-read'),
  });
  try {
    await client.connect();
    await reader.connect();
  } catch (error) {
    // Whichever of the two connections opened is closed here: a failure to
    // reach the before copy must not leave one held open.
    await client.end().catch(() => {});
    await reader.end().catch(() => {});
    throw error;
  }
  stagingMedia.useOtherCopy(reader);
  const applied = [];
  const leftOut = [];
  try {
    await runStagingSeeds(null, config, {
      ...(seeds ? { seeds } : {}),
      each: async (entry) => {
        let failure = null;
        const note = (error) => { failure = failure || error; };
        await client.query('BEGIN');
        try {
          await entry.run(seedPool(client, note), config);
          if (failure) throw failure;
          const committed = await client.query('COMMIT');
          if (committed?.command === 'ROLLBACK') {
            throw new Error(`Seed ${entry.name} left its transaction aborted.`);
          }
          applied.push(entry.name);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          const why = whyOf(failure || error);
          leftOut.push({ name: entry.name, why });
          log.warn('shots', 'A staging seed could not be written to the before copy', {
            seed: entry.name, why, error: String((failure || error)?.message || error),
          });
        }
      },
    });
  } finally {
    stagingMedia.clearOtherCopy();
    await client.end().catch(() => {});
    await reader.end().catch(() => {});
  }
  return { version: 1, applied, leftOut };
}

module.exports = { applySeedsToOtherCopy };
