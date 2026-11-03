'use strict';
// test:changed: when public/js/app-view.js (production-directory relay)
// test:changed: when src/services/db-manager.js (policy epoch)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../src/services/platform-preview-data-policy');
const kube = require('../src/services/kubernetes');
const retirement = require('../src/services/platform-preview-retirement');
const docker = require('../src/services/docker');
const config = { appRuntime: 'kubernetes', kubernetes: { appNamespace: 'apps' } };
const labels = { 'app.kubernetes.io/managed-by': kube.MANAGED_BY, 'social.usernode.io/app-id': '10', 'social.usernode.io/environment': 'staging' };
const current = { ...labels, [policy.LABEL]: policy.DIGEST };
const meta = (name, tags = labels) => ({ name, uid: `${name}-uid`, resourceVersion: '1', labels: tags });
const controller = (name, tags = labels, podTags = tags) => ({ metadata: meta(name,tags), spec: { template: { metadata: { labels: podTags } } } });
const pool = { query: async () => ({ rows: [{ id: 10 }] }) };
test.afterEach(() => kube._setClientsForTest(null));

function cluster({ pending = false, orphan = false, failInventory = false } = {}) {
  const runtimeName = 'sv-preview-10-s1';
  const tags = { ...labels, 'social.usernode.io/runtime-name': runtimeName };
  const store = {
    deployments: [controller(runtimeName,current)],
    sets: [controller('old-rs',tags)],
    pods: [{ metadata: meta('old-pod',tags) }],
    service: { metadata: meta(runtimeName), spec: { selector: { 'social.usernode.io/runtime-name': runtimeName } } },
  };
  const calls=[];
  kube._setClientsForTest({
    core: {
      readNamespacedService: async () => structuredClone(store.service),
      replaceNamespacedService: async ({body}) => { calls.push('restrict-service');store.service=body; },
      listNamespacedPod: async () => ({items:structuredClone(store.pods)}),
      // Intentionally no list-Service or delete-Pod: deployed runtime RBAC
      // grants neither, and does not grant delete-ReplicaSet either.
    },
    apps: {
      listNamespacedDeployment: async () => {
        if (failInventory) throw new Error('API unavailable');
        return {items:structuredClone(store.deployments)};
      },
      listNamespacedReplicaSet: async () => ({items:structuredClone(store.sets)}),
      deleteNamespacedDeployment: async request => {
        calls.push('delete-deployment');
        assert.equal(request.body.propagationPolicy,'Foreground');
        assert.deepEqual(request.body.preconditions,{uid:`${runtimeName}-uid`,resourceVersion:'1'});
        if (!pending) { store.deployments=[]; if(!orphan){store.sets=[];store.pods=[];} }
      },
    },
  });
  return {store,calls};
}

test('a current desired template cannot attest old actual Pods; restrict endpoints then retire the whole runtime', async () => {
  const c=cluster();
  // A deadline a busy test run can meet: the fake cluster retires at once,
  // but 10 ms ran out on the checks' own run with thousands of tests beside it.
  const result=await kube.retirePlatformPreviewPolicy(config,10,policy.DIGEST,{timeoutMs:5000,pollMs:0});
  assert.equal(result.retired,1);
  assert.deepEqual(c.calls,['restrict-service','delete-deployment']);
  assert.equal(c.store.service.spec.selector[policy.LABEL],policy.DIGEST);
  assert.equal(c.store.pods.length,0);
});

test('accepted deletion, an orphan controller, and failed inventory never count as completed retirement', async () => {
  for (const options of [{pending:true},{orphan:true},{failInventory:true}]) {
    cluster(options);
    await assert.rejects(kube.retirePlatformPreviewPolicy(config,10,policy.DIGEST,{timeoutMs:0,pollMs:0}));
  }
});

test('busy, promoted, checking and unlinked states cannot bypass security retirement', async () => {
  const c=cluster();
  let queries=0;
  const result=await retirement.retire(config,{query:async(sql)=>{
    queries++;assert.equal(sql,'SELECT id FROM apps WHERE slug = $1 AND self_hosted IS TRUE');
    return {rows:[{id:10}]};
  }});
  assert.equal(result.retired,1);assert.equal(queries,1);assert.equal(c.store.pods.length,0);
});

