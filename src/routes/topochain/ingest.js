// Topochain v4 — ingest (SPEC §4.4, from source v2: onchain-accounts read +
// slot-outcomes / epoch-stats batch writes).
//
// Mounted in server.js BEFORE authMiddleware, alongside the other v2/v3
// service-to-service surfaces (internal, anthropic-proxy, app-llm, etc.):
// ingest callers are chain-side/backoffice services, not browser sessions.
// Task 7 decides + applies this group's auth (the source spec doesn't
// pin a single middleware for these two routes — see SPEC around the
// ingest section); this file is a placeholder mount point only.
//
// This module is a SKELETON for Task 3 (foundation): only the mount-order
// probe route exists. Task 7 replaces this file with the real endpoints
// (`GET /api/v4/onchain-accounts`, `POST /api/v4/slot-outcomes`,
// `POST /api/v4/epoch-stats`).
'use strict';

const { Router } = require('express');
const { ok } = require('./helpers');

function topochainIngestRoutes(_config) {
  const router = Router();

  // Mount-order probe (plan Task 3).
  router.get('/api/v4/ingest/__ping', (_req, res) => ok(res, {}));

  return router;
}

module.exports = { topochainIngestRoutes };
