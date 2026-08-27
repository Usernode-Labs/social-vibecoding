'use strict';

const { Router } = require('express');
const { getPool } = require('../../db/pool');
const log = require('../../services/logger');
const { mobileTokenAuth } = require('../../middleware/topochain-auth');
const {
  revokeExactNativeSessionCredential,
} = require('../../services/native-session-revocation');
const { fail } = require('./helpers');
const {
  NativeSessionProtocol,
  NativeSessionProtocolError,
} = require('../../services/topochain/native-session-protocol');

const TICKET_PATH = '/api/v4/mobile/auth/native-establish-ticket';
const EXCHANGE_PATH = '/api/v4/mobile/auth/native-establish-exchange';
const LOGOUT_PATH = '/api/v4/mobile/auth/logout';

function sendExactJson(res, rawJson) {
  res.set('Cache-Control', 'no-store');
  return res.type('application/json').send(rawJson);
}

function nativeSessionRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const protocol = new NativeSessionProtocol({ pool, config });

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

  // Do not renew a credential that is being retired. A missing/revoked bearer
  // returns 401, which is the client's definitive-absence result.
  router.post(LOGOUT_PATH, mobileTokenAuth(config, { renewLease: false }), async (req, res) => {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await revokeExactNativeSessionCredential(client, {
        userId: req.user.id,
        attemptId: req.mobileAuth.attemptId,
        credentialReference: req.mobileAuth.credentialReference,
        credentialGeneration: req.mobileAuth.credentialGeneration,
        mobileAuthTokenId: req.mobileAuth.tokenId,
      });
      await client.query('COMMIT');
      return sendExactJson(res, '{"success":true}');
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => {});
      log.error('native-session-v2', 'POST native logout failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    } finally {
      client?.release();
    }
  });

  return router;
}

module.exports = {
  nativeSessionRoutes,
  TICKET_PATH,
  EXCHANGE_PATH,
  LOGOUT_PATH,
  sendExactJson,
};
