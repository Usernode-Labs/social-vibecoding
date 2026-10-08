// The chore list screen. Talks to api.js; every request carries the
// platform token the frame was opened with, which is how the server knows
// who you are.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it, so a chore called "<b>hi</b>" shows exactly that.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var params = new URLSearchParams(window.location.search);
  var token = params.get('token') || '';
  // A staging preview's demo rota (`?demo=1`), passed on to the API.
  var demo = params.get('demo') === '1';

  var el = {
    form: document.getElementById('add-form'),
    status: document.getElementById('status'),
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    empty: document.getElementById('empty'),
    section: document.getElementById('week-section'),
    week: document.getElementById('week'),
    doneCount: document.getElementById('done-count'),
    chores: document.getElementById('chores'),
    rotaNote: document.getElementById('rota-note'),
  };

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

  /** A tiny element builder: h('p', 'text-small', 'Hello'). */
  function h(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** A small "x" drawn as an SVG, for remove buttons. */
  function crossIcon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('class', 'h-5 w-5');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M5 5l10 10M15 5L5 15');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.75');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
    return svg;
  }

  function showStatus(err) {
    el.status.textContent = err ? err.message : '';
    el.status.hidden = !err;
  }

  function act(promise) {
    return promise.then(function () { showStatus(null); return load(); }).catch(showStatus);
  }

  function who(username, me) {
    return me && username === me.username ? 'you' : '@' + username;
  }

  function choreRow(chore, me) {
    var row = h('li', 'list-row py-2 pr-2');
    row.setAttribute('data-chore', String(chore.id));

    var label = h('label', 'flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-1');
    var box = h('input', 'h-6 w-6 shrink-0 accent-accent');
    box.type = 'checkbox';
    box.checked = chore.done;
    box.setAttribute('aria-label', (chore.done ? 'Not done: ' : 'Done: ') + chore.name);
    box.addEventListener('change', function () {
      act(api('PUT', '/api/chores/' + chore.id + '/done', { done: box.checked }));
    });
    label.appendChild(box);

    var text = h('span', 'flex min-w-0 flex-col');
    text.appendChild(h('span', chore.done ? 'text-body text-muted line-through break-words' : 'text-body break-words', chore.name));
    var line = h('span', 'text-small text-muted');
    if (chore.turn) {
      var turn = h('span', chore.yours && !chore.done ? 'font-medium text-accent' : '',
        chore.yours ? 'Your turn' : '@' + chore.turn + '\'s turn');
      turn.setAttribute('data-turn', chore.turn);
      line.appendChild(turn);
    }
    var rest = chore.done
      ? 'done by ' + who(chore.doneBy, me)
      : (chore.next ? 'next week ' + who(chore.next, me) : '');
    if (rest && chore.turn) rest = ' · ' + rest;
    else if (rest) rest = rest.charAt(0).toUpperCase() + rest.slice(1);
    if (rest) line.appendChild(document.createTextNode(rest));
    if (line.childNodes.length) text.appendChild(line);
    label.appendChild(text);
    row.appendChild(label);

    var remove = h('button', 'btn-secondary shrink-0 border-0 bg-transparent px-0 text-muted');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Take ' + chore.name + ' off the list');
    remove.appendChild(crossIcon());
    remove.addEventListener('click', function () {
      if (window.confirm('Take "' + chore.name + '" off the chore list for everyone?')) {
        act(api('DELETE', '/api/chores/' + chore.id));
      }
    });
    row.appendChild(remove);
    return row;
  }

  // ── Loading, empty, error ──────────────────────────────────────────────

  function show(state) {
    el.loading.hidden = state !== 'loading';
    el.error.hidden = state !== 'error';
    el.section.hidden = state !== 'ready';
  }

  function rank(chore) {
    if (chore.done) return 2;
    return chore.yours ? 0 : 1;
  }

  function render(data) {
    var monday = new Date(data.week + 'T00:00:00Z');
    el.week.textContent = 'Week of ' + monday.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
    var chores = data.chores.slice().sort(function (a, b) { return rank(a) - rank(b); });
    el.chores.textContent = '';
    chores.forEach(function (c) { el.chores.appendChild(choreRow(c, data.me)); });
    el.chores.hidden = !chores.length;
    el.empty.hidden = !!chores.length;
    var done = chores.filter(function (c) { return c.done; }).length;
    el.doneCount.textContent = chores.length ? done + ' of ' + chores.length + ' done' : '';

    var note = '';
    if (chores.length && data.rota === 'not_member') note = 'Join this project to be on the rota: turns go round its members.';
    else if (chores.length && data.rota === 'unavailable') note = 'Whose turn it is shows once the member list loads. Try again in a minute.';
    else if (chores.length && data.people === 1) note = 'You are the only one here so far, so every chore is yours. Invite people to share them.';
    el.rotaNote.textContent = note;
    el.rotaNote.hidden = !note;
    show('ready');
  }

  var loaded = false;
  var loading = null;
  function load() {
    if (loading) return loading;
    loading = api('GET', '/api/chores' + (demo ? '?demo=1' : ''))
      .then(function (data) { loaded = true; render(data); })
      .catch(function (err) {
        // A refresh that fails keeps what is on screen; only a first load
        // with nothing to show turns into the error state.
        if (loaded) showStatus(err);
        else show('error');
      })
      .then(function () { loading = null; });
    return loading;
  }

  el.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = el.form.elements.name;
    if (!input.value.trim()) return;
    act(api('POST', '/api/chores', { name: input.value }).then(function () { el.form.reset(); }));
  });
  document.getElementById('retry').addEventListener('click', function () { show('loading'); load(); });

  // Other people tick chores off too: look again every 30 seconds while the
  // app is on screen, and straight away when it comes back. Skipped while
  // someone is typing, so a refresh never interrupts them.
  setInterval(function () {
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT'
      && document.activeElement.type === 'text' && document.activeElement.value;
    if (!document.hidden && !typing) load();
  }, 30000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });

  load();
})();
