'use strict';

/**
 * #4417: TOPICS CHANGE BY PROPOSAL.
 *
 * A project's topics live in its dapp.json (`topics`, services/app-manifest.js
 * validateTopics), so a new topic, a rename, a merge or an archive is a pull
 * request on that file, dropped straight into the vote panel as a promoted
 * session — the same lifecycle as a rename or a visibility change, through
 * the same core (services/rename-pr.js createManifestPR). When it merges, the
 * rebuild it triggers runs reconcileAppTopics (for the platform's own app,
 * the post-deploy boot does), and only then does the topic change.
 *
 *   add      { op: 'add', name, handle?, about?, icon? }
 *            the id is the handle, set once: it is the category key.
 *   rename   { op: 'rename', id, name?, handle?, about?, icon? }
 *            any of the four; a changed handle keeps the old one working.
 *   merge    { op: 'merge', id, into }
 *            the topic's votes and placements move to `into`.
 *   archive  { op: 'archive', id }
 *            read-only from then on, its history kept.
 *
 * No timer exemption and no explicit-approval stamp: a topic is how the
 * group organises its own talk, not a protected block. The project's
 * approval rule decides, as for any change.
 *
 * The route (POST /api/apps/:slug/topics-pr) owns the gates — drainGuard,
 * issueCreateLimiter, membership, collab access, GitHub configured. This
 * module owns the edit: applyTopicChange is pure, and it validates the
 * array it produces with the same validator the deploy reads, so a PR that
 * could not apply is never opened.
 */

const appManifest = require('./app-manifest');
const renamePr = require('./rename-pr');

const OPS = Object.freeze(['add', 'rename', 'merge', 'archive']);

class TopicsPrError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TopicsPrError';
    this.status = status;
  }
}

