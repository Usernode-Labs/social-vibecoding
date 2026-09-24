'use strict';
const { requireAdminWrite } = require('../middleware/admin');
const BASE = '/api/admin/database-migrations';
function registerMigrationRoutes(app, service, { origin, batches }) {
  const write = [requireAdminWrite, (req, res, next) => {
    // This standalone cookie-authenticated service accepts same-origin JSON only.
    if (req.get('origin') !== origin || !req.is('application/json')) return res.status(403).json({ error: 'Same-origin JSON request required' });
    next();
  }];
  const handler = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : 'Migration service unavailable; inspect current status before retrying' }); }
  };
  if(batches){
    app.get(BASE+'/batches',handler(async(req,res)=>res.json({...await batches.inventory(),canWrite:req.user.canAdminWrite})));
    app.post(BASE+'/batches/plan',...write,handler(async(req,res)=>res.json(await batches.plan(req.body,req.user.id))));
    app.post(BASE+'/batches/:id/start',...write,handler(async(req,res)=>res.status(202).json(await batches.start(req.params.id,req.body,req.user.id))));
    app.post(BASE+'/batches/:id/action',...write,handler(async(req,res)=>res.status(202).json(await batches.action(req.params.id,req.body))));
  }
  app.get(BASE, handler(async (req, res) => res.json({ ...await service.inventory(), canWrite: req.user.canAdminWrite })));
  app.post(BASE + '/plan', ...write, handler(async (req, res) => res.json(await service.plan(req.body))));
  app.post(BASE, ...write, handler(async (req, res) => res.status(202).json(await service.submit(req.body, req.user.id))));
  app.post(BASE + '/:id/action', ...write, handler(async (req, res) => res.status(202).json(await service.action(req.params.id, req.body))));
}
module.exports = { registerMigrationRoutes };
