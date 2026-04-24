const { execFile } = require('child_process');
const { promisify } = require('util');
const { getPool } = require('../db/pool');
const log = require('./logger');
const workerProgress = require('./worker-progress');

const execFileAsync = promisify(execFile);

const WORKER_PREFIX = 'usernode-worker-';
const APP_PREFIX = 'usernode-app-';
const STAGING_PREFIX = 'usernode-staging-';

// Match SPEC.md limits.
const MAX_STAGING_GLOBAL = 25;
const MAX_STAGING_PER_USER = 3;
const WORKER_ORPHAN_THRESHOLD_MS = 20 * 60 * 1000;
const STUCK_SESSION_THRESHOLD_MS = 2 * 60 * 1000;

// Match sessions.js LLM caps so the dashboard shows the same numbers.
const USER_DAILY_LIMIT_CENTS = 2500;
const GLOBAL_DAILY_LIMIT_CENTS = 20000;

async function listContainers() {
  try {
    const { stdout } = await execFileAsync('docker', [
      'ps', '-a',
      '--format', '{{.Names}}\t{{.ID}}\t{{.State}}\t{{.Status}}\t{{.Image}}',
    ], { timeout: 5000 });
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, id, state, status, image] = line.split('\t');
        return { name, id, state, status, image };
      });
  } catch (err) {
    log.warn('status', 'docker ps failed', { err: err.message });
    return [];
  }
}

async function getStats() {
  try {
    const { stdout } = await execFileAsync('docker', [
      'stats', '--no-stream',
      '--format', '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}',
    ], { timeout: 10000 });
    const map = {};
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const [name, mem, cpu] = line.split('\t');
      map[name] = { mem, cpu };
    }
    return map;
  } catch {
    return {};
  }
}

async function inspectStarted(name) {
  try {
    const { stdout } = await execFileAsync('docker', [
      'inspect', '--format', '{{.State.StartedAt}}', name,
    ], { timeout: 3000 });
    const t = stdout.trim();
    return t && !t.startsWith('0001-') ? t : null;
  } catch {
    return null;
  }
}

