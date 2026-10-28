'use strict';

/**
 * #4666: WHO CAN SEE & CHANGE IT, proposed as one change.
 *
 * The sheet of that name (frontend/src/features/dialogs/who-decides.tsx)
 * puts who can see a project and how its changes are approved in one place,
 * and whatever is changed there goes up as ONE pull request on dapp.json:
 * the `visibility` block, the `governance` block, or both. Same lifecycle as
 * a visibility or a governance change (services/rename-pr.js
 * createManifestPR): the PR drops into the vote panel, and when it merges
 * the production rebuild's reconciles apply it.
 *
 *   visibility   'private' (a private community: members see and build it)
 *                or 'public' (a public community: anyone can see and join
 *                it, and everyone who can see it can suggest changes).
 *                "Public, invite-only building" is not offered any more; a
 *                project that has it keeps it until it proposes one of the
 *                two, and its sheet says what it has.
 *   governance   `{ preset }` or `{ groups, rules }`
 *                (services/governance-rules.js), written as dapp.json's
 *                `governance` block, which replaces the old two keys.
 *
 * A change to who decides is always flagged for explicit approval, so it is
 * decided by the creator's yes or the group's real votes, never on a quiet
 * wait (services/governance.js computeRulesGate; on a project still on the
 * old two columns, the #788 modifier as before).
 *
 * The route (POST /api/apps/:slug/who-decides-pr) owns the gates. This
 * module owns reading the body (pure: parseChange, describeChange) and the
 * edit.
 */

const governanceRules = require('./governance-rules');
const renamePr = require('./rename-pr');

const VISIBILITIES = Object.freeze(['private', 'public']);

class WhoDecidesError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'WhoDecidesError';
    this.status = status;
    this.extra = extra;
  }
}

/**
 * The body as a change: `{ visibility: 'private'|'public'|null,
 * governance: rules value | null }`, or throw WhoDecidesError. Neither is
 * a 400: there is nothing to propose.
 */
function parseChange(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  let visibility = null;
  if (b.visibility != null) {
    if (!VISIBILITIES.includes(b.visibility)) throw new WhoDecidesError('visibility must be "private" or "public"');
    visibility = b.visibility;
  }
  let governance = null;
  if (b.governance != null) {
    try {
      governance = governanceRules.parseRulesBlock(b.governance);
    } catch (err) {
      if (err instanceof governanceRules.RulesError) throw new WhoDecidesError(err.message);
      throw err;
    }
    if (!governance) throw new WhoDecidesError('governance needs a preset, or groups and rules');
  }
  if (!visibility && !governance) throw new WhoDecidesError('Choose who can see it, how changes are approved, or both');
  return { visibility, governance };
}

/** The two visibility columns a choice means. */
function columnsFor(visibility) {
  return visibility === 'public'
    ? { collab: 'public', view: 'public' }
    : { collab: 'private', view: 'private' };
}

/**
 * What changes, against the app as it is: `{ visibility, governance }` with
 * each part kept only when it differs. `current` is
 * `{ collab, view, rules }` (the app row's columns and its rules value, null
 * for a project on the old two columns, which no rules value equals).
 */
function diffChange(change, current) {
  const out = { visibility: null, governance: null };
  if (change.visibility) {
    const want = columnsFor(change.visibility);
    if (want.collab !== current.collab || want.view !== current.view) out.visibility = change.visibility;
  }
  if (change.governance) {
    const was = current.rules ? JSON.stringify(governanceRules.blockFor(current.rules)) : null;
    const now = JSON.stringify(governanceRules.blockFor(change.governance));
    if (was !== now) out.governance = change.governance;
  }
  return out;
}

/** The PR's title: what it does, in the sheet's words. */
function describeChange({ visibility, governance }) {
  const vis = visibility === 'public' ? 'a public community' : 'a private community';
  const rule = governance ? governanceRules.describeRules(governance) : null;
  if (visibility && rule) return `Make this ${vis}, approved by ${rule}`;
  if (visibility) return `Make this ${vis}`;
  return `Approve changes by ${rule}`;
}

/**
 * Check that a named group's people are people: each must be a registered
 * user. Resolves `{ ok: true }` or throws WhoDecidesError naming who is not.
 */
async function checkPeople(pool, governance) {
  const names = [...new Set((governance.groups || []).flatMap((g) => g.people.map((p) => p.toLowerCase())))];
  if (!names.length) return;
  const usernames = require('./usernames');
  const found = await usernames.resolveHandles(pool, names);
  const known = new Set(found.map((r) => r.declared));
  const missing = names.filter((n) => !known.has(n));
  if (missing.length) {
    throw new WhoDecidesError(`@${missing[0]} is not on Homeroom`, 400, { missing });
  }
}

/**
 * Open the PR. `change` is diffChange's output (at least one part set).
 * Resolves `{ sessionId, prNumber, prUrl, branch, title }`.
 */
async function createWhoDecidesPR(config, pool, app, change, actor, { steps } = {}) {
  const title = describeChange(change);
  const parts = [];
  if (change.visibility) {
    parts.push(change.visibility === 'public'
      ? 'makes it a public community: anyone can see it and join, and everyone who can see it can suggest changes'
      : 'makes it a private community: only its members can see it');
  }
  if (change.governance) {
    parts.push(`approves its changes by ${governanceRules.describeRules(change.governance)}`);
  }
  const block = change.governance ? governanceRules.blockFor(change.governance) : null;
  const result = await renamePr.createManifestPR(config, pool, app, actor, {
    steps,
    mutate: (m) => {
      if (change.visibility) {
        const cols = columnsFor(change.visibility);
        m.visibility = { build: cols.collab, view: cols.view };
      }
      if (block) m.governance = block;
    },
    branchPrefix: 'who-decides',
    commitMessage: title,
    prTitle: title,
    prBody:
      `${actor.username} (via Homeroom) proposed a change to who can see and change "${app.name}": it ${parts.join(', and ')}.\n\n`
      + 'This PR updates '
      + [change.visibility ? 'the `visibility` block' : null, block ? 'the `governance` block' : null].filter(Boolean).join(' and ')
      + ' in `dapp.json`. A change to who decides goes live on the creator\'s yes, or on the group\'s real yes votes, '
      + 'never on a quiet wait. It applies automatically once the PR merges and the project redeploys.',
    chatText: (prData) => `${actor.username} proposed: ${title}. Opened PR #${prData.number}.`,
    eventMetadata: { whoDecides: true, visibility: !!change.visibility, governance: !!block },
    explicitApproval: true,
    explicitApprovalReason: block ? 'governance' : 'visibility',
  });
  return { ...result, title };
}

/**
 * The change to who decides already up for a vote, if one is: a
 * who-decides PR, or one of the single-block PRs it replaces.
 */
async function findWhoDecidesPr(pool, appId) {
  const { rows } = await pool.query(
    `SELECT id, pr_number, pr_url, pr_title FROM chat_sessions
      WHERE app_id = $1 AND status IN ('promoted', 'merging')
        AND (branch_name LIKE 'who-decides/%' OR branch_name LIKE 'governance/%'
             OR branch_name LIKE 'visibility/%')
      ORDER BY id DESC
      LIMIT 1`,
    [appId]
  );
  return rows[0] || null;
}

module.exports = {
  VISIBILITIES,
  WhoDecidesError,
  parseChange,
  columnsFor,
  diffChange,
  describeChange,
  checkPeople,
  createWhoDecidesPR,
  findWhoDecidesPr,
};
