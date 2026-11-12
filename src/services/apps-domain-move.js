'use strict';

// Moving apps and previews to another domain (docs/plans/browser-site-isolation.md,
// step 4). USERNODE_APPS_DOMAIN names where they are served; while they move,
// USERNODE_LEGACY_APPS_DOMAIN names where they were.
//
// What moves, and how:
//   * Production apps: their addresses are never stored (caddy.js
//     productionHostname), so the release's clock job below moves every
//     production app Ingress from `<slug>.<legacy>` to `<slug>.<apps>`.
//   * Previews: their address is the preview machine's (chat_sessions
//     staging_url, which only its transitions write), and every build of a
//     preview computes a fresh one. They move on their next build; until
//     then they keep serving where they are, and the host parsers still
//     recognize them there (app-access.js parseAppHost, the waking page).
//   * Custom domains: a CNAME made before the move still points at the old
//     address, which keeps resolving to the same gateway; it keeps passing
//     (app-domains.js checkDns).
//   * Old links: the infrastructure redirects `<label>.<legacy>` to
//     `<label>.<apps>` wherever nothing is served any more (an Ingress for an
//     exact host wins over a wildcard one, so a preview not yet moved still
//     serves).
//
// Nothing here runs while USERNODE_LEGACY_APPS_DOMAIN is empty.

const log = require('./logger');

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

function appsDomain(env = process.env) {
  return String(env.USERNODE_APPS_DOMAIN || env.USERNODE_DOMAIN || '').trim().toLowerCase();
}

function normalized(env) {
  return String(env.USERNODE_LEGACY_APPS_DOMAIN || '').trim().toLowerCase().replace(/\.$/, '');
}

// The old apps domain, or '' when nothing is moving. Read once by caddy.js
// at load, the way it reads USERNODE_APPS_DOMAIN.
function legacyAppsDomain(env = process.env) {
  const legacy = normalized(env);
  if (!legacy || !DOMAIN_RE.test(legacy) || legacy === appsDomain(env)) return '';
  return legacy;
}

// Startup refuses a setting that would silently do nothing (src/config.js).
function validateLegacyAppsDomain(env = process.env) {
  const legacy = normalized(env);
  if (!legacy) return '';
  if (!DOMAIN_RE.test(legacy)) {
    throw new Error('USERNODE_LEGACY_APPS_DOMAIN must be a domain name without scheme, port or path');
  }
  if (legacy === appsDomain(env)) {
    throw new Error('USERNODE_LEGACY_APPS_DOMAIN must differ from USERNODE_APPS_DOMAIN');
  }
  if (legacy === String(env.USERNODE_DOMAIN || '').trim().toLowerCase()) {
    throw new Error('USERNODE_LEGACY_APPS_DOMAIN cannot be the platform host');
  }
  return legacy;
}

// The clock job (src/workflow/clock/services.ts 'apps-domain-move').
async function run({ config }, env = process.env) {
  const from = legacyAppsDomain(env);
  if (!from) return { off: true };
  if (require('./application-runtime').mode(config) !== 'kubernetes') return { off: true, runtime: 'docker' };
  const to = String(config.kubernetes.appDomain || '').toLowerCase();
  const { updated } = await require('./kubernetes').reconcileAppsDomainIngresses(config, { from, to });
  if (updated) log.info('apps-domain-move', 'Production apps moved to the apps domain', { from, to, updated });
  return { from, to, updated };
}

module.exports = { legacyAppsDomain, validateLegacyAppsDomain, run };
