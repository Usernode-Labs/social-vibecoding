'use strict';

const { Router } = require('express');
const log = require('../services/logger');
const { explorerProxyLimiter } = require('../middleware/rate-limits');

// The explorer passthrough, lifted out of server.js so it can be tested.
//
// Social owns transaction receipt observation. Its trusted top-frame bridge
// observes both direct and relayed embedded-dapp submissions through
// `GET /explorer-api/active_chain` + `POST /explorer-api/<chain>/transactions`
// after native submission returns an authoritative txId. On per-dapp
// subdomains the dapp template server (`proxyExplorer`) proxies that prefix to
// the explorer; on the launcher origin the path used to fall through the JWT
// gate and 302 to /login.html, so observation received HTML instead of
// explorer JSON. Mounting the same public passthrough here — before the JSON
// body parser so the raw body streams through, and before authMiddleware so
// it isn't redirected — makes receipt observation work without giving Flutter
// explorer authority. Matches the documented
// PUBLIC_PREFIXES = ['/explorer-api/'] convention
// (src/prompts/app-conventions.md).
//
// #2505 — WHAT WAS WRONG WITH IT.
//
// Being public is deliberate and stays. Being public AND unbounded was not:
//
//   const chunks = [];
//   req.on('data', (c) => chunks.push(c));
//   req.on('end', () => { ... Buffer.concat(chunks) ... });
//
// Nothing capped that array. It is mounted ahead of authMiddleware and ahead
// of the global `express.json()` — which is the whole point, since the body
// must stream through unparsed — so it inherited no limit from either. Any
// anonymous caller could POST an endless body and the platform would hold
// every byte in memory until the process died. No credential, no rate limit,
// nothing to stop a second attempt.
//
// The real payloads are a chain name and a transaction id. `MAX_BODY` is
// four orders of magnitude above that and still refuses anything that could
// matter.
//
// Four more bounds, each closing a way to spend the platform's resources
// from outside:
//
//   - the UPSTREAM's response was buffered just as unboundedly. A compromised
//     or merely misbehaving explorer could exhaust this process through a
//     path no caller here controls.
//   - there was no TIMEOUT, so a slow upstream pinned a socket and the
//     request's memory for as long as it liked.
//   - there was no RATE LIMIT on an endpoint that makes an outbound request
//     per call. Keyed by IP, because there is no user to key on.
//   - every METHOD was forwarded. The two documented surfaces are a GET and
//     a POST; DELETE and PUT were reaching the explorer with nothing here
//     intending them to.
//
// And one that is not a resource bound at all: `req.url` was pasted into the
// upstream path after stripping only leading slashes, so `..%2f` or a literal
// `../` walked out of EXPLORER_UPSTREAM_BASE and addressed the explorer's
// other routes through a proxy that answers `access-control-allow-origin: *`.

// A chain name plus a transaction id. 64 kB is far more than that shape ever
// needs and far less than a body worth worrying about.
const MAX_BODY = 64 * 1024;
// The explorer's own answers are small JSON documents.
const MAX_RESPONSE = 1024 * 1024;
// Node's `timeout` request option is an INACTIVITY timeout, not a deadline:
// an upstream that trickles one byte every nine seconds satisfies it forever.
// Both are needed — the inactivity one to notice a dead socket quickly, and
// the absolute one to bound the request no matter how the bytes are paced.
const UPSTREAM_IDLE_TIMEOUT_MS = 10_000;
const UPSTREAM_DEADLINE_MS = 30_000;
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);
// OPTIONS is answered HERE rather than forwarded. This handler replies with
// `access-control-allow-origin: *`, so a cross-origin POST carrying
// `content-type: application/json` is preflighted by the browser — and the
// old transparent proxy forwarded that preflight upstream. Refusing it with
// a bare 405 would mean the browser never issues the POST at all, which is a
// regression the method allow-list would otherwise have introduced.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600',
};

// Reject a path that tries to climb out of EXPLORER_UPSTREAM_BASE. Both the
// literal and the percent-encoded forms, and a backslash too, because what
// normalizes them is the upstream rather than anything here.
function isTraversal(subPath) {
  let decoded = subPath;
  try { decoded = decodeURIComponent(subPath); } catch { /* keep the raw form */ }
  const candidates = [subPath, decoded];
  return candidates.some((p) => /(^|[/\\])\.\.([/\\]|$)/.test(p));
}

