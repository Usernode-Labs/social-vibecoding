const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

const PUBLIC_PATHS = [
  '/login.html',
  '/register.html',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/wallet-check',
  '/api/auth/wallet-verify',
  // Self-service wallet password reset is pre-login by definition — the
  // wallet signature is the only credential (issue #282).
  '/api/auth/wallet-reset-verify',
  '/api/auth/wallet-register',
  '/api/auth/wallet-link-login',
  // Read-only kudos leaderboard (Top PRs / Top users). Public so the
  // board can be linked/embedded without a session; no private data is
  // exposed (usernames + public PR titles + aggregate counts only).
  '/api/leaderboard/',
  // Read-only public apps + contributors API (src/routes/public-api.js).
  // Public so outside integrations can list the platform's view-public
  // apps and who built them without an account; view-private apps and the
  // self-app are never surfaced. Same privacy tier as the leaderboard.
  '/api/public/',
  '/health',
  '/css/',
  '/js/',
  '/usernode-bridge.js',
  '/usernode-bridge/',
];

// SELF-HOSTING.md "Self-staging — iframe-auth login flow":
// In a staging container spawned for the self-app (USERNODE_ENV === 'staging'),
// the cloned users table has every prod row but with `password` scrubbed to
// the literal sentinel `__staging_redacted__` by db-manager.scrubPrivateColumns
// — so no cloned account can authenticate against /api/auth/login. Rather than
// copying password hashes across the prod/staging boundary, we accept the same
// platform-issued JWT every child app already verifies (see app-conventions.md
// "Auth — iframe token injection") and exchange it for a real session row on
// first hit. The trust chain is: parent prod admin authenticates via cookie →
// parent mints a 1h JWT signed with config.jwtSecret via /api/iframe-token →
// app-view.js sets `iframe.src = stagingUrl + '?token=' + jwt` → this
// middleware verifies + mints a local session cookie. Subsequent fetches
// inside the iframe use the cookie like any prod request.
//
// Gated entirely on USERNODE_ENV === 'staging'. Production never reads the
// query token, so a stolen iframe-token can't be replayed against prod (it's
// a downgraded credential that only works against staging clones).
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const STAGING_SESSION_DAYS = 7;
const SECURE_COOKIE = process.env.NODE_ENV === 'production';

