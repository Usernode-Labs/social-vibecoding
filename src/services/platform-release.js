'use strict';

// When a merge into Homeroom itself went live: chat_sessions.platform_live_at.
//
// A project's merge goes live inside the merge (its deploy is a step of it),
// but Homeroom's own release is cut from main afterwards and rolled out on
// its own, so the merge cannot say when production first ran it. The build
// can: every production process boots with the commit it was built from
// (GIT_SHA), and proposals are squash-merged, so main is a line of merges
// and a build at merge B carries every merge ordered at or before B, the
// rule release-watch.js's carriedBy already uses. On boot, the first
// process to serve a build stamps every merge it carries that has no stamp
// yet; a later process, a restart or a re-release of the same build finds
// them stamped and changes nothing, and a rollback stamps nothing new.
//
// A build whose commit is no merge's (a push straight to main) stamps
// nothing; the next build that is one stamps the merges it carries, so
// those read a little long rather than not at all. Staging never stamps:
// its previews boot with a proposal's commit, not production's.
//
// Read by the Infra topic's Merge → live (services/topic-figures.js).

const os = require('os');
const log = require('./logger');

const STAMP_SQL = `
  WITH boundary AS (
    SELECT COALESCE(cs.merged_at, cs.created_at) AS at, cs.id
      FROM chat_sessions cs
      JOIN apps ap ON ap.id = cs.app_id AND ap.self_hosted = TRUE
     WHERE cs.status = 'merged' AND LOWER(cs.merge_commit_sha) = $1::text
     ORDER BY COALESCE(cs.merged_at, cs.created_at) DESC, cs.id DESC
     LIMIT 1
  ), since AS (
    SELECT s.value::timestamptz AS at
      FROM platform_settings s
     WHERE s.key = 'platform_live_tracked_since'
  )
  UPDATE chat_sessions cs SET platform_live_at = NOW()
    FROM boundary b, since t, apps ap
   WHERE ap.id = cs.app_id AND ap.self_hosted = TRUE
     AND cs.status = 'merged' AND cs.platform_live_at IS NULL
     AND cs.merged_at >= t.at
     AND (COALESCE(cs.merged_at, cs.created_at), cs.id) <= (b.at, b.id)
  RETURNING cs.id`;

/**
 * Stamp the merges the running build carries. Never throws: a failure is
 * logged and the figure goes without this release.
 * @returns {Promise<number>} how many merges were stamped
 */
async function recordRunning(pool, { sha = process.env.GIT_SHA, env = process.env.USERNODE_ENV } = {}) {
  const commit = String(sha || '').toLowerCase();
  if (env === 'staging' || !/^[0-9a-f]{40}$/.test(commit)) return 0;
  try {
    const { rows } = await pool.query(STAMP_SQL, [commit]);
    if (rows.length) log.info('platform-release', 'Merges now live', { sha: commit.slice(0, 7), merges: rows.length });
    return rows.length;
  } catch (err) {
    log.warn('platform-release', 'Could not record which merges went live', { sha: commit.slice(0, 7), err: err.message });
    return 0;
  }
}

// The role a process was told to run (services/process-role.js), when it
// was told one: web or conductor once the split is on, all before it. An
// unset or unreadable PROCESS_ROLE is not guessed at here.
function toldRole(env = process.env) {
  if (!String(env.PROCESS_ROLE ?? '').trim()) return null;
  try { return require('./process-role').processRole(env); } catch { return null; }
}

/**
 * Say that a production process came up on Kubernetes, and in which pod
 * (events 'platform_booted'). A pod keeps its name when Kubernetes starts its
 * container again after the process died (a crash, the memory limit, a
 * failed liveness probe); a rollout starts new pods. So a second boot in one
 * pod is a crash, which the infra topic's "Homeroom crashes" counts
 * (services/topic-figures.js). A process that dies before it serves records
 * nothing: a release that never comes up is release-watch's to report.
 * Staging's previews and anything off Kubernetes record nothing. Never
 * throws.
 *
 * It also says why the last one died, when one did (recordPodExit), and the
 * role it runs when it was told one, so the platform signals can group the
 * crashes (signal-observers/homeroom-crashes.js).
 */