test('retirement refuses an unresolved platform identity instead of skipping inventory', async () => {
  const c=cluster();
  for (const rows of [[], [{id:10},{id:20}]]) {
    await assert.rejects(retirement.retire(config,{query:async()=>({rows})}),
      /Cannot resolve canonical platform/);
  }
  assert.deepEqual(c.calls,[], 'no runtime may be changed without a verified platform identity');
});

const dockerConfig = { appRuntime: 'docker', edgeJwtSecret: 'synthetic-production-only-receipt-key' };
const fixtureUrl = 'postgres://fixture:synthetic-password@preview.test/sanitized';
function receiptLabels(name, url = fixtureUrl, appId = 10, policyTag = policy.DIGEST) {
  return { [policy.APP_ID_LABEL]: String(appId), [policy.LABEL]: policyTag,
    [policy.RECEIPT_LABEL]: policy.runtimeReceipt(dockerConfig, { appId, runtimeName: name, policyTag, databaseUrl: url }) };
}
function dockerFixture(t, entries, { survives = false } = {}) {
  const original=Object.fromEntries(['execFileAsync','inspectContainer','stopAndRemove'].map(k=>[k,docker[k]]));
  t.after(()=>Object.assign(docker,original));
  const states=new Map(entries.map((state,index)=>[(index+1).toString(16).padStart(12,'0'),state]));
  const removed=[];
  docker.execFileAsync=async(_cmd,args)=>{
    if(args[0]==='ps') return {stdout:[...states].map(([id,state])=>`${id}\t${state.name}`).join('\n')};
    assert.deepEqual(args.slice(0,3),['inspect','--format','{{json .Name}}\t{{json .Config.Env}}']);
    const state=states.get(args.at(-1));
    if(state.inspectError) throw new Error(`private Docker detail ${fixtureUrl}`);
    return {stdout:JSON.stringify('/'+(state.actualName||state.name))+'\t'+JSON.stringify(state.env||[`DATABASE_URL=${fixtureUrl}`])};
  };
  docker.inspectContainer=async id=>states.has(id)?{status:'running',labels:states.get(id).labels||{}}:{status:'not_found'};
  docker.stopAndRemove=async id=>{removed.push(states.get(id).name);if(!survives)states.delete(id);};
  return {states,removed};
}

test('Docker image labels cannot forge policy or app scope, or replay receipts against another database/name', async t => {
  const ordinary = n => `usernode-staging-${policy.PLATFORM_SLUG}--${n}`;
  const shots = side => `usernode-shots-0123456789abcdef-${side}`;
  const c=dockerFixture(t,[
    {name:ordinary(1)},
    {name:shots('base'),labels:{'social.usernode.io/shots-run':'0'.repeat(32)}},
    // An old platform image can forge an authored-app label and policy epoch.
    {name:shots('head'),labels:{[policy.APP_ID_LABEL]:'20',[policy.LABEL]:'authored'}},
    {name:ordinary(2),labels:{[policy.LABEL]:policy.DIGEST}},
    {name:`usernode-app-${policy.PLATFORM_SLUG}`},
    {name:ordinary(3),labels:receiptLabels(ordinary(3))},
    {name:'usernode-evidence-1123456789abcdef-base',labels:receiptLabels('usernode-evidence-1123456789abcdef-base',fixtureUrl,20,'authored')},
    {name:ordinary(4),labels:receiptLabels(ordinary(4)),env:['DATABASE_URL=postgres://fixture:old-password@production.test/private']},
    {name:ordinary(5),labels:receiptLabels(ordinary(3))},
    {name:ordinary(6),labels:receiptLabels(ordinary(6)),env:[`DATABASE_URL=${fixtureUrl}`,`DATABASE_URL=${fixtureUrl}`]},
    {name:ordinary(7),labels:receiptLabels(ordinary(7)),actualName:ordinary(8)},
    {name:ordinary(9),labels:receiptLabels(ordinary(9)),inspectError:true},
    {name:ordinary(10),labels:receiptLabels(ordinary(10)),env:['NO_DATABASE_URL=true']},
    {name:ordinary(11),labels:receiptLabels(ordinary(11)),env:[null]},
    {name:'usernode-evidence-2123456789abcdef-head',labels:receiptLabels('usernode-evidence-2123456789abcdef-head')},
  ]);
  await retirement.retire(dockerConfig,pool);
  assert.deepEqual(c.removed,[ordinary(1),shots('base'),shots('head'),ordinary(2),ordinary(4),ordinary(5),ordinary(6),ordinary(7),ordinary(9),ordinary(10),ordinary(11)]);
  assert.equal(c.states.size,4,'production and both authenticated preview scopes survive');
});

