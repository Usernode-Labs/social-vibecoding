'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Client, Pool } = require('pg');
const bcrypt = require('bcrypt');
const express = require('express');
const email = require('../src/services/account-email');
const mail = require('../src/services/mail');

test('account email linking: ownership, expiry, retry limits and atomic replacement', async (t) => {
  const dsn = process.env.TEST_DATABASE_URL;
  if (!dsn) return t.skip('Set TEST_DATABASE_URL to run the Postgres verification tests.');
  const admin = new Client({ connectionString: dsn });
  await admin.connect();
  const schema = `account_email_test_${process.pid}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: dsn, options: `-c search_path=${schema}` });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await pool.query(`CREATE TABLE users (
    id SERIAL PRIMARY KEY, email TEXT, email_confirmed BOOLEAN DEFAULT FALSE,
    email_confirmed_at TIMESTAMPTZ, password TEXT NOT NULL,
    password_set BOOLEAN DEFAULT TRUE, is_admin BOOLEAN DEFAULT FALSE,
    password_reset_token_hash TEXT, password_reset_expires_at TIMESTAMPTZ
  ); CREATE UNIQUE INDEX users_email_lower_unique ON users(lower(email)) WHERE email IS NOT NULL;`);
  const ddl = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(ddl.slice(ddl.indexOf('-- #1841: private, user-bound')));
  const passwordHash = await bcrypt.hash('current-password', 4);
  const originalSend = mail.send;
  const sent = [];
  mail.send = async (_config, message) => { sent.push(message); };
  t.after(() => { mail.send = originalSend; });
  async function fresh(extra = '') {
    await pool.query('TRUNCATE users CASCADE');
    sent.length = 0;
    await pool.query(`INSERT INTO users (id,email,password) VALUES (1,'old@example.com',$1),(2,'taken@example.com',$1)`, [passwordHash]);
    if (extra) await pool.query(extra);
  }
  const request = (address = 'new@example.com', password = 'current-password', id = 1) => email.requestCode(pool, {}, id, address, password);
  const verify = (code = sent.at(-1).code, id = 1) => email.verifyCode(pool, id, code);
  const user = async () => (await pool.query('SELECT * FROM users WHERE id=1')).rows[0];
  const age = () => pool.query("UPDATE account_email_verifications SET created_at = NOW() - INTERVAL '61 seconds'");

  await t.test('requires current password and rejects invalid or already owned addresses', async () => {
    await fresh();
    await assert.rejects(request('bad-address'), { status: 400 });
    await assert.rejects(request('new@example.com', 'wrong'), { status: 401 });
    await assert.rejects(request('TAKEN@example.com'), { status: 409 });
    assert.equal(sent.length, 0);
  });
  await t.test('only attaches after mailbox proof; normalizes email and consumes code once', async () => {
    await fresh("UPDATE users SET password_reset_token_hash='old-reset' WHERE id=1");
    await request(' New@Example.com ');
    assert.equal((await user()).email, 'old@example.com');
    assert.equal(sent[0].kind, 'account_email');
    const code = sent[0].code;
    const row = (await pool.query('SELECT * FROM account_email_verifications')).rows[0];
    assert.notEqual(row.code_hash, code);
    await assert.rejects(verify(code, 2), { status: 400 });
    const result = await verify(code);
    assert.equal(result.email, 'new@example.com');
    const saved = await user();
    assert.equal(saved.email_confirmed, true);
    assert.ok(saved.email_confirmed_at);
    assert.equal(saved.password_reset_token_hash, null);
    assert.equal(saved.password, passwordHash);
    await assert.rejects(verify(code), { status: 400 });
  });
  await t.test('wrong attempts persist and stop even the right code after five guesses', async () => {
    await fresh(); await request();
    const wrong = sent[0].code === '000000' ? '000001' : '000000';
    for (let i=0;i<5;i++) await assert.rejects(verify(wrong), { status: 400 });
    assert.equal((await pool.query('SELECT attempts FROM account_email_verifications')).rows[0].attempts, 5);
    await assert.rejects(verify(), { status: 400 });
    assert.equal((await user()).email, 'old@example.com');
  });
  await t.test('expired or credential-stale challenges cannot change an account', async () => {
    for (const mutation of [
      "UPDATE account_email_verifications SET expires_at=NOW() - INTERVAL '1 second'",
      "UPDATE users SET password='new-hash' WHERE id=1",
      "UPDATE users SET email='changed@example.com' WHERE id=1",
    ]) {
      await fresh(); await request(); await pool.query(mutation);
      await assert.rejects(verify(), { status: 400 });
    }
  });
  await t.test('double requests preserve the mailed code; later resends replace it', async () => {
    await fresh(); await request(); const first = sent[0].code;
    await assert.rejects(request(), { status: 429 });
    assert.equal(sent.length, 1);
    await age(); await request();
    assert.equal(sent.length, 2);
    if (first !== sent[1].code) await assert.rejects(verify(first), { status: 400 });
    await verify();
  });
  await t.test('concurrent submissions consume one proof, and address collisions never merge users', async () => {
    await fresh(); await request();
    const results = await Promise.allSettled([verify(), verify()]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length, 1);
    await fresh(); await request();
    await pool.query("UPDATE users SET email='new@example.com' WHERE id=2");
    await assert.rejects(verify(), { status: 409 });
    assert.equal((await user()).email, 'old@example.com');
    assert.equal((await pool.query('SELECT count(*) FROM users')).rows[0].count, '2');
  });
  await t.test('passwordless and admin accounts get accurate recovery capability', async () => {
    await fresh('UPDATE users SET password_set=FALSE,is_admin=TRUE WHERE id=1');
    await request('new@example.com', '');
    const result = await verify();
    assert.equal(result.recoveryAllowed, false);
    assert.equal(result.passwordRequired, false);
  });
  await t.test('HTTP routes require authentication, return private state and bind writes to caller', async () => {
    await fresh();
    const poolModule = require('../src/db/pool');
    const originalPool = poolModule.getPool;
    poolModule.getPool = () => pool;
    delete require.cache[require.resolve('../src/routes/profile')];
    const router = require('../src/routes/profile').profileRoutes({});
    poolModule.getPool = originalPool;
    const app = express();
    app.use((req,_res,next)=>{ if(req.headers['x-test-user']) req.user={id:1}; next(); });
    app.use(router);
    const server=app.listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    t.after(()=>server.close());
    const base=`http://127.0.0.1:${server.address().port}`;
    for (const path of ['', '/request', '/verify']) {
      const res=await fetch(`${base}/api/me/email${path}`, {method:path?'POST':'GET'});
      assert.equal(res.status,401);
    }
    const read=await fetch(`${base}/api/me/email`,{headers:{'x-test-user':'1'}});
    assert.equal(read.headers.get('cache-control'),'no-store');
    assert.deepEqual(await read.json(),{email:'old@example.com',verified:false,passwordRequired:true,recoveryAllowed:true});
    const requested=await fetch(`${base}/api/me/email/request`, {method:'POST',headers:{'x-test-user':'1','content-type':'application/json'},body:JSON.stringify({email:'new@example.com',currentPassword:'current-password',userId:2})});
    assert.equal(requested.status,200);
    assert.equal((await pool.query('SELECT user_id FROM account_email_verifications')).rows[0].user_id,1);
  });
});
