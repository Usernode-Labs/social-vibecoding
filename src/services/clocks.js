'use strict';

// The workflow's scheduled jobs, as the routes reach them (src/workflow/
// clock/, through platform.ts): a job's last run, read from any process,
// and an admin's "run it now", waited for. A module of its own so a route
// test can stand in for the runtime.

const platform = () => require('../workflow/platform.ts');

module.exports = {
  status: (db, job) => platform().clockStatus(db, job),
  runNow: (job, admin, opts) => platform().runClockNow(job, admin, opts),
};
