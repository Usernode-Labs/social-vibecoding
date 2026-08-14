'use strict';

// Hosted MCP connector — throttle for the in-band "you can stop these
// permission prompts" setup tip.
//
// Its own module, and not inlined into services/mcp-tools.js, for the reason
// that module's header gives: no tool there touches the database directly,
// because a tool that did would be routing around the platform's own
// authorization. Every database read a tool needs goes through a service that
// owns that table — `whoami` reaches github-link the same way. This owns
// `mcp_connector_hints` and nothing else.
//
// Everything here is ADVISORY. The table gates no access, carries no user
// content, and a failed claim costs the caller a tip rather than a result.

const log = require('./logger');

// Lifetime cap per grant. Three is "the user saw it, and saw it again if they
// were busy the first time" — a fourth showing is nagging, and someone who
// has not acted by then has decided.
const MAX_SHOWS_PER_GRANT = 3;

// Claim the right to show the hint on THIS tool result.
//
// Returns true at most once per access token, at most MAX_SHOWS_PER_GRANT
// times per grant, ever. One atomic statement, so two reads racing on the
// same grant cannot both win it:
//
//   * no row yet         → insert with shown_count 1, claim granted
//   * same token as last → WHERE fails, no row returned, claim refused
//   * shown_count at cap → WHERE fails, claim refused
//
// Keyed on the GRANT rather than on an MCP session because /mcp is stateless
// (`sessionIdGenerator: undefined`, a fresh McpServer per HTTP request), so
// there is no session id to key on. The access token is the nearest stand-in
// for "this conversation" — it rotates roughly hourly — and the grant is the
// nearest stand-in for "this connection", surviving that rotation, which is
// what stops the tip returning every hour forever.
async function claimHintShow(pool, { grantId, userId, tokenId }) {
  if (!pool || !grantId || !userId) return false;
  try {
    const { rows } = await pool.query(
      `INSERT INTO mcp_connector_hints (grant_id, user_id, shown_count, last_token_id)
            VALUES ($1, $2, 1, $3)
       ON CONFLICT (grant_id) DO UPDATE
               SET shown_count = mcp_connector_hints.shown_count + 1,
                   last_token_id = EXCLUDED.last_token_id,
                   last_shown_at = NOW()
             WHERE mcp_connector_hints.shown_count < $4
               AND mcp_connector_hints.last_token_id IS DISTINCT FROM EXCLUDED.last_token_id
         RETURNING shown_count`,
      [String(grantId), userId, tokenId == null ? null : tokenId, MAX_SHOWS_PER_GRANT]
    );
    return rows.length > 0;
  } catch (err) {
    // Same posture as the last_used_at update at the /mcp edge: a working
    // read must not become an error because a tip could not be booked.
    log.warn('mcp-hint-throttle', 'hint claim failed', { err: err.message });
    return false;
  }
}

module.exports = { claimHintShow, MAX_SHOWS_PER_GRANT };
