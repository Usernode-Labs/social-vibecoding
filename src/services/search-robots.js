'use strict';

// What a search engine is told about the addresses the platform answers for
// (12 Nov 2026, from the Search Console report for the apps domain).
//
// Three things in that report were the platform's to fix:
//
//   1. Apps' `/api/*` routes were crawled and listed (as 401s, and some as
//      pages). An API answer is never a page.
//   2. The centrally hosted files every app host serves (/usernode-bridge/,
//      /usernode-native/, /usernode-tailwind/) and anything under a
//      `/__usernode` path are the platform's plumbing, the same bytes on
//      every app host: thousands of duplicates if indexed.
//   3. `https://<platform>/?report=app` and its like were "duplicate without
//      a canonical": the shell's front page has one address, whatever query
//      string a link carries.
//
// A preview (`<slug>--s<id>.<domain>`) is a proposal's working copy and is
// never a page for a search engine either, whichever path is asked for.
//
// An app's own pages are the app's to describe (its conventions say how);
// nothing here marks them.
//
// Dependency-free on purpose: scripts/app-gate.js and
// scripts/serve-platform-assets.js run in containers holding none of the
// platform's configuration and require this file directly.

const NOINDEX = 'noindex';

// The first label of a preview's host (services/preview-sleep.js and
// services/edge-gate.js read the same shape).
const PREVIEW_LABEL_RE = /^[a-z0-9-]+?--s\d+(?:--[a-z0-9]+)?$/;

// Paths on an app host that are never a page. `/api` alone and `/api/…`;
// `/__usernode…` covers the gate's own paths and anything an app's
// catch-all would otherwise answer under that name.
const NOINDEX_PATH_RE = /^\/(?:api(?:\/|$)|__usernode|usernode-(?:bridge|native|tailwind)\/)/;

function firstLabel(host) {
  return String(host || '').trim().toLowerCase().split(':')[0].split('.')[0];
}

/** Whether this host is a proposal's preview. */
function isPreviewHost(host) {
  return PREVIEW_LABEL_RE.test(firstLabel(host));
}

function pathOf(url) {
  const raw = String(url || '/');
  const cut = raw.search(/[?#]/);
  return cut === -1 ? raw : raw.slice(0, cut);
}

/**
 * The X-Robots-Tag an app host's answer carries, or null to leave it as the
 * app sent it. `host` is the request's Host, `url` its path (a query string
 * is ignored).
 */
function appHostRobots({ host, url } = {}) {
  if (isPreviewHost(host)) return NOINDEX;
  return NOINDEX_PATH_RE.test(pathOf(url)) ? NOINDEX : null;
}

/**
 * An app's own X-Robots-Tag with the platform's rule added. The app's words
 * are kept (it may say more, such as nofollow); `noindex` is added once.
 */
function withRobots(existing, rule) {
  if (!rule) return existing;
  const own = Array.isArray(existing) ? existing.join(', ') : String(existing || '').trim();
  if (!own) return rule;
  return own.toLowerCase().split(',').some((part) => part.trim() === rule) ? own : `${own}, ${rule}`;
}

/**
 * The `Link` header that names the shell front page's one address, or null.
 * Only for `/` on production: a query string (`?report=app`, `?demo=1`) is
 * the same page. Every other shell address is left alone; a public
 * project's page carries its own canonical (services/project-preview.js).
 */
function shellCanonicalLink({ method, path, origin, staging = false } = {}) {
  if (staging || (method !== 'GET' && method !== 'HEAD') || path !== '/') return null;
  if (!/^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(String(origin || ''))) return null;
  return `<${origin}/>; rel="canonical"`;
}

module.exports = {
  NOINDEX,
  isPreviewHost,
  appHostRobots,
  withRobots,
  shellCanonicalLink,
};
