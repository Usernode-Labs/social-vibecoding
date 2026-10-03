'use strict';

// Ordinary native policy uses the established owner; no CLI upload fields or
// second continuation/settlement/retirement implementation are involved.
const { selectedManual, enrolled } = require('./cli-preview-handoff/work');
const { ordinaryNative } = require('./cli-preview-handoff/source-policy');

async function ownsManualRequests(pool, config, session) {
  return ordinaryNative(session) && (selectedManual(config, session) || await enrolled(pool, session.id));
}

module.exports = { ownsManualRequests, createNativePreviewWork: (...args) => require('./cli-preview-handoff/work').createCliHandoffWork(...args) };
