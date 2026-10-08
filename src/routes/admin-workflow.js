'use strict';

// The admin console's Workflows section (features/admin/admin-workflows.tsx):
// what the workflow machines are doing and what needs a person. Reads are
// open to every admin and work with the runtime off (the tables are always
// there); actions need a full admin and the running runtime, and are events
// on the instance's timeline, never row edits. src/workflow/platform.ts.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
const log = require('../services/logger');

const kernel = () => require('../workflow/kernel/index.ts');
const platform = () => require('../workflow/platform.ts');

const text = (v, max = 256) => (typeof v === 'string' && v.length && v.length <= max ? v : null);
const positiveInt = (v) => (/^\d+$/.test(String(v ?? '')) ? Number(v) : null);

function adminWorkflowRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  router.use('/api/admin/workflow', adminMiddleware);

  const fail = (res, err, what) => {
    if (err instanceof platform().AdminActionError) return res.status(err.status).json({ error: err.message });
    log.error('admin-workflow', `${what} failed`, { message: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  };

  // The top of the section: problems first, then counts per state.
  router.get('/api/admin/workflow', async (req, res) => {
    try {
      const { inspect } = kernel();
      const [problems, counts] = await Promise.all([inspect.problems(pool), inspect.stateCounts(pool)]);
      res.json({ running: platform().workflowRunning(), actions: platform().adminEvents(), problems, counts });
    } catch (err) { fail(res, err, 'Workflow overview'); }
  });

  router.get('/api/admin/workflow/instances', async (req, res) => {
    try {
      const instances = await kernel().inspect.listInstances(pool, {
        machine: text(req.query.machine) || undefined,
        state: text(req.query.state) || undefined,
        flag: text(req.query.flag) || undefined,
        appId: positiveInt(req.query.appId) || undefined,
        before: text(req.query.before) || undefined,
        limit: positiveInt(req.query.limit) || 50,
      });
      res.json({ instances });
    } catch (err) { fail(res, err, 'Workflow instance list'); }
  });

  // One instance: row, timeline and work. Machine and key travel as query
  // parameters because keys carry colons (`issue:42`).
  router.get('/api/admin/workflow/instance', async (req, res) => {
    const machine = text(req.query.machine);
    const key = text(req.query.key);
    if (!machine || !key) return res.status(400).json({ error: 'machine and key are required' });
    try {
      const detail = await kernel().inspect.instance(pool, machine, key, {
        beforeId: positiveInt(req.query.beforeId) || undefined,
      });
      if (!detail.instance && !detail.events.length) return res.status(404).json({ error: 'No such instance' });
      res.json(detail);
    } catch (err) { fail(res, err, 'Workflow instance'); }
  });

  // Release a faulted instance: retry its faulted event, or skip it.
  router.post('/api/admin/workflow/release', requireAdminWrite, async (req, res) => {
    const { machine, key, mode } = req.body || {};
    if (!text(machine) || !text(key) || !['retry', 'skip'].includes(mode)) {
      return res.status(400).json({ error: 'machine, key and mode (retry | skip) are required' });
    }
    try {
      res.json(await platform().adminRelease(machine, key, mode, req.user));
    } catch (err) { fail(res, err, 'Workflow release'); }
  });

  // Append one of the machine's admin events (re-check now, apply, retry a
  // follow-up) and answer with its outcome.
  router.post('/api/admin/workflow/event', requireAdminWrite, async (req, res) => {
    const { machine, key, type, payload } = req.body || {};
    if (!text(machine) || !text(key) || !text(type, 64)) {
      return res.status(400).json({ error: 'machine, key and type are required' });
    }
    try {
      const outcome = await platform().adminEvent(machine, key, type,
        payload && typeof payload === 'object' ? payload : {}, req.user);
      res.status(outcome.status === 'pending' ? 202 : 200).json(outcome);
    } catch (err) { fail(res, err, 'Workflow admin event'); }
  });

  return router;
}

module.exports = { adminWorkflowRoutes };
