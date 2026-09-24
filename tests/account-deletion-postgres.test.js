'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const express = require('express');
const cookieParser = require('cookie-parser');
const deletion = require('../src/services/account-deletion');
const cleanup = require('../src/services/account-deletion-cleanup');
const conversations = require('../src/services/conversations');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('account deletion against the full PostgreSQL schema', { timeout: 120000 }, async t => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'account_deletion_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const config = { databaseUrl: String(url), jwtSecret: 'synthetic-test-only' };
  const routePool = require('../src/db/pool').getPool(config);
  t.after(async () => {
    await routePool.end();
    await pool.end();
    // pg-pool can resolve end() before every client's socket has closed.
    // A normal drop waits for those disconnects; FORCE can interrupt them
    // with an uncaught idle-client error after all assertions have passed.
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // migration is boot-idempotent, including retained FKs
  const password = 'disposable-fixture-password';
  const hash = await bcrypt.hash(password, 4);
  let seq = 0;
  async function user({ fullAdmin = false, readonly = false, passwordSet = true } = {}) {
    const { rows } = await pool.query(`INSERT INTO users (username, password, password_set, is_admin, admin_readonly, email, email_confirmed)
      VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING *`,
    [`fixture_${++seq}`, hash, passwordSet, fullAdmin || readonly, readonly, `fixture_${seq}@example.invalid`]);
    const token = crypto.randomBytes(24).toString('hex');
    await pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`, [token, rows[0].id]);
    return { ...rows[0], token };
  }
  const owner = await user({ fullAdmin: true });
  const erase = target => deletion.deleteAccount(pool, { userId: target.id, actorId: owner.id, mode: 'admin', confirmation: 'DELETE' });
  const count = async (table, column, id) => Number((await pool.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = $1`, [id])).rows[0].n);
  const app = (await pool.query(`INSERT INTO apps (name, slug, created_by) VALUES ('Synthetic app', 'deletion-fixture', $1) RETURNING *`, [owner.id])).rows[0];

  await t.test('confirmation, full-admin and recent authentication gates roll back', async () => {
    const target = await user();
    const readonly = await user({ readonly: true });
    await assert.rejects(deletion.deleteAccount(pool, { userId: target.id, actorId: owner.id, mode: 'admin' }), { code: 'confirmation_required' });
    await assert.rejects(deletion.deleteAccount(pool, { userId: target.id, actorId: readonly.id, mode: 'admin', confirmation: 'DELETE' }), { code: 'forbidden' });
    await assert.rejects(deletion.deleteAccount(pool, { userId: target.id, actorId: readonly.id, mode: 'self', confirmation: 'DELETE', password, sessionToken: readonly.token }), { code: 'forbidden' });
    await assert.rejects(deletion.deleteAccount(pool, { userId: target.id, actorId: target.id, mode: 'self', confirmation: 'DELETE', password, sessionToken: readonly.token }), { code: 'session_required' });
    await assert.rejects(deletion.deleteAccount(pool, { userId: target.id, actorId: target.id, mode: 'self', confirmation: 'DELETE', password: 'wrong', sessionToken: target.token }), { code: 'password_required' });
    const noPassword = await user({ passwordSet: false });
    await pool.query(`UPDATE sessions SET created_at = NOW() - INTERVAL '1 hour' WHERE token = $1`, [noPassword.token]);
    await assert.rejects(deletion.deleteAccount(pool, { userId: noPassword.id, actorId: noPassword.id, mode: 'self', confirmation: 'DELETE', sessionToken: noPassword.token }), { code: 'reauth_required' });
    assert.equal(await count('users', 'id', target.id), 1);
    assert.equal(await count('account_deletions', 'user_id', target.id), 0);
  });

  await t.test('populated accounts lose credentials and private data, retaining shared bytes and historical accounting', async () => {
    const target = await user();
    const peer = await user();
    const session = (await pool.query(`INSERT INTO chat_sessions(app_id,user_id,status,shared_at,transcript_shared_at)
      VALUES ($1,$2,'merged',NOW(),NOW()) RETURNING id`, [app.id, target.id])).rows[0].id;
    const privateSession = (await pool.query(`INSERT INTO chat_sessions(app_id,user_id) VALUES ($1,$2) RETURNING id`, [app.id, target.id])).rows[0].id;
    await pool.query(`INSERT INTO chat_session_messages(session_id,role,content) VALUES ($1,'user','private assistant text'),($2,'user','shared transcript')`, [privateSession, session]);
    await pool.query(`INSERT INTO pr_votes(session_id,user_id,vote) VALUES ($1,$3,'yes'),($2,$3,'yes')`, [session, privateSession, target.id]);
    await pool.query(`INSERT INTO llm_usage(user_id,total_cost_cents) VALUES ($1,12.5)`, [target.id]);
    const cred = (await pool.query(`INSERT INTO credentials.user_ai_credentials(user_id,provider,purpose,secret_enc)
      VALUES ($1,'openrouter','coding_agent','synthetic-encrypted-secret') RETURNING id`, [target.id])).rows[0].id;
    await pool.query(`INSERT INTO agent_turns(id,session_id,user_id,backend,status,credential_id,actual_cost_usd)
      VALUES ($1,$2,$3,'codex_openrouter','running',$4,0.42)`, [crypto.randomUUID(), session, target.id, cred]);
    await pool.query(`INSERT INTO credentials.managed_openrouter_keys(user_id,credential_id,remote_key_hash,remote_label,status,daily_limit_usd)
      VALUES ($1,$2,$3,'synthetic provider label','active',1)`, [target.id, cred, 'a'.repeat(64)]);
    await pool.query(`INSERT INTO mobile_auth_tokens(user_id,token_hash,ability,expires_at) VALUES ($1,$2,'session',NOW() + INTERVAL '1 day')`, [target.id, 'b'.repeat(64)]);
    await pool.query(`INSERT INTO cli_access_tokens(user_id,token_hash,token_hint,scopes,expires_at)
      VALUES ($1,$2,'svcli_…abcd',ARRAY['api:access'],NOW() + INTERVAL '30 days')`, [target.id, 'c'.repeat(64)]);
    await pool.query(`INSERT INTO mcp_tokens(user_id,token_hash,token_hint,kind,client_id,grant_id,scopes,expires_at)
      VALUES ($1,$2,'test','access','fixture','fixture',ARRAY['usernode:apps:read'],NOW() + INTERVAL '1 day')`, [target.id, 'd'.repeat(64)]);
    await pool.query(`INSERT INTO waitlist_signups(email,linked_user_id,ip,answers) VALUES ($1,$2,'192.0.2.1','{"name":"private"}')`, [target.email, target.id]);
    await pool.query(`INSERT INTO mobile_otp_codes(email,code_hash,expires_at) VALUES ($1,'synthetic',NOW() + INTERVAL '1 hour')`, [target.email]);
    await pool.query(`INSERT INTO mail_deliveries(kind,recipient,status) VALUES ('test',$1,'sent')`, [target.email]);
    await pool.query(`INSERT INTO db_exports(user_id,username,db_name,status,ip,error) VALUES ($1,$2,'fixture','failed','192.0.2.1','private error')`, [target.id, target.username]);
    const message = (await pool.query(`INSERT INTO chat_messages(app_id,user_id,content) VALUES ($1,$2,'Keep this shared message') RETURNING id`, [app.id, target.id])).rows[0].id;
    const sent = '1'.repeat(32), unsent = '2'.repeat(32);
    await pool.query(`INSERT INTO chat_message_attachments(id,app_id,message_id,user_id,kind,filename,content_type,size_bytes,data)
      VALUES ($1,$3,$4,$5,'text','shared.txt','text/plain',6,$6),($2,$3,NULL,$5,'text','draft.txt','text/plain',6,$6)`, [sent,unsent,app.id,message,target.id,Buffer.from('retain')]);
    const direct = (await pool.query(`INSERT INTO conversations(kind,created_by) VALUES ('direct',$1) RETURNING id`, [target.id])).rows[0].id;
    await pool.query(`INSERT INTO conversation_direct_pairs VALUES ($1,$2,$3)`, [direct,Math.min(target.id,peer.id),Math.max(target.id,peer.id)]);
    await pool.query(`INSERT INTO conversation_members(conversation_id,user_id,status) VALUES ($1,$2,'member'),($1,$3,'member')`, [direct,target.id,peer.id]);
    const dm = (await pool.query(`INSERT INTO conversation_messages(conversation_id,sender_id,content) VALUES ($1,$2,'Keep this direct message') RETURNING id`, [direct,target.id])).rows[0].id;
    await pool.query(`INSERT INTO conversation_message_attachments(id,conversation_id,message_id,user_id,kind,filename,content_type,size_bytes,data)
      VALUES ($1,$2,$3,$4,'text','shared.txt','text/plain',6,$5)`, ['3'.repeat(32),direct,dm,target.id,Buffer.from('retain')]);
    const result = await erase(target);
    assert.equal(await count('users','id',target.id),0);
    await assert.rejects(pool.query('INSERT INTO users(username,password) VALUES ($1,$2)',[target.username.toUpperCase(),hash]),{code:'23505'},'old mentions/admin handles cannot be claimed');
    for (const table of ['sessions','mobile_auth_tokens','cli_access_tokens','mcp_tokens','credentials.user_ai_credentials','credentials.managed_openrouter_keys']) {
      assert.equal(await count(table,'user_id',target.id),0,table);
    }
    for (const table of ['waitlist_signups','mobile_otp_codes']) assert.equal(await count(table,'email',target.email),0,table);
    assert.equal(await count('mail_deliveries','recipient',target.email),0);
    assert.equal(await count('chat_session_messages','session_id',privateSession),0);
    assert.equal(await count('chat_session_messages','session_id',session),1);
    assert.equal(await count('pr_votes','session_id',privateSession),0);
    assert.equal((await pool.query('SELECT user_id FROM pr_votes WHERE session_id=$1',[session])).rows[0].user_id,null);
    assert.equal(Number((await pool.query('SELECT SUM(total_cost_cents) AS total FROM llm_usage')).rows[0].total),12.5);
    const turn = (await pool.query('SELECT * FROM agent_turns WHERE session_id=$1',[session])).rows[0];
    assert.equal(turn.user_id,null); assert.equal(turn.credential_id,null); assert.equal(Number(turn.actual_cost_usd),0.42);
    const retained = (await pool.query('SELECT * FROM chat_message_attachments WHERE id=$1',[sent])).rows[0];
    assert.equal(retained.user_id,null); assert.equal(retained.data.toString(),'retain');
    assert.equal(await count('chat_message_attachments','id',unsent),0);
    const conversation = await conversations.getConversation(pool,{id:peer.id},direct);
    assert.equal(conversation.title,'Deleted user'); assert.equal(conversation.canSend,false);
    const history = await conversations.listMessages(pool,{id:peer.id},direct);
    assert.equal(history.messages[0].sender.username,'Deleted user');
    assert.equal(history.messages[0].content,'Keep this direct message');
    assert.equal(history.messages[0].attachments.length,1);
    assert.equal(await conversations.loadMembership(pool,direct,peer.id),null,'write membership stays closed');
    assert.equal(await conversations.getConversation(pool,{id:owner.id},direct),null,'outsider cannot read');
    assert.equal((await pool.query('SELECT username,ip,error FROM db_exports WHERE user_id IS NULL')).rows[0].username,'Deleted user');
    const receipt = (await cleanup.list(pool)).find(r=>r.id===result.deletionId);
    assert.equal(receipt.completed_at,null);
    assert.ok(receipt.tasks.some(r=>r.kind==='openrouter_key' && r.state==='pending'));
    // A retry cannot run a second deletion, mint another receipt, or remove
    // anything belonging to the next holder of an old email/username.
    assert.equal((await erase(target)).deletionId,result.deletionId);
    assert.equal(await count('account_deletions','user_id',target.id),1);
  });

  await t.test('blocked and unaccepted direct history is not reopened; group owner transfers', async () => {
    const target = await user(), peer = await user();
    const ids=[];
    for (const accepted of [false,true]) {
      const id=(await pool.query(`INSERT INTO conversations(kind,created_by) VALUES ('direct',$1) RETURNING id`,[target.id])).rows[0].id;
      // Distinct peers keep the pair unique.
      const other=accepted ? peer : await user();
      await pool.query(`INSERT INTO conversation_direct_pairs VALUES ($1,$2,$3)`,[id,target.id,other.id]);
      await pool.query(`INSERT INTO conversation_members(conversation_id,user_id,status) VALUES ($1,$2,'member'),($1,$3,$4)`,[id,target.id,other.id,accepted?'member':'invited']);
      ids.push({id,other});
    }
    await pool.query('INSERT INTO user_blocks(blocker_id,blocked_user_id) VALUES ($1,$2)',[peer.id,target.id]);
    const group=(await pool.query(`INSERT INTO conversations(kind,title,created_by) VALUES ('group','Keep group',$1) RETURNING id`,[target.id])).rows[0].id;
    await pool.query(`INSERT INTO conversation_members(conversation_id,user_id,status,role) VALUES ($1,$2,'member','owner'),($1,$3,'member','member')`,[group,target.id,peer.id]);
    await erase(target);
    for (const {id,other} of ids) assert.equal(await conversations.getConversation(pool,{id:other.id},id),null);
    assert.equal((await pool.query('SELECT role FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',[group,peer.id])).rows[0].role,'owner');
  });

  await t.test('friendships, requests, the quiet period and friend notifications go with the account (#2386)', async () => {
    const friendsSvc = require('../src/services/friends');
    const target = await user(), friend = await user(), asked = await user(), asker = await user();
    await pool.query('UPDATE users SET has_platform_access = TRUE WHERE id = ANY($1::int[])',
      [[target.id, friend.id, asked.id, asker.id]]);
    await friendsSvc.sendRequest(pool, target, friend.id);
    await friendsSvc.accept(pool, friend, target.id);
    await friendsSvc.sendRequest(pool, target, asked.id);
    await friendsSvc.sendRequest(pool, asker, target.id);
    await friendsSvc.decline(pool, target, asker.id);
    assert.equal(await count('notifications', 'source_user_id', target.id), 2, 'a friend_accept and a friend_request');
    await erase(target);
    for (const column of ['user_low_id', 'user_high_id', 'requester_id']) {
      assert.equal(await count('friendships', column, target.id), 0, column);
    }
    assert.equal(await count('friend_request_sends', 'requester_id', target.id), 0);
    assert.equal(await count('friend_request_declines', 'recipient_id', target.id), 0);
    assert.equal(await count('notifications', 'source_user_id', target.id), 0,
      'nobody is left holding a request from, or an acceptance by, a deleted account');
    for (const other of [friend, asked, asker]) {
      assert.deepEqual(await friendsSvc.listFor(pool, other.id), { friends: [], incoming: [], outgoing: [] });
    }
  });

  await t.test('last explicit app administrator must assign a successor', async () => {
    const target=await user();
    await pool.query('INSERT INTO app_admins(app_id,user_id) VALUES ($1,$2)',[app.id,target.id]);
    await assert.rejects(erase(target),{code:'app_admin_successor_required'});
    assert.equal(await count('users','id',target.id),1);
    await pool.query('INSERT INTO app_admins(app_id,user_id) VALUES ($1,$2)',[app.id,owner.id]);
    await erase(target);
  });

  await t.test('wallet-backed native credentials and their linked browser sessions are erased', async () => {
    const target = await user();
    const token = (await pool.query(`INSERT INTO mobile_auth_tokens(user_id,token_hash,ability,expires_at)
      VALUES ($1,$2,'session',NOW()+INTERVAL '1 day') RETURNING id`,[target.id,'9'.repeat(64)])).rows[0].id;
    const season = (await pool.query(`INSERT INTO seasons(name,starts_at,ends_at) VALUES ('Fixture',NOW(),NOW()+INTERVAL '1 day') RETURNING id`)).rows[0].id;
    const account = (await pool.query(`INSERT INTO onchain_accounts(amount,identity_uid,address,public_key,secret_key,tier,registration_code,season_id,user_id,is_used)
      VALUES (1,'synthetic-uid','synthetic-address','synthetic-public','synthetic-secret','fixture','synthetic-code',$1,$2,TRUE) RETURNING id`,[season,target.id])).rows[0].id;
    const suffix = 'a'.repeat(43), incarnation='nsw_'+suffix, attempt='nsa_'+suffix, installation='nsi_'+suffix, credential='nsc_'+suffix;
    await pool.query('INSERT INTO native_session_web_incarnations(id,user_id) VALUES ($1,$2)',[incarnation,target.id]);
    await pool.query(`INSERT INTO native_session_attempts(attempt_id,user_id,web_session_incarnation_id,desired_runtime,network_id,chain_id,request_digest,state)
      VALUES ($1,$2,$3,'running','testnet','utc1qqq',$4,'exchanged')`,[attempt,target.id,incarnation,'1'.repeat(64)]);
    await pool.query(`INSERT INTO native_installation_key_generations(installation_id,key_generation,possession_key_id,possession_key_thumbprint,possession_public_jwk,envelope_key_id,envelope_key_thumbprint,envelope_public_jwk)
      VALUES ($1,1,$2,$3,'{}',$4,$3,'{}')`,[installation,'nskp_'+suffix,suffix,'nske_'+suffix]);
    await pool.query(`INSERT INTO native_session_credentials(credential_reference,attempt_id,user_id,web_session_incarnation_id,installation_id,installation_key_generation,mobile_auth_token_id,account_id,network_id,chain_id,exchange_request_digest,expires_at)
      VALUES ($1,$2,$3,$4,$5,1,$6,$7,'testnet','utc1qqq',$8,NOW()+INTERVAL '1 day')`,[credential,attempt,target.id,incarnation,installation,token,account,'2'.repeat(64)]);
    await pool.query('UPDATE sessions SET native_session_incarnation_id=$1,native_session_credential_reference=$2 WHERE token=$3',[incarnation,credential,target.token]);
    await erase(target);
    for (const table of ['native_session_credentials','native_session_attempts','native_session_web_incarnations','mobile_auth_tokens','sessions']) assert.equal(await count(table,'user_id',target.id),0,table);
    const retained=(await pool.query('SELECT user_id,secret_key,registration_code FROM onchain_accounts WHERE id=$1',[account])).rows[0];
    assert.equal(retained.user_id,null); assert.equal(retained.secret_key,''); assert.notEqual(retained.registration_code,'synthetic-code');
  });

  await t.test('provider failures retry durably and late provisioning is reconciled', async () => {
    const target=await user();
    await pool.query(`INSERT INTO credentials.managed_openrouter_keys(user_id,daily_limit_usd) VALUES ($1,1)`,[target.id]);
    const result=await erase(target);
    assert.ok((await cleanup.list(pool)).find(r=>r.id===result.deletionId).tasks.some(t=>t.state==='review'));
    await deletion.recordLateManagedKey(pool,target.id,'f'.repeat(64));
    await cleanup.sweep(pool,{}, {run:async()=>{throw new Error('secret must not be recorded');}});
    const failed=(await pool.query('SELECT * FROM account_deletion_tasks WHERE deletion_id=$1 AND kind=$2',[result.deletionId,'openrouter_key'])).rows[0];
    assert.equal(failed.state,'pending'); assert.equal(failed.error_code,'cleanup_failed');
    assert.equal((await cleanup.list(pool)).find(r=>r.id===result.deletionId).completed_at,null);
    await pool.query(`UPDATE account_deletion_tasks SET next_attempt_at=NOW() WHERE state='pending'`);
    const seen=[];
    await cleanup.sweep(pool,{}, {run:async task=>seen.push(task.id)});
    await cleanup.sweep(pool,{}, {run:async()=>assert.fail('completed tasks must not run twice')});
    assert.ok(seen.length>0);
    assert.ok((await cleanup.list(pool)).find(r=>r.id===result.deletionId).completed_at);
    // A late bootstrap must reopen an already completed cleanup receipt.
    const workerTask=(await pool.query("SELECT * FROM account_deletion_tasks WHERE kind='worker' LIMIT 1")).rows[0];
    await assert.rejects(cleanup.assertWorkerAllowed(pool,Number(workerTask.target)),/account_deleted/);
    assert.equal((await pool.query('SELECT completed_at FROM account_deletions WHERE id=$1',[workerTask.deletion_id])).rows[0].completed_at,null);
    await cleanup.sweep(pool,{}, {run:async()=>{}});
  });

  await t.test('self-service HTTP endpoint requires cookie, password and explicit confirmation', async () => {
    const target=await user();
    const app=express(); app.use(express.json(),cookieParser());
    app.use((req,res,next)=>{req.user={id:target.id};next();});
    app.use(require('../src/routes/account-deletion').accountDeletionRoutes({}, {pool}));
    const server=app.listen(0); await new Promise(resolve=>server.once('listening',resolve));
    try {
      const url=`http://127.0.0.1:${server.address().port}/api/auth/account`;
      assert.equal((await fetch(url,{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
      const headers={'Content-Type':'application/json',Cookie:`session=${target.token}`};
      assert.equal((await fetch(url,{method:'DELETE',headers,body:JSON.stringify({confirmation:'DELETE',password:'wrong'})})).status,403);
      const response=await fetch(url,{method:'DELETE',headers,body:JSON.stringify({confirmation:'DELETE',password})});
      assert.equal(response.status,200); assert.match(response.headers.get('set-cookie'),/session=;/);
      assert.equal(await count('sessions','token',target.token),0);
    } finally { await new Promise(resolve=>server.close(resolve)); }
  });

  await t.test('real cookie authentication prevents cross-account deletion and forged admin authority', async () => {
    const attacker = await user(), victim = await user();
    await pool.query('UPDATE users SET has_platform_access = TRUE WHERE id = ANY($1::int[])', [[attacker.id, victim.id]]);
    const expiredToken = crypto.randomBytes(24).toString('hex');
    await pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() - INTERVAL '1 hour')`, [expiredToken, attacker.id]);

    // Exercise the real identity lookup rather than assigning req.user in a
    // test stub: request JSON, query parameters and headers cannot name it.
    const app = express(); app.use(express.json(), cookieParser());
    app.use(require('../src/middleware/auth').authMiddleware(config));
    app.use(require('../src/routes/account-deletion').accountDeletionRoutes(config));
    app.use(require('../src/routes/admin').adminRoutes(config));
    app.use(require('../src/routes/topochain/admin/users').usersAdminRoutes(config));
    const server = app.listen(0); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { 'Content-Type': 'application/json', Cookie: `session=${attacker.token}` };
    const forged = { confirmation: 'DELETE', password, id: victim.id, userId: victim.id,
      user_id: victim.id, actorId: owner.id, mode: 'admin', isAdmin: true, canAdminWrite: true };
    try {
      for (const token of [null, 'fabricated-session', expiredToken]) {
        const response = await fetch(base + '/api/auth/account', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json', ...(token ? { Cookie: `session=${token}` } : {}) },
          body: JSON.stringify(forged),
        });
        assert.equal(response.status, 401, 'missing, forged and expired sessions have no deletion authority');
      }
      for (const [prefix, deniedStatus] of [['/api/admin/users/', 302], ['/api/v4/admin/users/', 403]]) {
        const response = await fetch(base + prefix + victim.id, {
          method: 'DELETE', headers: { ...headers, 'X-User-Id': String(owner.id), 'X-Admin': 'true' },
          body: JSON.stringify(forged), redirect: 'manual',
        });
        // The legacy admin router redirects non-admins to /; v4 returns
        // JSON 403. Neither response may reach the deletion handler.
        assert.equal(response.status, deniedStatus, 'ordinary accounts cannot use either admin deletion endpoint');
        if (deniedStatus === 302) assert.equal(response.headers.get('location'), '/');
      }
      assert.equal((await fetch(base + `/api/auth/account/${victim.id}`, {
        method: 'DELETE', headers, body: JSON.stringify(forged),
      })).status, 404, 'there is no caller-selected account deletion route');
      assert.equal((await fetch(base + '/api/auth/account', {
        method: 'DELETE', headers: { ...headers, 'Content-Type': 'text/plain' }, body: JSON.stringify(forged),
      })).status, 415, 'simple cross-origin request content types cannot delete accounts');
      assert.equal((await fetch(base + '/api/auth/account', {
        method: 'DELETE', headers, body: JSON.stringify({ ...forged, password: 'incorrect' }),
      })).status, 403, 'spoofing admin mode does not bypass the caller password');
      assert.equal((await fetch(base + '/api/auth/account', {
        method: 'DELETE', headers, body: JSON.stringify({ ...forged, confirmation: '' }),
      })).status, 400, 'spoofing admin mode does not bypass explicit confirmation');
      for (const account of [attacker, victim]) {
        assert.equal(await count('users', 'id', account.id), 1);
        assert.equal(await count('account_deletions', 'user_id', account.id), 0);
      }

      // Even with another id in every client-controlled location, a valid
      // self-delete can affect only the owner of this browser session.
      const response = await fetch(base + `/api/auth/account?userId=${victim.id}&id=${victim.id}`, {
        method: 'DELETE', headers: { ...headers, 'X-User-Id': String(victim.id) }, body: JSON.stringify(forged),
      });
      assert.equal(response.status, 200);
      assert.equal(await count('users', 'id', attacker.id), 0);
      assert.equal(await count('users', 'id', victim.id), 1);
      assert.equal(await count('sessions', 'token', victim.token), 1);
      assert.equal(await count('account_deletions', 'user_id', victim.id), 0);
      assert.equal((await fetch(base + '/api/auth/account', {
        method: 'DELETE', headers, body: JSON.stringify(forged),
      })).status, 401, 'the deleted account cannot replay its old cookie');
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  await t.test('both admin APIs use erasure, refuse self deletion and reject stale/view-only authority', async () => {
    const app = express(); app.use(express.json());
    let actor = { id: owner.id, isAdmin: true, canAdminWrite: true };
    app.use((req,res,next) => { req.user = actor; next(); });
    app.use(require('../src/routes/admin').adminRoutes(config));
    app.use(require('../src/routes/topochain/admin/users').usersAdminRoutes(config));
    const server = app.listen(0); await new Promise(resolve=>server.once('listening',resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      for (const prefix of ['/api/admin/users/', '/api/v4/admin/users/']) {
        const target = await user();
        const opts = { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({confirmation:'DELETE'}) };
        actor = { id: owner.id, isAdmin: true, canAdminWrite: false };
        assert.equal((await fetch(base+prefix+target.id,opts)).status,403);
        actor = { id: owner.id, isAdmin: true, canAdminWrite: true };
        assert.equal((await fetch(base+prefix+owner.id,opts)).status,400);
        const stale = await user({readonly:true});
        actor = { id: stale.id, isAdmin: true, canAdminWrite: true };
        assert.equal((await fetch(base+prefix+target.id,opts)).status,403,'the transaction rechecks the actual admin role');
        actor = { id: owner.id, isAdmin: true, canAdminWrite: true };
        const response = await fetch(base+prefix+target.id,opts);
        assert.equal(response.status,200,JSON.stringify(await response.json()));
        assert.equal(await count('users','id',target.id),0);
        assert.equal(await count('sessions','user_id',target.id),0);
        assert.equal(await count('account_deletions','user_id',target.id),1);
      }
    } finally {
      await new Promise(resolve=>server.close(resolve));
      // Let the route's already-started synthetic cleanup pass finish.
      await cleanup.sweep(pool,{}, {run:async()=>{}});
    }
  });

  await t.test('concurrent deletions cannot remove the last full administrator', async () => {
    await pool.query('DELETE FROM app_admins');
    await pool.query('UPDATE users SET is_admin=FALSE,admin_readonly=FALSE');
    const a=await user({fullAdmin:true,passwordSet:false}),b=await user({fullAdmin:true,passwordSet:false});
    const results=await Promise.allSettled([a,b].map(u=>deletion.deleteAccount(pool,{userId:u.id,actorId:u.id,mode:'self',confirmation:'DELETE',sessionToken:u.token})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.find(r=>r.status==='rejected').reason.code,'last_admin');
    assert.equal(Number((await pool.query('SELECT COUNT(*) AS n FROM users WHERE is_admin AND NOT admin_readonly')).rows[0].n),1);
  });
});
