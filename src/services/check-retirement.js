'use strict';

const { durableManifest, manifestFlowId } = require('./cli-preview-handoff/source-policy');

const checkRuns = require('./check-runs');
const kubernetes = require('./kubernetes');

// The lifecycle/harvester already owns execution. This service journals only
// that run's destructive cleanup; it cannot admit Jobs or publish verdicts.
async function retire(config, pool, sessionId, runId) {
  const row = await checkRuns.read(pool, runId, sessionId);
  if (!row) throw new Error('Checks retirement requires its recovery manifest');
  const manifest = row.manifest;
  manifestFlowId(manifest); // Reject conflicting identity before destructive I/O.
  if (!durableManifest(manifest)) throw new Error('Durable retirement requires enrolled checks');

  let journal = manifest.retirement || null;
  const captureRequired = manifest.launched && !(manifest.shotsOnly && !manifest.media);
  const unitRequired = manifest.launched
    && !(manifest.unitSuite?.version === 1 && manifest.unitSuite.state === 'not-required');
  const result = await kubernetes.retireCheckResources(config, sessionId, runId, {
    journal,
    unitReceipt: manifest.unitSuite?.job || null,
    async persist(next) {
      await checkRuns.recordRetirement(pool, runId, sessionId, journal, next);
      journal = next;
    },
  });
  const released = kind => result.jobs.some(job => job.kind === kind && job.stage === 'released');
  let why = null;
  if (manifest.reconstruction) why = 'original launch specification unavailable';
  else if (!manifest.launched) why = 'launch manifest incomplete';
  else if (captureRequired && !released('capture')) why = 'capture creation unconfirmed';
  else if (unitRequired && !released('unit-suite')) why = 'unit-suite creation unconfirmed';
  if (why === null) await checkRuns.recordPreviewRelease(pool, row, result, { captureRequired, unitRequired });
  return { complete: why === null, why };
}

module.exports = { retire };
