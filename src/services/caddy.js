// Hostname helpers for the platform's public URLs.
//
// Routing + TLS are handled entirely by Caddy via a single wildcard site
// (see Caddyfile): the hostname is mapped to a container name
// deterministically and certs are issued on-demand. The platform no
// longer writes per-host route blocks or runs `caddy reload`, so the old
// registerRoute/removeRoute/reloadCaddy functions (and the shared-file
// read-modify-write race that silently dropped routes) are gone. These
// two builders remain the single source of truth for the hostnames the
// Caddy `map` in the Caddyfile expects to see.

const USERNODE_DOMAIN = process.env.USERNODE_DOMAIN || 'social-vibecoding.usernodelabs.org';

function productionHostname(slug) {
  return `${slug}.${USERNODE_DOMAIN}`;
}

// Staging preview hostname. Stable per session (no commit hash): the label
// is `<slug>--s<sessionId>`, so every redeploy of a session reuses the same
// hostname and therefore the same TLS cert. (Embedding the commit hash here
// previously minted a brand-new hostname — and a brand-new ACME cert — on
// every redeploy, which is what exhausted Let's Encrypt's 50-cert/week/domain
// limit once real traffic arrived.) The Caddy `map` strips the `s` and routes
// `s<id>` -> `usernode-staging-<slug>--<id>`, matching the container name the
// platform already assigns. `sessionLabel` is `s${session.id}`.
function stagingHostname(slug, sessionLabel) {
  return `${slug}--${sessionLabel}.${USERNODE_DOMAIN}`;
}

module.exports = {
  productionHostname,
  stagingHostname,
  USERNODE_DOMAIN,
};
