// The Hyrox training screen: the race's eight stations and eight runs, a
// form that logs a session, and your log, yours alone.
//
// Rendering sets textContent, never innerHTML, so nothing on the page is
// built from a response's text. Class names are whole literals so the
// Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';

  var el = {
    logForm: document.getElementById('log-form'),
    logError: document.getElementById('log-error'),
    sessions: document.getElementById('sessions'),
    week: document.getElementById('week'),
    sessionsLoading: document.getElementById('sessions-loading'),
    sessionsEmpty: document.getElementById('sessions-empty'),
    sessionsGuest: document.getElementById('sessions-guest'),
    sessionsError: document.getElementById('sessions-error'),
    sessionsList: document.getElementById('sessions-list'),
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

  // The zone the device reports, so the week and "today" read where the
  // person is. Unknown or missing, it is UTC.
  function deviceZone() {
    try {
      var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return zone && zone.length <= 64 ? zone : 'UTC';
    } catch (err) { return 'UTC'; }
  }

  // ── Your sessions ─────────────────────────────────────────────────────

  var me; // who the server says you are, once the log has loaded

  function show(which) {
    el.sessionsLoading.hidden = which !== 'loading';
    el.sessionsEmpty.hidden = which !== 'empty';
    el.sessionsGuest.hidden = which !== 'guest';
    el.sessionsError.hidden = which !== 'error';
    el.sessionsList.hidden = which !== 'list';
  }

  // "Today 14:05", "Yesterday 09:00" or "12 Oct", where the person is.
  function whenOf(iso) {
    var at = new Date(iso);
    var zone = deviceZone();
    var day = function (d) {
      return new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric' }).format(d);
    };
    var time = function (d) {
      return new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(d);
    };
    var nowDay = now().toLocaleDateString('en-US', { timeZone: zone });
    var atDay = at.toLocaleDateString('en-US', { timeZone: zone });
    var yesterday = new Date(now().getTime() - 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { timeZone: zone });
    if (atDay === nowDay) return 'Today ' + time(at);
    if (atDay === yesterday) return 'Yesterday ' + time(at);
    return day(at);
  }

  // A row is built once, by hand, and its text goes in as text: the note is
  // what somebody typed, never something the page turns into markup.
  function sessionRow(session) {
    var row = document.createElement('div');
    row.className = 'flex items-start justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0';
    row.setAttribute('data-session', String(session.id));

    var main = document.createElement('div');
    main.className = 'flex flex-col gap-0.5';
    var name = document.createElement('span');
    name.className = 'text-body';
    name.textContent = session.workout;
    var detail = document.createElement('span');
    detail.className = 'text-small text-muted';
    detail.textContent = session.minutes + ' min · ' + whenOf(session.doneAt) + (session.note ? ' · ' + session.note : '');
    main.appendChild(name);
    main.appendChild(detail);
    row.appendChild(main);

    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn-secondary text-small';
    remove.setAttribute('data-remove', String(session.id));
    remove.setAttribute('aria-label', 'Remove this session');
    remove.textContent = 'Remove';
    row.appendChild(remove);
    return row;
  }

  function renderSessions(data) {
    el.sessions.setAttribute('data-loaded', 'yes');
    me = data.me;
    if (!me) { show('guest'); return; }
    if (data.week && data.week.count > 0) {
      el.week.hidden = false;
      el.week.textContent = 'This week: ' + data.week.count + (data.week.count === 1 ? ' session, ' : ' sessions, ')
        + data.week.minutes + ' minutes in total.';
    } else {
      el.week.hidden = true;
    }
    if (!data.sessions.length) { show('empty'); return; }
    el.sessionsList.replaceChildren.apply(el.sessionsList, data.sessions.map(sessionRow));
    show('list');
  }

  function load() {
    return api('GET', '/api/sessions?tz=' + encodeURIComponent(deviceZone()))
      .then(function (data) { renderSessions(data); })
      .catch(function () { me = undefined; show('error'); });
  }

  el.retry.addEventListener('click', function () {
    show('loading');
    load();
  });

  // ── Logging a session ─────────────────────────────────────────────────

  function sayLogError(text) {
    el.logError.textContent = text;
    el.logError.hidden = false;
  }

  el.logForm.addEventListener('submit', function (event) {
    event.preventDefault();
    el.logError.hidden = true;
    var minutes = Number.parseInt(el.logForm.elements.minutes.value, 10);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600) {
      sayLogError('How many minutes did it take? A whole number from 1 to 600.');
      return;
    }
    var body = {
      workout: el.logForm.elements.workout.value,
      minutes: minutes,
      note: el.logForm.elements.note.value,
      tz: deviceZone(),
    };
    el.logForm.querySelector('button[type="submit"]').disabled = true;
    api('POST', '/api/sessions', body)
      .then(function () {
        el.logForm.elements.note.value = '';
        el.logForm.elements.minutes.value = '';
        return load();
      })
      .catch(function (err) { sayLogError(err.message || 'That session could not be logged. Try again in a moment.'); })
      .finally(function () { el.logForm.querySelector('button[type="submit"]').disabled = false; });
  });

  // Taking a session back: the row's own Remove button. Yours only, and the
  // server takes only yours even if another id were sent.
  el.sessionsList.addEventListener('click', function (event) {
    var button = event.target.closest('[data-remove]');
    if (!button) return;
    button.disabled = true;
    api('DELETE', '/api/sessions/' + button.getAttribute('data-remove'))
      .then(function () { return load(); })
      .catch(function (err) {
        button.disabled = false;
        sayLogError(err.message || 'That session could not be removed. Try again in a moment.');
      });
  });

  // ── Boot: the race is already there; the log loads ────────────────────

  load();
})();
