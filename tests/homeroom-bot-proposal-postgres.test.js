'use strict';

// #3518, executed against the FULL PostgreSQL schema: what the Homeroom bot
// writes onto its build session before it proposes (live.prepareProposal),
// read back by the real pr-metadata the promote route runs, in a throwaway
// database built from src/db/schema.sql as a boot applies it. Only GitHub is
// stubbed. The route's own call is reproduced as it makes it
// (routes/votes.js: the session row, its last user message, `ccSummary: ''`
// and `preferredTitle: session.proposed_pr_title`), and the last test pins
// that call so the two cannot drift apart.
//
// Before: "Build issue 3233: Quota notifications are cryptic codes Edit the
// app…", and no summary. The completion row goes through the real
// history trigger (trg_pr_summary_history), which must not count it as a new
// request, and the real gatherSessionContext query, which must read it.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const live = require('../src/services/homeroom-bot-live');
const github = require('../src/services/github');
const prMetadata = require('../src/services/pr-metadata');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const SPEC = [
  '# Show quota changes as a plain sentence',
  '',
  '## User-facing changes',
  '',
  'When your app allowance changes, the notification says so in a sentence, such as "Your app allowance changed from 0 to 2."',
  '',
  '### Assumptions',
  '- The old wording stays for a change it cannot read.',
  '',
  '## Technical implementation',
  '',
  'Edit the app_quota_changed row in `notifications.js`.',
].join('\n');
const DESCRIPTION = 'Allowance notifications now read as a sentence, for example "Your app allowance changed from 0 to 2", instead of a code.';

