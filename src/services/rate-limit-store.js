'use strict';

// The count behind a rate limiter that gates a send (a mail, a billed SMS),
// a bill (a paid model call) or a guess (a password, a code, a token):
// kept in Postgres (rate_limit_hits), so every process counts against one
// budget and a deploy does not hand everybody a fresh one. Before, each
// limiter counted in its process's memory: two web Pods were two budgets,
// and every release reset them all. The other limiters bound a runaway
// client and stay per process (middleware/rate-limits.js makeLimiter).
//
// An express-rate-limit store (its Store interface), one per limiter. A
// window starts with a key's first hit and lasts the limiter's windowMs, as
// the MemoryStore's does. A key is kept as the limiter's name and the hash
// of what it counts (an address, an email, an account), never the value.
//
// The pool is the process's, set at boot (server.js); a process that sets
// none (a unit test, a script) counts in memory. Rows past their window are
// deleted by the rate-limit-retention clock.

const crypto = require('node:crypto');

let pool = null;

/** The process's pool, set once at boot. */
function setPool(next) {
  pool = next || null;
}

const hashed = (prefix, key) => `${prefix}${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 40)}`;

const INCREMENT_SQL = `
  INSERT INTO rate_limit_hits (key, hits, reset_at) VALUES ($1, 1, now() + make_interval(secs => $2::double precision / 1000))
  ON CONFLICT (key) DO UPDATE SET
    hits = CASE WHEN rate_limit_hits.reset_at <= now() THEN 1 ELSE rate_limit_hits.hits + 1 END,
    reset_at = CASE WHEN rate_limit_hits.reset_at <= now() THEN EXCLUDED.reset_at ELSE rate_limit_hits.reset_at END
  RETURNING hits, reset_at`;

class SharedStore {
  constructor(name) {
    this.prefix = `${name}:`;
    // Keys counted here are seen by every process.
    this.localKeys = false;
    this.windowMs = 60 * 1000;
    // Without a pool (a process that set none): this process's count.
    this.memory = new Map();
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async get(key) {
    const k = hashed(this.prefix, key);
    if (!pool) {
      const m = this.memory.get(k);
      return m && m.resetTime > new Date() ? { totalHits: m.totalHits, resetTime: m.resetTime } : undefined;
    }
    const { rows: [r] } = await pool.query('SELECT hits, reset_at FROM rate_limit_hits WHERE key = $1 AND reset_at > now()', [k]);
    return r ? { totalHits: Number(r.hits), resetTime: new Date(r.reset_at) } : undefined;
  }

  async increment(key) {
    const k = hashed(this.prefix, key);
    if (!pool) {
      const now = new Date();
      const m = this.memory.get(k);
      const next = m && m.resetTime > now
        ? { totalHits: m.totalHits + 1, resetTime: m.resetTime }
        : { totalHits: 1, resetTime: new Date(now.getTime() + this.windowMs) };
      this.memory.set(k, next);
      return { ...next };
    }
    const { rows: [r] } = await pool.query(INCREMENT_SQL, [k, this.windowMs]);
    return { totalHits: Number(r.hits), resetTime: new Date(r.reset_at) };
  }

  async decrement(key) {
    const k = hashed(this.prefix, key);
    if (!pool) {
      const m = this.memory.get(k);
      if (m && m.totalHits > 0) this.memory.set(k, { ...m, totalHits: m.totalHits - 1 });
      return;
    }
    await pool.query('UPDATE rate_limit_hits SET hits = GREATEST(hits - 1, 0) WHERE key = $1 AND reset_at > now()', [k]);
  }

  async resetKey(key) {
    const k = hashed(this.prefix, key);
    if (!pool) { this.memory.delete(k); return; }
    await pool.query('DELETE FROM rate_limit_hits WHERE key = $1', [k]);
  }
}

/** Rows past their window: the rate-limit-retention clock's run. */
async function prune(db) {
  const { rowCount } = await db.query(`DELETE FROM rate_limit_hits WHERE reset_at < now() - interval '1 hour'`);
  return { deleted: rowCount };
}

module.exports = { SharedStore, setPool, prune };
