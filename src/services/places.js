'use strict';

// A project's PLACES (#4417): the list a project's page is navigated by —
// Hub, Needs you and Workshop, then its channels: #general first, then each
// of its topics.
//
// A topic is a lasting conversation about one part of the project, with the
// requests about that part filed under it. On screen and in dapp.json it is
// a "topic"; in here it is what the code has always called a CATEGORY — an
// app_category_registry row, with origin 'topic' — because "topic" already
// names one request or proposal in this codebase (topic_attribute_votes,
// services/topic-attributes.js). Its channel is a chat_messages thread of
// type 'category' (services/app-chat.js), whose ref is the row's id.
//
// This module reads them: the rows, a channel by its handle or an old one,
// and the `places` block GET /api/apps/:slug/community serves. Nothing here
// writes a topic: dapp.json is the only writer (app-manifest.js
// reconcileAppTopics), and a change to it is a proposal (topics-pr.js).

const appChat = require('./app-chat');
const log = require('./logger');
const topicFigures = require('./topic-figures');

const TOPIC_COLUMNS = `id, category_key, label, description, icon, topic_handle, topic_aliases,
                       topic_state, merged_into, merged_at, topic_order, topic_figures`;

/** A topic row as the client reads it. */
function shapeTopic(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    key: row.category_key,
    handle: row.topic_handle || row.category_key,
    aliases: Array.isArray(row.topic_aliases) ? row.topic_aliases.filter(Boolean) : [],
    name: row.label || row.category_key,
    about: row.description || '',
    icon: row.icon || '',
    state: row.topic_state || 'live',
    merged_into: row.topic_state === 'merged' ? row.merged_into || null : null,
    merged_at: row.topic_state === 'merged' && row.merged_at ? new Date(row.merged_at).toISOString() : null,
    order: row.topic_order == null ? null : Number(row.topic_order),
    // The figures its channel shows above the room (services/topic-figures.js).
    figures: topicFigures.knownFigureIds(row.topic_figures),
  };
}

/** Every topic of `appId`, retired ones included, in dapp.json's order. */
async function topicRows(pool, appId) {
  if (!appId) return [];
  const { rows } = await pool.query(
    `SELECT ${TOPIC_COLUMNS}
       FROM app_category_registry
      WHERE app_id = $1 AND origin = 'topic'
      ORDER BY topic_order ASC NULLS LAST, id ASC`,
    [appId]
  );
  return rows;
}

/** One topic of `appId` by its row id (a 'category' thread's ref), or null. */
async function findTopic(pool, appId, id) {
  const ref = appChat.positiveInt(id);
  if (!ref || !appId) return null;
  const { rows } = await pool.query(
    `SELECT ${TOPIC_COLUMNS}
       FROM app_category_registry
      WHERE id = $1 AND app_id = $2 AND origin = 'topic'`,
    [ref, appId]
  );
  return rows[0] || null;
}

/**
 * The topic a `#handle` names in one project: its handle now, or one it had
 * before a rename (`topic_aliases`), so an old link keeps working. Null for
 * none, and for `general`, which is the project's own channel.
 */
