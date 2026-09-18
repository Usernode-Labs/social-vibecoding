'use strict';

// #2377: authenticated settings, compatible-model catalog, and accounting
// surfaces for Global Chat. These routes never return the shared OpenRouter
// secret and are intentionally independent from development-agent settings.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const credentialStore = require('../services/credential-store');
const openrouterClient = require('../services/openrouter-client');
const agentModels = require('../services/agent-models');
const profileService = require('../services/global-chat/profile');
const globalChatStore = require('../services/global-chat/store');
const { firstUsePresentation } = require('../services/global-chat/presentation');
const { CapabilityRegistry } = require('../services/global-chat/capability-registry');
const { classicCapabilityDefinitions } = require('../services/global-chat/classic-capabilities');

const OPENROUTER = Object.freeze({ provider: 'openrouter', purpose: 'coding_agent' });
const PATCH_FIELDS = new Set(['model', 'reasoningEffort', 'spendCapUsd']);
const CAPABILITY_REGISTRY = new CapabilityRegistry(classicCapabilityDefinitions());

function noStore(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
}

function cleanProviderNumber(value) {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function globalChatRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  async function credentialForUser(userId) {
    const metadata = await credentialStore.readMetadata({ pool, userId, ...OPENROUTER });
    if (!metadata || metadata.status !== 'valid') {
      return { configured: false, metadata, apiKey: null };
    }
    const apiKey = await credentialStore.readSecret({
      pool,
      userId,
      ...OPENROUTER,
      dataKey: config.dataEncryptionKey,
    });
    return { configured: !!apiKey, metadata, apiKey: apiKey || null };
  }

  async function catalogForUser(userId, { forceRefresh = false, effort } = {}) {
    const credential = await credentialForUser(userId);
    if (!credential.configured) {
      return {
        configured: false,
        catalog: profileService.globalChatCatalog({ models: [] }, config, effort),
      };
    }
    const catalog = await agentModels.listOpenRouterModels({
      pool,
      userId,
      credentialRevision: credential.metadata.revision,
      apiKey: credential.apiKey,
      config,
      forceRefresh,
    });
    return {
      configured: true,
      catalog: profileService.globalChatCatalog(catalog, config, effort),
    };
  }

  async function developmentProfile(userId) {
    const { rows } = await pool.query(
      `SELECT backend, model_id, reasoning_effort
         FROM user_agent_preferences
        WHERE user_id = $1 AND is_default = TRUE
        LIMIT 1`,
      [userId],
    );
    const row = rows[0] || {};
    return {
      backend: row.backend || 'claude_code',
      model: row.model_id || null,
      reasoningEffort: row.reasoning_effort || null,
    };
  }

  router.get('/api/global-chat/bootstrap', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      const [profile, thread, development, credential] = await Promise.all([
        profileService.readProfile(pool, req.user.id, config),
        globalChatStore.ensureThread(pool, req.user.id),
        developmentProfile(req.user.id),
        credentialForUser(req.user.id),
      ]);
      const usage = await profileService.readMonthlyUsage(pool, req.user.id, {
        spendCapUsd: profile.spendCapUsd,
      });
      return res.json({
        experimental: true,
        label: 'Chat (experimental)',
        startupMode: 'classic',
        parityReady: false,
        available: credential.configured,
        unavailableReason: credential.configured ? null : 'openrouter_key_required',
        capabilityRegistryVersion: CAPABILITY_REGISTRY.version,
        capabilityCount: CAPABILITY_REGISTRY.size,
        thread,
        firstUse: firstUsePresentation(),
        profiles: { globalChat: profile, development },
        usage,
      });
    } catch (err) {
      log.error('global-chat', 'bootstrap failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Failed to open Global Chat.' });
    }
  });

  router.get('/api/global-chat/threads/current', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      return res.json({ thread: await globalChatStore.currentThread(pool, req.user.id) });
    } catch (err) {
      log.warn('global-chat', 'current thread read failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Failed to load the current Global Chat thread.' });
    }
  });

  router.post('/api/global-chat/threads', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      const thread = await globalChatStore.createThread(pool, req.user.id, { replace: true });
      return res.status(201).json({ thread, firstUse: firstUsePresentation() });
    } catch (err) {
      log.warn('global-chat', 'thread create failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Failed to start a new Global Chat thread.' });
    }
  });

  router.get('/api/global-chat/threads/:id/messages', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      const page = await globalChatStore.listMessages(pool, {
        userId: req.user.id,
        threadId: req.params.id,
        before: req.query.before,
        limit: req.query.limit,
      });
      return res.json(page);
    } catch (err) {
      if (err instanceof globalChatStore.GlobalChatStoreError
          && ['invalid_id', 'invalid_cursor'].includes(err.code)) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      log.warn('global-chat', 'message page failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Failed to load Global Chat messages.' });
    }
  });

  router.delete('/api/global-chat/threads/:id', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      const deleted = await globalChatStore.deleteThread(pool, req.user.id, req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Global Chat thread not found.' });
      return res.json({ ok: true });
    } catch (err) {
      if (err instanceof globalChatStore.GlobalChatStoreError && err.code === 'invalid_id') {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      log.warn('global-chat', 'thread delete failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Failed to clear Global Chat.' });
    }
  });

  router.get('/api/me/global-chat', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      const profile = await profileService.readProfile(pool, req.user.id, config);
      const usage = await profileService.readMonthlyUsage(pool, req.user.id, {
        spendCapUsd: profile.spendCapUsd,
      });
      res.json({
        experimental: true,
        startupMode: 'classic',
        profile,
        defaults: profileService.defaults(config),
        usage,
      });
    } catch (err) {
      log.error('global-chat', 'profile read failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Failed to load Global Chat settings.' });
    }
  });

  router.patch('/api/me/global-chat', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body
      : {};
    const keys = Object.keys(body);
    if (keys.length === 0 || keys.some((key) => !PATCH_FIELDS.has(key))) {
      return res.status(400).json({ error: 'Provide only model, reasoningEffort, or spendCapUsd.' });
    }
    try {
      const current = await profileService.readProfile(pool, req.user.id, config);
      const next = {
        model: Object.hasOwn(body, 'model')
          ? profileService.modelId(body.model)
          : current.model,
        reasoningEffort: Object.hasOwn(body, 'reasoningEffort')
          ? profileService.reasoningEffort(body.reasoningEffort)
          : current.reasoningEffort,
        spendCapUsd: Object.hasOwn(body, 'spendCapUsd')
          ? profileService.money(body.spendCapUsd)
          : current.spendCapUsd,
      };

      // A cap-only change remains possible during a provider outage. Model or
      // effort changes are executable configuration, so fail closed unless
      // the exact pair is in this user's live, capability-filtered catalog.
      if (Object.hasOwn(body, 'model') || Object.hasOwn(body, 'reasoningEffort')) {
        const { configured, catalog } = await catalogForUser(req.user.id, {
          effort: next.reasoningEffort,
        });
        if (!configured) {
          return res.status(400).json({ error: 'Add your OpenRouter API key in Settings first.' });
        }
        if (!catalog.models.some((model) => model.id === next.model)) {
          return res.status(400).json({
            error: 'That model does not support Global Chat tools, structured output, and the selected reasoning effort.',
          });
        }
      }

      const profile = await profileService.writeProfile(pool, req.user.id, next, config);
      const usage = await profileService.readMonthlyUsage(pool, req.user.id, {
        spendCapUsd: profile.spendCapUsd,
      });
      res.json({ ok: true, profile, usage });
    } catch (err) {
      if (err instanceof profileService.GlobalChatProfileError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      log.warn('global-chat', 'profile write failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Failed to save Global Chat settings.' });
    }
  });

  router.get('/api/me/global-chat/models', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      const profile = await profileService.readProfile(pool, req.user.id, config);
      const effort = req.query.reasoningEffort == null
        ? profile.reasoningEffort
        : profileService.reasoningEffort(req.query.reasoningEffort);
      const result = await catalogForUser(req.user.id, {
        forceRefresh: req.query.refresh === '1',
        effort,
      });
      res.json({ configured: result.configured, ...result.catalog });
    } catch (err) {
      if (err instanceof profileService.GlobalChatProfileError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      log.warn('global-chat', 'model catalog failed', { userId: req.user.id, err: err.message });
      return res.status(502).json({ error: 'Failed to load compatible Global Chat models.' });
    }
  });

  router.get('/api/me/global-chat/usage', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      const profile = await profileService.readProfile(pool, req.user.id, config);
      const globalChat = await profileService.readMonthlyUsage(pool, req.user.id, {
        spendCapUsd: profile.spendCapUsd,
      });
      const credential = await credentialForUser(req.user.id);
      if (!credential.configured) {
        return res.json({ globalChat, overallAllowance: { configured: false } });
      }
      const info = await openrouterClient.validateKey(credential.apiKey, {
        baseUrl: config.openrouterApiBase,
        origin: config.openrouterOrigin,
      });
      return res.json({
        globalChat,
        overallAllowance: {
          configured: true,
          limitUsd: cleanProviderNumber(info.limit),
          remainingUsd: cleanProviderNumber(info.limitRemaining),
          spentUsd: cleanProviderNumber(info.usage),
          reset: typeof info.limitReset === 'string' ? info.limitReset : null,
        },
      });
    } catch (err) {
      log.warn('global-chat', 'usage read failed', { userId: req.user.id, err: err.message });
      return res.status(502).json({ error: 'Failed to load Global Chat usage.' });
    }
  });

  return router;
}

module.exports = { globalChatRoutes, cleanProviderNumber };
