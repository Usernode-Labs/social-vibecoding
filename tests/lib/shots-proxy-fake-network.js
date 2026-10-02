'use strict';

// Test-only preload for the spawned shots proxy
// (tests/shots-origin-proxy-egress.test.js). Names resolve from FAKE_DNS
// instead of the network, and a connection to one of the FAKE_ROUTES
// addresses arrives at a local server instead. Every lookup, connection and
// pinned request is noted in FAKE_NOTES, never on stderr, which carries the
// proxy's own diagnostics.

const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');

const answers = JSON.parse(process.env.FAKE_DNS || '{}');
const routes = JSON.parse(process.env.FAKE_ROUTES || '{}');
const note = (entry) => fs.appendFileSync(process.env.FAKE_NOTES, `${JSON.stringify(entry)}\n`);

dns.promises.lookup = async (name, options) => {
  note({ resolve: name, all: options?.all === true, verbatim: options?.verbatim === true });
  if (!answers[name]) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  return answers[name].map((address) => ({ address, family: net.isIP(address) }));
};

// A CONNECT tunnel: note where the proxy connects, and route it locally.
const connect = net.connect;
net.connect = function fakeConnect(port, host, ...rest) {
  note({ connect: `${host}:${port}` });
  if (routes[host]) return connect.call(net, routes[host], '127.0.0.1', ...rest);
  return connect.call(net, port, host, ...rest);
};

// A forwarded HTTP request to a fake name: note the address the proxy's own
// lookup pins it to (both forms Node asks for), and route it locally.
const request = http.request;
http.request = function fakeRequest(target, options, callback) {
  if (!(target instanceof URL) || !answers[target.hostname]) return request.apply(http, arguments);
  const pinned = {};
  if (typeof options?.lookup === 'function') {
    options.lookup(target.hostname, {}, (_error, address) => { pinned.one = address; });
    options.lookup(target.hostname, { all: true }, (_error, list) => { pinned.all = list; });
  }
  note({ request: target.hostname, pinned });
  const port = routes[pinned.one];
  if (!port) throw new Error('an outside request was not pinned to a vetted address');
  return request.call(http, {
    host: '127.0.0.1', port, path: `${target.pathname}${target.search}`,
    method: options.method, headers: options.headers,
  }, callback);
};
