'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');
const express = require('express');
const blocks = require('../src/services/app-blocks');
const appAccess = require('../src/services/app-access');
const notifications = require('../src/services/notifications');
const { MobilePushWorker } = require('../src/services/mobile-push-worker');
const { appBlockRoutes } = require('../src/routes/app-blocks');
const { moderationGuard } = require('../src/middleware/moderation');
const moderation = require('../src/services/moderation');

test('personal app blocks isolate viewers, preserve contributors, suppress alerts and restore access (PostgreSQL)', async t => {
  const dsn = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const root = new Client({ connectionString: dsn, connectionTimeoutMillis: 2000 });
  try { await root.connect(); } catch (err) { await root.end().catch(() => {}); return t.skip(`Local test database unavailable: ${err.code}`); }
  const name = `app_blocks_test_${process.pid}`;
  let pool, server;
  const closed = [];
  try {
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(dsn); url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.toString() });
    pool.on('connect', client => closed.push(new Promise(resolve => client.once('end', resolve))));
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
    const addUser = async username => (await pool.query("INSERT INTO users (username,password) VALUES ($1,'unused') RETURNING id,username", [username])).rows[0];
    const alice = await addUser('alice'), bob = await addUser('bob'), collaborator = await addUser('carol');
    const addApp = async (slug, visibility='public', selfHosted=false) => (await pool.query(
      `INSERT INTO apps (slug,name,created_by,view_visibility,collab_visibility,self_hosted) VALUES ($1,$1,$2,$3,$3,$4) RETURNING *`, [slug,bob.id,visibility,selfHosted])).rows[0];
    const app = await addApp('team-app'), other = await addApp('other-app'), privateApp = await addApp('private-app','private'), platform = await addApp('platform','public',true);
    await pool.query("INSERT INTO app_collaborators (app_id,user_id,status) VALUES ($1,$2,'member'),($1,$3,'member'),($1,$4,'member')",[app.id,bob.id,collaborator.id,alice.id]);
    await pool.query('INSERT INTO app_favorites (user_id,app_id) VALUES ($1,$2)',[alice.id,app.id]);
    await pool.query("INSERT INTO chat_sessions (app_id,user_id,status) VALUES ($1,$2,'promoted')",[app.id,bob.id]);
    const savedMessage = (await pool.query("INSERT INTO chat_messages (app_id,user_id,content) VALUES ($1,$2,'Retained saved message') RETURNING id",[app.id,bob.id])).rows[0];
    const bookmarks = require('../src/services/message-bookmarks');
    await bookmarks.save(pool,alice.id,savedMessage.id);
    const discussions = () => pool.query(require('../src/routes/messages-overview').DISCUSSIONS_SQL,[alice.id,false]);
    const report = await moderation.submitReport(pool,alice,{targetType:'app',target:app.slug,reason:'spam'});
    assert.equal(report.blockAppSlug, app.slug);
    assert.equal(report.blockUserId, null);
    const duplicate = await moderation.submitReport(pool,alice,{targetType:'app',target:app.slug,reason:'spam'});
    assert.equal(duplicate.blockAppSlug, app.slug);
    assert.equal(duplicate.id, report.id);

    const web = express(); web.use(express.json());
    web.use((req,res,next) => { req.user = {alice,bob,collaborator}[req.get('x-test-user')]; next(); });
    web.use(moderationGuard({}, {pool}));
    web.use(appBlockRoutes({}, {pool}));
    const poolModule = require('../src/db/pool'), old = poolModule.getPool;
    poolModule.getPool = () => pool;
    web.use(require('../src/routes/apps').appRoutes({}));
    poolModule.getPool = old;
    server = web.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
    const request = (url, user='alice', method='GET', body) => fetch(`http://127.0.0.1:${server.address().port}${url}`,{
      method, headers:{'x-test-user':user,'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {}) });
    assert.equal((await request('/api/me/app-blocks','')).status,401);
    assert.equal((await request('/api/me/app-blocks/private-app','alice','PUT')).status,404);
    assert.equal((await request('/api/me/app-blocks/platform','alice','PUT')).status,400);
    const insertNotification = async (appId, userId=alice.id) => (await pool.query(
      "INSERT INTO notifications (user_id,app_id,kind) VALUES ($1,$2,'mention') RETURNING id",[userId,appId])).rows[0].id;
    const previousNotification = await insertNotification(app.id);
    await pool.query(`INSERT INTO mobile_push_deliveries (notification_id,environment,installation_id)
      VALUES ($1,'test','00000000-0000-0000-0000-000000000001')`,[previousNotification]);
    const block = await request('/api/me/app-blocks/team-app','alice','PUT',{user_id:bob.id});
    assert.equal(block.status,200,await block.clone().text());
    assert.equal((await pool.query('SELECT id FROM mobile_push_deliveries WHERE notification_id=$1',[previousNotification])).rowCount,0,'blocking clears already queued phone alerts');
    assert.equal(await blocks.isBlocked(pool,alice.id,app.id),true,'actor always comes from authenticated session');
    assert.equal(await blocks.isBlocked(pool,bob.id,app.id),false);
    assert.equal((await request('/api/me/app-blocks/team-app','alice','PUT')).status,200,'retry is idempotent');
    assert.equal((await pool.query('SELECT * FROM user_blocks')).rowCount,0,'creator and all contributors remain unblocked');
    assert.equal((await pool.query('SELECT * FROM app_collaborators WHERE app_id=$1',[app.id])).rowCount,3,'memberships retained');
    assert.equal((await pool.query('SELECT * FROM app_favorites WHERE user_id=$1',[alice.id])).rowCount,1,'favorites retained');
    assert.equal(await appAccess.checkAppAccess(pool,app,alice),false);
    assert.ok(!(await discussions()).rows.some(row=>row.slug===app.slug),'blocked app channel hidden');
    assert.equal((await bookmarks.listForUser(pool,alice.id)).length,0,'saved app messages hidden while blocked');
    assert.equal((await pool.query(require('../src/services/vote-digest').PENDING_SQL,['24'])).rows.some(row=>row.user_id===alice.id),false,'daily digest excludes blocked apps');
    assert.equal(await appAccess.checkAppAccess(pool,app,{...alice,isAdmin:true}),false,'personal block also applies to admin viewers');
    assert.equal(await appAccess.checkAppAccess(pool,app,bob),true);
    assert.equal(await appAccess.checkAppAccess(pool,app,collaborator),true);
    const unavailable = await request('/api/apps/team-app');
    assert.equal(unavailable.status,403); assert.equal((await unavailable.json()).code,'app_blocked');
    assert.equal((await request('/api/apps/team-app/messages','alice','POST',{content:'blocked write'})).status,403);
    const visible = await (await request('/api/apps')).json();
    assert.ok(Array.isArray(visible.apps),JSON.stringify(visible));
    assert.ok(!visible.apps.some(row => row.id===app.id),'actual app list excludes blocked app');
    assert.ok(visible.apps.some(row => row.id===other.id),'other apps remain visible');
    assert.ok((await (await request('/api/apps','bob')).json()).apps.some(row => row.id===app.id));
    assert.deepEqual((await (await request('/api/me/app-blocks','bob')).json()).apps,[],'block list is private');
    assert.equal((await (await request('/api/me/app-blocks')).json()).apps[0].slug,app.slug);

    const blockedNotification = await insertNotification(app.id);
    // A legacy/in-flight producer may already have queued a delivery. The
    // send-time query must independently reject it, not rely only on enqueue.
    const queued = (await pool.query(`INSERT INTO mobile_push_deliveries (notification_id,environment,installation_id,status)
      VALUES ($1,'test','00000000-0000-0000-0000-000000000001','sending') RETURNING id`,[blockedNotification])).rows[0];
    const loaded = await MobilePushWorker.prototype.loadDelivery.call({pool},queued);
    assert.equal(loaded.app_blocked,true);
    assert.equal(MobilePushWorker.prototype.invalidReason.call({},loaded),'app_blocked');
    const otherNotification = await insertNotification(other.id);
    const wsSource = fs.readFileSync(path.join(__dirname,'../src/services/ws.js'),'utf8');
    const liveHydration = [...wsSource.matchAll(/`(SELECT n\.id,[^`]+WHERE n\.id = ANY\(\$1::int\[\]\)[^`]+)`/g)];
    assert.equal(liveHydration.length,3,'exercise the actual reply, mention and reaction live-alert queries');
    for (const [,sql] of liveHydration) {
      const result = await pool.query(sql,[[blockedNotification,otherNotification]]);
      assert.ok(!result.rows.some(row=>row.id===blockedNotification),'live alert excludes blocked app');
      assert.ok(result.rows.some(row=>row.id===otherNotification),'unrelated live alert is retained');
    }
    const accountNotification = await insertNotification(null);
    await insertNotification(app.id,bob.id);
    const inbox = await notifications.listForUser(pool,alice.id);
    assert.ok(!inbox.some(row => row.id===blockedNotification));
    assert.ok(inbox.some(row => row.id===otherNotification));
    assert.ok(inbox.some(row => row.id===accountNotification),'moderation/account notifications stay available');
    assert.equal(await notifications.getForUser(pool,alice.id,blockedNotification),null);
    assert.ok((await notifications.listForUser(pool,bob.id)).some(row => row.app_id===app.id));
    assert.equal(MobilePushWorker.prototype.invalidReason.call({}, {app_blocked:true}),'app_blocked','queued delivery rechecks the current block');
    const wsAccess = await appAccess.getWsVisibility(pool,{appId:app.id});
    assert.ok(wsAccess.blockedUserIds.has(alice.id));
    assert.ok(!wsAccess.blockedUserIds.has(bob.id));
    assert.equal(await appAccess.isViewMember(pool,app.id,alice.id),false);

    assert.equal((await request('/api/me/app-blocks/team-app','bob','DELETE')).status,200);
    assert.equal(await blocks.isBlocked(pool,alice.id,app.id),true,'another account cannot unblock my app');
    assert.equal((await request('/api/me/app-blocks/team-app','alice','DELETE')).status,200);
    assert.equal(await appAccess.checkAppAccess(pool,app,alice),true);
    assert.ok((await discussions()).rows.some(row=>row.slug===app.slug),'app channel returns');
    assert.equal((await bookmarks.listForUser(pool,alice.id)).length,1,'saved messages return without losing bookmarks');
    assert.ok((await pool.query(require('../src/services/vote-digest').PENDING_SQL,['24'])).rows.some(row=>row.user_id===alice.id),'digest eligibility returns after unblock');
    assert.ok((await (await request('/api/apps')).json()).apps.some(row=>row.id===app.id));
    assert.ok(!(await notifications.listForUser(pool,alice.id)).some(row=>row.app_id===app.id),'suppressed alerts do not return after unblock');
    const fresh = await insertNotification(app.id);
    assert.ok((await notifications.listForUser(pool,alice.id)).some(row=>row.id===fresh));
    await blocks.setBlocked(pool,alice,app.slug,true);
    await pool.query("UPDATE apps SET view_visibility='private', collab_visibility='private', moderation_suspended_at=NOW() WHERE id=$1",[app.id]);
    assert.equal((await request('/api/me/app-blocks/team-app','alice','DELETE')).status,200,'unblock remains available if app access changes');
    assert.equal((await blocks.list(pool,alice.id)).length,0);
    assert.equal((await pool.query('SELECT id FROM moderation_reports WHERE id=$1',[report.id])).rowCount,1,'block and unblock leave the report intact');
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve));
    if(pool) await pool.end();
    await Promise.all(closed);
    await root.query(`DROP DATABASE IF EXISTS ${name}`); await root.end();
  }
});
