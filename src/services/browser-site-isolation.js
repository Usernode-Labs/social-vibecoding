'use strict';

const { domainToASCII } = require('node:url');
const { parse } = require('tldts');
const { isolationMode } = require('./browser-session-cookies');

function browserSite(host) {
  if (typeof host !== 'string' || host !== host.trim() || /[/:@?#\\]/.test(host)) return null;
  const ascii = domainToASCII(host.replace(/\.$/, '').toLowerCase());
  if (!ascii || ascii.length > 253 || !ascii.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  const result = parse(ascii, { allowPrivateDomains: true });
  return !result.isIp && (result.isIcann || result.isPrivate) ? result.domain : null;
}

function appHostIsIsolated(host, platformHost) {
  const platform = browserSite(platformHost), app = browserSite(host);
  return platform !== null && app !== null && platform !== app;
}

function validateBrowserSiteIsolation(env = process.env) {
  const mode = isolationMode(env);
  if (mode === 'strict' && !appHostIsIsolated(env.USERNODE_APPS_DOMAIN, env.USERNODE_DOMAIN)) {
    throw new Error('Strict browser isolation requires USERNODE_APPS_DOMAIN on a different registrable site from USERNODE_DOMAIN');
  }
  // The stock Compose edge still has one wildcard site and captures the
  // production platform over private HTTP. Do not claim a safe cutover there.
  if (mode === 'strict' && env.APP_RUNTIME !== 'kubernetes') {
    throw new Error('Strict browser isolation currently requires Kubernetes routing and HTTPS captures');
  }
  return mode;
}

module.exports = { browserSite, appHostIsIsolated, validateBrowserSiteIsolation };
