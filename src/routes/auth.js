const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { authLimiter } = require('../middleware/rate-limits');

const SESSION_DAYS = 7;

// Default-off: only set `Secure` when we explicitly know we're in production.
// Previously this was `NODE_ENV !== 'development'`, which silently dropped the
// cookie on any dev box reached over LAN HTTP (mobile testing) because
// NODE_ENV was usually unset => secure=true => browser refuses cookie on HTTP.
const SECURE_COOKIE = process.env.NODE_ENV === 'production';

function authRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.post('/api/auth/login', authLimiter, async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    try {
      const { rows } = await pool.query(
        'SELECT id, password, is_admin FROM users WHERE username = $1',
        [username]
      );

      if (rows.length === 0) {
        log.warn('auth', 'Login failed - unknown user', { username });
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = rows[0];
      const valid = await bcrypt.compare(password, user.password);

      if (!valid) {
        log.warn('auth', 'Login failed - bad password', { username });
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(
        Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000
      );

      await pool.query(
        'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
        [token, user.id, expiresAt]
      );

      res.cookie('session', token, {
        httpOnly: true,
        secure: SECURE_COOKIE,
        sameSite: 'lax',
        expires: expiresAt,
      });

      log.info('auth', 'Login successful', { userId: user.id, username });

      res.json({
        user: { id: user.id, username, isAdmin: user.is_admin },
      });
    } catch (err) {
      log.error('auth', 'Login error', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/auth/register', authLimiter, async (req, res) => {
    const { code, username, password } = req.body;

    if (!code?.trim() || !username?.trim() || !password) {
      return res.status(400).json({ error: 'Activation code, username, and password required' });
    }

    try {
      const { rows: codeRows } = await pool.query(
        'SELECT id FROM activation_codes WHERE code = $1 AND used_by IS NULL',
        [code.trim()]
      );

      if (codeRows.length === 0) {
        return res.status(400).json({ error: 'Invalid or already used activation code' });
      }

      const codeId = codeRows[0].id;
      const hash = await bcrypt.hash(password, 12);
      const { rows: userRows } = await pool.query(
        'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id',
        [username.trim(), hash]
      );

      const userId = userRows[0].id;
      await pool.query(
        'UPDATE activation_codes SET used_by = $1, used_at = NOW() WHERE id = $2',
        [userId, codeId]
      );

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
      await pool.query(
        'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
        [token, userId, expiresAt]
      );

      res.cookie('session', token, {
        httpOnly: true,
        secure: SECURE_COOKIE,
        sameSite: 'lax',
        expires: expiresAt,
      });

      log.info('auth', 'User registered', { userId, username: username.trim(), codeId });
      res.json({ user: { id: userId, username: username.trim(), isAdmin: false } });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Username already taken' });
      }
      log.error('auth', 'Registration error', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/auth/logout', async (req, res) => {
    const token = req.cookies?.session;
    if (token) {
      await pool.query('DELETE FROM sessions WHERE token = $1', [token]).catch(() => {});
      log.info('auth', 'Logout', { userId: req.user?.id });
    }
    res.clearCookie('session');
    res.json({ ok: true });
  });

  router.get('/api/auth/me', async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    // Include BYOK state (#30) so the settings modal can render
    // "sk-ant-…abcd" without decrypting anything — the last-4 is stored
    // in plaintext for display purposes only.
    let hasApiKey = false;
    let keyLast4 = null;
    let usernodePubkey = null;
    try {
      const { rows } = await pool.query(
        'SELECT anthropic_key_enc, anthropic_key_last4, usernode_pubkey FROM users WHERE id = $1',
        [req.user.id]
      );
      if (rows[0]?.anthropic_key_enc) {
        hasApiKey = true;
        keyLast4 = rows[0].anthropic_key_last4 || null;
      }
      usernodePubkey = rows[0]?.usernode_pubkey || null;
    } catch {}
    res.json({
      user: {
        id: req.user.id,
        username: req.user.username,
        isAdmin: req.user.isAdmin,
        hasApiKey,
        keyLast4,
        usernodePubkey,
        walletLinkEnabled: !!config.usernodeAppPubkey,
      },
    });
  });

  // #30 BYOK: set / replace the user's Anthropic key. We verify with a
  // cheap 1-token ping before persisting so we never save a key that
  // the Anthropic API would reject at runtime.
  router.post('/api/me/api-key', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { key } = req.body || {};
    if (typeof key !== 'string' || !key.trim()) {
      return res.status(400).json({ error: 'Key required' });
    }
    const clean = key.trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(clean)) {
      return res.status(400).json({ error: 'That doesn\'t look like a valid Anthropic API key.' });
    }

    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const test = new Anthropic({ apiKey: clean });
      await test.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
    } catch (err) {
      const msg = err?.status === 401 || err?.status === 403
        ? 'Anthropic rejected the key.'
        : `Couldn't verify the key (${err?.message || 'unknown error'}).`;
      return res.status(400).json({ error: msg });
    }

    const secrets = require('../services/secrets');
    const encrypted = secrets.encrypt(clean, config.jwtSecret);
    const last4 = clean.slice(-4);

    try {
      await pool.query(
        `UPDATE users SET anthropic_key_enc = $1, anthropic_key_last4 = $2 WHERE id = $3`,
        [encrypted, last4, req.user.id]
      );
      log.info('byok', 'API key saved', { userId: req.user.id });
      res.json({ ok: true, keyLast4: last4 });
    } catch (err) {
      log.error('byok', 'Failed to persist key', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/me/api-key', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      await pool.query(
        `UPDATE users SET anthropic_key_enc = NULL, anthropic_key_last4 = NULL WHERE id = $1`,
        [req.user.id]
      );
      log.info('byok', 'API key removed', { userId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('byok', 'Failed to remove key', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Wallet linking ───────────────────────────────────────────────
  const LINK_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

  router.post('/api/me/wallet-link', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!config.usernodeAppPubkey) {
      return res.status(503).json({ error: 'Wallet linking not configured' });
    }

    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);

    try {
      await pool.query(
        `UPDATE users SET wallet_link_token = $1, wallet_link_expires_at = $2 WHERE id = $3`,
        [token, expiresAt, req.user.id]
      );

      const memo = JSON.stringify({
        app: 'vibecode',
        type: 'link_wallet',
        token,
      });

      res.json({
        qr: {
          type: 'tx',
          to: config.usernodeAppPubkey,
          amount: 1,
          memo,
          confirmTitle: 'Link Wallet',
          confirmSubtitle: 'Link your Usernode wallet to your Social Vibecoding account.',
        },
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      log.error('wallet', 'Failed to generate link token', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/me/wallet-link/status', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const { rows } = await pool.query(
        'SELECT usernode_pubkey FROM users WHERE id = $1',
        [req.user.id]
      );
      const pubkey = rows[0]?.usernode_pubkey || null;
      res.json({ linked: !!pubkey, pubkey });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/me/wallet-link', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      await pool.query(
        `UPDATE users SET usernode_pubkey = NULL, wallet_link_token = NULL, wallet_link_expires_at = NULL WHERE id = $1`,
        [req.user.id]
      );
      log.info('wallet', 'Wallet unlinked', { userId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('wallet', 'Failed to unlink wallet', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { authRoutes };
