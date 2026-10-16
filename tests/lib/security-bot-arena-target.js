'use strict';

// A scripted in-memory arena target for the security bot's tests ONLY. It
// stands in for a throwaway app the broker reaches, backed by the full
// synthetic fixture set (services/security-bot/fixtures.js). It never ships: it
// lives under tests/lib so a test can drive the real probe against a known-good
// and a known-vulnerable variant without provisioning a real container.
//
//   secure      a project's planted secret is returned only to a member of that
//               project; everyone else gets 403. This is correct behaviour.
//   vulnerable  the membership check is deliberately skipped, so any signed-in
//               caller can read any project's secret. This is the known
//               cross-account data-exposure bug the private-data detector must
//               fire on.
//
// It is returned as a `fetchImpl` the broker can call directly, so the test
// exercises the real broker, run-lease fencing and request counting.

function buildArenaTarget({ set, vulnerable = false } = {}) {
  if (!set?.projects?.A || !set?.projects?.B) throw new Error('fixture set required');
  const projectsByKey = new Map(Object.values(set.projects).map((p) => [p.key, p]));
  const knownIdentity = new Set(Object.values(set.personas).map((p) => p.identityRef));

  return async function fetchImpl(url, options) {
    const path = new URL(url).pathname;
    const token = options.headers['x-usernode-token'];
    // A caller with no recognised arena identity is unauthenticated.
    if (!token || !knownIdentity.has(token)) return { status: 401, text: async () => '' };

    const match = /^\/api\/projects\/([^/]+)\/secret$/.exec(path);
    if (!match) return { status: 404, text: async () => '' };
    const project = projectsByKey.get(match[1]);
    if (!project) return { status: 404, text: async () => '' };

    const isMember = project.memberRefs.includes(token);
    if (vulnerable || isMember) {
      return { status: 200, text: async () => project.secret };
    }
    return { status: 403, text: async () => '' };
  };
}

module.exports = { buildArenaTarget };
