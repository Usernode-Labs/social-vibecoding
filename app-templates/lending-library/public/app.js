// The lending library screen. Talks to api.js; every request carries the
// platform token the frame was opened with, which is how the server knows
// who you are.
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

  // The thing whose "how long?" choice is open, if any.
  var choosing = null;
  var last = null;

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
    b.addEventListener('click', onClick);
    return b;
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
    choosing = null;
    return promise.then(function () { showStatus(null); return load(); }).catch(showStatus);
  }

  function statusLine(thing) {
    var line = h('p', 'text-small text-muted');
    var whose = thing.mine ? 'Yours' : 'Lent by @' + thing.owner;
    if (!thing.out) {
      line.textContent = whose + ' · on the shelf';
      return line;
    }
    var holder = thing.borrowedByMe ? 'You have it' : 'With @' + thing.borrower;
    line.textContent = (thing.borrowedByMe ? '' : whose + ' · ') + holder + ' · ';
    line.appendChild(thing.overdue
      ? h('span', 'font-medium text-danger', 'overdue since ' + day(thing.due))
      : document.createTextNode('due back ' + day(thing.due)));
    return line;
  }

  function thingRow(thing, me) {
    var row = h('li', 'flex flex-col gap-2 px-4 py-3');
    row.setAttribute('data-thing', String(thing.id));
    row.setAttribute('data-status', thing.out ? 'out' : 'in');

    var top = h('div', 'flex items-center gap-3');
    var text = h('div', 'min-w-0 flex-1');
    text.appendChild(h('p', 'text-body font-medium break-words', thing.name));
    if (thing.note) text.appendChild(h('p', 'text-small text-muted break-words', thing.note));
    text.appendChild(statusLine(thing));
    top.appendChild(text);

    if (thing.out && thing.borrowedByMe) {
      top.appendChild(button('btn-secondary shrink-0', 'Return', function () {
        act(api('POST', '/api/things/' + thing.id + '/return'));
      }));
    } else if (thing.out && thing.mine) {
      top.appendChild(button('btn-secondary shrink-0', 'It\'s back', function () {
        act(api('POST', '/api/things/' + thing.id + '/return'));
      }));
    } else if (!thing.out && thing.mine) {
      var remove = button('btn-secondary shrink-0 border-0 bg-transparent px-0 text-muted', null, function () {
        if (window.confirm('Take "' + thing.name + '" out of the library?')) act(api('DELETE', '/api/things/' + thing.id));
      });
      remove.setAttribute('aria-label', 'Take ' + thing.name + ' out of the library');
      remove.appendChild(crossIcon());
      top.appendChild(remove);
    } else if (!thing.out && me && choosing !== thing.id) {
      top.appendChild(button('btn-secondary shrink-0', 'Borrow', function () {
        choosing = thing.id;
        render(last);
      }));
    }
    row.appendChild(top);

    // How long for: a week, two weeks or a month.
    if (!thing.out && choosing === thing.id) {
      var choices = h('div', 'flex items-center gap-2');
      choices.setAttribute('role', 'group');
      choices.setAttribute('aria-label', 'Borrow ' + thing.name + ' for how long?');
      [[7, '1 week'], [14, '2 weeks'], [28, 'A month']].forEach(function (c) {
        choices.appendChild(button('btn-secondary flex-1 whitespace-nowrap px-2', c[1], function () {
          act(api('POST', '/api/things/' + thing.id + '/borrow', { days: c[0] }));
        }));
      });
      var cancel = button('btn-secondary shrink-0 border-0 bg-transparent px-0 text-muted', null, function () { choosing = null; render(last); });
      cancel.setAttribute('aria-label', 'Cancel');
      cancel.appendChild(crossIcon());
      choices.appendChild(cancel);
      row.appendChild(choices);
    }
    return row;
  }

  // ── Loading, empty, error ──────────────────────────────────────────────

  function show(state) {
    el.loading.hidden = state !== 'loading';
    el.error.hidden = state !== 'error';
    el.section.hidden = state !== 'ready';
  }

  function render(data) {
    last = data;
    el.shelf.textContent = '';
    data.things.forEach(function (t) { el.shelf.appendChild(thingRow(t, data.me)); });
    el.shelf.hidden = !data.things.length;
    el.empty.hidden = !!data.things.length;
    var out = data.things.filter(function (t) { return t.out; }).length;
    el.count.textContent = data.things.length
      ? data.things.length + (data.things.length === 1 ? ' thing' : ' things') + (out ? ' · ' + out + ' out' : '')
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

  // Other people borrow too: look again every 30 seconds while the app is
  // on screen, and straight away when it comes back. Skipped while someone
  // is typing or choosing how long to borrow something for.
  setInterval(function () {
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.value;
    if (!document.hidden && !typing && choosing === null) load();
  }, 30000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && choosing === null) load(); });

  load();
})();
