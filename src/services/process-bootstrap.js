'use strict';
// What every platform process sets up before it does any work, whether it
// serves the website (server.js) or only runs the workflow runtime's work
// items and timers (workflow-worker.js). Both call these, so code that runs
// in either process finds the same clients and the same hooks.

const { getPool } = require('../db/pool');

// The service clients work handlers and routes call into: phone pushes
// (pushToUser syncs the app icon's badge from the process that emits it),
// GitHub, and the LLM with its telemetry.
async function initServices(config) {
  await require('./mobile-push').initialize(config);
  await require('./github').init(config);
  // Configure the collection kill switch even on deployments with no
  // Anthropic client. OpenRouter/local coding runs are initialized by their
  // own paths and still need the provider-neutral collector.
  require('./llm-telemetry').init(config);
  await require('./llm').init(config);
}

// Module-level hooks other modules call back into, registered once per
// process.
function registerHooks(config) {
  require('./worker').setAccountDeletionGuard((sessionId) => require('./account-deletion-cleanup')
    .assertWorkerAllowed(getPool(config), sessionId));

  // The Workshop's placement stage runs when a card arrives on or leaves a
  // board — which every route and service announces through
  // ws.pushSessionUpdate / pushIssueUpdate — on whichever process handled
  // the change (the row's lease keeps two from racing). Registered in every
  // process, not under the leader, for that reason; the daily re-draft is
  // the leader's sweep.
  const ws = require('./ws');
  const workshopThemes = require('./workshop-themes');
  const previewLifecycle = require('./preview-lifecycle');
  if (typeof ws.onBoardChange === 'function') {
    // Announced from inside preview runs too; the debounced reconcile
    // outlives them, so it must not keep a run's guarded pool.
    ws.onBoardChange((info) => previewLifecycle.detach(() => workshopThemes.noteBoardChange(getPool(config), info)));
  }

  // A promoted head whose checks were deferred because it conflicted with
  // main (services/check-admission.js) gets them the moment it measures
  // clean — against the preview that is already up for it, so a run rather
  // than a rebuild. Measurement happens wherever the vote, the sweep or the
  // capture ran, so the hook is registered in every process, like the board
  // hook above. recheckSessionChecks is _inFlight-guarded at the capture; a
  // second kick for the same head costs nothing.
  require('./integration').onBecameClean(async (row) => {
    const pool = getPool(config);
    const { rows } = await pool.query(
      `SELECT cs.*, a.slug AS app_slug, a.repo_url, a.name AS app_name
         FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
        WHERE cs.id = $1 AND cs.status = 'promoted'
          AND cs.check_state = 'pending' AND cs.check_phase = 'deferred'`,
      [row.id]
    );
    if (!rows[0]) return;
    await require('./staging-recovery').recheckSessionChecks({
      config, pool, session: rows[0], reason: 'conflict-resolved',
    });
  });
}

module.exports = { initServices, registerHooks };
