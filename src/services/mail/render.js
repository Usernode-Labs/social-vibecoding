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

const RAW_IN_LAYOUT = ['content', 'why', 'preheader'];

// A line break, a control character or a separator some client treats as one.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f\u0085\u2028\u2029]/g;
const cleanSubject = (subject) => subject.replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim();

/**
 * `t` is the translator of a translated `template`, for the words the action
 * builds in code; left out, those are English. A translation may not add lines
 * or headers to its subject, so a translated subject is cleaned as a whole.
 */
function renderMessage(kind, { template, layout }, payload = {}, t) {
  const action = actionFor(kind);
  if (!action) throw new Error(`unknown mail kind: ${kind}`);
  const values = action.values(payload, t);
  const escaped = action.htmlValues ? action.htmlValues(payload, t) : {};
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
    subject: t ? cleanSubject(subject) : subject,
    html: framed.html,
    text: framed.text,
    why,
    preheader,
    headers: action.headers ? action.headers(payload) : null,
  };
}

module.exports = { renderMessage };
