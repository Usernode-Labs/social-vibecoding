'use strict';

const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { appPlatformAuth } = require('../middleware/app-llm-auth');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { STOCK_PROVIDERS, STOCK_ERRORS, STOCK_SAMPLE } = require('../services/stock-sample');

// App-facing stock photo search (request #7042, the first part of #6457).
//
//   GET /api/app-stock/v1/search?q=&provider=&page=&perPage=
//
// The one place an app's server asks Homeroom for free stock photos, so no
// app holds a photo service's key and nobody using an app is asked for one.
//
// THIS VERSION ANSWERS WITH FIXED SAMPLES. It reads no key and calls no
// outside service: every search gets the same six made-up rows from
// services/stock-sample.js, marked `sample: true`, in the shape real results
// will have. When real services are added, their keys are the platform's own
// variables (platform_env), never a project's dapp.json secrets, and the
// codes in STOCK_ERRORS are the ones they answer with.
//
// Auth is appPlatformAuth with a required user token, the same as the user
// directory and the members list in routes/app-platform-api.js: the app's
// token plus the forwarded token of the signed-in person, behind the
// private-IP gate. A staging preview holds no app token, so the person's
// token alone is accepted too; it names the app it was minted for. Every
// search is therefore attributable to one person in one app, which is what
// the limiter keys on.
//
// `q` is validated and echoed back, and never logged: it is what a person
// typed.

const API_V1_ROOT = '/api/app-stock/v1';

const MAX_QUERY_LENGTH = 100;
const DEFAULT_PER_PAGE = 15;
const MAX_PER_PAGE = 40;
const SEARCHES_PER_MINUTE = 60;

function fail(res, code, extra) {
  const { status, message } = STOCK_ERRORS[code];
  return res.status(status).json({ ok: false, code, message, ...extra });
}

// A query value given twice arrives as an array, and `q[a]=b` as an object:
// neither is the one string the contract names.
function oneString(value) {
  return typeof value === 'string' ? value : null;
}

// Whole numbers only: "2abc" and "1.5" are refused, not read as 2 and 1.
function wholeNumber(value) {
  const s = oneString(value);
  if (s === null || !/^\d{1,9}$/.test(s.trim())) return null;
  return parseInt(s.trim(), 10);
}

// Returns { query, provider, page, perPage } or { error: <code> }.
function readSearch(query = {}) {
  const q = oneString(query.q);
  const trimmed = q === null ? '' : q.trim();
  if (!trimmed || trimmed.length > MAX_QUERY_LENGTH) return { error: 'invalid_query' };

  let provider = 'all';
  if (query.provider !== undefined && query.provider !== '') {
    provider = oneString(query.provider);
    if (provider !== 'all' && !STOCK_PROVIDERS.includes(provider)) {
      return { error: 'invalid_provider' };
    }
  }

  let page = 1;
  if (query.page !== undefined && query.page !== '') {
    page = wholeNumber(query.page);
    if (page === null || page < 1) return { error: 'invalid_page' };
  }

  // Clamped, never refused: a page size is a preference, and an app that
  // asks for too many still gets a useful page.
  let perPage = wholeNumber(query.perPage);
  if (perPage === null) perPage = DEFAULT_PER_PAGE;
  perPage = Math.min(MAX_PER_PAGE, Math.max(1, perPage));

  return { query: trimmed, provider, page, perPage };
}

function sampleSearch({ query, provider, page, perPage }) {
  const rows = provider === 'all'
    ? STOCK_SAMPLE
    : STOCK_SAMPLE.filter((row) => row.provider === provider);
  const start = (page - 1) * perPage;
  return {
    ok: true,
    sample: true,
    safesearch: true,
    query,
    provider,
    page,
    perPage,
    totalResults: rows.length,
    hasMore: start + perPage < rows.length,
    results: rows.slice(start, start + perPage),
  };
}

function appStockRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  const auth = appPlatformAuth(pool, { requireUser: true, allowUserTokenOnly: true });

  const searchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: SEARCHES_PER_MINUTE,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Per (app, user): one person's searching must not use up the minute for
    // everybody else in the same app. Set now so the real services' own
    // limits are respected from their first day.
    keyGenerator: (req) => `app:${req.appPlatform?.appId || 'anon'}` +
      `:user:${req.appPlatform?.userId || 'anon'}`,
    handler: (req, res) => {
      log.warn('app-stock', 'Rate-limited', {
        appId: req.appPlatform?.appId, userId: req.appPlatform?.userId,
      });
      fail(res, 'rate_limited');
    },
  });

  router.get(`${API_V1_ROOT}/search`, auth, searchLimiter, (req, res) => {
    const search = readSearch(req.query);
    if (search.error) return fail(res, search.error);
    res.json(sampleSearch(search));
  });

  return router;
}

module.exports = appStockRoutes;
// Exposed for tests.
module.exports.readSearch = readSearch;
module.exports.sampleSearch = sampleSearch;
module.exports.SEARCHES_PER_MINUTE = SEARCHES_PER_MINUTE;
module.exports.MAX_PER_PAGE = MAX_PER_PAGE;
module.exports.DEFAULT_PER_PAGE = DEFAULT_PER_PAGE;
