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

function stagingHostname(slug, username, commitHash) {
  const shortHash = commitHash.substring(0, 6);
  return `${slug}--${username}--${shortHash}.${USERNODE_DOMAIN}`;
}

module.exports = {
  productionHostname,
  stagingHostname,
  USERNODE_DOMAIN,
};
