// Cache policy for the platform shell's own static assets (HTML / JS / CSS
// under public/).
//
// Why this exists: mobile WebViews (and some intermediary proxies) cache JS
// and CSS aggressively. A PR's staging preview lives at a STABLE URL across
// pushes to that PR's branch, so once a WebView cached `/js/app.js` it kept
// serving the pre-fix copy on every subsequent load — a shipped fix never
// actually ran, and the bug looked completely unchanged ("same as before")
// no matter how many times the code was corrected.
//
// The platform already learned this for the centrally-hosted bridge, which
// is served with `no-cache, must-revalidate` (see the /usernode-bridge
// middleware in server.js). The shell's own HTML/JS/CSS need the same
// treatment: revalidate on every load so a redeploy reaches users on the
// next page load instead of whenever the WebView decides to drop its cache.
// This is cheap — ETag / Last-Modified still yield 304s when the file is
// unchanged, so only genuinely-changed assets re-download.
//
// Long-lived immutable assets (e.g. /visuals/:id, the versioned bridge URL)
// set their own headers on their own routes and never reach this helper.
const express = require('express');
const fs = require('fs');
const { isBuildScopedAssetPath, parseBuildScopedPath } = require('../../scripts/shell-stamp');

const REVALIDATE = 'no-cache, must-revalidate';

// ── Build-scoped asset URLs: the one immutable lane for shell bytes ──────
//
// A deployed document loads its scripts and stylesheets from
// `/b/<build sha>/…` (scripts/shell-stamp.js explains the scheme and why).
// The URL names the build, so the bytes behind it never change — a deploy
// changes the URL — and these responses may carry the policy the rest of
// this file exists to forbid: a year-long `immutable`, which is what lets
// the browser reuse V8's compiled-code cache for the shell across loads
// instead of rebuilding it on every one.
//
// Only when the sha in the URL is THIS process's build. Any other sha is a
// document asking a server that is not its build: the seconds of a
// blue-green rollout where the document came from the new colour and the
// asset request landed on the old one, or a cached document from a build
// this server has since replaced. Answering `immutable` there would pin the
// wrong bytes under the new build's URL — in the HTTP cache and, worse, in
// the service worker's — for a year. So a mismatch serves the file it has
// (a rollout must not 404 its own scripts) under the revalidate policy,
// with its own build id in X-Platform-Build so public/sw.js can see the
// disagreement and decline to cache the answer.
//
// The document, the manifest and the worker are never served here (a 404,
// not a fallback): build-scoped is for what a build owns, and those are the
// URLs that must stay fixed and fresh.
const IMMUTABLE = 'public, max-age=31536000, immutable';

// Returns the Cache-Control value for a shell asset path, or null if the
// path isn't a revalidate-every-load shell asset (let the default apply).
function shellAssetCacheControl(filePath) {
  return /\.(?:html|js|css|webmanifest)$/i.test(String(filePath)) ? REVALIDATE : null;
}

// ── Which BUILD an asset belongs to ──────────────────────────────────────
//
// The revalidation above is right and stays. What it costs is a ROUND TRIP
// PER ASSET, and the shell is ~34 of them: measured warm on a 150ms link,
// every one was answered by the service worker out of its cache — after
// spending 200ms+ discovering that, because networkFirstShell races each
// asset against a deadline. 483ms of waiting for an answer the cache had
// the whole time, on a load where nothing had been deployed at all.
//
// The worker already has the shortcut (shellFromCacheThisLoad: if the
// DOCUMENT lost its race, serve every asset from cache outright). But the
// document only loses on a connection slower than 200ms — so the
// optimisation fired only when the network was bad and the cost was paid
// only when it was good.
//
// This header is what lets the worker ask the question it actually wants
// to ask: is the cached copy of this asset from the SAME BUILD as the
// document being parsed? If yes, the network has nothing to add and the
// cache answers immediately. If no, a deploy has happened and the asset
// races exactly as before, so a redeploy still reaches a WebView on the
// next load — the thing this whole file exists to guarantee.
//
// Deliberately ABSENT when the deploy identity is unknown. `dev` is not a
// build id — it never changes, so serving on it would pin a local checkout
// to whatever the worker cached first, and an edit to public/js/app.js
// would stop showing up. No header means the worker falls back to the race
// it does today, which is exactly right for a checkout.
const SHELL_BUILD_HEADER = 'X-Platform-Build';
const SHELL_BUILD_TIME_HEADER = 'X-Platform-Build-Time';
const _documentBuildTimes = new Map();

