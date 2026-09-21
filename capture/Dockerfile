FROM node:22-bookworm-slim

# Distro Chromium + ffmpeg + fonts is the smallest reliable combo for
# headless capture: Playwright's official image is ~2 GB and Alpine is
# unsupported by both Puppeteer and Playwright. ffmpeg is needed twice
# over — Puppeteer's page.screencast() shells out to it to encode the
# webm recording, and capture.js invokes it directly for the GIF
# transcode (palettegen/paletteuse).
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium ffmpeg ca-certificates \
    fonts-liberation fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# puppeteer-core only — the browser comes from the distro package above,
# so no Chromium download at npm-install time.
RUN npm install puppeteer-core@^23 playwright-core@1.55.1 zod@3.25.76 pngjs@7.0.0 \
  && chown -R node:node /app

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY capture/capture.js /app/capture.js
COPY evidence/replay-runner.js /app/evidence-replay.js
COPY src/services/visual-evidence-plan.js /app/visual-evidence-plan.js

USER node

# One-shot: reads BEFORE_URL / AFTER_URL (either may be empty) from env,
# emits sentinel-framed base64 artifacts on stdout, exits 0. The platform
# (src/services/visuals.js) runs this with `docker run --rm` and parses
# stdout — see that file for the protocol.
CMD ["node", "/app/capture.js"]
