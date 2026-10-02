process.env.NODE_ENV='test';
const { Pool } = require('pg');
const crypto = require('node:crypto');
const fs = require('node:fs');
const wsId = require.resolve('./src/services/ws');
require.cache[wsId] = { id: wsId, filename: wsId, loaded: true, exports: {
  pushConversationEvent() { return 1; }, pushToUser() { return 1; }, pushNotificationToUser() { return 1; },
  async handleMessage() { return { ok: true, message: { id: 1 } }; },
  async sendSystemMessage() { return { id: 1 }; }, pushIssueUpdate() {},
}};
require.cache[require.resolve('./src/services/mobile-push')] = { id: 0, filename: 'x', loaded: true, exports: { scheduleBadgeSync() { return false; } } };
(async () => {
  const admin = new Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/postgres' });
  const name = `dbgJ_${crypto.randomBytes(5).toString('hex')}`;
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const pool = new Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/' + name });
  await pool.query(fs.readFileSync('src/db/schema.sql','utf8'));
  async function user(name, synthetic=false){ const {rows:[u]} = await pool.query(`INSERT INTO users (username,password,has_platform_access,is_synthetic) VALUES ($1,'x',TRUE,$2) RETURNING id,username`,[name,synthetic]); return u; }
  const bot = await user('homeroom_bot', true);
  const ada = await user('ada');
  const {rows:[appIns]} = await pool.query(`INSERT INTO apps (name,slug,status,created_by,repo_url,view_visibility,collab_visibility) VALUES ('Seed swap','seed-swap','running',$1,'https://github.com/x/seed-swap','public','public') RETURNING id`,[ada.id]);
  const {rows:[app]} = await pool.query('SELECT * FROM apps WHERE id=$1',[appIns.id]);
  await pool.query('INSERT INTO community_members (community_id,user_id) VALUES ($1,$2)',[app.community_id,ada.id]);
  await pool.query(`INSERT INTO homeroom_bot_requesters (app_id,issue_number,user_id,issue_title) VALUES ($1,4,$2,'Dark mode')`,[app.id,ada.id]);
  const {rows:[session]} = await pool.query(`INSERT INTO chat_sessions (app_id,user_id,branch_name,status,session_title,promoted_at,linked_issues,issue_link_seeded) VALUES ($1,$2,'b','promoted','T',NOW(),'{4}',TRUE) RETURNING id`,[app.id,bot.id]);
  await pool.query(`INSERT INTO homeroom_bot_runs (app_id,issue_number,mode,verdict,proposal_session_id) VALUES ($1,4,'live','ready',$2)`,[app.id,session.id]);
  const orig = pool.query.bind(pool);
  pool.query = (text, params) => {
    const ph = (String(text).match(/\$\d+/g) || []).length;
    const n = Array.isArray(params) ? params.length : 0;
    if (ph && n && ph !== n) {
      console.error('MISMATCH', ph, n, String(text).slice(0, 300).replace(/\n/g, ' | '));
      console.error(new Error('trace').stack.split('\n').slice(2, 7).join('\n'));
      process.exit(3);
    }
    return orig(text, params);
  };
  const homeroomBot = require('./src/services/homeroom-bot');
  const settings = await homeroomBot.readSettings(pool);
  const mayor = require('./src/services/homeroom-bot-mayor');
  const ctx = { user: { ...ada, is_admin: false }, settings, deps: {}, userText: 'hi', messageId: 1, cards: [] };
  const r = await mayor.runTool(pool, ctx, 'answer_question', { proposal: session.id });
  console.log('R', JSON.stringify(r));
  process.exit(0);
})().catch(e => { console.error('TOP', e); process.exit(1); });
