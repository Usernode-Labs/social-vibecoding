'use strict';

// A domain of their own for previews (docs/plans/browser-site-isolation.md).
// Previews run unreviewed code. On the apps domain they share a browser site
// with every production app, so a preview can plant cookies on any app and
// reaches each app's same-site requests. USERNODE_PREVIEWS_DOMAIN puts them
// on another registrable domain: `<slug>--s<id>.<previews domain>`.
//
// Empty (the default) keeps previews on the apps domain. Production apps
// never move here: only preview labels are recognized on it.
//
// When it is set, previews move the way they moved with the apps domain
// (services/apps-domain-move.js): a preview's address is the preview
// machine's (chat_sessions staging_url) and every build computes a fresh
// one, so each preview moves on its next build. Until then it keeps serving
// on the apps domain, where the host parsers still recognize preview labels
// (app-access.js parseAppHost, the waking page).
//
// Routing on it is Kubernetes'. The stock Compose edge serves one wildcard
// site (the apps domain), so it does not route a previews domain.

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

function clean(value) {
  return String(value || '').trim().toLowerCase().replace(/\.$/, '');
}

function appsDomain(env) {
  return clean(env.USERNODE_APPS_DOMAIN || env.USERNODE_DOMAIN);
}

// `host` is `domain` or a name under it.
function within(host, domain) {
  return Boolean(host && domain) && (host === domain || host.endsWith(`.${domain}`));
}

// The previews domain, or '' when previews live on the apps domain. Read
// once by caddy.js at load, the way it reads USERNODE_APPS_DOMAIN; startup
// (validatePreviewsDomain) has already refused anything this would drop.
function previewsDomain(env = process.env) {
  const previews = clean(env.USERNODE_PREVIEWS_DOMAIN);
  if (!previews || !DOMAIN_RE.test(previews) || previews === appsDomain(env)) return '';
  return previews;
}

// Startup refuses a setting that would do nothing, or put previews back on
// a site they are meant to leave (src/config.js).
function validatePreviewsDomain(env = process.env) {
  const previews = clean(env.USERNODE_PREVIEWS_DOMAIN);
  if (!previews) return '';
  if (!DOMAIN_RE.test(previews)) {
    throw new Error('USERNODE_PREVIEWS_DOMAIN must be a domain name without scheme, port or path');
  }
  const others = [
    ['USERNODE_DOMAIN', clean(env.USERNODE_DOMAIN)],
    ['USERNODE_APPS_DOMAIN', appsDomain(env)],
    ['USERNODE_LEGACY_APPS_DOMAIN', clean(env.USERNODE_LEGACY_APPS_DOMAIN)],
  ];
  for (const [name, other] of others) {
    if (within(previews, other) || within(other, previews)) {
      throw new Error(`USERNODE_PREVIEWS_DOMAIN must not be ${name}, or under or above it`);
    }
  }
  // A previews domain exists to be another browser site. Where the ICANN
  // list cannot say (a test or private name), the checks above are all.
  const { browserSite } = require('./browser-site-isolation');
  const site = browserSite(previews);
  for (const [name, other] of others.slice(0, 2)) {
    if (site && other && browserSite(other) === site) {
      throw new Error(`USERNODE_PREVIEWS_DOMAIN must be on a different registrable site from ${name}`);
    }
  }
  return previews;
}

module.exports = { previewsDomain, validatePreviewsDomain };
