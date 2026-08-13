'use strict';

// Optional in-loop browser for build-mode coding-agent turns.
//
// The worker image ships Playwright + a pinned Chromium and the Playwright
// MCP server (see worker/Dockerfile), wired into `claude` for MODE=build
// only (see worker/run-cc.sh + worker/worker-run.sh). This module is the
// JS-side source of truth for two things the host owns:
//
//   1. IN_LOOP_BROWSER_GUIDANCE — the prompt block injected into the build
//      turn's INSTRUCTIONS (src/routes/sessions.js). It offers the browser
//      as a tool the agent MAY use at its discretion for user-visible
//      changes — NOT a mandatory gate on every turn.
//   2. browserEnvForMode(mode) — the INLOOP_* env the agent uses to boot
//      the edited app locally (port, USERNODE_ENV, throwaway DB pointer).
//      Build-only; scout (read-only) and sync (bookkeeping) get nothing.
//
// The browser/app traffic is entirely local to the worker container and is
// never routed through ANTHROPIC_BASE_URL (which only retargets the
// Anthropic SDK). Chromium launches lazily — only when the agent actually
// calls a browser tool — so turns that never reach for it pay no cost.
//
// WebGL: the MCP server is seeded (worker/worker-run.sh) with a Playwright
// config that enables software WebGL via SwiftShader, so Three.js /
// <canvas> WebGL apps render (CPU-rendered) instead of failing to create a
// context — matching the capture image's launch flags.

// Suggested loopback port for the in-loop app launch. Deliberately NOT 3000
// (the platform-convention app port) so a stray prod-style process can't
// collide with the throwaway one the agent spins up for the check.
const INLOOP_PORT = 3100;

// Local DB for the in-loop launch. This URL resolves for real (#659): the
// worker image ships a container-local Postgres 15 with trust auth on
// loopback (worker/Dockerfile), and run-cc.sh starts it and recreates the
// `inloop` database FRESH at the start of every build turn. The app boots
// with USERNODE_ENV=staging, so it follows the same fresh-empty-DB +
// manifest staging_default secret contract a real staging container does.
// If the app still won't boot (a missing required secret, a crash on
// start), the guidance tells the agent to skip the check and commit
// anyway (graceful degradation).
const INLOOP_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/inloop';

// True only for build turns. Scout must stay read-only/browser-free; sync
// is bookkeeping and never invokes the browser tooling.
function browserToolingEnabledForMode(mode) {
  return mode === 'build';
}

// INLOOP_* env injected into the build turn's `docker exec` (and inherited
// by any `node server.js` the agent spawns). Empty object for non-build
// modes so scout/sync exec envs are untouched.
function browserEnvForMode(mode) {
  if (!browserToolingEnabledForMode(mode)) return {};
  return {
    INLOOP_BROWSER: '1',
    INLOOP_PORT: String(INLOOP_PORT),
    INLOOP_ENV: 'staging',
    INLOOP_DATABASE_URL,
  };
}

