'use strict';

// The analytics section is a React island. These guards pin the user-visible
// distinctions that make the new data contract truthful; the browser check
// exercises the compiled component against PostgreSQL.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const UI = read('frontend/src/features/admin/admin-analytics.tsx');

test('ordered paths state their subject, order and 30-day window', () => {
  const start = UI.indexOf('{/* Funnels */}');
  const end = UI.indexOf('{/* Growth */}', start);
  const block = UI.slice(start, end);
  assert.match(block, /Signup → reported app open → later-UTC-day return → later social action → later project creation/);
  assert.match(block, /same user within 30 days/);
  assert.match(block, /Session start → precise PR opening → later promotion → later merge/);
  assert.match(block, /same dev session within 30 days/);
});

test('coverage and maturing rows cannot be rendered as abandonment', () => {
  assert.match(UI, /A missing opening receipt is coverage unknown, not measured abandonment/);
  assert.match(UI, /Counts are provisional; no abandonment rate is inferred/);
  assert.match(UI, /s\.conversion === false \? 'observed receipts'/,
    'signup-to-open must suppress the adjacent conversion percentage');
  assert.match(UI, /No trustworthy opening receipts have been recorded yet\. Conversion is unknown/);
});

test('optional votes and independent reach stay outside conversion funnels', () => {
  const start = UI.indexOf('<div id="funnel-pr"');
  const end = UI.indexOf('<h4 className={`${H4} mt-5 mb-1`}>Independent builder', start);
  const orderedProposal = UI.slice(start, end);
  assert.doesNotMatch(orderedProposal, /label: 'Received a vote'/,
    'optional votes must not become a required conversion step');
  assert.match(orderedProposal, /merged without recorded vote evidence; votes are not required/);
  assert.match(UI, /These bars are reach, not step conversion/);
  assert.match(UI, /Counts can come from different sessions and are not conversion/);
  assert.match(UI, /<MilestoneReach includeAdmins=\{includeAdmins\}/);
});
