'use strict';

const { proxyActivities, sleep, CancellationScope, isCancellation } = require('@temporalio/workflow');

const activities = proxyActivities({
  startToCloseTimeout: '6 seconds',
  heartbeatTimeout: '1 second',
  retry: { initialInterval: '100 milliseconds', maximumInterval: '1 second' },
});

async function retire(work) {
  // Completion/absence is not creator termination. A durable retirement loop
  // keeps the resource intent discoverable; production compaction remains open.
  for (;;) {
    await activities.step('cleanup', work);
    await sleep('100 milliseconds');
  }
}

async function prepare(work, phases) {
  try {
    for (const phase of phases) {
      for (;;) {
        const result = await activities.step(phase, work);
        if (result.retired) return await retire(work);
        if (!result.pending && !result.busy) break;
        await sleep('100 milliseconds');
      }
    }
    await activities.finish(work);
  } catch (error) {
    if (!isCancellation(error)) throw error;
    await CancellationScope.nonCancellable(() => retire(work));
  }
}

async function prepareV1(work) {
  return prepare(work, ['reserve', 'clone', 'build', 'checks', 'publish']);
}

async function prepareV2(work) {
  return prepare(work, ['reserve', 'clone', 'audit', 'build', 'checks', 'publish']);
}

module.exports = { prepareV1, prepareV2 };
