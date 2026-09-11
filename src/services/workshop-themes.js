// Workshop themes. The Workshop view (the Dev screen's lander) groups
// everything on an app's board — open issues, proposals under vote, shared
// sessions, recently landed changes — into a handful of THEMES: what the
// work is about, rather than which lifecycle column it sits in.
//
// ── Two stages, one row ───────────────────────────────────────────────
//
// The first cut asked one model call for the themes AND the placement of
// every card, once per (throttled) page view, and hashed the whole board to
// decide when. Three things followed on the platform's own board: the hash
// changed on every vote, so the grouping always read as stale; the input
// was capped at two hundred issues while the page drew every open one; and
// the model, asked to name three hundred keys in a single answer, named
// the ones it had written about and stopped — so most cards sat under
// "Not yet grouped" for good. The grouping is now a pipeline:
//
//   1. SNAPSHOT (buildThemeInput) — every card the board draws, keyed the
//      way the client keys its card models.
//   2. DIFF — the snapshot's keys against the row's PLACEMENTS (key →
//      theme id). Keys that are gone are dropped; keys that are new are
//      what placement has to do; both count as CHURN since the last
//      discovery. Votes, comments and edits are not churn.
//   3. DISCOVERY (llm.generateWorkshopThemeDefinitions), when due — the
//      whole snapshot in, theme DEFINITIONS out: name, description, saying
//      and a few anchor cards. Due on the first run, when the definitions
//      are a day old and anything has changed since, or when churn since
//      the last discovery reaches a tenth of the board (needsDiscovery).
//   4. PLACEMENT (llm.placeWorkshopItems) — batches of cards with the
//      definitions, one theme id (or none) per card, validated per batch
//      and retried once for anything the model skipped. After a discovery
//      every card is placed; otherwise only the new ones.
//   5. PERSIST + NOTIFY — the row (app_workshop_themes) holds the
//      definitions, the placements, the cards the placer could not fit
//      (`unplaced`, which count as churn), the churn counters, the last
//      failure and when the app was last viewed; then ws.pushWorkshopUpdate
//      tells open Workshop pages to re-fetch.
//
// The reconcile runs from three triggers, all through the same function:
// a board change (ws.pushSessionUpdate / pushIssueUpdate → noteBoardChange,
// debounced per app), the hourly leader sweep over apps viewed in the last
// week (sweep), and a GET that finds no draft, cards the row does not know,
// a stage run under another prompt version or a paragraph that is due
// (getThemes), so a first visit still starts one. GET never waits on the
// model: it serves what the row has, with `coverage` saying how much of the
// board that is.
//
// ── Prompt versions ───────────────────────────────────────────────────
//
// Each stage's prompt carries an integer version (llm.WORKSHOP_*_VERSION)
// and the row records the version each stage last ran with. A mismatch
// makes that stage due now, whatever its clocks and churn say: discovery
// re-drafts, placement re-places every card against the standing
// definitions, the digest is rewritten (needsDiscovery, reconcile,
// digestDue). The version is stamped on the ATTEMPT, so a bump against a
// failing model is one call and then the usual backoff, never a retry on
// every view. Before this a prompt change reached an app only when its own
// window ran out — a day, or never on a settled board.
// tests/workshop-prompt-versions.test.js pins each prompt's source to its
// version so a prompt edit cannot ship without deciding whether to bump.
//
// Spend lands on the platform's own account (fleet-maintenance's
// usernode-platform user), never on whoever opened the page or filed the
// issue whose arrival triggered a placement.
//
// When there is no model (staging, self-hosted without a key) the view is
// not empty: `fallbackThemes` groups by the community-voted category — the
// grouping the board already has — computed per request and never cached.
const crypto = require('crypto');
const github = require('./github');
const topicAttrs = require('./topic-attributes');
const { currentVotePredicateSql } = require('./pr-vote-revision');
const limits = require('./limits');
const llm = require('./llm');
const log = require('./logger');

// Caps keep the prompt bounded on a huge app. The issue cap is
// github.fetchPublicIssues' own ceiling: the snapshot is the board, not a
// sample of it — the first cut's two hundred left every older issue of a
// busy repository ungroupable by construction. Every list overflow is
// disclosed to the model via `truncated`.
const MAX_ISSUES = 1000;
const MAX_REVIEW = 100;
const MAX_GOV = 40;
const MAX_SESSIONS = 60;
const MAX_MERGED = 100;
const MERGED_WINDOW_DAYS = 30;
const TITLE_MAX = 140;
const EXCERPT_MAX = 240;

function envInt(name, dflt, floor) {
  const v = parseInt(process.env[name] || String(dflt), 10);
  return Math.max(Number.isFinite(v) ? v : dflt, floor);
}

// Discovery cadence. A discovery is due when the definitions are this old
// AND anything has changed since (a quiet board is not re-drafted), or
// sooner when churn — cards added, cards removed, cards the placer could
// not fit — reaches this share of the board the definitions were drafted
// from. Floored so a mis-set value cannot spin the model.
const DISCOVERY_MAX_AGE_MS = envInt('WORKSHOP_THEMES_MAX_AGE_MS', 24 * 60 * 60 * 1000, 60 * 60 * 1000);
const DRIFT_RATIO = (() => {
  const v = parseFloat(process.env.WORKSHOP_THEMES_DRIFT_RATIO || '0.1');
  return Math.min(1, Math.max(Number.isFinite(v) ? v : 0.1, 0.01));
})();
// A board change starts a reconcile after this quiet period, so a burst —
// a merge that closes three issues and lands a row — is one placement call.
const CHANGE_DEBOUNCE_MS = envInt('WORKSHOP_THEMES_DEBOUNCE_MS', 30 * 1000, 1000);
// After a failed stage, no retry for this long. Without it a persistent
// failure (a model outage, output the sanitiser rejects) could cost one
// model call per board change. The failure is also what the GET reports.
const FAILURE_BACKOFF_MS = envInt('WORKSHOP_THEMES_FAILURE_BACKOFF_MS', 5 * 60 * 1000, 30 * 1000);
// A GET starts a reconcile at most this often per app (per process).
const GET_KICK_MIN_MS = 60 * 1000;
// The row-level lease one reconcile holds; a crashed holder's lease lapses.
const LEASE_INTERVAL = '10 minutes';
// Cards per placement call.
const PLACEMENT_BATCH = 40;
// The sweep re-checks apps somebody opened this recently.
const SWEEP_VIEWED_INTERVAL = '7 days';
const SWEEP_MAX_APPS = 200;

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

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

const linkedOf = (r) => (Array.isArray(r.linked_issues) ? r.linked_issues : [])
  .map((n) => parseInt(n, 10)).filter(Number.isFinite);

