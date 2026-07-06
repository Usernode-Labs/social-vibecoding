// Tests for the worker-container wiring of the optional in-loop browser:
// worker/Dockerfile, worker/worker-run.sh, worker/run-cc.sh.
//
// These assert the build-ONLY gating at the shell layer (where it actually
// lives) without needing Docker: the Playwright MCP server is wired into
// `claude` for MODE=build only, scout/sync invocations are byte-for-byte
// unchanged, and the commit/push/result emission is independent of the
// browser path (so a turn whose app won't boot still commits — graceful
// degradation).
//
// Run with: node --test tests/worker-inloop-browser-wiring.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_DIR = path.join(__dirname, '..', 'worker');
const read = (f) => fs.readFileSync(path.join(WORKER_DIR, f), 'utf8');

// ── Dockerfile: pinned Playwright + Chromium + MCP server ────────────────

test('Dockerfile installs a PINNED Playwright, Chromium, and the MCP server', () => {
  const df = read('Dockerfile');
  assert.match(df, /ARG PLAYWRIGHT_VERSION=/);
  assert.match(df, /ARG PLAYWRIGHT_MCP_VERSION=/);
  // pinned, not a floating tag
  assert.match(df, /playwright@\$\{PLAYWRIGHT_VERSION\}/);
  assert.match(df, /@playwright\/mcp@\$\{PLAYWRIGHT_MCP_VERSION\}/);
  assert.doesNotMatch(df, /playwright@latest|@playwright\/mcp@latest/);
  // the matching Chromium build + its runtime deps
  assert.match(df, /playwright@\$\{PLAYWRIGHT_VERSION\} install --with-deps chromium/);
  // browsers cached under /home/node so the existing chown picks them up
  assert.match(df, /PLAYWRIGHT_BROWSERS_PATH=\/home\/node\//);
});

// ── worker-run.sh: seed the MCP config at bootstrap ──────────────────────

test('worker-run.sh seeds the Playwright MCP config alongside the .claude.json restore', () => {
  const wr = read('worker-run.sh');
  assert.match(wr, /BROWSER_MCP_CONFIG=\/home\/node\/\.usernode-mcp\.json/);
  assert.match(wr, /"mcpServers"/);
  assert.match(wr, /"playwright"/);
  assert.match(wr, /@playwright\/mcp/);
  assert.match(wr, /--headless/);
  assert.match(wr, /--isolated/);
});

// ── run-cc.sh: build-only MCP flags, strict config, scout/sync untouched ─

test('run-cc.sh gates the MCP flags on MODE=build and uses --strict-mcp-config', () => {
  const cc = read('run-cc.sh');
  // gated strictly on build, only when the seeded config exists
  assert.match(cc, /if \[ "\$MODE" = "build" \] && \[ -f "\$BROWSER_MCP_CONFIG" \]; then\s*\n\s*BROWSER_MCP_FLAGS="--mcp-config \$BROWSER_MCP_CONFIG --strict-mcp-config"/);
  // default config path is provided so the var is always defined
  assert.match(cc, /BROWSER_MCP_CONFIG:=\/home\/node\/\.usernode-mcp\.json/);
});

test('run-cc.sh applies the MCP flags to the build/scout claude invocations', () => {
  const cc = read('run-cc.sh');
  // the three non-sync invocations (resume, resume-retry, fresh) carry the
  // (possibly empty) browser flag var right after PERMISSION_FLAGS
  const matches = cc.match(/claude --print \$PERMISSION_FLAGS \$BROWSER_MCP_FLAGS --verbose/g) || [];
  assert.equal(matches.length, 3);
});

test('the sync-branch claude invocation does NOT get browser tooling', () => {
  const cc = read('run-cc.sh');
  // sync uses a fixed flag set with no MCP wiring
  assert.match(cc, /claude --print --dangerously-skip-permissions --verbose\s*\\\s*\n\s*--model "\$MODEL" --output-format stream-json -p "\$SYNC_PROMPT"/);
  // and BROWSER_MCP_FLAGS never appears inside the MODE=sync block
  const syncStart = cc.indexOf('if [ "$MODE" = "sync" ]; then');
  const syncEnd = cc.indexOf('# ── end MODE=sync');
  assert.ok(syncStart !== -1 && syncEnd > syncStart);
  const syncBlock = cc.slice(syncStart, syncEnd);
  assert.doesNotMatch(syncBlock, /BROWSER_MCP_FLAGS/);
});

// ── graceful degradation: commit/push/result is independent of browser ───

test('scout/sync get empty browser flags by default (var initialised empty before the build gate)', () => {
  const cc = read('run-cc.sh');
  // scout still short-circuits with its own RESULT line
  assert.match(cc, /mode=scout/);
  // BROWSER_MCP_FLAGS is initialised to "" and only reassigned inside the
  // MODE=build gate, so scout/sync invocations expand it to nothing —
  // their claude calls are unchanged.
  assert.match(cc, /BROWSER_MCP_FLAGS=""\s*\nif \[ "\$MODE" = "build" \]/);
});

test('build commit + push + RESULT are emitted unconditionally, not under any browser guard', () => {
  const cc = read('run-cc.sh');
  // The commit/push/result block sits after the claude call and is not
  // nested inside any `if ... BROWSER ...` — so whether or not the agent
  // used (or failed to boot) the browser, the turn still commits and
  // reports. Assert the phases exist at column 0 (top-level), unguarded.
  assert.match(cc, /\necho "__USERNODE_PHASE__ commit"/);
  assert.match(cc, /\necho "__USERNODE_PHASE__ push"/);
  assert.match(cc, /\necho "__USERNODE_RESULT__ cc_exit=\$CC_EXIT[^\n]*mode=build"/);
});
