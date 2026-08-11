# Stage 1 — compile the platform shell's Tailwind stylesheet from the exact
# sources in this image build. The output is deliberately not committed: every
# production deploy, staging preview, and rollback rebuilds it from that
# commit. Dev dependencies stay in this disposable stage.
FROM node:22-alpine AS css
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tailwind.config.js ./
COPY styles ./styles
COPY scripts/build-tailwind.js ./scripts/build-tailwind.js
COPY public ./public
COPY frontend ./frontend
RUN npm run build:css

# Stage 2 — production runtime.
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
COPY . .
# COPY after the source tree so a developer's ignored local build can never
# replace the stylesheet generated from this image build's sources.
COPY --from=css /build/public/css/tailwind.css ./public/css/tailwind.css
EXPOSE 3000
CMD ["node", "server.js"]