function uptimeSeconds(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

async function gather(config, { isAdmin = false } = {}) {
  const pool = getPool(config);

  const [appsQ, sessionsQ, llmQ, containers, stats] = await Promise.all([
    pool.query(
      `SELECT a.id, a.name, a.slug, a.repo_url, a.container_id, a.status, a.created_at,
              u.username AS created_by_username,
              (SELECT COUNT(*) FROM chat_sessions cs
                 WHERE cs.app_id = a.id AND cs.status = 'active') AS open_sessions,
              (SELECT COUNT(*) FROM issues i
                 WHERE i.app_id = a.id AND i.status = 'open') AS open_issues
       FROM apps a
       LEFT JOIN users u ON a.created_by = u.id
       ORDER BY a.created_at ASC`
    ),
    pool.query(
      `SELECT cs.id, cs.app_id, cs.branch_name, cs.pr_number, cs.pr_url, cs.pr_title,
              cs.staging_container_id, cs.staging_url, cs.status, cs.created_at,
              u.username, u.id AS user_id, a.slug AS app_slug
       FROM chat_sessions cs
       LEFT JOIN users u ON cs.user_id = u.id
       JOIN apps a ON cs.app_id = a.id
       WHERE cs.status = 'active'
       ORDER BY cs.created_at DESC`
    ),
    pool.query(
      `SELECT u.username, u.id AS user_id, lu.total_cost_cents
       FROM llm_usage lu JOIN users u ON u.id = lu.user_id
       WHERE lu.date = CURRENT_DATE
       ORDER BY lu.total_cost_cents DESC`
    ),
    listContainers(),
    getStats(),
  ]);

  const apps = appsQ.rows;
  const sessions = sessionsQ.rows;
  const llmUsage = llmQ.rows.map((r) => ({
    username: r.username,
    userId: r.user_id,
    costCents: parseFloat(r.total_cost_cents || 0),
  }));

  const byName = Object.fromEntries(containers.map((c) => [c.name, c]));

  // Workers (ephemeral, per chat turn).
  const workerContainers = containers.filter((c) => c.name.startsWith(WORKER_PREFIX));
  const workers = await Promise.all(workerContainers.map(async (c) => {
    const startedAt = await inspectStarted(c.name);
    const sessionId = parseInt(c.name.slice(WORKER_PREFIX.length), 10) || null;
    const sess = sessions.find((s) => s.id === sessionId);
    const prog = workerProgress.get(sessionId);
    const uptime = uptimeSeconds(startedAt);
    return {
      name: c.name,
      id: c.id,
      state: c.state,
      status: c.status,
      sessionId,
      appSlug: sess?.app_slug || null,
      username: sess?.username || null,
      sessionArchived: sessionId != null && !sess,
      startedAt,
      uptimeSeconds: uptime,
      orphan: (uptime !== null && uptime * 1000 > WORKER_ORPHAN_THRESHOLD_MS) ||
              (sessionId != null && !sess),
      lastProgress: prog?.text || null,
      lastProgressAt: prog?.at || null,
      model: prog?.model || null,
      stats: stats[c.name] || null,
    };
  }));

  // Apps — nest sessions, nest worker under each session.
  const appTree = await Promise.all(apps.map(async (app) => {
    const prodName = `${APP_PREFIX}${app.slug}`;
    const prod = byName[prodName];
    const prodStarted = prod ? await inspectStarted(prodName) : null;

    const appSessions = sessions
      .filter((s) => s.app_id === app.id)
      .map((s) => {
        const stagingName = `${STAGING_PREFIX}${app.slug}--${s.id}`;
        const staging = byName[stagingName];
        const worker = workers.find((w) => w.sessionId === s.id) || null;
        return {
          id: s.id,
          branchName: s.branch_name,
          prNumber: s.pr_number,
          prUrl: s.pr_url,
          prTitle: s.pr_title,
          stagingUrl: s.staging_url,
          username: s.username,
          userId: s.user_id,
          createdAt: s.created_at,
          ageSeconds: uptimeSeconds(s.created_at),
          status: s.status,
          staging: staging ? {
            name: staging.name,
            state: staging.state,
            status: staging.status,
            stats: stats[staging.name] || null,
          } : null,
          stagingDriftWarning: !!s.staging_container_id && !staging,
          worker: worker ? {
            name: worker.name,
            state: worker.state,
            uptimeSeconds: worker.uptimeSeconds,
            lastProgress: worker.lastProgress,
            lastProgressAt: worker.lastProgressAt,
            model: worker.model,
            orphan: worker.orphan,
          } : null,
        };
      });

    return {
      id: app.id,
      name: app.name,
      slug: app.slug,
      repoUrl: app.repo_url,
      dbStatus: app.status,
      createdBy: app.created_by_username,
      createdAt: app.created_at,
      openSessions: parseInt(app.open_sessions, 10),
      openIssues: parseInt(app.open_issues, 10),
      prod: prod ? {
        name: prodName,
        state: prod.state,
        status: prod.status,
        image: prod.image,
        startedAt: prodStarted,
        uptimeSeconds: uptimeSeconds(prodStarted),
        stats: stats[prodName] || null,
      } : null,
      prodMissing: !prod && app.status !== 'creating',
      sessions: appSessions,
    };
  }));

  // Counters.
  const stagingContainers = containers.filter((c) => c.name.startsWith(STAGING_PREFIX));
  const stagingRunning = stagingContainers.filter((c) => c.state === 'running').length;

  const stagingPerUser = {};
  for (const s of sessions) {
    if (s.staging_container_id) {
      stagingPerUser[s.username] = (stagingPerUser[s.username] || 0) + 1;
    }
  }

  // Sessions that have a branch but no staging URL for > 2 min — the exact
  // drift state the server-side recoverSessions() scans for on startup.
  const stuckSessions = sessions
    .filter((s) =>
      s.branch_name &&
      !s.staging_url &&
      Date.now() - new Date(s.created_at).getTime() > STUCK_SESSION_THRESHOLD_MS
    )
    .map((s) => ({
      id: s.id,
      appSlug: s.app_slug,
      username: s.username,
      branchName: s.branch_name,
      ageSeconds: uptimeSeconds(s.created_at),
    }));

  const globalSpendCents = llmUsage.reduce((a, r) => a + r.costCents, 0);

  // Dead Caddy-ish references: container_id recorded in DB but missing from docker.
  const driftContainers = [];
  for (const a of appTree) {
    if (a.prodMissing) {
      driftContainers.push({ kind: 'app', slug: a.slug, expected: a.prod?.name || `${APP_PREFIX}${a.slug}` });
    }
    for (const s of a.sessions) {
      if (s.stagingDriftWarning) {
        driftContainers.push({ kind: 'staging', slug: a.slug, sessionId: s.id, expected: `${STAGING_PREFIX}${a.slug}--${s.id}` });
      }
    }
  }

  // Strip admin-only fields from worker objects when not admin.
  // Kept private: live Claude Code progress text, model name, exact timestamps.
  const redactWorker = (w) => {
    if (!w) return w;
    if (isAdmin) return w;
    const { lastProgress, lastProgressAt, model, ...rest } = w;
    return rest;
  };

  const publicWorkers = workers.map(redactWorker);
  const publicApps = appTree.map((a) => ({
    ...a,
    sessions: a.sessions.map((s) => ({ ...s, worker: redactWorker(s.worker) })),
  }));

  const summary = {
    apps: apps.length,
    prodRunning: appTree.filter((a) => a.prod?.state === 'running').length,
    prodMissing: appTree.filter((a) => a.prodMissing).length,
    stagingRunning,
    stagingCap: MAX_STAGING_GLOBAL,
    workersRunning: workers.filter((w) => w.state === 'running').length,
    workersOrphaned: workers.filter((w) => w.orphan).length,
    stuckSessions: stuckSessions.length,
  };
  if (isAdmin) {
    summary.globalSpendCents = globalSpendCents;
    summary.globalSpendCap = GLOBAL_DAILY_LIMIT_CENTS;
  }

  const payload = {
    now: new Date().toISOString(),
    version: process.env.GIT_SHA || 'dev',
    isAdmin,
    limits: {
      stagingGlobal: MAX_STAGING_GLOBAL,
      stagingPerUser: MAX_STAGING_PER_USER,
      userDailyCents: isAdmin ? USER_DAILY_LIMIT_CENTS : undefined,
      globalDailyCents: isAdmin ? GLOBAL_DAILY_LIMIT_CENTS : undefined,
      workerOrphanThresholdMs: WORKER_ORPHAN_THRESHOLD_MS,
    },
    summary,
    apps: publicApps,
    workers: publicWorkers,
    stuckSessions,
    stagingPerUser,
    driftContainers,
  };

  if (isAdmin) {
    payload.llmUsage = llmUsage;
    payload.events = log.tail(50);
  }

  return payload;
}

module.exports = { gather };
