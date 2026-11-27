# Wasm backends for previews (pilot)

A project an admin switches to Wasm gets, for each proposal preview, a second
preview from the same commit: its backend compiled to WebAssembly (QuickJS
through Javy) and run on shared **runners** in Kata microVMs, reaching its
database only through the **data service**. The Node preview is unchanged.
Evidence and thresholds: the v2 framework document's step 3 ("Previews on
Wasm"); this directory is the runtime, `src/services/wasm-*.js` the platform
side.

```
common/   the pass, the twin database's name and password, frames, log lines (Rust)
runner/   the runner (Rust, Wasmtime 51)
dsvc/     the data service (Rust, tokio-postgres)
guest/    the guest runtime and the adapters bundled into every module (JavaScript)
test/     e2e.sh (Docker end to end) and its helpers
Dockerfile.runner, Dockerfile.data
```

## Parts and who trusts whom

```
browser ──> edge ──> app gate ──────────────> runner (Kata VM, many apps)
                       │  asks the platform:       │  runs the module named by the pass
                       │  identity + pass          │  queries ──> data service ──> preview Postgres
                       │                           │                (one login per twin)
platform ──(build: source tar)──────────────────> runner /_wasm/build (bundle + compile in the VM)
platform <──(module by hash)──────────────────── runner (module cache miss)
```

- The **platform** holds the pass signing key and the database secret. It
  never runs an app's code: it sends the source tree to a runner to bundle
  and compile, stores the returned module, and signs passes.
- The **app gate** (`scripts/app-gate.js`) holds no key. For a Wasm twin the
  platform's access answer names the runner Service, the identity, the pass
  and `X-Usernode-Runtime: wasm`; the gate adds an operation ID to every
  request that is not GET/HEAD/OPTIONS and retries once, with the same ID,
  when the runner fails before sending a response byte.
- A **runner** trusts nothing it is sent: it checks the pass's signature,
  loads only modules it compiled itself from Wasm whose SHA-256 the pass
  names, and never sees a database password.
- The **data service** checks the pass, derives the twin database's password
  from the database name and its secret, and keeps a pool per database.

## The pass (version 1)

