'use strict';

// What the app payloads say about versions (docs/plans/versions.md, "API
// shapes"): on a version, the original it was made from and whether it gets
// its updates; on an original, how many versions it has and how many get
// its updates; and the original's hub, "From its versions".
//
//   GET /api/apps/:slug            upstream_link {slug, name, following, linkable} | null
//                                  versions      {count, following} | null
//   GET /api/apps/:slug/community  made_from     {slug, name, following} | null
//                                  versions      {count, following} | null
//   GET /api/apps/:slug/versions   hub(): suggestions, lately, lastUpdate
//
// The link is `apps.upstream` (services/upstream-lineage.js), read by the
// original's id; the count by the expression index on
// ((upstream->>'appId')::int) (schema.sql, "Versions"). Each read is its own
// static query, beside the payload's own: those are built from column lists
// at run time, and a version's columns are not among them.

const appAccess = require('./app-access');
const lineage = require('./upstream-lineage');
const { changeHref } = require('./change-destination');

// How far back "Lately in its versions" looks, and how many changes it lists.
const LATELY_DAYS = 30;
const LATELY_ROWS = 10;
// How many open suggestions the hub lists.
const MAX_SUGGESTIONS = 20;

/**
 * The link, the original it names (with the columns the view check reads),
 * and the counts of this app's own versions, in one read. `original` is
 * null for a project that is not a version, or whose original is gone.
 */
async function readLinks(pool, appId) {
  const { rows: [row] = [] } = await pool.query(
    `SELECT a.upstream,
            o.id AS original_id, o.slug AS original_slug, o.name AS original_name,
            o.created_by AS original_created_by, o.self_hosted AS original_self_hosted,
            o.collab_visibility AS original_collab_visibility,
            o.view_visibility AS original_view_visibility,
            o.moderation_suspended_at AS original_moderation_suspended_at,
            vc.versions, vc.following
       FROM apps a
       LEFT JOIN apps o ON a.upstream IS NOT NULL AND o.id = (a.upstream->>'appId')::int
       CROSS JOIN LATERAL (
         SELECT COUNT(*)::int AS versions,
                (COUNT(*) FILTER (WHERE v.upstream->>'following' = 'true'))::int AS following
           FROM apps v
          WHERE v.upstream IS NOT NULL AND (v.upstream->>'appId')::int = a.id
       ) vc
      WHERE a.id = $1`,
    [appId]
  );
  if (!row) return { link: null, original: null, versions: null };
  const link = lineage.readUpstream({ upstream: row.upstream });
  const original = link && row.original_id != null ? {
    id: row.original_id,
    slug: row.original_slug,
    name: row.original_name,
    created_by: row.original_created_by,
    self_hosted: !!row.original_self_hosted,
    collab_visibility: row.original_collab_visibility,
    view_visibility: row.original_view_visibility,
    moderation_suspended_at: row.original_moderation_suspended_at,
  } : null;
  const count = Number(row.versions) || 0;
  const versions = count > 0 ? { count, following: Number(row.following) || 0 } : null;
  return { link, original, versions };
}

/**
 * The app payload's two fields. `upstream_link.linkable` is whether this
 * viewer may open the original; its name is shown either way, as
 * `forked_from` shows it, and is null once the original is gone. An app in
 * demo mode keeps its lineage quiet, as attachForkLineage does.
 */
async function appFields(pool, app, user) {
  const { link, original, versions } = await readLinks(pool, app.id);
  let upstreamLink = null;
  if (link && !app.demo_mode) {
    const linkable = !!original && await appAccess.checkAppAccess(pool, original, user, 'view');
    upstreamLink = {
      slug: original ? original.slug : link.slug,
      name: original ? original.name : null,
      following: link.following,
      linkable,
    };
  }
  return { upstream_link: upstreamLink, versions };
}

/** The community payload's two fields: what it was made from (while that exists), and its versions. */
async function communityFields(pool, app) {
  const { link, original, versions } = await readLinks(pool, app.id);
  return {
    made_from: link && original ? { slug: original.slug, name: original.name, following: link.following } : null,
    versions,
  };
}

/**
 * An original's hub, "From its versions" (GET /api/apps/:slug/versions):
 *
 *   count, following  its versions, and how many get its updates;
 *   suggestions       the open proposals its versions suggested here, from
 *                     whom (null for a private version: "a private version");
 *   lately            what its versions merged in the last 30 days, of those
 *                     that are public or share their titles: how many
 *                     versions, how many changes, and the newest ten;
 *   lastUpdate        its latest change offered down: to how many versions,
 *                     how many took it, skipped it, or are deciding; null
 *                     before any was offered.
 */
