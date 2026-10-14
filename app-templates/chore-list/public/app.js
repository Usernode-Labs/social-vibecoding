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
    who: document.getElementById('add-who'),
  };

  var current = null; // the last list read
  var editing = null; // the chore being changed, by id

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

  /**
   * A tap that cannot be undone asks for a second one. window.confirm() is no
   * use here: Homeroom's app frame does not allow dialogs, so it returns false
   * without showing anything. The first tap says what the second will do, and
   * the button goes back to how it was after a few seconds.
   */
  function tapTwice(button, armedLabel, action) {
    var timer = null;
    var resting = null;
    var label = null;
    var className = null;
    function rest() {
      timer = null;
      button.textContent = '';
      resting.forEach(function (n) { button.appendChild(n); });
      if (label) button.setAttribute('aria-label', label);
      button.className = className;
    }
    button.addEventListener('click', function () {
      if (timer) {
        clearTimeout(timer);
        rest();
        action();
        return;
      }
      resting = Array.prototype.slice.call(button.childNodes);
      label = button.getAttribute('aria-label');
      className = button.className;
      button.textContent = armedLabel;
      button.setAttribute('aria-label', armedLabel);
      button.className = 'btn-secondary shrink-0 whitespace-nowrap border-0 bg-transparent px-2 text-small text-danger';
      timer = setTimeout(rest, 4000);
    });
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

  function whoOptions(select, chosenId) {
    select.textContent = '';
    var turns = h('option', null, 'Takes turns');
    turns.value = '';
    select.appendChild(turns);
    (current ? current.members : []).forEach(function (m) {
      var o = h('option', null, current.me && m.id === current.me.id ? 'Always me' : 'Always @' + m.username);
      o.value = String(m.id);
      select.appendChild(o);
    });
    select.value = chosenId == null ? '' : String(chosenId);
  }

  function choreRow(chore, me) {
    if (editing === chore.id) return editRow(chore);
    var row = h('li', 'list-row py-2 pr-2');
    row.setAttribute('data-chore', String(chore.id));

    var tick = h('label', 'flex h-11 w-8 shrink-0 cursor-pointer items-center justify-center');
    var box = h('input', 'h-6 w-6 shrink-0 accent-accent');
    box.type = 'checkbox';
    box.checked = chore.done;
    box.setAttribute('aria-label', (chore.done ? 'Not done: ' : 'Done: ') + chore.name);
    box.addEventListener('change', function () {
      act(api('PUT', '/api/chores/' + chore.id + '/done', { done: box.checked }));
    });
    tick.appendChild(box);
    row.appendChild(tick);

    // The name is the way into renaming it or changing who does it.
    var text = h('button', 'flex min-w-0 flex-1 flex-col items-start py-1 text-left');
    text.type = 'button';
    text.setAttribute('aria-label', 'Change ' + chore.name);
    text.addEventListener('click', function () { editing = chore.id; render(current); });
    text.appendChild(h('span', chore.done ? 'text-body text-muted line-through break-words' : 'text-body break-words', chore.name));
    var line = h('span', 'text-small text-muted');
    if (chore.turn) {
      var words = chore.fixed
        ? (chore.yours ? 'Always yours' : 'Always @' + chore.turn)
        : (chore.yours ? 'Your turn' : '@' + chore.turn + '\'s turn');
      var turn = h('span', chore.yours && !chore.done ? 'font-medium text-accent' : '', words);
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
    row.appendChild(text);
    return row;
  }

  function editRow(chore) {
    var row = h('li', 'flex flex-col gap-2 px-4 py-3');
    row.setAttribute('data-chore', String(chore.id));
    var form = h('form', 'flex flex-col gap-2');
    form.setAttribute('autocomplete', 'off');
    var name = h('input', 'field');
    name.value = chore.name;
    name.maxLength = 80;
    name.required = true;
    name.setAttribute('aria-label', 'Chore');
    form.appendChild(name);
    var whoLine = h('div', 'flex items-center gap-2');
    whoLine.appendChild(h('span', 'shrink-0 px-1 text-small text-muted', 'Who does it'));
    var whoSelect = h('select', 'field min-w-0 flex-1');
    whoSelect.setAttribute('aria-label', 'Who does it');
    whoOptions(whoSelect, chore.fixed ? chore.turnId : null);
    whoLine.appendChild(whoSelect);
    form.appendChild(whoLine);
    var actions = h('div', 'flex flex-wrap items-center gap-2');
    var save = h('button', 'btn-primary', 'Save');
    save.type = 'submit';
    actions.appendChild(save);
    var cancel = h('button', 'btn-secondary', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', function () { editing = null; render(current); });
    actions.appendChild(cancel);
    var remove = h('button', 'btn-secondary ml-auto border-0 bg-transparent px-2 text-danger', 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Take ' + chore.name + ' off the list');
    tapTwice(remove, 'Tap again to remove', function () { editing = null; act(api('DELETE', '/api/chores/' + chore.id)); });
    actions.appendChild(remove);
    form.appendChild(actions);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!name.value.trim()) return;
      editing = null;
      act(api('PATCH', '/api/chores/' + chore.id + (demo ? '?demo=1' : ''), {
        name: name.value,
        assigneeId: whoSelect.value ? Number(whoSelect.value) : null,
      }));
    });
    row.appendChild(form);
    setTimeout(function () { name.focus(); }, 0);
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
    current = data;
    if (editing && !data.chores.some(function (c) { return c.id === editing; })) editing = null;
    if (document.activeElement !== el.who) whoOptions(el.who, el.who.value ? Number(el.who.value) : null);
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
    act(api('POST', '/api/chores' + (demo ? '?demo=1' : ''), {
      name: input.value,
      assigneeId: el.who.value ? Number(el.who.value) : null,
    }).then(function () { el.form.reset(); }));
  });
  document.getElementById('retry').addEventListener('click', function () { show('loading'); load(); });

  // Other people tick chores off too: look again every 30 seconds while the
  // app is on screen, and straight away when it comes back. Skipped while
  // someone is typing, so a refresh never interrupts them.
  setInterval(function () {
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT'
      && document.activeElement.type === 'text' && document.activeElement.value;
    if (!document.hidden && !typing && editing === null) load();
  }, 30000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && editing === null) load(); });

  load();
})();
