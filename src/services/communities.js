// Communities: who a project belongs to, and who is in it.
//
// Every app belongs to exactly one community (apps.community_id; see the
// "Communities" block at the end of src/db/schema.sql). While the two are
// one-to-one — stage 0 of the community model — a community is shown as
// its only project: its name, its icon, its page. What this module adds is
// the part that is already a community's rather than an app's:
//
//   MEMBERSHIP. Joining is what lets a person TAKE PART: start a change,
//   propose it, file a request, vote (on proposals and on requests) and post
//   in the app's chat. The gates are below — requireAppMembership,
//   requireSessionMembership, requireIssueMembership and chatNeedsJoin for
//   the WebSocket — each mounted on the write route it guards. Reading and
//   using an app stay on its own view/collab visibility
//   (services/app-access.js), which this does not replace: the collab guard
//   still decides whether you may be here at all, and this decides whether
//   you have joined.
//
//   AUDIENCE. Who a community is for: 'solo' (Just you), 'invited' (Group)
//   or 'open' (Community). Derived from the app, never stored — see
//   audienceSql.
//
// The vote THRESHOLD counts active MEMBERS: services/active-users.js
// intersects its activity rule with this table, so the people a proposal
// needs votes from are the people who are allowed to cast them.

const log = require('./logger');
const appAccess = require('./app-access');

// The three audiences, in the order the Workshop lists them.
const AUDIENCES = Object.freeze(['open', 'invited', 'solo']);

// What each audience is called on screen. Internal names stay internal:
// "community" is the container, and people see it as one of these.
const AUDIENCE_LABELS = Object.freeze({
  open: 'Community',
  invited: 'Group',
  solo: 'Just you',
});

// The audience of the community `alias` (an `apps` row) belongs to, as a SQL
// expression. `members` is an expression for its member count.
//
//   view-public                           → 'open'   anyone can find and join it
//   private, with anyone beyond one person → 'invited' a member or a pending
//                                                    invite makes it a group
//   anything else                         → 'solo'
//
// A pending invite counts because the moment you invite someone is the
// moment you have decided the project is not just yours; waiting for them to
// accept before the label changed would read as the invite not having gone.
function audienceSql(alias, members) {
  return `CASE
    WHEN ${alias}.view_visibility = 'public' THEN 'open'
    WHEN COALESCE(${members}, 0) > 1
      OR EXISTS (SELECT 1 FROM app_collaborators ic
                  WHERE ic.app_id = ${alias}.id AND ic.status = 'invited') THEN 'invited'
    ELSE 'solo'
  END`;
}

async function isMember(pool, appId, userId) {
  if (!appId || !userId) return false;
  const { rows } = await pool.query(
    `SELECT 1
       FROM apps a
       JOIN community_members m ON m.community_id = a.community_id
      WHERE a.id = $1 AND m.user_id = $2`,
    [appId, userId]
  );
  return rows.length > 0;
}

// The viewer's standing in the app's community, as the community card and
// the Join button need it. `app` must carry `id`.
async function getMembership(pool, app, userId) {
  const { rows } = await pool.query(
    `SELECT a.community_id,
            (SELECT COUNT(*)::int FROM community_members m WHERE m.community_id = a.community_id)
              AS member_count,
            EXISTS (SELECT 1 FROM community_members m
                     WHERE m.community_id = a.community_id AND m.user_id = $2) AS is_member,
            ${audienceSql('a', '(SELECT COUNT(*) FROM community_members m WHERE m.community_id = a.community_id)')}
              AS audience,
            (a.created_by IS NOT NULL AND a.created_by = $2) AS is_creator
       FROM apps a
      WHERE a.id = $1`,
    [app.id, userId || null]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    community_id: row.community_id,
    member_count: row.member_count,
    is_member: !!row.is_member,
    is_creator: !!row.is_creator,
    audience: row.audience,
    audience_label: AUDIENCE_LABELS[row.audience] || AUDIENCE_LABELS.open,
  };
}

// Join the community `app` belongs to. Also pins the app to Home, which is
// what "Add" did before it was "Join": the directory's one-tap button keeps
// putting the app where you will find it again. The pin would join you by
// itself (the app_favorites trigger in schema.sql), but the membership row
// is written first and explicitly so it records 'joined' rather than
// 'favorite'.
async function join(pool, app, userId) {
  await pool.query(
    `INSERT INTO community_members (community_id, user_id, source)
       SELECT a.community_id, $2, 'joined' FROM apps a
        WHERE a.id = $1 AND a.community_id IS NOT NULL
     ON CONFLICT (community_id, user_id) DO NOTHING`,
    [app.id, userId]
  );
  await pool.query(
    `INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2)
     ON CONFLICT (app_id, user_id) DO UPDATE SET hidden = FALSE`,
    [app.id, userId]
  );
}

