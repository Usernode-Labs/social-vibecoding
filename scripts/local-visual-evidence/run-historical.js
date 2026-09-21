#!/usr/bin/env node
'use strict';

// Replay previously failed proposal evidence against the exact merged PR
// revisions. GitHub supplies source code only; all databases, auth tokens,
// app containers, browser capture, and output files stay local.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Pool } = require('pg');
const contract = require('../../src/services/visual-evidence-plan');
const lab = require('./run');
const { assertLocalConfig, assertLocalPlatform } = require('./run-platform');

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, '../..');
const DB_CONTAINER = 'vibecoding-db-dev';
const NETWORK = 'usernode-net';
const CASES = Object.freeze(require('./historical-cases.json').cases);

function assertPlanMatchesRecordedClaims(plan, recorded) {
  const claims = plan.stories.map((story) => ({
    id: story.id,
    claim: story.claim,
    persona: story.persona,
    viewports: story.viewports.map((viewport) => viewport.name),
    steps: story.intent.steps,
    baseState: story.intent.baseState,
    animation: story.intent.animation,
  }));
  if (JSON.stringify(claims) !== JSON.stringify(recorded.claims)) {
    throw new Error('The local plan differs from the claims and media types recorded on the live proposal.');
  }
}

async function command(binary, args, options = {}) {
  const { stdout } = await execFileAsync(binary, args, {
    cwd: ROOT,
    timeout: options.timeout || 30_000,
    maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
  });
  return stdout.trim();
}

const docker = (args, timeout) => command('docker', args, { timeout });
const git = (args, timeout) => command('git', args, { timeout });

async function checkoutRevision(pr, side, sha) {
  const target = path.join(ROOT, '.local-visual-evidence', 'real-revisions', String(pr), side);
  let created = false;
  try {
    await fs.access(target);
  } catch {
    try { await git(['cat-file', '-e', `${sha}^{commit}`]); }
    catch { await git(['fetch', '--depth=1', 'origin', sha], 120_000); }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await git(['worktree', 'add', '--detach', target, sha], 60_000);
    created = true;
  }
  const actual = await git(['-C', target, 'rev-parse', 'HEAD']);
  if (actual !== sha) throw new Error(`${side} checkout has ${actual}; expected ${sha}.`);
  const changes = await git(['-C', target, 'status', '--porcelain', '--untracked-files=no']);
  if (changes) throw new Error(`${side} checkout has tracked changes; historical image must use a clean revision.`);
  return { target, created };
}

async function buildImage(pr, side, sha, checkout) {
  const tag = `usernode-evidence-historical-${pr}-${side}:${sha.slice(0, 8)}`;
  await docker(['build', '-q', '-t', tag, checkout], 600_000);
  const digest = await docker(['image', 'inspect', '--format', '{{.Id}}', tag]);
  return { tag, digest };
}

async function ready(name) {
  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await docker(['exec', name, 'node', '-e',
        "fetch('http://127.0.0.1:3000/health').then(r => { if (!r.ok) process.exit(1) })"], 5_000);
      return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${name} did not become healthy: ${lastError?.message || 'timeout'}`);
}

async function restoreDatabase(name, dump) {
  await docker(['exec', DB_CONTAINER, 'dropdb', '-U', 'usernode', '--if-exists', name]);
  await docker(['exec', DB_CONTAINER, 'createdb', '-U', 'usernode', name]);
  await docker(['exec', DB_CONTAINER, 'pg_restore', '-U', 'usernode', '-d', name,
    '--no-owner', '--no-privileges', dump], 120_000);
}

async function startApp(name, dbName, image) {
  await docker([
    'run', '-d', '--rm', '--name', name, '--network', NETWORK,
    '--env-file', path.join(ROOT, '.env'),
    '-e', `DATABASE_URL=postgres://usernode:localdev@${DB_CONTAINER}:5432/${dbName}`,
    '-e', 'NODE_ENV=development', '-e', 'USERNODE_ENV=staging',
    '-e', `DOCKER_NETWORK=${NETWORK}`,
    '-e', `PLATFORM_INTERNAL_URL=http://${name}:3000`,
    '-e', 'MINIO_ENDPOINT=http://vibecoding-minio-dev:9000',
    '-e', 'MINIO_ROOT_USER=localdev', '-e', 'MINIO_ROOT_PASSWORD=localdev-minio-secret',
    '-e', 'USERNODE_DB_PASSWORD=localdev', '-e', 'USERNODE_APP_ID=1',
    image,
  ], 30_000);
  await ready(name);
}

