'use strict';

// Classic-script fixtures run outside the React bundle that publishes this
// facade in the browser. Give them the real catalog/runtime, so existing
// English assertions keep testing rendered copy rather than message IDs.
const { loadTsx } = require('./render-tsx');
let runtime;
function withLanguage(context = { window: {} }) {
  runtime ||= loadTsx('frontend/src/lib/i18n/runtime.ts');
  context.PlatformI18n ||= runtime;
  context.tr ||= runtime.t;
  if (context.window) context.window.PlatformI18n ||= context.PlatformI18n;
  return context;
}
module.exports = { withLanguage };
