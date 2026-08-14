// Community-voted "priority" + "assigned person" on issues and PR
// proposals (see schema.sql `topic_attribute_votes`). Shared between the
// dedicated read/cast routes (src/routes/topic-attributes.js) and the
// feed-enrichment in the issue + proposal list routes, so the card chips
// can paint on first load and the dropdown can lazy-load the full tally.
//
// Voting model: ONE movable vote per user per (target, field). Casting a
// vote is an upsert — "suggesting" a brand-new value and "voting" for an
// existing one are the same operation. The displayed chip is the
// top-voted value: ranked by count desc, then earliest first-suggestion,
// then alphabetically (a stable tie-break so the chip never flickers).

const TARGET_TYPES = ['issue', 'proposal'];
const FIELDS = ['priority', 'assignee', 'category'];
const PRIORITY_VALUES = ['low', 'medium', 'high'];
// The BUILT-IN category vocabulary. Since #780 this is no longer the whole
// set: an app can also register CUSTOM categories (app_topic_categories),
// which list under these in the dropdown. These six stay hardcoded because
// they need stable colours + labels and are mirrored on the FE
// (ATTR_CATEGORY_VALUES in public/js/app-view.js — keep the two in sync).
const CATEGORY_VALUES = ['feature', 'bug', 'improvement', 'design', 'docs', 'chore'];
const MAX_ASSIGNEE_LEN = 64;
// #780: custom categories are free text, but tighter than the assignee
// field — they render inside a tiny chip pill and a 260px dropdown, so the
// cap is short. The per-app cap bounds how far one spammer can grow the
// vocabulary everybody in the app then sees.
const MAX_CATEGORY_LEN = 24;
const MAX_CUSTOM_CATEGORIES_PER_APP = 24;
// Thrown by ensureCategory when the app is already at its custom cap, so
// the route can turn it into a distinct 400 instead of a 500.
const CATEGORY_CAP_ERROR = 'category_cap_exceeded';
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// #780: validate + normalize a TYPED category into the pair we persist:
//   slug  — lowercased, the dedupe key AND the value stored on the vote
//   label — the same string with its typed casing, for display
// Returns null when the input can't be a category. Control characters are
// neutralised to spaces (never a legitimate part of a label, and they'd
// corrupt the chip), the string is trimmed, internal whitespace runs
// collapse to a single space (so "dev  experience" and "dev experience" are
// one option), and we require at least one letter or digit so pure
// punctuation ("---") can't become a category.
function normalizeCategoryInput(raw) {
  if (typeof raw !== 'string') return null;
  // Control chars become a SPACE (not nothing) so a tab/newline between
  // two words can't silently glue them together, then whitespace collapses.
  /* eslint-disable-next-line no-control-regex */
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length > MAX_CATEGORY_LEN) return null;
  if (!/[A-Za-z0-9]/.test(cleaned)) return null;
  return { slug: cleaned.toLowerCase(), label: cleaned };
}

// Validate + normalize a submitted value for a field. Returns the string
// to store (raw casing preserved for assignee) or null when invalid.
// Priority is a fixed enum; assignee and — since #780 — category are free
// text (trimmed, length-capped). Assignee is deliberately NOT restricted to
// registered usernames, since the requirement is "type someone's name";
// category likewise accepts anything typeable so a new option can be
// suggested in the same gesture as voting for it. The category slug is
// lower-cased here because groupKey() case-folds only `assignee` — every
// category tally relies on values already being lowercase.
function normalizeValue(field, value) {
  if (field === 'priority') {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return PRIORITY_VALUES.includes(v) ? v : null;
  }
  if (field === 'category') {
    const c = normalizeCategoryInput(value);
    return c ? c.slug : null;
  }
  if (field === 'assignee') {
    const v = typeof value === 'string' ? value.trim() : '';
    if (!v || v.length > MAX_ASSIGNEE_LEN) return null;
    return v;
  }
  return null;
}

// Case-insensitive grouping key. Assignee "Evan" and "evan" collapse to
// one option; priority is already lower-cased by normalizeValue.
function groupKey(field, value) {
  return field === 'assignee' ? String(value).toLowerCase() : String(value);
}

// Rank a field's grouped option rows and return the winning one (or null).
// rows: [{ value, count, firstAt }]. Pure — unit-tested directly.
function pickTop(rows) {
  if (!rows || !rows.length) return null;
  const sorted = [...rows].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const at = Date.parse(a.firstAt || '') || 0;
    const bt = Date.parse(b.firstAt || '') || 0;
    if (at !== bt) return at - bt;
    return String(a.value).localeCompare(String(b.value));
  });
  return sorted[0];
}