test('a failed Docker removal cannot pass the startup barrier', async t => {
  dockerFixture(t,[{name:`usernode-staging-${policy.PLATFORM_SLUG}--1`}],{survives:true});
  await assert.rejects(retirement.retire(dockerConfig,pool),/survived/);
});

test('Docker deploy overwrites image-controlled scope and signs the injected connection, for platform and authored shots', async t => {
  const original=Object.fromEntries(['runContainer','waitForHealthy','stopAndRemove'].map(k=>[k,docker[k]]));
  t.after(()=>Object.assign(docker,original));
  const runs=[];
  docker.runContainer=async(name,input)=>{runs.push({name,...input});return 'container-id';};
  docker.waitForHealthy=async()=>{};
  docker.stopAndRemove=async()=>{};
  for(const [app,name] of [
    [{id:10,slug:policy.PLATFORM_SLUG},`usernode-staging-${policy.PLATFORM_SLUG}--1`],
    [{id:10,slug:policy.PLATFORM_SLUG},'usernode-shots-1010101010101010-base'],
    [{id:20,slug:'authored-app'},'usernode-shots-2020202020202020-base'],
  ]) {
    const policyTag=app.id===10?policy.DIGEST:'authored';
    await require('../src/services/application-runtime').deploy(dockerConfig,{
      app,environment:'staging',runtimeName:name,internalOnly:true,imageRef:'candidate-image',
      env:{DATABASE_URL:fixtureUrl},labels:{[policy.LABEL]:policy.DIGEST,[policy.APP_ID_LABEL]:'999',[policy.RECEIPT_LABEL]:'forged'},
    });
    const actual=runs.at(-1).labels;
    assert.equal(actual[policy.APP_ID_LABEL],String(app.id));
    assert.equal(actual[policy.LABEL],policyTag);
    assert.equal(policy.verifyRuntimeReceipt(dockerConfig,{appId:app.id,runtimeName:name,policyTag,databaseUrl:fixtureUrl},actual[policy.RECEIPT_LABEL]),true);
    assert.equal(JSON.stringify(actual).includes('synthetic-password'),false);
    assert.equal(JSON.stringify(runs.at(-1).env).includes(dockerConfig.edgeJwtSecret),false);
  }
  assert.equal(runs.length,3);
});

test('receipt verification rejects key rotation, app-scope changes, and preview-known signing keys', () => {
  const inputs={appId:10,runtimeName:`usernode-staging-${policy.PLATFORM_SLUG}--1`,policyTag:policy.DIGEST,databaseUrl:fixtureUrl};
  const proof=policy.runtimeReceipt(dockerConfig,inputs);
  assert.equal(policy.verifyRuntimeReceipt({...dockerConfig,edgeJwtSecret:'rotated-production-key'},inputs,proof),false);
  assert.equal(policy.verifyRuntimeReceipt(dockerConfig,{...inputs,appId:20},proof),false);
  assert.equal(policy.verifyRuntimeReceipt(dockerConfig,{...inputs,policyTag:'authored'},proof),false);
  assert.equal(policy.verifyRuntimeReceipt(dockerConfig,inputs,'malformed'),false);
  assert.equal(policy.verifyRuntimeReceipt(dockerConfig,inputs,policy.runtimeReceipt({edgeJwtSecret:'preview-session-secret'},inputs)),false);
});

test('receipt creation refuses a missing production key rather than using preview secrets', () => {
  const before=process.env.EDGE_JWT_SECRET;
  delete process.env.EDGE_JWT_SECRET;
  try {
    const inputs={appId:10,runtimeName:'preview',policyTag:policy.DIGEST,databaseUrl:fixtureUrl};
    assert.throws(()=>policy.runtimeReceipt({sessionSecret:'preview-known',jwtSecret:'preview-known'},inputs),{noFallback:true});
    assert.equal(policy.verifyRuntimeReceipt({sessionSecret:'preview-known'},inputs,'a'.repeat(40)),false);
  } finally {
    if(before===undefined)delete process.env.EDGE_JWT_SECRET;else process.env.EDGE_JWT_SECRET=before;
  }
});

