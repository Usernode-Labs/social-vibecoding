const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_REQUEST_LIMIT_BYTES = 64 * 1024;
const DEFAULT_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const DEFAULT_RETRY_DELAY_MS = 100;
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504]);

function isPrivateHost(hostname) {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01]))/.test(hostname);
}

function upstreamOrigin(upstream) {
  if (/^https?:\/\//i.test(upstream)) return new URL(upstream);
  const hostname = upstream.replace(/:\d+$/, '');
  return new URL(`${isPrivateHost(hostname) ? 'http' : 'https'}://${upstream}`);
}

function jsonError(res, statusCode, error) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify({ error }));
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', body.length);
  res.setHeader('access-control-allow-origin', '*');
  res.end(body);
}

function collectRequestBody(req, res, limitBytes, callback) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limitBytes) {
    req.resume();
    jsonError(res, 413, 'Explorer request body too large');
    return;
  }

  const chunks = [];
  let size = 0;
  let finished = false;

  req.on('data', (chunk) => {
    if (finished) return;
    size += chunk.length;
    if (size > limitBytes) {
      finished = true;
      chunks.length = 0;
      req.resume();
      jsonError(res, 413, 'Explorer request body too large');
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (finished) return;
    finished = true;
    callback(chunks.length ? Buffer.concat(chunks, size) : null);
  });
  req.on('aborted', () => { finished = true; });
  req.on('error', () => {
    if (finished) return;
    finished = true;
    jsonError(res, 400, 'Could not read explorer request');
  });
}

function createExplorerProxy(options = {}) {
  const upstream = upstreamOrigin(
    options.upstream || process.env.EXPLORER_UPSTREAM ||
      'testnet-explorer.usernodelabs.org'
  );
  const upstreamBase = String(
    options.upstreamBase || process.env.EXPLORER_UPSTREAM_BASE || '/api'
  ).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const requestLimitBytes = options.requestLimitBytes || DEFAULT_REQUEST_LIMIT_BYTES;
  const responseLimitBytes = options.responseLimitBytes || DEFAULT_RESPONSE_LIMIT_BYTES;
  const retryDelayMs = options.retryDelayMs == null
    ? DEFAULT_RETRY_DELAY_MS
    : options.retryDelayMs;
  const log = options.log || require('./logger');
  const transport = upstream.protocol === 'http:' ? http : https;

  return function explorerProxy(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('allow', 'GET, POST');
      return jsonError(res, 405, 'Explorer method not allowed');
    }

    collectRequestBody(req, res, requestLimitBytes, (body) => {
      if (res.writableEnded) return;

      const subPath = req.url.replace(/^\/+/, '');
      const upstreamPath = `${upstreamBase}/${subPath}`;
      let completed = false;
      let activeUpstreamRequest = null;

      // Stop spending upstream work after the caller has gone away. `close`
      // also fires after an ordinary response, where writableEnded is true
      // and there is nothing left to cancel.
      res.once('close', () => {
        if (res.writableEnded) return;
        completed = true;
        activeUpstreamRequest?.destroy();
      });

      const finishError = (statusCode, message) => {
        if (completed) return;
        completed = true;
        jsonError(res, statusCode, message);
      };

      const scheduleRetry = (attempt, reason) => {
        log.debug('explorer-proxy', 'retrying transient upstream failure', {
          attempt: attempt + 1,
          reason,
        });
        setTimeout(() => runAttempt(attempt + 1), retryDelayMs);
      };

      const runAttempt = (attempt) => {
        if (completed || res.writableEnded || res.destroyed) return;
        let attemptSettled = false;
        let timedOut = false;

        const upReq = transport.request({
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || undefined,
          path: upstreamPath,
          method: req.method,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...(body ? { 'content-length': body.length } : {}),
          },
        }, (upRes) => {
          const chunks = [];
          let size = 0;
          let oversized = false;

          const declaredResponseSize = Number(upRes.headers['content-length']);
          if (Number.isFinite(declaredResponseSize) &&
              declaredResponseSize > responseLimitBytes) {
            attemptSettled = true;
            upRes.destroy();
            upReq.destroy();
            finishError(502, 'Explorer response too large');
            return;
          }

          upRes.on('data', (chunk) => {
            if (attemptSettled || oversized) return;
            size += chunk.length;
            if (size > responseLimitBytes) {
              oversized = true;
              attemptSettled = true;
              upRes.destroy();
              upReq.destroy();
              finishError(502, 'Explorer response too large');
              return;
            }
            chunks.push(chunk);
          });
          upRes.on('end', () => {
            if (attemptSettled || oversized || completed) return;
            attemptSettled = true;
            const statusCode = upRes.statusCode || 502;
            if (attempt === 0 && RETRYABLE_STATUS_CODES.has(statusCode)) {
              scheduleRetry(attempt, `HTTP ${statusCode}`);
              return;
            }

            completed = true;
            const responseBody = chunks.length ? Buffer.concat(chunks, size) : Buffer.alloc(0);
            res.statusCode = statusCode;
            res.setHeader(
              'content-type',
              upRes.headers['content-type'] || 'application/json'
            );
            res.setHeader('content-length', responseBody.length);
            res.setHeader('access-control-allow-origin', '*');
            res.end(responseBody);
          });
          const responseFailed = (err) => {
            if (attemptSettled || completed) return;
            attemptSettled = true;
            if (attempt === 0) return scheduleRetry(attempt, 'response error');
            log.warn('explorer-proxy', 'upstream response failed', { err: err.message });
            finishError(
              timedOut ? 504 : 502,
              timedOut ? 'Explorer upstream timed out' : 'Explorer temporarily unavailable'
            );
          };
          upRes.on('aborted', () => responseFailed(new Error('response aborted')));
          upRes.on('error', responseFailed);
        });
        activeUpstreamRequest = upReq;

        upReq.setTimeout(timeoutMs, () => {
          if (attemptSettled || completed) return;
          timedOut = true;
          upReq.destroy();
        });
        upReq.on('error', (err) => {
          if (attemptSettled || completed) return;
          attemptSettled = true;
          if (attempt === 0) {
            scheduleRetry(attempt, timedOut ? 'timeout' : 'transport error');
            return;
          }
          log.warn('explorer-proxy', 'upstream request failed', { err: err.message });
          finishError(
            timedOut ? 504 : 502,
            timedOut ? 'Explorer upstream timed out' : 'Explorer temporarily unavailable'
          );
        });

        if (body) upReq.write(body);
        upReq.end();
      };

      runAttempt(0);
    });
  };
}

module.exports = {
  createExplorerProxy,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_REQUEST_LIMIT_BYTES,
  DEFAULT_RESPONSE_LIMIT_BYTES,
};