// Injected into the build prompt's INSTRUCTIONS. Optional + encouraged, with
// the hooks that make the agent likely to actually reach for it: reuse the
// TESTING-block `path:` routes it already reasons about, the "blank page may
// mean missing seed data, not a bug" reminder, and a tight verify-fix budget
// so it can't loop. Phrased so it's clearly NOT a forced gate.
const IN_LOOP_BROWSER_GUIDANCE = `- OPTIONAL in-loop browser (encouraged, NOT required): a headless browser is
  available to you on build turns via the Playwright MCP tools
  (\`browser_navigate\`, \`browser_console_messages\`, \`browser_take_screenshot\`,
  …). When a change is USER-VISIBLE and you judge a visual check is worth it
  (a new screen, a layout change, anything where "does it actually render?"
  matters), you MAY use it to catch problems source-reading can't — a blank
  page, a JS crash on load, a broken layout, a failing API call — and fix them
  before you commit. Skip it entirely for backend-only / refactor / docs
  changes where rendering tells you nothing; this is a tool in reach, not a
  gate you must pass every turn.
  - To use it: boot the app you just edited locally, e.g.
    \`USERNODE_ENV=$INLOOP_ENV PORT=$INLOOP_PORT DATABASE_URL=$INLOOP_DATABASE_URL node server.js &\`
    (or the entrypoint this app's \`dapp.json\` declares), then point the
    browser at \`http://127.0.0.1:$INLOOP_PORT\` joined with the SAME route(s)
    you put in the TESTING block's \`path:\` lines. The app boots in staging
    mode against a FRESH, EMPTY local database — a real Postgres runs in
    this container and the \`inloop\` DB is recreated for each build turn —
    so seed any data your route needs in this same commit per the "Staging
    mock data" convention.
  - A BLANK or empty-looking page usually means MISSING SEED DATA, not a bug —
    the local DB starts empty. Add the \`IS_STAGING\` seed (or a
    \`?demo=1\` route) and re-check, rather than "fixing" working code.
  - SELF-APP (social-vibecoding) only: it is a hash-routed SPA, so put the
    route after the \`#\` (e.g. \`http://127.0.0.1:$INLOOP_PORT/#/leaderboard\`)
    or the page just boots to the home feed.
  - EXPECTED (not optional) when your TESTING block points \`path:\` at a
    screenshot-state deep link you added this turn (a query/hash param that
    boots the app straight into the changed state — see "Make the changed
    screen URL-reachable" in the conventions): navigate the exact \`path:\`
    URL(s) and confirm with \`browser_take_screenshot\` that the changed UI
    is actually visible before you commit. For a \`@mobile\`-annotated path,
    call \`browser_resize\` to a phone-sized frame (390x844) first. A state
    link that renders the home screen means the reviewer-facing
    before/after screenshots will show the home screen too.
  - Keep it tight: budget at most a couple of launch→check→fix cycles and a
    minute or two of wall-clock. If the app won't boot (a missing required
    secret, a crash on start), DON'T fight it — note that you skipped the
    visual check and commit your work anyway. The in-loop browser must never
    block or fail the turn.
  - PROPOSAL CHECKS ("CI for proposals"): the platform runs automated
    headless-browser tests against your staging build, and a proposal whose
    checks aren't passing is BLOCKED from merging. Tests are declared in
    \`dapp.json\`'s \`tests\` array (each navigates a route and asserts it
    loads with no console errors, plus optional selector/text); every
    proposal also gets the baseline "loads with no console errors" check for
    free. When you add/change a user-visible screen, add or extend a test for
    it in the same commit, reusing the route(s) you put in the TESTING block's
    \`path:\` lines, and seed any data that route needs (an empty staging DB
    makes a route fail).
  - RUN THE DECLARED CHECKS IN-LOOP with \`usernode-run-checks\` (via Bash):
    with the app booted on \`$INLOOP_PORT\` as above, run
    \`usernode-run-checks --changed\` to execute exactly the checks you added
    or changed this branch, with the SAME semantics the platform's capture
    container uses (console errors, wait-based selector/text assertions).
    \`--filter <substr>\` narrows by name/path; no flags runs the whole
    declared suite (fine for small suites, slow for hundreds of checks).
    This is EXPECTED whenever you touched \`dapp.json\` tests or changed a
    screen an existing check covers: \`npm test\` does NOT cover these, and a
    check that fails on staging after your turn ends blocks the merge with
    no way for you to react. A check that fails in-loop only because the
    local DB lacks data that REAL staging seeds is worth double-checking
    against the seed conventions before "fixing".`;

module.exports = {
  INLOOP_PORT,
  INLOOP_DATABASE_URL,
  browserToolingEnabledForMode,
  browserEnvForMode,
  IN_LOOP_BROWSER_GUIDANCE,
};
