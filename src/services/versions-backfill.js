'use strict';

// Every copy made before versions existed becomes a version of its original
// (docs/plans/versions.md, "Remixes and lineage"). The clock job
// `versions-backfill` runs this every ten minutes, a bounded page at a time
// (src/workflow/clock/services.ts):
//
//   a copy of someone's project  (apps.forked_from set, no link yet) is
//       linked to the project it came from, not getting its updates:
//       { appId, slug, following: false, syncedSha, baseSha, since } from
//       the two commits its forked_from kept, or { ..., legacy: true }
//       when it kept none, so they are looked for when first needed
//       (upstream-lineage.resolveLegacy);
//   a ready-made project        (apps.template a ready-made id, no link, not
//       an original itself) is linked to its starter's original once one
//       exists (apps.original_of = app-templates.dirOf(template)), with
//       { following: false, legacy: true }.
//
// Neither starts getting updates on its own: following is a line of its
// dapp.json, so it is its group's to vote on (POST /api/apps/:slug/follow-pr).
//
// Idempotent: a row is written only while it has no link (`upstream IS
// NULL` in the UPDATE), so a second run, or two at once, change nothing.
// Bounded: at most PAGE rows of each kind a run, walked by id from where the
// last run stopped (the clock keeps its result), so a row that cannot be
// linked yet (its original deleted, or no original for its starter yet) is
// passed over rather than read first every time.

const log = require('./logger');
const appTemplates = require('./app-templates');

const PAGE = 100;

const SHA_RE = /^[0-9a-f]{40}$/i;
const sha = (v) => (typeof v === 'string' && SHA_RE.test(v) ? v.toLowerCase() : null);

function objectOf(value) {
  let v = value;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { v = null; }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function isoOf(value) {
  const d = value instanceof Date ? value : new Date(value || NaN);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The link a copy of someone's project gets, from its `forked_from` and the
 * original it names (`{ id, slug }`). Pure.
 */
function remixLink(forkedFrom, original, createdAt = null) {
  const ref = objectOf(forkedFrom) || {};
  const syncedSha = sha(ref.sourceSha);
  const baseSha = sha(ref.forkBaseSha);
  const since = isoOf(ref.forkedAt) || isoOf(createdAt);
  return {
    appId: original.id,
    slug: original.slug,
    following: false,
    ...(syncedSha && baseSha ? { syncedSha, baseSha, legacy: false } : { legacy: true }),
    ...(since ? { since } : {}),
  };
}

/** The link a ready-made project from before versions gets. Pure. */
function readyMadeLink(original, createdAt = null) {
  const since = isoOf(createdAt);
  return { appId: original.id, slug: original.slug, following: false, legacy: true, ...(since ? { since } : {}) };
}

async function link(pool, appId, value) {
  const { rowCount } = await pool.query(
    'UPDATE apps SET upstream = $2::jsonb WHERE id = $1 AND upstream IS NULL',
    [appId, JSON.stringify(value)]
  );
  return rowCount > 0;
}

// The copies of someone's project with no link yet, from `after` on.
async function remixes(pool, after, limit) {
  const { rows } = await pool.query(
    `SELECT id, forked_from, created_at
       FROM apps
      WHERE id > $1 AND upstream IS NULL AND forked_from IS NOT NULL
        AND status <> 'creating' AND NOT self_hosted
      ORDER BY id
      LIMIT $2`,
    [after, limit]
  );
  if (!rows.length) return { rows, linked: 0, last: null };
  // The original each names: by its id (authoritative), else by its slug,
  // as app-forker.findForkSource finds it. A deleted original is no link.
  const ids = [];
  const slugs = [];
  for (const r of rows) {
    const ref = objectOf(r.forked_from) || {};
    if (Number.isInteger(ref.appId) && ref.appId > 0) ids.push(ref.appId);
    else if (typeof ref.slug === 'string' && ref.slug.trim()) slugs.push(ref.slug.trim());
  }
  const { rows: found } = await pool.query(
    'SELECT id, slug FROM apps WHERE id = ANY($1::int[]) OR slug = ANY($2::text[])',
    [ids, slugs]
  );
  const byId = new Map(found.map((o) => [o.id, o]));
  const bySlug = new Map(found.map((o) => [o.slug, o]));
  let linked = 0;
  for (const r of rows) {
    const ref = objectOf(r.forked_from) || {};
    const original = Number.isInteger(ref.appId) && ref.appId > 0
      ? byId.get(ref.appId)
      : bySlug.get(typeof ref.slug === 'string' ? ref.slug.trim() : '');
    if (!original || original.id === r.id) continue;
    if (await link(pool, r.id, remixLink(r.forked_from, original, r.created_at))) linked += 1;
  }
  return { rows, linked, last: rows[rows.length - 1].id };
}

// The ready-made projects with no link yet, from `after` on, each linked to
// its starter's original when there is one.
async function readyMades(pool, after, limit) {
  const { rows } = await pool.query(
    `SELECT id, template, created_at
       FROM apps
      WHERE id > $1 AND upstream IS NULL AND original_of IS NULL AND forked_from IS NULL
        AND template = ANY($2::text[])
        AND status <> 'creating' AND NOT self_hosted
      ORDER BY id
      LIMIT $3`,
    [after, [...appTemplates.READY_IDS], limit]
  );
  if (!rows.length) return { rows, linked: 0, last: null };
  const dirs = [...new Set(rows.map((r) => appTemplates.dirOf(r.template)).filter(Boolean))];
  const { rows: originals } = await pool.query(
    'SELECT id, slug, original_of FROM apps WHERE original_of = ANY($1::text[])',
    [dirs]
  );
  const byDir = new Map(originals.map((o) => [o.original_of, o]));
  let linked = 0;
  for (const r of rows) {
    const original = byDir.get(appTemplates.dirOf(r.template));
    if (!original || original.id === r.id) continue;
    if (await link(pool, r.id, readyMadeLink(original, r.created_at))) linked += 1;
  }
  return { rows, linked, last: rows[rows.length - 1].id };
}

// Where a kind's walk carries on from: after the last row this run read, or
// from the start once a page came back short (the walk got to the end).
function nextAfter(page, limit) {
  return page.rows.length < limit || page.last == null ? 0 : page.last;
}

/**
 * One run. `previous` is the last run's result ({ remixesAfter,
 * readyMadesAfter }), where each walk carries on from. Resolves what it did
 * and where the next run starts.
 */
async function run(_config, pool, { previous = null, limit = PAGE } = {}) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const fromRemixes = Number.isInteger(prev.remixesAfter) ? prev.remixesAfter : 0;
  const fromReadyMades = Number.isInteger(prev.readyMadesAfter) ? prev.readyMadesAfter : 0;
  const r = await remixes(pool, fromRemixes, limit);
  const m = await readyMades(pool, fromReadyMades, limit);
  if (r.linked || m.linked) {
    log.info('versions-backfill', 'Linked copies to their originals', { remixes: r.linked, readyMades: m.linked });
  }
  return {
    remixes: r.linked,
    readyMades: m.linked,
    remixesAfter: nextAfter(r, limit),
    readyMadesAfter: nextAfter(m, limit),
  };
}

module.exports = { PAGE, run, remixLink, readyMadeLink };
