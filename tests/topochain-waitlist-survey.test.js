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
  _version: 3,
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
  followed_claim: true,
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

test('every known key is surfaced under its own label', () => {
  const html = render(HOSTILE);
  for (const label of [
    'Made', 'Where', 'Found us', 'Referred by', 'Group', 'Group need',
    // "Invites (typed)" rather than "Invites": the stage-2 form collects a
    // share link now, and a row carrying typed addresses predates that. The
    // label says which it is, and legacy rows keep being shown — an admin
    // reading one should still see what that person actually typed.
    'Lost a tool', 'Loss story', 'Verified', 'Handles', 'Follow',
    'Invites \\(typed\\)',
  ]) {
    assert.match(html, new RegExp(`${label}:`), `${label} is surfaced`);
  }
});

// A follow is a SELF-REPORT. No network confirms one for us (see the note on
// `followed_claim` in services/waitlist-questions.js), so the line has to say
// so — beside a "Verified" line that means OAuth actually proved it, an
// unqualified "Follows us" would read as something we checked.
test('a claimed follow is labelled as a claim, not as a verification', () => {
  const html = render({ followed_claim: true });
  assert.match(html, /Follow:/);
  assert.match(html, /not verified/,
    'the claim is marked as one rather than sitting beside the OAuth-proved list');
});

// #1544. An unknown key used to be DROPPED, on the reasoning that nothing
// here knows how to label it. But `answers` spans several schema versions of
// a public form, and the keys that fall through are exactly the ones an admin
// looking at an odd row needs to see: what got dropped was the evidence. They
// are shown verbatim under one "Other answers" line, as escaped TEXT — the
// module's rules about untrusted content are unchanged, only the decision to
// hide it is.
test('an unrecognised key is shown rather than dropped, and shown as text', () => {
  const html = render({ ...HOSTILE, internal_admin_note: 'a retired question' });
  assert.match(html, /Other answers:/);
  assert.match(html, /internal_admin_note: a retired question/,
    'the key is named alongside its value, so an admin can see what is stored');

  // Still untrusted, still escaped, still never markup.
  const nasty = render({ stray_key: '<script>alert(1)</script>' });
  assert.ok(!/<script>/.test(nasty), 'an unknown value is escaped like every other string');
  assert.match(nasty, /&lt;script&gt;/);

  // A nested blob is JSON rather than "[object Object]", which tells an
  // admin nothing about what is in the row.
  const nested = render({ stray_key: { a: 1 } });
  assert.ok(!/\[object Object\]/.test(nested));
  assert.match(nested, /&quot;a&quot;:1|"a":1/);
});

test('the schema version is bookkeeping and is never shown as an answer', () => {
  const html = render(HOSTILE);
  assert.ok(!/_version/.test(html),
    '_version says nothing about the person and would head every Other answers line');
  // ...and it alone must not conjure the line into existence.
  assert.ok(!/Other answers:/.test(render({ _version: 3, country: 'DE' })));
});

// The option CODES stored in `answers` are labelled from
// /api/public/waitlist/options, which this render never fetches (effects do
// not run under renderToStaticMarkup, which is also the state of the screen
// for the first moment after it mounts). The fallback has to be the code
// itself: a row that reads `lt10` is still a row an admin can work with, and
// blanking the field would be worse than showing it raw.
test('an answer code still renders when the options lookup has not landed', () => {
  const html = render({
    discovery: { source: 'friend' },
    group: { size: 'lt10', role: 'organizer', tools: ['groupchat'] },
    loss: { had: 'yes', kind: ['shutdown'] },
  });
  assert.match(html, /Found us:/);
  assert.match(html, /friend/, 'the stored code is shown rather than nothing');
  assert.match(html, /lt10/);
  assert.match(html, /organizer/);
  assert.match(html, /groupchat/);
  assert.match(html, /shutdown/);
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

// `admit_together` was retired with its checkbox (#1534): no admission path
// ever read it, so a labelled line for it told an admin that a request was
// live when it never had been. The stored value is NOT erased — it falls
// through to "Other answers" like any other key the module stopped knowing,
// which is the same treatment a retired question gets everywhere else.
test('the retired buddy flag is no longer a line of its own, but is still shown', () => {
  const html = render(HOSTILE);
  assert.ok(!/only together/.test(html),
    'nothing on the screen still describes a request the platform never honoured');
  assert.match(html, /a@b\.invalid, c@d\.invalid/,
    'the legacy typed addresses are unaffected and still read as themselves');

  // A row carrying nothing but the retired key is not an empty row.
  const alone = render({ admit_together: true });
  assert.ok(!/No survey answers\./.test(alone), 'the stored value is still evidence');
  assert.match(alone, /Other answers:/);
  assert.match(alone, /admit_together: true/);
});
