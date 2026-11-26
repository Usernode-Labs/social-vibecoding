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
//     query before the app's code reads it, and does the refresh. Online,
//     once the app has loaded, it also checks the files the app ran on
//     against the app and reloads once onto any that changed: the refresh
//     fetches only the files it remembered, so a file it missed (or got
//     from the old build mid-rollout) would otherwise stay in front of the
//     new page for the whole 30 days.
//   * A page that never says it opened (no bridge) is reported by the
//     shell; two people on one build switch the cacheable address off for
//     the app until its next deploy (offline-cache-refusals.js,
//     apps.offline_cache_off_sha, read by forApp below).
//   * Each build's files have addresses of their own (versionAssetUrls
//     below): the access answer names the app's live build
//     (X-Usernode-Asset-Version) and the gate adds it to every same-site
//     <link> and <script> address on the app's pages. A copy a browser kept
//     of an older build's file is then never asked for again, by any browser
//     and whatever the page's address. The bridge's check could not do this
//     in Firefox, which keeps a page's own loads apart from the bridge's
//     fetches (25 Nov 2026): the check compared its own current copies and
//     the page drew the old CSS and JS forever.
//
// THE SWITCH. APP_OFFLINE_CACHE=on (chart config.appOfflineCache). Off, the
// access answer never asks for caching, the shared files keep their
// revalidate-every-load policy, and the apps' rows say offline_cache: false,
// so the shell builds today's address.
//
// Dependency-free: scripts/app-gate.js and scripts/serve-platform-assets.js
// run the platform's image with none of its configuration and require this.

// An app's page and files: fresh for 30 days. The shell's build check is
// what brings a merged change in (see the bridge's refresh), and the
// bridge's check of the files each load ran on catches any the refresh
// missed, so a long lifetime never pins an old version in front of a
// person who is online. The refresh alone did, until 25 Nov 2026.
const APP_CACHE_CONTROL = 'max-age=2592000';

// The shared /usernode-* files: always revalidated behind, never waited on.
const SHARED_CACHE_CONTROL = 'max-age=0, stale-while-revalidate=2592000';

// What the platform's access answer carries to the gate, and the one value.
const DECISION_HEADER = 'x-usernode-cache';
const DECISION_APP = 'app';

const SHARED_PREFIX_RE = /(^|[\\/])usernode-(?:bridge|native|tailwind)[\\/]/;

// ── Each build's files at addresses of their own ─────────────────────────
//
// The access answer names the app's live build in VERSION_HEADER (only the
// platform sets it: the gate discards one a visitor or an app sends), and
// the gate adds it as VERSION_PARAM to the addresses of the files an app's
// page loads, so the browser asks for the build's own copy. assetVersion is
// the one form the gate accepts, short and safe to write into a page.
const VERSION_HEADER = 'x-usernode-asset-version';
const VERSION_PARAM = 'un-v';
const VERSION_RE = /^[0-9a-z]{4,40}$/;

function assetVersion(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!VERSION_RE.test(s)) return '';
  return s.slice(0, 12);
}

// The paths a page's file address is never versioned on: data reads, the
// gate's and platform's own paths, and the platform's shared files (kept
// stale-while-revalidate, and versioned by the platform's own releases).
const UNVERSIONED_PATH_RE = /^\/?(?:\.\/)*(?:api(?:\/|$)|__|usernode-(?:bridge|native|tailwind)\/)/i;
// Any scheme (http:, https:, data:, blob:, javascript:) or a protocol-
// relative address: another site's file, or none at all.
const OTHER_ORIGIN_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i;
const LINK_RELS = new Set(['stylesheet', 'preload', 'modulepreload']);

// One address, versioned: its query keeps everything it had but an older
// VERSION_PARAM, and its #fragment stays last. Null for an address that is
// not one of the app's own files.
function versionedAddress(raw, version) {
  const value = String(raw);
  const lead = value.match(/^\s*/)[0];
  const trail = value.match(/\s*$/)[0];
  const url = value.slice(lead.length, value.length - trail.length);
  if (!url || OTHER_ORIGIN_RE.test(url)) return null;
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : url.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  if (!path || UNVERSIONED_PATH_RE.test(path)) return null;
  const query = queryAt === -1 ? '' : beforeHash.slice(queryAt + 1);
  const kept = query.split('&').filter((part) => part
    && !new RegExp(`^(?:amp;)?${VERSION_PARAM}(?:=|$)`).test(part));
  kept.push(`${VERSION_PARAM}=${version}`);
  return `${lead}${path}?${kept.join('&')}${fragment}${trail}`;
}