test('platform deployment refuses a clone without current policy attestation', async () => {
  await assert.rejects(require('../src/services/application-runtime').deploy(config,{
    app:{id:10,slug:policy.PLATFORM_SLUG},environment:'staging',labels:{},
  }),{noFallback:true});
});

test('synthetic preview identity preserves only exact capture names, at their fixed ids, and resets other claims', () => {
  assert.deepEqual(policy.previewIdentity({id:21,username:'private-handle',usernode_pubkey:'private-wallet',locale:'es'}),
    {id:21,username:'preview-user-21',usernode_pubkey:null,locale:null});
  assert.deepEqual(policy.previewIdentity({id:22,username:'usernode-capture'}),
    {id:2147482996,username:'usernode-capture',usernode_pubkey:null,locale:null});
  assert.equal(policy.previewIdentity({id:23,username:'usernode-capture-admin'}).id,2147482997);
  assert.deepEqual(policy.previewIdentity({id:24,username:'usernode-capture-lookalike'}),
    {id:24,username:'preview-user-24',usernode_pubkey:null,locale:null});
  // The shots fixtures' own ids are theirs; nothing maps onto them.
  const fixtures = require('../src/services/shots-fixtures');
  for (const id of policy.PREVIEW_PERSONA_IDS.values()) {
    assert.ok(![fixtures.FULL_ADMIN_USER_ID, fixtures.INVITED_MEMBER_USER_ID, fixtures.INVITED_MEMBER_LISTED_USER_ID].includes(id));
  }
});

test('a persona token for a platform preview carries the persona\'s fixed id; anywhere else its own', () => {
  require('./platform-keys').setPlatformKeys();
  const platformJwt = require('../src/services/platform-jwt');
  const visuals = require('../src/services/visuals');
  const claims = (token, appId) => platformJwt.verifyAppIdentityToken(token, { appId, allowPreview: true });
  const member = { id: 22, username: 'usernode-capture' };
  assert.equal(claims(visuals.mintCaptureToken(member, 10, { previewOnly: true }), 10).id, 2147482996);
  assert.equal(claims(visuals.mintCaptureToken(member, 11), 11).id, 22);
  const fixture = { id: 2147483000, username: 'usernode-shots-full-admin' };
  assert.equal(claims(visuals.mintCaptureToken(fixture, 10, { previewOnly: true }), 10).id, 2147483000);
});

test('platform preview cannot use the parent cookie directory relay, including Messages and stale context', async () => {
  const source=fs.readFileSync(path.join(__dirname,'../public/js/app-view.js'),'utf8');
  for (const context of [
    {preview:{slug:policy.PLATFORM_SLUG},origin:'http://localhost:8888',blocked:true},
    {preview:null,origin:'https://usernode-2d5619--s123.apps.example.test',blocked:true},
    {preview:{slug:'another-app'},origin:'https://another-app--s123.apps.example.test',blocked:false},
  ]) {
    const responses=[], frame={postMessage:(x)=>responses.push(x)};
    const element={src:context.origin+'/',contentWindow:frame};
    let fetched=0;
    const sandbox={URL,URLSearchParams,console,setTimeout,clearTimeout,setInterval,clearInterval,
      location:{href:'https://platform.invalid/'},addEventListener(){},
      localStorage:{getItem:()=>null,setItem(){}},
      document:{getElementById:id=>id==='staging-iframe'?element:null,addEventListener(){}},
      fetch:async(_url,options)=>{assert.equal(options.headers['X-Usernode-App-Bridge'],'isolated-v2');fetched++;return{ok:true,json:async()=>({users:[{id:99,username:'production-secret-handle'}]})};}};
    sandbox.window=sandbox;
    vm.createContext(sandbox);
    const AppView=vm.runInContext(source+'\nAppView;',sandbox);
    AppView._stagingPreview=context.preview;
    AppView.appData={slug:'unrelated-open-app'};
    await AppView.handleDirectoryBridgeMessage({source:frame,origin:context.origin,data:{id:'probe',__usernode_directory:'search',q:'a'}});
    assert.equal(fetched,context.blocked?0:1);
    if(context.blocked) assert.equal(JSON.stringify(responses).includes('production-secret-handle'),false);
  }
});

