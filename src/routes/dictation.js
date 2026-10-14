'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { getPool } = require('../db/pool');
const credentialStore = require('../services/credential-store');
const managedOpenRouter = require('../services/openrouter-managed-keys');
const limits = require('../services/limits');
const dictation = require('../services/dictation');
const telemetry = require('../services/llm-telemetry');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const { dictationLimiter } = require('../middleware/rate-limits');

function dictationRoutes(config, deps = {}) {
  const router = express.Router();
  const active = new Set();
  const pool = deps.pool || getPool();
  router.post('/api/dictation/transcribe', (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.user?.id) return res.status(401).json({ code: 'sign_in_required' });
    return next();
  }, dictationLimiter, sameOriginBrowserOnly,
  // Reject callers before buffering bytes or opening a provider request.
  (req, res, next) => {
    if (req.is('audio/wav') !== 'audio/wav') return res.status(415).json({ code: 'invalid_audio' });
    return next();
  }, express.raw({ type: 'audio/wav', limit: dictation.MAX_BYTES }), async (req, res) => {
    const userId = req.user.id;
    if (active.has(userId)) return res.status(429).json({ code: 'busy' });
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? 45000);
    active.add(userId);
    const started = Date.now();
    try {
      dictation.validateWav(req.body);
      const credential = { pool, userId, provider: 'openrouter', purpose: 'coding_agent' };
      const meta = await (deps.readMetadata || credentialStore.readMetadata)(credential);
      const apiKey = await (deps.readSecret || credentialStore.readSecret)({ pool, userId,
        provider: 'openrouter', purpose: 'coding_agent', dataKey: config.dataEncryptionKey,
        expectedRevision: meta?.revision });
      if (!apiKey) throw new dictation.DictationError('key_required', 403);
      const included = meta?.metadata?.source === managedOpenRouter.MANAGED_SOURCE;
      if (included) {
        const budget = await (deps.checkBudget || limits.checkBudget)(pool, userId);
        if (!budget.ok) throw new dictation.DictationError(
          budget.reason === 'entitlement_unavailable' ? 'transcription_failed' : 'credits_required',
          budget.reason === 'entitlement_unavailable' ? 503 : 402);
      }
      const result = await (deps.transcribe || dictation.transcribe)({ data: req.body, apiKey, config, signal: controller.signal });
      const costUsd = typeof result.usage.cost === 'number' && Number.isFinite(result.usage.cost) && result.usage.cost >= 0
        ? result.usage.cost : null;
      if (costUsd != null) await (deps.recordSpend || limits.recordSpend)(pool, userId, costUsd * 100, { byok: !included });
      void telemetry.record(pool, { provider: 'openrouter', backend: 'helper', component: 'dictation',
        userId, billingPath: included ? 'platform' : 'openrouter_byok',
        invocationKey: requestId, requestedModel: result.model, servedModel: result.model, durationMs: Date.now() - started, outcome: 'success',
        inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens,
        costUsd, costSource: costUsd == null ? 'unavailable' : 'provider_reported' });
      if (!controller.signal.aborted) res.json({ text: result.text, requestId, seconds: result.seconds });
      else if (!res.destroyed) res.status(504).json({ code: 'timeout', requestId });
    } catch (err) {
      const known = err instanceof dictation.DictationError;
      const code = controller.signal.aborted ? 'timeout' : known ? err.code : 'transcription_failed';
      if (!res.destroyed) res.status(controller.signal.aborted ? 504 : known ? err.status : 502).json({ code, requestId });
    } finally {
      clearTimeout(timeout); active.delete(userId); res.removeListener('close', disconnected);
    }
  }, (err, _req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ code: 'invalid_audio' });
    return next(err);
  });
  return router;
}

module.exports = { dictationRoutes };
