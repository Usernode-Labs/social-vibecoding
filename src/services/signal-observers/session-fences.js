'use strict';

// Session guard fences and invite landings: what the browser's session guard
// cut off (services/ui-telemetry.js `session_fence`, reported by
// frontend/src/lib/api-cache-identity.ts), and where an invite link's page
// settled (`invite_settlement`, frontend/src/features/auth/invite-card.tsx).
//
// Three problems are read from those rows:
//
//   session_fence_public  a signed-out page, or a read under /api/public/,
//                         was fenced on more than one visit in an hour.
//                         Nothing private can be in flight there, so a fence
//                         is never needed.
//   session_fence_jump    a new build fences signed-in reads at least twice
//                         as often per 1,000 page loads as the build before
//                         it, with a small minimum so one fence is nothing.
//   invite_pitch_failed   signed-out invite pages fell back to the pitch
//                         because the invite could not be read: 3 or more,
//                         and at least 2% of landings, in a day.
//
// Everything said publicly is route templates, reasons, counts and build
// SHAs. A stored path is already the route's own pattern, never an address.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FENCE_MIN_VISITS = 2;
const JUMP_MIN_LOADS = 200;
const JUMP_MIN_READS = 10;
const INVITE_MIN_FAILED = 3;

const iso = (v) => (v ? new Date(v).toISOString().replace(/\.\d+Z$/, 'Z') : 'unknown');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const list = (xs, max = 8) => {
  const shown = xs.slice(0, max);
  return xs.length > max ? `${shown.join(', ')} and ${xs.length - max} more` : shown.join(', ');
};
const time = (v) => (v ? new Date(v).getTime() : 0);
const sha7 = (s) => String(s || '').slice(0, 7);

const ROWS_SQL = `
  SELECT e.id, e.user_id, e.metadata, e.created_at
    FROM events e
   WHERE e.event_type = 'ui_experience'
     AND e.metadata->>'kind' IN ('session_fence', 'invite_settlement', 'page_load')
     AND e.created_at > NOW() - interval '7 days'
   ORDER BY e.created_at DESC
   LIMIT 50000`;

function fencesOf(row) {
  return Array.isArray(row?.metadata?.fences) ? row.metadata.fences : [];
}

