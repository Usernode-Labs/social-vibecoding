'use strict';

// Fence pre-deploy parent tabs whose relay did not bind requests to the
// frame's app and origin. This public protocol version grants no authority:
// session authentication and each route's app/user checks still apply.
function currentAppBridge(req, res, next) {
  if (req.get('X-Usernode-App-Bridge') !== 'isolated-v2') {
    res.set('Cache-Control', 'private, no-store');
    return res.status(403).json({ code: 'bridge_refresh_required', error: 'Reload Homeroom to use this app feature.' });
  }
  next();
}

module.exports = { currentAppBridge };
