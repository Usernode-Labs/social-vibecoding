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
      // `github.closePR` stops before GitHub closes it.
      async closePR(owner, repo, number) {
        await fakes.pause('github.closePR');
        await fakes.record('github.closePR', { repo: `${owner}/${repo}`, number });
      },
      // A proposal's pull request: a draft until it is marked ready (what
      // GitHub remembers is in wf_test_effects); its head, as the test set
      // it (`github.prHead`), else a fixed one.
      async getPR(owner, repo, number) {
        const ready = (await fakes.read('github.ready')).some((r) => r.number === number);
        const closed = (await fakes.read('github.closePR')).filter((r) => r.number === number).length
          > (await fakes.read('github.reopenPR')).filter((r) => r.number === number).length;
        const head = (await fakes.read('github.prHead')).filter((h) => h.number === number).pop()?.sha || 'c'.repeat(40);
        return { number, state: closed ? 'closed' : 'open', merged: false, draft: !ready, node_id: `PR_${number}`, head: { sha: head } };
      },
      async reopenPR(owner, repo, number) { await fakes.record('github.reopenPR', { repo: `${owner}/${repo}`, number }); },
      // The draft marked ready; `github.ready.done` is after GitHub did it,
      // before its answer.
      async markPrReadyForReview(owner, repo, number, pr) {
        if (pr && pr.draft === false) return pr;
        await fakes.record('github.ready', { repo: `${owner}/${repo}`, number });
        await fakes.pause('github.ready.done');
        return { ...pr, draft: false };
      },
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
  // A before & after shots run's steps (services/shots-orchestrator.js): its
  // copies are builds and runtimes, its agent a turn in a worker. Each is
  // recorded; the copies stop at `shots.copies.built`, after their images
  // are built (handed over for the step's checkpoint) and before anything
  // else, and they write the agent's workspace as the real step does; the
  // agent saves a before and an after into it.
  const shotsFile = (runId, side) => pool().query(
    `INSERT INTO shot_run_files (run_id, slot, story_id, viewport, side, variant, media, content_type, data, bytes, sha256)
     VALUES ($1, $2, 'c1', 'desktop', $3, 'context', 'png', 'image/png', $4, 3, $5) ON CONFLICT DO NOTHING`,
    [runId, `c1/desktop/${side}/context`, side, Buffer.from(side), side === 'base' ? 'b'.repeat(64) : 'd'.repeat(64)]);
  const pool = () => require(path.join(SRC, 'db/pool')).getPool();
  outside(fakes, 'services/shots-orchestrator', {
    keep: ['platformFault', 'visibleError', 'exactSha', 'headForSession', 'loadSession', 'publicSessionAndApp'],
    overrides: {
      async resolveRevision(_pool, { sessionId, headSha }) {
        await fakes.record('shots.revision', { sessionId, headSha });
        return { baseSha: '0'.repeat(40), headSha };
      },
      async buildCopies(_config, db, o) {
        await fakes.record('shots.copies', { runId: o.runId, reused: !!o.images, fresh: !!o.fresh });
        if (!o.images && o.onImages) await o.onImages({ base: { imageRef: 'img:b', imageDigest: 'sha256:b' }, head: { imageRef: 'img:h', imageDigest: 'sha256:h' } });
        await fakes.pause('shots.copies.built');
        await db.query(
          `INSERT INTO shot_run_control (run_id, session_id, intent, context, expires_at)
           VALUES ($1, $2, $3::jsonb, '{}'::jsonb, NOW() + INTERVAL '1 hour') ON CONFLICT DO NOTHING`,
          [o.runId, o.sessionId, JSON.stringify(o.intent)]);
        return { fixtureFingerprint: 'fp', baseImageDigest: 'sha256:b', headImageDigest: 'sha256:h', afterOnly: false };
      },
      async dispatchAgent(_config, _db, o) {
        await fakes.record('shots.agent', { runId: o.runId });
        await shotsFile(o.runId, 'base');
        await shotsFile(o.runId, 'head');
        return { agent: { outcome: 'completed' }, passed: true, readyCount: 1, failedCount: 0, skippedAny: false,
          verdict: { passed: true, mode: 'shots', runs: 1, stories: [{ id: 'c1', status: 'ready', files: 2 }] },
          manifestHash: 'e'.repeat(64), slots: ['c1/desktop/base/context', 'c1/desktop/head/context'], trace: {} };
      },
      async compareScreens(_db, { verdict }) { return verdict; },
      async cleanupRun(_config, db, o) {
        await fakes.record('shots.cleanup', { runId: o.runId });
        await db.query('DELETE FROM shot_run_control WHERE run_id = $1', [o.runId]);
        return { cleaned: true, version: 2 };
      },
    },
  });
  // A session's worker container: destroying it is recorded (the container
  // runtime is outside); everything else in the module is real.
  const worker = require(path.join(SRC, 'services/worker'));
  fakes.stub(path.join(SRC, 'services/worker'), {
    ...worker, async destroyWorker(name) { await fakes.record('worker.destroy', { name }); },
  });
  // Not an outside service, a probe: whether the Workshop hears a board
  // change in this process (its listener is registered by server.js only).
  const themes = require(path.join(SRC, 'services/workshop-themes'));
  fakes.stub(path.join(SRC, 'services/workshop-themes'), {
    ...themes, noteBoardChange: (pool, info) => { fakes.record('workshop.boardChange', info).catch(() => {}); return true; },
  });
};
