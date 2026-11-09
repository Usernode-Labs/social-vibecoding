'use strict';

// What a git child process is given when it runs on content somebody else
// wrote: a patch a person or an agent submitted, a branch read from their
// fork, an app's repository.
//
//   * Its environment is what git needs and nothing else of this process's:
//     PATH, a HOME and XDG_CONFIG_HOME outside the work tree, no system or
//     global config, no prompt, a fixed locale (the code reads git's English
//     messages: "stale info", "rejected") and this process's timezone. So
//     `git am` on a submitted patch never holds DATABASE_URL,
//     GITHUB_PRIVATE_KEY, GIT_HOST_TOKEN or anything else the platform runs
//     with, and no file in the repository configures git itself.
//   * A write credential reaches only the invocation handed it, and only
//     through a credential helper that reads it from that one process's
//     environment: never argv (which /proc/<pid>/cmdline shows to anything
//     on the node), a remote URL, git config or disk. With it, that
//     invocation follows no HTTP redirect, so the credential goes only to
//     the host it was meant for. services/git-host.js and
//     services/worker-git-push.js do the same for their own git.
//
//   invocation(args, { home, credential, env })  ->  { args, env }
//
// `args` is git's own argv (no `git`); `home` a directory outside any work
// tree (it need not exist); `credential` { username, token }
// (external-agent-head.js resolveWriteCredential: GitHub takes
// `x-access-token` with an installation token, Homeroom's git host its
// service account); `env` the few GIT_* settings a caller sets for one
// invocation (an index file, commit dates), never a credential.

const HELPER = '!f() { if [ "$1" = get ]; then printf "%s\\n" "username=$USERNODE_GIT_USERNAME" "password=$USERNODE_GIT_PASSWORD"; fi; }; f';

function configArgs(credential) {
  return [
    '-c', 'credential.helper=',
    '-c', 'core.hooksPath=/dev/null',
    ...(credential ? ['-c', `credential.helper=${HELPER}`, '-c', 'http.followRedirects=false'] : []),
  ];
}

function childEnv(home, { credential = null, extra = {} } = {}) {
  if (!home) throw new Error('A git child needs a home outside its work tree');
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/true',
    LC_ALL: 'C',
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    ...extra,
    ...(credential ? { USERNODE_GIT_USERNAME: String(credential.username || ''), USERNODE_GIT_PASSWORD: String(credential.token || '') } : {}),
  };
}

function subcommand(args) {
  let i = 0;
  while (i < args.length && String(args[i]).startsWith('-')) {
    const option = args[i++];
    if (['-C', '-c', '--git-dir', '--work-tree', '--config-env'].includes(option)) i++;
  }
  return args[i];
}
function isWrite(args) { return ['push', 'send-pack', 'http-push', 'receive-pack'].includes(subcommand(args)); }

function invocation(args, { home, credential = null, env: extra = {} } = {}) {
  // All platform git transports use this boundary.
  if (isWrite(args)) {
    require('./code-host-write').requireCodeHostWrite('git.' + subcommand(args));
  }
  return { args: [...configArgs(credential), ...args], env: childEnv(home, { credential, extra }) };
}

module.exports = { HELPER, invocation, isWrite };
