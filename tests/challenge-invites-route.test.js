// GET /challenges-api/me/invites (#3650) — the web session twin the
// challenge page's "Your invites" list reads. HTTP-level tests against a
// throwaway express app + a substring-dispatching mock pool, the idiom of
// tests/bp-request.test.js: what is under test here is the ROUTE (session
// gating, the envelope, the param and not-found contracts), while the
// statuses themselves are pinned against a real PostgreSQL in
// tests/challenge-invite-statuses-postgres.test.js.
//
// Run with: node --test tests/challenge-invites-route.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

const SESSIONS = {
  maker: { user_id: 1, expires_at: new Date(Date.now() + DAY) },
};

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

// The viewer's two people: one the ledger paid, one joined but unpaid.
const VIEWER = 1;
const COUNTED = 11;
const SOON = 12;

function makeMockPool() {
  async function query(rawSql, params = []) {
    const sql = collapse(rawSql);

    if (sql.includes('FROM sessions s JOIN users u')) {
      const s = SESSIONS[params[0]];
      if (!s) return { rows: [] };
      return {
        rows: [{
          user_id: s.user_id, expires_at: s.expires_at,
          username: 'maker', is_admin: false,
        }],
      };
    }

    // inviteStatuses, step 1: the rule rows (one invite challenge, id 7, and
    // one a different measure scores, id 8).
    if (sql.includes('FROM challenge_scoring_rules r')) {
      const rule = (challengeId, measure) => ({
        rule_id: 1, rule_name: 'Rule', measure,
        rule_target: 3, rule_points: 250, rule_enabled: true,
        rule_interval_minutes: 10, rule_last_scored_at: new Date(),
        challenge_id: challengeId, season_event_id: 1,
        enabled: true, completed: false,
        schedule_start: null, schedule_end: null,
        metric_target: null, reward: null,
        t_category: 'ONBOARDING', t_goal: 'Invite 3 people',
        t_schedule_start: null, t_schedule_end: null,
        t_metric_target: null, t_reward: null,
        event_starts_at: new Date(NOW - DAY), event_ends_at: new Date(NOW + DAY),
        first_challenge: true,
      });
      return { rows: [rule(7, 'INVITES_JOINED'), rule(8, 'PROPOSAL_SENT')] };
    }

    // The first-invite union FIRST: it embeds the same table names the
    // viewer's own reads name, so the narrower marker must win.
    if (sql.includes('DISTINCT ON (t.invitee_id)')) {
      return {
        rows: [
          { inviter_id: VIEWER, invitee_id: COUNTED, at: new Date(NOW - 2 * DAY) },
          { inviter_id: VIEWER, invitee_id: SOON, at: new Date(NOW - DAY) },
        ],
      };
    }

    if (sql.includes('FROM community_invite_redemptions x')) {
      return {
        rows: [
          { invitee_id: COUNTED, status: 'joined', created_at: new Date(), applied_at: new Date(), revoked_at: null, maker_holds: true },
          { invitee_id: SOON, status: 'joined', created_at: new Date(), applied_at: new Date(), revoked_at: null, maker_holds: true },
        ],
      };
    }

    if (sql.includes('FROM app_collaborators c')) return { rows: [] };

    if (sql.includes("metadata->>'source_key' LIKE 'invitee:%'")) {
      return { rows: [{ source_key: `invitee:${COUNTED}` }] };
    }

    if (sql.includes('FROM users u WHERE u.id = ANY')) {
      return {
        rows: [
          { id: COUNTED, username: 'evan', display_name: null, username_provisional_since: null, is_synthetic: false },
          { id: SOON, username: 'ocank14', display_name: null, username_provisional_since: null, is_synthetic: false },
        ],
      };
    }

    throw new Error(`Unhandled mock query: ${sql}`);
  }
  return { query };
}

function withApp(fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => makeMockPool() },
    loaded: true, id: poolModulePath, filename: poolModulePath, paths: original ? original.paths : [],
  };
  const mobileModulePath = require.resolve('../src/routes/topochain/mobile');
  delete require.cache[mobileModulePath];
  try {
    const { topochainMobileRoutes } = require('../src/routes/topochain/mobile');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(topochainMobileRoutes({ databaseUrl: 'postgres://fake/fake', env: 'test' }));
    return fn(app);
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[mobileModulePath];
  }
}

async function withServer(fn) {
  return withApp(async (app) => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(base);
    } finally {
      server.close();
    }
  });
}

const sessionHeaders = { cookie: 'session=maker' };

test('signed out, the invites route answers 401', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/challenges-api/me/invites?challenge_id=7`);
    assert.equal(res.status, 401);
  });
});

test('a malformed challenge_id answers 422', async () => {
  await withServer(async (base) => {
    for (const bad of ['abc', '0', '-3', '7.5']) {
      const res = await fetch(`${base}/challenges-api/me/invites?challenge_id=${bad}`, {
        headers: sessionHeaders,
      });
      assert.equal(res.status, 422, bad);
    }
    // Absent altogether: the challenge is required, not scoping.
    const absent = await fetch(`${base}/challenges-api/me/invites`, { headers: sessionHeaders });
    assert.equal(absent.status, 422);
  });
});

test('a challenge the invite measure does not score answers 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/challenges-api/me/invites?challenge_id=8`, {
      headers: sessionHeaders,
    });
    assert.equal(res.status, 404);
  });
});

test('the invite challenge answers the envelope with the people and their statuses', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/challenges-api/me/invites?challenge_id=7`, {
      headers: sessionHeaders,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.target, 3);
    assert.equal(body.data.people.length, 2);
    const [counted, soon] = body.data.people;
    assert.deepEqual({ ...counted, at: undefined }, { user_id: COUNTED, name: '@evan', status: 'counted', at: undefined });
    assert.deepEqual({ ...soon, at: undefined }, { user_id: SOON, name: '@ocank14', status: 'pending_count', at: undefined });
    assert.equal(counted.at, new Date(NOW - 2 * DAY).toISOString());
    assert.equal(soon.at, new Date(NOW - DAY).toISOString());
  });
});
