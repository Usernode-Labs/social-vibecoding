.PHONY: up down restart logs ps build node

# Local development entrypoints. Production deploys go through
# .github/workflows/deploy.yml + the top-level docker-compose.yml; nothing
# in here touches that path.

# ---------------------------------------------------------------------------
# Native usernode node, for Mac local dev.
#
# docker-compose.dev.yml deliberately doesn't run the `usernode-node`
# sidecar because Docker Desktop on Mac can't complete WebRTC P2P
# (the VM's network stack drops ICE). Instead, run the node natively
# on the host and the platform container reaches it via
# host.docker.internal:3001.
#
# One-time setup:
#   cd ../usernode && cargo build --release -p usernode-cli
#
# Then in a long-running terminal here:
#   make node
#
# Override USERNODE_BIN / NODE_PORT / GENESIS_URL / SEEDLIST_URL on the
# command line if you need to point at a different binary or network.
# ---------------------------------------------------------------------------

USERNODE_BIN ?= ../usernode/target/release/usernode
GENESIS_URL  ?= https://static.usernodelabs.org/testnet/genesis.json
SEEDLIST_URL ?= https://static.usernodelabs.org/testnet/seedlist.txt
# Must be 3001 to match docker-compose.dev.yml's NODE_RPC_URL. The host:3000
# slot is already taken by this stack's own platform container, so the node
# can't share it.
NODE_PORT    ?= 3001

node:
	$(USERNODE_BIN) node \
		--genesis-url $(GENESIS_URL) \
		--peer-list-url $(SEEDLIST_URL) \
		--port $(NODE_PORT) \
		--enable-recent-tx-stream

# ---------------------------------------------------------------------------
# Dev stack: platform + Postgres only (no sidecar — see `node` above).
# Run `make node` in a separate terminal first.
# ---------------------------------------------------------------------------

DEV_COMPOSE = docker compose -f docker-compose.dev.yml

build:
	$(DEV_COMPOSE) build

up:
	$(DEV_COMPOSE) up -d --build

down:
	$(DEV_COMPOSE) down

restart:
	$(DEV_COMPOSE) restart

logs:
	$(DEV_COMPOSE) logs -f --tail=200

ps:
	$(DEV_COMPOSE) ps
