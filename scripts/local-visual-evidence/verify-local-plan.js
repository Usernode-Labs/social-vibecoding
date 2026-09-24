#!/usr/bin/env node
'use strict';

// Verify an author-written plan against two real local platform revisions
// before opening a PR. The same replay runner used by hosted evidence makes
// the media; a local database snapshot supplies identical starting state.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Pool } = require('pg');
const contract = require('../../src/services/visual-evidence-plan');
const lab = require('./run');

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, '../..');
const DB_CONTAINER = 'vibecoding-db-dev';
const NETWORK = 'usernode-net';

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--help') return { help: true };
    if (!['--base', '--head', '--plan', '--intent', '--env-file', '--output-dir'].includes(key)
        || !args[index + 1] || args[index + 1].startsWith('--') || values[key]) {
      throw new Error(`Invalid or repeated argument ${key}. Use --help for usage.`);
    }
    values[key] = args[++index];
  }
  for (const key of ['--base', '--head', '--plan', '--intent']) {
    if (!values[key]) throw new Error(`${key} is required. Use --help for usage.`);
  }
  for (const key of ['--base', '--head']) {
    if (!/^[0-9a-f]{40}$/.test(values[key])) {
      throw new Error(`${key} must be an exact 40-character lowercase commit SHA.`);
    }
  }
  if (values['--base'] === values['--head']) {
    throw new Error('Base and head must be different commits.');
  }
  return {
    baseSha: values['--base'], headSha: values['--head'],
    planFile: path.resolve(values['--plan']),
    intentFile: path.resolve(values['--intent']),
    envFile: path.resolve(values['--env-file'] || path.join(ROOT, '.env')),
    outputRoot: path.resolve(values['--output-dir'] || path.join(ROOT, '.local-visual-evidence')),
  };
}

async function assertLocalConfig(envFile) {
  const env = await fs.readFile(envFile, 'utf8').catch(() => '');
  if (!/^USERNODE_LOCAL_DEV=1$/m.test(env)
      || !/^DATABASE_URL=postgres:\/\/usernode:localdev@db:5432\/usernode$/m.test(env)) {
    throw new Error('A local-only Homeroom .env is required. Run npm run visual-evidence:local-setup in the running checkout.');
  }
}

