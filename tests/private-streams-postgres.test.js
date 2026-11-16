'use strict';
// The authority a private platform stream is checked against, on the full
// PostgreSQL schema: Workshop's ask (POST /api/apps/:slug/workshop/ask) is the
// one classified stream (services/http-stream-access.js), and each chunk it
// sends is allowed only for a live credential that may read the project now.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
test('private platform SSE uses current authority', { timeout: 30000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500 });
    try {
        await admin.query('SELECT 1');
    }
    catch (err) {
        await admin.end();
        if (process.env.TEST_DATABASE_URL)
            throw err;
        t.skip('PostgreSQL unavailable');
        return;
    }
    const name = 'private_reads_' + crypto.randomBytes(5).toString('hex');
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN);
    url.pathname = '/' + name;
    const pool = new Pool({ connectionString: String(url), max: 8 });
    t.after(async () => {
        await pool.end();
        await admin.query(`DROP DATABASE ${name}`);
        await admin.end();
    });
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
    let seq = 0;
    async function person(isAdmin = false) {
        const { rows: [u] } = await pool.query("INSERT INTO users (username,password,has_platform_access,is_admin) VALUES ($1,'synthetic',TRUE,$2) RETURNING id", ['reader_' + (++seq), isAdmin]);
        u.token = crypto.randomBytes(32).toString('hex');
        await pool.query("INSERT INTO sessions (token,user_id,expires_at) VALUES ($1,$2,NOW()+INTERVAL '1 day')", [u.token, u.id]);
        return u;
    }
    await t.test('the declared stream scope uses real current credentials and preserves public reads', async () => {
        const access = require('../src/services/http-stream-access');
        const owner = await person(), stranger = await person(), outside = await person();
        const { rows: [a] } = await pool.query("INSERT INTO apps(name,slug,created_by,view_visibility,collab_visibility) VALUES($1,$1,$2,'private','private') RETURNING id, slug", ['private-read-' + (++seq), stranger.id]);
        await pool.query("INSERT INTO app_collaborators(app_id,user_id,status) VALUES($1,$2,'member')", [a.id, owner.id]);
        const req = (who, method, path) => ({ user: { id: who.id, isAdmin: true }, cookies: { session: who.token }, method, path });
        const allowed = (r) => access.captureStreamAuthority(r, pool)();
        const ask = '/api/apps/' + a.slug + '/workshop/ask';
        assert.equal(await allowed(req(owner, 'POST', ask)), true);
        await pool.query('UPDATE users SET has_platform_access=FALSE,private_member_since=NOW() WHERE id=$1', [owner.id]);
        assert.equal(await allowed(req(owner, 'POST', ask)), true, 'an admitted private-community member keeps their platform access');
        assert.equal(await allowed(req(outside, 'POST', ask)), false, 'a cached admin flag grants no authority');
        const oldCookie = req(owner, 'POST', ask);
        oldCookie.cookies.session = outside.token;
        assert.equal(await allowed(oldCookie), false);
        access.bindStreamSession(oldCookie, owner.token);
        assert.equal(await allowed(oldCookie), true, 'use the identity minted for this request, as a staging switch does');
        await pool.query("UPDATE apps SET view_visibility='public' WHERE id=$1", [a.id]);
        assert.equal(await allowed(req(outside, 'POST', ask)), true, 'public workshop reads do not require joining');
        await pool.query("DELETE FROM sessions WHERE token=$1", [outside.token]);
        assert.equal(await allowed(req(outside, 'POST', ask)), false, 'a signed-out cookie reads nothing, public or not');
    });
});
