#!/usr/bin/env node
'use strict';

// Exchange short-lived app identity JWTs for ordinary browser storage state
// before the model process starts. The runner unsets the raw tokens
// immediately afterward; MCP receives only the cookie/local-storage state in
// a private file and the model has no filesystem or shell tool in shots
// mode. The guest browser is never signed in: its state is empty, so it
// sees what a visitor who is not signed in sees.

const fs = require('node:fs/promises');
const path = require('node:path');
const { SessionBootstrapError, bootstrapInternalSession } = require('./session-bootstrap');
const { loadTrustedHostedAppOrigins } = require('./shots-hosted-origins');

const reportedPersona = (persona) => (
  persona === 'member' ? 'member' : persona === 'full_admin' ? 'full_admin'
    : persona === 'guest' ? 'guest'
      : persona === 'invited_member' ? 'invited_member'
        : persona === 'waitlisted_member' ? 'waitlisted_member' : 'admin'
);
// What the guest browser starts from: no cookie and no storage on any origin.
const SIGNED_OUT_STATE = '{"cookies":[],"origins":[]}\n';

function reportAuth(persona, side, bootstrap, sessionCookiePresent) {
  // Only fixed booleans and status cross the worker boundary. The token,
  // session cookie, URLs, and response body stay inside this process.
  process.stdout.write(`__USERNODE_SHOTS_BROWSER__ ${JSON.stringify({
    kind: 'auth_bootstrap',
    persona: reportedPersona(persona),
    side,
    attempted: bootstrap.attempted === true,
    cookieAlreadyPresent: bootstrap.cookieAlreadyPresent === true,
    sessionCookieInstalled: bootstrap.sessionCookieInstalled === true,
    sessionCookiePresent,
    ...(Number.isInteger(bootstrap.responseStatus) ? { responseStatus: bootstrap.responseStatus } : {}),
  })}\n`);
}

// Where the bootstrap was when it failed. A failure used to reach the run as
// one generic line, "shots browser authentication failed", which three
// production runs on 2026-09-30 carried and nothing more: the success event
// above is only written after a sign-in works. The failure is now reported
// the same way, from fixed values only.
const FAILURE_STAGES = Object.freeze({
  configure: 'reading its configuration',
  launch: 'starting the browser',
  exchange: 'exchanging the sign-in token',
  navigate: 'opening the app',
  cookie: 'keeping the session cookie',
  hosted_catalog: 'listing hosted apps',
  storage_state: 'saving the browser state',
  allowlist: 'writing the hosted-app allowlist',
});

// Classified from the error, never copied from it: a Playwright message can
// carry the token-bearing navigation URL.
function errorClass(error) {
  const text = `${error?.name || ''} ${error?.message || ''}`;
  if (/TimeoutError|Timeout \d+ms exceeded/.test(text)) return 'timeout';
  if (/net::ERR_|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/.test(text)) return 'network';
  if (/(Target page, context or browser has been closed|browser has been closed|Browser closed)/i.test(text)) {
    return 'browser_closed';
  }
  return 'other';
}

function failureEvent(error, progress = {}) {
  const bootstrap = progress.bootstrap || {};
  const code = error instanceof SessionBootstrapError && /^[a-z_]{1,40}$/.test(String(error.code || ''))
    ? error.code : null;
  return {
    kind: 'auth_bootstrap',
    outcome: 'error',
    ...(progress.persona ? { persona: reportedPersona(progress.persona) } : {}),
    ...(progress.side === 'base' || progress.side === 'head' ? { side: progress.side } : {}),
    failureStage: Object.prototype.hasOwnProperty.call(FAILURE_STAGES, progress.stage)
      ? progress.stage : 'configure',
    ...(code ? { failureCode: code } : {}),
    errorClass: errorClass(error),
    ...(typeof bootstrap.attempted === 'boolean' ? { attempted: bootstrap.attempted } : {}),
    ...(Number.isInteger(bootstrap.responseStatus) ? { responseStatus: bootstrap.responseStatus } : {}),
  };
}

