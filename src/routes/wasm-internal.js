'use strict';

// What the Wasm runners ask the platform for (runtime/wasm/README.md): a
// compiled-from-source module, by its SHA-256, when a pass names one the
// runner has not loaded yet. Only with the runners' token
// (WASM_RUNNER_TOKEN), which the platform put in their Secret
// (services/kubernetes.js ensureWasmBackends); a runner still checks that the
// bytes hash to the name it asked for.

const crypto = require('crypto');
const express = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const wasmRuntime = require('../services/wasm-runtime');
const wasmPreviews = require('../services/wasm-previews');

function tokenMatches(header) {
  const expected = process.env.WASM_RUNNER_TOKEN || '';
  const match = /^Bearer (.+)$/.exec(String(header || ''));
  if (expected.length < 32 || !match) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = function wasmInternalRoutes(config) {
  const router = express.Router();
  router.get('/internal/wasm/modules/:sha256', async (req, res) => {
    if (!wasmPreviews.deployOn(config)) return res.status(404).end();
    if (!tokenMatches(req.headers.authorization)) return res.status(401).end();
    try {
      const bytes = await wasmRuntime.moduleBytes(getPool(config), req.params.sha256);
      if (!bytes) return res.status(404).end();
      res.set('content-type', 'application/wasm');
      res.set('cache-control', 'no-store');
      return res.send(bytes);
    } catch (err) {
      log.error('wasm-internal', 'Module read failed', { err: err.message });
      return res.status(500).end();
    }
  });
  return router;
};
