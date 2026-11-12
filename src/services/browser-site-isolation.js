'use strict';

const { domainToASCII } = require('node:url');
const { parse } = require('tldts');
const { isolationMode } = require('./browser-session-cookies');

// A browser site is a scheme plus a registrable domain. Browsers compute the
// registrable domain with the whole Public Suffix List, private entries
// included; this check deliberately reads only its ICANN section. Two hosts
// whose ICANN registrable domains differ are different sites in every
// browser, whatever copy of the list it ships, because a private entry can
// only lengthen a registrable domain. A boundary that held only through a
// private entry would hold only in browsers that already ship that entry, and
// this server's copy of the list says nothing about theirs.
function browserSite(host) {
  if (typeof host !== 'string' || host !== host.trim() || /[/:@?#\\]/.test(host)) return null;
  const ascii = domainToASCII(host.replace(/\.$/, '').toLowerCase());
  if (!ascii || ascii.length > 253 || !ascii.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  const result = parse(ascii, { allowPrivateDomains: false });
  return !result.isIp && result.isIcann ? result.domain : null;
}

function appHostIsIsolated(host, platformHost) {
  const platform = browserSite(platformHost), app = browserSite(host);
  return platform !== null && app !== null && platform !== app;
}

// The hosts this deployment generates, in the shape src/services/caddy.js
// builds them (productionHostname, stagingHostname). Previews live on the
// apps domain until they get a domain of their own; when that happens the
// builders and this function change together, which
// tests/browser-site-isolation.test.js holds by comparing them.
function generatedHosts(env = process.env) {
  const platform = env.USERNODE_DOMAIN;
  const apps = env.USERNODE_APPS_DOMAIN || platform;
  return { platform, apps, app: `probe.${apps}`, preview: `probe--s1.${apps}` };
}

function validateBrowserSiteIsolation(env = process.env) {
  const mode = isolationMode(env);
  if (mode !== 'strict') return mode;
  // Strict mode keeps the platform session away from community code, so every
  // host that serves it (production apps and previews) must be on another
  // site. The apps domain must itself have a registrable domain: one that is
  // a public suffix would make each app a registrable domain of its own.
  const hosts = generatedHosts(env);
  if (browserSite(hosts.apps) === null) {
    throw new Error('Strict browser isolation requires USERNODE_APPS_DOMAIN on a different registrable site from USERNODE_DOMAIN');
  }
  for (const kind of ['app', 'preview']) {
    if (!appHostIsIsolated(hosts[kind], hosts.platform)) {
      throw new Error(`Strict browser isolation requires ${kind} hosts on a different registrable site from USERNODE_DOMAIN (ICANN section of the Public Suffix List)`);
    }
  }
  // The stock Compose edge still has one wildcard site and captures the
  // production platform over private HTTP. Do not claim a safe cutover there.
  if (env.APP_RUNTIME !== 'kubernetes') {
    throw new Error('Strict browser isolation currently requires Kubernetes routing and HTTPS captures');
  }
  return mode;
}

module.exports = { browserSite, appHostIsIsolated, generatedHosts, validateBrowserSiteIsolation };
