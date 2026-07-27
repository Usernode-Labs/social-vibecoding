// Platform database export — the full, unredacted `pg_dump` an admin can
// download from the admin console (#admin/db-export).
//
// WHY IT SHELLS OUT: the platform image (Dockerfile) is node:22-alpine +
// `docker-cli git` — there is NO postgresql-client inside this container,
// so `pg_dump` is not on our PATH and never will be. What we DO have is
// the host docker socket bind-mounted into the `usernode` service, and a
// `usernode-db` container (postgres:17-alpine) that ships pg_dump. That's
// the same mechanism db-manager.js `dumpRestore()` already uses for every
// staging clone, and the same shape as scripts/pull-remote-db.sh. So the
// export runs `docker exec <db container> pg_dump …` and streams the
// bytes straight through to the HTTP response.
//
// TWO RULES THAT ARE NOT OPTIONAL:
//
//   1. ARGV ONLY, NEVER `sh -c`. db-manager's clone path uses a shell
//      string because it needs a pipe (`pg_dump | pg_restore`). We don't,
//      and this path is *user-triggerable*, so nothing here may ever be
//      spliced into a shell. The database name is additionally validated
//      against SAFE_IDENT before it reaches the argv.
//   2. spawn(), NEVER execFile(). execFile buffers stdout in memory; the
//      platform DB carries bytea payloads (chat_session_attachments.data
//      is up to 20 MB each, plus issue_screenshots / session_visuals), so
//      a buffered dump is an OOM against the container's 3 GB cap. The
//      child's stdout is piped chunk-by-chunk into the response with
//      backpressure.
//
// The HTTP surface (auth, password re-entry, the audit rows) lives in
// src/routes/admin.js. This module owns process management, the
// single-flight guard, and the short-lived download tickets.

const { spawn } = require('child_process');
const crypto = require('crypto');
const log = require('./logger');

// Same defaults db-manager.js uses. Compose sets DB_CONTAINER=usernode-db;
// the fallback only matters for a fork that never sets it.
const DB_CONTAINER = process.env.DB_CONTAINER || 'project-usernode-db';
const DB_USER = process.env.DB_USER || 'usernode';

// Same guard db-manager.js applies to every database identifier.
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/i;

// Mirrors DB_CLONE_TIMEOUT_MS in db-manager.js, but longer: a clone writes
// into a local container, an export pushes every byte over the network to
// a browser, so a slow client legitimately takes longer.
const DB_EXPORT_TIMEOUT_MS = Number(process.env.DB_EXPORT_TIMEOUT_MS) || 15 * 60 * 1000;

// Grace between SIGTERM and SIGKILL when we abandon a dump.
const KILL_GRACE_MS = 5000;

// Download tickets are single-use and very short-lived; the browser
// navigates to the URL immediately after the POST resolves.
const TICKET_TTL_MS = 60 * 1000;

// Cap on captured stderr so a pathological failure can't balloon an audit
// row (the text is additionally redacted before it is stored).
const STDERR_CAP = 4000;

// How many exports one admin may take per rolling 24h. The enforcement
// lives in the rate limiter (middleware/rate-limits.js dbExportLimiter);
// this constant is only for display in the capability probe. Keep the
// two in sync.
const MAX_PER_DAY = 3;

// ── Environment ───────────────────────────────────────────────────────

// Staging previews must never be able to export. Three layers guard it
// (see the spec): staging containers don't get the docker socket at all,
// this server-side check, and a disabled button driven off the capability
// probe. This is a DELIBERATE exception to the "never gate features on
// USERNODE_ENV" convention in src/prompts/app-conventions.md, and it must
// stay: the self-staging auth path (middleware/auth.js) hands out a real
// session for a cloned `users` row that kept is_admin, so an admin
// session is trivially reachable in a preview — and a preview must not be
// able to `docker exec` into the production database. Do not "fix" this
// by deleting the check; the client stays env-literal-free instead.
function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

// ── Target database ───────────────────────────────────────────────────

