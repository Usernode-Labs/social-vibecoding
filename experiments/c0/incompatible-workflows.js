'use strict';

const { proxyActivities } = require('@temporalio/workflow');
const activities = proxyActivities({ startToCloseTimeout: '6 seconds' });

// Deliberately incompatible replacement of an existing workflow type. The replay
// regression must reject this; editing active history is not a deployment plan.
async function prepareV1(work) {
  await activities.changedFirstStep(work);
}

module.exports = { prepareV1 };
