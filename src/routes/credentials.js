'use strict';

// OpenRouter credential + coding-agent preference APIs (plan.md §6, §7).
//
// Distinct from the legacy /api/me/api-key route (which is
// Anthropic-specific). These routes own the OpenRouter key lifecycle:
//   GET    /api/me/credentials/openrouter   status (last4, limits)
//   POST   /api/me/credentials/openrouter/managed  claim company child key
//   PUT    /api/me/credentials/openrouter   save/replace personal key
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
const credentialStore = require('../services/credential-store');
const openrouterClient = require('../services/openrouter-client');
const managedOpenRouter = require('../services/openrouter-managed-keys');
const agentModels = require('../services/agent-models');
const registry = require('../agents/registry');
const agentPreferences = require('../services/agent-preferences');

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
    res.setHeader('Cache-Control', 'no-store');
    try {
      const [meta, managedRow] = await Promise.all([
        credentialStore.readMetadata({ pool, userId: req.user.id, ...OPENROUTER }),
        managedOpenRouter.stateForUser(pool, req.user.id),
      ]);
      const managed = managedOpenRouter.publicState(managedRow);
      const configured = meta?.status === 'valid';
      const available = betaAllowed(req.user.id) && !!config.openrouterManagementApiKey;
      res.json({
        configured,
        status: meta?.status || null,
        last4: meta?.secret_last4 || null,
        revision: meta?.revision || null,
        verifiedAt: meta?.verified_at || null,
        keyInfo: meta?.metadata?.keyInfo || null,
        source: meta?.metadata?.source || (configured ? 'personal' : null),
        managed,
        managedProvisioning: {
          available,
          verified: !!managedRow.verified,
          alreadyIssued: !!managed,
          canClaim: available && !!managedRow.verified && !managed && !configured,
          dailyLimitUsd: config.openrouterManagedDailyLimitUsd,
          reason: !betaAllowed(req.user.id) ? 'not_available'
            : (!config.openrouterManagementApiKey ? 'not_configured'
              : (!managedRow.verified ? 'verification_required'
                : (managed ? 'already_issued' : (configured ? 'personal_key_configured' : null)))),
        },
      });
    } catch (err) {
      log.error('credentials', 'openrouter status read failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Claim the one company-funded OpenRouter child key ─────────────
  router.post('/api/me/credentials/openrouter/managed', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    if (!betaAllowed(req.user.id)) {
      return res.status(403).json({ error: 'OpenRouter is not available for your account yet.' });
    }
    try {
      const claimed = await managedOpenRouter.provision({
        pool, userId: req.user.id, config,
      });
      // This is the one and only plaintext response. The browser presents a
      // copy/save affordance; subsequent GETs return only last4 + metadata.
      return res.status(201).json({ ok: true, ...claimed, shownOnce: true });
    } catch (err) {
      if (err instanceof managedOpenRouter.ManagedOpenRouterError) {
        return res.status(err.statusCode).json({ error: err.message, code: err.code });
      }
      log.error('credentials', 'managed OpenRouter claim failed', {
        userId: req.user.id, err: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
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
    try {
      const managedState = await managedOpenRouter.stateForUser(pool, req.user.id);
      if (managedState.managed_key_id && managedState.managed_status !== 'deleted') {
        return res.status(409).json({ error: 'This OpenRouter key is managed by Usernode. Ask an admin to block or remove it.' });
      }
    } catch (err) {
      log.error('credentials', 'managed key ownership check failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
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
      const last4 = clean.slice(-4);
      let defaultModel = config.openrouterDefaultCodexModel || null;
      try {
        const catalog = await agentModels.listOpenRouterModels({
          pool, userId: req.user.id, credentialRevision: 'personal-save',
          apiKey: clean, config, forceRefresh: true,
        });
        defaultModel = catalog.recommendedModelId || defaultModel;
      } catch (err) {
        log.warn('credentials', 'catalog unavailable while saving OpenRouter key', {
          userId: req.user.id, err: err.message,
        });
      }
      const saved = await credentialStore.withTransaction(pool, async (client) => {
        // Serialize with managed-key reservation. The earlier ownership
        // check gives fast feedback, while this in-transaction re-check
        // closes the provider-validation race where a claim could reserve a
        // company key before this personal-key save commits.
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
        const { rows: managedRows } = await client.query(
          `SELECT status FROM credentials.managed_openrouter_keys
            WHERE user_id = $1 AND status <> 'deleted'`,
          [req.user.id],
        );
        if (managedRows.length) {
          throw new managedOpenRouter.ManagedOpenRouterError(
            409,
            'managed_key_exists',
            'This OpenRouter key is managed by Usernode. Ask an admin to block or remove it.',
          );
        }
        const credential = await credentialStore.writeOpenRouterCodingAgentOnClient({
          client, userId: req.user.id, apiKey: clean,
          dataKey: config.dataEncryptionKey,
          metadata: { source: 'personal', keyInfo },
        });
        await agentPreferences.setDefaultBackend(client, req.user.id, {
          backend: 'codex_openrouter', model: defaultModel, reasoningEffort: null,
        });
        return credential;
      });
      agentModels.invalidateUser(req.user.id);
      log.info('credentials', 'OpenRouter key saved and selected as default', { userId: req.user.id });
      res.json({ ok: true, last4, revision: saved?.revision, keyInfo, defaultModel });
    } catch (err) {
      if (err instanceof managedOpenRouter.ManagedOpenRouterError) {
        return res.status(err.statusCode).json({ error: err.message, code: err.code });
      }
      log.error('credentials', 'Failed to persist OpenRouter key', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Delete (revoke) OpenRouter key ─────────────────────────────────
  router.delete('/api/me/credentials/openrouter', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const managedState = await managedOpenRouter.stateForUser(pool, req.user.id);
      if (managedState.managed_key_id && managedState.managed_status !== 'deleted') {
        return res.status(409).json({ error: 'Company-funded keys can only be blocked or removed by an admin.' });
      }
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
        await agentPreferences.setDefaultBackend(prefClient, req.user.id, {
          backend: 'claude_code',
        });
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
        `SELECT backend, model_id, reasoning_effort, is_default
         FROM user_agent_preferences WHERE user_id = $1`,
        [req.user.id],
      );
      const backends = {};
      for (const r of rows) {
        backends[r.backend] = {
          model: r.model_id, reasoningEffort: r.reasoning_effort,
          isDefault: r.is_default,
        };
      }
      let defaultBackend = rows.find((r) => r.is_default)?.backend || null;
      // Existing OpenRouter users who predate this default migration should
      // still see OpenRouter selected without requiring a preference rewrite.
      if (!defaultBackend && betaAllowed(req.user.id)) {
        const meta = await credentialStore.readMetadata({
          pool, userId: req.user.id, ...OPENROUTER,
        });
        if (meta?.status === 'valid') {
          defaultBackend = 'codex_openrouter';
          backends.codex_openrouter ||= {
            model: config.openrouterDefaultCodexModel || null,
            reasoningEffort: null,
            isDefault: true,
          };
        }
      }
      defaultBackend ||= (backends.claude_code ? 'claude_code' : registry.DEFAULT_BACKEND);
      res.json({ defaultBackend, backends, codexAvailable: betaAllowed(req.user.id) });
    } catch (err) {
      log.error('credentials', 'coding-agent prefs read failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/me/coding-agent', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { defaultBackend, model, reasoningEffort } = req.body || {};
    let backend = defaultBackend || 'codex_openrouter';
    try { registry.resolveBackend(backend); } catch { return res.status(400).json({ error: 'Unknown backend' }); }
    if (backend === 'codex_openrouter' && !betaAllowed(req.user.id)) {
      return res.status(403).json({ error: 'Codex/OpenRouter is not available for your account yet.' });
    }
    if (reasoningEffort != null && !['minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoningEffort)) {
      return res.status(400).json({ error: 'Invalid reasoning effort' });
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
        await agentPreferences.setDefaultBackend(pool, req.user.id, {
          backend, model, reasoningEffort,
        });
      } else {
        // Behaviour preserved verbatim from before the helper existed: this
        // branch upserts is_default = TRUE WITHOUT clearing the others.
        await pool.query(
          `INSERT INTO user_agent_preferences
             (user_id, backend, model_id, reasoning_effort, is_default)
          VALUES ($1, $2, $3, $4, TRUE)
           ON CONFLICT (user_id, backend) DO UPDATE SET
             model_id = EXCLUDED.model_id,
             reasoning_effort = EXCLUDED.reasoning_effort,
             is_default = EXCLUDED.is_default,
             updated_at = NOW()`,
          [req.user.id, backend, model || null, reasoningEffort || null],
        );
      }
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
