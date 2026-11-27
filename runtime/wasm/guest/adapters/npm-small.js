'use strict';
// Small npm packages often used beside Express, done here instead of bundled
// from node_modules (the tree has none): cors, body-parser, cookie-parser,
// dotenv, uuid, node-fetch, and compression, helmet and morgan, which change
// nothing an app answers and are no-ops.
const rt = require('../runtime.js');
const express = require('./express.js');

function cors(options) {
  const o = Object.assign({ origin: '*', methods: 'GET,HEAD,PUT,PATCH,POST,DELETE', preflightContinue: false, optionsSuccessStatus: 204 }, options || {});
  const list = (v) => (Array.isArray(v) ? v.join(',') : v);
  return function corsMiddleware(req, res, next) {
    const reqOrigin = req.headers.origin;
    let allow = o.origin;
    if (typeof allow === 'function') return allow(reqOrigin, (err, v) => { if (err) return next(err); apply(v); });
    apply(allow);
    function apply(v) {
      let origin = v;
      if (v === true) origin = reqOrigin;
      else if (v instanceof RegExp) origin = v.test(reqOrigin || '') ? reqOrigin : false;
      else if (Array.isArray(v)) origin = v.some((x) => (x instanceof RegExp ? x.test(reqOrigin || '') : x === reqOrigin)) ? reqOrigin : false;
      if (origin) res.set('Access-Control-Allow-Origin', origin);
      if (origin && origin !== '*') res.vary('Origin');
      if (o.credentials) res.set('Access-Control-Allow-Credentials', 'true');
      if (o.exposedHeaders) res.set('Access-Control-Expose-Headers', list(o.exposedHeaders));
      if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', list(o.methods));
        const h = o.allowedHeaders ? list(o.allowedHeaders) : req.headers['access-control-request-headers'];
        if (h) { res.set('Access-Control-Allow-Headers', h); if (!o.allowedHeaders) res.vary('Access-Control-Request-Headers'); }
        if (o.maxAge != null) res.set('Access-Control-Max-Age', String(o.maxAge));
        if (o.preflightContinue) return next();
        res.statusCode = o.optionsSuccessStatus;
        res.set('Content-Length', '0');
        return res.end();
      }
      next();
    }
  };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { v = decodeURIComponent(v); } catch (_) { /* as sent */ }
    if (v.startsWith('j:')) { try { v = JSON.parse(v.slice(2)); } catch (_) { /* as sent */ } }
    if (!(k in out)) out[k] = v;
  }
  return out;
}
function cookieParser(secret) {
  return function cookieParserMiddleware(req, _res, next) {
    if (req.cookies) return next();
    req.secret = Array.isArray(secret) ? secret[0] : secret;
    req.cookies = parseCookies(req.headers.cookie);
    req.signedCookies = {};
    next();
  };
}

const passThrough = () => (_req, _res, next) => next();
const bodyParser = { json: express.json, urlencoded: express.urlencoded, text: express.text, raw: express.raw };

const uuid = {
  v4: () => rt.randomUUID(),
  validate: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s)) || s === '00000000-0000-0000-0000-000000000000',
  NIL: '00000000-0000-0000-0000-000000000000',
  version: (s) => parseInt(String(s).charAt(14), 16),
};

const fetch = globalThis.fetch;
const nodeFetch = Object.assign((...a) => fetch(...a), { default: (...a) => fetch(...a), Headers, Request, Response, AbortError: Error, FetchError: Error });

const dotenv = { config: () => ({ parsed: {} }), parse: (src) => { const o = {}; for (const line of String(src).split('\n')) { const m = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/.exec(line); if (m) o[m[1]] = (m[2] || '').replace(/^(['"])(.*)\1$/, '$2'); } return o; } };

module.exports = {
  cors,
  cookieParser,
  bodyParser,
  compression: passThrough,
  helmet: Object.assign(passThrough, { contentSecurityPolicy: passThrough, hsts: passThrough, frameguard: passThrough }),
  morgan: passThrough,
  dotenv,
  uuid,
  nodeFetch,
};
