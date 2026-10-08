// The grocery list screen. Talks to api.js; every request carries the
// platform token the frame was opened with, which is how the server knows
// who you are.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it, so an item called "<b>hi</b>" shows exactly that.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';

  var el = {
    form: document.getElementById('add-form'),
    status: document.getElementById('status'),
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    empty: document.getElementById('empty'),
    neededSection: document.getElementById('needed-section'),
    needed: document.getElementById('needed'),
    neededCount: document.getElementById('needed-count'),
    boughtSection: document.getElementById('bought-section'),
    bought: document.getElementById('bought'),
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

  function itemRow(item) {
    var row = h('li', 'list-row py-2 pr-2');
    row.setAttribute('data-item', String(item.id));

    var label = h('label', 'flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-1');
    var box = h('input', 'h-6 w-6 shrink-0 accent-accent');
    box.type = 'checkbox';
    box.checked = item.bought;
    box.addEventListener('change', function () {
      act(api('PUT', '/api/items/' + item.id + '/bought', { bought: box.checked }));
    });
    label.appendChild(box);

    var text = h('span', 'flex min-w-0 flex-col');
    var name = h('span', item.bought ? 'text-body text-muted line-through break-words' : 'text-body break-words', item.name);
    if (item.note) {
      name.appendChild(document.createTextNode(' '));
      name.appendChild(h('span', 'text-muted', '(' + item.note + ')'));
    }
    text.appendChild(name);
    text.appendChild(h('span', 'text-small text-muted', item.bought
      ? 'Bought by ' + (item.boughtBy ? '@' + item.boughtBy : 'someone')
      : (item.mine ? 'Added by you' : 'Added by @' + item.by)));
    label.appendChild(text);
    row.appendChild(label);

    var remove = h('button', 'btn-secondary shrink-0 border-0 bg-transparent px-0 text-muted');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Take ' + item.name + ' off the list');
    remove.appendChild(crossIcon());
    remove.addEventListener('click', function () { act(api('DELETE', '/api/items/' + item.id)); });
    row.appendChild(remove);
    return row;
  }

  // ── Loading, empty, error ──────────────────────────────────────────────

  function show(state) {
    el.loading.hidden = state !== 'loading';
    el.error.hidden = state !== 'error';
    el.neededSection.hidden = state !== 'ready';
    if (state !== 'ready') el.boughtSection.hidden = true;
  }

  function render(data) {
    var needed = data.items.filter(function (i) { return !i.bought; });
    var bought = data.items.filter(function (i) { return i.bought; });
    el.needed.textContent = '';
    needed.forEach(function (i) { el.needed.appendChild(itemRow(i)); });
    el.needed.hidden = !needed.length;
    el.empty.hidden = !!needed.length;
    el.neededCount.textContent = needed.length ? needed.length + (needed.length === 1 ? ' thing' : ' things') : '';
    el.bought.textContent = '';
    bought.forEach(function (i) { el.bought.appendChild(itemRow(i)); });
    el.boughtSection.hidden = !bought.length;
    show('ready');
  }

  var loaded = false;
  var loading = null;
  function load() {
    if (loading) return loading;
    loading = api('GET', '/api/items')
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
    act(api('POST', '/api/items', { name: name.value, note: el.form.elements.note.value }).then(function () {
      el.form.reset();
      name.focus();
    }));
  });
  document.getElementById('clear-bought').addEventListener('click', function () {
    act(api('POST', '/api/items/clear-bought'));
  });
  document.getElementById('retry').addEventListener('click', function () { show('loading'); load(); });

  // Other people shop too: look again every 15 seconds while the app is on
  // screen, and straight away when it comes back. Skipped while someone is
  // typing, so a refresh never interrupts them.
  setInterval(function () {
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT'
      && document.activeElement.type === 'text' && document.activeElement.value;
    if (!document.hidden && !typing) load();
  }, 15000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });

  load();
})();