async function writeResult(pr, runId, plan, provenance, first, second, verdict) {
  const outputDir = path.join(ROOT, '.local-visual-evidence', `historical-${pr}-${runId}`);
  await fs.mkdir(outputDir, { recursive: true });
  const artifacts = [];
  for (const artifact of second.artifacts) {
    const filename = `${artifact.storyId}-${artifact.viewport}-${artifact.side}-${artifact.variant}.${artifact.media}`;
    await fs.writeFile(path.join(outputDir, filename), artifact.data);
    artifacts.push({ filename, storyId: artifact.storyId, viewport: artifact.viewport,
      side: artifact.side, variant: artifact.variant, media: artifact.media,
      contentType: artifact.contentType, bytes: artifact.bytes, sha256: artifact.sha256 });
  }
  const reviewExports = await lab.exportReviewVideos(
    outputDir, artifacts.filter((artifact) => artifact.variant === 'animation')
  );
  const manifest = {
    version: 2,
    kind: 'historical_real_revisions_probe',
    pr,
    historicalFailure: CASES[pr].historicalFailure,
    runId,
    plan,
    provenance,
    replayPasses: [first.result, second.result],
    verdict,
    artifacts,
    reviewExports,
    limitations: [
      'The replay plan was written by this Codex task, not the historical evidence agent.',
      'This invokes the production capture/replay service locally, not the proposal HTTP or agent orchestration path.',
      'The fixture data is a local development database snapshot, not production user data.',
    ],
  };
  await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { outputDir, artifacts, reviewExports };
}