async function hub(pool, app) {
  const { rows: [counts] = [] } = await pool.query(
    `SELECT COUNT(*)::int AS count,
            (COUNT(*) FILTER (WHERE upstream->>'following' = 'true'))::int AS following
       FROM apps
      WHERE upstream IS NOT NULL AND (upstream->>'appId')::int = $1`,
    [app.id]
  );

  const { rows: suggested } = await pool.query(
    `SELECT cs.id, cs.pr_number, cs.pr_title,
            v.slug AS from_slug, v.name AS from_name, v.view_visibility AS from_view
       FROM chat_sessions cs
       LEFT JOIN apps v ON v.id = cs.suggested_from_app_id
      WHERE cs.app_id = $1 AND cs.suggested_from_app_id IS NOT NULL
        AND cs.status IN ('active', 'promoted', 'merging')
      ORDER BY cs.id DESC
      LIMIT $2`,
    [app.id, MAX_SUGGESTIONS]
  );
  const suggestions = suggested.map((r) => ({
    sessionId: r.id,
    href: changeHref(app.slug, r.id, r.pr_number),
    title: r.pr_title || null,
    from: r.from_slug && r.from_view === 'public' ? { slug: r.from_slug, name: r.from_name || r.from_slug } : null,
  }));

  // A version's own changes: not the updates it took from here, and not its
  // settings (its name, who can see it).
  const { rows: [latelyCounts] = [] } = await pool.query(
    `SELECT COUNT(DISTINCT v.id)::int AS versions, COUNT(cs.id)::int AS changes
       FROM apps v
       JOIN chat_sessions cs ON cs.app_id = v.id
      WHERE v.upstream IS NOT NULL AND (v.upstream->>'appId')::int = $1
        AND (v.view_visibility = 'public' OR v.upstream->>'share' = 'true')
        AND cs.status = 'merged' AND cs.merged_at > NOW() - make_interval(days => $2)
        AND cs.upstream_from_app_id IS NULL
        AND cs.source IS DISTINCT FROM 'settings' AND cs.source IS DISTINCT FROM 'maintenance'`,
    [app.id, LATELY_DAYS]
  );
  const { rows: latelyRows } = await pool.query(
    `SELECT cs.pr_title, cs.merged_at, v.slug, v.name
       FROM apps v
       JOIN chat_sessions cs ON cs.app_id = v.id
      WHERE v.upstream IS NOT NULL AND (v.upstream->>'appId')::int = $1
        AND (v.view_visibility = 'public' OR v.upstream->>'share' = 'true')
        AND cs.status = 'merged' AND cs.merged_at > NOW() - make_interval(days => $2)
        AND cs.upstream_from_app_id IS NULL
        AND cs.source IS DISTINCT FROM 'settings' AND cs.source IS DISTINCT FROM 'maintenance'
      ORDER BY cs.merged_at DESC, cs.id DESC
      LIMIT $3`,
    [app.id, LATELY_DAYS, LATELY_ROWS]
  );
  const lately = {
    versions: Number(latelyCounts?.versions) || 0,
    changes: Number(latelyCounts?.changes) || 0,
    rows: latelyRows.map((r) => ({
      title: r.pr_title || null,
      from: { slug: r.slug, name: r.name || r.slug },
      at: r.merged_at ? new Date(r.merged_at).toISOString() : null,
    })),
  };

  // The latest change offered down: the original's main when versions were
  // offered it, else the one offered most lately.
  const { rows: [offered] = [] } = await pool.query(
    `SELECT from_sha,
            COUNT(*)::int AS offered,
            (COUNT(*) FILTER (WHERE state = 'merged'))::int AS took,
            (COUNT(*) FILTER (WHERE state = 'skipped'))::int AS skipped,
            (COUNT(*) FILTER (WHERE state IN ('open', 'available', 'needs_fit')))::int AS deciding
       FROM upstream_offers
      WHERE from_app_id = $1
      GROUP BY from_sha
      ORDER BY COALESCE(from_sha = $2, FALSE) DESC, MAX(updated_at) DESC
      LIMIT 1`,
    [app.id, app.main_sha || null]
  );
  const lastUpdate = offered ? {
    offered: Number(offered.offered) || 0,
    took: Number(offered.took) || 0,
    skipped: Number(offered.skipped) || 0,
    deciding: Number(offered.deciding) || 0,
  } : null;

  return {
    count: Number(counts?.count) || 0,
    following: Number(counts?.following) || 0,
    suggestions,
    lately,
    lastUpdate,
  };
}

module.exports = { LATELY_DAYS, LATELY_ROWS, readLinks, appFields, communityFields, hub };
