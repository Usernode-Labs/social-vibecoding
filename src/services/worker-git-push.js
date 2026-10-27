'use strict';

// The worker is an untrusted Git repository, including its hooks, config,
// remotes and executables. Only Git objects cross this boundary. Never run
// authenticated Git there, copy its .git directory, or check out its code in
// the platform process. remoteUrl and branchName come from platform state.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { validatePackBudget } = require('./worker-git-budget');
const { createQueue } = require('./worker-git-queue');
const gitProcess = require('./worker-git-process');

const pushQueue = createQueue();
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_EXPORT_BYTES = Math.ceil(MAX_BUNDLE_BYTES / 3) * 4 + 128;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_PREREQUISITES = 32;
const SHA = /^[0-9a-f]{40}$/;

function quote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function buildExportScript({ branchName, workspace = '/home/node/workspace' }) {
  return [
    'set -eu',
    `BRANCH=${quote(branchName)}`,
    `cd ${quote(workspace)}`,
    // Preserve the heal for an agent that committed on a descendant branch.
    // An unrelated HEAD must never replace the session's own branch.
    'cur=$(git symbolic-ref --quiet --short HEAD || true)',
    'if [ "$cur" != "$BRANCH" ] && git rev-parse --quiet --verify "refs/heads/$BRANCH" >/dev/null && git merge-base --is-ancestor "refs/heads/$BRANCH" HEAD; then',
    '  git branch --force "$BRANCH" HEAD >&2',
    'fi',
    'sha=$(git rev-parse --verify "refs/heads/$BRANCH^{commit}")',
    // Exclude upstream history to avoid copying a whole platform repository
    // on every push. These refs are untrusted: the platform obtains every
    // actual bundle prerequisite independently from the canonical public
    // repository before importing anything. A forged base fails closed.
    'base=$(git merge-base "refs/heads/$BRANCH" refs/remotes/origin/main 2>/dev/null || true)',
    'if [ "$sha" = "$base" ]; then',
    '  printf "__USERNODE_GIT_EXPORT_V1__ %s\\n-\\n" "$sha"',
    '  exit 0',
    'fi',
    'bundle=$(mktemp)',
    'trap \'rm -f "$bundle"\' 0',
    'if [ -n "$base" ]; then',
    '  git bundle create --quiet --version=2 "$bundle" "refs/heads/$BRANCH" "^$base"',
    'else',
    '  git bundle create --quiet --version=2 "$bundle" "refs/heads/$BRANCH"',
    'fi',
    `if [ "$(wc -c < "$bundle")" -gt ${MAX_BUNDLE_BYTES} ]; then echo 'Worker Git export exceeds the size limit' >&2; exit 1; fi`,
    // Read the exported head, not a HEAD that may have changed meanwhile.
    'sha=$(git bundle list-heads "$bundle" "refs/heads/$BRANCH" | cut -d " " -f 1)',
    'printf "__USERNODE_GIT_EXPORT_V1__ %s\\n" "$sha"',
    'base64 < "$bundle" | tr -d "\\r\\n"',
    'printf "\\n"',
  ].join('\n');
}

// git push -u used to do this in the worker. Keep its tracking state after
// a successful trusted push (especially the sealed benchmark checkout),
// with no credential present. A failed acknowledgement cannot undo a push.
function buildRecordPushScript({ branchName, sha, workspace = '/home/node/workspace' }) {
  if (!SHA.test(sha)) throw new Error('Invalid pushed commit');
  return [
    'set -e',
    `cd ${quote(workspace)}`,
    `git update-ref ${quote(`refs/remotes/origin/${branchName}`)} ${quote(sha)}`,
    `git config ${quote(`branch.${branchName}.remote`)} origin`,
    `git config ${quote(`branch.${branchName}.merge`)} ${quote(`refs/heads/${branchName}`)}`,
  ].join('\n');
}

function parseExport(stdout, branchName) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_EXPORT_BYTES) {
    throw new Error('Worker Git export exceeds the size limit');
  }
  const lines = stdout.split('\n');
  const head = /^__USERNODE_GIT_EXPORT_V1__ ([0-9a-f]{40})$/.exec(lines[0]);
  if (!head || lines.length !== 3 || lines[2] !== '') throw new Error('Invalid worker Git export');
  const sha = head[1];
  // Git refuses to create an empty bundle. This commit must already be
  // available in the canonical public repository; never trust the claim.
  if (lines[1] === '-') return { sha, bundle: null, prerequisites: [sha], pack: null };
  const encoded = lines[1];
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid worker Git bundle encoding');
  const bundle = Buffer.from(encoded, 'base64');
  if (bundle.length > MAX_BUNDLE_BYTES || bundle.toString('base64') !== encoded) {
    throw new Error('Invalid worker Git bundle encoding or size');
  }
  // Accept the deliberately small v2/SHA-1 format, without v3 filter or
  // object-format capabilities. Ref names and prerequisite comments never
  // become commands, paths or destination URLs. Git verifies the pack too.
  const end = bundle.indexOf('\n\n');
  if (end < 0 || end > MAX_HEADER_BYTES) throw new Error('Invalid worker Git bundle header');
  const header = bundle.subarray(0, end).toString('utf8').split('\n');
  if (header.shift() !== '# v2 git bundle' || header.pop() !== `${sha} refs/heads/${branchName}`) {
    throw new Error('Worker Git bundle does not match the session branch and commit');
  }
  if (header.length > MAX_PREREQUISITES) throw new Error('Too many worker Git bundle prerequisites');
  const prerequisites = header.map(line => {
    const match = /^-([0-9a-f]{40}) [^\r\n\0]*$/.exec(line);
    if (!match) throw new Error('Invalid worker Git bundle prerequisite');
    return match[1];
  });
  return { sha, bundle, prerequisites: [...new Set(prerequisites)], pack: bundle.subarray(end + 2) };
}

