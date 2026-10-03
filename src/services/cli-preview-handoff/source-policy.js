'use strict';

function ordinaryNative(session) {
  return !!session && (session.source === null || session.source === undefined || session.source === 'native');
}

function supportedSource(session) {
  return session?.source === 'cli_handoff' || ordinaryNative(session);
}

function nativeAction(session, cliType) {
  return session?.source === 'cli_handoff' ? cliType : cliType.replace('Cli', 'Native');
}

function durableManifest(manifest) {
  return !!(manifest?.durableNative || manifest?.durableCli);
}

function manifestFlowId(manifest) {
  if (manifest?.previewFlowId && manifest?.cliFlowId && manifest.previewFlowId !== manifest.cliFlowId) {
    throw new Error('Conflicting preview flow identities');
  }
  return manifest?.previewFlowId || manifest?.cliFlowId;
}

module.exports = { ordinaryNative, supportedSource, nativeAction, durableManifest, manifestFlowId };
