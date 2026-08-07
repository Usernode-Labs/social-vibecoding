'use strict';

// OpenRouter credential + coding-agent preference APIs (plan.md §6, §7).
//
// Distinct from the legacy /api/me/api-key route (which is
// Anthropic-specific). These routes own the OpenRouter key lifecycle:
//   GET    /api/me/credentials/openrouter   status (last4, limits)
//   PUT    /api/me/credentials/openrouter   save/replace (verified)
//   DELETE /api/me/credentials/openrouter   revoke
//   GET    /api/me/coding-agent             current preferences
//   PATCH  /api/me/coding-agent            set default backend/model/effort
//   GET    /api/me/coding-agent/models      user-filtered catalog
//
// The raw OpenRouter key is verified against GET /api/v1/key before it is
// stored, encrypted with the existing AES-256-GCM envelope, and only the
// last4 + sanitized key-info are ever returned to the UI.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const secrets = require('../services/secrets');
const credentialStore = require('../services/credential-store');
const openrouterClient = require('../services/openrouter-client');
const agentModels = require('../services/agent-models');
const registry = require('../agents/registry');

function credentialRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const OPENROUTER = { provider: 'openrouter', purpose: 'coding_agent' };

  function betaAllowed(userId) {
    if (!config.codexOpenrouterEnabled) return false;
    const beta = config.openrouterBetaUserIds || [];
    if (beta.length === 0) return true; // no allowlist = open to all (behind flag)
    return beta.includes(String(userId));
  }

  // ── OpenRouter key status ──────────────────────────────────────────
  router.get('/api/me/credentials/openrouter', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const meta = await credentialStore.readMetadata({
        pool, userId: req.user.id, ...OPENROUTER,
      });
      if (!meta || meta.status !== 'valid') {
        return res.json({ configured: false, status: meta?.status || null });
      }
      res.json({
        configured: true,
        status: 'valid',
        last4: meta.secret_last4,
        revision: meta.revision,
        verifiedAt: meta.verified_at,
        keyInfo: meta.metadata?.keyInfo || null,
      });
    } catch (err) {
      log.error('credentials', 'openrouter status read failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Save / replace OpenRouter key ──────────────────────────────────
  router.put('/api/me/credentials/openrouter', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!betaAllowed(req.user.id)) return res.status(403).json({ error: 'Codex/OpenRouter is not available for your account yet.' });
    const { apiKey } = req.body || {};
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      return res.status(400).json({ error: 'API key required' });
    }
    const clean = apiKey.trim();
    // Friendly prefix check only — not authoritative validation.
    if (!/^sk-or-/.test(clean)) {
      return res.status(400).json({ error: 'That doesn\'t look like an OpenRouter API key (expected sk-or-…).' });
    }
    let keyInfo;
    try {
      keyInfo = await openrouterClient.validateKey(clean, { baseUrl: config.openrouterApiBase, origin: config.openrouterOrigin });
    } catch (err) {
      const msg = err.code === 'invalid_key'
        ? 'OpenRouter rejected the key.'
        : `Couldn't verify the key (${err.message}).`;
      return res.status(400).json({ error: msg });
    }
    try {
      const encrypted = secrets.encrypt(clean, config.dataEncryptionKey);
      const last4 = clean.slice(-4);
      const fp = credentialStore.fingerprint(clean, config.dataEncryptionKey);
      const saved = await credentialStore.upsert({
        pool, userId: req.user.id, ...OPENROUTER,
        secretEnc: encrypted, secretLast4: last4, secretFingerprint: fp,
        status: 'valid', verified: true,
      });
      // Persist sanitized key-info into the row's metadata for the status
      // display (label/limits). Never the raw key.
      if (saved?.id) {
        await pool.query(
          'UPDATE credentials.user_ai_credentials SET metadata = $2 WHERE id = $1',
          [saved.id, { keyInfo }],
        );
      }
      agentModels.invalidateUser(req.user.id);
      log.info('credentials', 'OpenRouter key saved', { userId: req.user.id });
      res.json({ ok: true, last4, revision: saved?.revision, keyInfo });
    } catch (err) {
      log.error('credentials', 'Failed to persist OpenRouter key', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Delete (revoke) OpenRouter key ─────────────────────────────────
  router.delete('/api/me/credentials/openrouter', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      await credentialStore.revoke({ pool, userId: req.user.id, ...OPENROUTER });
      agentModels.invalidateUser(req.user.id);
      // Key-removal consistency (review #8, plan 9.4): if Codex/OpenRouter
      // is the user's DEFAULT coding agent, reset the default back to
      // Claude — otherwise every future ordinary/headless session copies the
      // Codex default and immediately fails with `credential_required` until
      // a key is reconfigured. The "clear Codex default + upsert Claude
      // default" pair runs in ONE transaction so a failure between them can
      // never leave the user with NO default backend. Existing sessions are
      // left untouched (they stay on whatever backend they were created
      // with).
      const prefClient = await pool.connect();
      try {
        await prefClient.query('BEGIN');
        await prefClient.query(
          `UPDATE user_agent_preferences SET is_default = FALSE
           WHERE user_id = $1 AND backend = 'codex_openrouter' AND is_default = TRUE`,
          [req.user.id],
        );
        await prefClient.query(
          `INSERT INTO user_agent_preferences
             (user_id, backend, model_id, reasoning_effort, is_default)
           VALUES ($1, 'claude_code', NULL, NULL, TRUE)
           ON CONFLICT (user_id, backend) DO UPDATE SET
             is_default = TRUE, updated_at = NOW()`,
          [req.user.id],
        );
        await prefClient.query('COMMIT');
      } catch (prefErr) {
        await prefClient.query('ROLLBACK').catch(() => {});
        throw prefErr;
      } finally {
        prefClient.release();
      }
      log.info('credentials', 'OpenRouter key removed; default agent reset to Claude', { userId: req.user.id });
      res.json({ ok: true, defaultReset: true });
    } catch (err) {
      log.error('credentials', 'Failed to remove OpenRouter key', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Coding-agent preferences ───────────────────────────────────────
  router.get('/api/me/coding-agent', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const { rows } = await pool.query(
        `SELECT backend, model_id, reasoning_effort, max_turn_cost_usd, is_default
         FROM user_agent_preferences WHERE user_id = $1`,
        [req.user.id],
      );
      const backends = {};
      for (const r of rows) {
        backends[r.backend] = {
          model: r.model_id, reasoningEffort: r.reasoning_effort,
          maxTurnCostUsd: r.max_turn_cost_usd, isDefault: r.is_default,
        };
      }
      const defaultBackend = rows.find((r) => r.is_default)?.backend
        || (backends.claude_code ? 'claude_code' : registry.DEFAULT_BACKEND);
      res.json({ defaultBackend, backends, codexAvailable: betaAllowed(req.user.id) });
    } catch (err) {
      log.error('credentials', 'coding-agent prefs read failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/me/coding-agent', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { defaultBackend, model, reasoningEffort, maxTurnCostUsd } = req.body || {};
    let parsedMaxTurnCostUsd;
    let backend = defaultBackend || 'codex_openrouter';
    try { registry.resolveBackend(backend); } catch { return res.status(400).json({ error: 'Unknown backend' }); }
    if (backend === 'codex_openrouter' && !betaAllowed(req.user.id)) {
      return res.status(403).json({ error: 'Codex/OpenRouter is not available for your account yet.' });
    }
    if (reasoningEffort != null && !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) {
      return res.status(400).json({ error: 'Invalid reasoning effort' });
    }
    // Cost-ceiling validation (review #7): reject negative, non-finite, or
    // malformed values up front (instead of letting PostgreSQL 500 on a
    // broken constraint). `null` means "unchanged"; `0` legitimately clears
    // the cap — so 0 must be preserved, not collapsed to null.
    if (maxTurnCostUsd != null) {
      const num = typeof maxTurnCostUsd === 'number' ? maxTurnCostUsd : Number(maxTurnCostUsd);
      if (!Number.isFinite(num) || num < 0) {
        return res.status(400).json({ error: 'Cost cap must be a non-negative number.' });
      }
      parsedMaxTurnCostUsd = num;
    } else {
      parsedMaxTurnCostUsd = null;
    }
    // Validate the model against the user's permitted catalog (review P1) —
    // model ids become executable Codex config.toml, so arbitrary strings
    // (with quotes/newlines) could inject TOML/MCP sections. Only allow
    // a model the user's key can actually access. Wrapped in try/catch
    // (review P6): listOpenRouterModels rethrows on failure, and Express 4
    // does not catch rejected async handlers — a transient catalog outage
    // must become a clean 400, never an unhandled rejection.
    if (backend === 'codex_openrouter' && model) {
      try {
      const meta = await credentialStore.readMetadata({
        pool, userId: req.user.id, provider: 'openrouter', purpose: 'coding_agent',
      });
      if (!meta || meta.status !== 'valid') {
        return res.status(400).json({ error: 'Add your OpenRouter API key in Settings first.' });
      }
      const apiKey = await credentialStore.readSecret({
        pool, userId: req.user.id, provider: 'openrouter', purpose: 'coding_agent',
        dataKey: config.dataEncryptionKey,
      });
      if (!apiKey) return res.status(400).json({ error: 'OpenRouter key not available.' });
      const catalog = await agentModels.listOpenRouterModels({
        pool, userId: req.user.id, credentialRevision: meta.revision,
        apiKey, config, forceRefresh: false,
      });
      const allowed = catalog.models.some((m) => m.id === model);
      if (!allowed) {
        return res.status(400).json({ error: 'That model is not available under your OpenRouter key.' });
      }
      } catch (err) {
        log.warn('credentials', 'model validation failed; rejecting safe', { userId: req.user.id, err: err.message });
        return res.status(400).json({ error: 'Could not validate that model right now; try again.' });
      }
    }
    try {
      // Clear other defaults BEFORE the upsert (review P2): the partial
      // unique index `user_agent_preferences_one_default` (one
      // is_default=TRUE per user) would reject the upsert if another
      // backend is already the default, because the ON CONFLICT fires
      // after the INSERT attempts a second is_default=TRUE row.
      if (defaultBackend) {
        await pool.query(
          `UPDATE user_agent_preferences SET is_default = FALSE
           WHERE user_id = $1 AND is_default = TRUE AND backend <> $2`,
          [req.user.id, backend],
        );
      }
      await pool.query(
        `INSERT INTO user_agent_preferences
           (user_id, backend, model_id, reasoning_effort, max_turn_cost_usd, is_default)
        VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, backend) DO UPDATE SET
           model_id = EXCLUDED.model_id,
           reasoning_effort = EXCLUDED.reasoning_effort,
           -- Preserve the existing cost cap when the request omits it
           -- (review P3): Settings' model/default save doesn't send
           -- maxTurnCostUsd, so a plain overwrite would silently wipe the
           -- user's safety limit. Only replace when explicitly provided.
           max_turn_cost_usd = COALESCE(EXCLUDED.max_turn_cost_usd,
             user_agent_preferences.max_turn_cost_usd),
           is_default = EXCLUDED.is_default,
           updated_at = NOW()`,
        [req.user.id, backend, model || null, reasoningEffort || null, parsedMaxTurnCostUsd != null ? parsedMaxTurnCostUsd : null, !!defaultBackend],
      );
      res.json({ ok: true });
    } catch (err) {
      log.error('credentials', 'coding-agent prefs write failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── User-filtered model catalog ────────────────────────────────────
  router.get('/api/me/coding-agent/models', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const backend = (req.query.backend || 'codex_openrouter');
    if (backend !== 'codex_openrouter') return res.json({ backend, models: [] });
    if (!betaAllowed(req.user.id)) return res.status(403).json({ error: 'Not available' });
    try {
      const meta = await credentialStore.readMetadata({ pool, userId: req.user.id, ...OPENROUTER });
      if (!meta || meta.status !== 'valid') {
        return res.json({ backend, credentialRevision: meta?.revision || null, models: [] });
      }
      const apiKey = await credentialStore.readSecret({
        pool, userId: req.user.id, ...OPENROUTER, dataKey: config.dataEncryptionKey,
      });
      if (!apiKey) return res.json({ backend, models: [] });
      const catalog = await agentModels.listOpenRouterModels({
        pool, userId: req.user.id, credentialRevision: meta.revision,
        apiKey, config, forceRefresh: req.query.refresh === '1',
      });
      res.json(catalog);
    } catch (err) {
      const msg = err.code === 'invalid_key' ? 'OpenRouter rejected the key.' : 'Failed to load models.';
      log.warn('credentials', 'model catalog failed', { userId: req.user.id, err: err.message });
      res.status(400).json({ error: msg });
    }
  });

  return router;
}

module.exports = { credentialRoutes };
