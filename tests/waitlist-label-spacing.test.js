'use strict';

// #1877: JSX drops the line break between a label's text and the <span> after
// it, so the waitlist's "Country" label rendered as "CountryOptional" (and
// "How did you find us?Optional"), and the required "*" touched "address".
// Each marker now carries its own left margin; the asterisk is also hidden
// from screen readers, since the input's `required` already announces it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend/src/features/auth/waitlist.tsx'), 'utf8');

/**
 * The className of the <span> that directly follows a label's text. The text
 * is a catalog message now, so the label is found by the id the screen reads.
 */
const LABEL_IDS = {
  Country: 'auth:waitlist.country.label',
  'How did you find us?': 'auth:waitlist.discovery.label',
  'Your email address': 'auth:waitlist.email.label',
};

function spanAfter(label) {
  assert.equal(message(LABEL_IDS[label]), label);
  const labelText = `{t('${LABEL_IDS[label]}')}`;
  const esc = labelText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = SRC.match(new RegExp(`\\n\\s*${esc}\\n\\s*<span className="([^"]*)"([^>]*)>`));
  assert.ok(m, `expected a span right after "${label}"`);
  return { classes: m[1].split(/\s+/), attrs: m[2] };
}

for (const label of ['Country', 'How did you find us?']) {
  test(`"${label}" and its "Optional" marker are spaced apart`, () => {
    const { classes } = spanAfter(label);
    assert.ok(classes.some((c) => /^ml-(?!0$)/.test(c)),
      `expected a left margin on the Optional span, got "${classes.join(' ')}"`);
  });
}

test('the required asterisk sits off the word and is hidden from screen readers', () => {
  const { classes, attrs } = spanAfter('Your email address');
  assert.ok(classes.some((c) => /^ml-(?!0$)/.test(c)), 'a left margin on the asterisk');
  assert.match(attrs, /aria-hidden="true"/);
  assert.match(SRC, /id="waitlist-email"[\s\S]{0,80}required=\{true\}/,
    'the input itself still carries required, which is what announces it');
});
