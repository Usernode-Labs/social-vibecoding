#!/usr/bin/env node
'use strict';

// Stand up the before/after pair a shots dry run needs, on the local stack
// (`make up`), the way a hosted run's reset does it:
//
//   npm run shots:pair -- up --before <sha> --after <sha> [--label NAME]
//   npm run shots:pair -- down [--label NAME]
//
// `up` builds each exact revision's platform image once (from a detached
// worktree), restores one dump of the local dev database into two evidence
// databases, runs both images on usernode-net with a credential-free env,
// applies the per-side fixtures (full-admin identity, member agent-session
// copy, no app cap), mints the three persona tokens, signs each persona in on
// both origins and saves its storage state. Before is served at
// http://127.0.0.1:4101 and after at http://localhost:4102: different hosts,
// so their session cookies never overwrite each other. It then prints the
// `npm run shots:dry-run` command for the pair. Only one pair runs at a time.
//
// Everything lives under .shots-dry-run/ (ignored). The env holds fresh random
// secrets and its own iframe key pair; it never reads the checkout's .env.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SLUG = 'usernode-2d5619';
const DB_CONTAINER = 'vibecoding-db-dev';
const NETWORK = 'usernode-net';
const DUMP = '/tmp/shots-dry-run.dump';
const PORTS = Object.freeze({ base: 4101, head: 4102 });
const ORIGINS = Object.freeze({ base: 'http://127.0.0.1:4101', head: 'http://localhost:4102' });
const PLAYWRIGHT_MCP = '@playwright/mcp@0.0.41';

function usage() {
  return `Usage: npm run shots:pair -- up --before SHA --after SHA [options]
       npm run shots:pair -- down [--label NAME]

  --before SHA           exact before (base) commit, 40 characters
  --after SHA            exact after (head) commit, 40 characters
  --label NAME           name of the pair (default: the after commit's first 12)
  --lab DIR              working directory (default .shots-dry-run)
  --executable-path P    browser for signing the personas in, when Playwright's
                         own Chromium is not installed (for example Chrome)
  --no-build             use images already built for these commits
`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { help: true };
  if (!['up', 'down'].includes(command)) throw new Error(`Unknown command ${command}.\n\n${usage()}`);
  const values = {};
  const flags = new Set(['--before', '--after', '--label', '--lab', '--executable-path']);
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (key === '--no-build') { values[key] = true; continue; }
    if (!flags.has(key) || rest[i + 1] == null || values[key] != null) {
      throw new Error(`Invalid or repeated argument ${key}.\n\n${usage()}`);
    }
    values[key] = rest[++i];
  }
  for (const key of ['--before', '--after']) {
    if (values[key] != null && !/^[0-9a-f]{40}$/.test(values[key])) {
      throw new Error(`${key} must be a full 40-character commit SHA.`);
    }
  }
  if (command === 'up' && (!values['--before'] || !values['--after'])) {
    throw new Error(`up needs --before and --after.\n\n${usage()}`);
  }
  if (values['--before'] && values['--before'] === values['--after']) {
    throw new Error('Before and after must be different commits.');
  }
  const label = values['--label'] || (values['--after'] ? values['--after'].slice(0, 12) : null);
  if (label != null && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(label)) {
    throw new Error('--label must be lowercase letters, digits and dashes.');
  }
  return {
    command,
    before: values['--before'] || null,
    after: values['--after'] || null,
    label,
    lab: path.resolve(values['--lab'] || path.join(ROOT, '.shots-dry-run')),
    executablePath: values['--executable-path'] || null,
    build: !values['--no-build'],
  };
}

const sh = (bin, args, opts = {}) => execFileSync(bin, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts,
}).trim();
const docker = (...args) => sh('docker', args);
const log = (...args) => process.stdout.write(`${args.join(' ')}\n`);