// Empty per-card summary (no votes yet). Shape the card chips read.
function emptySummary() {
  return {
    priority: { top: null, count: 0, myValue: null },
    assignee: { top: null, count: 0, myValue: null },
    category: { top: null, count: 0, myValue: null },
  };
}

// Coerce a loose ref list (numbers, numeric strings, int[] from pg) to a
// clean list of positive integers.
function normRefs(refs) {
  return (refs || [])
    .map((r) => (typeof r === 'number' ? r : parseInt(r, 10)))
    .filter((n) => Number.isInteger(n) && n > 0);
}

// Grouped tally per (target, field, case-folded value) for a set of refs,
// bucketed as Map<`${ref}|${field}`, [{ value, count, firstAt }]>. This is
// the shared read the summary + inheritance paths build on; array_agg keeps
// the most-recent casing for each display value.
async function fetchBuckets(pool, appId, targetType, ids) {
  const buckets = new Map();
  if (!ids.length) return buckets;
  const { rows } = await pool.query(
    `SELECT target_ref AS ref, field,
            CASE WHEN field = 'assignee' THEN lower(value) ELSE value END AS norm,
            COUNT(*)::int AS count,
            MIN(created_at) AS first_at,
            (array_agg(value ORDER BY created_at DESC))[1] AS display_value
       FROM topic_attribute_votes
      WHERE app_id = $1 AND target_type = $2 AND target_ref = ANY($3::int[])
      GROUP BY target_ref, field, norm`,
    [appId, targetType, ids]
  );
  for (const r of rows) {
    const key = `${r.ref}|${r.field}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ value: r.display_value, count: r.count, firstAt: r.first_at });
  }
  return buckets;
}

// The viewer's own current pick per (target, field), as Map<`${ref}|${field}`,
// value>. Empty when there's no viewer.
async function fetchMyVotes(pool, appId, targetType, ids, userId) {
  const mine = new Map();
  if (!userId || !ids.length) return mine;
  const { rows } = await pool.query(
    `SELECT target_ref AS ref, field, value
       FROM topic_attribute_votes
      WHERE app_id = $1 AND target_type = $2 AND target_ref = ANY($3::int[])
        AND user_id = $4`,
    [appId, targetType, ids, userId]
  );
  for (const m of rows) mine.set(`${m.ref}|${m.field}`, m.value);
  return mine;
}

// Combine already-grouped bucket lists (each from one target) into one
// deduped list for a field: same case-folded value across targets collapses
// (counts sum, earliest first-suggestion wins, display casing follows the
// higher-count member). Used to fold several linked issues' votes into a
// single inherited tally. Pure — unit-testable.
function mergeBuckets(field, lists) {
  const byKey = new Map(); // groupKey -> { value, count, firstAt, _top }
  for (const list of lists || []) {
    for (const b of list || []) {
      const k = groupKey(field, b.value);
      const ex = byKey.get(k);
      if (!ex) {
        byKey.set(k, { value: b.value, count: b.count, firstAt: b.firstAt, _top: b.count });
      } else {
        ex.count += b.count;
        const exT = Date.parse(ex.firstAt || '') || 0;
        const bT = Date.parse(b.firstAt || '') || 0;
        if (bT < exT) ex.firstAt = b.firstAt;
        if (b.count > ex._top) { ex.value = b.value; ex._top = b.count; }
      }
    }
  }
  return [...byKey.values()].map(({ value, count, firstAt }) => ({ value, count, firstAt }));
}

// Turn a bucket list into a per-card summary field ({ top, count, myValue }).
function summaryFromBuckets(list) {
  const top = pickTop(list || []);
  return { top: top ? top.value : null, count: top ? top.count : 0, myValue: null };
}

// Build, for a set of target refs, the minimal per-card summary the feed
// routes attach to each issue / proposal: { priority|assignee: { top,
// count, myValue } }. Returns a Map keyed by target_ref. One grouped
// query + one tiny my-votes query, regardless of how many refs.
async function summarizeForTargets(pool, appId, targetType, refs, userId) {
  const out = new Map();
  const ids = normRefs(refs);
  if (!ids.length) return out;
  for (const id of ids) out.set(id, emptySummary());

  const buckets = await fetchBuckets(pool, appId, targetType, ids);
  for (const [key, list] of buckets) {
    const [refStr, field] = key.split('|');
    const ref = parseInt(refStr, 10);
    if (!FIELDS.includes(field) || !out.has(ref)) continue;
    out.get(ref)[field] = summaryFromBuckets(list);
  }

  const mine = await fetchMyVotes(pool, appId, targetType, ids, userId);
  for (const [key, value] of mine) {
    const [refStr, field] = key.split('|');
    const ref = parseInt(refStr, 10);
    const s = out.get(ref);
    if (s && s[field]) s[field].myValue = value;
  }
  return out;
}

// Proposal-aware summary (#639). Priority/assignee are voted while a task is
// an OPEN ISSUE — keyed ('issue', github_number) — but once the task is
// promoted for voting the card's identity flips to ('proposal', session_id),
// so the chips would read empty and "vanish" (and stay empty through merge,
// since a proposal keeps its session id). This bridges the two keys at read
// time via the proposal's own `linked_issues`, with a PER-FIELD fallback:
// use the proposal's own votes for a field when it has any, otherwise inherit
// the combined tally across its linked issue(s). Retroactive — no backfill.
//
// `proposals` is [{ id, linked_issues }]. Returns a Map keyed by proposal id,
// same shape as summarizeForTargets.
async function summarizeForProposals(pool, appId, proposals, userId) {
  const out = new Map();
  const list = Array.isArray(proposals) ? proposals : [];
  const propIds = normRefs(list.map((p) => p && p.id));
  if (!propIds.length) return out;
  for (const id of propIds) out.set(id, emptySummary());

  // proposal id -> its sanitized linked issue numbers; plus the union set.
  const linkedByProp = new Map();
  const allIssueIds = new Set();
  for (const p of list) {
    const pid = typeof p.id === 'number' ? p.id : parseInt(p.id, 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const issues = normRefs(Array.isArray(p.linked_issues) ? p.linked_issues : []);
    linkedByProp.set(pid, issues);
    for (const n of issues) allIssueIds.add(n);
  }
  const issueIds = [...allIssueIds];

  const propBuckets = await fetchBuckets(pool, appId, 'proposal', propIds);
  const issueBuckets = await fetchBuckets(pool, appId, 'issue', issueIds);
  const propMine = await fetchMyVotes(pool, appId, 'proposal', propIds, userId);
  const issueMine = await fetchMyVotes(pool, appId, 'issue', issueIds, userId);

  for (const pid of propIds) {
    const summary = out.get(pid);
    const issues = linkedByProp.get(pid) || [];
    for (const field of FIELDS) {
      const own = propBuckets.get(`${pid}|${field}`);
      let mv = propMine.get(`${pid}|${field}`) || null;
      if (own && own.length) {
        // The proposal has its own votes for this field — use them as-is.
        summary[field] = summaryFromBuckets(own);
      } else if (issues.length) {
        // Inherit: fold every linked issue's votes for this field together.
        const merged = mergeBuckets(field, issues.map((n) => issueBuckets.get(`${n}|${field}`)));
        summary[field] = summaryFromBuckets(merged);
        // myValue: the viewer's proposal vote wins (none here), else their
        // vote on any linked issue so the dropdown pre-selects correctly.
        if (mv == null) {
          for (const n of issues) {
            const iv = issueMine.get(`${n}|${field}`);
            if (iv != null) { mv = iv; break; }
          }
        }
      }
      if (mv != null) summary[field].myValue = mv;
    }
  }
  return out;
}

// Rank a bucket list into the dropdown's option array, flagging the option
// the viewer currently backs. Shared by the own-target and inherited paths.
function rankOptions(list, field, myValue) {
  const myKey = myValue != null ? groupKey(field, myValue) : null;
  const options = [...(list || [])]
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      const at = Date.parse(a.firstAt || '') || 0;
      const bt = Date.parse(b.firstAt || '') || 0;
      if (at !== bt) return at - bt;
      return String(a.value).localeCompare(String(b.value));
    })
    .map((r) => ({
      value: r.value,
      count: r.count,
      mine: myKey != null && groupKey(field, r.value) === myKey,
    }));
  return { field, options, myValue };
}

// Full option list for ONE target+field, for the dropdown. Returns
// { field, options: [{ value, count, mine }], myValue }, ranked the same
// way pickTop ranks. `mine` flags the option the viewer currently backs.
//
// #639: for a proposal target with NO votes of its own on this field, fall
// back to the combined tally across its `linkedIssues` — the same per-field
// inheritance the card summary uses — so opening a promoted card's dropdown
// shows the tally that was building up on the origin issue (with the viewer's
// earlier issue pick pre-selected). Casting still writes the proposal key
// (see castVote), which "detaches" the field on first vote.
async function listOptions(pool, appId, targetType, ref, field, userId, linkedIssues = []) {
  const { rows } = await pool.query(
    `SELECT CASE WHEN field = 'assignee' THEN lower(value) ELSE value END AS norm,
            COUNT(*)::int AS count,
            MIN(created_at) AS first_at,
            (array_agg(value ORDER BY created_at DESC))[1] AS display_value
       FROM topic_attribute_votes
      WHERE app_id = $1 AND target_type = $2 AND target_ref = $3 AND field = $4
      GROUP BY norm`,
    [appId, targetType, ref, field]
  );
  let myValue = null;
  if (userId) {
    const { rows: mine } = await pool.query(
      `SELECT value FROM topic_attribute_votes
        WHERE app_id = $1 AND target_type = $2 AND target_ref = $3
          AND field = $4 AND user_id = $5`,
      [appId, targetType, ref, field, userId]
    );
    myValue = mine[0] ? mine[0].value : null;
  }

  // Proposal inheritance: only when the proposal itself carries no votes for
  // this field. Its own votes (even one) win outright.
  if (targetType === 'proposal' && rows.length === 0) {
    const issueIds = normRefs(linkedIssues);
    if (issueIds.length) {
      const buckets = await fetchBuckets(pool, appId, 'issue', issueIds);
      const merged = mergeBuckets(field, issueIds.map((n) => buckets.get(`${n}|${field}`)));
      if (merged.length) {
        if (myValue == null && userId) {
          const im = await fetchMyVotes(pool, appId, 'issue', issueIds, userId);
          for (const n of issueIds) {
            const v = im.get(`${n}|${field}`);
            if (v != null) { myValue = v; break; }
          }
        }
        return rankOptions(merged, field, myValue);
      }
    }
  }

  return rankOptions(
    rows.map((r) => ({ value: r.display_value, count: r.count, firstAt: r.first_at })),
    field, myValue
  );
}

// #780: the app's full category vocabulary for the dropdown + filter bar:
// the six built-ins first (custom: false), then the app's registered custom
// categories in creation order, then a SELF-HEAL tail — any category value
// that appears in this app's votes but has no registry row (e.g. a row
// deleted straight in the DB), appended alphabetically. The tail guarantees
// a chip can never display a value the picker doesn't list.
//
// `value` is the slug (what a vote stores); `label` is what the FE renders.
// Built-ins return the slug as their label — the FE owns their display
// names + colours in _categoryMeta, so echoing them here would just be a
// second place to keep in sync.
async function listCategories(pool, appId) {
  const out = CATEGORY_VALUES.map((v) => ({ value: v, label: v, custom: false }));
  const seen = new Set(CATEGORY_VALUES);

  const { rows } = await pool.query(
    `SELECT slug, label FROM app_topic_categories
      WHERE app_id = $1
      ORDER BY created_at ASC, id ASC`,
    [appId]
  );
  for (const r of rows) {
    if (seen.has(r.slug)) continue;
    seen.add(r.slug);
    out.push({ value: r.slug, label: r.label || r.slug, custom: true });
  }

  // Self-heal tail: registered-nowhere values that cards are already using.
  const { rows: orphans } = await pool.query(
    `SELECT DISTINCT value FROM topic_attribute_votes
      WHERE app_id = $1 AND field = 'category'
      ORDER BY value ASC`,
    [appId]
  );
  for (const o of orphans) {
    if (!o.value || seen.has(o.value)) continue;
    seen.add(o.value);
    out.push({ value: o.value, label: o.value, custom: true });
  }

  // Staging previews start from a copy of production, so app_topic_categories
  // — created by this change — arrives EMPTY and the custom-category UI would
  // have nothing to show. Append two obviously-fake entries so the dropdown's
  // custom block, the chip colours and the filter option are all reviewable.
  // Doing it here (rather than a boot seed keyed to one app id) covers
  // whichever app's Dev tab a reviewer opens. Strictly a no-op in production.
  if (IS_STAGING) {
    for (const label of ['Staging demo perf', 'Staging demo onboarding']) {
      const slug = label.toLowerCase();
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ value: slug, label, custom: true });
    }
  }

  return out;
}

// #780: register a typed category for this app so it becomes an option on
// every card, then let the caller cast the vote. No-op for a built-in slug
// (those need no row). Idempotent via UNIQUE(app_id, slug) — the FIRST typed
// label wins, so a later "PERFORMANCE" votes for the existing "Performance"
// without rewriting how it reads. Throws CATEGORY_CAP_ERROR when the app is
// at its custom cap AND this slug isn't already registered, so voting for an
// existing option keeps working at the cap.
async function ensureCategory(pool, appId, { slug, label }, userId) {
  if (CATEGORY_VALUES.includes(slug)) return;
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM app_topic_categories WHERE app_id = $1) AS total,
       (SELECT COUNT(*)::int FROM app_topic_categories
          WHERE app_id = $1 AND slug = $2) AS existing`,
    [appId, slug]
  );
  const total = (rows[0] && rows[0].total) || 0;
  const existing = (rows[0] && rows[0].existing) || 0;
  if (!existing && total >= MAX_CUSTOM_CATEGORIES_PER_APP) {
    throw new Error(CATEGORY_CAP_ERROR);
  }
  if (existing) return;
  await pool.query(
    `INSERT INTO app_topic_categories (app_id, slug, label, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (app_id, slug) DO NOTHING`,
    [appId, slug, label, userId || null]
  );
}

