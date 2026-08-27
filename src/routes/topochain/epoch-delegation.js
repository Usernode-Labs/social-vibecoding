'use strict';

const { Router } = require('express');
const { getPool } = require('../../db/pool');
const log = require('../../services/logger');
const { mobileTokenAuth, partnerApiKey } = require('../../middleware/topochain-auth');
const { ok, fail } = require('./helpers');
const {
  EpochDelegationError,
  EpochDelegationService,
} = require('../../services/topochain/epoch-delegations');

const NATIVE_DELEGATION_PATH = '/api/v4/mobile/native/delegation';
const MANAGED_DELEGATIONS_PATH = '/api/v1/delegations';

function sendError(res, error, operation) {
  if (error instanceof EpochDelegationError) {
    return fail(res, error.status, error.message, { code: error.code });
  }
  log.error('epoch-delegation', `${operation} failed`, { message: error.message });
  return fail(res, 500, 'Internal server error.');
}

function nativeEpochDelegationRoutes(config, { service } = {}) {
  const router = Router();
  const protocol = service || new EpochDelegationService({
    pool: getPool(config),
    config,
  });

  const auth = mobileTokenAuth(config);
  router.get(NATIVE_DELEGATION_PATH, auth, async (req, res) => {
    try {
      const data = await protocol.getNativePolicy({
        userId: req.user.id,
        mobileTokenId: req.mobileAuth.tokenId,
      });
      return ok(res, { data });
    } catch (error) {
      return sendError(res, error, 'GET native delegation');
    }
  });

  router.post(NATIVE_DELEGATION_PATH, auth, async (req, res) => {
    try {
      const data = await protocol.setNativePolicy({
        userId: req.user.id,
        mobileTokenId: req.mobileAuth.tokenId,
        body: req.body,
      });
      return ok(res, { data });
    } catch (error) {
      return sendError(res, error, 'POST native delegation');
    }
  });
  return router;
}

function managedEpochDelegationRoutes(config, { service } = {}) {
  const router = Router();
  const protocol = service || new EpochDelegationService({
    pool: getPool(config),
    config,
  });
  const auth = partnerApiKey(config);

  // This is the exact collection shape consumed by usernode's managed
  // producer poller: one authenticated response containing E, E+1 and E+2.
  router.get(MANAGED_DELEGATIONS_PATH, auth, async (_req, res) => {
    try {
      const response = await protocol.getManagedAssignments();
      return res.json(response);
    } catch (error) {
      return sendError(res, error, 'GET managed delegations');
    }
  });
  return router;
}

module.exports = {
  NATIVE_DELEGATION_PATH,
  MANAGED_DELEGATIONS_PATH,
  nativeEpochDelegationRoutes,
  managedEpochDelegationRoutes,
};
