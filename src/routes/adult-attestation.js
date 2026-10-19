'use strict';

// "Are you 18 or older?" (#5095): the yes, recorded. Me-scoped, so mounted
// behind authMiddleware like the other /api/me routes. The rule and the
// routes it guards are described in src/services/adult-attestation.js.
//
//   POST /api/me/adult-attestation   "I'm 18 or older"; read back as
//                                    `adultAttested` on /api/auth/me

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const adultAttestation = require('../services/adult-attestation');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');

function adultAttestationRoutes(config, { pool = getPool(config) } = {}) {
  const router = Router();

  router.post('/api/me/adult-attestation', sameOriginBrowserOnly, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const attestedAt = await adultAttestation.attest(pool, req.user.id);
      res.json({ adultAttested: !!attestedAt, attestedAt });
    } catch (err) {
      log.error('adult-attestation', 'Failed to record the 18+ answer', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { adultAttestationRoutes };
