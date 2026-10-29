'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireCodeHostWrite } = require('../src/services/code-host-write');

function asRole(t, role) {
  const prior = process.env.PROCESS_ROLE;
  process.env.PROCESS_ROLE = role;
  t.after(() => { if (prior === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = prior; });
}
const refused = (fn) => assert.rejects(Promise.resolve().then(fn), (e) => e.code === 'workflow_role_required');

test('web refuses every code-host write before host or repository I/O', async (t) => {
  asRole(t, 'web');
  const cases = {
    github: {
      createRepo: ['Usernode-Labs','x'], pushFiles: ['Usernode-Labs','x',[]], createRootCommit: ['Usernode-Labs','x',[]],
      createBranch: ['Usernode-Labs','x','b'], ensureBranchAtSha: ['Usernode-Labs','x','b','a'.repeat(40)],
      advanceBranchToSha: ['Usernode-Labs','x','b','a'.repeat(40)], forceBranchToSha: ['Usernode-Labs','x','b','a'.repeat(40)],
      createProposalCommit: ['Usernode-Labs','x',{}], createPR: ['Usernode-Labs','x',{}],
      updatePR: ['Usernode-Labs','x',1,{}], retargetPR: ['Usernode-Labs','x',1,'main'],
      closePR: ['Usernode-Labs','x',1], reopenPR: ['Usernode-Labs','x',1], mergePR: ['Usernode-Labs','x',1],
      markPrReadyForReview: ['Usernode-Labs','x',1], deleteBenchBranch: ['Usernode-Labs','x','bench/a'],
    },
    'hosted-git': {
      createRepo: ['apps','x'], pushFiles: ['apps','x',[]], createRootCommit: ['apps','x',[]], createBranch: ['apps','x','b'],
      ensureBranchAtSha: ['apps','x','b','a'.repeat(40)], advanceBranchToSha: ['apps','x','b','a'.repeat(40)],
      forceBranchToSha: ['apps','x','b','a'.repeat(40)], revertOnto: ['apps','x','a'.repeat(40),{}],
      deleteBenchBranch: ['apps','x','bench/a'], createProposalCommit: ['apps','x',{}],
    },
    'git-host': {
      createRepo: ['x'], setPrivate: ['x',true], pushRefs: ['x','/tmp',[]], casUpdateRef: ['x','/tmp','b',null,'a'.repeat(40)],
      deleteRef: ['x','b'], pushInitialFiles: ['x',{}], api: ['POST','/orgs/apps/repos',{}],
      git: [['-C','/tmp','push','https://example.invalid/x.git','main']],
    },
    'native-pulls': { merge: ['apps','x',1] },
    'native-merge': { squashMerge: [{}] },
    'external-agent-head': { mirrorForkBranch: [{}], pushForkBranchToAppBranch: [{}], deleteBranch: [{}], removeBranch: [{}] },
    'external-agent-patch': { applyPatch: [{}] },
    'worker-git-push': { push: [{}] },
  };
  for (const [file, methods] of Object.entries(cases)) {
    const service = require('../src/services/' + file);
    for (const [name,args] of Object.entries(methods)) await refused(() => service[name](...args));
  }
  await refused(() => require('../src/services/git-child').invocation(['-C','/tmp','push','remote','main'], { home: '/tmp/home' }));
  await refused(() => require('../src/services/github').githubFetch('anonymous','https://example.invalid',{method:'PATCH'}));
  const read = await require('../src/services/git-host').git(['--version']);
  assert.match(read.stdout, /^git version/);
});

test('the GitHub transport refuses a new mutating call while web can still read', async (t) => {
  asRole(t, 'web');
  let wrapped;
  const client = { hook: { wrap(_name, fn) { wrapped = fn; } } };
  require('../src/services/github')._instrumentForTests(client, 'anonymous');
  let sent = 0;
  const send = async () => { sent++; return { headers: {}, status: 200 }; };
  await refused(() => wrapped(send, { method: 'POST', url: '/repos/o/r/git/refs' }));
  assert.equal(sent, 0);
  await wrapped(send, { method: 'GET', url: '/repos/o/r' });
  assert.equal(sent, 1);
});

test('workflow roles retain code-host write ownership', (t) => {
  asRole(t, 'conductor');
  assert.doesNotThrow(() => requireCodeHostWrite('test'));
  process.env.PROCESS_ROLE = 'all';
  assert.doesNotThrow(() => requireCodeHostWrite('test'));
});

test('native pull-request metadata remains a database write on web', async (t) => {
  asRole(t, 'web');
  t.mock.method(require('../src/services/repo-ref'), 'hostOfOwner', () => 'git_host');
  const pulls = require('../src/services/native-pulls');
  t.mock.method(pulls, 'update', async () => ({ title: 'Updated title' }));
  assert.deepEqual(await require('../src/services/github').updatePR('apps','demo',1,{title:'Updated title'}), { title: 'Updated title' });
});