// Cast / move the caller's vote, then return the refreshed option list so
// the FE can repaint chip + open dropdown in one round-trip. Upsert keyed
// by the UNIQUE(app_id, target_type, target_ref, field, user_id). The vote
// is always written to the given (targetType, ref) key — casting on a
// proposal writes the proposal key, detaching the field from any inherited
// issue votes. `linkedIssues` is forwarded to listOptions only for the
// (rare) refresh where the proposal still has no own vote for the field.
//
// #780: for `category`, an unknown value is REGISTERED for the app first —
// typing a new category and voting for it are one operation, exactly like
// suggesting an assignee. `categoryLabel` carries the typed display casing
// (the caller has it from normalizeCategoryInput); it defaults to the slug.
async function castVote(pool, appId, targetType, ref, field, value, userId, linkedIssues = [], categoryLabel = null) {
  if (field === 'category') {
    await ensureCategory(pool, appId, { slug: value, label: categoryLabel || value }, userId);
  }
  await pool.query(
    `INSERT INTO topic_attribute_votes (app_id, target_type, target_ref, field, value, user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (app_id, target_type, target_ref, field, user_id)
       DO UPDATE SET value = EXCLUDED.value, created_at = NOW()`,
    [appId, targetType, ref, field, value, userId]
  );
  return listOptions(pool, appId, targetType, ref, field, userId, linkedIssues);
}