// One line for the run's failure reason, from the event's fixed values.
function failureSummary(event) {
  const who = [event.persona, event.side].filter(Boolean).join(' on ');
  const detail = [
    event.failureCode || event.errorClass,
    Number.isInteger(event.responseStatus) ? `HTTP ${event.responseStatus}` : null,
  ].filter(Boolean).join(', ');
  return `shots browser authentication failed${who ? ` (${who})` : ''}`
    + ` while ${FAILURE_STAGES[event.failureStage]}: ${detail}`;
}

async function main(progress) {
  const { chromium } = require('/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright');
  const origins = JSON.parse(process.env.SHOTS_ALLOWED_ORIGINS || '[]').map((value) => new URL(value).origin);
  const outputDir = String(process.env.SHOTS_BROWSER_STATE_DIR || '');
  const proxy = String(process.env.SHOTS_PROXY_SERVER || '');
  // The personas that sign in. The guest has no token to exchange (its
  // optional guest token is the proxy's alone), so none is required for it.
  // The invited members sign in only when the pair's fixtures wrote their
  // identities; otherwise their browsers stay signed out, like the guest.
  const personas = {
    member: String(process.env.SHOTS_MEMBER_TOKEN || ''),
    read_only_admin: String(process.env.SHOTS_ADMIN_TOKEN || ''),
    full_admin: String(process.env.SHOTS_FULL_ADMIN_TOKEN || ''),
  };
  const optionalPersonas = {
    invited_member: String(process.env.SHOTS_INVITED_TOKEN || ''),
    waitlisted_member: String(process.env.SHOTS_WAITLISTED_TOKEN || ''),
  };
  if (origins.length !== 2 || !outputDir || !proxy || Object.values(personas).some((value) => !value)) {
    throw new Error('Shots browser bootstrap configuration is incomplete.');
  }
  const hostedFile = path.resolve(outputDir, 'hosted-origins.json');
  if (!process.env.SHOTS_HOSTED_ORIGINS_FILE
      || path.resolve(process.env.SHOTS_HOSTED_ORIGINS_FILE) !== hostedFile) {
    throw new Error('Shots hosted-app catalog path does not match the private browser state directory.');
  }
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const memberCatalogs = [];
  progress.stage = 'launch';
  const browser = await chromium.launch({
    channel: 'chromium', headless: true, proxy: { server: proxy },
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    for (const [persona, token] of Object.entries({ ...personas, ...optionalPersonas })) {
      progress.persona = persona;
      progress.side = null;
      progress.bootstrap = null;
      if (!token) {
        // No token to exchange: the browser stays a visitor with no
        // session, as the guest does.
        progress.stage = 'storage_state';
        progress.side = null;
        progress.bootstrap = null;
        const signedOut = path.join(outputDir, `${persona}.json`);
        await fs.writeFile(signedOut, SIGNED_OUT_STATE, { mode: 0o600 });
        await fs.chmod(signedOut, 0o600);
        continue;
      }
      const context = await browser.newContext({ serviceWorkers: 'block' });
      try {
        for (const [index, origin] of origins.entries()) {
          const url = new URL('/', origin);
          url.searchParams.set('token', token);
          const bootstrap = {};
          progress.side = index === 0 ? 'base' : 'head';
          progress.bootstrap = bootstrap;
          progress.stage = 'exchange';
          // Use the same token-to-session exchange as deterministic replay.
          // Navigating alone loses a Secure session cookie on private HTTP.
          await bootstrapInternalSession(context, origin, url.href, token, bootstrap);
          progress.stage = 'navigate';
          const page = await context.newPage();
          await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          const final = new URL(page.url());
          if (final.origin !== origin) {
            throw new SessionBootstrapError('cross_origin_navigation', 'Shots authentication left its private origin.');
          }
          await page.close();
          progress.stage = 'cookie';
          const sessionCookiePresent = (await context.cookies(origin)).some((cookie) => cookie.name === 'session');
          reportAuth(persona, index === 0 ? 'base' : 'head', bootstrap, sessionCookiePresent);
          if (bootstrap.sessionCookieInstalled && !sessionCookiePresent) {
            throw new SessionBootstrapError('session_bootstrap_failed', 'The shots browser did not retain its private session cookie.');
          }
          if (persona === 'waitlisted_member') {
            // This persona has been Home once, so the project menu no longer
            // offers Go to Homeroom and Home's waitlist card reads "On the
            // waitlist". Marking the visit is the page's own device memory:
            // read the signed-in account from the page, then set the key it
            // sets (public/js/app.js _notePrivateHome), on this origin only.
            progress.stage = 'navigate';
            const page = await context.newPage();
            await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
            const final = new URL(page.url());
            if (final.origin !== origin) {
              throw new SessionBootstrapError('cross_origin_navigation', 'Shots authentication left its private origin.');
            }
            const userId = await page.evaluate(async () => {
              try {
                const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
                if (!response.ok) return null;
                const body = await response.json();
                const id = body?.user?.id;
                return Number.isInteger(id) || typeof id === 'number' ? String(id) : null;
              } catch { return null; }
            });
            if (userId != null) {
              await page.evaluate((id) => {
                try { localStorage.setItem(`usernode:private-home:${id}`, String(Date.now())); } catch (_) { /* private mode */ }
              }, userId);
            }
            await page.close();
          }
          if (persona === 'member') {
            progress.stage = 'hosted_catalog';
            const side = index === 0 ? 'base' : 'head';
            memberCatalogs.push(await loadTrustedHostedAppOrigins(context, origin, (result) => {
              process.stdout.write(`__USERNODE_SHOTS_BROWSER__ ${JSON.stringify({
                kind: 'hosted_app_catalog', side, ...result,
              })}\n`);
            }, process.env.SHOTS_RUN_ID));
          }
        }
        progress.stage = 'storage_state';
        progress.side = null;
        progress.bootstrap = null;
        const target = path.join(outputDir, `${persona}.json`);
        await context.storageState({ path: target });
        await fs.chmod(target, 0o600);
      } finally { await context.close(); }
    }
    progress.persona = 'guest';
    progress.stage = 'storage_state';
    const guestState = path.join(outputDir, 'guest.json');
    await fs.writeFile(guestState, SIGNED_OUT_STATE, { mode: 0o600 });
    await fs.chmod(guestState, 0o600);
    progress.stage = 'allowlist';
    progress.persona = null;
    const hostedApps = [...(memberCatalogs[0] || new Map())]
      .filter(([origin, slug]) => memberCatalogs[1]?.get(origin) === slug)
      .map(([origin, slug]) => ({ origin, slug }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    const stagedHostedFile = `${hostedFile}.${process.pid}.tmp`;
    await fs.writeFile(stagedHostedFile, `${JSON.stringify({
      version: 2, baseOrigin: origins[0], headOrigin: origins[1], apps: hostedApps,
    })}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(stagedHostedFile, hostedFile);
    process.stdout.write(`__USERNODE_SHOTS_BROWSER__ ${JSON.stringify({
      kind: 'hosted_app_allowlist', count: hostedApps.length,
    })}\n`);
  } finally { await browser.close(); }
}

async function run() {
  const progress = { stage: 'configure', persona: null, side: null, bootstrap: null };
  try {
    await main(progress);
  } catch (error) {
    // Playwright errors may include a token-bearing navigation URL. Only
    // fixed values cross the worker boundary: the event joins the run's
    // trace, and the summary becomes its failure reason (run-cc.sh reads it
    // from SHOTS_BOOTSTRAP_FAILURE_FILE).
    const event = failureEvent(error, progress);
    process.stdout.write(`__USERNODE_SHOTS_BROWSER__ ${JSON.stringify(event)}\n`);
    const summary = failureSummary(event);
    process.stderr.write(`${summary}\n`);
    if (process.env.SHOTS_BOOTSTRAP_FAILURE_FILE) {
      await fs.writeFile(process.env.SHOTS_BOOTSTRAP_FAILURE_FILE, summary, { mode: 0o600 }).catch(() => {});
    }
    process.exit(1);
  }
}

if (require.main === module) run();

module.exports = { FAILURE_STAGES, SIGNED_OUT_STATE, errorClass, failureEvent, failureSummary };
