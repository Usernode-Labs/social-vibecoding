'use strict';

// The conductor publishes repository-scoped read access on the existing clock
// machine. Its kept result survives a failed refresh; only encrypted tokens
// enter the journal. Web reads that result, never the GitHub App credential.
const { encrypt, decrypt } = require('./secrets');
const { processRole, runsWorkflow } = require('./process-role');
const repoRef = require('./repo-ref');

const JOB = 'github-read-access';
const RECHECK_MS = 5 * 60_000;
const REFRESH_BEFORE_MS = 10 * 60_000;
const CACHE_MS = 15_000;
const EXPIRY_MARGIN_MS = 60_000;
let config = null, pool = null, cached = null, readAt = 0, reading = null;

function scope(cfg) {
  const repo = repoRef.parse(repoRef.platformRepoUrl(cfg));
  return repo?.host === 'github' && cfg?.githubAppId
    ? `${String(cfg.githubAppId)}:${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}` : null;
}
function matches(record, cfg) { return !!record && !!scope(cfg) && record.scope === scope(cfg); }
function open(record, cfg, now = Date.now()) {
  if (!matches(record, cfg) || !record.tokenEnc) return null;
  const raw = decrypt(record.tokenEnc, cfg.dataEncryptionKey);
  try {
    const access = JSON.parse(raw);
    const expires = Date.parse(access.expiresAt);
    return access.scope === scope(cfg) && typeof access.token === 'string' && access.token
      && Number.isFinite(expires) && expires > now + EXPIRY_MARGIN_MS ? access : null;
  } catch { return null; }
}

async function refresh(cfg, previous = null) {
  require('./code-host-write').requireCodeHostWrite('github.readAccess');
  const github = require('./github');
  const now = Date.now();
  const base = { scope: scope(cfg), installed: false, checkedAt: new Date(now).toISOString() };
  if (!base.scope || !github.hasApp()) return base;
  if (!repoRef.sameRepo(repoRef.platformRepoUrl(cfg), repoRef.platformRepoUrl())) {
    throw new Error('GitHub read access requires matching platform repository configuration');
  }
  if (!cfg.dataEncryptionKey) throw new Error('GitHub read access requires a data encryption key');
  const prior = matches(previous, cfg) ? previous : null;
  let installationId = prior?.installationId;
  const checkedAt = Date.parse(prior?.checkedAt);
  if (!installationId || !Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt >= RECHECK_MS) {
    installationId = await github.readInstallationId();
    if (!installationId) return base;
  } else {
    base.checkedAt = prior.checkedAt;
  }
  let access = open(prior, cfg, now);
  let tokenEnc = prior?.tokenEnc;
  if (!access || installationId !== prior.installationId || Date.parse(access.expiresAt) <= now + REFRESH_BEFORE_MS) {
    const auth = await github.mintReadToken(installationId);
    access = { scope: base.scope, token: auth.token, expiresAt: auth.expiresAt };
    tokenEnc = encrypt(JSON.stringify(access), cfg.dataEncryptionKey);
  }
  const repo = repoRef.parse(repoRef.platformRepoUrl(cfg));
  // Actions-secret names need a separate App permission. Publish the metadata
  // from the conductor instead of adding that permission to web's read token.
  const actionsSecrets = await github.listActionsSecrets(repo.owner, repo.repo);
  return { ...base, installed: true, installationId, tokenEnc, expiresAt: access.expiresAt, actionsSecrets };
}

async function load({ force = false } = {}) {
  if (!pool || !config || !scope(config)) return null;
  if (!force && Date.now() - readAt < CACHE_MS) return cached;
  if (reading) return reading;
  reading = (async () => {
    try {
      const { rows: [row] } = await pool.query(
        `SELECT data->'kept' AS access FROM wf_instances WHERE machine = 'clock' AND key = $1`, [`clock:${JOB}`]);
      cached = matches(row?.access, config) ? row.access : null;
    } catch {
      // A short database outage may use an unexpired token already read.
      // Never include a query, result or credential in the error log.
    }
    readAt = Date.now();
    return cached;
  })().finally(() => { reading = null; });
  return reading;
}

async function init(cfg, db) {
  config = cfg; pool = db; cached = null; readAt = 0;
  if (!runsWorkflow(processRole())) await load({ force: true });
}
function configured() { return !!scope(config); }
function installed() {
  // canActOn is synchronous. Refresh the fact without doing privileged I/O.
  load().catch(() => {});
  const checked = Date.parse(cached?.checkedAt);
  return matches(cached, config) && cached.installed === true
    && checked <= Date.now() && Date.now() - checked < RECHECK_MS + 60_000;
}
async function token(owner) {
  const acting = repoRef.parse(repoRef.platformRepoUrl(config));
  if (!acting || String(owner).toLowerCase() !== acting.owner.toLowerCase()) {
    throw require('./github-pause').pausedError('owner');
  }
  let access = await load();
  let value = open(access, config);
  if (!value) { access = await load({ force: true }); value = open(access, config); }
  if (!access?.installed || !value) throw Object.assign(new Error('GitHub read access is unavailable'), { code: 'github_read_unavailable', status: 503 });
  return value.token;
}
async function actionsSecrets(owner, repo) {
  const acting = repoRef.parse(repoRef.platformRepoUrl(config));
  if (!acting || String(owner).toLowerCase() !== acting.owner.toLowerCase()
      || String(repo).replace(/\.git$/i, '').toLowerCase() !== acting.repo.toLowerCase()) {
    return { ok: false, code: 'not_found', message: 'No platform repository to read secrets from.' };
  }
  const access = await load();
  return installed() && access?.actionsSecrets
    ? access.actionsSecrets : { ok: false, code: 'no_token', message: 'GitHub read access is unavailable.' };
}

module.exports = { JOB, refresh, init, configured, installed, token, actionsSecrets };