/**
 * The deployed build id, or null when this process has no deploy identity
 * (a checkout, or a staging preview built without GIT_SHA — /api/version
 * reports the same value as the literal "dev" there).
 */
function shellBuildId(env = process.env) {
  const raw = String(env.GIT_SHA == null ? '' : env.GIT_SHA).trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(raw) ? raw : null;
}

/** Set the build header on a shell-asset response, when there is one to set. */
function applyShellBuildHeader(res, env = process.env) {
  const id = shellBuildId(env);
  if (id) res.setHeader(SHELL_BUILD_HEADER, id);
  return id;
}

/**
 * Stamp a shell DOCUMENT with an ordered build value as well as its SHA.
 *
 * Git SHAs identify builds but cannot say which of two builds is newer. That
 * distinction matters during a rollout: an old and a new server may both
 * answer briefly, and the service worker must not let the old answer replace
 * a newer cached index.html. The generated document's mtime is a build-time
 * value, so it moves forward for an ordinary deploy and for an intentional
 * rollback (which rebuilds the target revision now).
 *
 * Kept off JS/CSS responses: their build-scoped URL already pins their SHA;
 * only the fixed /index.html cache key needs an ordering value.
 */
function applyShellDocumentHeaders(res, filePath, env = process.env) {
  const id = applyShellBuildHeader(res, env);
  if (!id) return null;
  try {
    // A deployed image never mutates its generated document. Cache the stat
    // per process so this ordering header adds no synchronous I/O to normal
    // navigations; dev has no build id and returns above before touching it.
    let builtAt = _documentBuildTimes.get(filePath);
    if (builtAt == null) {
      builtAt = Math.trunc(fs.statSync(filePath).mtimeMs);
      _documentBuildTimes.set(filePath, builtAt);
    }
    if (Number.isSafeInteger(builtAt) && builtAt > 0) {
      res.setHeader(SHELL_BUILD_TIME_HEADER, String(builtAt));
      return builtAt;
    }
  } catch { /* no ordering header; the worker fails closed on cross-build replacement */ }
  return null;
}

/**
 * Express handler for `/b/<build sha>/<asset path>`. Serves the same file
 * the plain path would, from `publicDir`, immutable when the sha is this
 * process's build and revalidate-every-load when it is not.
 */
function buildScopedAssetHandler(publicDir, env = process.env) {
  const common = { index: false, redirect: false, fallthrough: false, dotfiles: 'ignore' };
  const immutable = express.static(publicDir, {
    ...common,
    maxAge: '1y',
    immutable: true,
    setHeaders(res) { applyShellBuildHeader(res, env); },
  });
  // serve-static writes its own Cache-Control before setHeaders runs, so the
  // revalidate lane overrides it there — the same shape as the shell handler
  // in server.js.
  const revalidate = express.static(publicDir, {
    ...common,
    setHeaders(res) {
      res.setHeader('Cache-Control', REVALIDATE);
      applyShellBuildHeader(res, env);
    },
  });
  return function buildScopedAssets(req, res, next) {
    const scoped = parseBuildScopedPath(req.path);
    if (!scoped) return next();
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !isBuildScopedAssetPath(scoped.path)) {
      res.status(404).end();
      return;
    }
    const current = shellBuildId(env);
    const serve = current && scoped.build === current ? immutable : revalidate;
    // The prefix is an address, not a directory: strip it and let serve-static
    // resolve the plain path. A query string rides along unchanged.
    req.url = scoped.path + req.url.slice(req.path.length);
    serve(req, res, (err) => {
      if (err && (err.status === 404 || err.statusCode === 404)) {
        res.status(404).end();
        return;
      }
      next(err);
    });
  };
}

module.exports = {
  shellAssetCacheControl,
  buildScopedAssetHandler,
  shellBuildId,
  applyShellBuildHeader,
  applyShellDocumentHeaders,
  SHELL_BUILD_HEADER,
  SHELL_BUILD_TIME_HEADER,
  REVALIDATE,
  IMMUTABLE,
};