// Withdraw the caller's own vote for a (target, field), then return the
// refreshed option list (same shape as castVote/listOptions) so the FE can
// repaint chip + card in one round-trip. Only removes THIS user's row — the
// card's top value only changes if no other votes remain. Backs the
// drag-to-Unassigned gesture in the PM view (and could back an explicit
// "clear" affordance on the chip). Idempotent: deleting a non-existent vote
// is a no-op.
async function clearVote(pool, appId, targetType, ref, field, userId, linkedIssues) {
  await pool.query(
    `DELETE FROM topic_attribute_votes
      WHERE app_id = $1 AND target_type = $2 AND target_ref = $3
        AND field = $4 AND user_id = $5`,
    [appId, targetType, ref, field, userId]
  );
  // #1187: the refreshed tally must include a proposal's inherited issue
  // votes (like GET/POST do) — the popover repaints straight from this
  // response, so dropping them here would blank inherited options until
  // the next full load.
  return listOptions(pool, appId, targetType, ref, field, userId, linkedIssues);
}

module.exports = {
  TARGET_TYPES,
  FIELDS,
  PRIORITY_VALUES,
  CATEGORY_VALUES,
  MAX_ASSIGNEE_LEN,
  MAX_CATEGORY_LEN,
  MAX_CUSTOM_CATEGORIES_PER_APP,
  CATEGORY_CAP_ERROR,
  normalizeValue,
  normalizeCategoryInput,
  listCategories,
  ensureCategory,
  groupKey,
  pickTop,
  mergeBuckets,
  emptySummary,
  summarizeForTargets,
  summarizeForProposals,
  listOptions,
  castVote,
  clearVote,
};
