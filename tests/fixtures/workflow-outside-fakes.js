'use strict';

// The outside services, faked for the workflow side of a two-process test
// (tests/lib/workflow-child.js): GitHub's API, the container runtime (Docker,
// Kubernetes), the model, and the phone push provider (Firebase). Each
// module keeps its pure helpers, its own in-process caches and its `init`
// real (the child boots through src/workflow/setup.ts as server.js does);
// what would reach the outside is replaced. The push provider is faked at
// its library, so the platform's own push code runs. A call a test did not
// expect fails like an unreachable service, and is recorded as
// `fake.unexpected` so the test can see what its flow touched.
//
// What GitHub would remember (an issue closed, a comment created) is kept in
// wf_test_effects, so a process started after a crash reads it back as it
// would from GitHub.

const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src');
const isClass = (fn) => /^class\b/.test(Function.prototype.toString.call(fn));

// The module with every function replaced by one that fails, except the
// ones kept real and the overrides.
function outside(fakes, rel, { keep = [], overrides = {} }) {
  const real = require(path.join(SRC, rel));
  const kept = new Set(keep);
  const out = {};
  for (const [name, value] of Object.entries(real)) {
    if (typeof value !== 'function' || isClass(value) || kept.has(name)) { out[name] = value; continue; }
    out[name] = () => {
      fakes.record('fake.unexpected', { module: rel, fn: name }).catch(() => {});
      throw Object.assign(new Error(`${rel}.${name} reaches an outside service this test does not fake`), { code: 'ECONNREFUSED' });
    };
  }
  fakes.stub(path.join(SRC, rel), { ...out, ...overrides });
}

module.exports = function install(fakes) {
  const comments = async (number) => (await fakes.read('github.comment')).filter((c) => c.number === number);
  outside(fakes, 'services/github', {
    keep: ['init', 'parseGithubUrl', 'safeMention', 'noteIssuesClosed', 'unsuppressIssues', 'invalidateIssuesCache',
      'noteIssueCreated', 'describeGithubError', 'credentialClass', 'clipIssueComments'],
    overrides: {
      isEnabled: () => true,
      async getIssue(owner, repo, number) {
        const closed = (await fakes.read('github.close')).some((c) => c.number === number);
        return { number, state: closed ? 'closed' : 'open' };
      },
      async closeIssue(owner, repo, number) { await fakes.record('github.close', { repo: `${owner}/${repo}`, number }); },
      // GitHub creates the comment, then its answer may never arrive: the
      // `github.comment.created` point is between the two.
      async createIssueComment(owner, repo, number, body) {
        await fakes.record('github.comment', { repo: `${owner}/${repo}`, number, body });
        await fakes.pause('github.comment.created');
        return { id: Date.now() };
      },
      async fetchIssueComments(owner, repo, number) {
        return { comments: (await comments(number)).map((c) => ({ body: c.body })), truncated: false };
      },
      async closePR(owner, repo, number) { await fakes.record('github.closePR', { repo: `${owner}/${repo}`, number }); },
      // A pull request's commits, as the test recorded them (`github.prCommits`);
      // the `github.prCommits` point is after GitHub listed them.
      async listPullRequestCommitShas(owner, repo, number) {
        const shas = (await fakes.read('github.prCommits')).filter((c) => c.number === number).flatMap((c) => c.shas);
        await fakes.pause('github.prCommits');
        return { shas, complete: true };
      },
      async getCommitTree() { return null; },
      // Whether a build contains a merge: `github.compare` stops before it answers.
      async compareCommitAncestry(owner, repo, base, head) {
        await fakes.record('github.compare', { base, head });
        await fakes.pause('github.compare');
        return { status: base === head ? 'identical' : 'ahead' };
      },
      // A production deploy starts by cloning; `github.clone` stops there.
      async getCloneUrl(owner, repo) {
        await fakes.pause('github.clone');
        throw Object.assign(new Error(`clone of ${owner}/${repo} is not faked`), { code: 'ECONNREFUSED' });
      },
    },
  });
  outside(fakes, 'services/docker', {
    keep: ['containerHostname', 'parseDockerBuildLine', 'STOP_GRACE_SEC', 'STAGING_STOP_GRACE_SEC'],
    overrides: {
      async removeVolume(name) { await fakes.record('docker.removeVolume', { name }); },
    },
  });
  outside(fakes, 'services/kubernetes', { keep: [] });
  outside(fakes, 'services/llm', { keep: ['init'], overrides: { isEnabled: () => false } });
  // Firebase: what a push to a phone carries, recorded (`push.send`).
  const firebase = (name, exports) => fakes.stub(require.resolve(name, { paths: [SRC] }), exports);
  firebase('firebase-admin/app', { initializeApp: (o, name) => ({ name }), cert: (account) => account, deleteApp: async () => {} });
  firebase('firebase-admin/messaging', { getMessaging: () => ({
    async send(message) {
      await fakes.record('push.send', { token: message.token, badge: message.apns?.payload?.aps?.badge ?? null });
      return 'projects/test/messages/1';
    },
  }) });
  // Not an outside service, a probe: whether the Workshop hears a board
  // change in this process (its listener is registered by server.js only).
  const themes = require(path.join(SRC, 'services/workshop-themes'));
  fakes.stub(path.join(SRC, 'services/workshop-themes'), {
    ...themes, noteBoardChange: (pool, info) => { fakes.record('workshop.boardChange', info).catch(() => {}); return true; },
  });
};
