'use strict';

// OpenRouter credential APIs (plan.md §6): the account's OpenRouter key,
// which voice input (routes/dictation.js) transcribes with.
//
// The legacy /api/me/api-key route (a person's own Anthropic key) went in
// task 2275; these routes own the OpenRouter key lifecycle, the only key a
// person adds now:
//   GET    /api/me/credentials/openrouter   status (last4, limits)
//   PUT    /api/me/credentials/openrouter   save/replace personal key
//   DELETE /api/me/credentials/openrouter   revoke
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
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');

function credentialRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const OPENROUTER = { provider: 'openrouter', purpose: 'coding_agent' };

  // #2568 retired the gradual-rollout allowlist. What is left is the one
  // deployment switch (config.codexOpenrouterEnabled), which is not
  // per-user at all.
  function codexAvailable() {
    return config.codexOpenrouterEnabled === true;
  }

  // ── OpenRouter key status ──────────────────────────────────────────
  router.get('/api/me/credentials/openrouter', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    res.setHeader('Cache-Control', 'no-store');
    try {
      // #2568: the lazy safety net for an account that has no included key
      // yet (one created before keys were issued at signup, or one whose
      // signup ran while OpenRouter's management API was down), so this
      // status reports the key rather than one being set up. Voice input's
      // key read (routes/dictation.js) runs it too. ensureIncludedKey is
      // idempotent and never throws; an account that already has a key (or
      // a personal one) costs one metadata read.
      await managedOpenRouter.ensureIncludedKey({
        pool, userId: req.user.id, config, reason: 'settings_read',
      });
      // #2119: the included key carries the platform's weekly allowance for
      // this user. It is resolved once here, for the claim card and for the
      // sync, and the managed state is synced before the credential's
      // key-info is read, because that merged key-info is what the settings
      // limit line renders.
      const allowance = managedOpenRouter.managedKeysEnabled(config)
        ? await managedOpenRouter.resolveAllowance(pool, req.user.id)
        : { cents: 0, limitUsd: 0, limitReset: managedOpenRouter.LIMIT_RESET };
      const managedRow = await managedOpenRouter.syncAllowance({
        pool, userId: req.user.id, config, allowance,
        state: await managedOpenRouter.stateForUser(pool, req.user.id),
      });
      const meta = await credentialStore.readMetadata({ pool, userId: req.user.id, ...OPENROUTER });
      const managed = managedOpenRouter.publicState(managedRow);
      const configured = meta?.status === 'valid';
      const available = codexAvailable() && managedOpenRouter.managedKeysEnabled(config);
      const hasAllowance = allowance.cents > 0;
      res.json({
        configured,
        status: meta?.status || null,
        last4: meta?.secret_last4 || null,
        revision: meta?.revision || null,
        verifiedAt: meta?.verified_at || null,
        keyInfo: meta?.metadata?.keyInfo || null,
        source: meta?.metadata?.source || (configured ? 'personal' : null),
        managed,
        // #2568: nothing here is a claim gate any more — an account's
        // included key is created with the account (and, failing that, by
        // the ensureIncludedKey above), and Settings renders this as a
        // status line rather than a button.
        managedProvisioning: {
          available,
          alreadyIssued: !!managed,
          limitUsd: allowance.limitUsd,
          limitReset: allowance.limitReset,
          reason: !codexAvailable() ? 'not_available'
            : (!managedOpenRouter.managedKeysEnabled(config) ? 'not_configured'
              : (managed ? 'already_issued'
                : (!hasAllowance ? 'no_allowance'
                  : (configured ? 'personal_key_configured' : null)))),
        },
      });
    } catch (err) {
      log.error('credentials', 'openrouter status read failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Save / replace OpenRouter key ──────────────────────────────────
  router.put('/api/me/credentials/openrouter', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!codexAvailable()) return res.status(403).json({ error: 'OpenRouter is not available on this deployment.' });
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
        return res.status(409).json({ error: 'This OpenRouter key is managed by Homeroom. Ask an admin to block or remove it.' });
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
            'This OpenRouter key is managed by Homeroom. Ask an admin to block or remove it.',
          );
        }
        return credentialStore.writeOpenRouterCodingAgentOnClient({
          client, userId: req.user.id, apiKey: clean,
          dataKey: config.dataEncryptionKey,
          metadata: { source: 'personal', keyInfo },
        });
      });
      log.info('credentials', 'OpenRouter key saved', { userId: req.user.id });
      res.json({ ok: true, last4, revision: saved?.revision, keyInfo });
    } catch (err) {
      if (err instanceof managedOpenRouter.ManagedOpenRouterError) {
        return res.status(err.statusCode).json({ error: err.message, code: err.code });
      }
      log.error('credentials', 'Failed to persist OpenRouter key', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Delete (revoke) OpenRouter key ─────────────────────────────────
  router.delete('/api/me/credentials/openrouter', sameOriginBrowserOnly, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const managedState = await managedOpenRouter.stateForUser(pool, req.user.id);
      if (managedState.managed_key_id && managedState.managed_status !== 'deleted') {
        return res.status(409).json({ error: 'Company-funded keys can only be blocked or removed by an admin.' });
      }
      await credentialStore.revoke({ pool, userId: req.user.id, ...OPENROUTER });
      log.info('credentials', 'OpenRouter key removed', { userId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('credentials', 'Failed to remove OpenRouter key', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { credentialRoutes };