`base64url(JSON) "." base64url(Ed25519 signature over the first part)`,
signed by the platform with `WASM_PASS_KEY` (PKCS#8), checked with
`WASM_PASS_PUBKEY` (raw 32 bytes, base64) by runners and the data service.

```json
{ "v": 1, "app": 123, "ses": 456, "mod": "<sha256 hex of the module>",
  "db": "app_slug_staging_s456_ab12cd_w", "user": 789, "scope": "req", "exp": 1795800000,
  "env": { "USERNODE_APP_NAME": "Plant Pal", "USERNODE_APP_SLUG": "plant-pal" } }
```

- `scope`: `req` for a request (expires in 60 s), `setup` for the release's
  setup run (300 s). `user` is an integer, or null for a guest. `mod` is
  lowercase hex.
- `env` (optional): extra environment the app sees in `process.env`, as its
  container would: `USERNODE_APP_NAME` and `USERNODE_APP_SLUG` (the page's
  name, the canonical address), `USERNODE_PLATFORM_ORIGIN`,
  `USERNODE_PLATFORM_API_V1_URL` and the like. Keys `[A-Z0-9_]`, at most 64
  characters; values at most 4 KiB. The runner always sets `USERNODE_APP_ID`
  (the pass's `app`), `USERNODE_ENV` (`staging` unless `env` says otherwise),
  `USERNODE_JWT_PUBLIC_KEY`, `PORT` and a placeholder `DATABASE_URL`.
- The data service refuses a pass whose `db` does not match
  `^app_[a-z0-9_]+_staging_s[0-9]+_[0-9a-f]{6}_w$` (twin databases only;
  `src/services/wasm-previews.js` `TWIN_DB_RE`).

## Runner (`runner/`, port 3000)

- `GET /health` without a pass: 200 `{ok, engine, modules, module_bytes}`
  (with a pass it is the app's own `/health`).
- Any other request with `x-usernode-pass`: the app's request. Also read:
  the identity token, `?token=` first and then `x-usernode-token` (the order
  the generated `server.js` reads them; RS256, checked with
  `USERNODE_JWT_PUBLIC_KEY`, issuer `usernode`, audience
  `usernode:app:<pass.app>`; the claims reach the app as its signed-in user),
  `x-usernode-op` (operation ID, `[A-Za-z0-9_.:-]{1,128}`, sent on to the
  data service). No pass, a bad pass, a `setup` pass, or an unknown module:
  502 `{"error": "<short reason>"}`, never the app. The app's own failures:
  500 (it crashed, ran past its time limit, or ended without answering), 504
  past `WASM_REQUEST_TIMEOUT_MS`.
- `POST /_wasm/build`, `authorization: Bearer <WASM_RUNNER_TOKEN>` (else 401),
  body a gzip tar of the commit's tree (at most 20 MB, else 413; one wrapping
  top directory is unwrapped): bundles the server entry (`server.js`, else
  `package.json` `main`) with esbuild, pointing `express`, `pg`,
  `jsonwebtoken`, Node's modules and a few small Express companions at the
  adapters (`guest/aliases.json`), then compiles it with Javy (dynamic,
  against the image's engine). The project's files go into the module as
  they are (see "What a module is"). Answers the module (`application/wasm`)
  with `x-module-sha256`, `x-build-ms`, `x-bundle-bytes` and
  `x-files-bytes`, or 422 `{"error": "<reason>"}` (an npm package or Node
  module the adapters do not cover, by name; a syntax error).
- **The build runs no project code.** Tailwind's build would (it loads the
  project's `tailwind.config.js`), so the runner does not run it: the
  platform puts the built `public/tailwind.css` into the tar (the Node twin's
  image build makes it), or the page has no stylesheet.
- `POST /_wasm/setup`, the bearer token and a `setup` pass: runs the
  module's top-level code once with queries allowed (the `CREATE TABLE IF NOT
  EXISTS` a container runs at every boot: a generated project's `start()`,
  which awaits `api.migrate(pool)`). Answers 200 `{ ok, statements, ms }`,
  with `error` when not ok (a throw, `process.exit(n)`, `process.exitCode`
  set) and `log` (the app's console) when it printed anything; 401 without
  the token, 502 for the pass or the module.
- Modules: on a miss, `GET ${WASM_MODULE_URL}/<sha256>` with the bearer
  token (404: unknown module); the bytes must hash to the name. Compiled
  modules are kept in memory (LRU by bytes, `WASM_MODULE_CACHE_MB`); a
  module asked for by many requests at once is fetched once. A module built
  by a runner with another engine (another Javy) is refused with 502 "built
  for another runner version": build it again.
- Test hook, only with `WASM_TEST_HOOKS=1`: `x-usernode-test:
  kill-after-commit` makes the process exit as soon as the data service has
  answered the request's first write (a statement outside a transaction
  that is not a read, or a COMMIT), before anything is sent back.
- Logs: one JSON line on stderr per request (`app`, `ses`, `mod`, `m`,
  `path` without the query, `status`, `ms`, `queries`, `fetches`, `user`,
  `op`, `warm` (the instance, when warm) and `discarded`, and
  `error`/`console` when there are), per build, per setup.

### Env

| Variable | Default | |
|---|---|---|
| `PORT` | 3000 | |
| `WASM_PASS_PUBKEY` | required | raw Ed25519 public key, base64 |
| `WASM_RUNNER_TOKEN` | required | bearer for build, setup and module fetches |
| `WASM_MODULE_URL` | none | without it, only modules built on this runner |
| `WASM_DATA_ADDR` | required | the data service, `host:port` (looked up once, again after a failure) |
| `USERNODE_JWT_PUBLIC_KEY` | none | PEM; `\n` written as two characters is accepted. Without it everyone is signed out |
| `USERNODE_GUEST_JWT_PUBLIC_KEY` | none | PEM (ES256), for apps that verify guest tokens |
| `WORKERS` | CPUs | threads |
| `EPOCH_MS` | 10 | the interrupt tick; a running instance yields each tick |
| `WASM_CPU_MS`, `WASM_SETUP_CPU_MS` | 2000, 60000 | running time a request (a setup) may use |
| `WASM_REQUEST_TIMEOUT_MS`, `WASM_SETUP_TIMEOUT_MS` | 30000, 240000 | wall clock |
| `WASM_MEMORY_MB` | 64 | per instance |
| `WASM_SLOTS` | 256 | instances at once (Wasmtime's pooling allocator) |
| `WASM_MODULE_CACHE_MB` | 512 | compiled modules kept |
| `WASM_BUILD_DIR` | `/tmp` | must be writable (an emptyDir with a read-only root) |
| `WASM_BUILD_CONCURRENCY`, `WASM_BUILD_TIMEOUT_MS` | 2, 120000 | |
| `WASM_FETCH_TIMEOUT_MS` | 30000 | an app's outside call |
| `WASM_FETCH_ALLOW_PRIVATE` | 0 | 1 lets apps call private, loopback and link-local addresses (tests only) |
| `WASM_FETCH_EXTRA_CA` | none | a PEM bundle apps' outside calls trust besides the usual roots (tests only: stand-in providers) |
| `WASM_APP_ENV` | `staging` | the app's `USERNODE_ENV` |
| `WASM_TEST_HOOKS` | 0 | |
| `WASM_WARM` | 0 | 0: a fresh instance per request. N > 0: warm instances, each recycled after N requests (see "Warm instances") |
| `WASM_WARM_IDLE_MS` | 60000 | a warm instance unused this long is let go |
| `WASM_WARM_MAX` | 200 | warm instances per runner process, least recently used let go first (`WASM_SLOTS` is raised to at least this + 64) |
| `WASM_WARM_PER_MODULE` | 1 | warm instances per module, app, database and environment |
| `WASM_WARM_MEMORY_MB` | `WASM_MEMORY_MB` / 2 | a warm instance whose memory has grown past this is let go after its request |
| `WASM_GUEST_DIR`, `WASM_PLUGIN`, `WASM_JAVY`, `WASM_ESBUILD` | the image's | |

## Warm instances (opt-in)

By default every request gets a fresh instance: nothing an app keeps in
memory outlives the request. With `WASM_WARM=N`, an instance is kept after
its request and serves the next requests of the same app, and its globals
last, as they do in the app's container today: World Weather's cache of
forecasts and place names, a parsed data file. The trade-off: **an app's
requests share its globals** (one request can leave something a later one
sees, as on Node); **apps stay separated from each other exactly as
before**: an instance is bound to one module, one app, one database and one
environment (the pass's `env`), and is never used for anything else.

- An instance serves one request at a time. A request that finds its app's
  warm instances busy (`WASM_WARM_PER_MODULE`) runs in a fresh one; nothing
  waits.
- Its memory only grows: the Javy plugin's QuickJS never runs its cycle
  collector, so garbage that refers to itself (Express's request and
  response, most app objects) stays. A warm instance is therefore also let
  go once its memory passes `WASM_WARM_MEMORY_MB` (half the instance limit
  by default): about 15 KB a request for a small read, 60 to 80 KB for World
  Weather's 853 districts, so several hundred to a few thousand requests per
  instance. Without that line it would run out of memory (seen at 794
  requests of the 853 districts in a 64 MiB instance).
- It is let go after N requests, after `WASM_WARM_IDLE_MS` unused, when the
  runner needs room (`WASM_WARM_MAX`, least recently used first), and at
  once after a request that went wrong: a trap, the time limit, running out
  of memory, an uncaught error or unhandled rejection (Node stops for those
  too), `process.exit`, or no answer. The next request gets a new instance,
  which boots the app again.
- What belongs to a request is the request's alone, exactly as in a fresh
  instance: its headers, identity, environment, operation ID, host calls,
  pinned database connections (released or rolled back when it ends), time
  limit and kill-after-commit hook. Timers left when a request is done are
  dropped (in a fresh instance they were too).
- The guest learns it is warm from its request frame and reports each
  request's end with a `D` frame `{discard}`; a module built before this
  runs as a fresh instance whatever the setting.

## What a module is

Javy's dynamically linked module (the app's QuickJS bytecode; QuickJS itself
is the plugin every module shares) plus two custom sections the build
appends: `usernode.meta` (`{abi, engine, entry}`: the guest protocol and the
first 16 hex of the plugin's SHA-256) and `usernode.files` (every file of
the tree but dotfiles, `node_modules`, `*.md`, `LICENSE*`, `Dockerfile*`,
lockfiles and `project.toml`; at most 50 MiB). The app reads its files
(`fs.readFileSync`, `res.sendFile`, `express.static`) from there; a static
file's bytes are sent by the runner and never enter the instance. The
project is at `/app`, as in its container. The same tree and runner image
give the same module, byte for byte.

## The guest (`guest/`)

`runtime.js` is bundled first into every module: one request per instance,
an event loop in JavaScript over a replaced `Promise` (the plugin has none;
the build lowers `async` functions to generators), and the host calls.
Queries and outside calls an app starts together go to the runner as one
frame and run concurrently there: queries outside a transaction as one batch
to the data service, `fetch`es at the same time. Also there: `Buffer`,
`process`, timers, `URL`, `URLSearchParams`, `fetch` with `Headers`,
`Request`, `Response`, `AbortController` and `AbortSignal.timeout`,
`crypto.randomUUID`, `structuredClone`, `atob`/`btoa`, and a console that
writes to the log. The adapters (`guest/adapters/`) are Express 4, node-pg,
jsonwebtoken, read-only `fs`, `path`, `events`, `crypto` (random bytes,
SHA and HMAC), `url`, `util`, `http.createServer`, `querystring` and small
ones, plus `cors`, `body-parser`, `cookie-parser`, `dotenv`, `uuid`,
`node-fetch`, and `compression`, `helmet` and `morgan` as no-ops.

What differs from the same code on Node, known:

- A request runs the app's top-level code again (cheap), but the queries it
  starts there are skipped: migrations belong to `/_wasm/setup`.
- In-memory state lasts one request (a cache, a counter, who is listening).
- Timers fire only while the request waits for its answer, at once (time
  does not pass for them); those left after the answer are dropped.
- An event stream (`text/event-stream`, live-updates.js) is answered with
  what the handler wrote and closed; the page reconnects after its `retry`
  (3 s), so another person's change shows within seconds, not at once.
- No `Intl`: `localeCompare` is not locale-aware. Engine error messages
  differ (`JSON.parse`'s wording, stack traces).
- `fs` is read-only; no `child_process`, `net`, sockets, `zlib`, streams,
  WebSockets; `crypto` has no ciphers or key pairs. A project that needs
  them fails its build by name.
- No ETag or 304 answers, no `Last-Modified` on static files.
- An RS256 or ES256 token is checked against Homeroom's keys whatever key
  the app passes to `jsonwebtoken.verify` (the app is only ever given those).
- Outside calls cannot reach private addresses; a response body is at most
  16 MiB.
- An app's secrets (dapp.json `secrets`) are not passed (the pass's `env`
  could carry them, but it travels in a header).

## Data service (`dsvc/`, port 3000)

Frames of `u32 little-endian length` + JSON, as measured in the validation
run, each carrying the request's `pass`:

- `{pass, r, c, s, p, op, seq}`: one statement. `p` are text values (or
  null); Postgres infers their types, as with node-pg. Without values a
  string holding several statements runs as a simple query (a migration).
- `{pass, r, b: [{s, p, op, seq}, …]}`: a batch. Reads with no operation ID
  run together on one connection (pipelined); anything else one by one, in
  order. Answer `{"rs": [...]}`.
- `c` > 0: a client (node-pg's `pool.connect()`, a transaction) holding one
  connection from its first statement until `{pass, r, c, rel: true}`
  (answer `{"ok":true}`; an open transaction is rolled back first) or until
  the runner's connection closes, when it is closed and so rolled back,
  never handed on. A client's frames must come over one runner connection.
- `{ctl: "health"}` and `{ctl: "stats"}` answer without a pass. The platform
  probes the TCP port; there is no HTTP endpoint.

A result is `{"f": [names], "t": [type oids], "n": rows, "cmd": "SELECT",
"rows": [[…], …]}` with values as node-pg gives them (int8 and numeric as
strings, timestamps as epoch milliseconds the guest makes Dates of, json as
JSON, bytea as base64, arrays as arrays). An error is `{"e": message, "code":
SQLSTATE, …}` with node-pg's fields (`detail`, `constraint`, `table`, …); a
refused pass is `{"e": …, "code": "pass"}`.

**Operation IDs.** Every statement carrying one (reads too) stores its
result in the database's `_ops` table (created on first use, rows kept a
day) in the same transaction as the statement; asked again with the same
`(op, seq)`, the stored result is answered instead. So a retried request
sees what the first attempt saw up to where it stopped, and answers the
same. Inside a transaction they are stored with it, and roll back with it.
BEGIN, COMMIT and ROLLBACK are never stored.

Env: `PORT` (3000), `WASM_PASS_PUBKEY`, `WASM_DB_SECRET`, `WASM_PG_HOST`
(looked up once, again after a failure), `WASM_PG_PORT` (5432), `CAP`
(connections per replica, 20), `PER_APP` (per database, 4), `IDLE_MS`
(5000), `WORKERS`, `WASM_STATEMENT_TIMEOUT_MS` (30000),
`WASM_IDLE_TX_TIMEOUT_MS` (15000: Postgres ends a transaction left idle
longer). No TLS to Postgres.

Password of a twin database's owner login (`<db>_owner`):
`hex(HMAC-SHA256(WASM_DB_SECRET, db))`, the secret's bytes as the key, set
by the platform when it clones the database.

## Images

`Dockerfile.runner` (the runner, Javy 9.1.0, esbuild 0.28.2, the engine
plugin `javy emit-plugin` makes, the guest) and `Dockerfile.data` (the data
service), both with build context `runtime/wasm`, no build target. Built by
`.github/workflows/build-kubernetes-images.yml` as the `wasm-runner` and
`wasm-data` components (linux/amd64; they build on arm64 too). Debian trixie
slim, base images pinned by digest, tool downloads by version and SHA-256.
Both run as UID 1000 and listen on `PORT` (3000). Runner pods have no init
container: work in an init container kills a Kata VM 45 s in (measured on
the cluster, 27 Nov 2026). The engine is per image architecture: a module
built by an arm64 runner is refused by an amd64 one.

## Tests

- `cargo test --workspace`: the pass (signing, refusals), the twin
  database's name and password, frames, the module cache's LRU and its
  checks, result encoding, transaction statements, the build's file rules,
  the warm pool (binding, busy means fresh, recycling, letting go after an
  error, least recently used, idle).
- `test/e2e.sh` (Docker and node on the host; `SKIP_BUILD=1` reuses the
  images, `KEEP=1` leaves them up): Postgres 17, the data service, two
  runners, a stand-in module endpoint, and each starter on Node beside it.
  It generates the `grocery-list` and `signup-shifts` projects with the
  platform's own generator (`src/services/template.js`), builds them through
  runner A, sets them up through runner B (which fetches the modules by
  hash), compares every answer of a walkthrough per app with the Node twin
  (signed in, as another person, signed out), kills runner A after a commit
  (a write, and a transaction) and retries on B with the same operation ID,
  races 20 people for a sign-up sheet's last place on both twins, and checks
  outside calls (they overlap), timers, crypto, the time limit, the
  private-address guard and an event stream. Prints a JSON summary.
  - `WW_SRC=<checkout>` adds World Weather (somebody else's code: its Node
    twin runs only in a container of its own, unprivileged, on its own
    network, with a read-only copy of the source). Its outside services are
    stand-ins (`test/mock-providers.js`) under the real host names
    (`--add-host`, and a test certificate authority both twins trust), so
    its code is not edited. Differences that are known (a list sorted by
    `localeCompare`) are reported under `known_differences`, not failed.
  - `BENCH=1` (`BENCH_SECONDS`, 20) also measures, at 50 requests a second,
    each side's wall time and CPU per request from its containers' cgroups:
    the grocery list's read and World Weather's routes. And the runner's
    resident memory per app (20 grocery-list apps, 10 World Weather apps).
  - `WASM_WARM=N` runs the runners with warm instances (runner B recycles
    every 3 requests): the same walkthroughs, kill test and race, plus
    checks that an app's globals last between its requests, never reach
    another app, database or environment, start empty after a recycle and
    after an error, and that a busy instance is not waited for.
