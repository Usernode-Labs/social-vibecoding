// #7215: a Homeroom report filed from another project's page is about that
// project. The bot reads the project's real records first (its repository
// host, the requests that closed around the report and when their changes
// merged), and when the problem has already gone it answers instead of
// building.
//
// Run with: node --test tests/homeroom-bot-about-project.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const aboutProject = require('../src/services/homeroom-bot-about-project');

// A hosted repository address parses only against the configured git host.
const PRIOR_GIT_HOST = process.env.GIT_HOST_URL;
test.before(() => { process.env.GIT_HOST_URL = 'https://git.homeroom.test'; });
test.after(() => {
  if (PRIOR_GIT_HOST === undefined) delete process.env.GIT_HOST_URL;
  else process.env.GIT_HOST_URL = PRIOR_GIT_HOST;
});

const PLATFORM = { id: 1, slug: 'usernode-2d5619', name: 'Homeroom' };
const ABOUT = {
  id: 412, slug: 'secret-project', name: 'Secret Project',
  repo_url: 'https://git.homeroom.test/acme/secret-project',
  created_by: 1, self_hosted: false,
  collab_visibility: 'private', view_visibility: 'private', moderation_suspended_at: null,
};
const REPORTED_AT = '2026-11-26T17:00:00.000Z';
const CLOSED_AT = '2026-11-26T16:59:53.000Z';
const MERGED_AT = '2026-11-26T16:59:40.000Z';

function fakePool({ about = ABOUT, report = true, canSee = true, refs = true } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      const s = String(sql);
      queries.push({ s, params });
      if (/FROM feedback_reports/.test(s)) {
        return { rows: report ? [{ about_app_id: ABOUT.id, user_id: 7, created_at: REPORTED_AT }] : [] };
      }
      if (/FROM apps WHERE id = \$1/.test(s)) return { rows: about ? [about] : [] };
      if (/FROM users WHERE id = \$1/.test(s)) return { rows: [{ id: 7, is_admin: false }] };
      if (/FROM user_app_blocks/.test(s)) return { rows: [] };
      if (/FROM app_collaborators/.test(s)) return { rows: canSee ? [{ '?column?': 1 }] : [] };
      if (/FROM chat_sessions cs/.test(s)) {
        return {
          rows: refs ? [{
            id: 90, status: 'merged', user_id: 7, shared_at: null, promoted_at: '2026-11-26T16:59:00.000Z',
            pr_number: 7213, pr_url: 'https://example.test/change/7213', linked_issues: [500],
            created_from_issue_number: null, last_activity_at: '2026-11-26T16:59:40.000Z',
            created_at: '2026-11-26T15:00:00.000Z', title: 'Hide done requests',
          }] : [],
        };
      }
      if (/FROM chat_sessions WHERE id = ANY/.test(s)) return { rows: [{ id: 90, merged_at: MERGED_AT }] };
      return { rows: [] };
    },
  };
}

const github = {
  async fetchClosedIssues() {
    return {
      issues: [
        { number: 500, title: 'A request still shows after its change is done', closedAt: CLOSED_AT, state: 'closed' },
        // Outside the window: ten minutes before the report is the edge, this is older.
        { number: 499, title: 'An older one', closedAt: '2026-11-26T16:40:00.000Z', state: 'closed' },
      ],
      truncatedList: false,
    };
  },
};

test('the about project\'s repository host and request state are read', async () => {
  const pool = fakePool();
  const about = await aboutProject.readAboutProject(pool, {
    app: PLATFORM, issueNumber: 7215, deps: { github, platformSlug: PLATFORM.slug },
  });
  assert.equal(about.host, 'homeroom', 'its repository is on Homeroom\'s own git host');
  assert.equal(about.private, true);
  assert.equal(about.reportedAt, REPORTED_AT);
  assert.equal(about.closedNear.length, 1, 'only the request inside the window');
  const closed = about.closedNear[0];
  assert.deepEqual(
    { number: closed.number, how: closed.how, mergedAt: closed.mergedAt, secondsBeforeReport: closed.secondsBeforeReport },
    { number: 500, how: 'merged', mergedAt: MERGED_AT, secondsBeforeReport: 7 },
  );
  assert.equal(closed.closedAt, CLOSED_AT);
});

