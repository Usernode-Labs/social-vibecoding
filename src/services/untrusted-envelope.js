'use strict';

// The <untrusted-content> envelope marks text other people wrote, so a model
// reads it as data. The envelope only holds if the text inside cannot carry
// a tag of its own: one closing tag would end it early and let the rest
// speak as instructions. So every opening or closing tag in the text, in any
// case and with stray whitespace or attributes (`</ untrusted-content >`,
// `<UNTRUSTED-CONTENT x>`), becomes a space before the text is wrapped.
const ENVELOPE_TAG_RE = /<\s*\/?\s*untrusted-content\b(?:[^<>]*>)?/gi;

function neutralizeEnvelope(value) {
  return String(value == null ? '' : value).replace(ENVELOPE_TAG_RE, ' ');
}

module.exports = { ENVELOPE_TAG_RE, neutralizeEnvelope };
