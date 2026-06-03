const crypto = require('crypto');
const bcrypt = require('bcrypt');
const https = require('https');
const http = require('http');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { authLimiter, walletCheckLimiter } = require('../middleware/rate-limits');
const genesisAccounts = require('../services/genesis-accounts');
const events = require('../services/events');

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
      events.record(pool, { type: events.EVENT_TYPES.USER_SIGNED_UP, userId, metadata: { via: 'activation_code' } });
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
        // Per-user app-creation gate (admin-controlled, default FALSE).
        // The home screen hides the "Create new app" affordance for
        // anyone who can't create — admins implicitly can, see the
        // canCreate helper in public/js/home.js.
        canCreateApps: !!req.user.canCreateApps,
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
        model: 'claude-haiku-4-5',
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

  // ── Wallet-based authentication ───────────────────────────────────
  const CHALLENGE_TTL_MS = 2 * 60 * 1000;
  const walletChallenges = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of walletChallenges) {
      if (now > entry.expiresAt) walletChallenges.delete(key);
    }
  }, 30_000);

  function httpJson(method, urlStr, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const mod = url.protocol === 'https:' ? https : http;
      const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = mod.request(url, {
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(bodyBuf ? { 'content-length': bodyBuf.length } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 500) || '(empty body)'}`));
          }
          try { resolve(JSON.parse(text)); }
          catch (e) { reject(new Error(`JSON parse: ${e.message} — raw: ${text.slice(0, 200)}`)); }
        });
      });
      req.on('error', reject);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  function createSessionCookie(res, token, expiresAt) {
    res.cookie('session', token, {
      httpOnly: true,
      secure: SECURE_COOKIE,
      sameSite: 'lax',
      expires: expiresAt,
    });
  }

  async function createSession(pool, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
      [token, userId, expiresAt]
    );
    return { token, expiresAt };
  }

  router.post('/api/auth/wallet-check', walletCheckLimiter, async (req, res) => {
    const { pubkey } = req.body || {};
    if (!pubkey || typeof pubkey !== 'string') {
      return res.status(400).json({ error: 'pubkey required' });
    }

    try {
      const { rows } = await pool.query(
        'SELECT id, username, is_admin FROM users WHERE usernode_pubkey = $1',
        [pubkey.trim()]
      );

      const isGenesis = genesisAccounts.isGenesisAddress(pubkey.trim());

      if (rows.length > 0) {
        const challenge = crypto.randomBytes(32).toString('hex');
        walletChallenges.set(challenge, {
          pubkey: pubkey.trim(),
          expiresAt: Date.now() + CHALLENGE_TTL_MS,
        });
        return res.json({ status: 'linked', challenge, isGenesis });
      }

      return res.json({ status: 'not_linked', isGenesis });
    } catch (err) {
      log.error('wallet-auth', 'wallet-check failed', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/auth/wallet-verify', authLimiter, async (req, res) => {
    const { pubkey, publicKey, challenge, signature } = req.body || {};
    if (!pubkey || !challenge || !signature) {
      return res.status(400).json({ error: 'pubkey, challenge, and signature required' });
    }

    const entry = walletChallenges.get(challenge);
    if (!entry || entry.pubkey !== pubkey.trim() || Date.now() > entry.expiresAt) {
      return res.status(401).json({ error: 'Invalid or expired challenge' });
    }
    walletChallenges.delete(challenge);

    const cryptoKey = (publicKey || pubkey).trim();
    const verifyUrl = `${config.nodeRpcUrl}/misc/verify-signature`;
    try {
      const verifyBody = {
        public_key: cryptoKey,
        message: challenge,
        signature,
      };
      log.info('wallet-auth', 'Calling verify-signature', {
        url: verifyUrl,
        public_key: cryptoKey.slice(0, 20) + '...',
        message_len: challenge.length,
        signature_prefix: String(signature).slice(0, 30) + '...',
      });
      const verifyResp = await httpJson('POST', verifyUrl, verifyBody);

      if (!verifyResp || !verifyResp.valid) {
        log.warn('wallet-auth', 'Signature invalid', { resp: verifyResp });
        return res.status(401).json({ error: 'Signature verification failed' });
      }

      const { rows } = await pool.query(
        'SELECT id, username, is_admin FROM users WHERE usernode_pubkey = $1',
        [pubkey.trim()]
      );
      if (rows.length === 0) {
        return res.status(401).json({ error: 'No account linked to this pubkey' });
      }

      const user = rows[0];
      const { token, expiresAt } = await createSession(pool, user.id);
      createSessionCookie(res, token, expiresAt);

      log.info('wallet-auth', 'Signature login successful', { userId: user.id, username: user.username });
      res.json({ user: { id: user.id, username: user.username, isAdmin: user.is_admin } });
    } catch (err) {
      log.error('wallet-auth', 'wallet-verify failed', { url: verifyUrl, err: err.message, code: err.code, stack: err.stack?.split('\n')[0] });
      res.status(500).json({ error: 'Signature verification service unavailable' });
    }
  });

  router.post('/api/auth/wallet-register', authLimiter, async (req, res) => {
    const { username, password, pubkey } = req.body || {};
    if (!username?.trim() || !password || !pubkey?.trim()) {
      return res.status(400).json({ error: 'username, password, and pubkey required' });
    }

    if (!genesisAccounts.isGenesisAddress(pubkey.trim())) {
      return res.status(403).json({ error: 'Only genesis ledger participants can register via wallet' });
    }

    try {
      const hash = await bcrypt.hash(password, 12);

      const linkToken = crypto.randomBytes(16).toString('hex');
      const linkExpiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);

      const { rows } = await pool.query(
        `INSERT INTO users (username, password, usernode_pubkey, wallet_link_token, wallet_link_expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [username.trim(), hash, pubkey.trim(), linkToken, linkExpiresAt]
      );
      const userId = rows[0].id;

      const { token, expiresAt } = await createSession(pool, userId);
      createSessionCookie(res, token, expiresAt);

      const memo = JSON.stringify({
        app: 'vibecode',
        type: 'link_wallet',
        token: linkToken,
      });

      log.info('wallet-auth', 'Wallet-gated registration', { userId, username: username.trim() });
      events.record(pool, { type: events.EVENT_TYPES.USER_SIGNED_UP, userId, metadata: { via: 'wallet' } });
      res.json({
        user: { id: userId, username: username.trim(), isAdmin: false },
        walletLink: {
          to: config.usernodeAppPubkey,
          amount: 1,
          memo,
          expiresAt: linkExpiresAt.toISOString(),
        },
      });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Username already taken' });
      }
      log.error('wallet-auth', 'wallet-register failed', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/auth/wallet-link-login', authLimiter, async (req, res) => {
    const { username, password, pubkey } = req.body || {};
    if (!username?.trim() || !password || !pubkey?.trim()) {
      return res.status(400).json({ error: 'username, password, and pubkey required' });
    }

    if (!genesisAccounts.isGenesisAddress(pubkey.trim())) {
      return res.status(403).json({ error: 'Only genesis ledger participants can link a wallet' });
    }

    try {
      const { rows } = await pool.query(
        'SELECT id, password, is_admin, usernode_pubkey FROM users WHERE username = $1',
        [username.trim()]
      );

      if (rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = rows[0];
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      if (user.usernode_pubkey && user.usernode_pubkey !== pubkey.trim()) {
        return res.status(409).json({ error: 'This account is already linked to a different wallet' });
      }

      const { token, expiresAt } = await createSession(pool, user.id);
      createSessionCookie(res, token, expiresAt);

      if (user.usernode_pubkey === pubkey.trim()) {
        log.info('wallet-auth', 'Wallet link-login (already linked)', { userId: user.id });
        return res.json({
          user: { id: user.id, username: user.username, isAdmin: user.is_admin },
        });
      }

      const linkToken = crypto.randomBytes(16).toString('hex');
      const linkExpiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);

      await pool.query(
        `UPDATE users SET wallet_link_token = $1, wallet_link_expires_at = $2 WHERE id = $3`,
        [linkToken, linkExpiresAt, user.id]
      );

      const memo = JSON.stringify({
        app: 'vibecode',
        type: 'link_wallet',
        token: linkToken,
      });

      log.info('wallet-auth', 'Wallet link-login initiated', { userId: user.id, username: user.username });
      res.json({
        user: { id: user.id, username: user.username, isAdmin: user.is_admin },
        walletLink: {
          to: config.usernodeAppPubkey,
          amount: 1,
          memo,
          expiresAt: linkExpiresAt.toISOString(),
        },
      });
    } catch (err) {
      log.error('wallet-auth', 'wallet-link-login failed', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { authRoutes };
