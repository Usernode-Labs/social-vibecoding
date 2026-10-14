// The game room, from the page: one live connection to the server
// (game/live.js), and, while that cannot be made, asking every couple of
// seconds instead (GET /api/room). It keeps the room's latest view and tells
// the game when anything moves.
//
//   var room = GameRoom.connect({
//     onView: function (view) {},    // the room changed (game/room.js viewFor)
//     onFrame: function (frame) {},  // a live game's moving parts
//     onEvent: function (event) {},  // one small change (a block placed)
//     onError: function (message) {},// a move the server refused
//     onStatus: function (status) {},// 'live', 'asking' or 'offline'
//     onHidden: function (hidden) {},// Homeroom hid or showed the app (keep it quiet while hidden)
//     pollMs: 2000,                  // how often to ask without a live connection
//   });
//   room.view                       // the latest view
//   room.join(), room.leave(), room.start(), room.again()
//   room.act(action)                // a move; the server's rules check it
//   room.input(controls)            // a live game's controls, sent as they change
//   room.away()                     // nobody can see the game right now
//   GameRoom.api(method, url, body) // any other request, signed in
//
// Every request carries the platform token the frame was opened with, which
// is how the server knows who is playing.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';

  function api(method, url, body) {
    var headers = { 'x-usernode-token': token };
    // A preview opened at a chosen moment tells the server what time it is
    // there (req.now; "Time-dependent features" in the platform conventions).
    if (window.usernode && window.usernode.previewNow) headers['x-usernode-now'] = window.usernode.now().toISOString();
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        if (res.status === 204) return {};
        return res.json().catch(function () { return {}; }).then(function (d) {
          if (!res.ok) {
            throw new Error(d.error === 'account_required'
              ? 'Make an account to play.'
              : d.error || 'Something went wrong (' + res.status + ').');
          }
          return d;
        });
      });
  }

  function connect(opts) {
    opts = opts || {};
    var room = { view: null, status: 'offline' };
    var socket = null;
    var live = false;
    var failures = 0;
    var pollTimer = null;
    var retryTimer = null;
    var lastInput = 0;
    var pendingInput = null;
    var inputTimer = null;

    function setStatus(s) {
      if (room.status === s) return;
      room.status = s;
      if (opts.onStatus) opts.onStatus(s);
    }

    function setView(view) {
      if (!view) return;
      if (room.view && view.version < room.view.version) return;
      room.view = view;
      if (opts.onView) opts.onView(view);
    }

    function error(message) {
      if (opts.onError) opts.onError(message === 'account_required' ? 'Make an account to play.' : message);
    }

    // ── Asking, while there is no live connection ─────────────────────────

    function poll() {
      if (live || room.away()) return schedulePoll();
      api('GET', '/api/room').then(function (v) {
        setView(v);
        if (!live) setStatus('asking');
      }, function () {
        if (!live) setStatus('offline');
      }).then(schedulePoll);
    }

    function schedulePoll() {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, opts.pollMs || 2000);
    }

    // ── The live connection ───────────────────────────────────────────────

    function open() {
      clearTimeout(retryTimer);
      var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/live' +
        (token ? '?token=' + encodeURIComponent(token) : '');
      var ws;
      try { ws = new WebSocket(url); } catch (e) { return retry(); }
      socket = ws;
      ws.onopen = function () {
        live = true;
        failures = 0;
        setStatus('live');
      };
      ws.onmessage = function (e) {
        var msg;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        if (msg.t === 'view') setView(msg.view);
        else if (msg.t === 'frame' && opts.onFrame) opts.onFrame(msg.frame);
        else if (msg.t === 'event' && opts.onEvent) opts.onEvent(msg.event, msg.version);
        else if (msg.t === 'error') error(msg.error);
      };
      ws.onclose = function () {
        if (socket !== ws) return;
        socket = null;
        live = false;
        setStatus('asking');
        poll();
        retry();
      };
      ws.onerror = function () {};
    }

    // Try again soon, then less often: a few seconds, up to half a minute.
    function retry() {
      failures += 1;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(open, Math.min(30000, 1000 * Math.pow(2, failures)));
    }

    // ── Moves ─────────────────────────────────────────────────────────────

    function write(t, body, path) {
      if (live && socket && socket.readyState === 1) {
        socket.send(JSON.stringify(Object.assign({ t: t }, body || {})));
        return Promise.resolve();
      }
      return api('POST', '/api/room/' + path, body || {}).then(setView, function (err) { error(err.message); });
    }

    room.join = function () { return write('join', null, 'join'); };
    room.leave = function () { return write('leave', null, 'leave'); };
    room.start = function () { return write('start', null, 'start'); };
    room.again = function () { return write('again', null, 'again'); };
    room.act = function (action) { return write('act', { action: action }, 'act'); };

    // Controls go at most 20 times a second over the live connection, and 8
    // over plain requests; the newest wins.
    room.input = function (controls) {
      pendingInput = controls;
      if (inputTimer) return;
      var gap = live ? 50 : 125;
      var wait = Math.max(0, gap - (Date.now() - lastInput));
      inputTimer = setTimeout(function () {
        inputTimer = null;
        lastInput = Date.now();
        var c = pendingInput;
        pendingInput = null;
        if (live && socket && socket.readyState === 1) socket.send(JSON.stringify({ t: 'input', input: c }));
        else api('POST', '/api/room/input', { input: c }).catch(function () {});
      }, wait);
    };

    // Homeroom keeps the last few apps loaded but hidden; while this one is,
    // nobody can see it, so it stops asking (the platform conventions'
    // "Staying loaded in the background").
    var shellHidden = false;
    room.away = function () { return document.hidden || shellHidden; };
    window.addEventListener('usernode:visibility-changed', function (e) {
      shellHidden = !!(e.detail && e.detail.hidden);
      if (opts.onHidden) opts.onHidden(room.away());
      if (!room.away() && !live) poll();
    });
    // Back on screen: catch up at once.
    document.addEventListener('visibilitychange', function () {
      if (opts.onHidden) opts.onHidden(room.away());
      if (!room.away() && !live) poll();
    });

    // The first view comes over a plain request, so the screen fills even
    // before (or without) the live connection; then the connection opens.
    api('GET', '/api/room').then(function (v) {
      setView(v);
      setStatus('asking');
    }, function (err) {
      if (opts.onFailed) opts.onFailed(err);
    }).then(function () {
      open();
      schedulePoll();
    });

    return room;
  }

  window.GameRoom = { connect: connect, api: api };
})();
