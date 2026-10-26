FROM node:22.23.4-bookworm-slim
# Pin npm and replace its affected Undici bundle until npm ships the patch.
RUN npm install --global npm@11.21.1 undici@6.29.1 \
  && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici \
  && mv /usr/local/lib/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/undici \
  && npm cache clean --force

# Distro Chromium + ffmpeg + fonts is the smallest reliable combo for
# headless capture: Playwright's official image is ~2 GB and Alpine is
# unsupported by both Puppeteer and Playwright. ffmpeg is needed twice
# over — Puppeteer's page.screencast() shells out to it to encode the
# webm recording, and capture.js invokes it directly for the GIF
# transcode (palettegen/paletteuse).
#
# Inter is the capture's sans-serif (capture/fonts.conf says why): the
# platform sets its text in the reader's system face, which this image does
# not have, and the Liberation/DejaVu fallback made every capture look like
# a different product from the one on a phone.
# The base image's own packages are upgraded first, as in worker/Dockerfile
# (OpenSSL CVE-2026-84782, 26 Oct 2026).
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends \
    chromium ffmpeg ca-certificates \
    fonts-inter fonts-liberation fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*
COPY capture/fonts.conf /etc/fonts/local.conf
RUN fc-cache -f

WORKDIR /app

# puppeteer-core only — the browser comes from the distro package above,
# so no Chromium download at npm-install time.
COPY capture/package.json ./
# Current browser client uses patched Zod 4; retain the FTP parser fix.
RUN npm install --omit=dev \
  && chown -R node:node /app

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY capture/capture.js /app/capture.js
COPY shots/hosted-app-fixture.js /app/shots-hosted-app-fixture.js
COPY worker/session-bootstrap.js /worker/session-bootstrap.js
COPY worker/shots-hosted-origins.js /worker/shots-hosted-origins.js
COPY worker/shots-hosted-app-contract.js /worker/shots-hosted-app-contract.js

# This image also serves the short-lived hosted-app shots fixture through
# the ordinary Kubernetes app runtime. That runtime enforces runAsNonRoot
# without assigning a UID, so kubelet must be able to verify a numeric image
# user before the container starts. UID/GID 1000 are the official node
# image's node account, preserving the same files and permissions as before.
USER 1000:1000

# One-shot: reads BEFORE_URL / AFTER_URL (either may be empty) from env,
# emits sentinel-framed base64 artifacts on stdout, exits 0. The platform
# (src/services/visuals.js) runs this with `docker run --rm` and parses
# stdout — see that file for the protocol.
CMD ["node", "/app/capture.js"]
