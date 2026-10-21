// The grocery list's offline shell, as Homeroom's Todo List app keeps its own.
//
// What it does:
//   - Keeps a copy of the page, its script and its stylesheet, so a phone
//     with no connection still opens the list. The page then shows the copy
//     of the list it saved on this device (public/app.js), and anything done
//     offline waits there until the connection is back.
//   - Keeps the platform's hosted files the page needs (the bridge and the
//     native UI kit) warm WITHOUT vendoring them: each is answered from the
//     copy at once and refreshed from the network on every online load, so a
//     platform fix still lands on the next load.
//   - Never touches /api/* or the live updates stream: data always goes to
//     the network, and the page's own saved copy is what shows offline.
//
// Homeroom opens this app with no connection only because this worker served
// its page on an earlier visit: the bridge sees it and tells the shell
// ("Offline: apps that open with no connection" in the platform conventions).
//
// Change CACHE when the list of files below changes; activate drops every
// older copy. The page and its own files are fetched fresh whenever the
// network answers in time, so an ordinary deploy needs no change here.

var CACHE = 'grocery-list-v1';

// This app's own files, kept for an offline load. The page is cached as
// /index.html, which the server answers like / and without a sign-in.
var SHELL = ['/index.html', '/app.js', '/live-updates.js', '/tailwind.css'];
var PAGE = '/index.html';

// The platform's files, served on this app's own address.
var HOSTED = ['/usernode-bridge/v1/bridge.js', '/usernode-native/v1/native.css', '/usernode-native/v1/native.js'];
function isHosted(path) {
  return path.indexOf('/usernode-bridge/') === 0 || path.indexOf('/usernode-native/') === 0 || path.indexOf('/usernode-tailwind/') === 0;
}

// Every fetch this worker makes has a deadline: a connection that drops
// everything must not hold an install, or a page, open until it gives up.
var DEADLINE_MS = 5000;
function fetchWithin(request, ms) {
  var ctl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
  return fetch(request, ctl ? { signal: ctl.signal } : undefined)
    .then(function (res) { clearTimeout(timer); return res; }, function (err) { clearTimeout(timer); throw err; });
}

function keep(path, res) {
  if (!res || !res.ok) return Promise.resolve();
  return caches.open(CACHE).then(function (cache) { return cache.put(path, res); }).catch(function () {});
}

self.addEventListener('install', function (event) {
  // One by one and best effort: a file that cannot be fetched now is kept
  // on the next online load instead, and never stops the worker installing.
  event.waitUntil(Promise.all(SHELL.concat(HOSTED).map(function (path) {
    return fetchWithin(new Request(path, { cache: 'reload' }), DEADLINE_MS)
      .then(function (res) { return keep(path, res); }, function () {});
  })).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) { return n !== CACHE; }).map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});

// The network when it answers in time, and the copy kept here otherwise.
function networkFirst(request, path) {
  return fetchWithin(request, DEADLINE_MS).then(function (res) {
    if (res && res.ok) keep(path, res.clone());
    return res;
  }, function () {
    return caches.match(path, { cacheName: CACHE }).then(function (copy) {
      if (copy) return copy;
      throw new Error('offline and not kept');
    });
  });
}

// The copy at once, refreshed from the network behind it.
function copyFirst(request, path) {
  return caches.match(path, { cacheName: CACHE }).then(function (copy) {
    var fresh = fetch(request).then(function (res) {
      if (res && res.ok) keep(path, res.clone());
      return res;
    });
    if (copy) { fresh.catch(function () {}); return copy; }
    return fresh;
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  // Data and the live updates stream always go to the network.
  if (url.pathname.indexOf('/api/') === 0 || url.pathname === '/health') return;
  if ((req.headers.get('accept') || '').indexOf('text/event-stream') !== -1) return;

  if (req.mode === 'navigate') {
    // An offline load comes with no ?token= (the shell cannot make one
    // without a connection): it still gets the page, which finds the list
    // it saved on this device.
    event.respondWith(networkFirst(req, PAGE).catch(function () {
      return new Response('<!doctype html><meta charset="utf-8"><title>Offline</title>'
        + '<p style="font:16px system-ui;padding:2rem;text-align:center">You are offline, and this list has not been opened on this device before.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }));
    return;
  }
  if (SHELL.indexOf(url.pathname) !== -1) {
    event.respondWith(networkFirst(req, url.pathname));
    return;
  }
  if (isHosted(url.pathname)) {
    event.respondWith(copyFirst(req, url.pathname));
  }
});
