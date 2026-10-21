'use strict';

// What this tier list would share with a Homeroom-wide tier list, if the
// group ever decides to: how many people put each item in each tier, and
// nothing about who.
//
//   GET /usernode/rankings-export   the counts, as JSON
//
// SHARE_RANKINGS below is the group's decision, and it is OFF. Turning it on
// is a one-line change, so it goes to the group's vote like any other. While
// it is off, the endpoint answers 403 `not_shared` and reads nothing.
//
// Only Homeroom can call it, and today Homeroom never does. The request
// carries a platform token in the `x-usernode-platform-token` header, signed
// with the same key as a person's sign-in token (verified with
// USERNODE_JWT_PUBLIC_KEY), for this app's audience, with `pur`
// 'rankings-export'. Anything else is refused.
//
// WHAT IT SENDS: each item's name, how many people put it in each tier and
// how many want to (W), and how many people have ranked anything. Never a
// user id, a username, or who added an item. A person who deletes their
// account takes their tiers with them (usernode-user-data.js), so the next
// export no longer counts them.
//
// It came from Homeroom's ready-made tier list, with api.js. If you change
// the tables in api.js, keep this file reading them; if you remove them,
// remove this file and its mount in api.js.

const jwt = require('jsonwebtoken');

// The group's decision. Off until the group votes to turn it on.
const SHARE_RANKINGS = false;

const EXPORT_PATH = '/usernode/rankings-export';
const TOKEN_HEADER = 'x-usernode-platform-token';
const PURPOSE = 'rankings-export';
// The shape of what it sends. A change to the shape is a new number, so
// whatever reads it can tell the copies apart.
const VERSION = 1;
const ITEMS_MAX = 1000;

// The tiers, best first, as api.js has them; W (Want to) is counted apart.
const TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];

/** Whether the request carries a platform token for this app and this purpose. */
function verifyPlatformRequest(req, { publicKey, audience }) {
  const token = req.get(TOKEN_HEADER);
  if (!token || !publicKey || !audience) return false;
  try {
    const claims = jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: 'usernode', audience });
    return !!claims && claims.pur === PURPOSE;
  } catch {
    return false;
  }
}

async function exportRankings(pool) {
  const { rows } = await pool.query(
    `SELECT i.name,
            ${TIERS.map((t) => `COUNT(v.user_id) FILTER (WHERE v.tier = '${t}')::int AS "${t}"`).join(',\n            ')},
            COUNT(v.user_id) FILTER (WHERE v.tier = 'W')::int AS wants
       FROM tier_items i
       LEFT JOIN tier_votes v ON v.item_id = i.id
      GROUP BY i.id
      ORDER BY i.id
      LIMIT $1`,
    [ITEMS_MAX + 1]
  );
  const { rows: people } = await pool.query("SELECT COUNT(DISTINCT user_id)::int AS n FROM tier_votes WHERE tier <> 'W'");
  return {
    version: VERSION,
    tiers: TIERS,
    people: people[0].n,
    items: rows.slice(0, ITEMS_MAX).map((r) => ({
      name: r.name,
      tiers: Object.fromEntries(TIERS.map((t) => [t, r[t]])),
      wants: r.wants,
    })),
    truncated: rows.length > ITEMS_MAX,
  };
}

// Mounted from api.js. A GET outside /api/ passes server.js's sign-in check
// untouched; this request carries no person's token, only the platform's
// own, verified here before anything else.
function mount(app, pool, {
  publicKey = (process.env.USERNODE_JWT_PUBLIC_KEY || '').replace(/\\n/g, '\n'),
  audience = process.env.USERNODE_APP_ID ? 'usernode:app:' + process.env.USERNODE_APP_ID : null,
  share = SHARE_RANKINGS,
} = {}) {
  app.get(EXPORT_PATH, async (req, res) => {
    if (!verifyPlatformRequest(req, { publicKey, audience })) return res.status(403).json({ error: 'platform_token_required' });
    if (!share) return res.status(403).json({ error: 'not_shared' });
    try {
      res.json(await exportRankings(pool));
    } catch (err) {
      console.error('rankings export failed: ' + err.message);
      res.status(500).json({ error: 'export_failed' });
    }
  });
}

module.exports = { SHARE_RANKINGS, VERSION, mount, exportRankings, verifyPlatformRequest };
