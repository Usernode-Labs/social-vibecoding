// The lending library screen. Talks to api.js; every request carries the
// platform token the frame was opened with, which is how the server knows
// who you are.
//
// Each thing says who has it now. Ask for one and you join the line; whoever
// has it hands it on to the first person who asked (or anyone else in the
// line), and its owner can always say it is back with them.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it, so a thing called "<b>hi</b>" shows exactly that.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';

  var el = {
    form: document.getElementById('add-form'),
    status: document.getElementById('status'),
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    empty: document.getElementById('empty'),
    section: document.getElementById('shelf-section'),
    shelf: document.getElementById('shelf'),
    count: document.getElementById('shelf-count'),
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

  function button(className, text, onClick) {
    var b = h('button', className, text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  /**
   * A tap that cannot be undone asks for a second one. window.confirm() is no
   * use here: Homeroom's app frame does not allow dialogs, so it returns false
   * without showing anything. The first tap says what the second will do, and
   * the button goes back to how it was after a few seconds.
   */
  function tapTwice(btn, armedLabel, action) {
    var timer = null;
    var resting = null;
    var label = null;
    var className = null;
    function rest() {
      timer = null;
      btn.textContent = '';
      resting.forEach(function (n) { btn.appendChild(n); });
      if (label) btn.setAttribute('aria-label', label);
      btn.className = className;
    }
    btn.addEventListener('click', function () {
      if (timer) {
        clearTimeout(timer);
        rest();
        action();
        return;
      }
      resting = Array.prototype.slice.call(btn.childNodes);
      label = btn.getAttribute('aria-label');
      className = btn.className;
      btn.textContent = armedLabel;
      btn.setAttribute('aria-label', armedLabel);
      btn.className = 'btn-secondary shrink-0 whitespace-nowrap border-0 bg-transparent px-2 text-small text-danger';
      timer = setTimeout(rest, 4000);
    });
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

  function day(iso) {
    return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function showStatus(err) {
    el.status.textContent = err ? err.message : '';
    el.status.hidden = !err;
  }

  function act(promise) {
    return promise.then(function () { showStatus(null); return load(); }).catch(function (err) { showStatus(err); return load(); });
  }

  function at(username, me) { return me && username === me.username ? 'you' : '@' + username; }

  function whereItIs(thing) {
    if (thing.atHome) return thing.mine ? 'On your shelf' : 'On @' + thing.owner + '\'s shelf';
    var who = thing.withMe ? 'You have it' : '@' + thing.holder + ' has it';
    return (thing.mine ? 'Lent by you · ' : '') + who + ' since ' + day(thing.since);
  }

  function askLine(thing, me) {
    if (!thing.asks.length) return null;
    var names = thing.asks.map(function (a) { return at(a.username, me); });
    var all = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
    return 'Asked for by ' + all;
  }

  function thingRow(thing, me) {
    var row = h('li', 'flex flex-col gap-2 px-4 py-3');
    row.setAttribute('data-thing', String(thing.id));
    row.setAttribute('data-status', thing.atHome ? 'home' : 'out');

    var top = h('div', 'flex items-start gap-3');
    var text = h('div', 'min-w-0 flex-1');
    text.appendChild(h('p', 'text-body font-medium break-words', thing.name));
    if (thing.note) text.appendChild(h('p', 'text-small text-muted break-words', thing.note));
    text.appendChild(h('p', 'text-small text-muted', whereItIs(thing)));
    var asks = askLine(thing, me);
    if (asks) {
      var asked = h('p', thing.withMe ? 'text-small font-medium text-accent' : 'text-small text-muted', asks);
      asked.setAttribute('data-asks', String(thing.asks.length));
      text.appendChild(asked);
    }
    top.appendChild(text);

    if (thing.mine && thing.atHome) {
      var remove = button('btn-secondary shrink-0 border-0 bg-transparent px-0 text-muted');
      remove.setAttribute('aria-label', 'Take ' + thing.name + ' out of the library');
      remove.appendChild(crossIcon());
      tapTwice(remove, 'Tap again', function () { act(api('DELETE', '/api/things/' + thing.id)); });
      top.appendChild(remove);
    }
    row.appendChild(top);

    // What you can do with it, from where you stand.
    var actions = h('div', 'flex flex-wrap items-center gap-2');
    if (thing.withMe || thing.mine) {
      thing.asks.slice(0, 3).forEach(function (a) {
        actions.appendChild(button('btn-secondary', 'Hand to @' + a.username, function () {
          act(api('POST', '/api/things/' + thing.id + '/hand', { to: a.id }));
        }));
      });
    }
    if (!thing.atHome && thing.mine && !thing.withMe) {
      actions.appendChild(button('btn-secondary border-0 bg-transparent px-2 text-muted', 'It\'s back with me', function () {
        act(api('POST', '/api/things/' + thing.id + '/back'));
      }));
    }
    if (!thing.atHome && thing.withMe && !thing.mine) {
      actions.appendChild(button('btn-secondary border-0 bg-transparent px-2 text-muted', 'I gave it back to @' + thing.owner, function () {
        act(api('POST', '/api/things/' + thing.id + '/back'));
      }));
    }
    if (!thing.withMe && me) {
      actions.appendChild(thing.askedByMe
        ? button('btn-secondary border-0 bg-transparent px-2 text-muted', 'Take back my ask', function () {
          act(api('DELETE', '/api/things/' + thing.id + '/ask'));
        })
        : button('btn-secondary', 'Ask for it', function () {
          act(api('POST', '/api/things/' + thing.id + '/ask'));
        }));
    }
    if (actions.childNodes.length) row.appendChild(actions);
    return row;
  }

  // ── Loading, empty, error ──────────────────────────────────────────────

  function show(state) {
    el.loading.hidden = state !== 'loading';
    el.error.hidden = state !== 'error';
    el.section.hidden = state !== 'ready';
  }

  function render(data) {
    el.shelf.textContent = '';
    data.things.forEach(function (t) { el.shelf.appendChild(thingRow(t, data.me)); });
    el.shelf.hidden = !data.things.length;
    el.empty.hidden = !!data.things.length;
    var out = data.things.filter(function (t) { return !t.atHome; }).length;
    el.count.textContent = data.things.length
      ? data.things.length + (data.things.length === 1 ? ' thing' : ' things') + (out ? ' · ' + out + ' lent out' : '')
      : '';
    show('ready');
  }

  var loaded = false;
  var loading = null;
  function load() {
    if (loading) return loading;
    loading = api('GET', '/api/things')
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
    var name = el.form.elements.name;
    if (!name.value.trim()) return;
    act(api('POST', '/api/things', { name: name.value, note: el.form.elements.note.value }).then(function () { el.form.reset(); }));
  });
  document.getElementById('retry').addEventListener('click', function () { show('loading'); load(); });

  // Other people ask and hand things on too: look again every 20 seconds
  // while the app is on screen, and straight away when it comes back.
  // Skipped while someone is typing.
  setInterval(function () {
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.value;
    if (!document.hidden && !typing) load();
  }, 20000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });

  load();
})();
