'use strict';
// test:changed: when src/db/schema.sql (a fresh preview's own boot)
//
// SEC-06: a platform preview of this code can boot from an EMPTY database.
// Its own seeds make the platform's row at production's app id (the id its
// sign-in tokens are bound to), the screenshot personas at their fixed ids
// with their roles and the platform community, and keep every seeded user
// off the production ids a reviewer signs in with. The platform reads
// src/db/preview-boot.json to know this code can.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { Client } = require('pg');
const { PREVIEW_PERSONA_IDS } = require('../src/services/preview-personas');

test('the marker says this code boots a platform preview from an empty database', () => {
  const marker = require('../src/db/preview-boot.json');
  assert.equal(marker.startsEmpty, 1);
});

test('a platform preview boots from an empty database', {
  skip: !process.env.TEST_DATABASE_URL, timeout: 180000,
}, async (t) => {
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  await admin.connect();
  const name = `empty_boot_${crypto.randomBytes(5).toString('hex')}`;
  t.after(async () => { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); });
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const [member, viewer] = [PREVIEW_PERSONA_IDS.get('usernode-capture'), PREVIEW_PERSONA_IDS.get('usernode-capture-admin')];
  // Many seeders catch errors, so assert the resulting state, not just the exit status.
  const bootstrap = `
    const assert=require('node:assert/strict');
    (async()=>{
      const config=require('./src/config').load();
      await require('./src/db/migrate').migrate(config);
      const pool=require('./src/db/pool').getPool(config);
      const scalar=async (sql,params)=>Object.values((await pool.query(sql,params)).rows[0])[0];
      assert.equal(await scalar("SELECT id FROM apps WHERE slug='usernode-2d5619' AND self_hosted"),10,'production app id');
      const persona=async name=>(await pool.query('SELECT id,is_admin,admin_readonly,has_platform_access FROM users WHERE username=$1',[name])).rows[0];
      assert.deepEqual(await persona('usernode-capture'),{id:${member},is_admin:false,admin_readonly:false,has_platform_access:true});
      assert.deepEqual(await persona('usernode-capture-admin'),{id:${viewer},is_admin:true,admin_readonly:true,has_platform_access:true});
      for (const id of [${member},${viewer}]) {
        assert.equal(await scalar("SELECT count(*)::int FROM community_members WHERE user_id=$1 AND community_id=(SELECT community_id FROM apps WHERE slug='usernode-2d5619')",[id]),1,String(id));
      }
      assert.equal(await scalar("SELECT count(*)::int FROM users WHERE id < 900000"),0,'no seeded user on a production id');
      const {rows:[next]}=await pool.query("INSERT INTO apps (name,slug,status) VALUES ('After','after-the-platform','running') RETURNING id");
      assert.ok(next.id>10,'the apps sequence moved past the platform');
      assert.ok(await scalar("SELECT count(*)::int FROM chat_sessions")>0,'the staging fixtures were seeded');
      await pool.end();console.log('EMPTY_BOOT_VERIFIED');
    })().catch(error=>{console.error(error);process.exitCode=1;});`;
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', bootstrap], {
    cwd: path.resolve(__dirname, '..'), timeout: 90000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, DATABASE_URL: url.href, DB_ADMIN_URL: '', STAGING_DB_ADMIN_URL: '', USERNODE_ENV: 'staging', USERNODE_APP_ID: '10',
      USERNODE_PLATFORM_ORIGIN: '', ADMIN_USERNAME: 'preview-bootstrap-admin', ADMIN_PASSWORD: 'fixture-only-password',
      SESSION_SECRET: 'fixture-only-session-secret', MAX_APPS: '0' },
  });
  assert.match(stdout, /EMPTY_BOOT_VERIFIED/);
});