test('the triage prompt carries the project\'s facts and the resolved-state rule', () => {
  const about = {
    appId: 412, private: true, host: 'homeroom', reportedAt: REPORTED_AT, readFully: true,
    closedNear: [{
      number: 500, title: 'A request still shows after its change is done',
      closedAt: CLOSED_AT, how: 'merged', mergedAt: MERGED_AT, secondsBeforeReport: 7,
    }],
  };
  const prompt = bot.triagePromptFor({ seed: 'SEED', issueNumber: 7215, aboutProject: about });
  assert.match(prompt, /PROJECT THIS REPORT IS ABOUT: a private project \(app id 412\)/);
  assert.doesNotMatch(prompt, /Secret Project/, 'a private project is never named');
  assert.match(prompt, /repository is on Homeroom's own git host/);
  assert.match(prompt, /request #500 "A request still shows after its change is done" closed 7 seconds before the report/);
  assert.match(prompt, new RegExp(`its change merged at ${MERGED_AT.replace(/[.]/g, '\\.')}`));
  assert.match(prompt, /no longer true/);
  assert.match(prompt, /go_ahead/);
});

test('a report on any other project, or one the reporter cannot see, adds nothing', async () => {
  const elsewhere = await aboutProject.readAboutProject(fakePool(), {
    app: { id: 9, slug: 'another-project' }, issueNumber: 12, deps: { github, platformSlug: PLATFORM.slug },
  });
  assert.equal(elsewhere, null, 'a project\'s own board already knows which project it is about');

  const hidden = await aboutProject.readAboutProject(fakePool({ canSee: false }), {
    app: PLATFORM, issueNumber: 7215, deps: { github, platformSlug: PLATFORM.slug },
  });
  assert.equal(hidden, null, 'a project the reporter cannot see is never described');

  const noReport = await aboutProject.readAboutProject(fakePool({ report: false }), {
    app: PLATFORM, issueNumber: 7215, deps: { github, platformSlug: PLATFORM.slug },
  });
  assert.equal(noReport, null);
});

test('a report whose problem has already gone gets a reply and no build', async (t) => {
  const real = { post: live.post, advanceSeen: live.advanceSeen, mentionTargets: live.mentionTargets };
  t.after(() => Object.assign(live, real));
  const posts = [];
  live.post = async (args) => { posts.push(args); return {}; };
  live.advanceSeen = async () => ({ advanced: false });
  live.mentionTargets = async () => [];

  const pool = fakePool();
  const acted = await bot.actOnVerdict({
    pool, config: {}, bot: { id: 77, username: 'homeroom_bot' },
    app: PLATFORM, repo: { owner: 'Usernode-Labs', repo: 'social-vibecoding' },
    issueNumber: 7215, issue: { title: 'Done changes still show in Requests' },
    parsed: {
      verdict: 'person', goAhead: false, blocker: 'explanation', goAheadDecides: false,
      reason: 'That request closed by itself 13 seconds before you sent this, as its change merged. I have built nothing.',
    },
    capSuppressed: null, runId: 900, seed: 's', seedReadAt: REPORTED_AT, postedAt: [],
    turnBudgetMs: 1000, model: 'stage/triage',
    deps: {
      github: { getBotUsername: async () => 'usernode-bot', async fetchIssueComments() { return { comments: [] }; } },
      ws: {}, threadContext: { async loadIssueThread() { return { messages: [] }; } },
      limits: { async recordSpend() {}, async checkBudget() { return {}; } },
      managedOpenRouter: { async usesIncludedKey() { return false; } }, domain: 'x',
    },
  });

  assert.equal(acted, 'person', 'it answers the request');
  assert.equal(posts.length, 1, 'one reply');
  assert.equal(posts[0].kind, 'person');
  assert.match(posts[0].homeroomText || posts[0].text, /closed by itself 13 seconds before you sent this/);
  assert.ok(!pool.queries.some((q) => /INSERT INTO chat_sessions/.test(q.s)), 'nothing was built');
});
