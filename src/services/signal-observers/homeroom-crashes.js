'use strict';

// homeroom_crash: a Homeroom process died in the last 24 hours, one item per
// role (web, conductor; 'platform' for a process that runs everything, or
// whose role was not recorded).
//
// Read from two records the boot leaves (services/platform-release.js):
//
//   platform_booted    every process that came up, by pod. A second boot in
//                      one pod within 7 days is its container started again
//                      after the process died: the rule the infra topic's
//                      "Homeroom crashes" counts by (topic-figures.js
//                      HOMEROOM_CRASHES_SQL).
//   platform_pod_exit  what ended the process before it in that pod, read
//                      off the Pod: the reason (OOMKilled, Error), exit
//                      code, memory limit.
//
// Each crash leaves one of each, so a pod's crashes are the larger of the
// two counts: a pod whose exit could not be read still counts by its boots,
// and one older than the figure's 7 days still counts by its exits.
//
// Everything said is typed: counts, Kubernetes' reasons and exit codes, the
// memory limit, pod names and commit SHAs.

const CRASH_BOOTS_SQL = `
  SELECT b.created_at, b.metadata->>'pod' AS pod, b.metadata->>'sha' AS sha, b.metadata->>'role' AS role
    FROM events b
   WHERE b.event_type = 'platform_booted'
     AND b.created_at > NOW() - interval '24 hours'
     AND EXISTS (
       SELECT 1 FROM events p
        WHERE p.event_type = 'platform_booted'
          AND p.metadata->>'pod' = b.metadata->>'pod'
          AND p.created_at < b.created_at
          AND p.created_at >= b.created_at - interval '7 days')
   ORDER BY b.created_at DESC
   LIMIT 500`;

const POD_EXITS_SQL = `
  SELECT e.created_at, e.metadata
    FROM events e
   WHERE e.event_type = 'platform_pod_exit'
     AND e.created_at > NOW() - interval '24 hours'
   ORDER BY e.created_at DESC
   LIMIT 500`;

// Where each role's process is named: the chart's `processRole`
// (src/services/process-role.js). 'all' runs everything, as every process
// did before the split.
function roleOf(value) {
  const r = String(value || '').trim().toLowerCase();
  return r === 'web' || r === 'conductor' ? r : 'platform';
}

const ROLE_WORDS = Object.freeze({
  web: 'web process',
  conductor: 'conductor',
  platform: 'server process',
});

const sha7 = (s) => (/^[0-9a-f]{7,40}$/i.test(String(s || '')) ? String(s).slice(0, 7).toLowerCase() : null);
const iso = (v) => (v ? new Date(v).toISOString().replace(/\.\d+Z$/, 'Z') : 'unknown');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const word = (v, max = 60) => String(v ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, max);
const list = (xs, max = 8) => {
  const shown = xs.slice(0, max);
  return xs.length > max ? `${shown.join(', ')} and ${xs.length - max} more` : shown.join(', ');
};
// A count per thing, most first.
const ranked = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

/** The roles that crashed, from the rows of the two queries. Pure. */
function crashesByRole(boots, exits) {
  const podKey = (name) => word(name, 253) || 'unknown';
  // A pod is one role for its life: the role its pod label gave an exit
  // (Kubernetes' own), else the one a boot was told.
  const podRole = new Map();
  for (const e of exits) {
    const m = e.metadata || {};
    if (m.role && !podRole.has(podKey(m.pod))) podRole.set(podKey(m.pod), m.role);
  }
  for (const b of boots) if (b.role && !podRole.has(podKey(b.pod))) podRole.set(podKey(b.pod), b.role);

  const pods = new Map();
  const podOf = (name) => {
    const key = podKey(name);
    if (!pods.has(key)) pods.set(key, { name: key, boots: [], exits: [] });
    return pods.get(key);
  };
  for (const b of boots) podOf(b.pod).boots.push(b);
  for (const e of exits) podOf(e.metadata?.pod).exits.push(e);

  const roles = new Map();
  for (const p of pods.values()) {
    const role = roleOf(podRole.get(p.name));
    if (!roles.has(role)) roles.set(role, { role, crashes: 0, pods: [], boots: [], exits: [], times: [] });
    const r = roles.get(role);
    r.crashes += Math.max(p.boots.length, p.exits.length);
    r.pods.push(p.name);
    r.boots.push(...p.boots);
    r.exits.push(...p.exits);
    // When each came back up: a boot's row, and its exit's, are written then.
    for (const x of [...p.boots, ...p.exits]) {
      const t = new Date(x.created_at).getTime();
      if (Number.isFinite(t)) r.times.push(t);
    }
  }
  return [...roles.values()].filter((r) => r.crashes > 0);
}

function itemFor(r) {
  const reasons = new Map();
  const limits = new Set();
  let oom = false;
  for (const e of r.exits) {
    const m = e.metadata || {};
    const reason = word(m.reason) || 'unknown reason';
    if (reason === 'OOMKilled') oom = true;
    const what = Number.isInteger(m.exitCode) ? `${reason} (exit code ${m.exitCode})` : reason;
    reasons.set(what, (reasons.get(what) || 0) + 1);
    if (m.memoryLimit) limits.add(word(m.memoryLimit, 20));
  }
  const shas = new Map();
  for (const b of r.boots) {
    const s = sha7(b.sha);
    if (s) shas.set(s, (shas.get(s) || 0) + 1);
  }
  const unread = Math.max(0, r.crashes - r.exits.length);
  const first = r.times.length ? Math.min(...r.times) : null;
  const last = r.times.length ? Math.max(...r.times) : null;
  const words = ROLE_WORDS[r.role];
  const where = [];
  if (oom) where.push('deploy/helm/social-vibecoding-platform/values.yaml');
  if (!oom || r.exits.some((e) => word(e.metadata?.reason) !== 'OOMKilled')) where.push('server.js');
  return {
    kind: 'homeroom_crash',
    key: r.role,
    subject: { role: r.role },
    title: `Homeroom's ${words} crashed`,
    summary: `A Homeroom ${words} died and Kubernetes started it again in the same pod. `
      + 'Whatever it was doing stopped with it: turns, builds and requests in flight.',
    occurrences: r.crashes,
    evidence: {
      lines: [
        `${plural(r.crashes, 'crash', 'crashes')} in the last 24 hours`
          + (first != null ? `, the first at ${iso(first)}${last !== first ? `, the last at ${iso(last)}` : ''}.` : '.'),
        reasons.size
          ? `How it ended: ${ranked(reasons).map(([what, n]) => `${what} ${plural(n, 'time', 'times')}`).join(', ')}.`
          : null,
        unread ? `No reason recorded for ${plural(unread, 'crash', 'crashes')}: the process that came back up could not read its pod.` : null,
        limits.size ? `Memory limit: ${[...limits].join(', ')}.` : null,
        shas.size ? `Running: ${ranked(shas).map(([sha, n]) => `${sha} (${plural(n, 'crash', 'crashes')})`).join(', ')}.` : null,
        `Pods: ${list(r.pods)}.`,
      ].filter(Boolean),
      where,
    },
  };
}

// The window is the database's own (NOW() in the queries), not this
// process's clock.
async function run(pool) {
  const [boots, exits] = await Promise.all([pool.query(CRASH_BOOTS_SQL), pool.query(POD_EXITS_SQL)]);
  return crashesByRole(boots.rows, exits.rows).map(itemFor);
}

module.exports = { run, crashesByRole, roleOf, CRASH_BOOTS_SQL, POD_EXITS_SQL };
