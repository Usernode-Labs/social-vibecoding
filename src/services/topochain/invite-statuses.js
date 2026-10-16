// The challenge page's "Your invites" list — why each person you invited
// does or does not count for an INVITES_JOINED challenge (#3650).
//
// The scorer pays on the person's FIRST invite taken, once, inside the
// rule's window, on the rule's scheduled pass (the counted-measure rule the
// scorer's own header explains). That is the whole rule, and it is what
// people could not see: marleeehilpert had invited about ten people and the
// card said "1/3 joined", with no way to tell why the other nine were not
// the two missing. This reader answers it per person, with the status the
// scorer's own SQL decides — the same first-invite union
// (INVITES_FIRST_TAKEN_SQL, exported by ./challenge-scorer.js) and the same
// rule row (RULE_CHALLENGES_SQL) — so the list can never disagree with what
// the next scheduled pass will pay.
//
// Read-only, and it never scores: a person who counts shows "Counted" from
// the LEDGER (their source_key is already paid), and one whose join the
// scorer has not taken yet shows "Counts soon". Nothing here writes
// credits, and nothing here touches the points sync.
'use strict';

const scorer = require('./challenge-scorer');
const rules = require('./challenge-rules');

// ── The statuses, checked in this order ────────────────────────────────
//
// The ledger is checked first, so a credited person always reads Counted,
// even if a later record of theirs looks different (they left, or a second
// link of the viewer's was revoked): the ledger is what the score is.
// `other_invite` before the window checks, because the first invite they
// took decides whose it is — each person counts once, and the inviter is
// whoever's record came first, whatever the window says.

const STATUS_ORDER = Object.freeze({
  counted: 0,
  pending_count: 1,
  waiting_access: 2,
  not_accepted: 3,
  over_target: 4,
  other_invite: 5,
  outside_window: 6,
  link_off: 7,
});

// ── The reads ──────────────────────────────────────────────────────────

// The viewer's link redemptions: a person who followed one of the viewer's
// links. 'cancelled' is out — a queued redemption whose link was turned off
// first was never followed in earnest — and so is the viewer following
// their own link (inviter_id <> invitee_id, as the scorer's union holds).
// `maker_holds` is the function apply_community_invite() re-checks at
// release: while it is FALSE a queued person waits for nobody — the link
// can no longer grant what it granted.
const VIEWER_REDEMPTIONS_SQL = `
  SELECT x.user_id AS invitee_id, x.status, x.created_at, x.applied_at,
         i.revoked_at, community_invite_maker_holds(i.id) AS maker_holds
    FROM community_invite_redemptions x
    JOIN community_invites i ON i.id = x.invite_id
   WHERE i.created_by = $1
     AND x.user_id <> $1
     AND x.status <> 'cancelled'
`;

// The viewer's collaborator invites, by username or by email once claimed:
// 'member' is accepted (a join the scorer pays on), 'invited' is still open.
const VIEWER_COLLABS_SQL = `
  SELECT c.user_id AS invitee_id, c.status, c.created_at, c.accepted_at
    FROM app_collaborators c
   WHERE c.invited_by = $1
     AND c.user_id <> $1
     AND c.status IN ('member', 'invited')
`;

// Each person's first record across ALL inviters — the scorer's own union,
// restricted to the people the viewer has records for. An empty id list
// answers empty, so the same statement runs whatever the viewer has.
const FIRST_RECORDS_SQL = `
  SELECT f.inviter_id, f.invitee_id, f.at
    FROM (${scorer.INVITES_FIRST_TAKEN_SQL}) f
   WHERE f.invitee_id = ANY($1::bigint[])
`;

// What this challenge's ledger already holds for the viewer. The key
// `invitee:<user id>` is the scorer's own sourceKey for an invite credit.
const CREDITED_KEYS_SQL = `
  SELECT metadata->>'source_key' AS source_key
    FROM user_activities
   WHERE challenge_id = $1
     AND user_id = $2
     AND metadata->>'source_key' LIKE 'invitee:%'
`;

// Names, and the synthetic exclusion: the bot's and the bench's accounts
// are not people anybody invited on purpose, and they are never listed.
const INVITEE_NAMES_SQL = `
  SELECT u.id, u.username, u.display_name, u.username_provisional_since, u.is_synthetic
    FROM users u
   WHERE u.id = ANY($1::bigint[])
`;

// A provisional handle is a name, not a username; nothing public may show
// it. Their display name shows instead, and without an @.
function nameOf(row) {
  if (!row) return null;
  if (row.username_provisional_since != null) return row.display_name || null;
  return row.username ? `@${row.username}` : null;
}

const tsOf = (v) => (v instanceof Date ? v.getTime() : (v == null ? NaN : Date.parse(v)));
const isoOf = (v) => (v instanceof Date ? v.toISOString() : null);