/** Pure: the three problems in rows of ROWS_SQL. */
function itemsFrom(rows, { now = Date.now() } = {}) {
  const all = (rows || []).filter((r) => r && r.metadata);
  const fenceRows = all.filter((r) => r.metadata.kind === 'session_fence');
  const settlementRows = all.filter((r) => r.metadata.kind === 'invite_settlement');
  const loadRows = all.filter((r) => r.metadata.kind === 'page_load');
  const items = [];

  // ── session_fence_public ──────────────────────────────────────────────
  const byTemplate = new Map();
  const visitTemplates = new Map();
  for (const row of fenceRows) {
    const visit = String(row.metadata.visitId || row.id);
    if (!visitTemplates.has(visit)) visitTemplates.set(visit, new Set());
    for (const fence of fencesOf(row)) {
      const path = String(fence?.path || '');
      if (!path.startsWith('/api/')) continue;
      visitTemplates.get(visit).add(path);
      const needs = row.metadata.signedIn === false || fence.public === true || path.startsWith('/api/public/');
      if (!needs) continue;
      if (!byTemplate.has(path)) byTemplate.set(path, []);
      byTemplate.get(path).push(row);
    }
  }
  for (const [path, hits] of byTemplate) {
    const hour = hits.filter((r) => now - time(r.created_at) < HOUR_MS);
    const hourVisits = new Set(hour.map((r) => String(r.metadata.visitId || r.id)));
    if (hourVisits.size < FENCE_MIN_VISITS) continue;
    const day = hits.filter((r) => now - time(r.created_at) < DAY_MS);
    const reasons = [...new Set(hits.flatMap((r) => fencesOf(r).filter((f) => f.path === path).map((f) => f.reason)).filter(Boolean))].sort();
    const signed = [...new Set(hits.map((r) => (r.metadata.signedIn === true ? 'signed in' : 'signed out')))].sort();
    const firstBuild = hits
      .filter((r) => r.metadata.build)
      .sort((a, b) => time(a.created_at) - time(b.created_at))[0]?.metadata.build || null;
    const others = [...new Set(hourVisits)].flatMap((v) => [...(visitTemplates.get(v) || [])])
      .filter((p) => p !== path).sort();
    const reads = hits.reduce((sum, r) => sum + fencesOf(r).filter((f) => f.path === path)
      .reduce((n, f) => n + (Number(f.count) || 0), 0), 0);
    items.push({
      kind: 'session_fence_public',
      key: path,
      topic: 'onboarding',
      fixer: 'bot',
      subject: { path },
      title: `Session guard fenced public reads: ${path}`,
      summary: 'The browser cut off reads while the session seemed to change, on a signed-out page or a '
        + 'public read. Nothing private can be in flight there, so those reads never needed to be fenced, '
        + 'and a screen that was waiting for one showed its fallback instead.',
      occurrences: hourVisits.size,
      evidence: {
        lines: [
          `${plural(hourVisits.size, 'visit', 'visits')} in the last hour, ${plural(day.length, 'visit', 'visits')} in the last day.`,
          `${plural(reads, 'read', 'reads')} in the last 7 days.`,
          `Path: ${path}.`,
          reasons.length ? `Reasons: ${list(reasons)}.` : null,
          `Pages: ${signed.join(', ')}.`,
          others.length ? `Other paths fenced on those visits: ${list(others)}.` : null,
          firstBuild ? `First reported by build ${sha7(firstBuild)}.` : 'Build: not reported.',
          'Where: frontend/src/lib/api-cache-identity.ts',
        ].filter(Boolean),
      },
    });
  }

  // ── session_fence_jump ────────────────────────────────────────────────
  const byBuild = new Map();
  const buildOf = (row) => {
    const build = row.metadata.build;
    if (typeof build !== 'string' || !/^(?:[0-9a-f]{7,40}|dev)$/.test(build)) return null;
    if (!byBuild.has(build)) byBuild.set(build, { build, loads: 0, reads: 0, latest: 0, paths: new Map(), reasons: new Set() });
    return byBuild.get(build);
  };
  for (const row of loadRows) {
    const b = buildOf(row);
    if (!b) continue;
    b.loads += 1;
    b.latest = Math.max(b.latest, time(row.created_at));
  }
  for (const row of fenceRows) {
    if (row.user_id == null) continue; // signed-in reads only
    const b = buildOf(row);
    if (!b) continue;
    for (const fence of fencesOf(row)) {
      b.reads += Number(fence.count) || 0;
      if (fence.path) b.paths.set(fence.path, (b.paths.get(fence.path) || 0) + (Number(fence.count) || 0));
      if (fence.reason) b.reasons.add(fence.reason);
    }
    b.latest = Math.max(b.latest, time(row.created_at));
  }
  const builds = [...byBuild.values()].sort((a, b) => b.latest - a.latest);
  const current = builds.find((b) => b.loads >= JUMP_MIN_LOADS);
  const previous = current ? builds.filter((b) => b !== current && b.latest < current.latest)
    .find((b) => b.loads >= JUMP_MIN_LOADS) : null;
  if (current && previous) {
    const rate = (b) => (b.reads / b.loads) * 1000;
    const currentRate = rate(current);
    const previousRate = rate(previous);
    if (current.reads >= JUMP_MIN_READS && currentRate >= 2 * Math.max(previousRate, 1)) {
      const topPaths = [...current.paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([path, n]) => `${path} (${n})`);
      items.push({
        kind: 'session_fence_jump',
        key: sha7(current.build),
        topic: 'infra',
        fixer: 'bot',
        subject: { build: current.build },
        title: `Session guard fences reads far more after build ${sha7(current.build)}`,
        summary: 'A new build cuts off many more reads than the build before it, so something on it is '
          + 'changing the session, or racing it, more often. Every cut-off read is a screen showing a fallback.',
        occurrences: current.reads,
        evidence: {
          lines: [
            `Build ${sha7(current.build)}: ${current.reads} fenced reads in ${current.loads} page loads `
              + `(${currentRate.toFixed(1)} per 1,000).`,
            `Build ${sha7(previous.build)}: ${previous.reads} fenced reads in ${previous.loads} page loads `
              + `(${previousRate.toFixed(1)} per 1,000).`,
            topPaths.length ? `Paths: ${list(topPaths)}.` : null,
            current.reasons.size ? `Reasons: ${list([...current.reasons].sort())}.` : null,
            `Release it started with: ${current.build}.`,
            'Where: frontend/src/lib/api-cache-identity.ts',
          ].filter(Boolean),
        },
      });
    }
  }

  // ── invite_pitch_failed ───────────────────────────────────────────────
  const recent = settlementRows.filter((r) => now - time(r.created_at) < DAY_MS);
  const counts = { card: 0, dead: 0, failed: 0, timeout: 0 };
  for (const row of recent) {
    const settled = row.metadata.settled;
    if (Object.prototype.hasOwnProperty.call(counts, settled)) counts[settled] += 1;
  }
  const total = counts.card + counts.dead + counts.failed + counts.timeout;
  if (counts.failed >= INVITE_MIN_FAILED && counts.failed * 100 >= total * 2) {
    const visits = new Set(recent.filter((r) => r.metadata.settled === 'failed')
      .map((r) => String(r.metadata.visitId || r.id)));
    const sameVisit = fenceRows.filter((r) => visits.has(String(r.metadata.visitId || r.id)));
    const inviteFences = [...new Set(sameVisit.flatMap((r) => fencesOf(r))
      .map((f) => f.path).filter((p) => typeof p === 'string' && p.startsWith('/api/public/invites/')))].sort();
    const builds = [...new Set(recent.map((r) => r.metadata.build).filter(Boolean))].sort();
    items.push({
      kind: 'invite_pitch_failed',
      key: 'invite',
      topic: 'onboarding',
      fixer: 'bot',
      subject: { settled: 'failed' },
      title: 'Invite pages fall back to the pitch: the invite could not be read',
      summary: 'Signed-out people opening an invite link saw the waitlist pitch because the invite could '
        + 'not be read, rather than the invite card. That should stay near zero: an invite link that does '
        + 'not show its invite loses the person it was sent to.',
      occurrences: counts.failed,
      evidence: {
        lines: [
          `In the last day: ${counts.failed} failed of ${plural(total, 'landing', 'landings')} `
            + `(${total ? Math.round((counts.failed / total) * 100) : 0}%).`,
          `The invite card: ${counts.card}, the dead-link page: ${counts.dead}, too long: ${counts.timeout}.`,
          inviteFences.length ? `Fenced invite reads on those visits: ${list(inviteFences)}.` : null,
          builds.length ? `Builds: ${list(builds, 6)}.` : 'Builds: not reported.',
          'Where: frontend/src/features/auth/invite-card.tsx',
        ].filter(Boolean),
      },
    });
  }

  return items;
}

async function run(pool, { now = Date.now() } = {}) {
  const { rows } = await pool.query(ROWS_SQL);
  return itemsFrom(rows, { now });
}

module.exports = {
  run,
  itemsFrom,
  ROWS_SQL,
  FENCE_MIN_VISITS,
  JUMP_MIN_LOADS,
  JUMP_MIN_READS,
  INVITE_MIN_FAILED,
};
