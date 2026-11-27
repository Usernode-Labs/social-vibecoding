'use strict';
// http / https: createServer(app) for apps that start their server that way;
// the runner hands each request to the handler. Outgoing requests: use fetch.
const rt = require('../runtime.js');
const express = require('./express.js');

function createServer(options, handler) {
  const fn = typeof options === 'function' ? options : handler;
  let app = fn && fn.__isApp ? fn : null;
  if (!app && fn) {
    // A plain (req, res) handler: run it inside an Express app so it gets req/res.
    app = express();
    app.use((req, res) => fn(req, res));
  }
  if (app) rt.serveWith(app);
  const server = {
    listen(...a) { const cb = a.find((x) => typeof x === 'function'); if (cb) rt.queueJob(() => cb.call(server)); return server; },
    close(cb) { if (cb) rt.queueJob(() => cb()); return server; },
    closeIdleConnections() {}, closeAllConnections() {},
    address() { return { address: '::', family: 'IPv6', port: Number(process.env.PORT || 3000) }; },
    on() { return server; }, once() { return server; }, off() { return server; }, emit() { return false; },
    setTimeout() { return server; }, ref() { return server; }, unref() { return server; },
    keepAliveTimeout: 5000, headersTimeout: 60000, requestTimeout: 300000, listening: true,
  };
  return server;
}
const unavailable = () => { throw new Error('http.request is not available in Wasm previews: use fetch'); };
module.exports = {
  createServer,
  request: unavailable,
  get: unavailable,
  Agent: class Agent {},
  globalAgent: {},
  STATUS_CODES: express.__statusText,
  METHODS: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
};
module.exports.default = module.exports;