async function inviteStatuses(pool, { userId, challengeId, now = Date.now() } = {}) {
  const viewer = Number(userId);
  const challenge = Number(challengeId);
  if (!Number.isFinite(viewer) || !viewer
      || !Number.isFinite(challenge) || !challenge) return null;

  // ── 1. The rule row for this challenge ────────────────────────────────
  // The same read the scorer's run takes, narrowed in memory to the one
  // challenge and the invite measure. A challenge no enabled INVITES_JOINED
  // rule scores has no list — the route answers 404, and the page shows
  // nothing new on it.
  const { rows: ruleRows } = await pool.query(scorer.RULE_CHALLENGES_SQL, [scorer.ONBOARDING_LIMIT]);
  const row = ruleRows.find((r) => Number(r.challenge_id) === challenge
    && r.measure === 'INVITES_JOINED');
  if (!row) return null;
  // The same rule/row shapes scoreChallenge passes the rules helpers.
  const rule = {
    id: row.rule_id,
    name: row.rule_name,
    measure: row.measure,
    target: row.rule_target,
    points: row.rule_points,
    enabled: row.rule_enabled,
  };
  const window = rules.resolveWindow(row, { now });
  const target = rules.effectiveTarget(rule, row);

  // ── 2. The viewer's own records ───────────────────────────────────────
  const [{ rows: redemptions }, { rows: collabs }, { rows: creditedRows }] = await Promise.all([
    pool.query(VIEWER_REDEMPTIONS_SQL, [viewer]),
    pool.query(VIEWER_COLLABS_SQL, [viewer]),
    pool.query(CREDITED_KEYS_SQL, [challenge, viewer]),
  ]);
  const creditedKeys = new Set(creditedRows.map((r) => r.source_key));
  const creditedCount = creditedKeys.size;

  const byInvitee = (list) => {
    const map = new Map();
    for (const r of list) {
      const id = Number(r.invitee_id);
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(r);
    }
    return map;
  };
  const redsBy = byInvitee(redemptions);
  const colsBy = byInvitee(collabs);
  const ids = [...new Set([...redsBy.keys(), ...colsBy.keys()])];

  // ── 3/4. Each person's first record, and their name ───────────────────
  const firsts = new Map();
  const names = new Map();
  if (ids.length) {
    const [{ rows: firstRows }, { rows: nameRows }] = await Promise.all([
      pool.query(FIRST_RECORDS_SQL, [ids]),
      pool.query(INVITEE_NAMES_SQL, [ids]),
    ]);
    for (const r of firstRows) firsts.set(Number(r.invitee_id), r);
    for (const r of nameRows) names.set(Number(r.id), r);
  }

  // ── 5. One status per person ──────────────────────────────────────────
  const people = [];
  for (const id of ids) {
    const nameRow = names.get(id);
    // A synthetic account is nobody's invitee (is_synthetic — the bot, the
    // bench): it counts on no challenge and is never listed.
    if (nameRow && nameRow.is_synthetic) continue;

    const reds = redsBy.get(id) || [];
    const cols = colsBy.get(id) || [];
    // The records a JOIN is, in the scorer union's own terms: a link
    // applied, or a collaborator invite accepted.
    const joinedRed = reds.find((r) => r.status === 'joined' && r.applied_at != null);
    const acceptedCol = cols.find((c) => c.status === 'member' && c.accepted_at != null);
    const hasJoinedRecord = !!(joinedRed || acceptedCol);
    const first = firsts.get(id) || null;
    const firstIsViewer = !!(first && Number(first.inviter_id) === viewer);
    const firstAt = first ? tsOf(first.at) : NaN;
    const at = Number.isFinite(firstAt) ? isoOf(first.at) : null;

    const queuedRed = reds.find((r) => r.status === 'queued' && r.applied_at == null);
    const invitedCol = cols.find((c) => c.status === 'invited');

    let status = null;
    if (creditedKeys.has(`invitee:${id}`)) {
      status = 'counted';
    } else if (hasJoinedRecord && first && !firstIsViewer) {
      status = 'other_invite';
    } else if (hasJoinedRecord && firstIsViewer) {
      if ((window.startMs != null && Number.isFinite(firstAt) && firstAt < window.startMs)
          || (window.endMs != null && Number.isFinite(firstAt) && firstAt > window.endMs)) {
        status = 'outside_window';
      } else if (Number.isFinite(target) && creditedCount >= target) {
        status = 'over_target';
      } else {
        status = 'pending_count';
      }
    } else if (queuedRed) {
      // They followed the link but no community got them: the link still
      // grants, so they join when they are let into Homeroom (the
      // queued-invite trigger), or the link died while they waited.
      const off = queuedRed.revoked_at != null || queuedRed.maker_holds === false;
      status = off ? 'link_off' : 'waiting_access';
    } else if (invitedCol) {
      status = 'not_accepted';
    } else {
      // A record the viewer holds that none of the statuses above describe
      // (a queued redemption replaced by a joined one they did not take —
      // unreachable today, guarded for a shape the scorer may add). Not
      // shown rather than shown with a wrong reason.
      continue;
    }

    // The time the person sees: when they joined (a first record), when
    // they followed the link, or when they were invited.
    const stampAt = status === 'counted' || hasJoinedRecord
      ? at
      : isoOf(queuedRed?.created_at ?? invitedCol?.created_at ?? null);

    people.push({
      user_id: id,
      name: nameOf(nameRow),
      status,
      at: stampAt,
    });
  }

  // Counted first, then the ones waiting to be counted, then the ones
  // waiting on a person, then the rest — newest first within a group, so a
  // long list leads with what happened last. Capped at 100: a page of
  // names past that is a wall, and the status people act on is among the
  // first hundred anyway (counted sorts first).
  people.sort((a, b) => ((STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99))
    || ((Number.isFinite(tsOf(b.at)) ? tsOf(b.at) : 0) - (Number.isFinite(tsOf(a.at)) ? tsOf(a.at) : 0)));
  return { target: Number.isFinite(target) ? target : null, people: people.slice(0, 100) };
}

module.exports = { inviteStatuses };
