'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SOURCE = fs.readFileSync(path.join(__dirname, '../public/js/app-view.js'), 'utf8');

function harness() {
  const requests = [], sent = [];
  const urls = {
    'app-iframe': 'https://mounted-app.apps.invalid/',
    'staging-iframe': 'https://preview-app--s12--fixture.apps.invalid/',
    'app-viewer-frame': 'https://viewer-app.apps.invalid/',
  };
  const frames = Object.fromEntries(Object.entries(urls).map(([id, src]) => [id, {
    src, contentWindow: { postMessage(value, target) { sent.push({ id, value, target }); } },
    getAttribute(name) { return name === 'allow' ? '' : this[name]; },
  }]));
  const context = {
    URL, URLSearchParams, ArrayBuffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
    location: { href: 'https://platform.invalid/', origin: 'https://platform.invalid' },
    addEventListener() {}, localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: id => frames[id] || null, addEventListener() {} },
    PlatformI18n: { t: key => key },
    App: { user: { id: 7 } },
  };
  context.window = context;
  context.fetch = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200, json: async () => ({
      marker: 'PRIVATE_RESPONSE', grant: { status: 'active', dailyCapCents: 91, allowByok: true },
      declared: [], effective: [],
    }) };
  };
  vm.createContext(context);
  vm.runInContext(SOURCE + '\nglobalThis.AppView = AppView;', context);
  const view = context.AppView;
  view.appData = { slug: 'unrelated-private-project' };
  view._appFrameDom._slug = 'mounted-app';
  view._stagingPreview = { slug: 'preview-app', sessionId: 12, self_hosted: false };
  view._viewerApp = { frame: frames['app-viewer-frame'], slug: 'viewer-app' };
  const event = (family, frameId = 'app-iframe', type) => ({
    source: frames[frameId].contentWindow, origin: new URL(frames[frameId].src).origin,
    data: { id: 'fixture', ['__usernode_' + family]: type || {
      storage: 'get-usage', llm: 'get-access', permission: 'get-all', directory: 'search',
    }[family], q: 'fixture', fileId: 'a'.repeat(32) },
  });
  const call = e => view[{
    storage: 'handleStorageBridgeMessage', llm: 'handleLlmBridgeMessage',
    permission: 'handlePermissionBridgeMessage', directory: 'handleDirectoryBridgeMessage',
  }[Object.keys(e.data).find(k => k.startsWith('__usernode_')).slice(11)]](e);
  return { context, view, frames, requests, sent, event, call };
}
const families = ['storage', 'llm', 'permission', 'directory'];
const tick = () => new Promise(setImmediate);

for (const family of families) {
  test(`${family}: a foreign origin in an owned window gets no privileged request or response`, async () => {
    const h = harness(), e = h.event(family);
    e.origin = 'https://foreign.invalid';
    await h.call(e);
    assert.equal(h.requests.length, 0);
    assert.equal(h.sent.length, 0);
  });
  test(`${family}: a response cannot follow its window into a new document`, async () => {
    const h = harness(), gate = Promise.withResolvers();
    h.context.fetch = async (url, init) => { h.requests.push({ url, init }); return gate.promise; };
    const work = h.call(h.event(family));
    await tick();
    assert.equal(h.requests.length, 1);
    h.frames['app-iframe'].src = 'https://another-app.apps.invalid/';
    h.view._appFrameDom._slug = 'another-app';
    gate.resolve({ ok: true, status: 200, json: async () => ({ marker: 'PRIVATE_OLD_DOCUMENT', grant: { status: 'active' } }) });
    await work;
    assert.ok(h.sent.length > 0, 'the original document got its acknowledgement');
    assert.equal(h.sent.some(x => x.value['__usernode_' + family] === 'response'), false);
    assert.ok(h.sent.every(x => x.target === 'https://mounted-app.apps.invalid'));
  });
}

for (const family of ['storage', 'llm', 'permission']) {
  test(`${family}: a preview opened from Messages acts only on its own project`, async () => {
    const h = harness();
    await h.call(h.event(family, 'staging-iframe'));
    assert.equal(h.requests.length, 1);
    assert.ok(h.requests[0].url.startsWith('/api/apps/preview-app/'));
    assert.equal(h.requests[0].init.headers['X-Usernode-App-Bridge'], 'isolated-v2');
    assert.ok(h.sent.some(x => x.value['__usernode_' + family] === 'response'));
    assert.ok(h.sent.every(x => x.target === 'https://preview-app--s12--fixture.apps.invalid'));
  });
  test(`${family}: the mounted app owns the request while another project is selected`, async () => {
    const h = harness();
    await h.call(h.event(family));
    assert.ok(h.requests[0].url.startsWith('/api/apps/mounted-app/'));
  });
}

