// Tests for the worker-container wiring of the optional in-loop browser:
// worker/Dockerfile, worker/worker-run.sh, worker/run-cc.sh.
//
// These assert the purpose-bound browser gating at the shell layer (where it
// actually lives) without needing Docker: build gets the general browser,
// evidence gets its isolated paired-origin browser, scout/sync stay unchanged,
// and commit/push/result emission remains independent of browser availability.
//
// Run with: node --test tests/worker-inloop-browser-wiring.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_DIR = path.join(__dirname, '..', 'worker');
const read = (f) => fs.readFileSync(path.join(WORKER_DIR, f), 'utf8');

// ── Dockerfile: pinned MCP server + its revision-matched Chromium ────────

test('Dockerfile installs a PINNED MCP server and Chromium via its bundled Playwright', () => {
  const df = read('Dockerfile');
  assert.match(df, /ARG PLAYWRIGHT_MCP_VERSION=/);
  // pinned, not a floating tag
  assert.match(df, /@playwright\/mcp@\$\{PLAYWRIGHT_MCP_VERSION\}/);
  assert.doesNotMatch(df, /@playwright\/mcp@latest/);
  // NO standalone playwright pin: browsers must be installed by the MCP's
  // own bundled playwright, or the downloaded Chromium revision drifts
  // from the one the server launches (#688: chromium-1148 installed,
  // chromium-1194 expected → every launch failed).
  assert.doesNotMatch(df, /ARG PLAYWRIGHT_VERSION=/);
  // the browser install runs FROM the MCP package directory so npx
  // resolves its package-local playwright CLI (revision match by
  // construction), and still pulls Chromium's apt runtime deps
  assert.match(df, /cd \/usr\/local\/lib\/node_modules\/@playwright\/mcp[\s\S]{0,120}playwright install --with-deps chromium/);
  // browsers cached under /home/node so the existing chown picks them up
  assert.match(df, /PLAYWRIGHT_BROWSERS_PATH=\/home\/node\//);
});

test('Dockerfile smoke-tests a headless Chromium launch at image build time, as node', () => {
  const df = read('Dockerfile');
  // launches the bundled-chromium channel with the SwiftShader flags the
  // seeded config uses, so a future pin bump that reintroduces a
  // channel/revision mismatch fails the image build instead of silently
  // degrading every build turn
  const smokeIdx = df.search(/RUN cd \/usr\/local\/lib\/node_modules\/@playwright\/mcp[\s\S]{0,80}chromium\.launch/);
  assert.ok(smokeIdx !== -1, 'smoke-test RUN present');
  assert.match(df, /chromium\.launch\(\{channel:'chromium',headless:true,chromiumSandbox:false/);
  assert.match(df, /--enable-unsafe-swiftshader/);
  // runs after the final USER node switch (browsers are node-owned by then)
  const userNodeIdx = df.lastIndexOf('USER node');
  assert.ok(userNodeIdx !== -1 && smokeIdx > userNodeIdx, 'smoke test runs as node');
});

// ── worker-run.sh: seed the MCP config at bootstrap ──────────────────────

test('worker-run.sh seeds the Playwright MCP config alongside the .claude.json restore', () => {
  const wr = read('worker-run.sh');
  assert.match(wr, /BROWSER_MCP_CONFIG=\/home\/node\/\.usernode-mcp\.json/);
  assert.match(wr, /"mcpServers"/);
  assert.match(wr, /"playwright"/);
  assert.match(wr, /"command": "\/usr\/local\/bin\/mcp-server-playwright"/);
  // bundled-Chromium channel — without it the MCP defaults to branded
  // Google Chrome, which the image doesn't ship (#688)
  assert.match(wr, /"--browser", "chromium"/);
  assert.match(wr, /--headless/);
  assert.match(wr, /--isolated/);
  assert.match(wr, /--no-sandbox/);
  // Saved screenshots/snapshots land outside the app checkout; the MCP
  // default (./.playwright-mcp) put them where `git add -A` committed them.
  assert.match(wr, /BROWSER_OUTPUT_DIR=\/tmp\/usernode-playwright-output/);
  assert.match(wr, /"--output-dir", "\$BROWSER_OUTPUT_DIR"/);
});

test('worker-run.sh keeps agent tool output out of every checkout, old apps included', () => {
  const wr = read('worker-run.sh');
  // The local exclude file, not the app's .gitignore: it is never committed,
  // and it covers apps scaffolded before the template carried these entries.
  const block = wr.slice(wr.indexOf('for USERNODE_EXCLUDE in'), wr.indexOf('# Idempotent submodule sync'));
  assert.ok(block.length > 0, 'exclude block present before the submodule sync');
  for (const entry of ['.playwright-mcp/', 'test-results/', 'playwright-report/']) {
    assert.ok(block.includes(`'${entry}'`), `excludes ${entry}`);
  }
  assert.match(block, /grep -qxF "\$USERNODE_EXCLUDE" \.git\/info\/exclude/, 'idempotent across warm re-bootstraps');
  assert.match(block, />> \.git\/info\/exclude/);
  // After both checkout branches (cold clone and existing checkout), so a
  // re-warmed container gets it too.
  assert.ok(wr.indexOf('for USERNODE_EXCLUDE in') > wr.indexOf('checkout (existing)'));
});

test('the exclude block really keeps agent output out of `git add -A`, and runs twice cleanly', () => {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const wr = read('worker-run.sh');
  const block = wr.slice(wr.indexOf('for USERNODE_EXCLUDE in'), wr.indexOf('# Idempotent submodule sync'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'un-exclude-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q');
    fs.mkdirSync(path.join(dir, '.playwright-mcp'));
    fs.writeFileSync(path.join(dir, '.playwright-mcp', 'page.png'), 'x');
    fs.mkdirSync(path.join(dir, 'test-results'));
    fs.writeFileSync(path.join(dir, 'test-results', 'r.json'), '{}');
    fs.writeFileSync(path.join(dir, 'app.js'), '1');
    const script = path.join(dir, '.exclude.sh');
    fs.writeFileSync(script, `set -u\n${block}\n`);
    execFileSync('/bin/sh', [script], { cwd: dir });
    execFileSync('/bin/sh', [script], { cwd: dir });
    fs.unlinkSync(script);
    const lines = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8').split('\n');
    for (const entry of ['.playwright-mcp/', 'test-results/', 'playwright-report/']) {
      assert.equal(lines.filter((l) => l === entry).length, 1, `${entry} appears exactly once`);
    }
    git('add', '-A');
    assert.deepEqual(git('diff', '--cached', '--name-only').trim().split('\n'), ['app.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── run-cc.sh: purpose-bound MCP flags, strict config, scout/sync untouched ─

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
  // (possibly empty) browser flag var right after PERMISSION_FLAGS. The
  // independently optional system-prompt flags follow it.
  const matches = cc.match(/claude --print \$PERMISSION_FLAGS \$BROWSER_MCP_FLAGS \$SYSTEM_PROMPT_FLAGS --verbose/g) || [];
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

test('scout/sync stay browser-free while evidence gets only its purpose-bound MCP config', () => {
  const cc = read('run-cc.sh');
  // The shared read-only terminal branch reports the actual lightweight mode.
  assert.match(cc, /if \[ "\$MODE" = "scout" \] \|\| \[ "\$MODE" = "shots" \]; then[\s\S]*mode=\$MODE/);
  // The flag starts empty, build may receive the general config, and evidence
  // replaces it only after creating its isolated run-scoped configuration.
  assert.match(cc, /BROWSER_MCP_FLAGS=""\s*\nif \[ "\$MODE" = "build" \]/);
  assert.match(cc, /if \[ "\$MODE" = "shots" \]; then[\s\S]*BROWSER_MCP_CONFIG="\$SHOTS_TMP\/mcp\.json"[\s\S]*BROWSER_MCP_FLAGS="--mcp-config \$BROWSER_MCP_CONFIG --strict-mcp-config"/);
});

test('build commit + push + RESULT are emitted unconditionally, not under any browser guard', () => {
  const cc = read('run-cc.sh');
  // The commit/push/result block sits after the claude call and is not
  // nested inside any `if ... BROWSER ...` — so whether or not the agent
  // used (or failed to boot) the browser, the turn still commits and
  // reports. Assert the phases exist at column 0 (top-level), unguarded.
  assert.match(cc, /\necho "__USERNODE_PHASE__ commit"/);
  assert.match(cc, /\necho "__USERNODE_PHASE__ push"/);
  // The line may end with the branch_mismatch field (worker/session-branch.sh)
  // and the stop guard's stop_hook_blocks field (worker/build-stop-hook.js).
  assert.match(cc, /\necho "__USERNODE_RESULT__ cc_exit=\$CC_EXIT[^\n]*mode=build(\$BRANCH_MISMATCH_FIELD)?(\$STOP_HOOK_BLOCKS_FIELD)?"/);
});
