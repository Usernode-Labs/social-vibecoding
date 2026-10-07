'use strict';

// With WF_PREVIEWS_ENABLED on, a promoted proposal's interactive turn tail
// moves its reviewed head (retiring the votes) BEFORE it submits the commit
// to the preview machine: the reviewed head is the pin the machine checks a
// revision against, so the other order is refused as head_superseded and
// nothing builds (review finding 3).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the interactive tail retires the votes before it hands the commit to the machine', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/sessions.js'), 'utf8');
  const branch = src.slice(src.indexOf('let previewHandedOff = false;'));
  const retire = branch.indexOf('await retireVotesForCommit();');
  const submit = branch.indexOf('previewWorkflow.revision(');
  assert.ok(retire > 0 && submit > retire, 'votes retired (pin moved), then the revision submitted');
  assert.ok(src.indexOf('const retireVotesForCommit = async') < src.indexOf('let previewHandedOff = false;'));
});
