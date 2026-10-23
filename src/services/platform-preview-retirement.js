'use strict';
const policy = require('./platform-preview-data-policy');

// Keep connection credentials private to this verification. Do not widen
// inspectContainer's shared result: status callers may serialize that object.
// Query by immutable container ID, require the actual name, and reject
// duplicate DATABASE_URL entries rather than guessing which one code uses.
async function verifiedDockerReceipt(docker, config, id, name, labels) {
  try {
    const { stdout } = await docker.execFileAsync('docker', [
      'inspect', '--format', '{{json .Name}}\t{{json .Config.Env}}', id,
    ], { timeout: 5000 });
    const [rawName, rawEnv] = String(stdout).trim().split('\t');
    const env = JSON.parse(rawEnv);
    if (JSON.parse(rawName) !== `/${name}` || !Array.isArray(env) || env.some(v => typeof v !== 'string')) return false;
    const urls = env.filter(v => v.startsWith('DATABASE_URL='));
    if (urls.length !== 1) return false;
    return policy.verifyRuntimeReceipt(config, {
      appId: labels?.[policy.APP_ID_LABEL], runtimeName: name,
      policyTag: labels?.[policy.LABEL], databaseUrl: urls[0].slice('DATABASE_URL='.length),
    }, labels?.[policy.RECEIPT_LABEL]);
  } catch { return false; } // never propagate an inspect error containing env
}


// Never uses session status, busy checks, review locks or a session pointer.
// A preview containing an obsolete export is a security retirement, even if
// its proposal is currently being voted on. Failed removals throw for retry.
async function retire(config, pool) {
  if (process.env.USERNODE_ENV === 'staging') return { skipped: 'staging' };
  const { rows } = await pool.query(
    'SELECT id FROM apps WHERE slug = $1 AND self_hosted IS TRUE', [policy.PLATFORM_SLUG]);
  if (rows.length !== 1) throw new Error('Cannot resolve canonical platform for preview data-policy retirement');
  if (require('./application-runtime').mode(config) === 'kubernetes') {
    return require('./kubernetes').retirePlatformPreviewPolicy(config, rows[0].id, policy.DIGEST);
  }
  const docker = require('./docker');
  const { stdout } = await docker.execFileAsync('docker', [
    'ps', '-a', '--format', '{{.ID}}\t{{.Names}}',
  ], { timeout: 10000 });
  let examined = 0, retired = 0;
  for (const line of String(stdout).trim().split('\n').filter(Boolean)) {
    const [id, name] = line.split('\t');
    if (!/^[0-9a-f]{12,64}$/.test(id)) throw new Error('Cannot read Docker preview inventory');
    const ordinary = new RegExp(`^usernode-staging-${policy.PLATFORM_SLUG}--[0-9]+$`).test(name);
    if (!ordinary && !policy.isOpaqueDockerPreview(name)) continue;
    const state = await docker.inspectContainer(id);
    if (!state) throw new Error('Cannot inspect Docker preview data policy');
    if (state.status === 'not_found') continue;
    examined++;
    const tag = state.labels?.[policy.LABEL];
    const platform = state.labels?.[policy.APP_ID_LABEL] === String(rows[0].id);
    const accepted = platform ? tag === policy.DIGEST : !ordinary && tag === 'authored';
    if (accepted && await verifiedDockerReceipt(docker, config, id, name, state.labels)) continue;
    await docker.stopAndRemove(id, { stopTimeoutSec: 0 });
    const after = await docker.inspectContainer(id);
    if (!after || after.status !== 'not_found') throw new Error('Unsafe Docker preview survived data-policy retirement');
    retired++;
  }
  return { examined, retired };
}
module.exports = { retire };
