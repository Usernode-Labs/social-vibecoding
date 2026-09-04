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
    // "Invites (typed)" rather than "Invites": the stage-2 form collects a
    // share link now, and a row carrying typed addresses predates that. The
    // label says which it is, and legacy rows keep being shown — an admin
    // reading one should still see what that person actually typed.
    'Lost a tool', 'Loss story', 'Verified', 'Handles', 'Invites \\(typed\\)',
  ]) {
    assert.match(html, new RegExp(`${label}:`), `${label} is surfaced`);
  }
  // An unknown key is data the form stopped collecting or never did — it must
  // not appear, because nothing here knows how to label or trust it.
  const withStray = render({ ...HOSTILE, internal_admin_note: 'do not show me' });
  assert.ok(!withStray.includes('do not show me'),
    'an unrecognised answers key is not rendered');
});

// #1527 replaced the region-bucketed picker with the complete ISO 3166-1
// list, so what is STORED in `country` is now one of three things: a real
// alpha-2 code, one of the five namespaced legacy region answers the boot
// migration rewrote (`X-LA` and friends), or — on a row old enough or odd
// enough — a string that is neither. The screen has to read for a human in
// all three cases, and the third one is still untrusted input.
test('a stored country code is rendered as its name, not as the code', () => {
  const html = render({ country: 'DE' });
  assert.match(html, /Where:/);
  assert.match(html, /Germany/, 'the alpha-2 code is looked up, not printed raw');
  assert.ok(!/>DE</.test(html), 'and the code itself is not what an admin reads');
});

test('a retired region answer keeps saying what the person actually picked', () => {
  // The picker no longer offers it, and nothing rewrote the answer into a
  // country it never meant — so the label has to name the region AND mark
  // it as one, or "Elsewhere in Latin America" reads like a place.
  assert.match(render({ country: 'X-LA' }), /Elsewhere in Latin America \(region\)/);
  assert.match(render({ country: 'X-EU' }), /Elsewhere in Europe \(region\)/);
});

test('an unrecognised country falls back to the stored string, escaped', () => {
  // `countryLabel` must never throw and never blank the field: an admin
  // reading a row wants to see whatever is actually in the database.
  assert.match(render(HOSTILE), /Elsewhere/);
  const nasty = render({ country: '<script>alert(1)</script>' });
  assert.ok(!/<script>/.test(nasty), 'the fallback path escapes like every other string');
  assert.match(nasty, /&lt;script&gt;/);
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
