const { getPool } = require('../db/pool');
const log = require('../services/logger');

const PUBLIC_PATHS = [
  '/login.html',
  '/register.html',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/wallet-check',
  '/api/auth/wallet-verify',
  '/api/auth/wallet-register',
  '/api/auth/wallet-link-login',
  '/health',
  '/css/',
  '/js/',
  '/usernode-bridge.js',
];

function authMiddleware(config) {
  const pool = getPool(config);

  return async (req, res, next) => {
    if (PUBLIC_PATHS.some((p) => req.path.startsWith(p))) {
      return next();
    }

    const token = req.cookies?.session;
    if (!token) {
      return redirectOrReject(req, res);
    }

    try {
      const { rows } = await pool.query(
        `SELECT s.user_id, s.expires_at, u.username, u.is_admin
         FROM sessions s JOIN users u ON s.user_id = u.id
         WHERE s.token = $1`,
        [token]
      );

      if (rows.length === 0 || new Date(rows[0].expires_at) < new Date()) {
        if (rows.length > 0) {
          await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
        }
        res.clearCookie('session');
        return redirectOrReject(req, res);
      }

      req.user = {
        id: rows[0].user_id,
        username: rows[0].username,
        isAdmin: rows[0].is_admin,
      };

      log.debug('auth', 'Session validated', { userId: req.user.id });
      next();
    } catch (err) {
      log.error('auth', 'Session check failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

function redirectOrReject(req, res) {
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect('/login.html');
}

module.exports = { authMiddleware };
