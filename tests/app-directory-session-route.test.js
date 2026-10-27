// Tests for the browser-session user directory (issue #1195) —
// GET /api/app-directory/users/lookup and /users/search in
// src/routes/app-directory.js.
//
// This is the surface the platform shell's `__usernode_directory` relay
// (public/js/app-view.js) fetches on behalf of the signed-in user, and
// therefore the ONLY directory path that works in a staging preview,
// where containers hold no platform token. It shares the matcher in
// src/services/user-directory.js with the app-token twin, so this file
// covers what is specific to it rather than re-testing the matcher:
//
//   • the same { id, username } allowlist reaches the wire,
//   • responses are Cache-Control: no-store (per-user, and the roster
//     changes as people register),
//   • there is NO membership parameter — unlike /api/users/search,
//     whose `excludeApp` filter would tell an app iframe who is already
//     on an app,
//   • 400 for an unusable handle stays distinct from a 200 miss.
//
// Harness shape: same as tests/apps-last-failure-route.test.js —
// override getPool before requiring the route module, mount on a real
// express app behind a stub that sets req.user (authMiddleware runs
// before this router in server.js), hit it over HTTP.
//
// Run with: node --test tests/app-directory-session-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

stub(require.resolve('../src/services/logger'), {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
});

const SENSITIVE = {
  password: '$2b$10$notarealhash',
  email: 'private@example.com',
  usernode_pubkey: 'npub-secret',
  locale: 'fr',
  is_admin: true,
};

const state = { users: [], lastSearchParams: null, failNext: false, queries: 0 };

function user(id, username) {
  return { id, username, ...SENSITIVE };
}

function unescapeLike(s) {
  return String(s).replace(/\\(.)/g, '$1');
}

const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  async query(sql, params) {
    state.queries++;
    if (state.failNext) {
      state.failNext = false;
      throw new Error('boom');
    }
    const s = String(sql);
    if (/WHERE LOWER\(username\) = LOWER/.test(s)) {
      const name = params[0];
      const rows = state.users
        .filter((u) => u.username.toLowerCase() === name.toLowerCase())
        .sort((a, b) =>
          (Number(b.username === name) - Number(a.username === name)) || (a.id - b.id))
        .slice(0, 2);
      return { rows };
    }
    if (/LIKE LOWER\(\$1\)/.test(s)) {
      state.lastSearchParams = params;
      const prefix = unescapeLike(params[0]).toLowerCase();
      const rows = state.users
        .filter((u) => u.username.toLowerCase().startsWith(prefix))
        .sort((a, b) =>
          a.username.toLowerCase().localeCompare(b.username.toLowerCase()) || (a.id - b.id))
        .slice(0, params[2]);
      return { rows };
    }
    return { rows: [], rowCount: 0 };
  },
});

const appDirectoryRoutes = require('../src/routes/app-directory');
const express = require('express');

let currentUser = { id: 100, username: 'viewer' };
let server;

test.before(async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(appDirectoryRoutes({}));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
});
test.after(() => server?.close());

async function call(path, qs = '', headers = { 'X-Usernode-App-Bridge': 'isolated-v2' }) {
  const res = await fetch(
    `http://127.0.0.1:${server.address().port}/api/app-directory/users/${path}${qs}`, { headers }
  );
  return { status: res.status, headers: res.headers, body: await res.json() };
}

test.beforeEach(() => {
  state.users = [];
  state.lastSearchParams = null;
  state.failNext = false;
  state.queries = 0;
  currentUser = { id: 100, username: 'viewer' };
});

test('lookup resolves a handle to id + username and nothing else', async () => {
  state.users = [user(42, 'alice')];
  const { status, body } = await call('lookup', '?username=alice');
  assert.equal(status, 200);
  assert.equal(body.found, true);
  assert.deepEqual(body.user, { id: 42, username: 'alice' });
  const wire = JSON.stringify(body);
  for (const value of Object.values(SENSITIVE)) {
    if (typeof value !== 'string') continue;
    assert.equal(wire.includes(value), false, `leaked ${value}`);
  }
});

test('a miss is a 200 with found:false', async () => {
  const { status, body } = await call('lookup', '?username=nobody');
  assert.equal(status, 200);
  assert.deepEqual(body, { found: false, user: null });
});

test('a case-collided pair with no exact match is flagged ambiguous', async () => {
  state.users = [user(9, 'Nova'), user(110, 'nova')];
  const { body } = await call('lookup', '?username=NOVA');
  assert.equal(body.user.id, 9);
  assert.equal(body.ambiguous, true);
});

test('an unusable handle is a 400, distinct from a miss', async () => {
  for (const qs of ['', '?username=', `?username=${'x'.repeat(300)}`]) {
    const { status, body } = await call('lookup', qs);
    assert.equal(status, 400);
    assert.ok(body.error);
  }
});

