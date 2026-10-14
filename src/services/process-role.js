'use strict';

// What a platform process runs (docs/plans/web-and-conductor.md).
//
//   all        everything, as every platform process did before the split:
//              it serves HTTP and WebSockets and stands for the leader lock.
//              The default, so docker-compose, local development, tests and
//              staging previews are unchanged.
//   web        serves HTTP and WebSockets and never stands for leader. A
//              route still starts what it always started (a turn, a preview
//              build, a shots run) and finishes it on a release, as any
//              process does (docs/plans/draining-releases.md).
//   conductor  stands for leader and runs what the leader runs (the
//              workflow loops, the timers and sweeps, the merge queue, the
//              Homeroom bot, the bench lane). It listens on HTTP too, for
//              callbacks addressed to its own Pod, but no Service sends it
//              people's requests.
//
// Read from PROCESS_ROLE. An unknown value fails boot rather than guess: a
// typo that ran as 'all' would serve, and a typo that ran as 'web' on the
// only process would leave nothing leading.

const ROLES = Object.freeze(['all', 'web', 'conductor']);

function processRole(env = process.env) {
  const raw = String(env.PROCESS_ROLE ?? '').trim().toLowerCase();
  if (!raw) return 'all';
  if (!ROLES.includes(raw)) {
    throw new Error(`PROCESS_ROLE must be one of ${ROLES.join(', ')} (got ${JSON.stringify(env.PROCESS_ROLE)})`);
  }
  return raw;
}

function standsForLeader(role) {
  return role !== 'web';
}

// Whether a Service sends this process people's requests: what a release
// makes live is what these run (platform-release.js recordRunning).
function servesRequests(role) {
  return role !== 'conductor';
}

// The roles that take over what a process of `role` does when a release
// replaces it, and that count among its successors and its fellow drainers
// (services/processes.js servingOthers, newerDraining). What a release must
// not leave without is the leader: a conductor or an 'all' is replaced by
// either, so the split can be switched on and off by a release of its own.
// People's requests are Kubernetes' to move (a Pod leaves the Service when
// it terminates), so a web process is replaced by a web or an 'all'.
const SUCCESSORS = Object.freeze({
  all: Object.freeze(['all', 'conductor']),
  conductor: Object.freeze(['conductor', 'all']),
  web: Object.freeze(['web', 'all']),
});

function successorRoles(role) {
  return SUCCESSORS[role] || SUCCESSORS.all;
}

module.exports = { ROLES, processRole, standsForLeader, servesRequests, successorRoles };
