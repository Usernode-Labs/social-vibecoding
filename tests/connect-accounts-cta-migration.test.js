'use strict';
// test:changed: when src/db/migrations/0012-connect-accounts-cta.sql (its data rewrite)
//
// #6080: the "Connect X and GitHub" challenge sent people to Settings ›
// Connectors (the MCP servers / AI tools page) instead of Settings › Linked
// accounts. Its text and button are database rows, so 0012 rewrites them.
//
// WHAT THIS PINS. The rewrite lands on the rows that carry a CONNECT_ACCOUNTS
// scoring rule (template-bound, challenge-bound, or a challenge's template)
// and on this season's "Connect X and GitHub" rows; it replaces only the
// Connectors destination, the "Open Connectors" label and the words
// "Settings › Connectors" (or "Settings > Connectors") in the organiser's own
// text; and a second run changes nothing.
//
// The real migration file runs against real PostgreSQL. It needs only its
// three tables, so this creates those columns and skips the 17k-line
// baseline.
//
// Run with: node --test tests/connect-accounts-cta-migration.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool, Client } = require('pg');

const BASE = process.env.TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL;
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'src/db/migrations/0012-connect-accounts-cta.sql'), 'utf8');

const TABLES = `
CREATE TABLE challenge_templates (
  id                BIGSERIAL PRIMARY KEY,
  goal              VARCHAR(255) NOT NULL,
  task              TEXT,
  description       TEXT,
  requirements      TEXT,
  cta_button        VARCHAR(255),
  cta_label         VARCHAR(255),
  cta_link          TEXT,
  mobile_cta_label  VARCHAR(255),
  mobile_cta_link   TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE challenges (
  id                     BIGSERIAL PRIMARY KEY,
  challenge_template_id  BIGINT NOT NULL REFERENCES challenge_templates(id),
  goal                   VARCHAR(255),
  task                   TEXT,
  description            TEXT,
  requirements           TEXT,
  cta_button             VARCHAR(255),
  cta_label              VARCHAR(255),
  cta_link               TEXT,
  mobile_cta_label       VARCHAR(255),
  mobile_cta_link        TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE challenge_scoring_rules (
  id                     BIGSERIAL PRIMARY KEY,
  measure                VARCHAR(40) NOT NULL,
  challenge_template_id  BIGINT REFERENCES challenge_templates(id),
  challenge_id           BIGINT REFERENCES challenges(id)
);`;

const CONNECTORS = 'Both count once they are both connected under Settings › Connectors.';
const CONNECTORS_GT = 'Link them in Settings > Connectors.';

