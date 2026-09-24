'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { accessFlags } = require('../src/routes/apps');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const ui = loadTsx('tests/fixtures/app-report-actions-api.ts');
const app = { id:928, slug:'watchnest-0bd214', name:'WatchNest', created_by:3, view_visibility:'public', collab_visibility:'public' };

test('report eligibility excludes the owner even when an admin, anonymous viewers, demos and suspended apps', () => {
  for (const user of [{id:3}, {id:'3'}, {id:3,isAdmin:true,canAdminWrite:true}, null]) {
    assert.equal(accessFlags(app,user,false).can_report,false);
  }
  for (const user of [{id:4}, {id:4,isAdmin:true,canAdminWrite:false}]) {
    assert.equal(accessFlags(app,user,false).can_report,true);
    assert.equal(accessFlags({...app,demo:true},user,false).can_report,false);
    assert.equal(accessFlags({...app,moderation_suspended_at:new Date()},user,false).can_report,false);
  }
});

test('opening apps carries API eligibility through the controller into the rendered menu and resets it on navigation', t => {
  const previousWindow = global.window;
  const initial = {...ui.improveStore.get()};
  const prefetched = ui.Improve._prefetched;
  ui.Improve._prefetched = true;
  global.window = {Improve:ui.Improve,App:{platformUpdateState:'idle'},AppView:{readOnly:true}};
  t.after(() => {global.window=previousWindow;ui.improveStore.set(initial);ui.Improve._prefetched=prefetched;});
  const render = () => renderToHtml(createElement(ui.ImproveQuickActions));
  const open = (row, user) => {
    window.AppView.appData = {...row,...accessFlags(row,user,false)};
    ui.ImproveStatus.setAppOpen(true);
    return render();
  };
  assert.match(open(app,{id:4}),/id="improve-row-report"/,'view-only access still permits reporting');
  const owned = open(app,{id:3,isAdmin:true,canAdminWrite:true});
  assert.doesNotMatch(owned,/improve-row-report/,'owner does not see an action the server rejects');
  assert.match(owned,/improve-row-feedback/,'feedback remains available');
  assert.match(open(app,{id:4}),/improve-row-report/);
  window.AppView.appData = {slug:'not-loaded',name:'Loading'};
  ui.ImproveStatus.setAppOpen(true);
  assert.doesNotMatch(render(),/improve-row-report/,'unknown target does not inherit the preceding app permission');
});
