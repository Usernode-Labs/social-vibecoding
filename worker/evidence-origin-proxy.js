#!/usr/bin/env node
'use strict';

// Mandatory egress boundary for evidence-browser MCP servers. Playwright's
// allowed-origins option is useful filtering but explicitly is not a security
// boundary; this proxy independently rejects every HTTP request and CONNECT
// tunnel whose exact origin is not one of the paired internal app origins.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

let origins;
try {
  origins = new Set(JSON.parse(process.env.EVIDENCE_ALLOWED_ORIGINS || '[]').map((value) => new URL(value).origin));
} catch {
  origins = new Set();
}
if (origins.size !== 2) {
  process.stderr.write('Evidence proxy requires exactly two allowed origins.\n');
  process.exit(1);
}
const authorities = new Set([...origins].map((origin) => {
  const url = new URL(origin);
  return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
}));
const port = Number(process.env.EVIDENCE_PROXY_PORT || 17891);
const readyFile = process.env.EVIDENCE_PROXY_READY || '';

function reject(socketOrResponse, code = 403) {
  if (typeof socketOrResponse.writeHead === 'function') {
    socketOrResponse.writeHead(code, { 'content-type': 'text/plain', connection: 'close' });
    socketOrResponse.end('Blocked by visual-evidence origin policy.');
  } else {
    socketOrResponse.end(`HTTP/1.1 ${code} Forbidden\r\nConnection: close\r\n\r\n`);
  }
}

const server = http.createServer((req, res) => {
  let target;
  try {
    target = new URL(req.url);
  } catch {
    try { target = new URL(req.url || '/', `http://${req.headers.host}`); }
    catch { return reject(res, 400); }
  }
  if (!origins.has(target.origin)) return reject(res);
  const headers = { ...req.headers, host: target.host };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  const transport = target.protocol === 'https:' ? https : http;
  const upstream = transport.request(target, { method: req.method, headers }, (upstreamResponse) => {
    res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(res);
  });
  upstream.on('error', () => reject(res, 502));
  req.pipe(upstream);
});

server.on('connect', (req, client, head) => {
  const authority = String(req.url || '').toLowerCase();
  if (!authorities.has(authority)) return reject(client);
  const split = authority.lastIndexOf(':');
  const host = authority.slice(0, split);
  const targetPort = Number(authority.slice(split + 1));
  const upstream = net.connect(targetPort, host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
});

server.listen(port, '127.0.0.1', () => {
  if (readyFile) fs.writeFileSync(readyFile, String(process.pid), { mode: 0o600 });
});

function stop() {
  if (readyFile) { try { fs.unlinkSync(readyFile); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