async function database(t) {
  if (!BASE) { t.skip('set TEST_DATABASE_URL for real PostgreSQL regression tests'); return null; }
  const name = `connect_cta_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new Client({ connectionString: BASE }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(BASE); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 1, connectionTimeoutMillis: 3000 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  return pool;
}

// t1 is template-bound. t2 serves a challenge-bound rule. t3 has no rule, so
// only its challenge that names the connect goal is touched.
const SEED = `
INSERT INTO challenge_templates (id, goal, cta_label, cta_link, requirements, description, task, updated_at) VALUES
  (1, 'Connect X and GitHub', 'Open Connectors', '#settings/connectors', '${CONNECTORS}', '${CONNECTORS_GT}',
   'Go to Settings › Connectors and connect both.', '2020-01-01T00:00:00Z'),
  (2, 'Build with the community', 'Open Connectors', '#settings/connectors', '${CONNECTORS}', NULL, NULL, '2020-01-01T00:00:00Z'),
  (3, 'Try three apps', 'Open Connectors', '#settings/connectors', '${CONNECTORS}', NULL, NULL, '2020-01-01T00:00:00Z');
INSERT INTO challenges (id, challenge_template_id, goal, cta_label, cta_link, mobile_cta_label, mobile_cta_link,
                        requirements, description, task, updated_at) VALUES
  (1, 1, NULL, 'Open Connectors', 'https://my.onhomeroom.com/#settings/connectors/', ' open connectors ',
   '#settings/connectors', '${CONNECTORS}', '${CONNECTORS_GT}', 'Settings > Connectors', '2020-01-01T00:00:00Z'),
  (2, 2, NULL, 'Open Connectors', '/#settings/connectors', NULL, NULL, '${CONNECTORS}', NULL, NULL, '2020-01-01T00:00:00Z'),
  (3, 3, 'Connect X and GitHub', 'Open Connectors', 'https://my.onhomeroom.com/#settings/connectors', NULL, NULL,
   '${CONNECTORS}', NULL, NULL, '2020-01-01T00:00:00Z'),
  (4, 3, NULL, 'Open Connectors', '#settings/connectors', NULL, NULL, '${CONNECTORS}', NULL, NULL, '2020-01-01T00:00:00Z'),
  (5, 1, 'Connect X and GitHub', 'Open Connectors', '#settings/alerts', NULL, NULL, '${CONNECTORS}', NULL, NULL, '2020-01-01T00:00:00Z');
INSERT INTO challenge_scoring_rules (measure, challenge_template_id, challenge_id) VALUES
  ('CONNECT_ACCOUNTS', 1, NULL),
  ('CONNECT_ACCOUNTS', NULL, 2),
  ('CONNECT_ACCOUNTS', NULL, 2);`;

const row = async (pool, table, id) => (await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0];

test('the Connect X and GitHub rows now name Linked accounts, and nothing else moves', async t => {
  const pool = await database(t); if (!pool) return;
  await pool.query(TABLES);
  await pool.query(SEED);

  await pool.query(MIGRATION);

  // A template bound to the measure, and one whose challenge is bound.
  const t1 = await row(pool, 'challenge_templates', 1);
  assert.equal(t1.cta_link, '#settings/linked-accounts');
  assert.equal(t1.cta_label, 'Open linked accounts');
  assert.equal(t1.requirements, CONNECTORS.replace('Settings › Connectors', 'Settings › Linked accounts'));
  assert.equal(t1.description, 'Link them in Settings › Linked accounts.');
  assert.equal(t1.task, 'Go to Settings › Linked accounts and connect both.');
  assert.equal((await row(pool, 'challenge_templates', 2)).cta_label, 'Open linked accounts');
  // A template no rule reaches keeps everything, including its timestamp.
  assert.deepEqual(await row(pool, 'challenge_templates', 3), {
    id: '3', goal: 'Try three apps', task: null, description: null, requirements: CONNECTORS,
    cta_button: null, cta_label: 'Open Connectors', cta_link: '#settings/connectors',
    mobile_cta_label: null, mobile_cta_link: null, updated_at: new Date('2020-01-01T00:00:00.000Z'),
  });

  // A challenge from the template-bound template: link, label (case and
  // spacing ignored), mobile link and every changed text column.
  const c1 = await row(pool, 'challenges', 1);
  assert.equal(c1.cta_link, 'https://my.onhomeroom.com/#settings/linked-accounts');
  assert.equal(c1.mobile_cta_link, '#settings/linked-accounts');
  assert.equal(c1.cta_label, 'Open linked accounts');
  assert.equal(c1.mobile_cta_label, 'Open linked accounts');
  assert.equal(c1.requirements, CONNECTORS.replace('Settings › Connectors', 'Settings › Linked accounts'));
  assert.equal(c1.description, 'Link them in Settings › Linked accounts.');
  assert.equal(c1.task, 'Settings › Linked accounts');

  // A challenge-bound rule, and a challenge whose effective goal names the
  // connect challenge though its template does not.
  assert.equal((await row(pool, 'challenges', 2)).cta_link, '/#settings/linked-accounts');
  assert.equal((await row(pool, 'challenges', 3)).cta_link, 'https://my.onhomeroom.com/#settings/linked-accounts');

  // Unreached challenge untouched, timestamp included.
  assert.deepEqual(await row(pool, 'challenges', 4), {
    id: '4', challenge_template_id: '3', goal: null, task: null, description: null, requirements: CONNECTORS,
    cta_button: null, cta_label: 'Open Connectors', cta_link: '#settings/connectors',
    mobile_cta_label: null, mobile_cta_link: null, updated_at: new Date('2020-01-01T00:00:00.000Z'),
  });

  // Only the Connectors destination is replaced: another section the
  // organiser named is kept, while the label still gets the right name.
  const c5 = await row(pool, 'challenges', 5);
  assert.equal(c5.cta_link, '#settings/alerts');
  assert.equal(c5.cta_label, 'Open linked accounts');

  // A second run changes nothing at all, timestamps included.
  const touched = [['challenge_templates', 1], ['challenge_templates', 2],
    ['challenges', 1], ['challenges', 2], ['challenges', 3], ['challenges', 5]];
  const before = {};
  for (const [table, id] of touched) before[`${table}-${id}`] = await row(pool, table, id);
  await pool.query(MIGRATION);
  for (const [table, id] of touched) {
    assert.deepEqual(await row(pool, table, id), before[`${table}-${id}`],
      `${table} ${id} is unchanged by a second run`);
  }
});
