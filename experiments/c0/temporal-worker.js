'use strict';

const { Worker, NativeConnection } = require('@temporalio/worker');
const { Context } = require('@temporalio/activity');
const { createSteps } = require('./steps');

async function run() {
  const config = JSON.parse(process.env.C0_CONFIG);
  const version = Number(process.env.C0_VERSION || 1);
  const steps = createSteps(config, 'temporal');
  const connection = await NativeConnection.connect({ address: config.temporalAddress });
  const worker = await Worker.create({
    connection,
    taskQueue: `${config.queue}-v${version}`,
    workflowsPath: require.resolve('./workflows'),
    maxConcurrentActivityTaskExecutions: 5,
    maxHeartbeatThrottleInterval: 100,
    stickyQueueScheduleToStartTimeout: '500 milliseconds',
    activities: {
      async step(stage, work) {
        const activity = Context.current();
        const heartbeat = setInterval(() => activity.heartbeat({ stage, workId: work.id }), 100);
        try {
          return await steps.step(stage, work, {
            workflowId: activity.info.workflowExecution.workflowId,
            runId: activity.info.workflowExecution.runId,
            activityId: activity.info.activityId,
            attempt: activity.info.attempt,
          });
        } finally {
          clearInterval(heartbeat);
        }
      },
      finish: steps.finish,
    },
  });
  process.send({ ready: true });
  await worker.run();
}

run().catch(error => { console.error(error); process.exit(1); });