async function resolveTopicHandle(pool, appId, raw) {
  const handle = String(raw || '').trim().replace(/^#/, '').toLowerCase();
  if (!appId || !handle || handle === 'general' || !/^[a-z][a-z0-9-]{0,39}$/.test(handle)) return null;
  const { rows } = await pool.query(
    `SELECT ${TOPIC_COLUMNS}
       FROM app_category_registry
      WHERE app_id = $1 AND origin = 'topic'
        AND (topic_handle = $2 OR $2 = ANY(topic_aliases))
      ORDER BY (topic_handle = $2) DESC, (topic_state = 'live') DESC, id ASC
      LIMIT 1`,
    [appId, handle]
  );
  return rows[0] || null;
}

// A board key ('issue:12', 'session:4', 'gov:9') as the vote target it is.
function targetKey(card) {
  const [kind, raw] = String(card || '').split(':');
  const ref = Number(raw);
  if (!Number.isInteger(ref) || ref <= 0) return null;
  if (kind === 'issue') return `issue:${ref}`;
  if (kind === 'session' || kind === 'gov') return `proposal:${ref}`;
  return null;
}

/**
 * How many REQUESTS each topic holds: the open requests on the board (the
 * Workshop's snapshot: its placements and the cards its placer declined)
 * whose category is the topic — the group's vote where there is one, the
 * Workshop's placement where not, the same order of precedence All items
 * groups by. Before the Workshop has a row (no model, or a first view still
 * to come), the requests the group has voted into it. Map<key, n>.
 */
async function topicRequestCounts(pool, appId, keys) {
  const out = new Map((keys || []).map((k) => [k, 0]));
  if (!appId || !out.size) return out;
  const { rows: board } = await pool.query(
    `SELECT placements_json, unplaced_json FROM app_workshop_themes WHERE app_id = $1`,
    [appId]
  );
  const { rows: voted } = await pool.query(
    `SELECT DISTINCT ON (target_type, target_ref) target_type, target_ref, value
       FROM (
         SELECT target_type, target_ref, value, COUNT(*) AS n, MIN(created_at) AS first_at
           FROM topic_attribute_votes
          WHERE app_id = $1 AND field = 'category'
            AND value NOT IN (SELECT category_key FROM app_category_registry
                               WHERE app_id = $1 AND origin = 'topic'
                                 AND topic_state IN ('archived', 'merged'))
          GROUP BY target_type, target_ref, value
       ) tally
      ORDER BY target_type, target_ref, n DESC, first_at ASC, value ASC`,
    [appId]
  );
  const vote = new Map(voted.map((v) => [`${v.target_type}:${v.target_ref}`, v.value]));
  const row = board[0];
  if (row) {
    const placements = row.placements_json && typeof row.placements_json === 'object' ? row.placements_json : {};
    const cards = new Set([...Object.keys(placements), ...(Array.isArray(row.unplaced_json) ? row.unplaced_json : [])]);
    for (const card of cards) {
      if (!String(card).startsWith('issue:')) continue;
      const category = vote.get(targetKey(card)) || placements[card] || null;
      if (category && out.has(category)) out.set(category, out.get(category) + 1);
    }
    return out;
  }
  for (const [target, category] of vote) {
    if (target.startsWith('issue:') && out.has(category)) out.set(category, out.get(category) + 1);
  }
  return out;
}

/**
 * The `places` block of GET /api/apps/:slug/community: the votes waiting on
 * the viewer here, and every channel — #general first, then each topic in
 * dapp.json's order, retired ones included and marked so (the list draws the
 * live ones; a retired channel stays readable, and a merge draws its card in
 * the channel it joined). `general` is the community card's own channel row
 * (or null when the viewer has none); `member` says whether to keep read
 * cursors for them.
 *
 *   { owed, channels: [{ id, kind, key, handle, aliases, name, about, icon,
 *                        state, merged_into, merged_at, requests, unread,
 *                        figures }] }
 *
 * Best-effort per part: a count that fails to read is null, never a failed
 * page.
 */
async function placesFor(pool, app, viewer, { general = null, member = false, showSelfHosted = false } = {}) {
  const viewerId = viewer && viewer.id ? viewer.id : null;
  let owed = null;
  if (viewerId && member) {
    try {
      const { owedByCommunity } = require('../routes/workshop-overview');
      const mine = await owedByCommunity(pool, viewerId, { showSelfHosted, isAdmin: !!(viewer && viewer.isAdmin) });
      owed = (mine.find((w) => w.slug === app.slug) || { waiting: 0 }).waiting;
    } catch (err) {
      log.warn('places', 'Could not count the votes owed', { slug: app.slug, message: err.message });
    }
  }
  const rows = await topicRows(pool, app.id);
  const topics = rows.map(shapeTopic);
  const live = topics.filter((t) => t.state === 'live');
  let requests = new Map();
  try {
    requests = await topicRequestCounts(pool, app.id, live.map((t) => t.key));
  } catch (err) {
    log.warn('places', 'Could not count the requests per topic', { slug: app.slug, message: err.message });
  }
  let unread = new Map();
  if (viewerId && member && topics.length) {
    try {
      await appChat.ensureCategoryReadCursors(pool, app.id, viewerId, live.map((t) => t.id));
      unread = await appChat.categoryUnreadCounts(pool, app.id, viewerId, topics.map((t) => t.id));
    } catch (err) {
      log.warn('places', 'Could not read the topic channels\' unread', { slug: app.slug, message: err.message });
    }
  }
  const channels = [];
  if (general) {
    channels.push({
      id: null,
      kind: 'general',
      key: null,
      handle: 'general',
      aliases: [],
      name: 'general',
      about: '',
      icon: '',
      state: 'live',
      merged_into: null,
      merged_at: null,
      requests: null,
      unread: Number(general.unread_count) || 0,
      figures: [],
    });
  }
  for (const t of topics) {
    channels.push({
      ...t,
      kind: 'topic',
      requests: t.state === 'live' ? (requests.get(t.key) ?? 0) : null,
      unread: t.state === 'live' ? (unread.get(t.id) || 0) : 0,
    });
  }
  return { owed, channels };
}

module.exports = {
  shapeTopic,
  topicRows,
  findTopic,
  resolveTopicHandle,
  topicRequestCounts,
  placesFor,
};
