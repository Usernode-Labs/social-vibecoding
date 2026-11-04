'use strict';

// #6281: a project whose creator deleted their account. apps.created_by is
// REFERENCES users(id) ON DELETE SET NULL, so the community route resolves no
// creator and used to say "this project has no creator", which reads like a
// bug (Bread Bot). The route now carries `creator_gone` beside `creator`, and
// only for a project that is not the platform's own (which has no creator by
// design). The real database path is exercised in
// tests/communities-postgres.test.js; this pins the wiring so a later edit
// cannot drop the flag.
//
// Run with: node --test tests/community-creator-gone.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ROUTE = fs.readFileSync(path.join(ROOT, 'src/routes/apps.js'), 'utf8');

test('the community payload says when a project\'s creator account is gone', () => {
  assert.match(ROUTE, /creator,\s*\n\s*\/\/ #6281:[\s\S]*?creator_gone: !app\.self_hosted && !creator,/,
    'creator_gone is derived from the resolved creator, and is false on the platform\'s own project');
});
