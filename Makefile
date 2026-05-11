.PHONY: up down restart logs ps build node-full node-full-no-fetch fetch-archive

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
#   make node-full
#
# Override USERNODE_BIN / NODE_PORT / GENESIS_URL / SEEDLIST_URL / ARCHIVE_DIR
# / ARCHIVE_SEED_HOST on the command line if you need to point at a
# different binary, network, or archive seed.
# ---------------------------------------------------------------------------

USERNODE_BIN      ?= ../usernode/target/release/usernode
GENESIS_URL       ?= https://static.usernodelabs.org/testnet/genesis.json
SEEDLIST_URL      ?= https://static.usernodelabs.org/testnet/seedlist.txt
# Must be 3001 to match docker-compose.dev.yml's NODE_RPC_URL. The host:3000
# slot is already taken by this stack's own platform container, so the node
# can't share it.
NODE_PORT         ?= 3001
ARCHIVE_DIR       ?= $(HOME)/.usernode/archive
ARCHIVE_SEED_HOST ?= testnet-seed1

# Run the node in true full-ledger mode by loading a remote archive snapshot.
#
# Why this is the only `node` target: PARTIAL_LEDGER_RECENT_TX_SOURCE_BUG
# describes the `RecentTxEntry.source = null` failure that hits any consumer
# reading the recent-tx stream off a partial-ledger node. The platform's
# /__node-status panel surfaces this as the "Partial ledger mode" banner;
# child-app dapp servers silently drop incoming txs from non-tracked senders
# whenever it triggers. The fix is to run the node with the full UTXO tree
# present, so `collect_block_input_owners_at_root` can resolve every input
# commitment (not just tracked-wallet ones).
#
# A naive `usernode node ...` boot would NOT give you a full ledger: any
# runtime `tracked_owner/add` call (every child app fires one at boot) trips
# the wallet-seed shortcut into PARTIAL UTXO overlay mode. Removing tracked
# owners would force a multi-hour genesis sync AND break /wallet/send. So
# the right answer is always: load a fresh archive snapshot at boot.
#
# This target uses tizoc/PR-759: fetch a packaged archive snapshot from a
# seed node, then start with `--archive-load-only` so the node hydrates the
# FULL UTXO tree from the snapshot in seconds. From that root forward,
# every block is applied in full mode and source resolution is authoritative.
#
# Mirrors what the deploy workflow does in prod (.github/workflows/deploy.yml
# fetches the same snapshot via the same script and force-recreates the
# sidecar container), so local and prod stay in lockstep on full mode.
#
# Prereq (one-time):
#   ~/.ssh/config entries for testnet-seed1 / testnet-seed2 with
#   IdentityFile pointing at the right key.
#
# Always re-fetches the archive before booting, so each `make node-full`
# starts from a fresh snapshot whose best_tip is on the canonical fork.
# A stale archive is the silent failure mode: the node will load it,
# apply its local tail in full mode, then receive live P2P blocks on a
# different fork and fall back to partial-overlay applies — exactly what
# this target is meant to avoid. To skip the fetch (e.g. iterating
# offline), run `make node-full-no-fetch`.
#
# Verify it's actually full mode (in another terminal):
#   curl -s http://localhost:$(NODE_PORT)/status | jq '.node.flags'  # includes HAS_FULL_UTXO_DB
#   grep -m1 'kind = "UtxoDb.InitFromArchive"' node.log              # archive load happened
#   grep -c   'apply_mode = "partial"' node.log                      # should stay flat after boot
node-full: fetch-archive node-full-no-fetch

node-full-no-fetch:
	@echo "=========================================="
	@echo "  make node-full -- starting at: $$(date '+%Y-%m-%d %H:%M:%S')"
	@echo "  Archive: $(ARCHIVE_DIR)"
	@echo "  Logs:    ./node.log"
	@echo "  In another terminal:"
	@echo "    curl -s http://localhost:$(NODE_PORT)/status | jq '.node.flags'"
	@echo "    grep -c 'apply_mode = \"partial\"' node.log         # should stay flat"
	@echo "=========================================="
	@$(USERNODE_BIN) node \
		--archive-load-only \
		--archive-path $(ARCHIVE_DIR) \
		--genesis-url $(GENESIS_URL) \
		--peer-list-url $(SEEDLIST_URL) \
		--port $(NODE_PORT) \
		--enable-recent-tx-stream 2>&1 \
		| tee node.log \
		| grep --line-buffered -E 'apply_mode|UtxoDb\.(InitFromArchive|ApplyError)'

# Refresh the local archive snapshot from a seed node. Wipes $(ARCHIVE_DIR)
# and replaces it with whatever's current on the seed (--replace).
#
# Uses the locally-vendored script (matches what .github/workflows/deploy.yml
# does on the prod VPS). Override the seed:
#   make fetch-archive ARCHIVE_SEED_HOST=testnet-seed2
fetch-archive:
	@echo "==> Fetching archive from $(ARCHIVE_SEED_HOST) → $(ARCHIVE_DIR)"
	./scripts/fetch-archive-snapshot.sh $(ARCHIVE_SEED_HOST) $(ARCHIVE_DIR) --replace

# ---------------------------------------------------------------------------
# Dev stack: platform + Postgres only (no sidecar — see `node-full` above).
# Run `make node-full` in a separate terminal first.
# ---------------------------------------------------------------------------

DEV_COMPOSE = docker compose -f docker-compose.dev.yml

build:
	$(DEV_COMPOSE) build

up:
	$(DEV_COMPOSE) up -d --build

# Full local teardown:
#   1. Take down the compose-managed services (platform + Postgres).
#   2. Force-remove every container the running platform spawned via raw
#      `docker run` calls in src/services/{app-creator,staging,worker}.js.
#      Those live outside compose, so a plain `docker compose down` leaves
#      them running (or stopped-but-piling-up) forever — see the
#      "usernode-app-*", "usernode-staging-*", and "usernode-worker-*"
#      containers that accumulate over weeks of dev.
#
# Volumes are intentionally NOT touched here. The CC session volumes
# (usernode-cc-session-<id>) hold Claude's on-disk conversation memory
# and the Postgres volume holds every chat history; both should survive
# a `make down` / `make up` cycle so resuming a session works the way
# pause/resume promises. To wipe those too, run `docker volume prune`
# (or `make nuke` if/when we add it).
down:
	$(DEV_COMPOSE) down
	@echo "==> Tearing down platform-spawned containers (apps/staging/workers)..."
	@for prefix in usernode-app- usernode-staging- usernode-worker-; do \
		ids=$$(docker ps -aq --filter "name=$$prefix" 2>/dev/null); \
		if [ -n "$$ids" ]; then \
			n=$$(echo $$ids | wc -w | tr -d ' '); \
			echo "  - removing $$n $${prefix}* container(s)"; \
			docker rm -f $$ids >/dev/null; \
		fi; \
	done
	@echo "==> Done."

restart:
	$(DEV_COMPOSE) restart

logs:
	$(DEV_COMPOSE) logs -f --tail=200

ps:
	$(DEV_COMPOSE) ps
