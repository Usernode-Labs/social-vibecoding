'use strict';

// A deliberately small social feed over authoritative, already-public
// platform activity. There is no write model here: no post table, fan-out,
// ranking, or cache that could outlive a visibility change. Every request
// joins the current app/session/user rows and therefore stops returning an
// item as soon as its app becomes private, its proposal is archived, or an
// actor is deleted.

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const RETENTION_DAYS = 30;

const TYPE_RANK = Object.freeze({
  app_created: 1,
  proposal: 2,
  kudos: 3,
});

function clampLimit(raw) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function iso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({
    v: 1,
    at: iso(row.occurred_at),
    t: Number(row.sort_type),
    id: Number(row.source_id),
  })).toString('base64url');
}

function decodeCursor(raw) {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const time = Date.parse(parsed?.at);
    if (parsed?.v !== 1 || !Number.isFinite(time)
        || !Object.values(TYPE_RANK).includes(parsed.t)
        || !Number.isSafeInteger(parsed.id) || parsed.id < 1) {
      return null;
    }
    return { at: new Date(time).toISOString(), type: parsed.t, id: parsed.id };
  } catch {
    return null;
  }
}

function proposalStatus(status) {
  if (status === 'merged') return 'merged';
  if (status === 'merging') return 'merging';
  return 'proposed';
}

function serialize(row) {
  const item = {
    id: `${row.type}:${row.source_id}`,
    type: row.type,
    occurred_at: iso(row.occurred_at),
    actor: { username: row.actor_username },
    app: {
      id: Number(row.app_id),
      slug: row.app_slug,
      name: row.app_name,
    },
  };
  if (row.type === 'proposal' || row.type === 'kudos') {
    item.proposal = {
      id: Number(row.session_id),
      number: row.pr_number == null ? null : Number(row.pr_number),
      title: row.pr_title || `Proposal #${row.session_id}`,
      status: proposalStatus(row.pr_status),
      author: row.author_username,
    };
  }
  return item;
}

async function listSocialFeed(pool, { limit = DEFAULT_LIMIT, cursor = null } = {}) {
  const pageLimit = clampLimit(limit);
  const cursorAt = cursor?.at || null;
  const cursorType = cursor?.type || null;
  const cursorId = cursor?.id || null;

  // Each arm repeats the privacy/lifecycle predicates intentionally. Moving
  // them outside the UNION makes it too easy for a future arm to project a
  // private name before filtering, and makes route-level review harder.
  const { rows } = await pool.query(
    `WITH social_feed AS (
       SELECT 'app_created'::text AS type, ${TYPE_RANK.app_created}::int AS sort_type,
              a.id::bigint AS source_id, a.created_at AS occurred_at,
              creator.username AS actor_username,
              a.id AS app_id, a.slug AS app_slug, a.name AS app_name,
              NULL::int AS session_id, NULL::int AS pr_number,
              NULL::text AS pr_title, NULL::text AS pr_status,
              NULL::text AS author_username
         FROM apps a
         JOIN users creator ON creator.id = a.created_by
        WHERE a.view_visibility = 'public'
          AND a.status <> 'error'
          AND a.created_at >= NOW() - make_interval(days => ${RETENTION_DAYS})
       UNION ALL
       SELECT 'proposal'::text AS type, ${TYPE_RANK.proposal}::int AS sort_type,
              cs.id::bigint AS source_id,
              COALESCE(cs.merged_at, cs.promoted_at) AS occurred_at,
              author.username AS actor_username,
              a.id AS app_id, a.slug AS app_slug, a.name AS app_name,
              cs.id AS session_id, cs.pr_number, cs.pr_title,
              cs.status AS pr_status, author.username AS author_username
         FROM chat_sessions cs
         JOIN apps a ON a.id = cs.app_id
         JOIN users author ON author.id = cs.user_id
        WHERE a.view_visibility = 'public'
          AND cs.is_headless = FALSE
          AND cs.status IN ('promoted', 'merging', 'merged')
          AND cs.promoted_at IS NOT NULL
          AND COALESCE(cs.merged_at, cs.promoted_at)
                >= NOW() - make_interval(days => ${RETENTION_DAYS})
       UNION ALL
       SELECT 'kudos'::text AS type, ${TYPE_RANK.kudos}::int AS sort_type,
              pk.id::bigint AS source_id, pk.created_at AS occurred_at,
              giver.username AS actor_username,
              a.id AS app_id, a.slug AS app_slug, a.name AS app_name,
              cs.id AS session_id, cs.pr_number, cs.pr_title,
              cs.status AS pr_status, author.username AS author_username
         FROM pr_kudos pk
         JOIN users giver ON giver.id = pk.giver_user_id
         JOIN chat_sessions cs ON cs.id = pk.session_id
         JOIN users author ON author.id = cs.user_id
         JOIN apps a ON a.id = cs.app_id
        WHERE a.view_visibility = 'public'
          AND cs.is_headless = FALSE
          AND cs.status IN ('promoted', 'merging', 'merged')
          AND cs.promoted_at IS NOT NULL
          AND pk.created_at >= NOW() - make_interval(days => ${RETENTION_DAYS})
     )
     SELECT * FROM social_feed
      WHERE ($1::timestamptz IS NULL
             OR (occurred_at, sort_type, source_id) < ($1::timestamptz, $2::int, $3::bigint))
      ORDER BY occurred_at DESC, sort_type DESC, source_id DESC
      LIMIT $4`,
    [cursorAt, cursorType, cursorId, pageLimit + 1]
  );

  const hasMore = rows.length > pageLimit;
  const page = hasMore ? rows.slice(0, pageLimit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(serialize),
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor(last) : null,
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  RETENTION_DAYS,
  TYPE_RANK,
  clampLimit,
  decodeCursor,
  encodeCursor,
  listSocialFeed,
  proposalStatus,
  serialize,
};
