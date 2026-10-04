'use strict';

// What the bridge needs to know about the deployment an app runs under, as
// the small JSON document served at /usernode-bridge/v1/platform.json on
// every app host (#3657).
//
// An app opened at its own address (<slug>.<apps domain>) gets a Homeroom
// button from the bridge (the __USERNODE_PLATFORM_LINK__ block in
// public/usernode-bridge/v1/bridge.js). Its rows link to the app inside the
// platform and to the site's front door, and the hostname alone cannot say
// where those are: a single-domain deployment serves the platform at
// <domain> beside apps at <slug>.<domain>, the hosted one serves it at
// app.<domain>. So the platform says, from its own settings, on a path under
// the centrally hosted /usernode-bridge/ prefix that every app host routes
// to the platform rather than to the app (Caddy's @platform_assets on the
// standalone deployment; services/kubernetes.js's asset routes, answered by
// scripts/serve-platform-assets.js, on Kubernetes).
//
// Deliberately pure and dependency-light: serve-platform-assets.js runs in a
// container holding none of the platform's configuration, so both servers
// build the document from plain values (the platform from its config, the
// asset server from the three env vars its Deployment is given).
//
// Nothing secret is here, and nothing per-user: the same three public facts
// for every caller, so it is served anonymously with a wildcard CORS header.

const { normalizeBaseUrl } = require('./marketing-links');

const CONFIG_PATH = '/usernode-bridge/v1/platform.json';

// A bare DNS name: lower-case labels, at least two of them, no port, no
// scheme. Anything else (localhost:3000, an empty value) yields no document,
// and the bridge draws no button, which is the right answer for a dev box.
function cleanDomain(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : null;
}

function appHostConfig({ platformDomain, appsDomain, marketingBaseUrl } = {}) {
  const platform = cleanDomain(platformDomain);
  if (!platform) return null;
  const apps = cleanDomain(appsDomain) || platform;
  return {
    version: 1,
    platform_origin: `https://${platform}`,
    apps_domain: apps,
    site_url: normalizeBaseUrl(marketingBaseUrl),
  };
}

// The asset server's view: the env vars kubernetes.js gives its Deployment.
function appHostConfigFromEnv(env = process.env) {
  return appHostConfig({
    platformDomain: env.USERNODE_DOMAIN,
    appsDomain: env.USERNODE_APPS_DOMAIN,
    marketingBaseUrl: env.MARKETING_BASE_URL,
  });
}

// Response headers for the document, shared by both servers so they cannot
// drift. Revalidated on every load like the bridge itself.
const CONFIG_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-cache, must-revalidate',
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
});

module.exports = {
  CONFIG_PATH,
  CONFIG_HEADERS,
  cleanDomain,
  appHostConfig,
  appHostConfigFromEnv,
};
