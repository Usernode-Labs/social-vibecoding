FROM node:22-alpine
# The platform spawns child apps by shelling out to the host's Docker
# daemon (see src/services/docker.js — `execFile('docker', [...])`).
# That needs the docker CLI inside the container; the daemon itself
# is reached via a bind-mounted /var/run/docker.sock from the host.
# git is for the import-existing flow's `git clone` of foreign repos.
RUN apk add --no-cache docker-cli git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci --prefix frontend
COPY . .
# Local builds still compile the shell for convenience. Production builds pass
# an exact source SHA and must consume the verified CI artifact copied into
# public/react; rebuilding here would sever the check-to-deploy identity.
ARG GIT_SHA=dev
ARG SV_REACT_SHELL_REVISION=dev
RUN set -eu; \
    if printf '%s' "$GIT_SHA" | grep -Eq '^[0-9a-f]{40}$'; then \
      test "$SV_REACT_SHELL_REVISION" = "$GIT_SHA"; \
      test -f .verified-react-shell.json; \
      test -f .verified-react-shell.sha256; \
      GIT_SHA="$GIT_SHA" node -e ' \
        const fs = require("node:fs"); \
        const manifest = JSON.parse(fs.readFileSync(".verified-react-shell.json", "utf8")); \
        if (manifest.schemaVersion !== 1 || \
            manifest.sourceSha !== process.env.GIT_SHA || \
            manifest.reactShellRevision !== process.env.GIT_SHA) { \
          throw new Error(`verified React shell does not match ${process.env.GIT_SHA}`); \
        }'; \
      sha256sum -c .verified-react-shell.sha256; \
    else \
      if [ "$SV_REACT_SHELL_REVISION" = "dev" ]; then \
        npm run build --prefix frontend; \
      else \
        SV_REACT_SHELL_REVISION="$SV_REACT_SHELL_REVISION" npm run build --prefix frontend; \
      fi; \
    fi
EXPOSE 3000
CMD ["node", "server.js"]
