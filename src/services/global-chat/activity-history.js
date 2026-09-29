'use strict';

// Small semantic reads used by Global Chat for questions that span apps.
// The Classic interface builds these views from several app-scoped routes;
// exposing the same intent as one authorized query keeps the cheap chat model
// from having to discover an app first or manufacture route parameters.

const MAX_HISTORY_LIMIT = 50;

function historyLimit(value) {
  const numeric = Number(value == null ? 10 : value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_HISTORY_LIMIT) {
    const error = new Error(`limit must be an integer from 1 to ${MAX_HISTORY_LIMIT}.`);
    error.code = 'invalid_capability_input';
    throw error;
  }
  return numeric;
}

async function recentClosedIssues(pool, userId, {
  limit = 10,
  isAdmin = false,
  showSelfHosted = false,
} = {}) {
  const bounded = historyLimit(limit);
  const { rows } = await pool.query(
    `WITH linked AS (
       SELECT cs.id AS session_id,
              cs.app_id,
              cs.pr_number,
              cs.pr_title,
              COALESCE(cs.merged_at, cs.created_at) AS closed_at,
              issue_number,
              ROW_NUMBER() OVER (
                PARTITION BY cs.app_id, issue_number
                ORDER BY COALESCE(cs.merged_at, cs.created_at) DESC, cs.id DESC
              ) AS occurrence
         FROM chat_sessions cs
         CROSS JOIN LATERAL UNNEST(COALESCE(cs.linked_issues, '{}'::INTEGER[]))
           AS linked_issue(issue_number)
        WHERE cs.user_id = $1
          AND cs.status = 'merged'
     )
     SELECT linked.session_id,
            linked.issue_number,
            linked.pr_number,
            linked.pr_title,
            linked.closed_at,
            apps.slug AS app_slug,
            apps.name AS app_name,
            issues.id AS issue_id,
            issues.title AS issue_title,
            issues.description,
            issues.status
       FROM linked
       JOIN apps ON apps.id = linked.app_id
       LEFT JOIN app_collaborators membership
         ON membership.app_id = apps.id
        AND membership.user_id = $1
        AND membership.status = 'member'
       LEFT JOIN issues
         ON issues.app_id = linked.app_id
        AND issues.github_issue_number = linked.issue_number
      WHERE linked.occurrence = 1
        AND ($3::boolean OR apps.view_visibility = 'public' OR membership.user_id IS NOT NULL)
        AND (NOT apps.self_hosted OR $4::boolean)
      ORDER BY linked.closed_at DESC, linked.session_id DESC, linked.issue_number DESC
      LIMIT $2`,
    [userId, bounded, !!isAdmin, !!showSelfHosted],
  );
  return {
    items: rows.map((row) => ({
      id: row.issue_id || `${row.app_slug}#${row.issue_number}`,
      number: Number(row.issue_number),
      title: row.issue_title || `Issue #${row.issue_number}`,
      description: row.description || null,
      status: row.status || 'closed',
      appSlug: row.app_slug,
      appName: row.app_name,
      closedAt: row.closed_at,
      closedBySessionId: row.session_id,
      mergedPrNumber: row.pr_number == null ? null : Number(row.pr_number),
      mergedPrTitle: row.pr_title || null,
    })),
  };
}

async function recentMergedWork(pool, userId, {
  limit = 10,
  isAdmin = false,
  showSelfHosted = false,
} = {}) {
  const bounded = historyLimit(limit);
  const { rows } = await pool.query(
    `SELECT cs.id,
            cs.pr_number,
            cs.pr_title,
            cs.session_title,
            cs.status,
            cs.merged_at,
            cs.created_at,
            cs.linked_issues,
            apps.slug AS app_slug,
            apps.name AS app_name
       FROM chat_sessions cs
       JOIN apps ON apps.id = cs.app_id
       LEFT JOIN app_collaborators membership
         ON membership.app_id = apps.id
        AND membership.user_id = $1
        AND membership.status = 'member'
      WHERE cs.user_id = $1
        AND cs.status = 'merged'
        AND ($3::boolean OR apps.view_visibility = 'public' OR membership.user_id IS NOT NULL)
        AND (NOT apps.self_hosted OR $4::boolean)
      ORDER BY COALESCE(cs.merged_at, cs.created_at) DESC, cs.id DESC
      LIMIT $2`,
    [userId, bounded, !!isAdmin, !!showSelfHosted],
  );
  return {
    items: rows.map((row) => ({
      id: row.id,
      sessionId: row.id,
      title: row.pr_title || row.session_title || `Merged work #${row.id}`,
      status: 'merged',
      prNumber: row.pr_number == null ? null : Number(row.pr_number),
      appSlug: row.app_slug,
      appName: row.app_name,
      mergedAt: row.merged_at || row.created_at,
      linkedIssues: Array.isArray(row.linked_issues)
        ? row.linked_issues.map(Number).filter(Number.isInteger)
        : [],
    })),
  };
}

async function queryUserHistory(pool, userId, kind, options = {}) {
  if (kind === 'closed_issues') return recentClosedIssues(pool, userId, options);
  if (kind === 'merged_work') return recentMergedWork(pool, userId, options);
  const error = new Error('That history view is unavailable.');
  error.code = 'capability_not_found';
  throw error;
}

module.exports = {
  MAX_HISTORY_LIMIT,
  historyLimit,
  queryUserHistory,
  recentClosedIssues,
  recentMergedWork,
};
