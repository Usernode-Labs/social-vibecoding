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
// Fixed, predefined category vocabulary — a controlled set (like priority,
// unlike free-text assignee) so chip colours stay consistent and grouping /
// filtering never fragments on casing ("bug" vs "Bug"). Adjust the taxonomy
// by editing this list; no data migration needed since values are strings.
const CATEGORY_VALUES = ['feature', 'bug', 'improvement', 'design', 'docs', 'chore'];
const MAX_ASSIGNEE_LEN = 64;

// Validate + normalize a submitted value for a field. Returns the string
// to store (raw casing preserved for assignee) or null when invalid.
// Priority + category are fixed enums; assignee is free text (trimmed,
// length-capped) — deliberately NOT restricted to registered usernames,
// since the requirement is "type someone's name".
function normalizeValue(field, value) {
  if (field === 'priority') {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return PRIORITY_VALUES.includes(v) ? v : null;
  }
  if (field === 'category') {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return CATEGORY_VALUES.includes(v) ? v : null;
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

// Cast / move the caller's vote, then return the refreshed option list so
// the FE can repaint chip + open dropdown in one round-trip. Upsert keyed
// by the UNIQUE(app_id, target_type, target_ref, field, user_id). The vote
// is always written to the given (targetType, ref) key — casting on a
// proposal writes the proposal key, detaching the field from any inherited
// issue votes. `linkedIssues` is forwarded to listOptions only for the
// (rare) refresh where the proposal still has no own vote for the field.
async function castVote(pool, appId, targetType, ref, field, value, userId, linkedIssues = []) {
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
async function clearVote(pool, appId, targetType, ref, field, userId) {
  await pool.query(
    `DELETE FROM topic_attribute_votes
      WHERE app_id = $1 AND target_type = $2 AND target_ref = $3
        AND field = $4 AND user_id = $5`,
    [appId, targetType, ref, field, userId]
  );
  return listOptions(pool, appId, targetType, ref, field, userId);
}

module.exports = {
  TARGET_TYPES,
  FIELDS,
  PRIORITY_VALUES,
  CATEGORY_VALUES,
  MAX_ASSIGNEE_LEN,
  normalizeValue,
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
