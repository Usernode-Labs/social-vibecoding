'use strict';

const { checkAppAccess } = require('../app-access');
const PAGE_SIZE = 25;
const DATE_MEASURES = new Set(['TRY_APPS', 'USE_APPS_MINUTES']);

function sourceRef(metadata) {
  const match = /^(session|merged):([1-9][0-9]{0,9})$/.exec(metadata?.source_key || '');
  if (!match || Number(match[2]) > 2147483647) return null;
  return { kind: match[1], id: Number(match[2]), key: match[0] };
}

function activityView(row, proposal = null) {
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const dateOnly = DATE_MEASURES.has(metadata.measure);
  const time = row.activity_at == null ? null : new Date(row.activity_at);
  const iso = time && Number.isFinite(time.getTime()) ? time.toISOString() : null;
  const reason = typeof metadata.grade?.reason === 'string' ? metadata.grade.reason.trim().slice(0, 200) : null;
  return {
    id: Number(row.id), points: Number(row.points) || 0,
    description: String(row.description || row.activity_type || 'Challenge credit').slice(0, 500),
    activityAt: iso, date: dateOnly && iso ? iso.slice(0, 10) : null,
    precision: dateOnly ? 'date' : 'timestamp',
    explanation: reason || null,
    proposal,
  };
}

async function personalChallengeActivities(pool, user, challengeId, before = null) {
  // Stable id keyset includes backdated imports without timestamp ties dropping rows.
  const { rows } = await pool.query(
    `SELECT ua.id, ua.activity_type, ua.points, ua.description, ua.activity_at, ua.metadata
       FROM user_activities ua
       JOIN challenges c ON c.id = ua.challenge_id
       JOIN season_events se ON se.id = c.season_event_id
      WHERE ua.user_id = $1 AND ua.challenge_id = $2 AND se.internal = FALSE
        AND ($3::bigint IS NULL OR ua.id < $3)
      ORDER BY ua.id DESC LIMIT $4`,
    [user.id, challengeId, before, PAGE_SIZE + 1],
  );
  const page = rows.slice(0, PAGE_SIZE);
  const refs = page.map(row => sourceRef(row.metadata)).filter(Boolean);
  const mergedIds = [...new Set(refs.filter(ref => ref.kind === 'merged').map(ref => ref.id))];
  const eventSessions = new Map();
  if (mergedIds.length) {
    const events = await pool.query(
      `SELECT id, session_id FROM events
        WHERE id = ANY($1::int[]) AND user_id = $2 AND event_type = 'pr_merged'`,
      [mergedIds, user.id],
    );
    for (const event of events.rows) eventSessions.set(Number(event.id), Number(event.session_id));
  }
  const sessionId = ref => ref.kind === 'session' ? ref.id : eventSessions.get(ref.id);
  const ids = [...new Set(refs.map(sessionId).filter(Number.isSafeInteger))];
  const proposals = new Map();
  if (ids.length) {
    const sessions = await pool.query(
      `SELECT cs.id, cs.pr_title, cs.session_title, a.id AS app_id, a.slug, a.view_visibility
         FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
        WHERE cs.id = ANY($1::int[]) AND cs.user_id = $2`,
      [ids, user.id],
    );
    const access = new Map();
    for (const row of sessions.rows) {
      if (!access.has(row.app_id)) access.set(row.app_id, await checkAppAccess(pool,
        { id: row.app_id, view_visibility: row.view_visibility }, user, 'view'));
      if (!access.get(row.app_id)) continue;
      proposals.set(Number(row.id), {
        title: String(row.pr_title || row.session_title || 'View proposal').slice(0, 256),
        href: `#app/${encodeURIComponent(row.slug)}/dev/proposals/${Number(row.id)}`,
      });
    }
  }
  return {
    items: page.map(row => {
      const ref = sourceRef(row.metadata);
      return activityView(row, ref ? proposals.get(sessionId(ref)) || null : null);
    }),
    nextBefore: rows.length > PAGE_SIZE ? String(page[page.length - 1].id) : null,
  };
}

module.exports = { personalChallengeActivities, activityView, sourceRef, PAGE_SIZE };
