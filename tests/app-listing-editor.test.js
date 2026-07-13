const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AppView = require('../public/js/app-view');
const appSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app.js'),
  'utf8'
);

test('App listing card follows the Dev collaboration gate', () => {
  assert.equal(AppView._listingCardHtml({ can_collaborate: false }), '');

  const html = AppView._listingCardHtml({ can_collaborate: true });
  assert.match(html, /id="dev-listing-card"/);
  assert.match(html, />App listing</);
  assert.match(html, /Edit the category and tagline people see when they find this app/);
  assert.match(html, /M9 5l7 7-7 7/);
});

test('listing editor renders nullable category controls and safe tagline input', () => {
  const html = AppView._listingEditorHtml({
    category: 'tool',
    tagline: 'Build <things> & "share"',
  });

  assert.match(html, />App listing</);
  assert.match(html, />Category</);
  assert.match(html, /data-listing-category="game" aria-pressed="false"/);
  assert.match(html, /data-listing-category="tool" aria-pressed="true"/);
  assert.match(html, />Game</);
  assert.match(html, />Tool</);
  assert.match(html, />Tagline</);
  assert.match(html, /One line saying what people do with this app\. Up to 80 characters/);
  assert.match(html, /maxlength="80"/);
  assert.match(html, /value="Build &lt;things&gt; &amp; &quot;share&quot;"/);
  assert.match(html, />24\/80</);
  assert.match(html, />Save</);
});

test('listing save PATCHes metadata and updates the cached Home card', async (t) => {
  const app = { slug: 'demo', category: null, tagline: null };
  const cached = { slug: 'demo', category: null, tagline: null };
  const calls = [];
  const oldFetch = global.fetch;
  const oldHome = global.Home;
  t.after(() => {
    global.fetch = oldFetch;
    global.Home = oldHome;
  });
  global.Home = { _apps: [cached] };
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({ category: 'game', tagline: 'Solve a daily puzzle' }),
    };
  };

  const result = await AppView._saveListingData(app, 'game', ' Solve a daily puzzle ');

  assert.deepEqual(result, { category: 'game', tagline: 'Solve a daily puzzle' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/apps/demo/listing');
  assert.equal(calls[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    category: 'game',
    tagline: ' Solve a daily puzzle ',
  });
  assert.equal(app.category, 'game');
  assert.equal(app.tagline, 'Solve a daily puzzle');
  assert.equal(cached.category, 'game');
  assert.equal(cached.tagline, 'Solve a daily puzzle');
});

test('listing save failures reject without mutating local metadata', async (t) => {
  const app = { slug: 'demo', category: 'tool', tagline: 'Original' };
  const oldFetch = global.fetch;
  t.after(() => { global.fetch = oldFetch; });
  global.fetch = async () => ({ ok: false, status: 503 });

  await assert.rejects(
    () => AppView._saveListingData(app, 'game', 'Changed'),
    /HTTP 503/
  );
  assert.deepEqual(app, { slug: 'demo', category: 'tool', tagline: 'Original' });
});

test('app router parses, normalizes, and emits the listing sub-screen route', () => {
  assert.match(appSource, /sec === 'listing'[\s\S]*subTab = 'listing'/);
  assert.match(appSource, /currentSubTab === 'listing'[\s\S]*dev\/listing/);
  assert.match(appSource, /subTab === 'listing'[\s\S]*subTab: 'listing'/);
  assert.match(appSource, /SUB_SCREENS = new Set\(\[[^\]]*'listing'/);
});

test('listing editor uses the specified success and recovery copy', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
    'utf8'
  );
  assert.match(source, /status\.textContent = 'Listing updated'/);
  assert.match(source, /Could not save the listing\. Check your connection and try again/);
});