// Leave. One transaction, three rows: the membership, the collaborator row
// (on a private app that is your access — leaving it is the point, and the
// confirm says so), and the Home pin. The creator cannot leave: an app with
// no creator in its community would have nobody who can invite anyone back,
// which is a state no screen explains. Returns { ok } or { error, status }.
async function leave(pool, app, userId) {
  if (app.created_by && app.created_by === userId) {
    return { ok: false, status: 409, error: 'You started this project, so you can’t leave it.' };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM community_members m USING apps a
        WHERE a.id = $1 AND m.community_id = a.community_id AND m.user_id = $2`,
      [app.id, userId]
    );
    await client.query(
      'DELETE FROM app_collaborators WHERE app_id = $1 AND user_id = $2',
      [app.id, userId]
    );
    await client.query(
      'DELETE FROM app_favorites WHERE app_id = $1 AND user_id = $2',
      [app.id, userId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  // A private app's WS audience is its members; drop the cached answer so
  // the next broadcast stops reaching someone who just left.
  appAccess.invalidateVisibility(app.id, app.slug);
  return { ok: true };
}

// The refusal a non-member gets from a gated route. 403, not the 404 the
// visibility guards answer with: by the time this runs the app is one the
// caller may see, so there is nothing to hide, and the client needs the
// code to offer Join in place of a dead end.
function joinRequiredBody(app) {
  const name = app.name || app.slug || 'this project';
  return {
    error: `Join ${name} to take part: members start changes, file requests, vote and chat there.`,
    code: 'join_required',
    app: { slug: app.slug, name },
  };
}

// The columns every gate below reads, off an `apps` row aliased `a`, with
// `$2` the caller's user id.
const GATE_COLUMNS = `a.id, a.slug, a.name, a.community_id, a.collab_visibility, a.view_visibility,
                EXISTS (SELECT 1 FROM community_members m
                         WHERE m.community_id = a.community_id AND m.user_id = $2) AS is_member`;

// Whether `app` (a row carrying GATE_COLUMNS) should be refused with
// join_required for `user`. Only ever TRUE for someone who could otherwise
// take part — see the notes on requireSessionMembership (below) for the
// three ways it answers false.
async function refusesToJoin(pool, app, user) {
  if (!app || user?.isAdmin) return false;
  if (app.community_id == null || app.is_member) return false;
  return appAccess.checkAppAccess(pool, app, user, 'collab');
}

// The same gate as middleware over a resolved row, for the three route
// gates below, which differ only in how they find the app.
function gate(pool, findApp, what) {
  return async (req, res, next) => {
    if (req.user?.isAdmin) return next();
    try {
      const app = await findApp(req);
      if (await refusesToJoin(pool, app, req.user)) return res.status(403).json(joinRequiredBody(app));
      return next();
    } catch (err) {
      log.error('communities', `membership guard failed (${what})`, { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// For `/api/apps/:slug/...` write routes: starting a change, filing a
// request, importing a pull request, posting to the app's chat over HTTP.
// A slug that does not resolve falls through to the route's own 404.
function requireAppMembership(pool) {
  return gate(pool, async (req) => {
    if (!req.params.slug) return null;
    const { rows } = await pool.query(
      `SELECT ${GATE_COLUMNS} FROM apps a WHERE a.slug = $1`,
      [req.params.slug, req.user?.id || null]
    );
    return rows[0] || null;
  }, 'app');
}

// For `/api/issues/:id/...` write routes: voting on a request or a
// governance proposal.
function requireIssueMembership(pool) {
  return gate(pool, async (req) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return null;
    const { rows } = await pool.query(
      `SELECT ${GATE_COLUMNS} FROM issues i JOIN apps a ON a.id = i.app_id WHERE i.id = $1`,
      [id, req.user?.id || null]
    );
    return rows[0] || null;
  }, 'issue');
}

// The WebSocket chat write (src/services/ws.js, a 'chat' message). Returns
// the join_required body to send back to that one client, or null to let the
// message through. Only 'chat' is gated: typing indicators and reactions are
// not posting, and a Join prompt on a keystroke would be a trap.
async function chatNeedsJoin(pool, appId, user) {
  if (!appId || user?.isAdmin) return null;
  const { rows } = await pool.query(
    `SELECT ${GATE_COLUMNS} FROM apps a WHERE a.id = $1`,
    [appId, user?.id || null]
  );
  const app = rows[0];
  return (await refusesToJoin(pool, app, user)) ? joinRequiredBody(app) : null;
}

// For session-addressed routes (/api/sessions/:id/...): proposing, voting,
// cloning a headless run. The rules every gate here shares are stated once,
// on this one. Each answers only "has the caller joined": a caller without
// collab access falls through to whichever guard or route refuses them, so
// a gate is safe on either side of appAccess.sessionCollabGuard.
//
// Admins pass, as they pass every access check: they are who the
// screenshot and proposal-checks runners sign in as.
//
// FAILS OPEN on an app with no community. schema.sql gives every app one
// (a trigger on insert, a backfill for the rest), so this is a row caught
// between the two on its first boot — and refusing every vote on it would
// be a regression nobody asked for. A missing session falls through to the
// route's own 404, as the collab guard's does.
//
// And the third: someone who may not build here at all is the collab
// guard's to refuse, with its existence-hiding 404. Answering them with a
// 403 that names the app would disclose a private one — and the CLI handoff
// router mounts this ahead of the guard, so no gate here assumes the guard
// already ran.
function requireSessionMembership(pool) {
  return gate(pool, async (req) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return null;
    const { rows } = await pool.query(
      `SELECT ${GATE_COLUMNS}, cs.user_id AS session_user_id
         FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`,
      [id, req.user?.id || null]
    );
    const row = rows[0] || null;
    // The Homeroom bot proposing what it built on an app in its live list
    // (app-access.isBotOwnProposal): an admin's listing is its standing
    // there, not membership. Only a request carrying the marker is asked,
    // and for it there is no app to refuse.
    if (row && req.user?.[appAccess.HOMEROOM_BOT_PROPOSAL]
        && appAccess.isBotOwnProposal(req.user, row.session_user_id)) return null;
    return row;
  }, 'session');
}

// The members the community card shows by name: most recent first, capped.
// Names only — the roster with roles and invites is the Members & approvals
// dialog's, which this card opens.
async function listMembers(pool, appId, limit = 8) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, m.source, m.joined_at
       FROM apps a
       JOIN community_members m ON m.community_id = a.community_id
       JOIN users u ON u.id = m.user_id
      WHERE a.id = $1
      ORDER BY (m.source = 'creator') DESC, m.joined_at DESC, u.id
      LIMIT $2`,
    [appId, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    display_name: r.display_name || null,
    source: r.source,
  }));
}