test('code that cannot start a platform preview empty is refused before any database is made', () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-boot-'));
  try {
    assert.equal(policy.startsEmpty(dir), false, 'no marker');
    fs.mkdirSync(path.join(dir, 'src', 'db'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'db', 'preview-boot.json'), '{"startsEmpty":0}');
    assert.equal(policy.startsEmpty(dir), false, 'not this support');
    fs.writeFileSync(path.join(dir, 'src', 'db', 'preview-boot.json'), 'not json');
    assert.equal(policy.startsEmpty(dir), false, 'unreadable');
    fs.writeFileSync(path.join(dir, 'src', 'db', 'preview-boot.json'), '{"startsEmpty":1}');
    assert.equal(policy.startsEmpty(dir), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(policy.startsEmpty(path.join(__dirname, '..')), true, 'this code can');
  // Both builders ask before they make a database.
  const staging = fs.readFileSync(path.join(__dirname, '../src/services/staging.js'), 'utf8');
  const refuse = staging.indexOf('previewPolicy.sourceIdentity(prodDbName) && !await commitStartsEmpty(cloneDir)');
  assert.ok(refuse > 0 && refuse < staging.indexOf('dbManager.cloneDatabase(prodDbName'), 'the preview build refuses before it clones');
  const shots = fs.readFileSync(path.join(__dirname, '../src/services/shots-environment.js'), 'utf8');
  const both = shots.indexOf('[baseCheckout, headCheckout].every((checkout) => previewPolicy.startsEmpty(checkout.dir))');
  assert.ok(both > 0 && both < shots.indexOf('dbManager.prepareStagingCloneSource('), 'shots refuse before preparing a source');
  assert.match(shots, /'shots_preview_needs_update', previewPolicy\.NEEDS_UPDATE/);
});

// On Kubernetes the preview build's clone carries only the root's files
// (staging.js rootOnly: --filter=blob:none --sparse), so the marker under
// src/db is never on disk there: the build reads it from the commit
// (3 Nov 2026: read from disk, it refused every platform preview).
test('a preview build reads the marker from the commit, which a root-only clone has', async () => {
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const staging = require('../src/services/staging');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-boot-git-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe' });
  const origin = path.join(root, 'origin');
  const cloneAs = (name) => {
    const dir = path.join(root, name);
    git('clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', `file://${origin}`, dir);
    return dir;
  };
  try {
    fs.mkdirSync(path.join(origin, 'src', 'db'), { recursive: true });
    git('-C', origin, 'init', '-q');
    git('-C', origin, 'config', 'uploadpack.allowFilter', 'true');
    fs.writeFileSync(path.join(origin, 'dapp.json'), '{}');
    fs.writeFileSync(path.join(origin, 'src', 'db', 'preview-boot.json'), '{"startsEmpty":1}');
    git('-C', origin, 'add', '-A');
    git('-C', origin, 'commit', '-qm', 'can start empty');
    const marked = cloneAs('marked');
    assert.equal(fs.existsSync(path.join(marked, 'dapp.json')), true, 'root files are there');
    assert.equal(fs.existsSync(path.join(marked, 'src', 'db', 'preview-boot.json')), false, 'src/ is not, as on Kubernetes');
    assert.equal(policy.startsEmpty(marked), false, 'so the working tree cannot tell');
    assert.equal(await staging.commitStartsEmpty(marked), true, 'the commit can');
    fs.writeFileSync(path.join(origin, 'src', 'db', 'preview-boot.json'), '{"startsEmpty":0}');
    git('-C', origin, 'commit', '-qam', 'not this support');
    assert.equal(await staging.commitStartsEmpty(cloneAs('unsupported')), false);
    git('-C', origin, 'rm', '-q', 'src/db/preview-boot.json');
    git('-C', origin, 'commit', '-qm', 'from before');
    assert.equal(await staging.commitStartsEmpty(cloneAs('before')), false, 'no marker');
    assert.equal(await staging.commitStartsEmpty(path.join(root, 'nowhere')), false, 'git cannot say: refused');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