test('search is a prefix typeahead with has_more', async () => {
  state.users = [
    user(1, 'carla'), user(2, 'carlos'), user(3, 'carmen'), user(4, 'natalie'),
  ];
  const page = await call('search', '?q=car&limit=2');
  assert.equal(page.status, 200);
  assert.deepEqual(page.body.users.map((u) => u.username), ['carla', 'carlos']);
  assert.equal(page.body.has_more, true);

  const all = await call('search', '?q=car');
  assert.equal(all.body.users.length, 3);
  assert.equal(all.body.has_more, false);
});

test('an empty query returns nothing rather than the whole roster', async () => {
  state.users = [user(1, 'alice'), user(2, 'bob')];
  const { status, body } = await call('search', '?q=');
  assert.equal(status, 200);
  assert.deepEqual(body, { users: [], has_more: false });
});

// The reason this router exists instead of reusing /api/users/search:
// that endpoint's excludeApp filter answers "who is already on this
// app?", which nothing an app iframe can reach may expose.
test('no membership filter is honoured on the bridge surface', async () => {
  state.users = [user(1, 'alice')];
  await call('search', '?q=ali&excludeApp=some-app&excludeAppId=7');
  assert.equal(state.lastSearchParams[1], null);
});

test('responses are not cacheable by any shared cache', async () => {
  state.users = [user(1, 'alice')];
  for (const [path, qs] of [['lookup', '?username=alice'], ['search', '?q=ali']]) {
    const { headers } = await call(path, qs);
    const cc = headers.get('cache-control');
    assert.match(cc, /no-store/);
    assert.match(cc, /private/);
  }
});

test('a database failure is a 500 that leaks no detail', async () => {
  state.failNext = true;
  const { status, body } = await call('lookup', '?username=alice');
  assert.equal(status, 500);
  assert.deepEqual(body, { error: 'Internal server error' });
});

test('legacy or unknown parent protocols cannot read either production directory route', async () => {
  state.users = [user(42, 'private-person@example.invalid')];
  for (const [route, query] of [['lookup','?username=private-person%40example.invalid'],['search','?q=private']]) {
    for (const headers of [{}, {'X-Usernode-Directory-Bridge':'old'}, {'X-Usernode-Directory-Bridge':'platform-isolated-v1, old'}]) {
      const response = await call(route,query,headers);
      assert.equal(response.status,403);
      assert.equal(response.body.code,'bridge_refresh_required');
      assert.match(response.headers.get('cache-control'),/no-store/);
      assert.equal(JSON.stringify(response.body).includes('private-person'),false);
    }
  }
  assert.equal(state.queries,0,'old parent requests never hydrate production directory rows');
});

test('the actual guarded parent relay works against the protocol fence and blocks platform previews', async () => {
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
  const source=fs.readFileSync(path.join(__dirname,'../public/js/app-view.js'),'utf8');
  state.users=[user(42,'private-person@example.invalid')];
  for(const slug of ['usernode-2d5619','authored-control']) {
    for(const type of ['lookup','search']) {
      const replies=[],frame={postMessage:value=>replies.push(value)};
      const before=state.queries;
      const origin=`https://${slug}--s77.apps.example`;
      const element={src:origin+'/',contentWindow:frame};
      const sandbox={URL,URLSearchParams,console,setTimeout,clearTimeout,setInterval,clearInterval,
        location:{href:'https://platform.invalid/'},addEventListener(){},localStorage:{getItem:()=>null,setItem(){}},
        document:{getElementById:id=>id==='staging-iframe'?element:null,addEventListener(){}},
        fetch:(url,options)=>fetch(`http://127.0.0.1:${server.address().port}${url}`,options)};
      sandbox.window=sandbox;
      vm.createContext(sandbox);
      const AppView=vm.runInContext(source+'\nAppView;',sandbox);
      AppView._stagingPreview={slug};
      await AppView.handleDirectoryBridgeMessage({source:frame,origin,
        data:{id:'protocol-control',__usernode_directory:type,username:'private-person@example.invalid',q:'private'}});
      const reply=replies.find(r=>r.__usernode_directory==='response');
      assert.ok(reply);assert.equal(reply.error,null);
      if(slug==='usernode-2d5619') {
        assert.equal(state.queries,before);
        assert.equal(JSON.stringify(reply).includes('private-person'),false);
      } else {
        assert.equal(state.queries,before+1);
        const users=type==='lookup'?[reply.value.user]:reply.value.users;
        assert.deepEqual(JSON.parse(JSON.stringify(users)),[{id:42,username:'private-person@example.invalid'}]);
      }
    }
  }
});
