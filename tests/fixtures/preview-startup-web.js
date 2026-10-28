'use strict';

// A separate web process, with SELECT on wf_instances and no runtime I/O.
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.PREVIEW_STARTUP_TEST_URL });
let privilegedCalls = 0;
require('../../src/services/platform-preview-retirement').retire = async () => {
  privilegedCalls++;
  throw new Error('web has no runtime authority');
};
let elapsed = 0;
async function main() {
  const { rows: [grants] } = await pool.query(`SELECT
    has_table_privilege(current_user, 'wf_instances', 'SELECT') AS read,
    has_table_privilege(current_user, 'wf_instances', 'UPDATE') AS write,
    has_table_privilege(current_user, 'wf_events', 'INSERT') AS append,
    has_table_privilege(current_user, 'apps', 'SELECT') AS read_apps`);
  const result = await require('../../src/services/platform-preview-startup').beforeServe(
    JSON.parse(process.env.PREVIEW_STARTUP_TEST_CONFIG), pool, {
      timeoutMs: 1000, now: () => elapsed,
      sleep: () => new Promise(resolve => {
        process.once('message', message => { if (message.expire) elapsed = 1000; resolve(); });
        process.send({ type: 'waiting', grants, privilegedCalls });
      }),
    });
  return { type: 'ready', result, privilegedCalls, grants };
}
main().catch(error => ({ type: 'refused', message: error.message, privilegedCalls }))
  .then(async message => {
    await pool.end();
    process.send(message, () => process.disconnect());
  });
