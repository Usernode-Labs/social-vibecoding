const { Router } = require('express');
const net = require('net');
const { getPool } = require('../db/pool');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
const {
  publicProfileReadLimiter,
  profileWriteLimiter,
  profileReportLimiter,
} = require('../middleware/rate-limits');
const log = require('../services/logger');

const REASONS = new Set(['impersonation', 'harassment', 'spam', 'unsafe_avatar', 'other']);
const PROFILE_KEYS = new Set(['published', 'displayName', 'bio', 'avatarUrl']);
const NO_STORE = 'private, no-store, max-age=0';

function textField(value, name, max, { multiline = false } = {}) {
  if (value == null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: `${name} must be a string or null` };
  const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  const controls = multiline
    ? /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u
    : /[\u0000-\u001F\u007F-\u009F]/u;
  if (controls.test(normalized)) return { error: `${name} contains unsupported control characters` };
  if (Array.from(normalized).length > max) return { error: `${name} must be at most ${max} characters` };
  return { value: normalized || null };
}

function privateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // Remote avatar URLs need hostnames, not IP literals. Besides blocking
  // conventional loopback/private ranges this rejects alternate IPv4 forms
  // and IPv4-mapped IPv6 without maintaining a fragile CIDR list. The server
  // never fetches avatars; this protects visitors' browsers from being used
  // as probes of literal-address services on their local network.
  if (net.isIP(h)) return true;
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^169\.254\./.test(h) || /^192\.168\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb');
}

function avatarField(value) {
  const parsed = textField(value, 'avatarUrl', 500);
  if (parsed.error || parsed.value == null) return parsed;
  let url;
  try { url = new URL(parsed.value); } catch { return { error: 'avatarUrl must be a valid HTTPS URL' }; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) {
    return { error: 'avatarUrl must be a plain HTTPS URL without credentials, query, fragment, or non-standard port' };
  }
  if (!url.hostname || privateHost(url.hostname)) return { error: 'avatarUrl host is not allowed' };
  return { value: url.href };
}

function publicShape(row) {
  return {
    username: row.username,
    displayName: row.profile_display_name || null,
    bio: row.profile_bio || null,
    avatarUrl: row.profile_avatar_url || null,
    url: `/#profile/${encodeURIComponent(row.username)}`,
  };
}

function profileRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/public/profiles/:username', publicProfileReadLimiter, async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    const username = String(req.params.username || '');
    if (!username || username.length > 255 || /[\u0000-\u001F\u007F]/u.test(username)) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    try {
      const { rows } = await pool.query(
        `SELECT username, profile_display_name, profile_bio, profile_avatar_url
           FROM users
          WHERE username = $1
            AND profile_published = TRUE
            AND profile_disabled_at IS NULL`,
        [username]
      );
      if (!rows.length) return res.status(404).json({ error: 'Profile not found' });
      return res.json({ profile: publicShape(rows[0]) });
    } catch (err) {
      log.error('profiles', 'Public profile read failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/me/profile', async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const { rows } = await pool.query(
        `SELECT username, profile_published, profile_display_name, profile_bio,
                profile_avatar_url, profile_disabled_at
           FROM users WHERE id = $1`,
        [req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      const row = rows[0];
      return res.json({
        profile: publicShape(row),
        published: !!row.profile_published,
        moderationDisabled: !!row.profile_disabled_at,
      });
    } catch (err) {
      log.error('profiles', 'Owner profile read failed', { userId: req.user.id, message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/me/profile', profileWriteLimiter, async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!body || Object.keys(body).some((key) => !PROFILE_KEYS.has(key)) || typeof body.published !== 'boolean') {
      return res.status(400).json({ error: 'Expected only published, displayName, bio, and avatarUrl' });
    }
    const display = textField(body.displayName, 'displayName', 80);
    const bio = textField(body.bio, 'bio', 500, { multiline: true });
    const avatar = avatarField(body.avatarUrl);
    const error = display.error || bio.error || avatar.error;
    if (error) return res.status(400).json({ error });
    if (body.published && !display.value && !bio.value && !avatar.value) {
      return res.status(400).json({ error: 'Add a display name, bio, or avatar before publishing' });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE users
            SET profile_published = $1, profile_display_name = $2,
                profile_bio = $3, profile_avatar_url = $4,
                profile_updated_at = NOW()
          WHERE id = $5
          RETURNING username, profile_published, profile_display_name,
                    profile_bio, profile_avatar_url, profile_disabled_at`,
        [body.published, display.value, bio.value, avatar.value, req.user.id]
      );
      const row = rows[0];
      log.info('profiles', 'Profile saved', { userId: req.user.id, published: body.published });
      return res.json({ profile: publicShape(row), published: !!row.profile_published, moderationDisabled: !!row.profile_disabled_at });
    } catch (err) {
      log.error('profiles', 'Profile save failed', { userId: req.user.id, message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/me/profile', profileWriteLimiter, async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      await pool.query(
        `UPDATE users
            SET profile_published = FALSE, profile_display_name = NULL,
                profile_bio = NULL, profile_avatar_url = NULL,
                profile_updated_at = NOW()
          WHERE id = $1`,
        [req.user.id]
      );
      return res.json({ ok: true });
    } catch (err) {
      log.error('profiles', 'Profile clear failed', { userId: req.user.id, message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/profiles/:username/report', profileReportLimiter, async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    if (!REASONS.has(reason)) return res.status(400).json({ error: 'Invalid report reason' });
    const detail = textField(req.body?.detail, 'detail', 500, { multiline: true });
    if (detail.error) return res.status(400).json({ error: detail.error });
    const username = String(req.params.username || '');
    if (username === req.user.username) return res.status(400).json({ error: 'You cannot report your own profile' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize against moderation's UPDATE of this same user row. If the
      // report wins, a following takedown resolves it; if moderation wins,
      // this read observes disabled_at and inserts nothing. No pending report
      // can be stranded behind a completed takedown.
      const { rows } = await client.query(
        `SELECT id FROM users
          WHERE username = $1 AND profile_published = TRUE AND profile_disabled_at IS NULL
          FOR KEY SHARE`,
        [username]
      );
      if (rows.length) {
        await client.query(
          `INSERT INTO profile_reports (profile_user_id, reporter_user_id, reason, detail)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (profile_user_id, reporter_user_id) WHERE status = 'pending'
           DO NOTHING`,
          [rows[0].id, req.user.id, reason, detail.value]
        );
      }
      await client.query('COMMIT');
      // Always accepted, including missing/unpublished/duplicate targets, so
      // reporting cannot be used as a higher-fidelity profile oracle.
      return res.status(202).json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('profiles', 'Profile report failed', { userId: req.user.id, message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  router.get('/api/admin/profile-reports', adminMiddleware, async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    const status = ['pending', 'resolved', 'dismissed'].includes(req.query.status) ? req.query.status : 'pending';
    try {
      const { rows } = await pool.query(
        `SELECT pr.id, pr.reason, pr.detail, pr.status, pr.created_at,
                target.username AS profile_username, reporter.username AS reporter_username
           FROM profile_reports pr
           JOIN users target ON target.id = pr.profile_user_id
           JOIN users reporter ON reporter.id = pr.reporter_user_id
          WHERE pr.status = $1 ORDER BY pr.created_at ASC, pr.id ASC LIMIT 200`,
        [status]
      );
      return res.json({ reports: rows });
    } catch (err) {
      log.error('profiles', 'Profile reports list failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/admin/profiles/:username/moderation', adminMiddleware, requireAdminWrite, async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    if (typeof req.body?.disabled !== 'boolean') return res.status(400).json({ error: 'disabled must be a boolean' });
    const reason = textField(req.body?.reason, 'reason', 240);
    if (reason.error || (req.body.disabled && !reason.value)) {
      return res.status(400).json({ error: reason.error || 'reason is required when disabling a profile' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE users
            SET profile_disabled_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
                profile_disabled_by = CASE WHEN $1 THEN $2 ELSE NULL END,
                profile_disabled_reason = CASE WHEN $1 THEN $3 ELSE NULL END
          WHERE username = $4
          RETURNING id, username`,
        [req.body.disabled, req.user.id, reason.value, String(req.params.username || '')]
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }
      if (req.body.disabled) {
        await client.query(
          `UPDATE profile_reports SET status = 'resolved', resolved_at = NOW(), resolved_by = $1
            WHERE profile_user_id = $2 AND status = 'pending'`,
          [req.user.id, rows[0].id]
        );
      }
      await client.query('COMMIT');
      log.info('profiles', 'Profile moderation changed', { username: rows[0].username, disabled: req.body.disabled, by: req.user.username });
      return res.json({ ok: true, username: rows[0].username, disabled: req.body.disabled });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('profiles', 'Profile moderation failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = { profileRoutes, textField, avatarField, publicShape };
