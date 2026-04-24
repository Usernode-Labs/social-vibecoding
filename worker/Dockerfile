FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

COPY worker-run.sh /usr/local/bin/worker-run.sh
# `.claude` must exist (owned by node) in the image so that when we mount a
# named volume at that path for persistent CC sessions, Docker initialises the
# volume with node ownership instead of defaulting to root.
RUN chmod +x /usr/local/bin/worker-run.sh \
  && mkdir -p /home/node/workspace /home/node/.claude \
  && chown -R node:node /home/node

USER node
WORKDIR /home/node/workspace

# The worker runs autonomously: once spawned, it clones, invokes Claude
# Code, commits, and pushes — all inside this container — then exits.
# The host server only tails `docker logs` for progress and reads the
# final __USERNODE_RESULT__ marker. This decouples in-flight coding
# sessions from the host server's lifetime; a server restart no longer
# kills the running dev session.
#
# All session config comes in via -e at `docker run` time:
#   CLONE_URL, BRANCH, PROMPT, MODEL, COMMIT_MSG, PAT, ANTHROPIC_API_KEY
CMD ["/usr/local/bin/worker-run.sh"]
