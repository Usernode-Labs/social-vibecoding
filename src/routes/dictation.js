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
  const pool = deps.pool || getPool();
  const timeoutMs = deps.timeoutMs ?? 45000;
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
    // One at a time per person, on any process; a crash's claim lapses a
    // minute after the request would have timed out.
    let claimId;
    try {
      claimId = await dictation.claim(pool, userId, timeoutMs + 60000);
    } catch {
      return res.status(503).json({ code: 'transcription_failed' });
    }
    if (!claimId) return res.status(429).json({ code: 'busy' });
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    let reply;
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
      reply = !controller.signal.aborted
        ? [200, { text: result.text, requestId, seconds: result.seconds }]
        : [504, { code: 'timeout', requestId }];
    } catch (err) {
      const known = err instanceof dictation.DictationError;
      const code = controller.signal.aborted ? 'timeout' : known ? err.code : 'transcription_failed';
      reply = [controller.signal.aborted ? 504 : known ? err.status : 502, { code, requestId }];
    } finally {
      clearTimeout(timeout); res.removeListener('close', disconnected);
      // Free before answering: a retry the answer prompts finds it free.
      await dictation.release(pool, userId, claimId).catch(() => {});
    }
    if (!res.destroyed) res.status(reply[0]).json(reply[1]);
  }, (err, _req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ code: 'invalid_audio' });
    return next(err);
  });
  return router;
}

module.exports = { dictationRoutes };
