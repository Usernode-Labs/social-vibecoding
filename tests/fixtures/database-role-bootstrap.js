'use strict';
// Controlled interruption after a durable empty-template CREATE. No data or
// credentials leave this fixture; the parent decides when to stop the process.
const { Client } = require('pg');
const query = Client.prototype.query;
Client.prototype.query = async function (sql, ...args) {
  const result = await query.call(this, sql, ...args);
  const name = typeof sql === 'string' && /^CREATE DATABASE "(homeroom_(?:prepare|empty)_[a-f0-9]+)"/.exec(sql)?.[1];
  if (name) {
    process.send({ type: 'prepared', name });
    await new Promise(() => {});
  }
  return result;
};
require('../../scripts/bootstrap-database-roles').bootstrap().then(() => {
  process.send({ type: 'complete' });
}).catch(error => {
  process.send({ type: 'failed', code: error.code || 'bootstrap_failed' });
  process.exitCode = 1;
});