// The pair's own evidence databases, named as a hosted run names them.
function pairNames(label) {
  const runId = crypto.createHash('sha256').update(`shots-dry-run:${label}`).digest('hex').slice(0, 32);
  const dbManager = require('../src/services/db-manager');
  return {
    runId,
    containers: { base: `shots-${label}-before`, head: `shots-${label}-after` },
    dbs: { base: dbManager.evidenceDbName(SLUG, runId, 'base'), head: dbManager.evidenceDbName(SLUG, runId, 'head') },
  };
}

function imageTag(sha) { return `usernode-shots-dry-run:${sha.slice(0, 12)}`; }

// A credential-free env for the builds, written once per lab directory.
function labEnv(lab) {
  const file = path.join(lab, 'lab.env');
  if (!fs.existsSync(file)) {
    const { bech32m } = require('bech32');
    const secret = () => crypto.randomBytes(32).toString('hex');
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = (key, type) => key.export({ format: 'pem', type }).replace(/\n/g, '\\n');
    const dataKey = secret();
    const env = {
      ADMIN_USERNAME: 'localadmin', ADMIN_PASSWORD: secret(), SESSION_SECRET: secret(),
      USERNODE_DOMAIN: 'localhost', CLI_CANONICAL_ORIGIN: 'http://localhost:3000',
      USERNODE_DB_PASSWORD: 'localdev', DATA_ENCRYPTION_KEY: dataKey, JWT_SECRET: dataKey,
      IFRAME_JWT_PRIVATE_KEY: pem(keys.privateKey, 'pkcs8'), IFRAME_JWT_PUBLIC_KEY: pem(keys.publicKey, 'spki'),
      WORKER_JWT_SECRET: secret(), EDGE_JWT_SECRET: secret(),
      NODE_RPC_URL: 'http://127.0.0.1:9', EXPLORER_UPSTREAM: '127.0.0.1:9',
      TOPOCHAIN_PARTNER_API_KEY: secret(),
      NATIVE_SESSION_V2_TESTNET_CHAIN_ID: bech32m.encode('utc', bech32m.toWords(crypto.randomBytes(32)), 1023),
      USERNODE_LOCAL_DEV: '1', VISUAL_EVIDENCE_V2_ENABLED: 'true', APP_HEAL_INTERVAL_MS: '0',
    };
    fs.writeFileSync(file, `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
      { mode: 0o600, flag: 'wx' });
  }
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  return { file, env };
}

function assertLocalStack() {
  try { docker('network', 'inspect', NETWORK); }
  catch { throw new Error(`Docker network ${NETWORK} is missing. Start the local stack with make up.`); }
  try { docker('exec', DB_CONTAINER, 'pg_isready', '-U', 'usernode'); }
  catch { throw new Error(`${DB_CONTAINER} is not running. Start the local stack with make up.`); }
}

function buildImage(lab, sha) {
  const tag = imageTag(sha);
  try { docker('image', 'inspect', tag); return tag; } catch { /* build it */ }
  const checkout = path.join(lab, 'rev', sha.slice(0, 12));
  if (!fs.existsSync(checkout)) {
    try { sh('git', ['-C', ROOT, 'cat-file', '-e', `${sha}^{commit}`]); }
    catch { sh('git', ['-C', ROOT, 'fetch', '--depth=1', 'origin', sha], { timeout: 120_000 }); }
    fs.mkdirSync(path.dirname(checkout), { recursive: true });
    sh('git', ['-C', ROOT, 'worktree', 'add', '--detach', checkout, sha], { timeout: 120_000 });
  }
  log(`building ${tag}`);
  const built = spawnSync('docker', ['build', '-q', '--build-arg', `GIT_SHA=${sha}`, '-t', tag, checkout],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1_200_000 });
  if (built.status !== 0) throw new Error(`docker build of ${sha} failed:\n${String(built.stderr).slice(-2000)}`);
  return tag;
}

async function health(origin) {
  for (let i = 0; i < 240; i += 1) {
    try {
      if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) })).ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${origin} never became healthy`);
}

function down(lab, label) {
  const n = pairNames(label);
  for (const name of Object.values(n.containers)) {
    try { docker('rm', '-f', name); } catch { /* absent */ }
  }
  for (const db of Object.values(n.dbs)) {
    try { docker('exec', DB_CONTAINER, 'dropdb', '-U', 'usernode', '--if-exists', db); } catch { /* absent */ }
  }
  fs.rmSync(path.join(lab, 'pairs', label, 'pair.json'), { force: true });
}

// Every pair this script stood up, so `up` can free the two ports.
function knownPairs(lab) {
  const dir = path.join(lab, 'pairs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => fs.existsSync(path.join(dir, name, 'pair.json')));
}

function playwright(lab) {
  const dir = path.join(lab, 'pw');
  const entry = path.join(dir, 'node_modules', 'playwright');
  if (!fs.existsSync(entry)) {
    log(`installing ${PLAYWRIGHT_MCP} into ${dir} (the dry run's browser server and its Playwright)`);
    fs.mkdirSync(dir, { recursive: true });
    sh('npm', ['install', '--prefix', dir, '--no-audit', '--no-fund', PLAYWRIGHT_MCP], { timeout: 300_000 });
  }
  return require(entry);
}

async function up(options) {
  const { lab, label, before, after } = options;
  assertLocalStack();
  fs.mkdirSync(lab, { recursive: true });
  const { file: envFile, env } = labEnv(lab);
  const images = options.build
    ? { base: buildImage(lab, before), head: buildImage(lab, after) }
    : { base: imageTag(before), head: imageTag(after) };
  for (const other of knownPairs(lab)) down(lab, other);
  down(lab, label);
  const n = pairNames(label);

  try { docker('exec', DB_CONTAINER, 'test', '-s', DUMP); }
  catch { log('dumping the local dev database'); docker('exec', DB_CONTAINER, 'pg_dump', '-U', 'usernode', '-d', 'usernode', '-Fc', '-f', DUMP); }
  const appId = Number(docker('exec', DB_CONTAINER, 'psql', '-U', 'usernode', '-d', 'usernode', '-Atc',
    `SELECT id FROM apps WHERE slug = '${SLUG}'`));
  if (!Number.isInteger(appId) || appId <= 0) throw new Error(`The local database has no ${SLUG} app.`);
  for (const side of ['base', 'head']) {
    docker('exec', DB_CONTAINER, 'createdb', '-U', 'usernode', n.dbs[side]);
    docker('exec', DB_CONTAINER, 'pg_restore', '-U', 'usernode', '-d', n.dbs[side], '--no-owner', '--no-privileges', DUMP);
  }
  for (const side of ['base', 'head']) {
    const name = n.containers[side];
    docker('run', '-d', '--rm', '--name', name, '--network', NETWORK, '-p', `127.0.0.1:${PORTS[side]}:3000`,
      '--env-file', envFile,
      '-e', `DATABASE_URL=postgres://usernode:localdev@${DB_CONTAINER}:5432/${n.dbs[side]}`,
      '-e', 'NODE_ENV=development', '-e', 'USERNODE_ENV=staging',
      '-e', `DOCKER_NETWORK=${NETWORK}`, '-e', `PLATFORM_INTERNAL_URL=http://${name}:3000`,
      '-e', 'MINIO_ENDPOINT=http://vibecoding-minio-dev:9000',
      '-e', 'MINIO_ROOT_USER=localdev', '-e', 'MINIO_ROOT_PASSWORD=localdev-minio-secret',
      '-e', `USERNODE_APP_ID=${appId}`, '-e', 'MAX_APPS=0', images[side]);
  }
  await Promise.all(['base', 'head'].map((side) => health(ORIGINS[side])));
  log('both builds are healthy');

  // The same per-side fixtures a hosted reset applies to a self-app pair;
  // availableFixtures keeps the base side's descriptors, as it does there.
  const fixtures = require('../src/services/visual-evidence-fixtures');
  const input = (side) => ({ databaseUrl: `postgres://usernode:localdev@127.0.0.1:5440/${n.dbs[side]}`,
    slug: SLUG, runId: n.runId, side });
  const availableFixtures = [];
  const admins = [];
  for (const side of ['base', 'head']) admins.push(await fixtures.ensureFullAdminIdentity(input(side)));
  availableFixtures.push(admins[0]);
  const ready = await Promise.all(['base', 'head'].map((side) => fixtures.canCopyMemberAgentSession(input(side))));
  if (ready.every(Boolean)) {
    const seeded = [];
    for (const side of ['base', 'head']) seeded.push(await fixtures.copyMemberAgentSession({ ...input(side), selfAppSlug: SLUG }));
    availableFixtures.push(seeded[0]);
  }

  // Persona tokens minted with the pair's own iframe key, exchanged for a
  // session on both origins exactly as the worker's bootstrap does.
  process.env.IFRAME_JWT_PRIVATE_KEY = env.IFRAME_JWT_PRIVATE_KEY.replace(/\\n/g, '\n');
  process.env.IFRAME_JWT_PUBLIC_KEY = env.IFRAME_JWT_PUBLIC_KEY.replace(/\\n/g, '\n');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: input('base').databaseUrl });
  let tokens;
  try { tokens = await require('../src/services/visual-evidence-identities').mintEvidenceAuthTokens(pool, appId); }
  finally { await pool.end(); }
  const { chromium } = playwright(lab);
  const { bootstrapInternalSession } = require('../worker/session-bootstrap');
  const pairDir = path.join(lab, 'pairs', label);
  const stateDir = path.join(pairDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({ headless: true, ...(options.executablePath ? { executablePath: options.executablePath } : {}) });
  try {
    for (const [persona, token] of Object.entries(tokens)) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      try {
        for (const side of ['base', 'head']) {
          const url = new URL('/', ORIGINS[side]);
          url.searchParams.set('token', token);
          await bootstrapInternalSession(context, ORIGINS[side], url.href, token);
          const page = await context.newPage();
          await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await page.close();
          if (!(await context.cookies(ORIGINS[side])).some((cookie) => cookie.name === 'session')) {
            throw new Error(`${persona} has no session on ${ORIGINS[side]}`);
          }
        }
        await context.storageState({ path: path.join(stateDir, `${persona}.json`) });
        fs.chmodSync(path.join(stateDir, `${persona}.json`), 0o600);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(pairDir, 'fixtures.json'), `${JSON.stringify(availableFixtures, null, 2)}\n`);
  fs.writeFileSync(path.join(pairDir, 'pair.json'), `${JSON.stringify({
    label, before, after, images, origins: ORIGINS, databases: n.dbs,
  }, null, 2)}\n`);
  log(`ready: before ${ORIGINS.base}, after ${ORIGINS.head}; personas signed in on both.`);
  log(`\nnpm run shots:dry-run -- --intent <intent.json> \\
  --before ${ORIGINS.base} --after ${ORIGINS.head} \\
  --state-dir ${path.relative(ROOT, stateDir)} --fixtures ${path.relative(ROOT, path.join(pairDir, 'fixtures.json'))} \\
  --base-sha ${before} --head-sha ${after} \\
  --head-checkout ${path.relative(ROOT, path.join(lab, 'rev', after.slice(0, 12)))} \\
  --playwright-mcp ${path.relative(ROOT, path.join(lab, 'pw', 'node_modules', '.bin', 'mcp-server-playwright'))}${options.executablePath ? ` \\\n  --executable-path "${options.executablePath}"` : ''}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(usage()); return; }
  if (options.command === 'down') {
    for (const label of options.label ? [options.label] : knownPairs(options.lab)) {
      down(options.lab, label);
      log(`stopped ${label}`);
    }
    return;
  }
  await up(options);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, pairNames, ORIGINS };