async function assertLocalPlatform() {
  const response = await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(5_000) });
  if (!response.ok || (await response.json()).status !== 'ok') {
    throw new Error('Local Homeroom is not healthy. Start it with make up.');
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

async function checkoutRevision(runId, side, sha) {
  const target = path.join(ROOT, '.local-visual-evidence', 'pre-pr-revisions', runId, side);
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
  if (changes) throw new Error(`${side} checkout has tracked changes; the image must use a clean revision.`);
  return { target, created };
}

async function buildImage(sha, checkout) {
  // Repeated plan edits should not create an unbounded set of local tags.
  const tag = `usernode-evidence-local:${sha.slice(0, 16)}`;
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

async function startApp(name, dbName, image, envFile) {
  await docker([
    'run', '-d', '--rm', '--name', name, '--network', NETWORK,
    '--env-file', envFile,
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

async function writeResult(options, runId, plan, intent, provenance, first, second, verdict) {
  const outputDir = path.join(options.outputRoot, `pre-pr-${runId}`);
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
    kind: 'local_exact_revision_replay',
    passed: true,
    runId,
    planHash: contract.planHash(plan),
    plan,
    intent,
    provenance,
    replayPasses: [first.result, second.result],
    verdict,
    artifacts,
    reviewExports,
    limitations: [
      'The local development database is the fixture; live app data may differ.',
      'The platform will replay independently after proposal import.',
      'A person must inspect the media to judge whether it proves the claim.',
    ],
  };
  await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(outputDir, 'submission.json'), `${JSON.stringify({
    visualEvidence: intent,
    visualEvidencePlan: {
      baseSha: options.baseSha, headSha: options.headSha,
      planHash: manifest.planHash, plan,
    },
  }, null, 2)}\n`);
  return { outputDir, artifacts, reviewExports };
}

function failureLocation(error) {
  const detail = error?.detail;
  if (!detail || typeof detail !== 'object') return null;
  const location = {};
  for (const key of ['storyId', 'viewport', 'side', 'phase', 'actionId', 'actionType', 'assertionType']) {
    if (typeof detail[key] === 'string') location[key] = detail[key].slice(0, 96);
  }
  if (Number.isInteger(detail.assertionIndex)) location.assertionIndex = detail.assertionIndex;
  if (Number.isInteger(detail.count)) location.matchedCount = detail.count;
  if (Array.isArray(detail.targetStates)) {
    location.targetStates = detail.targetStates.slice(0, 4).map((state) => ({
      kind: state.kind, matchedCount: state.matchedCount,
      attachedCount: state.attachedCount, visibleCount: state.visibleCount,
      ...(state.roleHints ? { roleHints: state.roleHints } : {}),
    }));
  }
  if (detail.execution?.lastEvent) location.lastEvent = detail.execution.lastEvent;
  return Object.keys(location).length ? location : null;
}

async function verifyLocalPlan(options) {
  const plan = contract.parseReplayPlan(JSON.parse(await fs.readFile(options.planFile, 'utf8')));
  const intent = contract.parseIntent(JSON.parse(await fs.readFile(options.intentFile, 'utf8')));
  if (contract.canonicalJson(contract.semanticIntentFromPlan(plan))
      !== contract.canonicalJson(intent)) {
    throw new Error('The replay plan changes the declared visual evidence intent.');
  }
  await assertLocalConfig(options.envFile);
  await assertLocalPlatform();
  await docker(['network', 'inspect', NETWORK]);
  // docker.js captures this network when visuals/replay is first required.
  process.env.DOCKER_NETWORK = NETWORK;
  // Review-video export binds this directory into the capture image. Colima
  // and remote Docker daemons do not necessarily share the host's /tmp.
  await require('../../src/services/visuals').ensureCaptureImage();
  await fs.mkdir(options.outputRoot, { recursive: true });
  const mountedOutputRoot = await fs.realpath(options.outputRoot);
  try {
    await docker(['run', '--rm', '--network', 'none',
      '--mount', `type=bind,source=${mountedOutputRoot},target=/evidence,readonly`,
      'usernode-capture:latest', 'test', '-d', '/evidence']);
  } catch {
    throw new Error('Docker cannot mount the local evidence output directory. Choose a Docker-shared path, such as the repository’s .local-visual-evidence directory.');
  }
  const runId = crypto.randomBytes(16).toString('hex');
  const checkouts = {};
  const names = { base: `usernode-pre-pr-${runId.slice(0, 8)}-base`,
    head: `usernode-pre-pr-${runId.slice(0, 8)}-head` };
  const databases = { base: `evidence_pre_pr_${runId.slice(0, 12)}_base`,
    head: `evidence_pre_pr_${runId.slice(0, 12)}_head` };
  const dump = `/tmp/evidence-pre-pr-${runId}.dump`;
  const stop = async () => lab.stopFixtures(Object.values(names));
  let pool;
  try {
    for (const side of ['base', 'head']) {
      checkouts[side] = await checkoutRevision(runId, side, options[`${side}Sha`]);
    }
    const images = {};
    for (const side of ['base', 'head']) {
      images[side] = await buildImage(options[`${side}Sha`], checkouts[side].target);
    }
    await docker(['exec', DB_CONTAINER, 'pg_dump', '-U', 'usernode', '-d', 'usernode',
      '-Fc', '-f', dump], 120_000);
    const fingerprint = (await docker(['exec', DB_CONTAINER, 'sha256sum', dump])).split(' ')[0];
    const provenance = {
      baseSha: options.baseSha, headSha: options.headSha, fixtureFingerprint: fingerprint,
      baseImageDigest: images.base.digest, headImageDigest: images.head.digest,
    };
    require('dotenv').config({ path: options.envFile, quiet: true });
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
      const restored = await Promise.allSettled(['base', 'head'].map((side) =>
        restoreDatabase(databases[side], dump)));
      const restoreFailure = restored.find((result) => result.status === 'rejected');
      if (restoreFailure) throw restoreFailure.reason;
      const started = await Promise.allSettled(['base', 'head'].map((side) =>
        startApp(names[side], databases[side], images[side].tag, options.envFile)));
      const failed = started.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    };
    const prepareCase = async () => {
      await stop();
      await startPair();
      return { origins };
    };
    const captureId = Number.parseInt(runId.slice(0, 6), 16) + 1;
    const first = await replay.runPassCases(config, captureId, input(1), { prepareCase, onEvent });
    const second = await replay.runPassCases(config, captureId, input(2), { prepareCase, onEvent });
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
    const result = await writeResult(options, runId, plan, intent, provenance, first, second, verdict);
    process.stdout.write(`${JSON.stringify({ passed: true, runId, planHash: contract.planHash(plan),
      baseSha: options.baseSha, headSha: options.headSha, outputDir: result.outputDir,
      artifacts: result.artifacts.length, reviewVideos: result.reviewExports.length })}\n`);
    return result;
  } catch (error) {
    await fs.mkdir(options.outputRoot, { recursive: true }).catch(() => {});
    await fs.writeFile(path.join(options.outputRoot, `pre-pr-${runId}-failure.json`),
      `${JSON.stringify({ passed: false, runId, baseSha: options.baseSha,
        headSha: options.headSha, planHash: contract.planHash(plan),
        code: error.code || null, message: error.message,
        location: failureLocation(error) }, null, 2)}\n`).catch(() => {});
    throw error;
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
  Promise.resolve().then(() => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write('Usage: npm run verify:visual-evidence:local -- --base SHA --head SHA --intent FILE --plan FILE [--env-file FILE] [--output-dir DIR]\n');
      return;
    }
    return verifyLocalPlan(options);
  }).catch((error) => {
    process.stderr.write(`${error?.code ? `${error.code}: ` : ''}${error?.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, verifyLocalPlan, writeResult, failureLocation };
