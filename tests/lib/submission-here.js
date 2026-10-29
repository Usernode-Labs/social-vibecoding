'use strict';

// submit_work's writes are a conductor's (services/fork-operations.js
// `work.submit` and `work.discard`): services/external-agent-tasks.js asks
// for them through platform-operations and waits. A unit test of that
// service runs them here instead, in its own process, with the deps it handed
// submitWork (its fake `gh`, `githubLink` and pool) and inert steps, the way
// a conductor runs them after it has read the requester's authority again
// (tests/fork-operations.test.js covers that half). The request goes through
// JSON, as it does to a conductor, so a test cannot pass by handing the
// conductor something it could not carry.
//
//   const restore = submissionsHere();   // for the whole file
//   ...
//   restore();
//
// `restore.requests` lists what was asked, in order.

const svc = require('../../src/services/external-agent-tasks');
const forkOperations = require('../../src/services/fork-operations');

function submissionsHere() {
  const requests = [];
  let n = 0;
  const prior = svc._setConductorForTests(async (p, deps) => {
    n += 1;
    const requestId = `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
    const { payload = null, ...request } = JSON.parse(JSON.stringify({ ...p, requestId }));
    requests.push({ ...request, payload });
    const user = { id: request.userId };
    try {
      const result = request.op === 'work.discard'
        ? await forkOperations.discardHere(deps, request, user)
        : await forkOperations.submitHere(deps, request, user, payload);
      return { ...(result && result.ok === false ? result : { ok: true, ...(result || {}) }), requestId };
    } catch (err) {
      return { ok: false, status: 500, error: err.message, requestId };
    }
  });
  const restore = () => svc._setConductorForTests(prior);
  restore.requests = requests;
  return restore;
}

module.exports = { submissionsHere };
