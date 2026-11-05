'use strict';

// One message from one template: fills the template's fields with the action's
// values and puts the result inside its layout, if it has one. The caller picks
// the template and layout rows (English or a translation) and attributes the
// payload first (tracking.attributedPayload), so the output goes on through
// tracking.decorate as buildMessage's does.
//
// `subject` and `text` are plain text, so nothing is escaped in them. `html`,
// `why` and `preheader` are html sources: a value is escaped where it lands, and
// the wording around it is written as it should go out. The returned `why` and
// `preheader` are therefore html. The layout gets them, and `{{content}}`, raw,
// because they have been escaped by the time they get there; a value is never
// read as template text, so nothing in one can reach the layout's placeholders.

const { actionFor } = require('./actions');
const { render } = require('./template-language');
const { englishFrom, englishTexts } = require('../push-text');

const RAW_IN_LAYOUT = ['content', 'why', 'preheader'];

// A line break, a control character or a separator some client treats as one.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f\u0085\u2028\u2029]/g;
const cleanSubject = (subject) => subject.replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim();
const controls = (text) => (text.match(CONTROL) || []).join('');

// The words built in code ask a translator at send time, under the rule the seed
// applied to the rest: an answer that is empty or brings line breaks the English
// does not have costs that one message its translation.
function guarded(t) {
  const english = englishFrom(englishTexts(undefined, 'email'));
  return (id, values) => {
    const inEnglish = english(id, values);
    const answer = t(id, values);
    return typeof answer === 'string' && answer.trim() && controls(answer) === controls(inEnglish) ? answer : inEnglish;
  };
}

/**
 * `t` is the translator of a translated `template`, for the words the action
 * builds in code; left out, those are English. `readerHasLanguage` says the
 * reader has a language other than English, whether or not it has a row for this
 * mail. Such a reader's subject is cleaned as a whole, as it has always been, so
 * that nothing adds lines or headers to it; mail that stays in English is not.
 */
function renderMessage(kind, { template, layout }, payload = {}, t, { readerHasLanguage = false } = {}) {
  const action = actionFor(kind);
  if (!action) throw new Error(`unknown mail kind: ${kind}`);
  const words = t ? guarded(t) : undefined;
  const values = action.values(payload, words);
  const escaped = action.htmlValues ? action.htmlValues(payload, words) : {};
  const inHtml = (source) => render(source, { ...values, ...escaped }, { raw: Object.keys(escaped) });
  const inText = (source) => render(source, values, { mode: 'text' });

  const subject = inText(template.subject);
  const content = { html: inHtml(template.html), text: inText(template.text) };
  const why = inHtml(template.why);
  const preheader = inHtml(template.preheader);
  const framed = layout
    ? {
      html: render(layout.html, { content: content.html, why, preheader }, { raw: RAW_IN_LAYOUT }),
      text: render(layout.text, { content: content.text, why: inText(template.why), preheader: inText(template.preheader) }, { mode: 'text' }),
    }
    : content;

  return {
    subject: (t || readerHasLanguage) && !action.englishOnly ? cleanSubject(subject) : subject,
    html: framed.html,
    text: framed.text,
    why,
    preheader,
    headers: action.headers ? action.headers(payload) : null,
  };
}

module.exports = { renderMessage };