function clean(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** A handle typed in the dialog (`#Release notes` → `release-notes`). */
function handleFrom(raw) {
  return String(raw || '').trim().replace(/^#/, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
}

/**
 * Validate a request body into one change, or throw TopicsPrError. Only the
 * fields the op takes are kept.
 */
function parseChange(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const op = typeof b.op === 'string' ? b.op : '';
  if (!OPS.includes(op)) throw new TopicsPrError('op must be one of add, rename, merge or archive');
  const pick = (k) => (b[k] == null ? undefined : (typeof b[k] === 'string' ? b[k] : null));
  const out = { op };
  for (const k of ['id', 'into', 'name', 'handle', 'about', 'icon']) {
    const v = pick(k);
    if (v === null) throw new TopicsPrError(`${k} must be a string`);
    if (v !== undefined) out[k] = v;
  }
  if (op === 'add' && !clean(out.name)) throw new TopicsPrError('A new topic needs a name');
  if (op !== 'add' && !clean(out.id)) throw new TopicsPrError('Name the topic to change (id)');
  if (op === 'merge' && !clean(out.into)) throw new TopicsPrError('Name the topic to merge into (into)');
  if (op === 'rename' && ['name', 'handle', 'about', 'icon'].every((k) => out[k] === undefined)) {
    throw new TopicsPrError('A rename changes the name, the channel, what it is for or the icon');
  }
  return out;
}

/**
 * Pure. Apply one change to a dapp.json object's `topics`. `aliases` maps a
 * handle the project's topics HAD (topic_aliases) to the topic id it belongs
 * to, so a new or renamed handle cannot take an old link from another topic.
 * Returns `{ topics, title, summary }` — the whole new array, the PR's title
 * and one line for its body and the vote message — or throws TopicsPrError.
 */
function applyTopicChange(manifest, change, { aliases = {} } = {}) {
  const current = Array.isArray(manifest && manifest.topics)
    ? manifest.topics.map((t) => (t && typeof t === 'object' && !Array.isArray(t) ? { ...t } : t))
    : [];
  const entries = current.filter((t) => t && typeof t === 'object');
  const find = (id) => entries.find((t) => t.id === id) || null;
  const handleOf = (t) => (typeof t.handle === 'string' && t.handle ? t.handle : t.id);
  const stateOf = (t) => (t.mergedInto ? 'merged' : (t.archived === true ? 'archived' : 'live'));
  const live = (id) => {
    const t = find(id);
    if (!t) throw new TopicsPrError(`There is no topic "${id}"`, 404);
    if (stateOf(t) !== 'live') throw new TopicsPrError(`#${handleOf(t)} is ${stateOf(t)} already`, 409);
    return t;
  };
  const handleTaken = (handle, exceptId = null) => entries.some((t) => t.id !== exceptId && (handleOf(t) === handle || t.id === handle))
    || (aliases[handle] && aliases[handle] !== exceptId);

  let title;
  let summary;
  const op = change.op;
  if (op === 'add') {
    const name = clean(change.name);
    const handle = handleFrom(change.handle || name);
    const normalized = appManifest.normalizeTopicHandle(handle);
    if (!normalized) {
      throw new TopicsPrError('The channel name must be 2 to 32 lowercase letters, digits and hyphens, starting with a letter, and not "general"');
    }
    if (handleTaken(normalized)) throw new TopicsPrError(`#${normalized} is taken in this project`, 409);
    const entry = { id: normalized, handle: normalized, name };
    if (clean(change.icon)) entry.icon = clean(change.icon);
    if (clean(change.about)) entry.about = clean(change.about);
    current.push(entry);
    title = `New topic #${normalized}`;
    summary = `adds the topic "${name}" (#${normalized})`;
  } else if (op === 'rename') {
    const t = live(clean(change.id));
    const before = handleOf(t);
    const parts = [];
    if (change.name !== undefined && clean(change.name) !== t.name) {
      t.name = clean(change.name);
      parts.push(`names it "${t.name}"`);
    }
    if (change.handle !== undefined) {
      const normalized = appManifest.normalizeTopicHandle(handleFrom(change.handle));
      if (!normalized) {
        throw new TopicsPrError('The channel name must be 2 to 32 lowercase letters, digits and hyphens, starting with a letter, and not "general"');
      }
      if (normalized !== before) {
        if (handleTaken(normalized, t.id)) throw new TopicsPrError(`#${normalized} is taken in this project`, 409);
        t.handle = normalized;
        parts.push(`moves its channel to #${normalized} (#${before} keeps working)`);
      }
    }
    if (change.about !== undefined && clean(change.about) !== (t.about || '')) {
      if (clean(change.about)) t.about = clean(change.about); else delete t.about;
      parts.push('rewrites what it is for');
    }
    if (change.icon !== undefined && clean(change.icon) !== (t.icon || '')) {
      if (clean(change.icon)) t.icon = clean(change.icon); else delete t.icon;
      parts.push('changes its icon');
    }
    if (!parts.length) throw new TopicsPrError('That is how the topic is already');
    title = t.handle !== before ? `Rename #${before} to #${t.handle}` : `Rename topic #${before}`;
    summary = `${parts.join(', ')} for #${before}`;
  } else if (op === 'merge') {
    const t = live(clean(change.id));
    const into = live(clean(change.into));
    if (t.id === into.id) throw new TopicsPrError('A topic cannot be merged into itself');
    t.mergedInto = into.id;
    delete t.archived;
    title = `Merge #${handleOf(t)} into #${handleOf(into)}`;
    summary = `merges #${handleOf(t)} into #${handleOf(into)}: its requests move there, and its channel stays readable`;
  } else if (op === 'archive') {
    const t = live(clean(change.id));
    t.archived = true;
    title = `Archive #${handleOf(t)}`;
    summary = `archives #${handleOf(t)}: its channel stays readable and takes no new messages`;
  } else {
    throw new TopicsPrError('op must be one of add, rename, merge or archive');
  }

  const { errors } = appManifest.validateTopics(current);
  if (errors.length) throw new TopicsPrError(errors[0]);
  return { topics: current, title, summary };
}

/** The handles the project's topics had before (topic_aliases), by alias. */
async function aliasMap(pool, appId) {
  const { rows } = await pool.query(
    `SELECT category_key, topic_aliases FROM app_category_registry
      WHERE app_id = $1 AND origin = 'topic'`,
    [appId]
  );
  const out = {};
  for (const r of rows) for (const a of (r.topic_aliases || [])) out[a] = r.category_key;
  return out;
}

/**
 * Open the topics PR for `app`: edit dapp.json's `topics` on a branch, open
 * the PR, and drop it into the vote panel as a promoted session. The edit is
 * made against main's dapp.json as it is now, and refused (TopicsPrError,
 * before anything is written to GitHub) if it would not apply. Resolves
 * `{ sessionId, prNumber, prUrl, branch, title }`.
 */
async function createTopicsPR(config, pool, app, change, actor) {
  const aliases = await aliasMap(pool, app.id);
  let applied = null;
  const opts = {
    mutate: (m) => {
      applied = applyTopicChange(m, change, { aliases });
      m.topics = applied.topics;
    },
    branchPrefix: 'topics',
    // Read after `mutate`, which is when the title is known: it names the
    // topics as main's dapp.json has them.
    get commitMessage() { return applied ? applied.title : 'Change topics'; },
    get prTitle() { return applied ? applied.title : 'Change topics'; },
    get prBody() {
      return `${actor.username} (via Homeroom) proposed a change to "${app.name}"'s topics: it ${applied ? applied.summary : 'changes them'}.\n\n`
        + 'This PR updates the `topics` array in `dapp.json`. A topic is a lasting conversation about one part of the '
        + 'project, a channel and a category at once. It still needs a regular merge vote to land, and applies '
        + 'automatically once the PR merges and the app redeploys.';
    },
    chatText: (prData, majority, activeUsers) =>
      `${actor.username} proposed: ${applied ? applied.title : 'a change to the topics'}. Opened PR #${prData.number}, which needs ${majority}/${activeUsers} votes to land.`,
    eventMetadata: { topics: change.op },
  };
  const result = await renamePr.createManifestPR(config, pool, app, actor, opts);
  return { ...result, title: applied ? applied.title : null };
}

/** The topics PRs waiting for a vote on `appId`, newest first. */
async function openTopicsPrs(pool, appId) {
  const { rows } = await pool.query(
    `SELECT id, pr_number, pr_url, pr_title FROM chat_sessions
      WHERE app_id = $1 AND status IN ('promoted', 'merging')
        AND branch_name LIKE 'topics/%'
      ORDER BY id DESC
      LIMIT 10`,
    [appId]
  );
  return rows.map((r) => ({
    session_id: Number(r.id), pr_number: r.pr_number || null, pr_url: r.pr_url || null, title: r.pr_title || null,
  }));
}

module.exports = {
  OPS,
  TopicsPrError,
  handleFrom,
  parseChange,
  applyTopicChange,
  createTopicsPR,
  openTopicsPrs,
};
