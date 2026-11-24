'use strict';

// A project's making (src/workflow/app-creation/), stood in for where no
// workflow runs: the insert of its row starts it (a Started event, by the
// database's own trigger), and its repository arrives a moment later.
//
//   const making = standInForMaking(pool);
//   await making.started();   // the ids of the projects whose making started
//   await making.stop();      // before the pool ends
//
// It remembers nothing, and what was made is read from the database. A
// stand-in that counted the events it read, on a timer that did not wait for
// its own last look, counted one event twice whenever a look took longer
// than the timer: "the host app is made once: 2 !== 1" for one host.

const STARTED = "machine = 'app-creation' AND type = 'Started'";

function standInForMaking(pool, { everyMs = 20 } = {}) {
  let stopped = false;
  const looking = (async () => {
    while (!stopped) {
      await pool.query(
        `UPDATE apps SET repo_url = 'https://github.com/usernode-bot/' || slug, status = 'running'
          WHERE repo_url IS NULL AND id IN (SELECT app_id FROM wf_events WHERE ${STARTED})`,
      );
      await new Promise((resolve) => { setTimeout(resolve, everyMs); });
    }
  })();
  // A look that failed is stop()'s to report, not an unhandled rejection.
  looking.catch(() => {});
  return {
    async started() {
      const { rows } = await pool.query(`SELECT app_id FROM wf_events WHERE ${STARTED} ORDER BY id`);
      return rows.map((r) => r.app_id);
    },
    async stop() {
      stopped = true;
      await looking;
    },
  };
}

module.exports = { standInForMaking };