function redact(text, token, username = 'x-access-token') {
  let result = String(text || '');
  for (const secret of [token, encodeURIComponent(token), Buffer.from(`${username}:${token}`).toString('base64'),
    Buffer.from(`x-access-token:${token}`).toString('base64')]) {
    if (secret) result = result.split(secret).join('***');
  }
  return result;
}

// No token in argv, URL, config, disk or worker transport. This helper is
// installed only on the final trusted Git invocation. The fresh repository
// has no other helpers and HTTP redirects are disabled.
const CREDENTIAL_HELPER = '!f() { if [ "$1" = get ]; then printf "%s\\n" "username=$USERNODE_PUSH_USER" "password=$USERNODE_PUSH_TOKEN"; fi; }; f';

// `username`: who the token belongs to. GitHub takes any name with a token
// (x-access-token); Homeroom's git host (services/git-host.js) takes its
// service account's. `authFetch`: the base commits are fetched with the same
// credential too, for a destination that is not public.
async function push(options) {
  const { remoteUrl, branchName, token } = options;
  const { isValidBranchName } = require('./branch-names');
  if (!isValidBranchName(branchName)) throw new Error('Invalid push branch');
  if (!token) throw new Error('Missing GitHub push credential');
  return pushQueue.run(`${remoteUrl}\0${branchName}`, () => publish(options));
}

async function publish({ remoteUrl, branchName, token, exportWorker, expectedSha = null, username = 'x-access-token', authFetch = false }) {
  let dir;
  try {
    const exported = await exportWorker(buildExportScript({ branchName }));
    const { sha, bundle, prerequisites, pack } = parseExport(exported.stdout, branchName);
    if (expectedSha && sha !== expectedSha) throw Object.assign(new Error('Worker commit changed before publication'), { code: 'commit_changed', permanent: true });
    if (pack) await validatePackBudget(pack);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usernode-worker-push-'));
    // mkdtemp is 0700. No inherited Git env, HOME config, template, hooks,
    // alternates, URL rewrites, proxies or trace destinations can reach Git.
    const env = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: dir, XDG_CONFIG_HOME: dir, TMPDIR: dir,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false',
      GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C',
    };
    const repo = path.join(dir, 'repo.git');
    const config = [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'credential.helper=',
      '-c', 'http.followRedirects=false',
      '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always',
      // These also allow local integration tests. The caller, worker.js,
      // validates the server-recorded URL as canonical GitHub HTTPS.
      '-c', 'protocol.http.allow=always',
      '-c', 'protocol.file.allow=always',
      '-c', 'fetch.fsckObjects=true',
      '-c', 'fetch.unpackLimit=0',
      '-c', 'gc.auto=0',
      '-c', 'gc.autoDetach=false',
      '-c', 'maintenance.auto=false',
      '-c', 'pack.threads=1',
      '-c', 'pack.windowMemory=16m',
      '-c', 'pack.deltaCacheSize=16m',
    ];
    const git = (args, authenticated = false) => gitProcess.run('/usr/bin/git', [
      '-C', repo, ...config,
      ...(authenticated ? ['-c', `credential.helper=${CREDENTIAL_HELPER}`] : []),
      ...args,
    ], {
      env: authenticated ? { ...env, USERNODE_PUSH_USER: username, USERNODE_PUSH_TOKEN: token } : env,
    });
    await fs.mkdir(repo);
    await git(['init', '--quiet', '--bare', '--template=']);
    if (prerequisites.length) {
      // Every omitted commit is obtained from exactly the same destination
      // that will receive the push (without credentials unless authFetch).
      // No worker remote or alternate object store is ever consulted.
      await git(['fetch', '--quiet', '--depth=1', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--no-auto-maintenance',
        '--', remoteUrl, ...prerequisites.map((base, i) => `${base}:refs/usernode/base-${i}`)], authFetch);
    }
    if (bundle) {
      const file = path.join(dir, 'worker.bundle');
      await fs.writeFile(file, bundle, { mode: 0o600 });
      await git(['bundle', 'verify', file]);
      await git(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--no-auto-maintenance',
        '--', file, `refs/heads/${branchName}:refs/heads/export`]);
      const head = await git(['rev-parse', '--verify', 'refs/heads/export^{commit}']);
      if (head.stdout.trim() !== sha) throw new Error('Imported worker commit does not match the export');
    } else {
      const head = await git(['rev-parse', '--verify', `${sha}^{commit}`]);
      if (head.stdout.trim() !== sha) throw new Error('Canonical commit does not match the export');
    }
    // Only this invocation receives the credential. No force, extra refs,
    // tags, submodule pushes or pre-push hooks, even for hostile commits.
    const result = await git(['push', '--porcelain', '--no-verify', '--no-follow-tags', '--recurse-submodules=no',
      '--', remoteUrl, `${sha}:refs/heads/${branchName}`], true);
    return { sha, stderr: redact(result.stderr, token, username).trim() };
  } catch (error) {
    // Return a new, bounded error, never the raw child/transport error or
    // its potentially huge stdout. Preserve a useful redacted Git reason.
    const detail = error.stderr ? `: ${error.stderr}` : '';
    const safe = new Error(redact(`${error.message}${detail}`, token, username).slice(0, 2000));
    safe.code = error.code;
    safe.permanent = error.permanent === true;
    safe.stderr = redact(error.stderr, token, username).slice(0, 8000);
    throw safe;
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

module.exports = { push, buildExportScript, buildRecordPushScript, parseExport, MAX_BUNDLE_BYTES, MAX_EXPORT_BYTES };
