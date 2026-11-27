#!/usr/bin/env bash
# End to end, on Docker: a throwaway Postgres 17, the data service, two
# runners, a stand-in for the platform's module endpoint, and each pilot
# project on Node beside it. Then test/e2e.js builds, sets up, walks
# through, kills and races (see its header).
#
#   runtime/wasm/test/e2e.sh            build the two images, run, clean up
#   SKIP_BUILD=1 runtime/wasm/test/e2e.sh   reuse wasm-runner:e2e and wasm-data:e2e
#   KEEP=1 ...                           leave the containers up afterwards
#   WW_SRC=<dir> ...                     add World Weather (a checkout of its repository)
#   BENCH=1 ...                          also measure CPU and time per request
#                                        (50 requests a second for BENCH_SECONDS, 20)
#   WASM_WARM=N ...                      run both runners with warm instances (runner
#                                        B recycles every 3 requests, WASM_WARM_B to change)
#
# Needs docker and node on the host (and openssl for WW_SRC); npm ci in the
# Node twins reads the npm registry. Throwaway keys and secrets go to a
# fresh temporary directory (E2E_OUT to choose it) and never to the terminal.
#
# World Weather is somebody else's code: it never runs on the host. Its
# Node twin runs in a container of its own, as an unprivileged user, on a
# network of its own (reaching only its database and the stand-in
# providers), with a read-only copy of the source as its only mount; it
# installs and builds inside the container, and its tree (with the built
# stylesheet) is read back with `docker exec tar` for the Wasm build. Its
# outside services are stand-ins (mock-providers.js) answering under the
# real host names: --add-host points the names at them, and both twins
# trust the test's own certificate authority, so the app's code is not edited.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
WASM=$(dirname "$HERE")
ROOT=$(cd "$WASM/../.." && pwd)
OUT=${E2E_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/wasm-e2e.XXXXXX")}
NAME=wasm-e2e
NET=$NAME-net
PG_IMAGE=${PG_IMAGE:-postgres:17-alpine}
NODE_IMAGE=${NODE_IMAGE:-node:22.23.4-alpine}
RUNNER_IMAGE=${RUNNER_IMAGE:-wasm-runner:e2e}
DATA_IMAGE=${DATA_IMAGE:-wasm-data:e2e}
PORT_A=${PORT_A:-47101}
PORT_B=${PORT_B:-47102}
PORT_NG=${PORT_NG:-47201}
PORT_NS=${PORT_NS:-47202}
PORT_NW=${PORT_NW:-47203}
PORT_STATS=${PORT_STATS:-47301}
WW_SRC=${WW_SRC:-}
NET_WW=$NAME-ww-net
PROVIDER_HOSTS="geocoding-api.open-meteo.com api.open-meteo.com air-quality-api.open-meteo.com api.weather.gov"
CONTAINERS=("$NAME-pg" "$NAME-data" "$NAME-modules" "$NAME-runner-a" "$NAME-runner-b" "$NAME-node-grocery" "$NAME-node-signup" "$NAME-providers" "$NAME-node-ww")

say() { printf '\n== %s\n' "$*" >&2; }
teardown() {
  docker rm -f "${CONTAINERS[@]}" >/dev/null 2>&1 || true
  docker network rm "$NET" "$NET_WW" >/dev/null 2>&1 || true
}
cleanup() {
  if [ "${KEEP:-0}" = 1 ]; then say "left running (KEEP=1); files in $OUT"; return; fi
  teardown
  chmod -R u+w "$OUT" 2>/dev/null || true # the read-only source copy, so the directory can be removed
}
trap cleanup EXIT
teardown

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  say "building $RUNNER_IMAGE and $DATA_IMAGE"
  docker build -q -f "$WASM/Dockerfile.data" -t "$DATA_IMAGE" "$WASM" >/dev/null
  docker build -q -f "$WASM/Dockerfile.runner" -t "$RUNNER_IMAGE" "$WASM" >/dev/null
fi

say "keys and projects in $OUT"
mkdir -p "$OUT/modules" "$OUT/proj"
chmod 700 "$OUT"
node "$HERE/lib.js" keys "$OUT/keys"
PG_PASSWORD=$(node -e "process.stdout.write(require('crypto').randomBytes(16).toString('hex'))")
node "$HERE/generate-project.js" "$ROOT" grocery-list "Grocery Test" "$OUT/proj/grocery" >&2
node "$HERE/generate-project.js" "$ROOT" signup-shifts "Signup Test" "$OUT/proj/signup" >&2
for p in grocery signup; do
  # The Node twin's packages and stylesheet, as its image build makes them.
  docker run --rm -v "$OUT/proj/$p:/app" -w /app "$NODE_IMAGE" \
    sh -c 'npm ci --include=dev --no-audit --no-fund --loglevel=error >/dev/null && npm run build >/dev/null' >&2
  # The Wasm twin's source: the tree with the built stylesheet, without node_modules.
  tar -C "$OUT/proj/$p" --exclude=node_modules -czf "$OUT/$p.tgz" .
done

if [ -n "$WW_SRC" ]; then
  say "World Weather: a read-only copy of $WW_SRC, and the stand-in providers' certificate"
  mkdir -p "$OUT/ww-src" "$OUT/tls"
  tar -C "$WW_SRC" --exclude=.git --exclude=node_modules -cf - . | tar -C "$OUT/ww-src" -xf -
  chmod -R a-w "$OUT/ww-src"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=wasm-e2e test CA" \
    -keyout "$OUT/tls/ca.key" -out "$OUT/tls/ca.pem" 2>/dev/null
  sans=$(for h in $PROVIDER_HOSTS; do printf 'DNS:%s,' "$h"; done)
  openssl req -newkey rsa:2048 -nodes -subj "/CN=providers" -keyout "$OUT/tls/key.pem" -out "$OUT/tls/req.pem" 2>/dev/null
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "${sans%,}" >"$OUT/tls/ext.cnf"
  openssl x509 -req -in "$OUT/tls/req.pem" -CA "$OUT/tls/ca.pem" -CAkey "$OUT/tls/ca.key" -CAcreateserial \
    -days 2 -extfile "$OUT/tls/ext.cnf" -out "$OUT/tls/cert.pem" 2>/dev/null
  chmod 644 "$OUT/tls/key.pem" # read by the stand-in's container user
  WW_NODE_PASSWORD=$(node -e "process.stdout.write(require('crypto').randomBytes(16).toString('hex'))")
fi

# Single-line values for --env-file; the PEM's newlines written as \n (both twins read it so).
JWT_PUB=$(awk 'BEGIN{ORS="\\n"} {print}' "$OUT/keys/jwt.pub.pem")
umask 077
cat >"$OUT/data.env" <<EOF
WASM_PASS_PUBKEY=$(cat "$OUT/keys/pass.pub.b64")
WASM_DB_SECRET=$(cat "$OUT/keys/db.secret")
WASM_PG_HOST=$NAME-pg
WASM_PG_PORT=5432
EOF
cat >"$OUT/runner.env" <<EOF
WASM_PASS_PUBKEY=$(cat "$OUT/keys/pass.pub.b64")
WASM_RUNNER_TOKEN=$(cat "$OUT/keys/runner.token")
WASM_MODULE_URL=http://$NAME-modules:3000
WASM_DATA_ADDR=$NAME-data:3000
USERNODE_JWT_PUBLIC_KEY=$JWT_PUB
WASM_TEST_HOOKS=1
EOF
umask 022

say "postgres, the data service, the module endpoint, two runners"
docker network create "$NET" >/dev/null
docker run -d --name "$NAME-pg" --network "$NET" -e POSTGRES_PASSWORD="$PG_PASSWORD" "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME-pg" pg_isready -U postgres -q 2>/dev/null && break; sleep 0.5; done
sleep 1
psql() { docker exec -i "$NAME-pg" psql -q -U postgres -v ON_ERROR_STOP=1 "$@"; }
# Twin databases, as the platform clones them: an owner login per database,
# its password hex(HMAC-SHA256(WASM_DB_SECRET, db)). The Node twins' own databases beside them.
for db in app_grocery_staging_s301_a1b2c3_w app_signup_staging_s302_d4e5f6_w; do
  pw=$(node "$HERE/lib.js" password "$OUT/keys" "$db")
  psql >/dev/null <<SQL
CREATE ROLE "${db}_owner" LOGIN PASSWORD '$pw';
CREATE DATABASE "$db" OWNER "${db}_owner";
REVOKE ALL ON DATABASE "$db" FROM PUBLIC;
SQL
done
psql -c 'CREATE DATABASE app_grocery_node' -c 'CREATE DATABASE app_signup_node' >/dev/null
if [ -n "$WW_SRC" ]; then
  db=app_ww_staging_s303_c0ffee_w
  pw=$(node "$HERE/lib.js" password "$OUT/keys" "$db")
  # World Weather's Node twin gets a login of its own that owns its database
  # and nothing else, never the superuser.
  psql >/dev/null <<SQL
CREATE ROLE "${db}_owner" LOGIN PASSWORD '$pw';
CREATE DATABASE "$db" OWNER "${db}_owner";
REVOKE ALL ON DATABASE "$db" FROM PUBLIC;
CREATE ROLE ww_node LOGIN PASSWORD '$WW_NODE_PASSWORD';
CREATE DATABASE app_ww_node OWNER ww_node;
REVOKE ALL ON DATABASE app_ww_node FROM PUBLIC;
SQL
fi

docker run -d --name "$NAME-data" --network "$NET" --env-file "$OUT/data.env" "$DATA_IMAGE" >/dev/null
docker run -d --name "$NAME-modules" --network "$NET" -v "$OUT/modules:/modules:ro" -v "$HERE:/test:ro" -v "$OUT/keys/runner.token:/token:ro" \
  "$NODE_IMAGE" node /test/module-server.js /modules 3000 /token >/dev/null
RUNNER_EXTRA=()
if [ -n "$WW_SRC" ]; then
  docker network create "$NET_WW" >/dev/null
  docker network connect "$NET_WW" "$NAME-pg"
  docker run -d --name "$NAME-providers" --network "$NET" -v "$HERE:/test:ro" -v "$OUT/tls:/tls:ro" -p "127.0.0.1:$PORT_STATS:8080" \
    "$NODE_IMAGE" node /test/mock-providers.js /tls/cert.pem /tls/key.pem >/dev/null
  docker network connect "$NET_WW" "$NAME-providers"
  ip_on() { docker inspect -f "{{(index .NetworkSettings.Networks \"$2\").IPAddress}}" "$1"; }
  PROVIDERS_IP=$(ip_on "$NAME-providers" "$NET")
  PROVIDERS_IP_WW=$(ip_on "$NAME-providers" "$NET_WW")
  for h in $PROVIDER_HOSTS; do RUNNER_EXTRA+=(--add-host "$h:$PROVIDERS_IP"); done
  RUNNER_EXTRA+=(-v "$OUT/tls/ca.pem:/tls/ca.pem:ro" -e WASM_FETCH_EXTRA_CA=/tls/ca.pem)
fi
# Runner A restarts after the kill test's exit, as its pod would. It may
# call private addresses (the test's slow service and stand-in providers
# are); B keeps the default.
WARM_A=${WASM_WARM:-0}
WARM_B=${WASM_WARM_B:-$([ "$WARM_A" -gt 0 ] && echo 3 || echo 0)}
RUNNER_EXTRA+=(-e WASM_WARM_IDLE_MS="${WASM_WARM_IDLE_MS:-60000}")
docker run -d --name "$NAME-runner-a" --network "$NET" --restart on-failure --env-file "$OUT/runner.env" -e WASM_FETCH_ALLOW_PRIVATE=1 -e WASM_WARM="$WARM_A" \
  ${RUNNER_EXTRA[@]+"${RUNNER_EXTRA[@]}"} -p "127.0.0.1:$PORT_A:3000" "$RUNNER_IMAGE" >/dev/null
docker run -d --name "$NAME-runner-b" --network "$NET" --env-file "$OUT/runner.env" -e WASM_WARM="$WARM_B" \
  ${RUNNER_EXTRA[@]+"${RUNNER_EXTRA[@]}"} -p "127.0.0.1:$PORT_B:3000" "$RUNNER_IMAGE" >/dev/null

say "the Node twins"
node_twin() { # name app-id app-name slug db port
  docker run -d --name "$NAME-node-$1" --network "$NET" -v "$OUT/proj/$1:/app" -w /app -p "127.0.0.1:$6:3000" \
    -e DATABASE_URL="postgres://postgres:$PG_PASSWORD@$NAME-pg:5432/$5" -e USERNODE_JWT_PUBLIC_KEY="$JWT_PUB" \
    -e USERNODE_APP_ID="$2" -e USERNODE_ENV=staging -e USERNODE_APP_NAME="$3" -e USERNODE_APP_SLUG="$4" -e PORT=3000 \
    "$NODE_IMAGE" node server.js >/dev/null
}
node_twin grocery 201 "Grocery Test" grocery-test app_grocery_node "$PORT_NG"
node_twin signup 202 "Signup Test" signup-test app_signup_node "$PORT_NS"
if [ -n "$WW_SRC" ]; then
  ww_hosts=()
  for h in $PROVIDER_HOSTS; do ww_hosts+=(--add-host "$h:$PROVIDERS_IP_WW"); done
  # The CA arrives as a variable (no second mount) and is written inside.
  docker run -d --name "$NAME-node-ww" --network "$NET_WW" --user node --cap-drop ALL --security-opt no-new-privileges \
    -v "$OUT/ww-src:/src:ro" "${ww_hosts[@]}" -p "127.0.0.1:$PORT_NW:3000" \
    -e CA_PEM="$(cat "$OUT/tls/ca.pem")" -e DATABASE_URL="postgres://ww_node:$WW_NODE_PASSWORD@$NAME-pg:5432/app_ww_node" \
    -e USERNODE_JWT_PUBLIC_KEY="$JWT_PUB" -e USERNODE_APP_ID=203 -e USERNODE_ENV=staging -e PORT=3000 \
    "$NODE_IMAGE" sh -c 'cp -R /src /home/node/app && chmod -R u+w /home/node/app && cd /home/node/app \
      && npm ci --include=dev --no-audit --no-fund --loglevel=error >/dev/null && npm run build >/dev/null \
      && printf "%s\n" "$CA_PEM" > /home/node/ca.pem && NODE_EXTRA_CA_CERTS=/home/node/ca.pem exec node server.js' >/dev/null
fi

wait_up() {
  for _ in $(seq 1 120); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 0.5; done
  echo "not up: $1" >&2; return 1
}
for u in "http://127.0.0.1:$PORT_A/health" "http://127.0.0.1:$PORT_B/health" "http://127.0.0.1:$PORT_NG/health" "http://127.0.0.1:$PORT_NS/health"; do wait_up "$u"; done
WW_ENV=()
if [ -n "$WW_SRC" ]; then
  wait_up "http://127.0.0.1:$PORT_NW/health" || { docker logs --tail 20 "$NAME-node-ww" >&2; exit 1; }
  # The Wasm twin's source: the same tree, read back from the container.
  docker exec "$NAME-node-ww" tar -C /home/node/app --exclude=./node_modules -czf - . >"$OUT/ww.tgz"
  WW_ENV=(WW_TGZ="$OUT/ww.tgz" NODE_WW="http://127.0.0.1:$PORT_NW" PROVIDER_STATS="http://127.0.0.1:$PORT_STATS")
fi

say "running test/e2e.js"
status=0
KEYS="$OUT/keys" MODULES="$OUT/modules" PG_CONTAINER="$NAME-pg" \
RUNNER_A="http://127.0.0.1:$PORT_A" RUNNER_B="http://127.0.0.1:$PORT_B" \
NODE_GROCERY="http://127.0.0.1:$PORT_NG" NODE_SIGNUP="http://127.0.0.1:$PORT_NS" \
GROCERY_TGZ="$OUT/grocery.tgz" SIGNUP_TGZ="$OUT/signup.tgz" SLOW_URL="http://$NAME-modules:3000" \
CONTAINER_PREFIX="$NAME" BENCH="${BENCH:-0}" BENCH_SECONDS="${BENCH_SECONDS:-20}" WARM_A="$WARM_A" WARM_B="$WARM_B" \
  env ${WW_ENV[@]+"${WW_ENV[@]}"} node "$HERE/e2e.js" | tee "$OUT/summary.json" || status=$?

say "runner logs (last lines)"
for c in "$NAME-runner-a" "$NAME-runner-b" "$NAME-data"; do echo "-- $c" >&2; docker logs --tail 5 "$c" 2>&1 | cut -c1-400 >&2; done
[ "$status" = 0 ] && say "PASS ($OUT/summary.json)" || say "FAIL ($OUT/summary.json)"
exit "$status"
