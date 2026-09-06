// Workshop themes. The Workshop view (the Dev screen's lander) groups
// everything on an app's board — open issues, proposals under vote, shared
// sessions, recently landed changes — into a handful of THEMES: what the
// work is about, rather than which lifecycle column it sits in.
//
// The pattern is report-ai.js's, and deliberately so: the same
// SHARED-VISIBILITY-ONLY input, the same content fingerprint, one cached
// row per app (app_workshop_themes) that every viewer reads. Two things
// differ, and both come from this being a lander rather than a report:
//
//   * Nobody clicks "generate". A GET that finds the cache stale kicks a
//     regeneration off IN THE BACKGROUND and answers at once with what it
//     has, so the lander never waits on a model. The call is debited to
//     the platform's own account (fleet-maintenance's usernode-platform
//     user), never to whoever happened to open the page.
//   * Themes have STABLE IDS. The previous themes are fed back into every
//     generation with the instruction to keep an id where the theme is the
//     same, so a link, a filter or a "since you were here" delta survives
//     a regeneration. The previous themes are NOT part of the fingerprint —
//     if they were, every generation would change the hash it is compared
//     against and the cache could never read as fresh.
//
// When there is no model (staging, self-hosted without a key) the view is
// not empty: `fallbackThemes` groups by the community-voted category, which
// is the one grouping the board already has. It is computed per request and
// never cached, so a key arriving later takes over without a stale
// category grouping reading as current forever.
const crypto = require('crypto');
const github = require('./github');
const topicAttrs = require('./topic-attributes');
const { currentVotePredicateSql } = require('./pr-vote-revision');
const limits = require('./limits');
const llm = require('./llm');
const log = require('./logger');

// Caps keep the prompt bounded on a huge app. Every list overflow is
// disclosed to the model via `truncated`.
const MAX_ISSUES = 200;
const MAX_REVIEW = 50;
const MAX_GOV = 20;
const MAX_SESSIONS = 30;
const MAX_MERGED = 60;
const MERGED_WINDOW_DAYS = 30;
const TITLE_MAX = 140;
const EXCERPT_MAX = 240;

