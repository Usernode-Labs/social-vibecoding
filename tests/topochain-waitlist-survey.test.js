// The waitlist survey-answers block, EXECUTED against a hostile payload.
//
// WHY THIS FILE EXISTS. `waitlist_signups.answers` is user-submitted JSON from
// the public join form — the least trusted data any admin screen renders. One
// field in it, `made_url`, is a URL the signup chose, and the rule the module
// has carried since it shipped is that it is rendered as SELECTABLE TEXT and
// never as an anchor: escaping stops attribute breakout but not a
// `javascript:` scheme, which executes on click with no markup injection
// needed at all.
//
// Grepping cannot check that. Neither can a declared browser check: the
// staging seed leaves `answers` empty on every row, so the whole block is
// unreachable in a preview. This renders the component and reads the markup.
//
// Run with: node --test tests/topochain-waitlist-survey.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderComponent } = require('./lib/render-tsx');

const ENTRY = 'frontend/src/features/admin/topochain/waitlist.tsx';
const render = (answers) => renderComponent(ENTRY, 'SurveyAnswers', { answers });

// Every known key at once, with the dangerous ones carrying payloads.
const HOSTILE = {
  made_url: 'javascript:alert(document.cookie)',
  made_note: '<img src=x onerror=alert(1)>',
  city: 'Nowhere"><script>alert(1)</script>',
  country: 'Elsewhere',
  discovery: { source: 'a friend', detail: '</span><script>alert(1)</script>' },
  referrer_handle: '@someone',
  group: { name: 'Team', size: '4', role: 'lead', tools: ['vim', 'tmux'], need: 'a whiteboard' },
  loss: { had: 'a tool', product: 'Widgets', kind: ['sunset'], story: 'It went away.' },
  verified: { github: 'octocat' },
  handles: { x: 'someone' },
  invites: ['a@b.invalid', 'c@d.invalid'],
  admit_together: true,
};

test('a submitted URL is never rendered as a link, whatever its scheme', () => {
  const html = render(HOSTILE);
  assert.ok(!/<a[\s>]/.test(html), 'no anchor is produced from survey answers at all');
  assert.ok(!/href=/.test(html), '...and therefore no href to carry a scheme');
  assert.ok(!/javascript:alert\(document\.cookie\)"/.test(html),
    'the URL never lands inside an attribute value');
  // It IS shown — the admin has to be able to read and copy it.
  assert.match(html, /javascript:alert\(document\.cookie\)/,
    'the URL is displayed as text so an admin can copy it out');
  assert.match(html, /class="select-all break-all"/,
    'and is selectable in one gesture, which is the affordance replacing the link');
});

test('every submitted string is escaped, in text and in the note beside the URL', () => {
  const html = render(HOSTILE);
  assert.ok(!/<script>/.test(html), 'no submitted markup survives as markup');
  assert.ok(!/<img /.test(html), 'including in made_note, which sits beside the URL');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'the note is shown, escaped');
  assert.match(html, /&lt;\/span&gt;&lt;script&gt;/, 'so is a breakout attempt in discovery.detail');
});

test('the known keys are surfaced, and nothing else is', () => {
  const html = render(HOSTILE);
  for (const label of [
    'Made', 'Where', 'Found us', 'Referred by', 'Group', 'Group need',
    'Lost a tool', 'Loss story', 'Verified', 'Handles', 'Invites',
  ]) {
    assert.match(html, new RegExp(`${label}:`), `${label} is surfaced`);
  }
  // An unknown key is data the form stopped collecting or never did — it must
  // not appear, because nothing here knows how to label or trust it.
  const withStray = render({ ...HOSTILE, internal_admin_note: 'do not show me' });
  assert.ok(!withStray.includes('do not show me'),
    'an unrecognised answers key is not rendered');
});

test('an empty answers object says so rather than rendering an empty block', () => {
  assert.match(render({}), /No survey answers\./);
});

test('the two invite shapes render differently, and both say "only together"', () => {
  const both = render({ invites: ['a@b.invalid'], admit_together: true });
  assert.match(both, /a@b\.invalid/);
  assert.match(both, /\(only together\)/);
  const aloneHtml = render({ admit_together: true });
  assert.match(aloneHtml, /only together/);
  assert.ok(!/\(only together\)/.test(aloneHtml),
    'with no invites listed the parenthetical would have nothing to qualify');
});