// The community's channel — the app's general discussion (`chat_messages`
// with a null thread type) — as the community card's one row for it: the
// last thing said, by whom, and how many messages from others arrived since
// the viewer last read it. The same three facts, with the same exclusions
// (deleted messages, people the viewer has blocked), as the per-app rows
// src/routes/messages-overview.js used to put in the Messages list, which
// this row replaces. Unread is 0 without a read cursor, as it is there:
// a viewer who has never opened the channel has no "since".
async function channelSummary(pool, appId, userId) {
  const { rows: latest } = await pool.query(
    `SELECT m.content, m.created_at, u.username
       FROM chat_messages m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.app_id = $1
        AND m.thread_type IS NULL
        AND m.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks blocked
           WHERE blocked.blocker_id = $2 AND blocked.blocked_user_id = m.user_id
        )
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1`,
    [appId, userId || null]
  );
  const { rows: unread } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM chat_messages m
       JOIN app_chat_reads rc ON rc.app_id = m.app_id AND rc.user_id = $2
      WHERE m.app_id = $1
        AND m.thread_type IS NULL
        AND m.id > rc.last_read_message_id
        AND m.deleted_at IS NULL
        AND m.user_id IS NOT NULL AND m.user_id <> $2
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks blocked
           WHERE blocked.blocker_id = $2 AND blocked.blocked_user_id = m.user_id
        )`,
    [appId, userId || null]
  );
  const last = latest[0] || null;
  return {
    last_message: last ? last.content : null,
    last_at: last ? last.created_at : null,
    last_by: last ? last.username || null : null,
    unread_count: unread[0]?.n || 0,
  };
}

module.exports = {
  channelSummary,
  AUDIENCES,
  AUDIENCE_LABELS,
  audienceSql,
  isMember,
  getMembership,
  join,
  leave,
  joinRequiredBody,
  requireAppMembership,
  requireSessionMembership,
  requireIssueMembership,
  chatNeedsJoin,
  listMembers,
};