function recordBoot(pool, {
  sha = process.env.GIT_SHA, env = process.env.USERNODE_ENV,
  onKubernetes = !!process.env.KUBERNETES_SERVICE_HOST, pod = os.hostname(),
  role = toldRole(), namespace = process.env.PLATFORM_NAMESPACE, readPod,
} = {}) {
  if (env === 'staging' || !onKubernetes || !pod) return Promise.resolve();
  const events = require('./events');
  const commit = String(sha || '').toLowerCase();
  const metadata = { sha: /^[0-9a-f]{40}$/.test(commit) ? commit : null, pod: String(pod) };
  if (role) metadata.role = role;
  return Promise.all([
    events.record(pool, { type: events.EVENT_TYPES.PLATFORM_BOOTED, metadata }),
    recordPodExit(pool, { env, onKubernetes, pod, namespace, role, readPod }),
  ]).then(() => {});
}

// The pod label the chart gives each platform Pod its role by
// (deploy/helm/social-vibecoding-platform/templates/platform.yaml).
const ROLE_LABEL = 'social.usernode.io/process-role';
// The chart's name for the platform's container.
const CONTAINER = 'platform';

const isoOf = (v) => {
  if (!v) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};
// Kubernetes' own words (OOMKilled, Error, Completed, ContainerCannotRun):
// kept to what such a word is made of.
const wordOf = (v, max = 60) => {
  const s = String(v ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, max);
  return s || null;
};
const intOf = (v) => (Number.isInteger(v) ? v : null);

/**
 * Pure: what ended the platform container's last run in `pod` (a V1Pod), or
 * null when it has not ended one (a Pod's first container). Kubernetes keeps
 * the previous container's end in `lastState.terminated` once it has started
 * the next, which is the moment a process booting reads it.
 */
function podExitOf(pod, { role = null, name = null } = {}) {
  const statuses = Array.isArray(pod?.status?.containerStatuses) ? pod.status.containerStatuses : [];
  const status = statuses.find((c) => c?.name === CONTAINER) || (statuses.length === 1 ? statuses[0] : null);
  const ended = status?.lastState?.terminated;
  if (!ended) return null;
  const spec = (Array.isArray(pod?.spec?.containers) ? pod.spec.containers : []).find((c) => c?.name === status.name);
  const limit = spec?.resources?.limits?.memory;
  return {
    pod: wordOf(pod?.metadata?.name, 253) || wordOf(name, 253),
    role: wordOf(pod?.metadata?.labels?.[ROLE_LABEL], 20) || role || null,
    container: wordOf(status.name, 63),
    reason: wordOf(ended.reason),
    exitCode: intOf(ended.exitCode),
    signal: intOf(ended.signal),
    startedAt: isoOf(ended.startedAt),
    finishedAt: isoOf(ended.finishedAt),
    restartCount: intOf(status.restartCount),
    memoryLimit: limit == null ? null : wordOf(limit, 20),
  };
}

/**
 * Say what ended this pod's last process (events 'platform_pod_exit'):
 * { pod, role, container, reason, exitCode, signal, startedAt, finishedAt,
 * restartCount, memoryLimit }. A second boot in one pod says only THAT the
 * process died; this says why: the memory limit (OOMKilled, exit code 137)
 * or the process's own exit (Error, its code). Read from this process's own
 * Pod (HOSTNAME in PLATFORM_NAMESPACE), which the chart's Role lets the
 * platform `get`. Skipped where recordBoot is (staging, off Kubernetes), and
 * on a Pod's first container, which ended nothing. Never throws.
 * @returns {Promise<object|null>} what it recorded
 */
async function recordPodExit(pool, {
  env = process.env.USERNODE_ENV, onKubernetes = !!process.env.KUBERNETES_SERVICE_HOST,
  pod = process.env.HOSTNAME || os.hostname(), namespace = process.env.PLATFORM_NAMESPACE,
  role = toldRole(), readPod = (args) => require('./kubernetes').readPlatformPod(args),
} = {}) {
  if (env === 'staging' || !onKubernetes || !pod || !namespace) return null;
  try {
    const read = await readPod({ name: String(pod), namespace: String(namespace) });
    const exit = podExitOf(read, { role, name: pod });
    if (!exit) return null;
    const events = require('./events');
    await events.record(pool, { type: events.EVENT_TYPES.PLATFORM_POD_EXIT, metadata: exit });
    log.warn('platform-release', 'The last process in this pod died', {
      pod: exit.pod, reason: exit.reason, exitCode: exit.exitCode, restartCount: exit.restartCount,
    });
    return exit;
  } catch (err) {
    log.warn('platform-release', 'Could not read this pod for what ended its last process', {
      pod: String(pod), err: err?.message || String(err),
    });
    return null;
  }
}

module.exports = { recordRunning, recordBoot, recordPodExit, podExitOf, STAMP_SQL };
