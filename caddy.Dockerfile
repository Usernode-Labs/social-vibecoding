# Custom Caddy image with the acme-dns DNS provider plugin.
#
# The stock `caddy:2-alpine` image ships no DNS plugins, but DNS-01 issuance
# of the `*.social-vibecoding.usernodelabs.org` wildcard cert needs one. We
# use caddy-dns/acmedns so Caddy sets the challenge TXT via our self-hosted
# acme-dns server (internal HTTP API) instead of touching the production
# Namecheap zone. See acme-dns/config.cfg for the rationale.
FROM caddy:2-builder AS builder
RUN xcaddy build \
    --with github.com/caddy-dns/acmedns

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
