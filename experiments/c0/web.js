'use strict';

const http = require('node:http');
const { randomUUID, randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const { createSessionDecisionRuntime } = require('../../src/services/decision-runtime');
const { createPreviewFlow } = require('../../src/services/preview-flow');
const { candidateResources } = require('../../src/services/preview-flow/candidate-resources');
const { encrypt } = require('../../src/services/secrets');

const config = JSON.parse(process.env.C0_CONFIG);
const pool = new Pool({ connectionString: config.databaseUrl });
const runtime = createSessionDecisionRuntime(pool);
const preview = createPreviewFlow(pool);

// Experiment-only loopback ingress. No production route, authentication or
// scheduling changes. Accepted preview work and its handoff commit together.
const server = http.createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    const result = await runtime.transact(async transaction => {
      const accepted = await preview.applyInTransaction(transaction, {
        type: 'RequestCandidatePreview',
        actionId: input.actionId,
        sessionId: input.sessionId,
        headSha: input.headSha,
        startedStatus: input.startedStatus || 'active',
      });
      if (!accepted.decision.accepted) return accepted;
      const flow = accepted.decision.flow;
      const work = {
        id: flow.id,
        sessionId: input.sessionId,
        flow,
        version: input.version || 1,
        intent: candidateResources(config, input.sessionId, flow.attemptId),
        credentialEnc: encrypt(randomBytes(24).toString('hex'), config.dataEncryptionKey),
        preparedActionId: randomUUID(),
      };
      await transaction.withSession(input.sessionId, client => client.query(`INSERT INTO c0_work
        (id, input, backend, version) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [work.id, JSON.stringify(work), input.backend, work.version]));
      return { accepted: true, id: work.id };
    });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(500).end(JSON.stringify({ error: error.message }));
  }
});

server.listen(0, '127.0.0.1', () => process.send({ ready: true, port: server.address().port }));
