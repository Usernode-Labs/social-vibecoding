'use strict';

// #3233: Global Chat's Notifications card titled each row with its raw `kind`
// humanized ("App Quota Changed") and used the raw `detail` as its summary
// ("0:2"). It now words a row the way the notification sheet does, by running
// the sheet's own rowView. This renders the real card over an
// /api/notifications payload rather than matching the source.
//
// Run with: node --test tests/global-chat-notification-copy.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

if (!globalThis.window) globalThis.window = globalThis;

function render(notifications) {
  const { GlobalChatResultBlock } = loadTsx('frontend/src/features/global-chat/renderers.tsx');
  return renderToHtml(createElement(GlobalChatResultBlock, {
    result: {
      id: 'r1',
      capabilityId: 'notifications.list',
      renderer: 'notification',
      classicPath: null,
      status: 'completed',
      authoritativeResult: { data: { notifications } },
    },
    // Nested blocks start expanded, which is where a row's summary shows.
    nested: true,
  }));
}

const AT = new Date(Date.now() - 4 * 60 * 1000).toISOString();

test('an allowance change reads in words, not as its kind and detail', () => {
  const html = render([{ id: 7, kind: 'app_quota_changed', detail: '0:2', createdAt: AT, readAt: null }]);
  assert.match(html, /App allowance changed/);
  assert.match(html, /Your app allowance went up from 0 to 2 app slots\./);
  assert.doesNotMatch(html, /App Quota Changed/);
  assert.doesNotMatch(html, />0:2</);
});

test('a kind the sheet names keeps the sheet name here too', () => {
  const html = render([{ id: 8, kind: 'app_quota_requested', sourceUsername: 'ada', createdAt: AT }]);
  assert.match(html, /Requested more app slots/);
  assert.match(html, /@ada/);
  assert.doesNotMatch(html, /App Quota Requested/);
});
