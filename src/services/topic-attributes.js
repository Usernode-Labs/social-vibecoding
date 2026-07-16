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
const FIELDS = ['priority', 'assignee'];
const PRIORITY_VALUES = ['low', 'medium', 'high'];
const MAX_ASSIGNEE_LEN = 64;

// Validate + normalize a submitted value for a field. Returns the string
// to store (raw casing preserved for assignee) or null when invalid.
// Priority is a fixed enum; assignee is free text (trimmed, length-capped)
// — deliberately NOT restricted to registered usernames, since the
// requirement is "type someone's name".
function normalizeValue(field, value) {
  if (field === 'priority') {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return PRIORITY_VALUES.includes(v) ? v : null;
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
  };
}

// Build, for a set of target refs, the minimal per-card summary the feed
// routes attach to each issue / proposal: { priority|assignee: { top,
// count, myValue } }. Returns a Map keyed by target_ref. One grouped
// query + one tiny my-votes query, regardless of how many refs.
async function summarizeForTargets(pool, appId, targetType, refs, userId) {
  const out = new Map();
  const ids = (refs || [])
    .map((r) => (typeof r === 'number' ? r : parseInt(r, 10)))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return out;
  for (const id of ids) out.set(id, emptySummary());

  // Grouped tally per (target, field, case-folded value). array_agg keeps
  // the most-recent casing for the display value.
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
  // Bucket rows by ref+field, pick the top per bucket.
  const buckets = new Map(); // `${ref}|${field}` -> [{ value, count, firstAt }]
  for (const r of rows) {
    const key = `${r.ref}|${r.field}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ value: r.display_value, count: r.count, firstAt: r.first_at });
  }
  for (const [key, list] of buckets) {
    const [refStr, field] = key.split('|');
    const ref = parseInt(refStr, 10);
    if (!FIELDS.includes(field) || !out.has(ref)) continue;
    const top = pickTop(list);
    out.get(ref)[field] = { top: top ? top.value : null, count: top ? top.count : 0, myValue: null };
  }

  // The viewer's own current pick per (target, field), if any.
  if (userId) {
    const { rows: mine } = await pool.query(
      `SELECT target_ref AS ref, field, value
         FROM topic_attribute_votes
        WHERE app_id = $1 AND target_type = $2 AND target_ref = ANY($3::int[])
          AND user_id = $4`,
      [appId, targetType, ids, userId]
    );
    for (const m of mine) {
      const s = out.get(m.ref);
      if (s && s[m.field]) s[m.field].myValue = m.value;
    }
  }
  return out;
}

// Full option list for ONE target+field, for the dropdown. Returns
// { field, options: [{ value, count, mine }], myValue }, ranked the same
// way pickTop ranks. `mine` flags the option the viewer currently backs.
async function listOptions(pool, appId, targetType, ref, field, userId) {
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
  const myKey = myValue != null ? groupKey(field, myValue) : null;
  const options = rows
    .map((r) => ({ value: r.display_value, count: r.count, firstAt: r.first_at }))
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

// Merge a proposal's own attribute summary with the summary of the issue
// it addresses, per field. A proposal keeps its OWN voted value for a
// field whenever it has one (top != null); only a field the proposal has
// no votes for falls back to the linked issue's value — so a proposal's
// direct votes always win and nothing an issue carries can override them.
// `myValue` always stays sourced from the proposal summary (the viewer's
// movable vote belongs to the target they'd actually vote on), so the
// dropdown's "your pick" highlight is unaffected by the inherited display.
// Pure — unit-tested directly. `proposalSummary` is required; `issueSummary`
// may be null (no linked issue) in which case the proposal summary is
// returned unchanged.
function applyIssueFallback(proposalSummary, issueSummary) {
  const base = proposalSummary || emptySummary();
  if (!issueSummary) return base;
  const out = emptySummary();
  for (const field of FIELDS) {
    const own = base[field] || { top: null, count: 0, myValue: null };
    if (own.top != null) {
      out[field] = own;
      continue;
    }
    const inherited = issueSummary[field] || { top: null, count: 0 };
    // Inherit the issue's displayed top value + count, but never the
    // issue's myValue — the viewer's own pick is per-target.
    out[field] = {
      top: inherited.top != null ? inherited.top : null,
      count: inherited.top != null ? inherited.count : 0,
      myValue: own.myValue != null ? own.myValue : null,
    };
  }
  return out;
}

// Cast / move the caller's vote, then return the refreshed option list so
// the FE can repaint chip + open dropdown in one round-trip. Upsert keyed
// by the UNIQUE(app_id, target_type, target_ref, field, user_id).
async function castVote(pool, appId, targetType, ref, field, value, userId) {
  await pool.query(
    `INSERT INTO topic_attribute_votes (app_id, target_type, target_ref, field, value, user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (app_id, target_type, target_ref, field, user_id)
       DO UPDATE SET value = EXCLUDED.value, created_at = NOW()`,
    [appId, targetType, ref, field, value, userId]
  );
  return listOptions(pool, appId, targetType, ref, field, userId);
}

module.exports = {
  TARGET_TYPES,
  FIELDS,
  PRIORITY_VALUES,
  MAX_ASSIGNEE_LEN,
  normalizeValue,
  groupKey,
  pickTop,
  emptySummary,
  applyIssueFallback,
  summarizeForTargets,
  listOptions,
  castVote,
};