test('a bot proposal is named by its spec and led by its own description', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_proposal_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  const realCreate = github.createPR;
  const created = [];
  github.createPR = async (_owner, _repo, opts) => {
    created.push(opts);
    return { number: 800 + created.length, html_url: `https://github.com/usernode-bot/todo/pull/${800 + created.length}` };
  };
  t.after(async () => {
    github.createPR = realCreate;
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const bot = (await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`,
  )).rows[0];
  const app = (await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Todo', 'todo', 'running', 'https://github.com/usernode-bot/todo')
     RETURNING id, slug`,
  )).rows[0];

  // The session buildAndPropose opens, its seed, and (when it wrote one) the
  // spec as persistScoutPublication stores it.
  let issue = 3232;
  async function buildSession({ spec }) {
    issue += 1;
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless,
                                  created_from_issue_number, linked_issues, issue_link_seeded,
                                  session_title, agent_backend, agent_provider, agent_model)
       VALUES ($1, $2, $3, 'paused', FALSE, $4, ARRAY[$4::int], TRUE, $5,
               'codex_openrouter', 'openrouter', 'z-ai/glm-5.3-flash')
       RETURNING id`,
      [app.id, bot.id, `dev/homeroom_bot-${issue}`, issue, `Homeroom bot: #${issue} Quota notifications are cryptic codes`],
    );
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content) VALUES ($1, 'user', $2)`,
      [s.id, `Build issue #${issue}: Quota notifications are cryptic codes\n\n`
        + 'Edit the app_quota_changed row so it reads as a sentence. Keep the fallback line.'],
    );
    if (spec) {
      await pool.query('UPDATE chat_sessions SET spec_md = $1 WHERE id = $2', [spec, s.id]);
      await pool.query('INSERT INTO chat_session_specs (session_id, version, content) VALUES ($1, 1, $2)', [s.id, spec]);
    }
    return s.id;
  }

  // What POST /api/sessions/:id/promote does with it, down to applyPrMetadata.
  async function promote(sessionId) {
    const { rows: [session] } = await pool.query(
      `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
        WHERE cs.id = $1 AND cs.user_id = $2 AND cs.status IN ('active', 'paused')`,
      [sessionId, bot.id],
    );
    const { rows: msgRows } = await pool.query(
      `SELECT content FROM chat_session_messages
       WHERE session_id = $1 AND role = 'user'
       ORDER BY id DESC LIMIT 1`,
      [sessionId],
    );
    await prMetadata.applyPrMetadata({
      pool, session, repoOwner: 'usernode-bot', repoName: 'todo',
      userMessage: msgRows[0]?.content || '',
      ccSummary: '',
      username: bot.username,
      apiKey: null,
      userId: bot.id,
      allowModelGeneration: false,
      preferredTitle: session.proposed_pr_title || null,
    });
    return (await pool.query(
      `SELECT pr_number, pr_title, session_title, pr_title_fallback, pr_summary_md, pr_summary_source,
              pr_summary_stale, pr_summary_input_version, pr_body, proposed_pr_title
         FROM chat_sessions WHERE id = $1`,
      [sessionId],
    )).rows[0];
  }

  await t.test('the spec names it and the build\'s own block leads it', async () => {
    const id = await buildSession({ spec: SPEC });
    const before = (await pool.query('SELECT pr_summary_input_version FROM chat_sessions WHERE id = $1', [id])).rows[0];
    const prepared = await live.prepareProposal({
      pool, bot, sessionId: id, spec: SPEC, model: 'z-ai/glm-5.3-flash',
      buildText: `Built it.\n\n**What changed**\n- notifications.js\n\n==== DESCRIPTION ====\n${DESCRIPTION}\n==== END DESCRIPTION ====`,
    });
    assert.deepEqual(prepared, { title: 'Show quota changes as a plain sentence', description: DESCRIPTION });
    const after = (await pool.query('SELECT pr_summary_input_version FROM chat_sessions WHERE id = $1', [id])).rows[0];
    assert.equal(Number(after.pr_summary_input_version), Number(before.pr_summary_input_version),
      'a completion row is not a new request: the history trigger leaves the summary inputs alone');

    const row = await promote(id);
    const pr = created.at(-1);
    assert.equal(pr.title, 'Show quota changes as a plain sentence', 'what the change does');
    assert.doesNotMatch(pr.title, /Build issue|#?\d{4}/);
    assert.equal(row.pr_title, 'Show quota changes as a plain sentence');
    assert.equal(row.session_title, row.pr_title, 'the session is named after its proposal');
    assert.equal(row.pr_title_fallback, false);
    assert.equal(row.pr_summary_md, DESCRIPTION, 'the summary the group reads first');
    assert.equal(row.pr_summary_source, 'generated');
    assert.equal(row.pr_summary_stale, false);
    assert.ok(pr.body.startsWith(`${DESCRIPTION}\n\n`), 'the pull request leads with it');
    assert.match(pr.body, new RegExp(`^Closes #${issue}$`, 'm'), 'and still closes its issue');
  });

  await t.test('a build that left its block out is described by the spec\'s user-facing half', async () => {
    const id = await buildSession({ spec: SPEC });
    await live.prepareProposal({ pool, bot, sessionId: id, spec: SPEC, buildText: 'Built it. Changed notifications.js.' });
    const row = await promote(id);
    assert.equal(row.pr_title, 'Show quota changes as a plain sentence');
    assert.equal(row.pr_summary_md,
      'When your app allowance changes, the notification says so in a sentence, such as "Your app allowance changed from 0 to 2."',
      'the plain-English half, without its assumptions');
  });

  await t.test('with no spec the proposal is named after its issue, whole, not the seed', async () => {
    const id = await buildSession({ spec: null });
    await live.prepareProposal({ pool, bot, sessionId: id, spec: null, buildText: '' });
    const row = await promote(id);
    assert.equal(row.proposed_pr_title, null, 'nothing chosen: the route names it');
    assert.equal(row.pr_title, 'Quota notifications are cryptic codes');
    assert.equal(row.pr_summary_md, null, 'nothing was said, so nothing is invented');
  });

  await t.test('a title somebody already chose is kept', async () => {
    const id = await buildSession({ spec: SPEC });
    await pool.query('UPDATE chat_sessions SET proposed_pr_title = $1 WHERE id = $2', ['A name a person gave it', id]);
    await live.prepareProposal({ pool, bot, sessionId: id, spec: SPEC, buildText: '' });
    const row = await promote(id);
    assert.equal(row.pr_title, 'A name a person gave it');
  });

  await t.test('the reproduction above is the call the promote route makes', () => {
    const votes = fs.readFileSync(path.join(__dirname, '..', 'src/routes/votes.js'), 'utf8');
    const call = votes.slice(votes.indexOf('prResult = await prMetadata.applyPrMetadata({'));
    assert.match(call.slice(0, 900), /userMessage: msgRows\[0\]\?\.content \|\| '',\n\s+ccSummary: '',/);
    assert.match(call.slice(0, 900), /preferredTitle: session\.proposed_pr_title \|\| null,/);
    assert.match(votes, /`SELECT content FROM chat_session_messages\n\s+WHERE session_id = \$1 AND role = 'user'\n\s+ORDER BY id DESC LIMIT 1`/);
  });
});
