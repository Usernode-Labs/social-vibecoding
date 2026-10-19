'use strict';

// #5294: THE REPORT DIALOG (header menu › Report app, and the person and
// message reports that share it).
//
// It was a drop-down of reasons over two filled blue buttons, centred on every
// screen. Now:
//
//   1. the reasons are a short list to tap: a radio group of whole-row
//      buttons, a check on the picked one, arrow keys moving the pick, and
//      the same reason keys sent to POST /api/reports as before;
//   2. "Send report" is the one filled button and Cancel is quiet text;
//   3. on a phone it is a bottom sheet (useDialog's `phoneSheet`, the
//      feedback dialog's presentation), the centred card elsewhere.
//
// Run with: node --test tests/report-dialog.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const REPORT = fs.readFileSync(path.join(ROOT, 'frontend/src/features/dialogs/report.tsx'), 'utf8');
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/locales/en/dialogs.json'), 'utf8'));

test('the reasons are a list to tap, not a drop-down', () => {
  assert.doesNotMatch(REPORT, /<select/, 'no drop-down left');
  assert.doesNotMatch(REPORT, /<option/);
  assert.match(REPORT, /<GroupedList[^>]*role="radiogroup"[^>]*aria-labelledby=\{labelId\}/);
  assert.match(REPORT, /as="button"\s+role="radio"\s+aria-checked=\{value === key\}/,
    'each reason is a whole-row radio button');
  assert.match(REPORT, /data-report-reason=\{key\}/);
  assert.match(REPORT, /onClick=\{\(\) => onPick\(key\)\}/);
  assert.match(REPORT, /<CheckIcon [^>]*aria-hidden="true" \/>/, 'the picked row carries a check');
  assert.match(REPORT, /labelId="report-reason-label"/);
  assert.match(REPORT, /<SectionHeader [^>]*id="report-reason-label">\{t\('dialogs:report\.reason\.label'\)\}/);
});

test('the list works from the keyboard like a radio group', () => {
  assert.match(REPORT, /tabIndex=\{key === focusable \? 0 : -1\}/, 'one row in the tab order');
  assert.match(REPORT, /'ArrowDown'/);
  assert.match(REPORT, /'ArrowUp'/);
  assert.match(REPORT, /onPick\(key\);\s*const row = [^;]+;\s*row\?\.focus\(\);/,
    'an arrow key picks the next reason and moves focus to it');
});

test('the value sent is the reason key the drop-down sent', () => {
  for (const key of ['spam', 'scam', 'harassment', 'hate', 'threats', 'sexual_content', 'impersonation', 'other']) {
    assert.ok(REPORT.includes(`['${key}',`), `${key} is still a reason`);
  }
  assert.match(REPORT, /onPick=\{setReason\}/);
  assert.match(REPORT, /body: JSON\.stringify\(\{ targetType: target\.targetType, target: target\.target, reason, detail \}\)/);
  assert.match(REPORT, /key !== 'impersonation' \|\| target\?\.targetType === 'user'/,
    'impersonation is offered only for a person');
});

test('#5102: child safety is the first reason, worded plainly', () => {
  const list = REPORT.slice(REPORT.indexOf('export const REPORT_REASONS = ['));
  const first = list.match(/\['([a-z_]+)',/);
  assert.equal(first && first[1], 'child_safety', 'child safety is the first row of the list');
  assert.ok(REPORT.includes("['child_safety', 'dialogs:report.reason.childSafety']"));
  assert.equal(message('dialogs:report.reason.childSafety'),
    'Child safety: a minor at risk, or sexual content involving a minor');
});

test('Send report is the one strong button; Cancel is quiet text', () => {
  assert.equal(message('dialogs:report.submit'), 'Send report');
  assert.match(REPORT, /<Button type="button" variant="unstyled" size="default" ink="muted" className="rounded-lg" disabled=\{busy\} onClick=\{dialog\.close\}>\{t\('core:common\.cancel'\)\}<\/Button>/);
  assert.match(REPORT, /<Button type="submit" disabledStyle="block" disabled=\{busy \|\| !reason \|\| \(reason === 'other' && !detail\.trim\(\)\)\}>/,
    'still disabled until a reason is picked (and a detail for Other)');
});

test('a bottom sheet on a phone', () => {
  assert.match(REPORT, /useDialog<ReportTarget>\('report', \{\s*phoneSheet: true,/);
});

test('the copy no longer talks about a drop-down', () => {
  assert.equal(CATALOG['report.reason.choose'], undefined, 'the empty option is gone');
  for (const [id, entry] of Object.entries(CATALOG)) {
    if (!id.startsWith('report.')) continue;
    assert.doesNotMatch(entry.description, /drop-down/, id);
    assert.doesNotMatch(entry.description, /Submit report/, id);
  }
});
