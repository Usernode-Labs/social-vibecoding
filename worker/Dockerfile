FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Cache-bust the Claude Code install so the worker tracks the latest CLI
# instead of freezing at whatever version was current when this layer was
# first built. ensureWorkerImage() passes today's date as
# CLAUDE_CODE_CACHE_BUST, so the layer is reused within a calendar day and
# re-pulls `latest` on the first build of each new day. Stale CLIs are the
# cause of "thinking.type.enabled is not supported for this model" 400s on
# newer models (Sonnet 5 / Opus 4.8), which require thinking.type.adaptive.
ARG CLAUDE_CODE_CACHE_BUST=unset
RUN echo "claude-code cache bust: ${CLAUDE_CODE_CACHE_BUST}" \
  && npm install -g @anthropic-ai/claude-code

# ── Optional in-loop browser (build-mode turns only) ───────────────────
# Playwright + a pinned Chromium and the Playwright MCP server give the
# build-mode agent first-class browser_navigate / browser_console /
# screenshot tools, so it can load the app it just edited and catch
# render/JS errors before committing (see app-conventions.md "In-loop
# browser", worker/run-cc.sh, src/services/in-loop-browser.js).
#
# Unlike the Claude Code layer above, these versions are PINNED (not
# day-bumped): the Chromium build is tied to the Playwright version, so a
# floating `latest` would re-download a different browser unpredictably.
# Bump deliberately. `playwright install --with-deps chromium` pulls the
# matching Chromium plus its apt runtime deps (runs as root, before the
# USER node switch below). The browser launches LAZILY — only when the
# agent actually calls a browser tool — so turns that never reach for it
# pay no runtime cost; scout/sync never wire the MCP server at all.
ARG PLAYWRIGHT_VERSION=1.49.1
ARG PLAYWRIGHT_MCP_VERSION=0.0.41
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN npm install -g playwright@${PLAYWRIGHT_VERSION} @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
  && npx --yes playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium

COPY worker-run.sh   /usr/local/bin/worker-run.sh
COPY run-cc.sh       /usr/local/bin/run-cc.sh
# usernode-push is the worker's only path to writing anything back to
# GitHub: it POSTs to the platform's internal push proxy, which runs
# the actual `git push` from the host side with the bot token injected
# for that one call. See worker.execPushFromWorker + src/routes/internal.js.
# The worker container itself carries zero GitHub credentials.
COPY usernode-push   /usr/local/bin/usernode-push
# usernode-issues is read-only: it GETs the platform's internal issues
# endpoints (anonymous public-repo fetch happens platform-side) so Claude
# Code can list the repo's open GitHub issues — or fetch one issue's full
# untruncated body via `usernode-issues <number>` — in both build and
# scout modes. Authenticates with the read-only ISSUES_JWT, never WORKER_JWT.
COPY usernode-issues /usr/local/bin/usernode-issues
# usernode-attachments is read-only like usernode-issues (same ISSUES_JWT
# auth, works in scout + build): it lists the session's user-attached
# dev-chat files, or downloads one into the container so Claude Code can
# Read it (images especially — text files are already inlined in the
# prompt). See src/routes/internal.js attachments routes (#450).
COPY usernode-attachments /usr/local/bin/usernode-attachments
# `.claude` must exist (owned by node) in the image so that when we mount a
# named volume at that path for persistent CC sessions, Docker initialises the
# volume with node ownership instead of defaulting to root.
RUN chmod +x /usr/local/bin/worker-run.sh \
              /usr/local/bin/run-cc.sh \
              /usr/local/bin/usernode-push \
              /usr/local/bin/usernode-issues \
              /usr/local/bin/usernode-attachments \
  && mkdir -p /home/node/workspace /home/node/.claude \
  && chown -R node:node /home/node

USER node
WORKDIR /home/node/workspace

# The worker is "warm-by-default": MODE=warm clones the repo + restores
# CC config + sleeps forever, and the host drives per-turn work via
# `docker exec /usr/local/bin/run-cc.sh`. Each per-exec invocation runs
# `claude --print` (build or scout), commits, pushes, and emits the
# usual __USERNODE_RESULT__ marker on its own stdout (read directly by
# the host's docker-exec child, not via `docker logs`).
#
# Setting MODE=build|scout on `docker run` keeps the legacy single-shot
# path alive (clone → CC → commit → push → exit) for rollback safety.
#
# Bootstrap env via -e on `docker run`:
#   CLONE_URL          plain HTTPS, no embedded token (public repos only)
#   BRANCH             session's canonical dev branch
#   ANTHROPIC_API_KEY  forwarded to claude
#   WORKER_JWT         session-scoped JWT for usernode-push
#   SESSION_ID         used in the platform API URL
#   PLATFORM_URL       internal endpoint of the platform server
# Per-exec env via -e on `docker exec`:
#   PROMPT, MODE, MODEL, COMMIT_MSG, CLAUDE_RESUME_SESSION_ID,
#   WORKER_JWT (re-minted each turn), SESSION_ID, PLATFORM_URL
CMD ["/usr/local/bin/worker-run.sh"]