function explorerProxyRoutes(config = {}) {
  const router = Router();

  const upstream = config.explorerUpstream
    || process.env.EXPLORER_UPSTREAM || 'testnet-explorer.usernodelabs.org';
  const upstreamBase = config.explorerUpstreamBase
    || process.env.EXPLORER_UPSTREAM_BASE || '/api';
  const useHttp = process.env.EXPLORER_USE_HTTP === 'true'
    || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01]))/.test(
      upstream.replace(/:\d+$/, '')
    );

  router.use('/explorer-api', explorerProxyLimiter, (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }
    if (!ALLOWED_METHODS.has(req.method)) {
      return res.status(405).set(CORS_HEADERS).type('application/json')
        .send(JSON.stringify({ error: 'Method not allowed' }));
    }

    const transport = useHttp ? require('http') : require('https');
    // req.url is the path *after* the /explorer-api mount point, e.g.
    // "/active_chain" or "/<chain>/transactions" (query string preserved).
    const subPath = req.url.replace(/^\/+/, '');
    if (isTraversal(subPath)) {
      return res.status(400).type('application/json')
        .send(JSON.stringify({ error: 'Invalid path' }));
    }
    const upstreamPath = `${upstreamBase}/${subPath}`;
    const [hostname, portStr] = upstream.split(':');
    const port = portStr ? Number(portStr) : useHttp ? 80 : 443;

    const chunks = [];
    let size = 0;
    let aborted = false;

    // Refuse as soon as the cap is passed rather than after the body has
    // finished arriving — the point is not to hold it.
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY) {
        aborted = true;
        log.warn('explorer-proxy', 'Request body over cap', { size });
        res.status(413).type('application/json')
          .send(JSON.stringify({ error: 'Request body too large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on('end', () => {
      if (aborted) return;
      const bodyBuf = chunks.length ? Buffer.concat(chunks) : null;
      // Assigned once the deadline timer exists; called from every terminal
      // path, including ones that fire before that assignment.
      let finish = () => {};
      const upReq = transport.request(
        {
          hostname,
          port,
          path: upstreamPath,
          method: req.method,
          timeout: UPSTREAM_IDLE_TIMEOUT_MS,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...(bodyBuf ? { 'content-length': bodyBuf.length } : {}),
          },
        },
        (upRes) => {
          // #2505: destroying `upReq` also aborts THIS stream, and an
          // unhandled 'error' on an IncomingMessage is an uncaught exception
          // — i.e. the timeout path below could take the process down
          // instead of answering 502.
          upRes.on('error', (err) => {
            log.warn('explorer-proxy', 'upstream response aborted', { err: err.message });
            finish();
            if (!res.headersSent) {
              res.status(502).type('application/json')
                .send(JSON.stringify({ error: 'Explorer proxy error' }));
            }
          });
          const rChunks = [];
          let rSize = 0;
          let rAborted = false;
          upRes.on('data', (c) => {
            if (rAborted) return;
            rSize += c.length;
            if (rSize > MAX_RESPONSE) {
              rAborted = true;
              log.warn('explorer-proxy', 'Upstream response over cap', { rSize });
              upRes.destroy();
              if (!res.headersSent) {
                res.status(502).type('application/json')
                  .send(JSON.stringify({ error: 'Explorer response too large' }));
              }
              return;
            }
            rChunks.push(c);
          });
          upRes.on('end', () => {
            finish();
            if (rAborted || res.headersSent) return;
            res.writeHead(upRes.statusCode || 502, {
              'content-type': upRes.headers['content-type'] || 'application/json',
              'access-control-allow-origin': '*',
            });
            res.end(Buffer.concat(rChunks));
          });
        }
      );
      // The absolute deadline. Cleared on every terminal path so a healthy
      // request does not hold a timer for its full duration.
      const deadline = setTimeout(() => {
        log.warn('explorer-proxy', 'upstream past deadline', { upstreamPath });
        upReq.destroy(new Error('upstream exceeded deadline'));
      }, UPSTREAM_DEADLINE_MS);
      deadline.unref?.();
      finish = () => clearTimeout(deadline);

      upReq.on('timeout', () => {
        log.warn('explorer-proxy', 'upstream idle timeout', { upstreamPath });
        upReq.destroy(new Error('upstream timed out'));
      });
      upReq.on('error', (err) => {
        finish();
        log.error('explorer-proxy', 'upstream error', { err: err.message });
        if (!res.headersSent) {
          res.status(502).type('text/plain').send(`Explorer proxy error: ${err.message}`);
        }
      });
      upReq.on('close', () => finish());
      if (bodyBuf) upReq.write(bodyBuf);
      upReq.end();
    });
  });

  return router;
}

module.exports = {
  explorerProxyRoutes,
  isTraversal,
  MAX_BODY,
  MAX_RESPONSE,
  UPSTREAM_IDLE_TIMEOUT_MS,
  UPSTREAM_DEADLINE_MS,
  ALLOWED_METHODS,
  CORS_HEADERS,
};
