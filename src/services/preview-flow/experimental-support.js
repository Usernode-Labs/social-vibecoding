'use strict';

const { REDUCER_VERSION: previewVersion } = require('./reducer');
const { REDUCER_VERSION: cliVersion } = require('../cli-preview-handoff/reducer');
const { REDUCER_VERSION: reviewVersion } = require('../proposal-review/reducer');

// Fresh experimental stores only. Removed kinds must fail visibly instead of
// silently falling outside the worker's claim registry. This is not a migration
// or a permission to delete retained records or their external resources.
async function assertSupportedExperimentalStore(pool) {
  const { rows } = await pool.query(`SELECT
    (SELECT count(*)::int FROM execution_work_requests WHERE workflow IN
      ('native-preview-prepare', 'native-preview-template-prepare', 'native-preview-kpack-prepare')) AS historical_work,
    (SELECT count(*)::int FROM preview_flow_decisions WHERE reducer_version <> $1) AS preview_traces,
    (SELECT count(*)::int FROM cli_preview_decisions WHERE reducer_version NOT IN (3, 4, $2)) AS cli_traces,
    (SELECT count(*)::int FROM proposal_review_decisions WHERE reducer_version <> $3) AS review_traces`, [previewVersion, cliVersion, reviewVersion]);
  const inventory = rows[0];
  if (Object.values(inventory).some(count => count > 0)) {
    throw new Error(`Unsupported experimental store: ${JSON.stringify(inventory)}. `
      + 'Export historical traces with the offline archive and inventory/reconcile retained work and cleanup before replacing this store.');
  }
  return inventory;
}

module.exports = { assertSupportedExperimentalStore };