// ── 1. The snapshot ───────────────────────────────────────────────────
//
// One item per board card, keyed the way the client's card models are:
// `issue:<number>` for a GitHub issue (open, or closed by an applied
// close-issue proposal — the board's "Shipped this week" draws those),
// `session:<id>` for anything that is a chat_sessions row (a proposal, a
// shared session, a merged change) and `gov:<id>` for a governance
// proposal. The client joins on these keys. A key is listed once; the open
// issue wins over a close row for the same number.
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
  const seen = new Set();
  const push = (item) => {
    if (!item.key || seen.has(item.key)) return;
    seen.add(item.key);
    items.push(item);
  };
  for (const i of ghIssues.slice(0, MAX_ISSUES)) {
    const a = attrs.get(i.number) || {};
    const category = top(a.category);
    categoryOf.set(i.number, category);
    push({
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
      LIMIT $2`,
    [appId, MAX_REVIEW + 1]
  );
  for (const r of reviewRows.slice(0, MAX_REVIEW)) {
    const linked = linkedOf(r);
    push({
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
      LIMIT $2`,
    [appId, MAX_GOV + 1]
  );
  for (const r of govRows.slice(0, MAX_GOV)) {
    push({
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

  // Shared in-progress sessions ONLY (shared_at IS NOT NULL): the row is
  // app-wide, so a private session must never enter the input. The client
  // places the viewer's own private sessions by their linked issue.
  const { rows: sessionRows } = await pool.query(
    `SELECT cs.id, cs.session_title, cs.pr_title, cs.branch_name, cs.linked_issues, u.username, cs.created_at
       FROM chat_sessions cs
       LEFT JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1 AND cs.shared_at IS NOT NULL
        AND cs.status IN ('active', 'paused') AND cs.is_headless = FALSE
      ORDER BY cs.shared_at ASC
      LIMIT $2`,
    [appId, MAX_SESSIONS + 1]
  );
  for (const r of sessionRows.slice(0, MAX_SESSIONS)) {
    const linked = linkedOf(r);
    push({
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

  // Recently landed changes: the last month BY MERGE DATE, so a theme can
  // say what shipped in it — a branch cut two months ago that landed this
  // week is this week's news. Older history is the board's Done column's.
  const window = `${MERGED_WINDOW_DAYS} days`;
  const { rows: mergedRows } = await pool.query(
    `SELECT cs.id, cs.pr_number, cs.pr_title, cs.pr_summary_md, cs.linked_issues, u.username, cs.created_at, cs.merged_at
       FROM chat_sessions cs
       LEFT JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1 AND cs.status = 'merged'
        AND COALESCE(cs.merged_at, cs.created_at) >= NOW() - $2::interval
      ORDER BY COALESCE(cs.merged_at, cs.created_at) DESC
      LIMIT $3`,
    [appId, window, MAX_MERGED + 1]
  );
  for (const r of mergedRows.slice(0, MAX_MERGED)) {
    const linked = linkedOf(r);
    push({
      key: `session:${r.id}`,
      kind: 'merged',
      state: 'merged',
      pr: r.pr_number,
      title: clip(r.pr_title, TITLE_MAX),
      // The plain-language summary voters read, as the review rows already
      // carry. A merged row had only its title, and a title on this board
      // reads like "the row is the card compressed" — evocative, and useless
      // for saying what a person using the app will notice. The summary is
      // written for exactly that reader.
      excerpt: excerpt(r.pr_summary_md),
      by: r.username || null,
      linked,
      category: linked.map((n) => categoryOf.get(n)).find(Boolean) || null,
      at: day(r.merged_at || r.created_at),
    });
  }

  // Issues closed by an applied close-issue proposal in the same window:
  // routes/votes.js's /merged folds them into the Completed stream, and the
  // client keys such a row on the issue it closed.
  const { rows: closedRows } = await pool.query(
    `SELECT i.id, i.title, i.payload, i.github_issue_number, u.username AS created_by_username, i.created_at
       FROM issues i
       LEFT JOIN users u ON u.id = i.created_by
      WHERE i.app_id = $1 AND i.kind = 'close_issue' AND i.status = 'closed'
        AND i.payload ? 'appliedAt'
        AND i.created_at >= NOW() - $2::interval
      ORDER BY i.created_at DESC
      LIMIT $3`,
    [appId, window, MAX_MERGED + 1]
  );
  for (const r of closedRows.slice(0, MAX_MERGED)) {
    const p = r.payload || {};
    const n = parseInt(p.issueNumber != null ? p.issueNumber : r.github_issue_number, 10);
    if (!Number.isFinite(n)) continue;
    push({
      key: `issue:${n}`,
      kind: 'closed-issue',
      state: 'merged',
      title: clip(p.issueTitle || r.title, TITLE_MAX),
      by: r.created_by_username || null,
      category: categoryOf.get(n) || null,
      at: day(p.appliedAt || r.created_at),
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
      merged: mergedRows.length > MAX_MERGED || closedRows.length > MAX_MERGED,
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
// The row's input_hash is the KEY SET's digest: which cards the placements
// cover, not what they say. Votes and edits do not move it.
function fingerprintKeys(keys) {
  return fingerprint({ keys: [...keys].sort() });
}

// ── Stable ids ────────────────────────────────────────────────────────
//
// The model names themes; the service names their ids. A theme the model
// tagged with a previous id keeps it; anything else gets a slug of its
// name, made unique against the ids already in use. Ids are what the
// client keys a filter and an expanded state on, and what every placement
// points at, so they must not be the model's to invent freely.
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
    return {
      id, name: t.name, description: t.description, saying: t.saying,
      icon: t.icon || '',
      anchors: Array.isArray(t.anchors) ? t.anchors : [],
    };
  });
}

// ── The no-model grouping ─────────────────────────────────────────────
//
// By the community-voted category, which is the grouping the board already
// carries. Order: biggest group first; the uncategorised remainder last.
// One glyph per category, fixed rather than hashed: on this grouping the
// category IS the theme, so the icon can mean the category and nothing else.
const CATEGORY_ICONS = {
  feature: '\u2728', bug: '\uD83D\uDC1B', improvement: '\uD83D\uDCC8',
  design: '\uD83C\uDFA8', docs: '\uD83D\uDCC4', chore: '\uD83E\uDDF9',
};
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
        icon: CATEGORY_ICONS[cat] || '',
        items: keys,
      };
    });
  if (rest.length) {
    themes.push({
      id: 'everything-else',
      name: 'Everything else',
      description: 'Items nobody has categorised yet.',
      saying: null,
      icon: '',
      items: rest,
    });
  }
  return themes;
}

// ── Staging's grouping ────────────────────────────────────────────────
//
// A staging preview has a copy of production's board and, usually, no
// model — so the category fallback would show a reviewer one flat group,
// which is exactly the Workshop's failure mode and nothing of its shape.
// Staging gets an OBVIOUSLY FAKE grouping instead: the real items dealt
// round-robin into a few "Staging demo" themes with placeholder sayings, so
// every part of the view (several themes, every lane, the roster, the
// counts) is exercised against real cards. Computed per request, never
// cached, and never in production: this is a demo of the surface, not a
// grouping anyone should read as meaning something.
const STAGING_THEME_NAMES = [
  'Staging demo: getting in',
  'Staging demo: the app on a phone',
  'Staging demo: voting and review',
  'Staging demo: look and feel',
];
// So a preview shows the icon slot filled, which is half of what the slot
// changes about the row of theme heads.
const STAGING_THEME_ICONS = ['\uD83D\uDD11', '\uD83D\uDCF1', '\uD83D\uDDF3\uFE0F', '\uD83C\uDFA8'];

function stagingDemoGrouping(input) {
  const items = (input && input.items) || [];
  if (!items.length) return [];
  const n = Math.min(STAGING_THEME_NAMES.length, Math.max(1, Math.ceil(items.length / 4)));
  const themes = STAGING_THEME_NAMES.slice(0, n).map((name, i) => ({
    id: `staging-demo-${i + 1}`,
    name,
    description: 'A staging-only grouping of real board items, dealt out to show the Workshop\'s shape.',
    saying: 'Staging demo: what people are asking for in this category would be summarised here by the model.',
    icon: STAGING_THEME_ICONS[i] || '',
    items: [],
  }));
  items.forEach((it, i) => { themes[i % n].items.push(it.key); });
  return themes;
}

// ── The row ───────────────────────────────────────────────────────────

const ROW_COLUMNS = `app_id, input_hash, themes_json, placements_json, unplaced_json, source, model,
          generated_at, discovered_at, discovery_key_count, churn_added, churn_removed,
          last_error, last_failed_at, last_viewed_at, reconcile_started_at,
          digest_text, digest_json, digest_at, digest_error,
          discovery_version, placement_version, digest_version`;

// A version column as the row holds it; absent (a fixture from before the
// columns) is the schema's default. Not `|| 1`: 0 is a version too, and one
// a bump test reaches for.
function versionOf(v) {
  return v == null ? 1 : Number(v);
}

function shapeRow(r) {
  if (!r) return null;
  const placements = r.placements_json && typeof r.placements_json === 'object' && !Array.isArray(r.placements_json)
    ? r.placements_json : {};
  return {
    inputHash: r.input_hash,
    themes: Array.isArray(r.themes_json) ? r.themes_json : [],
    placements,
    unplaced: Array.isArray(r.unplaced_json) ? r.unplaced_json.map(String) : [],
    source: r.source || 'ai',
    model: r.model || null,
    generatedAt: r.generated_at || null,
    discoveredAt: r.discovered_at || null,
    discoveryKeyCount: Number(r.discovery_key_count) || 0,
    churnAdded: Number(r.churn_added) || 0,
    churnRemoved: Number(r.churn_removed) || 0,
    lastError: r.last_error || null,
    lastFailedAt: r.last_failed_at || null,
    lastViewedAt: r.last_viewed_at || null,
    reconcileStartedAt: r.reconcile_started_at || null,
    digest: r.digest_text || null,
    // The three windowed lines the lander draws as cards. `digest_text`
    // beside it is the same answer flattened to prose, kept so a row stays
    // readable to anything that only knows the paragraph — including this
    // file's own staleness check, which asks whether ANY text was written.
    digestCards: r.digest_json && typeof r.digest_json === 'object' && !Array.isArray(r.digest_json)
      ? r.digest_json : null,
    digestAt: r.digest_at || null,
    digestError: r.digest_error || null,
    // The prompt version each stage last ran with (llm.WORKSHOP_*_VERSION).
    // 1 for a row written before the columns existed: the schema's default.
    discoveryVersion: versionOf(r.discovery_version),
    placementVersion: versionOf(r.placement_version),
    digestVersion: versionOf(r.digest_version),
  };
}

async function getRow(pool, appId) {
  const { rows } = await pool.query(
    `SELECT ${ROW_COLUMNS} FROM app_workshop_themes WHERE app_id = $1`,
    [appId]
  );
  return shapeRow(rows[0]);
}
// For tests and the route: the cached row without the working columns.
async function getCached(pool, appId) {
  return getRow(pool, appId);
}

// The row exists before the first model call, so a failure has somewhere
// to be recorded and the sweep sees the app from its first view.
async function ensureRow(pool, appId) {
  await pool.query(
    `INSERT INTO app_workshop_themes (app_id, input_hash, last_viewed_at)
     VALUES ($1, '', NOW())
     ON CONFLICT (app_id) DO NOTHING`,
    [appId]
  );
}

// One reconcile per app at a time ACROSS instances: two colours serve
// during a rollout, and a board change reaches whichever handled the
// request. The lease lapses on its own so a crashed holder cannot wedge
// the app.
async function claimLease(pool, appId) {
  const { rows } = await pool.query(
    `UPDATE app_workshop_themes SET reconcile_started_at = NOW()
      WHERE app_id = $1
        AND (reconcile_started_at IS NULL OR reconcile_started_at < NOW() - $2::interval)
      RETURNING app_id`,
    [appId, LEASE_INTERVAL]
  );
  return rows.length > 0;
}

async function releaseLease(pool, appId) {
  await pool.query(
    'UPDATE app_workshop_themes SET reconcile_started_at = NULL WHERE app_id = $1',
    [appId]
  );
}

async function writeRow(pool, appId, next) {
  const { rows } = await pool.query(
    `UPDATE app_workshop_themes
        SET input_hash = $2, themes_json = $3::jsonb, placements_json = $4::jsonb,
            unplaced_json = $5::jsonb, source = 'ai', model = $6, generated_at = NOW(),
            discovered_at = CASE WHEN $7::boolean THEN NOW() ELSE discovered_at END,
            discovery_key_count = CASE WHEN $7::boolean THEN $8::integer ELSE discovery_key_count END,
            churn_added = $9, churn_removed = $10,
            last_error = $11, last_failed_at = CASE WHEN $11::text IS NULL THEN NULL ELSE NOW() END,
            -- A digest is written only when this pass produced one. A pass
            -- that did not (no model, the call failed, nothing changed) keeps
            -- the last one rather than blanking the paragraph: a stale
            -- sentence beside fresh themes is worth more than no sentence.
            --
            -- The CLOCK, though, moves on any pass that TRIED. Staleness is
            -- what schedules the next attempt, so stamping only successes
            -- would put a failing model back on the wire at every single
            -- view, forever. Tried and got nothing is still tried.
            digest_text = COALESCE($12::text, digest_text),
            -- Written together with the text and by the same rule: a pass
            -- that produced nothing leaves both standing rather than
            -- blanking the cards. $19 rather than a slot in the middle
            -- because tests/workshop-prompt-versions.test.js pins the
            -- version columns to their placeholder numbers.
            digest_json = COALESCE($19::jsonb, digest_json),
            digest_at = CASE WHEN $13::boolean THEN NOW() ELSE digest_at END,
            -- The error travels with the clock: a pass that tried records
            -- why it got nothing (or NULL, on success); one that did not try
            -- leaves the last verdict standing. It is what the footnote
            -- shows and what picks the retry window.
            digest_error = CASE WHEN $13::boolean THEN $14::text ELSE digest_error END,
            -- The prompt version each stage ran with, stamped on the ATTEMPT
            -- like the digest clock: a discovery that ran, a pass that placed
            -- EVERY card (a re-draft or a re-place, never an incremental
            -- batch), a digest that was tried. A bump against a failing model
            -- then waits its backoff rather than retrying on every view.
            discovery_version = CASE WHEN $7::boolean THEN $15::integer ELSE discovery_version END,
            placement_version = CASE WHEN $16::boolean THEN $17::integer ELSE placement_version END,
            digest_version = CASE WHEN $13::boolean THEN $18::integer ELSE digest_version END,
            reconcile_started_at = NULL
      WHERE app_id = $1
      RETURNING ${ROW_COLUMNS}`,
    [
      appId, next.inputHash, JSON.stringify(next.themes), JSON.stringify(next.placements),
      JSON.stringify(next.unplaced), next.model || null, !!next.discovered, next.discoveryKeyCount,
      next.churnAdded, next.churnRemoved, next.lastError || null, next.digest || null,
      !!next.digestTried, next.digestError || null,
      llm.WORKSHOP_DISCOVERY_VERSION, !!next.placedAll, llm.WORKSHOP_PLACEMENT_VERSION, llm.WORKSHOP_DIGEST_VERSION,
      next.digestCards ? JSON.stringify(next.digestCards) : null,
    ]
  );
  return shapeRow(rows[0]);
}

async function recordFailure(pool, appId, message) {
  await pool.query(
    `UPDATE app_workshop_themes
        SET last_error = $2, last_failed_at = NOW(), reconcile_started_at = NULL
      WHERE app_id = $1`,
    [appId, String(message || 'failed').slice(0, 200)]
  );
}

// Stamped by GET, at most every few minutes per app: the sweep reads it to
// decide which apps are still worth re-checking.
async function touchViewed(pool, appId) {
  await pool.query(
    `UPDATE app_workshop_themes SET last_viewed_at = NOW()
      WHERE app_id = $1 AND (last_viewed_at IS NULL OR last_viewed_at < NOW() - $2::interval)`,
    [appId, '5 minutes']
  );
}

function backingOff(row) {
  if (!row || !row.lastFailedAt) return false;
  const t = Date.parse(row.lastFailedAt);
  return Number.isFinite(t) && (Date.now() - t) < FAILURE_BACKOFF_MS;
}

// ── 2. The diff, and what it says about the definitions ──────────────

// Pure. A stage's recorded prompt version against the one in the code
// (llm.WORKSHOP_*_VERSION). Behind in either direction: after a rollback the
// row should match the code that is running, not the code that was. Unknown
// (a caller that passed none) is not behind, so the pure predicates keep
// answering from the fields they are about.
function versionBehind(ran, current) {
  return ran != null && Number(ran) !== Number(current);
}

// Pure. Why a discovery is due, or null: 'first' with no definitions yet,
// 'version' when they were drafted under an older prompt, 'drift' when churn
// since the last discovery is a tenth of the board it was drafted from,
// 'age' when the definitions are a day old and anything has changed since.
// Churn is cards added, cards removed and cards the placer could not fit —
// never a vote, a comment or an edit.
function needsDiscovery({ hasThemes, discoveredAt, discoveryKeyCount, churnAdded, churnRemoved, unplacedCount, discoveryVersion, now }) {
  if (!hasThemes) return 'first';
  if (versionBehind(discoveryVersion, llm.WORKSHOP_DISCOVERY_VERSION)) return 'version';
  const churn = (churnAdded || 0) + (churnRemoved || 0) + (unplacedCount || 0);
  const base = Math.max(Number(discoveryKeyCount) || 0, 1);
  if (churn / base >= DRIFT_RATIO) return 'drift';
  const at = Date.parse(discoveredAt || '');
  const age = (now || Date.now()) - at;
  if ((!Number.isFinite(at) || age >= DISCOVERY_MAX_AGE_MS) && churn > 0) return 'age';
  return null;
}

// The row's placements against the snapshot: what is placed, what the
// placer declined, what neither knows yet. A placement pointing at a theme
// that no longer exists is pending, not placed.
function diffRow(row, keys) {
  const themeIds = new Set(row.themes.map((t) => t.id));
  const keySet = new Set(keys);
  const placements = {};
  let removed = 0;
  for (const [k, id] of Object.entries(row.placements)) {
    if (!keySet.has(k)) { removed += 1; continue; }
    if (themeIds.has(id)) placements[k] = id;
  }
  const unplaced = new Set(row.unplaced.filter((k) => keySet.has(k)));
  const added = keys.filter((k) => !(k in placements) && !unplaced.has(k));
  return { placements, unplaced, added, removed };
}

// The themes as the client reads them: definitions with `items` filled from
// the placements, in snapshot order. A row written before placements
// existed carries `items` on the definitions themselves; those serve until
// the first reconcile replaces them.
function themesWithItems(row, keys, placements) {
  const byTheme = new Map(row.themes.map((t) => [t.id, []]));
  const hasPlacements = Object.keys(row.placements).length > 0;
  if (hasPlacements) {
    for (const k of keys) {
      const id = placements[k];
      if (id && byTheme.has(id)) byTheme.get(id).push(k);
    }
  } else {
    const keySet = new Set(keys);
    for (const t of row.themes) {
      for (const k of (Array.isArray(t.items) ? t.items : [])) {
        if (keySet.has(k)) byTheme.get(t.id).push(k);
      }
    }
  }
  return row.themes.map((t) => ({
    id: t.id, name: t.name, description: t.description || '', saying: t.saying || null,
    // '' when the model gave none, or on a row written before icons existed —
    // the client draws the theme's initial rather than a stand-in glyph.
    icon: t.icon || '',
    items: byTheme.get(t.id),
  }));
}

// ── 3 + 4. The model calls ────────────────────────────────────────────

// Debited to the platform's own account: nobody clicked "generate".
async function recordSpend(pool, app, usage, model) {
  if (!usage) return;
  try {
    const { ensurePlatformUser } = require('./fleet-maintenance');
    const platformUserId = await ensurePlatformUser(pool);
    await limits.recordSpend(pool, platformUserId, llm.estimateCostCents(usage, model));
  } catch (err) {
    log.warn('workshop-themes', 'spend record failed', { app: app.slug, message: err.message });
  }
}

// What the placer reads about a card: enough to match it against a
// definition, none of the numbers.
function placementCard(it) {
  return {
    key: it.key,
    kind: it.kind,
    title: it.title,
    excerpt: it.excerpt || undefined,
    category: it.category || undefined,
    by: it.by || undefined,
    linked: it.linked && it.linked.length ? it.linked : undefined,
  };
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function discover({ pool, app, input, previous }) {
  const keys = input.items.map((i) => i.key);
  const result = await llm.generateWorkshopThemeDefinitions({
    inputJson: JSON.stringify({ ...input, previousThemes: previous }),
    appName: app.name || app.slug,
    itemKeys: keys,
    telemetryContext: { pool, appId: app.id },
  });
  await recordSpend(pool, app, result.usage, result.model);
  return { themes: assignIds(result.themes, previous), model: result.model };
}

// The status paragraph. Written from the SAME snapshot and the same themes
// this pass just settled on, so the sentence and the grouping beside it can
// never describe different boards. Failure is not the reconcile's failure:
// the paragraph is one line on a lander and the themes are the product, so a
// digest that throws is logged, the previous one is kept, and the pass
// carries on. Only ever attempted on a pass that re-drafted the themes —
// between drafts nothing about the board's shape has moved enough to say
// anything new, and it would be a Sonnet call per placement batch.
/**
 * How long a digest stands before it is written again.
 *
 * Round three tied the digest to discovery alone, which sounded frugal and
 * was in fact a bug with no symptom in the tests: an app whose themes are
 * settled never re-drafts, so the paragraph was never written AT ALL and
 * every reader saw the client's derived fallback instead. It was invisible
 * because the fallback is a complete sentence — nothing looked broken, it
 * just was not the feature.
 *
 * A day is the cadence the paragraph itself talks in ("this week", "right
 * now"), and it bounds the cost at one call per app per day.
 */
const DIGEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * How long after a FAILED attempt the next one waits. A day was the rule for
 * every attempt, which meant a paragraph that hit the output limit at 4pm
 * stayed missing until 4pm tomorrow, with nothing on the page saying why.
 * An hour is long enough that a model outage does not become a retry storm
 * and short enough that a transient failure costs one refresh, not a day.
 */
const DIGEST_RETRY_MS = 60 * 60 * 1000;

/**
 * `digestAt` is when the digest was last ATTEMPTED, not when text last
 * landed — see writeRow. That is what stops a model that is failing from
 * being retried on every view: a pass that tried and got nothing still
 * stamps the clock and keeps the previous text. `digestError` says whether
 * that last attempt failed, and picks the window: an hour after a failure,
 * a day after a success. Never attempted at all is due now.
 *
 * A row with NO text and NO error is never a success, whatever its clock
 * says. The day's window is earned by a paragraph the page can show; the
 * hour by a failure that was recorded. Neither is there, so it is due now.
 * This is the state a row is left in by the code that ran before
 * `digest_error` existed: it stamped the clock on every attempt and could
 * not record that the attempt got nothing, so a fresh clock, no text and no
 * error read as "written an hour ago" and the page kept its worked-out
 * sentence for a day.
 *
 * `digestDue` answers WHY the paragraph is due ('version', 'never', 'retry',
 * 'age') or null; `digestStale` is the same as a yes or no.
 */
function digestDue(row, now = Date.now()) {
  if (!row) return 'never';
  // Written under another prompt: due whatever the clocks say. The version
  // is stamped on the attempt (writeRow), so a failing model is asked once
  // and then waits its hour like any other failure.
  if (versionBehind(row.digestVersion, llm.WORKSHOP_DIGEST_VERSION)) return 'version';
  const at = Date.parse(row.digestAt || '');
  if (!Number.isFinite(at)) return 'never';
  if (!row.digest && !row.digestError) return 'never';
  if (row.digestError) return now - at >= DIGEST_RETRY_MS ? 'retry' : null;
  return now - at >= DIGEST_MAX_AGE_MS ? 'age' : null;
}
function digestStale(row, now = Date.now()) {
  return digestDue(row, now) !== null;
}

// ── The two calendar weeks the cards are drawn for ────────────────────
//
// Monday-anchored, in UTC. The digest is cached PER APP and read by
// everyone, so a viewer's own timezone cannot decide where the week starts
// without the cached line disagreeing with half the people who read it.
//
// These windows are fetched SEPARATELY from the board snapshot, and that
// separation is the point. The snapshot caps merged rows at MAX_MERGED over
// MERGED_WINDOW_DAYS, which is right for the themes — they want a bounded
// sample of what the app is about. It is wrong for a week: on a board
// merging ~180 changes a week the hundred most recent cover about three
// days, so the old `landedThisWeek` filtered an already-truncated list and
// handed the model a partial week labelled as a whole one. The model then
// did what anyone would with a biased sample and generalised from its top:
// "mostly reshaped the Workshop and Dev board", written about a week whose
// largest single block was Kubernetes work it had never been shown.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// A week's list is capped too — an unbounded one could blow the prompt on a
// fleet-scale app — but an order of magnitude above the busiest week this
// platform has had, and the cap is DISCLOSED per window rather than being a
// silent slice. Truncation the model is told about is a hedge it can write;
// truncation it is not told about is the bug above.
const DIGEST_WEEK_MAX = 400;

/** Midnight UTC on the Monday of the week containing `ms`. */
function weekStart(ms) {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * 86400000;
}

/**
 * The two windows: `last` is the completed Monday–Sunday just gone, `this`
 * is Monday up to now and is therefore PARTIAL by construction — which the
 * prompt is told, so a Tuesday's two-day list does not read as a drought.
 */
function weekWindows(now = Date.now()) {
  const thisStart = weekStart(now);
  return {
    lastStart: thisStart - WEEK_MS,
    lastEnd: thisStart,
    thisStart,
    thisEnd: now,
  };
}

const iso = (ms) => new Date(ms).toISOString();
const label = (ms) => iso(ms).slice(0, 10);

/**
 * Everything that LANDED in `[fromMs, toMs)` — merged proposals and the
 * issues an applied close-issue proposal closed, the same two sources the
 * board snapshot folds into its "merged" state. Complete unless it says
 * otherwise.
 */
async function fetchDigestWeek(pool, appId, fromMs, toMs) {
  const args = [appId, iso(fromMs), iso(toMs), DIGEST_WEEK_MAX + 1];
  const { rows: merged } = await pool.query(
    `SELECT cs.pr_number, cs.pr_title, cs.pr_summary_md, u.username, cs.merged_at, cs.created_at
       FROM chat_sessions cs
       LEFT JOIN users u ON u.id = cs.user_id
      WHERE cs.app_id = $1 AND cs.status = 'merged'
        AND COALESCE(cs.merged_at, cs.created_at) >= $2::timestamptz
        AND COALESCE(cs.merged_at, cs.created_at) <  $3::timestamptz
      ORDER BY COALESCE(cs.merged_at, cs.created_at) DESC
      LIMIT $4`,
    args
  );
  const { rows: closed } = await pool.query(
    `SELECT i.title, i.payload, i.github_issue_number, u.username AS created_by_username, i.created_at
       FROM issues i
       LEFT JOIN users u ON u.id = i.created_by
      WHERE i.app_id = $1 AND i.kind = 'close_issue' AND i.status = 'closed'
        AND i.payload ? 'appliedAt'
        AND i.created_at >= $2::timestamptz
        AND i.created_at <  $3::timestamptz
      ORDER BY i.created_at DESC
      LIMIT $4`,
    args
  );
  const truncated = merged.length > DIGEST_WEEK_MAX || closed.length > DIGEST_WEEK_MAX;
  const items = [
    ...merged.slice(0, DIGEST_WEEK_MAX).map((r) => ({
      kind: 'merged',
      pr: r.pr_number,
      title: clip(r.pr_title, TITLE_MAX),
      // The plain-language summary voters read. It is what the line has to
      // be written from: a title on this board reads like a headline and
      // says nothing about what a person using the app will notice.
      excerpt: excerpt(r.pr_summary_md),
      by: r.username || null,
      at: day(r.merged_at || r.created_at),
    })),
    ...closed.slice(0, DIGEST_WEEK_MAX).map((r) => {
      const p = r.payload || {};
      return {
        kind: 'closed-issue',
        title: clip(p.issueTitle || r.title, TITLE_MAX),
        by: r.created_by_username || null,
        at: day(p.appliedAt || r.created_at),
      };
    }),
  ];
  return { items, truncated };
}

/**
 * The three lines as one paragraph, for `digest_text`.
 *
 * Not a second rendering of the feature — the lander reads the fields. It
 * keeps the text column meaningful for a reader that predates the cards, and
 * it is what `digestDue` asks about when it decides whether ANY text has ever
 * been written for this app (a row with no text and no error is due now).
 * Joining in window order is the only sensible flattening: it is the order
 * the cards are drawn in.
 */
function flattenDigest(cards) {
  if (!cards) return null;
  const text = [cards.lastWeek, cards.thisWeek, cards.open].filter(Boolean).join(' ').trim();
  return text || null;
}

async function makeDigest({ pool, app, input, themes, now = Date.now() }) {
  try {
    const w = weekWindows(now);
    const [last, cur] = await Promise.all([
      fetchDigestWeek(pool, app.id, w.lastStart, w.lastEnd),
      fetchDigestWeek(pool, app.id, w.thisStart, w.thisEnd),
    ]);
    const out = await llm.generateWorkshopDigest({
      inputJson: JSON.stringify(input),
      lastWeekJson: JSON.stringify(last.items),
      thisWeekJson: JSON.stringify(cur.items),
      themesJson: JSON.stringify(themes.map((t) => ({ id: t.id, name: t.name, description: t.description }))),
      appName: app.name || app.slug,
      windows: {
        lastWeekLabel: `${label(w.lastStart)} to ${label(w.lastEnd - 1)}`,
        thisWeekLabel: `${label(w.thisStart)} to today`,
        lastWeekTruncated: last.truncated,
        thisWeekTruncated: cur.truncated,
      },
      telemetryContext: { pool, appId: app.id },
    });
    await recordSpend(pool, app, out.usage, out.model);
    // An answer with nothing usable in it is a failure with a name, not a
    // success with no text: it must retry on the failure clock and show up
    // in the footnote, or it is the silent day-long gap this replaces.
    if (!out.digest) return { digest: null, error: 'the model returned nothing usable' };
    return { digest: out.digest, error: null };
  } catch (err) {
    const message = String((err && err.message) || err).slice(0, 160);
    log.warn('workshop-themes', 'digest failed', { app: app.slug, message });
    return { digest: null, error: message };
  }
}

// Place `keys` into `themes`, a batch at a time. A batch the model answers
// incompletely is asked again for what it skipped; a batch that fails
// outright is left for the next reconcile (`failed`) and the error is the
// row's to report. Sequential on purpose: the theme prefix is cached after
// the first call, and the platform account's rate budget is shared.
async function placeAll({ pool, app, themes, input, keys }) {
  const byKey = new Map(input.items.map((i) => [i.key, i]));
  const themeIds = themes.map((t) => t.id);
  const themesJson = JSON.stringify(themes.map((t) => ({
    id: t.id, name: t.name, description: t.description, anchors: t.anchors || [],
  })));
  const placed = {};
  const none = [];
  const failed = [];
  let error = null;
  let model = null;
  const call = async (batch) => {
    const res = await llm.placeWorkshopItems({
      themesJson,
      itemsJson: JSON.stringify(batch.map((k) => placementCard(byKey.get(k)))),
      appName: app.name || app.slug,
      itemKeys: batch,
      themeIds,
      telemetryContext: { pool, appId: app.id },
    });
    await recordSpend(pool, app, res.usage, res.model);
    model = res.model;
    return res;
  };
  for (const batch of chunk(keys.filter((k) => byKey.has(k)), PLACEMENT_BATCH)) {
    try {
      const res = await call(batch);
      Object.assign(placed, res.placed);
      none.push(...res.none);
      if (res.missing.length) {
        const again = await call(res.missing);
        Object.assign(placed, again.placed);
        none.push(...again.none);
        failed.push(...again.missing);
      }
    } catch (err) {
      error = err;
      failed.push(...batch);
      log.warn('workshop-themes', 'placement batch failed', { app: app.slug, size: batch.length, message: err.message });
    }
  }
  return { placed, none, failed, error, model };
}

// ── 5. Notify ─────────────────────────────────────────────────────────

let notifier = null;
function setNotifier(fn) { notifier = fn; }
function notify(app, stage) {
  try {
    const fn = notifier || require('./ws').pushWorkshopUpdate;
    if (typeof fn === 'function') fn({ appId: app.id, appSlug: app.slug, stage });
  } catch (err) {
    log.debug('workshop-themes', 'notify skipped', { app: app.slug, message: err.message });
  }
}

// ── The reconcile ─────────────────────────────────────────────────────

// Per process: apps with a reconcile running, and apps a change reached
// while one was running (they get one more pass when it ends).
const inFlight = new Set();
const dirty = new Set();

async function reconcile({ pool, app, reason }) {
  const result = {
    reason: reason || null, skipped: null, discovered: false, replaced: false, placed: 0, none: 0, failed: 0, removed: 0,
    // The stages this pass re-ran because their prompt version had moved.
    outdated: [],
  };
  if (inFlight.has(app.id)) { dirty.add(app.id); return { ...result, skipped: 'in-flight' }; }
  if (!llm.isEnabled()) return { ...result, skipped: 'no-model' };
  inFlight.add(app.id);
  let leased = false;
  try {
    const { input } = await buildThemeInput(pool, app);
    if (!input.items.length) return { ...result, skipped: 'empty' };
    await ensureRow(pool, app.id);
    const row = await getRow(pool, app.id);
    if (!row) return { ...result, skipped: 'no-row' };
    if (backingOff(row)) return { ...result, skipped: 'backoff' };
    leased = await claimLease(pool, app.id);
    if (!leased) return { ...result, skipped: 'leased' };

    const keys = input.items.map((i) => i.key);
    const diff = diffRow(row, keys);
    const churnAdded = row.churnAdded + diff.added.length;
    const churnRemoved = row.churnRemoved + diff.removed;
    result.removed = diff.removed;
    const why = needsDiscovery({
      hasThemes: row.themes.length > 0, discoveredAt: row.discoveredAt,
      discoveryKeyCount: row.discoveryKeyCount, churnAdded, churnRemoved,
      unplacedCount: diff.unplaced.size, discoveryVersion: row.discoveryVersion,
    });
    // Cards placed under an older prompt are placed again, all of them,
    // against the definitions as they stand. A re-draft does that anyway.
    const replace = !why && versionBehind(row.placementVersion, llm.WORKSHOP_PLACEMENT_VERSION);
    // A pass with nothing else to do still runs when the paragraph is due:
    // on a settled board this branch is the ONLY one that ever fires, which
    // is exactly why the digest never got written before.
    const digestWhy = why ? 'discovery' : digestDue(row);
    const wantDigest = !!digestWhy;
    if (why === 'version') result.outdated.push('discovery');
    if (replace) result.outdated.push('placement');
    if (digestWhy === 'version') result.outdated.push('digest');
    if (result.outdated.length) log.info('workshop-themes', 'prompt version moved', { app: app.slug, stages: result.outdated });
    if (!why && !replace && !wantDigest && !diff.added.length && !diff.removed && !row.lastError) {
      await releaseLease(pool, app.id);
      leased = false;
      return { ...result, skipped: 'unchanged' };
    }

    let themes = row.themes;
    let model = row.model;
    const next = {
      placements: diff.placements, unplaced: diff.unplaced,
      churnAdded, churnRemoved, discovered: false, discoveryKeyCount: row.discoveryKeyCount,
    };
    let toPlace = diff.added;
    let placedAll = false;
    if (why) {
      const previous = row.themes.map((t) => ({ id: t.id, name: t.name, description: t.description }));
      const disc = await discover({ pool, app, input, previous });
      themes = disc.themes;
      model = disc.model;
      next.placements = {};
      next.unplaced = new Set();
      for (const t of themes) for (const k of t.anchors) if (!(k in next.placements)) next.placements[k] = t.id;
      toPlace = keys.filter((k) => !(k in next.placements));
      next.discovered = true;
      next.discoveryKeyCount = keys.length;
      next.churnAdded = 0;
      next.churnRemoved = 0;
      result.discovered = true;
      placedAll = true;
      log.info('workshop-themes', 'themes drafted', { app: app.slug, reason: why, themes: themes.length, cards: keys.length });
    } else if (replace) {
      // The anchors stay where the draft put them: they are the draft's own
      // examples, not the placer's work. Everything else is placed afresh.
      const keySet = new Set(keys);
      next.placements = {};
      next.unplaced = new Set();
      for (const t of themes) for (const k of t.anchors || []) if (keySet.has(k) && !(k in next.placements)) next.placements[k] = t.id;
      toPlace = keys.filter((k) => !(k in next.placements));
      placedAll = true;
      result.replaced = true;
      log.info('workshop-themes', 'cards re-placed', { app: app.slug, reason: 'version', cards: toPlace.length });
    }

    let lastError = null;
    if (toPlace.length) {
      const out = await placeAll({ pool, app, themes, input, keys: toPlace });
      Object.assign(next.placements, out.placed);
      for (const k of out.none) next.unplaced.add(k);
      if (out.model) model = out.model;
      if (out.error) lastError = `placement: ${String(out.error.message || out.error).slice(0, 160)}`;
      result.placed = Object.keys(out.placed).length;
      result.none = out.none.length;
      result.failed = out.failed.length;
    }

    const dig = wantDigest ? await makeDigest({ pool, app, input, themes }) : { digest: null, error: null };

    await writeRow(pool, app.id, {
      inputHash: fingerprintKeys(keys), themes, placements: next.placements,
      unplaced: [...next.unplaced], model, discovered: next.discovered,
      discoveryKeyCount: next.discoveryKeyCount, churnAdded: next.churnAdded,
      churnRemoved: next.churnRemoved, lastError,
      digest: flattenDigest(dig.digest), digestCards: dig.digest,
      digestTried: wantDigest, digestError: dig.error,
      placedAll,
    });
    leased = false;
    notify(app, why ? 'discovery' : 'placement');
    return result;
  } catch (err) {
    log.warn('workshop-themes', 'reconcile failed', { app: app.slug, reason, message: err.message });
    await recordFailure(pool, app.id, err && err.message).catch(() => {});
    leased = false;
    return { ...result, error: String(err && err.message || err) };
  } finally {
    if (leased) await releaseLease(pool, app.id).catch(() => {});
    inFlight.delete(app.id);
    if (dirty.delete(app.id)) noteBoardChange(pool, { appId: app.id, appSlug: app.slug });
  }
}

// ── Triggers ──────────────────────────────────────────────────────────

async function loadApp(pool, { appId, appSlug }) {
  const { rows } = appId != null
    ? await pool.query('SELECT id, slug, name, repo_url FROM apps WHERE id = $1', [appId])
    : await pool.query('SELECT id, slug, name, repo_url FROM apps WHERE slug = $1', [appSlug]);
  return rows[0] || null;
}

// A board change (ws.pushSessionUpdate / pushIssueUpdate). One timer per
// app: a second change inside the quiet period joins the first. Returns
// whether a reconcile is scheduled.
const changeTimers = new Map();
function noteBoardChange(pool, info) {
  if (!llm.isEnabled() || !pool || !info) return false;
  const key = info.appId != null ? `id:${info.appId}` : (info.appSlug ? `slug:${info.appSlug}` : null);
  if (!key) return false;
  if (changeTimers.has(key)) return true;
  const timer = setTimeout(() => {
    changeTimers.delete(key);
    runChange(pool, info).catch((err) => {
      log.warn('workshop-themes', 'change reconcile failed', { key, message: err.message });
    });
  }, CHANGE_DEBOUNCE_MS);
  if (timer.unref) timer.unref();
  changeTimers.set(key, timer);
  return true;
}

async function runChange(pool, info) {
  const app = await loadApp(pool, info);
  if (!app) return null;
  return reconcile({ pool, app, reason: 'change' });
}

// The hourly leader sweep: every app somebody opened in the last week, in
// turn. Discovery is due for most of them at most once a day; the rest is
// a diff that finds nothing and costs no model call.
async function sweep({ pool, isShuttingDown }) {
  if (!llm.isEnabled()) return { apps: 0, skipped: 'no-model' };
  const { rows } = await pool.query(
    `SELECT a.id, a.slug, a.name, a.repo_url
       FROM app_workshop_themes t
       JOIN apps a ON a.id = t.app_id
      WHERE t.last_viewed_at IS NOT NULL AND t.last_viewed_at >= NOW() - $1::interval
      ORDER BY t.last_viewed_at DESC
      LIMIT $2`,
    [SWEEP_VIEWED_INTERVAL, SWEEP_MAX_APPS]
  );
  let apps = 0;
  let discovered = 0;
  for (const app of rows) {
    if (typeof isShuttingDown === 'function' && isShuttingDown()) break;
    const r = await reconcile({ pool, app, reason: 'sweep' });
    apps += 1;
    if (r && r.discovered) discovered += 1;
  }
  return { apps, discovered };
}

// A GET starts a reconcile at most once a minute per app: the row's own
// lease and the failure backoff bound the rest.
const lastKick = new Map();
function kickAllowed(appId) {
  const t = lastKick.get(appId) || 0;
  if (Date.now() - t < GET_KICK_MIN_MS) return false;
  lastKick.set(appId, Date.now());
  return true;
}

// What the route serves. Never waits on the model. With definitions, the
// themes with their items from the placements, `coverage` counting how
// much of the board they hold, `unplaced` naming the cards the placer
// declined, and `pending` when a reconcile is running or was just started
// (`pendingStage` says which stage). Without definitions, the category
// grouping (or staging's demo) with the same flags.
async function getThemes({ pool, app }) {
  const { input } = await buildThemeInput(pool, app);
  const keys = input.items.map((i) => i.key);
  const row = await getRow(pool, app.id);
  const enabled = llm.isEnabled();
  if (row) touchViewed(pool, app.id).catch(() => {});

  const hasThemes = !!(row && row.themes.length);
  if (!hasThemes) {
    let pending = inFlight.has(app.id);
    if (!pending && enabled && keys.length && !backingOff(row) && kickAllowed(app.id)) {
      pending = true;
      void reconcile({ pool, app, reason: 'get' });
    }
    if (IS_STAGING && !enabled) {
      return {
        themes: stagingDemoGrouping(input), source: 'demo', generatedAt: null, discoveredAt: null,
        stale: true, pending: false, pendingStage: null, lastError: null, coverage: null, unplaced: [],
        digest: 'Staging demo: the model\u2019s three lines on the two weeks and the open board would sit here.',
        digestCards: {
          lastWeek: 'Staging demo: what landed in the completed week just gone would be one line here.',
          thisWeek: 'Staging demo: what has landed so far this week would be one line here.',
          open: 'Staging demo: what the open issues and waiting proposals are about would be one line here.',
        },
        digestError: null,
      };
    }
    return {
      themes: fallbackThemes(input), source: 'category', generatedAt: null, discoveredAt: null,
      digest: null, digestCards: null,
      stale: true, pending, pendingStage: pending ? 'discovery' : null,
      lastError: enabled && row ? row.lastError : null, coverage: null, unplaced: [],
      digestError: null,
    };
  }

  const diff = diffRow(row, keys);
  const themes = themesWithItems(row, keys, diff.placements);
  const placedCount = themes.reduce((n, t) => n + t.items.length, 0);
  const unplacedKeys = [...diff.unplaced];
  const pendingCount = Math.max(0, keys.length - placedCount - unplacedKeys.length);
  const why = needsDiscovery({
    hasThemes: true, discoveredAt: row.discoveredAt, discoveryKeyCount: row.discoveryKeyCount,
    churnAdded: row.churnAdded + diff.added.length, churnRemoved: row.churnRemoved + diff.removed,
    unplacedCount: unplacedKeys.length, discoveryVersion: row.discoveryVersion,
  });
  const replace = !why && versionBehind(row.placementVersion, llm.WORKSHOP_PLACEMENT_VERSION);
  const digestWhy = digestDue(row);
  let pending = inFlight.has(app.id);
  // A view starts a pass for anything the row does not know or holds under
  // an older prompt, the paragraph included. It used to wait for unplaced
  // cards or a due draft alone, so a version bump, or a day-old paragraph,
  // reached the page only when the hourly sweep came round.
  const due = pendingCount > 0 || !!why || replace || !!digestWhy;
  if (!pending && enabled && due && !backingOff(row) && kickAllowed(app.id)) {
    pending = true;
    void reconcile({ pool, app, reason: 'get' });
  }
  return {
    themes,
    source: row.source || 'ai',
    generatedAt: row.generatedAt,
    discoveredAt: row.discoveredAt,
    stale: !!why || replace || pendingCount > 0,
    pending,
    pendingStage: pending ? (why ? 'discovery' : (pendingCount > 0 || replace ? 'placement' : 'digest')) : null,
    lastError: row.lastError,
    coverage: { total: keys.length, placed: placedCount, unplaced: unplacedKeys.length, pending: pendingCount },
    unplaced: unplacedKeys,
    digest: row.digest || null,
    digestCards: row.digestCards || null,
    digestError: row.digestError || null,
  };
}

module.exports = {
  buildThemeInput, fingerprint, fingerprintKeys, fallbackThemes, stagingDemoGrouping, assignIds, slugify, excerpt,
  needsDiscovery, versionBehind, digestDue, digestStale, diffRow, themesWithItems,
  getCached, getThemes, reconcile, noteBoardChange, sweep, setNotifier,
  DISCOVERY_MAX_AGE_MS, DIGEST_MAX_AGE_MS, DIGEST_RETRY_MS, DRIFT_RATIO, CHANGE_DEBOUNCE_MS, FAILURE_BACKOFF_MS, PLACEMENT_BATCH,
  // The digest’s own windows, fetched apart from the board snapshot so a
  // week is never a truncated slice of one. DIGEST_WEEK_MAX is the cap it
  // discloses rather than hides.
  weekStart, weekWindows, fetchDigestWeek, flattenDigest, DIGEST_WEEK_MAX,
  _inFlightForTests: inFlight,
  _dirtyForTests: dirty,
  _changeTimersForTests: changeTimers,
  _lastKickForTests: lastKick,
  _runChangeForTests: runChange,
};
