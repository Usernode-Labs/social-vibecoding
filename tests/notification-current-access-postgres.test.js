'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
test('notification reads require current resource access', { timeout: 30000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500 });
    try {
        await admin.query('SELECT 1');
    }
    catch (e) {
        await admin.end();
        if (process.env.TEST_DATABASE_URL)
            throw e;
        t.skip('PostgreSQL unavailable');
        return;
    }
    const db = 'notification_reads_' + crypto.randomBytes(5).toString('hex');
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(DSN);
    url.pathname = '/' + db;
    const pool = new Pool({ connectionString: String(url), max: 8 });
    const pm = require('../src/db/pool'), prev = pm.getPool;
    pm.getPool = () => pool;
    let server;
    t.after(async () => { if (server) {
        server.closeAllConnections();
        await new Promise(r => server.close(r));
    } pm.getPool = prev; await pool.end(); await admin.query(`DROP DATABASE ${db}`); await admin.end(); });
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
    const config = { databaseUrl: String(url), dataEncryptionKey: 'synthetic-notification-key', mobilePushEnabled: false };
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(require('../src/middleware/auth').authMiddleware(config));
    app.use(require('../src/routes/notifications').notificationsRoutes(config));
    server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    const notifications = require('../src/services/notifications');
    let n = 0;
    const person = async (isAdmin = false) => { const { rows: [u] } = await pool.query("INSERT INTO users(username,password,has_platform_access,is_admin) VALUES($1,'synthetic',TRUE,$2) RETURNING id", ['notice_reader_' + (++n), isAdmin]); u.token = crypto.randomBytes(32).toString('hex'); await pool.query("INSERT INTO sessions(token,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '1 day')", [u.token, u.id]); return u; };
    const fixture = async ({ member = true, publicApp = false } = {}) => { const recipient = await person(), author = await person(); const { rows: [a] } = await pool.query("INSERT INTO apps(name,slug,created_by,view_visibility,collab_visibility) VALUES($1,$1,$2,$3,'private') RETURNING id", ['notice-app-' + (++n), author.id, publicApp ? 'public' : 'private']); if (member)
        await pool.query("INSERT INTO app_collaborators(app_id,user_id,status) VALUES($1,$2,'member')", [a.id, recipient.id]); const { rows: [s] } = await pool.query("INSERT INTO chat_sessions(app_id,user_id,pr_title) VALUES($1,$2,'PERMITTED_FIXTURE_TITLE') RETURNING id", [a.id, author.id]); const { rows: [notice] } = await pool.query("INSERT INTO notifications(user_id,app_id,session_id,kind) VALUES($1,$2,$3,'session_done') RETURNING id", [recipient.id, a.id, s.id]); return { recipient, author, a, s, notice }; };
    const get = async (who, path) => { const r = await fetch(base + path, { headers: { cookie: 'session=' + who.token } }); return { status: r.status, body: await r.json() }; };
    await t.test('only the notification recipient can resolve its id', async () => { const f = await fixture(); assert.equal((await get(f.recipient, '/api/notifications/' + f.notice.id)).status, 200); assert.equal((await get(f.author, '/api/notifications/' + f.notice.id)).status, 404); });
    await t.test('a public project notification remains readable without membership', async () => { const f = await fixture({ member: false, publicApp: true }); assert.equal((await get(f.recipient, '/api/notifications/' + f.notice.id)).status, 200); });
    await t.test('removed private-project access cannot hydrate newly changed content through an old notification', async () => {
        const f = await fixture();
        await pool.query('INSERT INTO notification_bookmarks(notification_id,user_id) VALUES($1,$2)', [f.notice.id, f.recipient.id]);
        assert.equal((await get(f.recipient, '/api/notifications/' + f.notice.id)).status, 200);
        await pool.query('DELETE FROM app_collaborators WHERE app_id=$1 AND user_id=$2', [f.a.id, f.recipient.id]);
        await pool.query("UPDATE chat_sessions SET pr_title='FORBIDDEN_EDIT_AFTER_REMOVAL' WHERE id=$1", [f.s.id]);
        const exact = await get(f.recipient, '/api/notifications/' + f.notice.id);
        assert.equal(exact.status, 404, 'an old notification cannot disclose the current private proposal');
        const feed = await get(f.recipient, '/api/notifications');
        assert.equal(feed.status, 200);
        assert.ok(!JSON.stringify(feed.body).includes('FORBIDDEN_EDIT_AFTER_REMOVAL'));
        assert.ok(!feed.body.notifications.some(x => x.id === f.notice.id));
        assert.equal(await notifications.countUnread(pool, f.recipient.id), 0);
        assert.deepEqual(await notifications.listSavedForUser(pool, f.recipient.id), []);
    });
    await t.test('private visibility, user blocks and suspension all apply to old notifications', async () => {
        for (const reason of ['private', 'blocked', 'suspended']) {
            const f = await fixture({ member: false, publicApp: true });
            assert.equal((await get(f.recipient, '/api/notifications/' + f.notice.id)).status, 200);
            if (reason === 'private')
                await pool.query("UPDATE apps SET view_visibility='private' WHERE id=$1", [f.a.id]);
            if (reason === 'blocked')
                await pool.query('INSERT INTO user_app_blocks(user_id,app_id) VALUES($1,$2)', [f.recipient.id, f.a.id]);
            if (reason === 'suspended')
                await pool.query('UPDATE apps SET moderation_suspended_at=NOW() WHERE id=$1', [f.a.id]);
            assert.equal((await get(f.recipient, '/api/notifications/' + f.notice.id)).status, 404, reason);
            assert.equal(await notifications.countUnread(pool, f.recipient.id), 0, reason);
        }
    });
    await t.test('a current admin can read a private-project notification, but demotion removes that exception', async () => {
        const f = await fixture({ member: false });
        await pool.query('UPDATE users SET is_admin=TRUE WHERE id=$1', [f.recipient.id]);
        assert.equal((await get(f.recipient, '/api/notifications/' + f.notice.id)).status, 200);
        await pool.query('UPDATE users SET is_admin=FALSE WHERE id=$1', [f.recipient.id]);
        assert.equal((await get(f.recipient, '/api/notifications/' + f.notice.id)).status, 404);
    });
    await t.test('pending project invitations may reveal only their authorized metadata', async () => {
        for (const kind of ['collab_invite', 'approver_invite']) {
            const f = await fixture({ member: false });
            const table = kind === 'collab_invite' ? 'app_collaborators' : 'app_approvers';
            await pool.query(`INSERT INTO ${table}(app_id,user_id,status) VALUES($1,$2,'invited')`, [f.a.id, f.recipient.id]);
            const { rows: [invite] } = await pool.query('INSERT INTO notifications(user_id,app_id,kind) VALUES($1,$2,$3) RETURNING id', [f.recipient.id, f.a.id, kind]);
            assert.equal((await get(f.recipient, '/api/notifications/' + invite.id)).status, 200, kind);
            await pool.query('UPDATE notifications SET session_id=$2 WHERE id=$1', [invite.id, f.s.id]);
            assert.equal((await get(f.recipient, '/api/notifications/' + invite.id)).status, 404, 'an invitation cannot smuggle a private proposal reference');
            await pool.query('UPDATE notifications SET session_id=NULL WHERE id=$1', [invite.id]);
            await pool.query(`DELETE FROM ${table} WHERE app_id=$1 AND user_id=$2`, [f.a.id, f.recipient.id]);
            assert.equal((await get(f.recipient, '/api/notifications/' + invite.id)).status, 404, 'a removed invitation grants no current access');
        }
    });
    await t.test('platform admin alerts disappear on demotion/read-only access while ordinary personal rows remain', async () => {
        const u = await person(true);
        const { rows: [notice] } = await pool.query("INSERT INTO notifications(user_id,kind) VALUES($1,'platform_incident') RETURNING id", [u.id]);
        assert.equal((await get(u, '/api/notifications/' + notice.id)).status, 200);
        await pool.query('UPDATE users SET admin_readonly=TRUE WHERE id=$1', [u.id]);
        assert.equal((await get(u, '/api/notifications/' + notice.id)).status, 404);
        await pool.query('UPDATE users SET is_admin=FALSE,admin_readonly=FALSE WHERE id=$1', [u.id]);
        assert.equal((await get(u, '/api/notifications/' + notice.id)).status, 404);
        assert.equal(await notifications.countUnread(pool, u.id), 0);
        const { rows: [personal] } = await pool.query("INSERT INTO notifications(user_id,kind) VALUES($1,'low_credits') RETURNING id", [u.id]);
        assert.equal((await get(u, '/api/notifications/' + personal.id)).status, 200);
    });
});
