'use strict';

const { z } = require('zod');
const { mode } = require('../application-runtime');

function candidateResources(config, sessionId, attemptId) {
  z.number().int().positive().max(2147483647).parse(sessionId);
  const hex = z.string().uuid().parse(attemptId).replace(/-/g, '');
  const runtimeKind = mode(config);
  return {
    runtimeKind,
    runtimeName: `sv-p-${hex}`,
    dbName: `app_p_s${sessionId}_${hex}`,
    namespace: runtimeKind === 'kubernetes' ? config.kubernetes.appNamespace : null,
    attemptId,
    checkoutDir: `/tmp/usernode-preview-${hex}`,
    imageName: `usernode-preview-attempt:${hex}`,
  };
}

module.exports = { candidateResources };