// An attribute of one tag: its name (case-insensitive, after whitespace, so
// data-href is not href) and its value, quoted either way or bare. A bare
// value runs to the next whitespace or `>`, as browsers read it: an `=` in
// its query (`href=/a.css?x=1`) is part of it.
function attributeIn(tag, name) {
  const re = new RegExp(`(\\s${name}\\s*=\\s*)("([^"]*)"|'([^']*)'|([^\\s"'>][^\\s>]*))`, 'i');
  const m = tag.match(re);
  if (!m) return null;
  const quote = m[3] != null ? '"' : m[4] != null ? "'" : '';
  const value = m[3] != null ? m[3] : m[4] != null ? m[4] : m[5];
  return { index: m.index, length: m[0].length, prefix: m[1], quote, value };
}

function versionAttribute(tag, name, version) {
  const attr = attributeIn(tag, name);
  if (!attr) return tag;
  const next = versionedAddress(attr.value, version);
  if (next == null) return tag;
  const quote = attr.quote || (/[\s"'=<>`]/.test(next) ? '"' : '');
  return tag.slice(0, attr.index) + attr.prefix + quote + next + quote + tag.slice(attr.index + attr.length);
}

// The page with `un-v=<version>` on every same-site address its <link
// rel="stylesheet|preload|modulepreload" href> and <script src> load. The
// rest of the document is left exactly as it was: comments, and what sits
// inside <script> and <style> elements, are skipped whole. Run again with
// another version, it replaces the version it wrote. A version assetVersion
// refuses leaves the page as it is.
function versionAssetUrls(html, version) {
  const v = assetVersion(version);
  const text = String(html);
  if (!v) return text;
  const token = /<!--[\s\S]*?-->|<(link|script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  let out = '';
  let last = 0;
  let m;
  while ((m = token.exec(text))) {
    if (!m[1]) continue;
    const kind = m[1].toLowerCase();
    const tag = m[0];
    let next = tag;
    if (kind === 'link') {
      const rel = attributeIn(tag, 'rel');
      const rels = rel ? rel.value.toLowerCase().split(/\s+/) : [];
      if (rels.some((r) => LINK_RELS.has(r))) next = versionAttribute(tag, 'href', v);
    } else if (kind === 'script') {
      next = versionAttribute(tag, 'src', v);
    }
    if (next !== tag) {
      out += text.slice(last, m.index) + next;
      last = m.index + tag.length;
    }
    // What a <script> or <style> holds is not markup: carry on after it.
    if ((kind === 'script' || kind === 'style') && !/\/\s*$/.test(m[2] || '')) {
      const close = new RegExp(`</${kind}\\s*>`, 'ig');
      close.lastIndex = token.lastIndex;
      const end = close.exec(text);
      token.lastIndex = end ? close.lastIndex : text.length;
    }
  }
  return last === 0 ? text : out + text.slice(last);
}

// Is this request a page the gate rewrites (a document or a frame's, or one
// that asks for HTML), as opposed to a file or a data read?
function isPageRequest({ method, headers = {} } = {}) {
  if (String(method || '').toUpperCase() !== 'GET') return false;
  const dest = String(headers['sec-fetch-dest'] || '').toLowerCase();
  if (dest === 'document' || dest === 'iframe') return true;
  if (dest && dest !== 'empty') return false;
  return String(headers.accept || '').toLowerCase().includes('text/html');
}

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
//   * Only a GET or HEAD answered 200 or 304, never /api/ (data) or /__
//     (the gate's and the platform's own paths). A 304 answers the bridge's
//     check of a kept copy (usernode-bridge/v1/bridge.js, checkFiles): the
//     browser takes its Cache-Control onto that copy, so without this the
//     app's own `max-age=0` would end the copy's lifetime and the next
//     open with no connection would fail.
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
  if (Number(status) !== 200 && Number(status) !== 304) return null;
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
  VERSION_HEADER,
  VERSION_PARAM,
  assetVersion,
  versionedAddress,
  versionAssetUrls,
  isPageRequest,
  enabled,
  optedOut,
  forApp,
  refusedOnThisBuild,
  appCacheControl,
  sharedFileCacheControl,
};
