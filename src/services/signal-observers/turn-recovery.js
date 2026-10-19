'use strict';

// turn_recovery_gave_up: interrupted turns the platform stopped trying to
// pick up again in the last 24 hours, as one problem.
//
// A turn a restart or a failure interrupted is retried with backoff while
// its active_turn is kept (services/recovery-retry.js); after its last
// attempt the retry gives up, records 'turn_recovery_gave_up' and leaves the
// turn to the stale-turn watchdog, which ends it and tells its owner
// (services/turn-lifecycle.js). Each one is a person's turn that was lost
// because the platform could not resume it, so any is worth a request.
//
// Everything said is typed: counts, error codes, session ids, attempts.

const GAVE_UP_SQL = `
  SELECT e.created_at, e.session_id, e.metadata
    FROM events e
   WHERE e.event_type = 'turn_recovery_gave_up'
     AND e.created_at > NOW() - interval '24 hours'
   ORDER BY e.created_at DESC
   LIMIT 500`;

const iso = (v) => (v ? new Date(v).toISOString().replace(/\.\d+Z$/, 'Z') : 'unknown');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const word = (v, max = 60) => String(v ?? '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, max);
const list = (xs, max = 10) => {
  const shown = xs.slice(0, max);
  return xs.length > max ? `${shown.join(', ')} and ${xs.length - max} more` : shown.join(', ');
};
const counted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .map(([what, n]) => `${what} (${n})`);

/** The one item, or none, from the window's events. Pure. */
function gaveUpItems(rows) {
  if (!rows.length) return [];
  const codes = new Map();
  const recoveries = new Map();
  const sessions = [];
  const attempts = new Set();
  for (const r of rows) {
    const m = r.metadata || {};
    const code = word(m.code) || 'no code';
    codes.set(code, (codes.get(code) || 0) + 1);
    const recovery = word(m.recovery, 30);
    if (recovery) recoveries.set(recovery, (recoveries.get(recovery) || 0) + 1);
    const id = Number(m.sessionId ?? r.session_id);
    if (Number.isSafeInteger(id) && id > 0 && !sessions.includes(id)) sessions.push(id);
    if (Number.isInteger(m.failures) && m.failures > 0) attempts.add(m.failures);
  }
  const times = rows.map((r) => new Date(r.created_at).getTime()).filter(Number.isFinite);
  const first = times.length ? Math.min(...times) : null;
  const last = times.length ? Math.max(...times) : null;
  return [{
    kind: 'turn_recovery_gave_up',
    key: 'all',
    subject: { scope: 'all' },
    title: 'Interrupted turns given up on: recovery ran out of attempts',
    summary: 'Turns that were interrupted (a restart, a worker or database failure) were retried until their recovery ran out '
      + 'of attempts, and then given up on: the stale-turn watchdog ended each one and told its owner, '
      + 'so each was a person\'s turn lost because the platform could not pick it up again.',
    occurrences: rows.length,
    evidence: {
      lines: [
        `${plural(rows.length, 'turn', 'turns')} given up on in the last 24 hours`
          + (first != null ? `, the first at ${iso(first)}${last !== first ? `, the last at ${iso(last)}` : ''}.` : '.'),
        `Error codes of the last failed attempt: ${counted(codes).join(', ')}.`,
        recoveries.size ? `Recoveries: ${counted(recoveries).join(', ')}.` : null,
        attempts.size ? `Attempts before giving up: ${[...attempts].sort((a, b) => a - b).join(', ')}.` : null,
        sessions.length ? `Sessions: ${list(sessions)}.` : null,
      ].filter(Boolean),
      where: ['src/services/recovery-retry.js', 'src/services/turn-lifecycle.js'],
    },
  }];
}

async function run(pool) {
  const { rows } = await pool.query(GAVE_UP_SQL);
  return gaveUpItems(rows);
}

module.exports = { run, gaveUpItems, GAVE_UP_SQL };
