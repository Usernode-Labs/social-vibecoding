'use strict';

// What the leader keeps in memory and an admin screen reads, for the
// processes that do not lead (docs/plans/web-and-conductor.md): a web process
// never leads, so a route there would otherwise answer with an empty status,
// or none, for work that runs on the conductor.
//
// The leader names each status it keeps (`provide`, from server.js
// becomeLeader) and writes them all to leader_status every PUBLISH_MS while
// it leads; a route reads one with `read`, which answers from memory where
// the work runs and from the table everywhere else. A copy older than
// STALE_MS is nobody's: its leader stopped writing (it was replaced, or
// died), and `read` answers null, as a process with no such work always did.
//
// Values are what the route would have sent: plain JSON, so a Date arrives as
// the ISO string res.json() would have made of it.

const log = require('./logger');
const processes = require('./processes');
const lifecycle = require('./lifecycle');

const PUBLISH_MS = 10 * 1000;
const STALE_MS = 2 * 60 * 1000;

const providers = new Map(); // key -> () => value
let pool = null;
let timer = null;
let publishing = null;

function provide(key, read) {
  if (typeof read !== 'function') throw new TypeError(`leader-status: ${key} needs a function`);
  providers.set(key, read);
}

function provides(key) {
  return providers.has(key);
}

async function publish() {
  if (!pool || !providers.size || lifecycle.isShuttingDown()) return;
  if (publishing) return publishing;
  publishing = (async () => {
    for (const [key, read] of providers) {
      let value;
      try {
        value = JSON.stringify(read() ?? null);
      } catch (err) {
        log.warn('leader-status', 'Could not read a status to publish', { key, err: err.message });
        continue;
      }
      try {
        await pool.query(
          `INSERT INTO leader_status (key, value, process_id, published_at) VALUES ($1, $2::jsonb, $3, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, process_id = EXCLUDED.process_id,
             published_at = NOW()`,
          [key, value, processes.ID]);
      } catch (err) {
        log.warn('leader-status', 'Could not publish a status', { key, err: err.message });
      }
    }
  })().finally(() => { publishing = null; });
  return publishing;
}

/** The leader: write what it provides now, and every PUBLISH_MS. */
function start({ pool: db }) {
  pool = db;
  if (!timer) {
    timer = setInterval(() => { publish().catch(() => {}); }, PUBLISH_MS);
    timer.unref?.();
  }
  return publish().catch(() => {});
}

/** It stopped leading: nothing more is written, and the copies age out. */
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * A status, wherever its work runs: from this process's memory when it
 * provides it, else the leader's copy if it is fresh, else null. Never
 * throws: a copy the database will not give is null.
 */
async function read(key, db) {
  const local = providers.get(key);
  if (local) return local();
  if (!db) return null;
  try {
    const { rows: [row] } = await db.query(
      `SELECT value FROM leader_status
        WHERE key = $1 AND published_at > NOW() - make_interval(secs => $2)`,
      [key, STALE_MS / 1000]);
    return row ? row.value : null;
  } catch (err) {
    log.warn('leader-status', 'Could not read a published status', { key, err: err.message });
    return null;
  }
}

/** Tests: forget everything. */
function _reset() {
  stop();
  providers.clear();
  pool = null;
  publishing = null;
}

module.exports = { PUBLISH_MS, STALE_MS, provide, provides, publish, start, stop, read, _reset };
