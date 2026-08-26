'use strict';

const { Router } = require('express');
const { getPool } = require('../../db/pool');
const log = require('../../services/logger');
const { fail } = require('./helpers');
const {
  NativeSessionProtocol,
  NativeSessionProtocolError,
} = require('../../services/topochain/native-session-protocol');

const TICKET_PATH = '/api/v4/mobile/auth/native-establish-ticket';
const EXCHANGE_PATH = '/api/v4/mobile/auth/native-establish-exchange';

function sendExactJson(res, rawJson) {
  res.set('Cache-Control', 'no-store');
  return res.type('application/json').send(rawJson);
}

function nativeSessionRoutes(config) {
  const router = Router();
  const protocol = new NativeSessionProtocol({ pool: getPool(config), config });

  // Protocol 2 is deployment-dark unless an operator pins the exact canonical
  // Rust testnet ChainId. A generic 404 neither advertises a partial rollout
  // nor falls back to a legacy bearer/wallet authority.
  if (!protocol.enabled) {
    router.post([TICKET_PATH, EXCHANGE_PATH], (_req, res) => fail(res, 404, 'Not found.'));
    return router;
  }

  router.post(TICKET_PATH, async (req, res) => {
    try {
      const rawJson = await protocol.createTicket({
        sessionToken: req.cookies?.session,
        body: req.body,
      });
      return sendExactJson(res, rawJson);
    } catch (err) {
      if (err instanceof NativeSessionProtocolError) {
        return fail(res, err.status, err.message, { code: err.code });
      }
      log.error('native-session-v2', 'POST native-establish-ticket failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  router.post(EXCHANGE_PATH, async (req, res) => {
    try {
      const rawJson = await protocol.exchange({ body: req.body });
      return sendExactJson(res, rawJson);
    } catch (err) {
      if (err instanceof NativeSessionProtocolError) {
        return fail(res, err.status, err.message, { code: err.code });
      }
      log.error('native-session-v2', 'POST native-establish-exchange failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = { nativeSessionRoutes, TICKET_PATH, EXCHANGE_PATH, sendExactJson };
