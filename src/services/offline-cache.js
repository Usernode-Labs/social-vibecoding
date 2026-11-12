'use strict';

// Project apps that open offline from the browser's own HTTP cache, with no
// service worker (docs/plans/project-apps-offline.md, option E).
//
// WHY NOT A SERVICE WORKER. The iOS app's WKWebView allows three service
// worker registrations in all (WebKit's SWServer, defaultMaxRegistrationCount)
// and Homeroom's own worker holds one, so a worker per app stops at two apps
// on an iPhone. The browser's ordinary cache has no such limit: a page and
// files kept FRESH are used with no request at all, by WebKit and Chromium
// alike, so an app opened online once opens again with no network.
//
// THE PIECES.
//   * The app gate (scripts/app-gate.js) gives an app's own pages and files
//     a 30-day fresh lifetime, when the platform's access answer says so
//     (edge-gate.js sets X-Usernode-Cache: app). appCacheControl below is
//     the rule. With the gate off nothing upstream changes.
//   * The shared /usernode-* files may be served stale while they refresh
//     behind (stale-while-revalidate): they change with every platform
//     build, and an app outside the shell (a direct visit) must still pick
//     up a platform fix on its next loads.
//   * The shell (public/js/app-view.js) frames such an app at ONE address
//     per build whatever the token (`?un-build=<sha>`, the token after `#`),
//     so a merged change is a page no browser has kept yet, and asks the
//     bridge to refresh the app's files when the app's build changed.
//   * The bridge (usernode-bridge/v1/bridge.js) moves that token into the
//     query before the app's code reads it, and does the refresh.
//   * A page that never says it opened (no bridge) is reported by the
//     shell; two people on one build switch the cacheable address off for
//     the app until its next deploy (offline-cache-refusals.js,
//     apps.offline_cache_off_sha, read by forApp below).
//
// THE SWITCH. APP_OFFLINE_CACHE=on (chart config.appOfflineCache). Off, the
// access answer never asks for caching, the shared files keep their
// revalidate-every-load policy, and the apps' rows say offline_cache: false,
// so the shell builds today's address.
//
// Dependency-free: scripts/app-gate.js and scripts/serve-platform-assets.js
// run the platform's image with none of its configuration and require this.

// An app's page and files: fresh for 30 days. The shell's build check is
// what brings a merged change in (see the bridge's refresh), so a long
// lifetime never pins an old version in front of a person who is online.
const APP_CACHE_CONTROL = 'max-age=2592000';

// The shared /usernode-* files: always revalidated behind, never waited on.
const SHARED_CACHE_CONTROL = 'max-age=0, stale-while-revalidate=2592000';

// What the platform's access answer carries to the gate, and the one value.
const DECISION_HEADER = 'x-usernode-cache';
const DECISION_APP = 'app';

const SHARED_PREFIX_RE = /(^|[\\/])usernode-(?:bridge|native|tailwind)[\\/]/;

function enabled(env = process.env) {
  return String(env.APP_OFFLINE_CACHE || '').trim().toLowerCase() === 'on';
}

// `"offline": false` in dapp.json keeps an app out (a game, or a page that
// must never be a day old). Only that literal opts out; anything else reads
// as saying nothing, like the manifest's other lenient fields.
function optedOut(manifest) {
  return !!manifest && typeof manifest === 'object' && !Array.isArray(manifest)
    && manifest.offline === false;
}

// Does the shell frame this app at the cacheable address? `app` is an apps
// row (or its client payload): the platform itself is never one.
function forApp(app, env = process.env) {
  if (!enabled(env) || !app) return false;
  if (app.self_hosted) return false;
  // A view-private app's `/` cannot load without its token, and the shell
  // puts that token after `#`, so the gate never sees it: framing such an
  // app at the cacheable address sends the request through the access
  // gate's sign-in hop, which frames the shell again and nests it inside
  // itself (#6226). Only the tokened address is right for these.
  if (app.view_visibility === 'private') return false;
  // A page two people's frames saw not open at the cacheable address on
  // this build (services/offline-cache-refusals.js): the tokened address on
  // every device until the app deploys again.
  if (refusedOnThisBuild(app)) return false;
  return !optedOut(app.manifest_snapshot);
}

// Is `app` on the build its page was found not to open on? A row without
// both columns (an older projection) says no.
function refusedOnThisBuild(app) {
  const off = String(app && app.offline_cache_off_sha || '').toLowerCase();
  const live = String(app && app.main_sha || '').toLowerCase();
  return !!off && off === live;
}

function directives(value) {
  return String(value || '').toLowerCase().split(',').map((d) => d.trim()).filter(Boolean);
}

// The gate's rule, for one proxied response. Returns the Cache-Control to
// send, or null to leave the app's own header as it is.
//
//   * Only a GET or HEAD answered 200, never /api/ (data) or /__ (the
//     gate's and the platform's own paths).
//   * Never an address that carries the token in its query: that is the
//     45-minute refresh's address (and an app's own links), not the one the
//     shell opens and caches.
//   * Never a response that sets a cookie: that answer was for one person.
//   * Only over no Cache-Control, or one that asks for revalidation on every
//     load (max-age=0, no-cache, must-revalidate). An app that chose a
//     lifetime of its own, or said no-store or private, keeps its choice.
function appCacheControl({ method, url, status, cacheControl, setCookie } = {}) {
  const m = String(method || '').toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return null;
  if (Number(status) !== 200) return null;
  const raw = String(url || '/');
  const q = raw.indexOf('?');
  const pathname = q === -1 ? raw : raw.slice(0, q);
  if (pathname.startsWith('/api/') || pathname === '/api' || pathname.startsWith('/__')) return null;
  if (q !== -1 && /(^|&)token=/.test(raw.slice(q + 1))) return null;
  if (setCookie != null && [].concat(setCookie).some((v) => String(v || '').trim())) return null;
  const list = directives(cacheControl);
  if (!list.length) return APP_CACHE_CONTROL;
  if (list.includes('no-store') || list.includes('private')) return null;
  const maxAge = list.find((d) => d.startsWith('max-age='));
  const positive = maxAge && Number(maxAge.slice('max-age='.length)) > 0;
  if (positive || list.some((d) => d.startsWith('s-maxage=') || d === 'immutable')) return null;
  // max-age=0, no-cache, must-revalidate, or `public` alone (the browser
  // would guess a lifetime): ours.
  return APP_CACHE_CONTROL;
}

// The shared files' Cache-Control: SHARED_CACHE_CONTROL for a
// /usernode-bridge|native|tailwind/ path while the switch is on, otherwise
// `fallback` (each server's own policy).
function sharedFileCacheControl(filePath, fallback, env = process.env) {
  if (!enabled(env)) return fallback;
  return SHARED_PREFIX_RE.test(String(filePath || '')) ? SHARED_CACHE_CONTROL : fallback;
}

module.exports = {
  APP_CACHE_CONTROL,
  SHARED_CACHE_CONTROL,
  DECISION_HEADER,
  DECISION_APP,
  enabled,
  optedOut,
  forApp,
  refusedOnThisBuild,
  appCacheControl,
  sharedFileCacheControl,
};
