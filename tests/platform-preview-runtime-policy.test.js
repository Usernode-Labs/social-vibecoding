'use strict';
// test:changed: when public/js/app-view.js (production-directory relay)
// test:changed: when src/services/platform-preview-data-policy.json (policy epoch)
// test:changed: when src/services/platform-preview-schema.json (schema epoch)
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
  const result=await kube.retirePlatformPreviewPolicy(config,10,policy.DIGEST,{timeoutMs:10,pollMs:0});
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

test('synthetic preview identity preserves only exact capture names and resets other claims', () => {
  assert.deepEqual(policy.previewIdentity({id:21,username:'private-handle',usernode_pubkey:'private-wallet',locale:'es'}),
    {id:21,username:'preview-user-21',usernode_pubkey:null,locale:null});
  assert.equal(policy.previewIdentity({id:22,username:'usernode-capture'}).username,'usernode-capture');
  assert.equal(policy.previewIdentity({id:24,username:'usernode-capture-lookalike'}).username,'preview-user-24');
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
