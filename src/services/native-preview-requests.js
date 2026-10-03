'use strict';

// Ordinary native policy uses the established owner; no CLI upload fields or
// second continuation/settlement/retirement implementation are involved.
const { selectedManual, enrolled } = require('./cli-preview-handoff/work');
const { createHash } = require('node:crypto');
const { ordinaryNative } = require('./cli-preview-handoff/source-policy');

async function ownsManualRequests(pool, config, session) {
  return ordinaryNative(session) && (selectedManual(config, session) || await enrolled(pool, session.id));
}

// One normalized metadata submission is one durable check intent. Explicit
// same-specification reruns instead carry a caller-generated UUID.
function metadataRecheckId(sessionId, headSha, metadataKey, previousIntent) {
  const hash = createHash('sha256').update(JSON.stringify({
    sessionId, headSha, metadataKey, previousIntent,
  })).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

module.exports = { ownsManualRequests, metadataRecheckId, createNativePreviewWork: (...args) => require('./cli-preview-handoff/work').createCliHandoffWork(...args) };
