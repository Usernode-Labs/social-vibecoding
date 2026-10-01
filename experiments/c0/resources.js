'use strict';

const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { event } = require('./database');

// Controlled external system: lives outside web/executor processes. Its durable
// objects and in-flight creates survive executor SIGKILL, just as cluster Jobs do.
// This is not a live Kubernetes, Docker or production-clone implementation.
async function createResources(pool) {
  const pending = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      const { rows } = await pool.query('SELECT policy FROM c0_faults WHERE work_id = $1', [input.workId]);
      const policy = rows[0]?.policy || {};
      if (policy.busy || policy.failAlways || policy.ioFailures > 0) {
        if (policy.ioFailures > 0) {
          policy.ioFailures--;
          await pool.query('UPDATE c0_faults SET policy = $2 WHERE work_id = $1', [input.workId, JSON.stringify(policy)]);
        }
        await event(pool, input.workId, 'external_retry', { busy: !!policy.busy });
        res.writeHead(503).end(JSON.stringify({ error: 'Retryable external failure' }));
        return;
      }

      let result;
      if (input.op === 'inspect') {
        result = (await pool.query('SELECT * FROM c0_objects WHERE name = $1', [input.name])).rows[0] || null;
      } else if (input.op === 'create') {
        const existing = (await pool.query('SELECT * FROM c0_objects WHERE name = $1', [input.name])).rows[0];
        if (existing) {
          if (existing.flow_id !== input.workId) throw new Error('External resource owner changed');
          result = existing;
        } else {
          await event(pool, input.workId, 'create_accepted', { name: input.name, kind: input.kind });
          if (policy.delayCreationKind === input.kind) {
            await new Promise(resolve => setTimeout(resolve, policy.delayCreationMs || 700));
          }
          const object = {
            ...input.body,
            ...(input.kind === 'check' ? { verdict: policy.failingTest ? 'failing' : 'passing' } : {}),
            state: input.kind === 'clone' && policy.partialClone ? 'partial'
              : input.kind === 'build' && policy.holdBuild ? 'running' : 'complete',
          };
          const uid = randomUUID();
          await pool.query(`INSERT INTO c0_objects (name, flow_id, kind, uid, body)
            VALUES ($1, $2, $3, $4, $5) ON CONFLICT (name) DO NOTHING`,
            [input.name, input.workId, input.kind, uid, JSON.stringify(object)]);
          result = (await pool.query('SELECT * FROM c0_objects WHERE name = $1', [input.name])).rows[0];
          await event(pool, input.workId, 'created', { name: input.name, kind: input.kind, uid: result.uid });
          if (policy.loseAckKind === input.kind) {
            await pool.query(`UPDATE c0_faults SET policy = policy - 'loseAckKind' WHERE work_id = $1`, [input.workId]);
            res.destroy();
            return;
          }
          if (policy.holdAckKind === input.kind) {
            await new Promise(resolve => setTimeout(resolve, policy.holdAckMs || 2000));
          }
        }
      } else if (input.op === 'remove') {
        const removed = await pool.query(`DELETE FROM c0_objects WHERE name = $1
          AND flow_id = $2 AND uid = $3 RETURNING name`, [input.name, input.workId, input.uid]);
        if (!removed.rows.length) {
          const present = (await pool.query('SELECT 1 FROM c0_objects WHERE name = $1', [input.name])).rows.length;
          if (present) throw new Error('External deletion ownership changed');
        }
        await event(pool, input.workId, 'removed', { name: input.name });
        result = { removed: true };
      } else {
        throw new Error('Unknown external operation');
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(409).end(JSON.stringify({ error: error.message }));
    }
  });

  server.on('request', (_req, res) => {
    pending.add(res);
    res.once('close', () => pending.delete(res));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const response of pending) response.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = { createResources };