function authMiddleware(config) {
  const pool = getPool(config);

  return async (req, res, next) => {
    if (PUBLIC_PATHS.some((p) => req.path.startsWith(p))) {
      return next();
    }

    const cookieToken = req.cookies?.session;

    // Cookie path — identical in prod and staging once a session exists.
    if (cookieToken) {
      try {
        const { rows } = await pool.query(
          `SELECT s.user_id, s.expires_at, u.username, u.is_admin, u.admin_readonly, u.app_quota, u.ai_progress_estimate
           FROM sessions s JOIN users u ON s.user_id = u.id
           WHERE s.token = $1`,
          [cookieToken]
        );

        if (rows.length > 0 && new Date(rows[0].expires_at) >= new Date()) {
          req.user = {
            id: rows[0].user_id,
            username: rows[0].username,
            isAdmin: rows[0].is_admin,
            // View-only admin marker + derived write capability (issue
            // #311). `isAdmin` still gates every read/visibility check;
            // `canAdminWrite` is the single gate for privileged mutations
            // (a full admin only — view-only admins get FALSE).
            adminReadonly: !!rows[0].admin_readonly,
            canAdminWrite: !!rows[0].is_admin && !rows[0].admin_readonly,
            // Per-user app-creation quota (see users.app_quota in
            // schema.sql). The POST /api/apps gate compares this to the
            // user's live app count; admins bypass it. The derived
            // `canCreateApps` boolean the client reads is computed in
            // auth/me from this plus a live count.
            appQuota: rows[0].app_quota ?? 0,
            // Experimental per-user opt-in (default FALSE) — read by
            // runClaudeCodeTool to gate the Haiku progress estimator.
            aiProgressEstimate: !!rows[0].ai_progress_estimate,
          };
          log.debug('auth', 'Session validated', { userId: req.user.id });
          return next();
        }

        // Stale or unknown cookie — drop it before deciding whether to
        // redirect. In staging we still want to fall through to the
        // iframe-token path; in prod this just becomes the "no auth" case.
        if (rows.length > 0) {
          await pool.query('DELETE FROM sessions WHERE token = $1', [cookieToken]);
        }
        res.clearCookie('session');
      } catch (err) {
        log.error('auth', 'Session check failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    // Iframe-JWT path — staging only. See block comment above.
    if (IS_STAGING) {
      const queryToken = typeof req.query?.token === 'string' ? req.query.token : null;
      const headerToken = req.headers['x-usernode-token'];
      const jwtToken = queryToken || (typeof headerToken === 'string' ? headerToken : null);
      if (jwtToken) {
        const minted = await tryMintSessionFromIframeJwt(pool, config, jwtToken, res);
        if (minted) {
          req.user = minted;
          log.debug('auth', 'Staging iframe-JWT auth succeeded', { userId: minted.id });
          return next();
        }
      }
    }

    return redirectOrReject(req, res);
  };
}

// Verify the parent-issued JWT, look up the matching user in the local
// (cloned) users table, mint a session row + set the cookie. Returns the
// resolved req.user shape on success, null on any failure (caller falls
// through to redirectOrReject).
async function tryMintSessionFromIframeJwt(pool, config, jwtToken, res) {
  let payload;
  try {
    payload = jwt.verify(jwtToken, config.jwtSecret);
  } catch (err) {
    log.warn('auth', 'Staging iframe-JWT verification failed', { err: err.message });
    return null;
  }

  if (!payload || typeof payload !== 'object' || typeof payload.id !== 'number') {
    log.warn('auth', 'Staging iframe-JWT payload missing required fields');
    return null;
  }

  // The cloned users table preserves row identity (id, username, is_admin)
  // and only column-scrubs password / api keys / wallet tokens, so we can
  // resolve is_admin from the local DB. Username match is defense-in-depth
  // against a token whose id was renumbered between clone and now.
  let userRow;
  try {
    const { rows } = await pool.query(
      'SELECT id, username, is_admin, admin_readonly, app_quota, ai_progress_estimate FROM users WHERE id = $1',
      [payload.id]
    );
    userRow = rows[0];
  } catch (err) {
    log.error('auth', 'Staging iframe-JWT user lookup failed', { err: err.message });
    return null;
  }

  if (!userRow) {
    log.warn('auth', 'Staging iframe-JWT references unknown user', { id: payload.id });
    return null;
  }
  if (typeof payload.username === 'string' && payload.username !== userRow.username) {
    // Token issued for a user whose username changed since the clone. Refuse
    // — the parent's cookie must re-issue against the current state.
    log.warn('auth', 'Staging iframe-JWT username mismatch', {
      tokenUsername: payload.username, dbUsername: userRow.username,
    });
    return null;
  }

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + STAGING_SESSION_DAYS * 24 * 60 * 60 * 1000);
  try {
    await pool.query(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
      [sessionToken, userRow.id, expiresAt]
    );
  } catch (err) {
    log.error('auth', 'Staging iframe-JWT session insert failed', { err: err.message });
    return null;
  }

  res.cookie('session', sessionToken, {
    httpOnly: true,
    secure: SECURE_COOKIE,
    sameSite: 'lax',
    expires: expiresAt,
  });

  log.info('auth', 'Staging iframe-JWT minted local session', {
    userId: userRow.id, username: userRow.username,
  });

  return {
    id: userRow.id,
    username: userRow.username,
    isAdmin: userRow.is_admin,
    adminReadonly: !!userRow.admin_readonly,
    canAdminWrite: !!userRow.is_admin && !userRow.admin_readonly,
    appQuota: userRow.app_quota ?? 0,
    aiProgressEstimate: !!userRow.ai_progress_estimate,
  };
}

function redirectOrReject(req, res) {
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect('/login.html');
}

module.exports = { authMiddleware };