test('preview storage deletion carries its environment and the guarded relay protocol', async () => {
  const h = harness();
  await h.call(h.event('storage', 'staging-iframe', 'delete'));
  assert.equal(h.requests[0].init.method, 'DELETE');
  assert.ok(h.requests[0].url.endsWith('?staging=1'));
  assert.equal(h.requests[0].init.headers['X-Usernode-App-Bridge'], 'isolated-v2');
});

test('the platform preview still uses its synthetic directory', async () => {
  const h = harness();
  h.view._stagingPreview = { slug: 'usernode-2d5619', sessionId: 12, self_hosted: true };
  await h.call(h.event('directory', 'staging-iframe'));
  assert.equal(h.requests.length, 0);
  const response = h.sent.find(x => x.value.__usernode_directory === 'response');
  assert.deepEqual(JSON.parse(JSON.stringify(response.value.value)), { users: [], has_more: false });
});

for (const family of ['llm', 'permission']) {
  for (const change of ['navigation', 'account change']) {
    test(`${family}: ${change} during consent cannot create a grant`, async () => {
      const h = harness(), decision = Promise.withResolvers(), shown = Promise.withResolvers();
      h.context.fetch = async (url, init) => {
        h.requests.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ grant: null,
          declared: [{ capability: 'camera' }], catalogue: [], effective: [] }) };
      };
      h.view.showLlmConsentModal = h.view.showPermissionConsentModal = () => { shown.resolve(); return decision.promise; };
      const e = h.event(family, 'app-iframe', family === 'llm' ? 'request-access' : 'request');
      e.data.capability = 'camera';
      const work = h.call(e);
      await shown.promise;
      if (change === 'navigation') {
        h.frames['app-iframe'].src = 'https://another-app.apps.invalid/';
        h.view._appFrameDom._slug = 'another-app';
      } else h.context.App.user = { id: 8 };
      decision.resolve(family === 'llm' ? { dailyCapCents: 10, allowByok: false } : true);
      await work;
      assert.equal(h.requests.some(x => x.init?.method === 'POST'), false);
    });
  }
}


for (const family of families) {
  test(`${family}: a private response is discarded after the shell account changes`, async () => {
    const h = harness(), gate = Promise.withResolvers();
    h.context.fetch = async () => gate.promise;
    const pending = h.call(h.event(family));
    await tick();
    h.context.App.user = { id: 8 };
    gate.resolve({ ok: true, status: 200, json: async () => ({ marker: 'PRIVATE_PREVIOUS_USER', grant: { status: 'active' } }) });
    await pending;
    assert.equal(h.sent.some(x => x.value['__usernode_' + family] === 'response'), false);
  });
}


test('locale reads and broadcasts stay on the intended origin and synthetic platform profile', async () => {
  const h = harness();
  h.context.App.user.locale = 'es';
  const message = frameId => ({ source: h.frames[frameId].contentWindow,
    origin: new URL(h.frames[frameId].src).origin, data: { id: 'locale', __usernode_locale: 'get' } });
  const e = message('app-iframe');
  h.view.handleLocaleBridgeMessage({ ...e, origin: 'https://foreign.invalid' });
  assert.equal(h.sent.length, 0);
  h.view.handleLocaleBridgeMessage(e);
  assert.equal(h.sent.at(-1).value.value.locale, 'es');
  assert.equal(h.sent.at(-1).target, e.origin);
  h.view._stagingPreview = { slug: 'usernode-2d5619', self_hosted: true };
  h.view.handleLocaleBridgeMessage(message('staging-iframe'));
  assert.equal(h.sent.at(-1).value.value.locale, null);
  h.view.notifyLocaleChanged('fr');
  assert.equal(h.sent.findLast(x => x.id === 'app-iframe').value.locale, 'fr');
  assert.equal(h.sent.findLast(x => x.id === 'staging-iframe').value.locale, null);
  assert.equal(h.sent.some(x => x.target === '*'), false);
});
