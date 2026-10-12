// The Study timer screen: one big Start button for a 25 minute focus
// session, a gentle beep when it ends, and how many sessions you finished
// today.
//
// The timer goes by the clock, not by counting seconds: a session ends at
// an absolute moment (endsAt), and the screen draws what is left of it
// whenever it looks. Lock the phone or leave the tab in the background and
// the session still ends at the right moment; on coming back it is already
// finished and counted, and the beep plays if it ended less than a minute
// ago. A page closed mid-session picks the session up again on reload.
//
// A session that runs out is counted once, per person, on the server: the
// page sends the key it made when the session started, and the same key
// twice is one session. One that could not be posted (offline at the end)
// stays on the device and is posted as soon as the connection is back.
// Reset never counts anything.
//
// Rendering sets textContent, never innerHTML, so nothing on the page is
// built from a response's text. Class names are whole literals so the
// Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';
  var SESSION_MS = 25 * 60 * 1000;
  var SESSION_KEY = 'study-timer:session';
  var PENDING_KEY = 'study-timer:pending';

  var el = {
    timer: document.getElementById('timer'),
    clock: document.getElementById('clock'),
    status: document.getElementById('timer-status'),
    start: document.getElementById('start'),
    reset: document.getElementById('reset'),
    today: document.getElementById('today'),
    todayLoading: document.getElementById('today-loading'),
    todayCard: document.getElementById('today-card'),
    todayCount: document.getElementById('today-count'),
    todayMinutes: document.getElementById('today-minutes'),
    todayEmpty: document.getElementById('today-empty'),
    todayGuest: document.getElementById('today-guest'),
    todayError: document.getElementById('today-error'),
    retry: document.getElementById('retry'),
  };

  // "Now" as the platform sees it: a preview opened at a chosen moment says
  // what time it is there, and everything here reads it through this.
  function now() {
    return window.usernode && window.usernode.now ? window.usernode.now() : new Date();
  }

  function api(method, url, body) {
    var headers = { 'x-usernode-token': token };
    // A preview opened at a chosen moment tells the server what time it is
    // there (req.now; "Time-dependent features" in the platform conventions).
    if (window.usernode && window.usernode.previewNow) headers['x-usernode-now'] = window.usernode.now().toISOString();
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) {
            throw new Error(data.error === 'account_required'
              ? 'Make an account to join in.'
              : data.error || 'Something went wrong (' + res.status + ').');
          }
          return data;
        });
      });
  }

  // ── The session, kept on the device ───────────────────────────────────

  var session = readState();

  function readState() {
    try {
      var saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (saved && (saved.state === 'running' || saved.state === 'paused' || saved.state === 'done')) return saved;
    } catch (err) { /* A note that will not parse is no note. */ }
    return { state: 'ready' };
  }

  function save() {
    try {
      if (session.state === 'ready') localStorage.removeItem(SESSION_KEY);
      else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (err) { /* Storage off: the timer still runs, the count still loads. */ }
  }

  // A key made when the session starts. The server counts the same key
  // once, however many times a retry sends it.
  function makeKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function fmt(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return (minutes < 10 ? '0' : '') + minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
  }

  function draw() {
    el.timer.setAttribute('data-state', session.state);
    if (session.state === 'running') {
      el.clock.textContent = fmt(session.endsAt - now().getTime());
      el.status.textContent = 'Focusing';
      el.start.textContent = 'Pause';
      el.reset.hidden = false;
    } else if (session.state === 'paused') {
      el.clock.textContent = fmt(session.remainingMs);
      el.status.textContent = 'Paused';
      el.start.textContent = 'Resume';
      el.reset.hidden = false;
    } else if (session.state === 'done') {
      el.clock.textContent = fmt(SESSION_MS);
      el.status.textContent = 'Session done. Nice work.';
      el.start.textContent = 'Start another';
      el.reset.hidden = true;
    } else {
      el.clock.textContent = fmt(SESSION_MS);
      el.status.textContent = 'Ready when you are';
      el.start.textContent = 'Start';
      el.reset.hidden = true;
    }
  }

  // The big button: Start, then Pause, then Resume, then Start another.
  // Starting and resuming happen inside the tap, which is also where the
  // AudioContext is made or woken: a phone keeps a tone silent unless the
  // gesture that turns it on was a real tap.
  el.start.addEventListener('click', function () {
    if (session.state === 'running') {
      session.remainingMs = session.endsAt - now().getTime();
      session.state = 'paused';
    } else {
      unlockAudio();
      var rest = session.state === 'paused' ? session.remainingMs : SESSION_MS;
      if (session.state !== 'paused') session.key = makeKey();
      session.endsAt = now().getTime() + rest;
      session.remainingMs = null;
      session.state = 'running';
    }
    save();
    draw();
  });

  // Back to 25:00, and nothing counted.
  el.reset.addEventListener('click', function () {
    session = { state: 'ready' };
    save();
    draw();
  });

  // ── The clock, read rather than counted ───────────────────────────────

  function tick() {
    if (session.state !== 'running') return;
    var left = session.endsAt - now().getTime();
    if (left <= 0) { finish(); return; }
    el.clock.textContent = fmt(left);
    rollDay();
  }

  setInterval(tick, 250);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });

  function finish() {
    var key = session.key;
    var endedAt = session.endsAt;
    session = { state: 'done' };
    if (key) pend(key);
    save();
    draw();
    // A phone that was locked may have kept the tone quiet; if the session
    // ended while nobody was looking (more than a minute ago), stay quiet
    // rather than beep into the room late.
    if (now().getTime() - endedAt < 60000) beep();
    flush();
  }

  // ── Sessions waiting to be counted ────────────────────────────────────

  function pending() {
    try {
      var list = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (err) { return []; }
  }

  function pend(key) {
    var list = pending();
    if (list.indexOf(key) === -1) list.push(key);
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch (err) { /* stays here only */ }
  }

  function unpend(key) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(pending().filter(function (k) { return k !== key; }))); }
    catch (err) { /* tried again next time */ }
  }

  // Post every session still waiting. Runs on load, when a session ends and
  // on Retry; one that fails stays pending and goes with the next try.
  function flush() {
    var list = pending();
    if (!list.length || me === undefined) return;
    if (!me) { list.forEach(unpend); return; } // a guest's sessions are not counted
    var zone = deviceZone();
    list.forEach(function (key) {
      api('POST', '/api/sessions', { key: key, tz: zone })
        .then(function () { unpend(key); loadToday(); })
        .catch(function () { /* stays pending; posted on the next try */ });
    });
  }

  // ── The beep: two soft notes, made by the browser ─────────────────────

  var audio = null;

  function unlockAudio() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return; // no AudioContext: the app stays silent, and works
      if (!audio) audio = new Ctx();
      if (audio.state === 'suspended') audio.resume();
    } catch (err) { audio = null; }
  }

  function beep() {
    if (!audio) return;
    try {
      var t = audio.currentTime;
      [[880, 0], [660, 0.3]].forEach(function (note) {
        var osc = audio.createOscillator();
        var gain = audio.createGain();
        osc.type = 'sine';
        osc.frequency.value = note[0];
        gain.gain.setValueAtTime(0, t + note[1]);
        gain.gain.linearRampToValueAtTime(0.15, t + note[1] + 0.05);
        gain.gain.linearRampToValueAtTime(0, t + note[1] + 0.25);
        osc.connect(gain);
        gain.connect(audio.destination);
        osc.start(t + note[1]);
        osc.stop(t + note[1] + 0.3);
      });
    } catch (err) { /* silence is fine */ }
  }

  // ── Today's count ─────────────────────────────────────────────────────

  var me; // who the server says you are, once the count has loaded

  function showToday(which) {
    el.todayLoading.hidden = which !== 'loading';
    el.todayCard.hidden = which !== 'count';
    el.todayEmpty.hidden = which !== 'empty';
    el.todayGuest.hidden = which !== 'guest';
    el.todayError.hidden = which !== 'error';
  }

  function renderToday(data) {
    el.today.setAttribute('data-loaded', 'yes');
    me = data.me;
    if (!me) { showToday('guest'); return; }
    if (data.count > 0) {
      el.todayCount.textContent = data.count === 1 ? '1 session finished today' : data.count + ' sessions finished today';
      el.todayMinutes.textContent = 'That’s ' + (data.count * 25) + ' minutes of focus.';
      showToday('count');
    } else {
      showToday('empty');
    }
  }

  function loadToday() {
    return api('GET', '/api/today?tz=' + encodeURIComponent(deviceZone()))
      .then(function (data) { renderToday(data); flush(); })
      .catch(function () { me = undefined; showToday('error'); });
  }

  el.retry.addEventListener('click', function () {
    showToday('loading');
    loadToday();
  });

  // The day the count is for: when it changes under the ticking (midnight,
  // where you are), fetch again so it starts from zero.
  var dayLoaded = null;
  function rollDay() {
    var today = now().toLocaleDateString();
    if (dayLoaded === null) dayLoaded = today;
    else if (dayLoaded !== today) {
      dayLoaded = today;
      loadToday();
    }
  }

  // The zone the device reports, so the server counts the day where the
  // person is. Unknown or missing, it is UTC.
  function deviceZone() {
    try {
      var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return zone && zone.length <= 64 ? zone : 'UTC';
    } catch (err) { return 'UTC'; }
  }

  // ── Boot: draw at once, then the count ────────────────────────────────

  draw();
  // A session that ran out while the page was closed is finished now, and
  // its count goes up with the first load.
  if (session.state === 'running' && session.endsAt - now().getTime() <= 0) finish();
  loadToday();
  if (session.state === 'running') dayLoaded = now().toLocaleDateString();
})();
