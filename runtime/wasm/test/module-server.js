'use strict';
// The platform's module endpoint, for tests: GET /<sha256> answers the
// module stored under that name, with the runner token as bearer.
//   node module-server.js <dir> <port> <token file>
const fs = require('fs');
const http = require('http');
const path = require('path');
const [dir, port, tokenFile] = process.argv.slice(2);
const token = fs.readFileSync(tokenFile, 'utf8').trim();
http.createServer((req, res) => {
  // A slow outside service for the fetch test: answers after 300 ms.
  if (req.url.startsWith('/slow')) {
    const n = new URL(req.url, 'http://x').searchParams.get('n');
    return setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ n })); }, 300);
  }
  const name = req.url.slice(1);
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end(); }
  if (!/^[0-9a-f]{64}$/.test(name) || !fs.existsSync(path.join(dir, name))) { res.writeHead(404); return res.end(); }
  const b = fs.readFileSync(path.join(dir, name));
  res.writeHead(200, { 'content-type': 'application/wasm', 'content-length': b.length });
  res.end(b);
}).listen(Number(port), () => console.log(`module server on ${port}`));
