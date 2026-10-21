// Live updates, from the page: listens to GET /api/changes (live-updates.js,
// beside server.js) and calls the screen back whenever anything changed, so
// it fetches what it shows again at once.
//
//   var live = LiveUpdates.watch({
//     refresh: function () { return load(); }, // fetch again and draw; return its promise
//     quiet: function () { return !drag; },    // optional: false while a redraw would get in the way
//   });
//   live.changed(); // something the screen knows it has not drawn yet: fetch when quiet
//
// - A change heard while the screen is not quiet (mid-drag, mid-typing)
//   waits and is fetched the moment it is quiet again. It is never dropped.
// - Changes close together make one refresh (WAIT_MS).
// - While nobody can see the app (its tab hidden, or Homeroom keeping it
//   loaded but hidden: usernode:visibility-changed), it lets go of the
//   stream. Back on screen, it fetches at once and listens again.
// - It also looks every LOOK_MS whatever the stream says, in case the
//   stream is down, so the screen is never more than that out of date.
// - A stream that drops is reconnected by the browser. One the server
//   refuses (a sign-in token that ran out: Homeroom opens the frame again
//   with a fresh one well before that) is tried again, less and less often,
//   each time with the token the page has then.
//
// The stream carries no data, only "something changed": the screen's own
// read decides what it shows.

(function () {
  var WAIT_MS = 250;
  var LOOK_MS = 60000;
  var QUIET_CHECK_MS = 300;
  var RETRY_MIN_MS = 2000;
  var RETRY_MAX_MS = 60000;

  function watch(opts) {
    var refresh = opts.refresh;
    var quiet = opts.quiet || function () { return true; };
    var source = null;
    var opened = false;
    var failures = 0;
    var retryTimer = null;
    var waitTimer = null;
    var pending = false;
    var running = false;
    var shellHidden = false;

    function away() { return document.hidden || shellHidden; }

    // Something changed: fetch once things settle, and once the screen is quiet.
    function changed() {
      pending = true;
      if (!waitTimer) waitTimer = setTimeout(settle, WAIT_MS);
    }

    function settle() {
      waitTimer = null;
      // Nobody looking: coming back on screen fetches anyway.
      if (!pending || away()) return;
      if (running || !quiet()) { waitTimer = setTimeout(settle, QUIET_CHECK_MS); return; }
      pending = false;
      running = true;
      Promise.resolve().then(refresh).catch(function () { /* the screen shows its own error */ }).then(function () {
        running = false;
        if (pending) changed();
      });
    }

    function streamUrl() {
      // The token the frame has now, read again each time: Homeroom opens
      // the frame with a fresh one before the old one runs out.
      var token = new URLSearchParams(window.location.search).get('token');
      return '/api/changes' + (token ? '?token=' + encodeURIComponent(token) : '');
    }

    function open() {
      clearTimeout(retryTimer);
      retryTimer = null;
      if (source || away() || typeof EventSource === 'undefined') return;
      var es = new EventSource(streamUrl());
      source = es;
      es.addEventListener('open', function () {
        failures = 0;
        // Open again after being down: what changed meanwhile was not heard.
        if (opened) changed();
        opened = true;
      });
      es.addEventListener('change', changed);
      es.addEventListener('error', function () {
        if (source !== es) return;
        // CONNECTING: the browser is reconnecting a dropped stream itself.
        // CLOSED: the server refused it, so try again later.
        if (es.readyState !== EventSource.CLOSED) return;
        es.close();
        source = null;
        failures += 1;
        retryTimer = setTimeout(open, Math.min(RETRY_MAX_MS, RETRY_MIN_MS * Math.pow(2, failures - 1)));
      });
    }

    function shut() {
      clearTimeout(retryTimer);
      retryTimer = null;
      if (source) { source.close(); source = null; }
    }

    function onVisibility() {
      if (away()) { shut(); return; }
      changed();
      open();
    }

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('usernode:visibility-changed', function (e) {
      shellHidden = !!(e.detail && e.detail.hidden);
      onVisibility();
    });
    setInterval(function () { if (!away()) changed(); }, LOOK_MS);
    open();

    return { changed: changed };
  }

  window.LiveUpdates = { watch: watch };
})();
