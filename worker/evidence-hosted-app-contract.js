'use strict';

// A platform-owned app used only inside one isolated visual-evidence run.
// The row is inserted into the paired disposable databases and the runtime is
// removed with the rest of the pair. Its id is intentionally outside normal
// serial ranges; a collision makes fixture installation fail closed.
const HOSTED_APP_ID = 2147482999;
const HOSTED_APP_PROFILE = 'platform-hosted-app-bridge-v1';
const MANIFEST_KEY = 'usernode_evidence_fixture';

function exactRunId(value) {
  const runId = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(runId)) {
    throw new Error('Evidence hosted-app fixture requires an exact run id.');
  }
  return runId;
}

function hostedAppSlug(runId) {
  return `homeroom-evidence-${exactRunId(runId).slice(0, 16)}`;
}

function hostedAppManifest(runId) {
  return {
    [MANIFEST_KEY]: {
      version: 1,
      runId: exactRunId(runId),
      kind: 'hosted-app-bridge',
    },
  };
}

function isHostedAppFixture(app, runId) {
  let expected;
  try { expected = exactRunId(runId); } catch { return false; }
  const marker = app?.manifest_snapshot?.[MANIFEST_KEY];
  return Number(app?.id) === HOSTED_APP_ID
    && app?.slug === hostedAppSlug(expected)
    && marker?.version === 1
    && marker?.runId === expected
    && marker?.kind === 'hosted-app-bridge';
}

module.exports = {
  HOSTED_APP_ID,
  HOSTED_APP_PROFILE,
  MANIFEST_KEY,
  exactRunId,
  hostedAppSlug,
  hostedAppManifest,
  isHostedAppFixture,
};
