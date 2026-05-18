FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

COPY worker-run.sh   /usr/local/bin/worker-run.sh
COPY run-cc.sh       /usr/local/bin/run-cc.sh
# usernode-push is the worker's only path to writing anything back to
# GitHub: it POSTs to the platform's internal push proxy, which runs
# the actual `git push` from the host side with the bot token injected
# for that one call. See worker.execPushFromWorker + src/routes/internal.js.
# The worker container itself carries zero GitHub credentials.
COPY usernode-push   /usr/local/bin/usernode-push
# `.claude` must exist (owned by node) in the image so that when we mount a
# named volume at that path for persistent CC sessions, Docker initialises the
# volume with node ownership instead of defaulting to root.
RUN chmod +x /usr/local/bin/worker-run.sh \
              /usr/local/bin/run-cc.sh \
              /usr/local/bin/usernode-push \
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