// Pull the database name out of a postgres:// URL. Handles passwords
// containing '@' (the last '@' separates credentials from the host) and
// strips any query string.
function parseDbName(databaseUrl) {
  if (!databaseUrl || typeof databaseUrl !== 'string') return null;
  const withoutScheme = databaseUrl.replace(/^[a-z+]+:\/\//i, '');
  const at = withoutScheme.lastIndexOf('@');
  const hostAndPath = at === -1 ? withoutScheme : withoutScheme.slice(at + 1);
  const slash = hostAndPath.indexOf('/');
  if (slash === -1) return null;
  let name = hostAndPath.slice(slash + 1);
  const q = name.search(/[?#]/);
  if (q !== -1) name = name.slice(0, q);
  name = name.trim();
  if (!name) return null;
  try { name = decodeURIComponent(name); } catch { /* keep raw */ }
  return name;
}

// Resolve (and validate) what we would dump. Returns
// { dbName, container, dbUser, reason } — dbName is null when we can't
// safely export, with `reason` explaining why.
function resolveTargetDb(config) {
  const base = { dbName: null, container: DB_CONTAINER, dbUser: DB_USER, reason: null };
  const parsed = parseDbName(config && config.databaseUrl);
  if (!parsed) return { ...base, reason: 'no_database_url' };
  if (!SAFE_IDENT.test(parsed)) {
    log.warn('db-export', 'Refusing to export: database name failed SAFE_IDENT', { dbName: parsed });
    return { ...base, reason: 'unsafe_db_name' };
  }
  // A fork may legitimately have renamed the platform DB — warn, don't fail.
  if (config && config.selfAppDbName && config.selfAppDbName !== parsed) {
    log.warn('db-export', 'Export target differs from config.selfAppDbName', {
      target: parsed, selfAppDbName: config.selfAppDbName,
    });
  }
  return { ...base, dbName: parsed };
}

// usernode-platform-<db>-20260727T121314Z.dump
function exportFilename(dbName, now) {
  const d = now instanceof Date ? now : new Date();
  const stamp = d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `usernode-platform-${dbName}-${stamp}.dump`;
}

// ── Single-flight guard ───────────────────────────────────────────────
//
// `usernode-db` runs on 4 GB / 4 CPUs and already competes with staging
// `pg_dump | pg_restore` clones. One export at a time, platform-wide.

let _current = null;

function isExportInProgress() { return !!_current; }
function currentExport() { return _current ? { ..._current } : null; }

function beginExport(info) {
  if (_current) return false;
  _current = { startedAt: Date.now(), ...(info || {}) };
  return true;
}

function endExport() { _current = null; }

// ── Download tickets ──────────────────────────────────────────────────
//
// The confirm step needs a password in a request BODY (a POST), but the
// deliverable is a real browser download (a navigated GET carrying
// Content-Disposition). A single-use, 60-second, user-bound ticket
// bridges the two. In-memory only: never persisted, never logged in full.

const _tickets = new Map();

function _sweepTickets(now) {
  for (const [token, t] of _tickets) {
    if (t.expiresAt <= now) _tickets.delete(token);
  }
}

function issueTicket({ userId, ip, auditId, dbName }) {
  const now = Date.now();
  _sweepTickets(now);
  const token = crypto.randomBytes(32).toString('hex');
  _tickets.set(token, {
    token, userId, ip: ip || null, auditId: auditId || null,
    dbName: dbName || null, expiresAt: now + TICKET_TTL_MS,
  });
  return { token, expiresInSeconds: Math.round(TICKET_TTL_MS / 1000) };
}

// Single-use: a valid ticket is deleted on the first successful consume.
// Returns the ticket, or null when it is unknown / expired / belongs to
// another user.
function consumeTicket(token, userId) {
  const now = Date.now();
  _sweepTickets(now);
  if (!token || typeof token !== 'string') return null;
  const t = _tickets.get(token);
  if (!t) return null;
  if (t.expiresAt <= now) { _tickets.delete(token); return null; }
  if (t.userId !== userId) return null; // do NOT delete — not this user's to burn
  _tickets.delete(token);
  return t;
}

function _resetTickets() { _tickets.clear(); }

// ── The dump itself ───────────────────────────────────────────────────

// Stream `docker exec <container> pg_dump -U <user> -Fc --no-password <db>`
// into `res`. Always resolves (never rejects) with
// { status, bytesSent, error }, where status is one of
// 'completed' | 'failed' | 'cancelled'.
//
// Headers are written lazily, on the FIRST stdout byte: if the child dies
// immediately (bad container name, missing database) nothing has been
// committed yet and we can still answer with a JSON error.
function runExport({ dbName, res, filename, onStart, spawnFn }) {
  return new Promise((resolve) => {
    if (!SAFE_IDENT.test(String(dbName || ''))) {
      resolve({ status: 'failed', bytesSent: 0, error: 'unsafe database name' });
      return;
    }

    // Argv form. No shell, no interpolation, nothing splice-able.
    const args = ['exec', DB_CONTAINER, 'pg_dump', '-U', DB_USER, '-Fc', '--no-password', dbName];

    let child;
    try {
      child = (spawnFn || spawn)('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ status: 'failed', bytesSent: 0, error: err.message });
      return;
    }

    let headersSent = false;
    let bytesSent = 0;
    let stderr = '';
    let clientGone = false;
    let timedOut = false;
    let settled = false;
    let killTimer = null;

    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ status, bytesSent, error: error || null, headersSent });
    };

    const killChild = () => {
      if (child.exitCode !== null || child.signalCode) return;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      if (killTimer) return;
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, KILL_GRACE_MS);
      if (killTimer.unref) killTimer.unref();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      log.error('db-export', 'Export timed out — killing pg_dump', { dbName, bytesSent });
      killChild();
    }, DB_EXPORT_TIMEOUT_MS);
    if (timeoutTimer.unref) timeoutTimer.unref();

    const sendHeaders = () => {
      headersSent = true;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // No Content-Length: the size isn't known up front, so this is a
      // chunked response and the browser shows an indeterminate progress.
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (typeof onStart === 'function') {
        try { onStart(); } catch { /* audit bookkeeping must not break the stream */ }
      }
    };

    child.stderr.on('data', (chunk) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.toString('utf8');
    });

    child.stdout.on('data', (chunk) => {
      if (clientGone) return;
      if (!headersSent) sendHeaders();
      bytesSent += chunk.length;
      // Backpressure: a slow browser must not make us buffer the dump.
      if (res.write(chunk) === false) {
        child.stdout.pause();
        res.once('drain', () => { try { child.stdout.resume(); } catch {} });
      }
    });

    child.on('error', (err) => {
      log.error('db-export', 'Failed to spawn pg_dump', { message: err.message });
      if (!headersSent && !res.headersSent) {
        try { res.status(500).json({ error: 'Export failed to start', code: 'export_failed' }); } catch {}
      } else {
        try { res.destroy(); } catch {}
      }
      finish('failed', err.message);
    });

    // The client hung up (cancelled the download, closed the tab, lost the
    // network). Kill the child so pg_dump isn't left holding a snapshot
    // open against the production database.
    res.on('close', () => {
      if (settled) return;
      if (!res.writableEnded) {
        clientGone = true;
        log.warn('db-export', 'Client disconnected mid-export — killing pg_dump', { dbName, bytesSent });
        killChild();
      }
    });

    child.on('close', (code) => {
      if (clientGone) { finish('cancelled', null); return; }
      if (timedOut) {
        if (headersSent) { try { res.destroy(); } catch {} }
        else if (!res.headersSent) {
          try { res.status(504).json({ error: 'Export timed out', code: 'export_timeout' }); } catch {}
        }
        finish('failed', `timed out after ${DB_EXPORT_TIMEOUT_MS}ms`);
        return;
      }
      if (code === 0) {
        try { res.end(); } catch {}
        finish('completed', null);
        return;
      }
      // Non-zero exit. If bytes are already on the wire we CANNOT send an
      // error status — destroy the socket so the browser records a failed
      // download instead of silently keeping a truncated file.
      const detail = log.redactString
        ? log.redactString(stderr.slice(0, STDERR_CAP))
        : stderr.slice(0, STDERR_CAP);
      log.error('db-export', 'pg_dump exited non-zero', { dbName, code, stderr: detail });
      if (headersSent) { try { res.destroy(); } catch {} }
      else if (!res.headersSent) {
        try { res.status(500).json({ error: 'Export failed', code: 'export_failed' }); } catch {}
      }
      finish('failed', `pg_dump exited ${code}: ${detail}`.slice(0, STDERR_CAP));
    });
  });
}

module.exports = {
  DB_CONTAINER,
  DB_USER,
  DB_EXPORT_TIMEOUT_MS,
  TICKET_TTL_MS,
  MAX_PER_DAY,
  SAFE_IDENT,
  isStaging,
  parseDbName,
  resolveTargetDb,
  exportFilename,
  isExportInProgress,
  currentExport,
  beginExport,
  endExport,
  issueTicket,
  consumeTicket,
  runExport,
  _resetTickets,
};
