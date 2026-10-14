// Whether a platform process is still alive, without a heartbeat: each
// process holds one session-level advisory lock, keyed by its own name, on
// a connection it keeps for its whole life (services/process-presence.js),
// and exits if that connection ends while it holds records that name it.
// So the lock is held exactly while the process can still act, and a crash
// or a release ends it at once. Leadership is held the same way
// (services/leadership.js).
//
// What a process records as working on a session (the preview machine's
// operations, src/workflow/preview/) names it as `holder`; a reader counts a
// record only while its holder's lock is held. The SQL here is that test.

// The classifier half of `pg_advisory_lock(classifier, key)`; registered
// with the platform's other lock ids in services/advisory-locks.js.
export const PROCESS_PRESENCE_LOCK = 991016;

// The key half, from the holder's name, as both sides compute it.
export const PRESENCE_KEY_SQL = (holder: string) => `(hashtext(${holder}) & 2147483647)`;

// True while the process named by the SQL expression `holder` is alive.
export function holderAliveSql(holder: string): string {
  return `EXISTS (SELECT 1 FROM pg_locks l
                   WHERE l.locktype = 'advisory' AND l.granted
                     AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
                     AND l.classid = ${PROCESS_PRESENCE_LOCK}::oid
                     AND l.objid = ${PRESENCE_KEY_SQL(holder)}::oid
                     AND l.objsubid = 2)`;
}
