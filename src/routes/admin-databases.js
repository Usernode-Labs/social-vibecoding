'use strict';

const { loadPolicy, createStore, submitRequest, publicRequest } = require('../services/database-control-plane');

// Mounted after adminMiddleware. Dependencies are injectable to exercise the
// actual HTTP boundary without loading the rest of the platform.
function registerDatabaseRoutes(router, { requireAdminWrite, getPolicy = loadPolicy, getStore = defaultStore }) {
  router.get('/api/admin/database-clusters', async (_req, res) => {
    try {
      const policy = getPolicy();
      if (!policy) return res.json({ enabled: false, targets: [], requests: [] });
      const requests = await getStore().list(policy.namespace);
      const placement = require('../services/database-placement');
      const selected = placement.loadSelection();
      const bindings = selected ? await placement.assertCentralPlacement([], { all: true }) : null;
      return res.json({ ...(bindings ? { bindings } : {}), enabled: true, targets: policy.targets.map(({ id, profile, displayName }) => ({ id, profile, ...(displayName ? { displayName } : {}) })),
        requests: requests.map(publicRequest) });
    } catch { return res.status(503).json({ error: 'Database control plane is unavailable' }); }
  });
  router.post('/api/admin/database-clusters', requireAdminWrite, async (req, res) => {
    try {
      const policy = getPolicy();
      if (!policy) return res.status(503).json({ error: 'Database control plane is disabled' });
      if (!req.body || Object.keys(req.body).some((key) => key !== 'target')
        || typeof req.body.target !== 'string' || !policy.targets.some((t) => t.id === req.body.target)) {
        return res.status(400).json({ error: 'Choose a configured database target' });
      }
      const request = await submitRequest(getStore(), policy, req.body.target, req.user.id);
      return res.status(202).json(publicRequest(request));
    } catch { return res.status(503).json({ error: 'Could not submit database request' }); }
  });
}

let store;
function defaultStore() {
  if (!store) {
    const k8s = require('@kubernetes/client-node');
    const config = new k8s.KubeConfig();
    config.loadFromCluster();
    store = createStore(config.makeApiClient(k8s.CustomObjectsApi));
  }
  return store;
}
module.exports = { registerDatabaseRoutes };