async function main(pr) {
  if (!Object.hasOwn(CASES, pr)) {
    throw new Error(`Choose one historical PR: ${Object.keys(CASES).join(', ')}.`);
  }
  await assertLocalConfig();
  await assertLocalPlatform();
  await docker(['network', 'inspect', NETWORK]);
  const runId = crypto.randomBytes(16).toString('hex');
  const spec = CASES[pr];
  const planPath = path.join(__dirname, `historical-${pr}-plan.json`);
  const plan = contract.parseReplayPlan(JSON.parse(await fs.readFile(planPath, 'utf8')));
  assertPlanMatchesRecordedClaims(plan, spec);
  const checkouts = {};
  const names = { base: `usernode-historical-${runId.slice(0, 8)}-base`,
    head: `usernode-historical-${runId.slice(0, 8)}-head` };
  const databases = { base: `evidence_hist_${runId.slice(0, 12)}_base`,
    head: `evidence_hist_${runId.slice(0, 12)}_head` };
  const dump = `/tmp/evidence-hist-${runId}.dump`;
  const stop = async () => lab.stopFixtures(Object.values(names));
  let pool;
  try {
    for (const side of ['base', 'head']) {
      checkouts[side] = await checkoutRevision(pr, side, spec[`${side}Sha`]);
    }
    const images = {};
    for (const side of ['base', 'head']) {
      images[side] = await buildImage(pr, side, spec[`${side}Sha`], checkouts[side].target);
    }
    await docker(['exec', DB_CONTAINER, 'pg_dump', '-U', 'usernode', '-d', 'usernode',
      '-Fc', '-f', dump], 120_000);
    const fingerprint = (await docker(['exec', DB_CONTAINER, 'sha256sum', dump])).split(' ')[0];
    const provenance = {
      baseSha: spec.baseSha, headSha: spec.headSha, fixtureFingerprint: fingerprint,
      baseImageDigest: images.base.digest, headImageDigest: images.head.digest,
    };
    require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
    pool = new Pool({ connectionString: 'postgres://usernode:localdev@127.0.0.1:5440/usernode' });
    const { rows: users } = await pool.query(
      "SELECT has_platform_access FROM users WHERE username = 'usernode-capture'"
    );
    if (users[0]?.has_platform_access !== true) {
      throw new Error('Local capture member lacks platform access. Restart local Homeroom to apply its fixture seed.');
    }
    process.env.DOCKER_NETWORK = NETWORK;
    const authTokens = await require('../../src/services/visual-evidence-identities')
      .mintEvidenceAuthTokens(pool, 1);
    const replay = require('../../src/services/visual-evidence-replay');
    const config = { captureRuntime: 'docker', visualEvidence: { maxRunMs: 240_000 } };
    const origins = { base: `http://${names.base}:3000`, head: `http://${names.head}:3000` };
    const input = (pass) => ({ runId, pass, publishArtifacts: pass === 2,
      plan, origins, provenance, authTokens, cookies: {},
      browser: { locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', deviceScaleFactor: 1 } });
    const onEvent = (event) => {
      if (['viewport_started', 'viewport_finished'].includes(event.type)) {
        process.stdout.write(`pass ${event.pass}: ${event.type} ${event.storyId}/${event.viewport}\n`);
      }
    };
    const startPair = async () => {
      await Promise.all(['base', 'head'].map((side) => restoreDatabase(databases[side], dump)));
      const started = await Promise.allSettled(['base', 'head'].map((side) =>
        startApp(names[side], databases[side], images[side].tag)));
      const failed = started.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    };
    await startPair();
    const first = await replay.runPass(config, pr, input(1), { onEvent });
    await stop();
    await startPair();
    const second = await replay.runPass(config, pr, input(2), { onEvent });
    const verdict = replay.comparePasses(first, second, { plan, provenance, runId });
    if (!verdict.passed) {
      if (verdict.code === 'non_reproducible') {
        const changes = first.result.stories.flatMap((left, index) => {
          const right = second.result.stories[index];
          return ['base', 'head'].flatMap((side) => {
            const before = left[side];
            const after = right?.[side];
            if (['fingerprint', 'path', 'contextHash', 'focusHash'].every(
              (key) => before[key] === after?.[key])) return [];
            return [{ story: left.id, viewport: left.viewport, side,
              fingerprint: [before.fingerprint, after?.fingerprint],
              contextHash: [before.contextHash, after?.contextHash],
              focusHash: [before.focusHash, after?.focusHash],
              focusRect: [before.focusRect, after?.focusRect] }];
          });
        });
        throw new Error(`${verdict.code}: ${verdict.reason} ${JSON.stringify(changes)}`);
      }
      throw new Error(`${verdict.code}: ${verdict.reason}`);
    }
    const result = await writeResult(pr, runId, plan, provenance, first, second, verdict);
    process.stdout.write(`${JSON.stringify({ passed: true, pr, outputDir: result.outputDir,
      artifacts: result.artifacts.length, reviewVideos: result.reviewExports.length })}\n`);
  } finally {
    await stop();
    for (const name of Object.values(databases)) {
      await docker(['exec', DB_CONTAINER, 'dropdb', '-U', 'usernode', '--if-exists', name])
        .catch(() => {});
    }
    await docker(['exec', DB_CONTAINER, 'rm', '-f', dump]).catch(() => {});
    if (pool) await pool.end();
    for (const side of ['base', 'head']) {
      if (checkouts[side]?.created) {
        await git(['worktree', 'remove', '--force', checkouts[side].target]).catch(() => {});
      }
    }
  }
}

if (require.main === module) {
  const pr = Number(process.argv[2]);
  main(pr).catch((error) => {
    process.stderr.write(`${error?.code ? `${error.code}: ` : ''}${error?.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { CASES, assertPlanMatchesRecordedClaims, checkoutRevision, main };
