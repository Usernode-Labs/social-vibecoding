#!/usr/bin/env node
'use strict';

// First local evidence milestone: run the production browser/encoder against
// two synthetic app variants, with no platform DB, GitHub, or model service.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const contract = require('../../src/services/visual-evidence-plan');

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, '../..');
const FIXTURE_FILE = path.join(__dirname, 'fixture-app.js');
const DEFAULT_PLAN = path.join(__dirname, 'plan.json');

function parseArgs(argv) {
  const options = { planFile: DEFAULT_PLAN, outputRoot: path.join(ROOT, '.local-visual-evidence') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--plan' && argv[i + 1]) options.planFile = path.resolve(argv[++i]);
    else if (argv[i] === '--output-dir' && argv[i + 1]) options.outputRoot = path.resolve(argv[++i]);
    else if (argv[i] === '--help') options.help = true;
    else throw new Error(`Unknown or incomplete option: ${argv[i]}`);
  }
  return options;
}

async function docker(args, timeout = 30_000) {
  const { stdout } = await execFileAsync('docker', args, { timeout, maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim();
}

async function fixtureImageDigest() {
  const image = 'node:22-bookworm-slim';
  try { return await docker(['image', 'inspect', '--format', '{{.Id}}', image]); }
  catch {
    await docker(['pull', image], 180_000);
    return docker(['image', 'inspect', '--format', '{{.Id}}', image]);
  }
}

async function startFixture(name, network, side) {
  await docker([
    'run', '-d', '--rm', '--name', name, '--network', network,
    '--read-only', '--tmpfs', '/tmp',
    '--mount', `type=bind,source=${FIXTURE_FILE},target=/app/fixture-app.js,readonly`,
    '--env', `EVIDENCE_VARIANT=${side}`,
    'node:22-bookworm-slim', 'node', '/app/fixture-app.js',
  ]);
  let lastError = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await docker(['exec', name, 'node', '-e',
        "fetch('http://127.0.0.1:3000/health').then(r => { if (!r.ok) process.exit(1) })"], 5_000);
      return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${side} fixture did not become ready: ${lastError?.message || 'timeout'}`);
}

async function stopFixtures(names) {
  await Promise.all(names.map((name) => docker(['rm', '-f', name], 15_000).catch(() => {})));
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function syntheticRevision(source, side) {
  return crypto.createHash('sha1').update(`local evidence fixture\0${side}\0${source}`).digest('hex');
}

async function run(options) {
  const plan = contract.parseReplayPlan(JSON.parse(await fs.readFile(options.planFile, 'utf8')));
  const source = await fs.readFile(FIXTURE_FILE, 'utf8');
  const runId = crypto.randomBytes(16).toString('hex');
  const network = `usernode-evidence-lab-${runId.slice(0, 8)}`;
  const names = { base: `${network}-base`, head: `${network}-head` };
  const containerNames = Object.values(names);
  const outputDir = path.join(options.outputRoot, runId);
  const imageDigest = await fixtureImageDigest();
  const provenance = {
    baseSha: syntheticRevision(source, 'base'),
    headSha: syntheticRevision(source, 'head'),
    fixtureFingerprint: sha256(source + contract.canonicalJson(plan)),
    baseImageDigest: imageDigest,
    headImageDigest: imageDigest,
  };
  const origins = {
    base: `http://${names.base}:3000`,
    head: `http://${names.head}:3000`,
  };
  const inputFor = (pass) => ({
    runId, pass, publishArtifacts: pass === 2, plan, origins, provenance,
    authTokens: { member: 'local-member-fixture', read_only_admin: 'local-admin-fixture' },
    cookies: {},
    browser: { locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', deviceScaleFactor: 1 },
  });

  await docker(['network', 'create', '--driver', 'bridge', network]);
  try {
    // docker.js captures its shared network at require time. Select the
    // isolated lab network before loading the production replay launcher.
    process.env.DOCKER_NETWORK = network;
    const replay = require('../../src/services/visual-evidence-replay');
    const config = { captureRuntime: 'docker', visualEvidence: { maxRunMs: 240_000 } };
    const sessionId = Number.parseInt(runId.slice(0, 8), 16) + 1;
    const startPair = async () => {
      const results = await Promise.allSettled([
        startFixture(names.base, network, 'base'),
        startFixture(names.head, network, 'head'),
      ]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    };
    const onEvent = (event) => {
      if (event.type === 'viewport_started' || event.type === 'viewport_finished') {
        process.stdout.write(`pass ${event.pass}: ${event.type} ${event.storyId}/${event.viewport}\n`);
      }
    };

    await startPair();
    const first = await replay.runPass(config, sessionId, inputFor(1), { onEvent });
    await stopFixtures(containerNames);
    await startPair();
    const second = await replay.runPass(config, sessionId, inputFor(2), { onEvent });
    const verdict = replay.comparePasses(first, second, { plan, provenance, runId });
    if (!verdict.passed) throw new Error(`${verdict.code}: ${verdict.reason}`);

    await fs.mkdir(outputDir, { recursive: true });
    const artifacts = [];
    for (const artifact of second.artifacts) {
      const filename = `${artifact.storyId}-${artifact.viewport}-${artifact.side}-${artifact.variant}.${artifact.media}`;
      await fs.writeFile(path.join(outputDir, filename), artifact.data);
      artifacts.push({
        filename, storyId: artifact.storyId, viewport: artifact.viewport,
        side: artifact.side, variant: artifact.variant, media: artifact.media,
        contentType: artifact.contentType, bytes: artifact.bytes, sha256: artifact.sha256,
      });
    }
    await fs.writeFile(path.join(outputDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    const manifest = {
      version: 1, kind: 'synthetic_local_fixture', runId,
      passed: true, planHash: contract.planHash(plan), provenance,
      replayPasses: [first.result, second.result], verdict, artifacts,
    };
    await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`Captured ${artifacts.length} artifacts after two matching passes.\n${outputDir}\n`);
    return { outputDir, artifacts };
  } finally {
    await stopFixtures(containerNames);
    await docker(['network', 'rm', network], 15_000).catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: npm run test:visual-evidence:local -- [--plan FILE] [--output-dir DIR]\n');
    return;
  }
  await run(options);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, syntheticRevision, run };