// A regeneration is at most this frequent per app. The grouping of a NEW
// item lags by at most this long; the counts and rows on the view are live
// from the board's own caches regardless. Floored so a mis-set value
// cannot spin the model.
const MIN_INTERVAL_MS = Math.max(
  parseInt(process.env.WORKSHOP_THEMES_MIN_INTERVAL_MS || String(10 * 60 * 1000), 10)
    || (10 * 60 * 1000),
  60 * 1000
);

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const day = (v) => {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

// The first sentences of a body, flattened: enough for the model to tell a
// "dark mode resets" issue from a "dark mode toggle placement" one, not the
// whole markdown.
function excerpt(text) {
  const flat = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_>`\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat ? flat.slice(0, EXCERPT_MAX) : null;
}

function parseOwnerRepo(repoUrl) {
  const m = String(repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// One item per board card, keyed the way the client's card models are:
// `issue:<number>` for a GitHub issue, `session:<id>` for anything that is
// a chat_sessions row (a proposal, a shared session, a merged change) and
// `gov:<id>` for a governance proposal. The client joins on these keys.
async function buildThemeInput(pool, app) {
  const appId = app.id;

  let ghIssues = [];
  let issuesTruncated = false;
  const or = parseOwnerRepo(app.repo_url);
  if (or) {
    try {
      const res = await github.fetchPublicIssues(or.owner, or.repo);
      ghIssues = Array.isArray(res && res.issues) ? res.issues : [];
      issuesTruncated = !!(res && res.truncatedList);
    } catch (err) {
      log.warn('workshop-themes', 'issue fetch failed', { app: app.slug, message: err.message });
    }
  }
  let attrs = new Map();
  if (ghIssues.length) {
    try {
      attrs = await topicAttrs.summarizeForTargets(
        pool, appId, 'issue', ghIssues.map((i) => i.number), null
      );
    } catch (err) {
      log.warn('workshop-themes', 'attribute summary failed', { app: app.slug, message: err.message });
    }
  }
  const top = (s) => (s && s.top) || null;
  const categoryOf = new Map();
  const items = [];
  for (const i of ghIssues.slice(0, MAX_ISSUES)) {
    const a = attrs.get(i.number) || {};
    const category = top(a.category);
    categoryOf.set(i.number, category);
    items.push({
      key: `issue:${i.number}`,
      kind: 'issue',
      state: 'open',
      title: clip(i.title, TITLE_MAX),
      excerpt: excerpt(i.body),
      by: i.user || null,
      category,
      priority: top(a.priority),
      updated: day(i.updatedAt),
    });
  }

  // Proposals under vote. `linked_issues` lets a proposal inherit its
  // issue's category in the fallback grouping, and tells the model the two
  // belong together.
  const { rows: reviewRows } = await pool.query(
    `SELECT cs.id, cs.pr_number, cs.pr_title, cs.pr_summary_md, cs.linked_issues, cs.status,
            cs.created_at, u.username,
            (SELECT COUNT(*) FROM pr_votes pv
              WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                AND ${currentVotePredicateSql('pv', 'cs')}) AS yes_count,
            (SELECT COUNT(*) FROM pr_votes pv
              WHERE pv.session_id = cs.id AND pv.vote = 'no'
                AND ${currentVotePredicateSql('pv', 'cs')}) AS no_count
       FROM chat_sessions cs
       LEFT JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1 AND cs.status IN ('promoted', 'merging')
      ORDER BY cs.created_at DESC
      LIMIT ${MAX_REVIEW + 1}`,
    [appId]
  );
  for (const r of reviewRows.slice(0, MAX_REVIEW)) {
    const linked = (Array.isArray(r.linked_issues) ? r.linked_issues : [])
      .map((n) => parseInt(n, 10)).filter(Number.isFinite);
    items.push({
      key: `session:${r.id}`,
      kind: 'proposal',
      state: 'review',
      pr: r.pr_number,
      title: clip(r.pr_title, TITLE_MAX),
      excerpt: excerpt(r.pr_summary_md),
      by: r.username || null,
      linked,
      category: linked.map((n) => categoryOf.get(n)).find(Boolean) || null,
      yes: Number(r.yes_count) || 0,
      no: Number(r.no_count) || 0,
      since: day(r.created_at),
    });
  }

  const { rows: govRows } = await pool.query(
    `SELECT i.id, i.kind, i.title, i.payload, u.username AS created_by_username, i.created_at
       FROM issues i
       LEFT JOIN users u ON u.id = i.created_by
      WHERE i.app_id = $1 AND i.status = 'open'
      ORDER BY i.created_at DESC
      LIMIT ${MAX_GOV + 1}`,
    [appId]
  );
  for (const r of govRows.slice(0, MAX_GOV)) {
    items.push({
      key: `gov:${r.id}`,
      kind: 'governance',
      state: 'review',
      title: clip(
        r.kind === 'rename' && r.payload && r.payload.newName
          ? `Rename to ${r.payload.newName}` : r.title,
        TITLE_MAX
      ),
      by: r.created_by_username || null,
      category: null,
      since: day(r.created_at),
    });
  }

  // Shared in-progress sessions ONLY (shared_at IS NOT NULL): the cache is
  // app-wide, so a private session must never enter the input.
  const { rows: sessionRows } = await pool.query(
    `SELECT cs.id, cs.session_title, cs.pr_title, cs.branch_name, cs.linked_issues, u.username, cs.created_at
       FROM chat_sessions cs
       LEFT JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1 AND cs.shared_at IS NOT NULL
        AND cs.status IN ('active', 'paused') AND cs.is_headless = FALSE
      ORDER BY cs.shared_at ASC
      LIMIT ${MAX_SESSIONS + 1}`,
    [appId]
  );
  for (const r of sessionRows.slice(0, MAX_SESSIONS)) {
    const linked = (Array.isArray(r.linked_issues) ? r.linked_issues : [])
      .map((n) => parseInt(n, 10)).filter(Number.isFinite);
    items.push({
      key: `session:${r.id}`,
      kind: 'session',
      state: 'underway',
      title: clip(r.session_title || r.pr_title || r.branch_name || 'Untitled session', TITLE_MAX),
      by: r.username || null,
      linked,
      category: linked.map((n) => categoryOf.get(n)).find(Boolean) || null,
      since: day(r.created_at),
    });
  }

  // Recently landed changes: the last month, so a theme can say what
  // shipped in it. Older history is the board's Done column's business.
  const { rows: mergedRows } = await pool.query(
    `SELECT cs.id, cs.pr_number, cs.pr_title, cs.linked_issues, u.username, cs.created_at
       FROM chat_sessions cs
       LEFT JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1 AND cs.status = 'merged'
        AND cs.created_at >= NOW() - INTERVAL '${MERGED_WINDOW_DAYS} days'
      ORDER BY cs.created_at DESC
      LIMIT ${MAX_MERGED + 1}`,
    [appId]
  );
  for (const r of mergedRows.slice(0, MAX_MERGED)) {
    const linked = (Array.isArray(r.linked_issues) ? r.linked_issues : [])
      .map((n) => parseInt(n, 10)).filter(Number.isFinite);
    items.push({
      key: `session:${r.id}`,
      kind: 'merged',
      state: 'merged',
      pr: r.pr_number,
      title: clip(r.pr_title, TITLE_MAX),
      by: r.username || null,
      linked,
      category: linked.map((n) => categoryOf.get(n)).find(Boolean) || null,
      at: day(r.created_at),
    });
  }

  const input = {
    appName: clip(app.name || app.slug, 120),
    items,
    truncated: {
      issues: issuesTruncated || ghIssues.length > MAX_ISSUES,
      review: reviewRows.length > MAX_REVIEW,
      gov: govRows.length > MAX_GOV,
      sessions: sessionRows.length > MAX_SESSIONS,
      merged: mergedRows.length > MAX_MERGED,
    },
  };
  return { input };
}

// Canonical (key-sorted) JSON → sha256 hex. Pure.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}
function fingerprint(input) {
  return crypto.createHash('sha256').update(canonical(input)).digest('hex');
}

// ── Stable ids ────────────────────────────────────────────────────────
//
// The model names themes; the service names their ids. A theme the model
// tagged with a previous id keeps it; anything else gets a slug of its
// name, made unique against the ids already in use. Ids are what the
// client keys a filter and an expanded state on, so they must not be the
// model's to invent freely.
function slugify(name) {
  const s = String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'theme';
}

function assignIds(themes, previous) {
  const prevIds = new Set((previous || []).map((p) => p.id));
  const used = new Set();
  return themes.map((t) => {
    let id = t.id && prevIds.has(t.id) && !used.has(t.id) ? t.id : null;
    if (!id) {
      const base = slugify(t.name);
      id = base;
      let n = 2;
      while (used.has(id)) id = `${base}-${n++}`;
    }
    used.add(id);
    return { id, name: t.name, description: t.description, saying: t.saying, items: t.items };
  });
}

// ── The no-model grouping ─────────────────────────────────────────────
//
// By the community-voted category, which is the grouping the board already
// carries. Order: biggest group first; the uncategorised remainder last.
const CATEGORY_LABELS = {
  feature: 'Features', bug: 'Bugs', improvement: 'Improvements',
  design: 'Design', docs: 'Docs', chore: 'Chores',
};

function fallbackThemes(input) {
  const groups = new Map();
  const rest = [];
  for (const it of (input && input.items) || []) {
    if (!it.category) { rest.push(it.key); continue; }
    if (!groups.has(it.category)) groups.set(it.category, []);
    groups.get(it.category).push(it.key);
  }
  const themes = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([cat, keys]) => {
      const label = CATEGORY_LABELS[cat]
        || (cat.charAt(0).toUpperCase() + cat.slice(1));
      return {
        id: `category-${slugify(cat)}`,
        name: label,
        description: `Everything the group has tagged as ${label.toLowerCase()}.`,
        saying: null,
        items: keys,
      };
    });
  if (rest.length) {
    themes.push({
      id: 'everything-else',
      name: 'Everything else',
      description: 'Items nobody has categorised yet.',
      saying: null,
      items: rest,
    });
  }
  return themes;
}

function shapeRow(r) {
  if (!r) return null;
  return {
    inputHash: r.input_hash,
    themes: Array.isArray(r.themes_json) ? r.themes_json : [],
    source: r.source || 'ai',
    model: r.model || null,
    generatedAt: r.generated_at,
  };
}

async function getCached(pool, appId) {
  const { rows } = await pool.query(
    'SELECT input_hash, themes_json, source, model, generated_at FROM app_workshop_themes WHERE app_id = $1',
    [appId]
  );
  return shapeRow(rows[0]);
}

// One generation per app at a time, process-wide.
const inFlight = new Set();

function cooldownElapsed(cached) {
  if (!cached || !cached.generatedAt) return true;
  const t = Date.parse(cached.generatedAt);
  return !Number.isFinite(t) || (Date.now() - t) >= MIN_INTERVAL_MS;
}

// The model call and the cache write. Runs detached from the request that
// noticed the cache was stale; every failure is logged and swallowed,
// because the request already answered with the fallback or the previous
// themes and there is nobody to report to.
async function regenerate({ pool, app, input, hash, cached }) {
  if (inFlight.has(app.id)) return null;
  inFlight.add(app.id);
  try {
    const previous = (cached ? cached.themes : []).map((t) => ({
      id: t.id, name: t.name, description: t.description,
    }));
    const itemKeys = input.items.map((i) => i.key);
    const result = await llm.generateWorkshopThemes({
      inputJson: JSON.stringify({ ...input, previousThemes: previous }),
      appName: app.name || app.slug,
      itemKeys,
      telemetryContext: { pool, appId: app.id },
    });
    const themes = assignIds(result.themes, previous);
    const { rows } = await pool.query(
      `INSERT INTO app_workshop_themes (app_id, input_hash, themes_json, source, model, generated_at)
       VALUES ($1, $2, $3::jsonb, 'ai', $4, NOW())
       ON CONFLICT (app_id) DO UPDATE SET
         input_hash = EXCLUDED.input_hash, themes_json = EXCLUDED.themes_json,
         source = EXCLUDED.source, model = EXCLUDED.model, generated_at = NOW()
       RETURNING input_hash, themes_json, source, model, generated_at`,
      [app.id, hash, JSON.stringify(themes), result.model]
    );
    // Debited to the platform's own account: the lander regenerates on
    // sight, and a viewer must never pay for a page they only opened.
    if (result.usage) {
      try {
        const { ensurePlatformUser } = require('./fleet-maintenance');
        const platformUserId = await ensurePlatformUser(pool);
        await limits.recordSpend(
          pool, platformUserId, llm.estimateCostCents(result.usage, result.model)
        );
      } catch (err) {
        log.warn('workshop-themes', 'spend record failed', { app: app.slug, message: err.message });
      }
    }
    return shapeRow(rows[0]);
  } catch (err) {
    log.warn('workshop-themes', 'generation failed', { app: app.slug, message: err.message });
    return null;
  } finally {
    inFlight.delete(app.id);
  }
}

// What the route serves. Never waits on the model: a fresh cache is
// returned as is; a stale one is returned as is with `stale: true` while
// a regeneration runs behind it (`pending: true` says one is running or
// was just started); no cache at all means the category grouping, with
// the same pending flag.
async function getThemes({ pool, app, waitForGeneration = false }) {
  const { input } = await buildThemeInput(pool, app);
  const hash = fingerprint(input);
  const cached = await getCached(pool, app.id);
  if (cached && cached.inputHash === hash) {
    return {
      themes: cached.themes, source: cached.source, generatedAt: cached.generatedAt,
      stale: false, pending: inFlight.has(app.id), itemCount: input.items.length,
    };
  }
  let pending = inFlight.has(app.id);
  if (!pending && llm.isEnabled() && input.items.length && cooldownElapsed(cached)) {
    const run = regenerate({ pool, app, input, hash, cached });
    pending = true;
    if (waitForGeneration) {
      const fresh = await run;
      if (fresh) {
        return {
          themes: fresh.themes, source: fresh.source, generatedAt: fresh.generatedAt,
          stale: false, pending: false, itemCount: input.items.length,
        };
      }
      pending = false;
    }
  }
  if (cached) {
    return {
      themes: cached.themes, source: cached.source, generatedAt: cached.generatedAt,
      stale: true, pending, itemCount: input.items.length,
    };
  }
  return {
    themes: fallbackThemes(input), source: 'category', generatedAt: null,
    stale: true, pending, itemCount: input.items.length,
  };
}

module.exports = {
  buildThemeInput, fingerprint, fallbackThemes, assignIds, slugify, excerpt,
  getCached, getThemes, regenerate,
  MIN_INTERVAL_MS,
  _inFlightForTests: inFlight,
};
