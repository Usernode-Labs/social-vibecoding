// The grocery list screen. Talks to api.js; every request carries the
// platform token the frame was opened with, which is how the server knows
// who you are.
//
// The list is sorted into aisles, in the order the group's store is laid
// out. A ticked item stays where it is, struck through, so the list does not
// jump while somebody is shopping; "Clear bought" tidies it afterwards. Tap
// an item's name to change it, its note or its aisle. Which aisles are
// folded away is remembered on this device.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it, so an item called "<b>hi</b>" shows exactly that.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';

  var el = {
    form: document.getElementById('add-form'),
    aisle: document.getElementById('add-aisle'),
    status: document.getElementById('status'),
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    empty: document.getElementById('empty'),
    aisles: document.getElementById('aisles'),
    tools: document.getElementById('tools'),
    clear: document.getElementById('clear-bought'),
    arrange: document.getElementById('arrange'),
    arranger: document.getElementById('arranger'),
    aisleList: document.getElementById('aisle-list'),
    aisleForm: document.getElementById('aisle-form'),
    activity: document.getElementById('activity'),
    activityLine: document.getElementById('activity-line'),
    activityToggle: document.getElementById('activity-toggle'),
    activityList: document.getElementById('activity-list'),
  };

  var data = null;
  var editing = null; // the item being edited, by id
  var arranging = false;
  var aisleTouched = false; // the add form's aisle was chosen by hand
  var folded = {};
  try { folded = JSON.parse(localStorage.getItem('grocery-list:folded') || '{}') || {}; } catch (e) { folded = {}; }

  // Words that say which aisle something is in, for the default aisles. Only
  // a guess for the add form: the aisle picker beside it has the last word.
  var GUESS = {
    'Produce': ['apple', 'banana', 'lettuce', 'tomato', 'onion', 'garlic', 'potato', 'carrot', 'lemon', 'lime', 'avocado', 'berries', 'berry', 'spinach', 'pepper', 'cucumber', 'fruit', 'herb', 'basil', 'ginger', 'grape', 'orange', 'mushroom', 'salad', 'kale', 'broccoli'],
    'Bakery': ['bread', 'bagel', 'tortilla', 'bun', 'croissant', 'roll', 'baguette', 'muffin', 'pita', 'sourdough'],
    'Dairy & eggs': ['milk', 'cheese', 'yogurt', 'yoghurt', 'butter', 'egg', 'cream', 'feta', 'parmesan', 'mozzarella'],
    'Meat & fish': ['chicken', 'beef', 'pork', 'fish', 'salmon', 'tuna', 'sausage', 'bacon', 'turkey', 'shrimp', 'mince', 'steak', 'tofu'],
    'Pantry': ['rice', 'pasta', 'flour', 'sugar', 'oil', 'beans', 'cereal', 'coffee', 'tea', 'sauce', 'spice', 'salt', 'peanut', 'oats', 'honey', 'jam', 'soup', 'vinegar', 'noodle', 'chips', 'crackers', 'nuts', 'chocolate'],
    'Frozen': ['frozen', 'ice cream', 'peas', 'pizza', 'ice'],
    'Drinks': ['juice', 'water', 'soda', 'beer', 'wine', 'sparkling', 'kombucha', 'lemonade'],
    'Household': ['soap', 'detergent', 'paper towel', 'toilet', 'trash bag', 'bin bag', 'sponge', 'foil', 'cling', 'bleach', 'tissues', 'batteries', 'shampoo', 'toothpaste'],
  };

  function api(method, url, body) {
    var headers = { 'x-usernode-token': token };
    // A preview opened at a chosen moment tells the server what time it is
    // there (req.now; "Time-dependent features" in the platform conventions).
    if (window.usernode && window.usernode.previewNow) headers['x-usernode-now'] = window.usernode.now().toISOString();
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (d) {
          if (!res.ok) {
            throw new Error(d.error === 'account_required'
              ? 'Make an account to join in.'
              : d.error || 'Something went wrong (' + res.status + ').');
          }
          return d;
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

  /** A small icon drawn as an SVG: 'cross', 'up', 'down' or 'chevron'. */
  function icon(kind, className) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('class', className || 'h-5 w-5');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', {
      cross: 'M5 5l10 10M15 5L5 15',
      up: 'M10 15V5M5 10l5-5 5 5',
      down: 'M10 5v10M5 10l5 5 5-5',
      chevron: 'M7 5l5 5-5 5',
    }[kind]);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.75');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
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

  function showStatus(err) {
    el.status.textContent = err ? err.message : '';
    el.status.hidden = !err;
  }

  function act(promise) {
    return promise.then(function () { showStatus(null); return load(); }).catch(function (err) { showStatus(err); return load(); });
  }

  function ago(iso) {
    var mins = Math.max(0, Math.round((new Date(data.now) - new Date(iso)) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hours = Math.round(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    var days = Math.round(hours / 24);
    return days + (days === 1 ? ' day ago' : ' days ago');
  }

  function who(by, mine) { return mine ? 'You' : '@' + by; }

  // ── Aisles ───────────────────────────────────────────────────────────────

  function guessAisle(name) {
    var words = ' ' + name.toLowerCase() + ' ';
    for (var i = 0; i < data.aisles.length; i++) {
      var keys = GUESS[data.aisles[i].name] || [];
      for (var k = 0; k < keys.length; k++) {
        if (words.indexOf(keys[k]) !== -1) return data.aisles[i].id;
      }
    }
    return null;
  }

  function fillAisles(select, chosen) {
    select.textContent = '';
    data.aisles.forEach(function (a) {
      var o = h('option', null, a.name);
      o.value = String(a.id);
      select.appendChild(o);
    });
    var other = h('option', null, 'Other');
    other.value = '';
    select.appendChild(other);
    select.value = chosen == null ? '' : String(chosen);
  }

  function setFolded(key, on) {
    if (on) folded[key] = true; else delete folded[key];
    try { localStorage.setItem('grocery-list:folded', JSON.stringify(folded)); } catch (e) { /* this visit only */ }
  }

  // ── An item ──────────────────────────────────────────────────────────────

  function itemRow(item) {
    if (editing === item.id) return editRow(item);
    var row = h('li', 'list-row py-2 pr-2');
    row.setAttribute('data-item', String(item.id));

    var box = h('input', 'h-6 w-6 shrink-0 accent-accent');
    box.type = 'checkbox';
    box.checked = item.bought;
    box.setAttribute('aria-label', (item.bought ? 'Not bought after all: ' : 'Bought: ') + item.name);
    box.addEventListener('change', function () {
      act(api('PATCH', '/api/items/' + item.id, { bought: box.checked }));
    });
    var tick = h('label', 'flex h-11 w-8 shrink-0 cursor-pointer items-center justify-center');
    tick.appendChild(box);
    row.appendChild(tick);

    // The name is the way into editing it.
    var text = button('flex min-w-0 flex-1 flex-col items-start py-1 text-left');
    text.setAttribute('aria-label', 'Change ' + item.name);
    var name = h('span', item.bought ? 'text-body text-muted line-through break-words' : 'text-body break-words', item.name);
    if (item.note) {
      name.appendChild(document.createTextNode(' '));
      name.appendChild(h('span', 'text-muted', '(' + item.note + ')'));
    }
    text.appendChild(name);
    text.appendChild(h('span', 'text-small text-muted', item.bought
      ? 'Bought by ' + (item.boughtBy ? (item.boughtBy === (data.me && data.me.username) ? 'you' : '@' + item.boughtBy) : 'someone')
      : 'Added by ' + (item.mine ? 'you' : '@' + item.by)));
    text.addEventListener('click', function () { editing = item.id; render(); });
    row.appendChild(text);
    return row;
  }

  function editRow(item) {
    var row = h('li', 'flex flex-col gap-2 px-4 py-3');
    row.setAttribute('data-item', String(item.id));
    var form = h('form', 'flex flex-col gap-2');
    form.setAttribute('autocomplete', 'off');
    var name = h('input', 'field');
    name.name = 'name';
    name.value = item.name;
    name.maxLength = 80;
    name.required = true;
    name.setAttribute('aria-label', 'Item');
    form.appendChild(name);
    var line = h('div', 'flex gap-2');
    var note = h('input', 'field min-w-0 flex-1');
    note.name = 'note';
    note.value = item.note || '';
    note.maxLength = 80;
    note.placeholder = 'Note, e.g. 2 cartons';
    note.setAttribute('aria-label', 'Note, if any');
    line.appendChild(note);
    var aisle = h('select', 'field w-36 shrink-0');
    aisle.setAttribute('aria-label', 'Aisle');
    fillAisles(aisle, item.aisleId);
    line.appendChild(aisle);
    form.appendChild(line);
    var actions = h('div', 'flex flex-wrap items-center gap-2');
    var save = h('button', 'btn-primary', 'Save');
    save.type = 'submit';
    actions.appendChild(save);
    actions.appendChild(button('btn-secondary', 'Cancel', function () { editing = null; render(); }));
    actions.appendChild(button('btn-secondary ml-auto border-0 bg-transparent px-2 text-danger', 'Remove', function () {
      editing = null;
      act(api('DELETE', '/api/items/' + item.id));
    }));
    form.appendChild(actions);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!name.value.trim()) return;
      editing = null;
      act(api('PATCH', '/api/items/' + item.id, { name: name.value, note: note.value, aisleId: aisle.value ? Number(aisle.value) : null }));
    });
    row.appendChild(form);
    setTimeout(function () { name.focus(); }, 0);
    return row;
  }

  // ── An aisle ─────────────────────────────────────────────────────────────

  function aisleSection(key, label, items) {
    var section = h('section', 'flex flex-col gap-2');
    section.setAttribute('data-aisle', key);
    var isFolded = !!folded[key];
    var head = button('flex min-h-11 items-center gap-2 px-1 text-left');
    head.setAttribute('aria-expanded', isFolded ? 'false' : 'true');
    var chevron = icon('chevron', isFolded ? 'h-4 w-4 shrink-0 text-muted' : 'h-4 w-4 shrink-0 rotate-90 text-muted');
    head.appendChild(chevron);
    head.appendChild(h('span', 'flex-1 text-body font-medium', label));
    var toGet = items.filter(function (i) { return !i.bought; }).length;
    head.appendChild(h('span', 'text-small text-muted', toGet ? toGet + ' to get' : 'All bought'));
    head.addEventListener('click', function () { setFolded(key, !isFolded); render(); });
    section.appendChild(head);
    var list = h('ul', 'list');
    list.hidden = isFolded;
    items.forEach(function (i) { list.appendChild(itemRow(i)); });
    section.appendChild(list);
    return section;
  }

  function renderAisles() {
    el.aisles.textContent = '';
    data.aisles.forEach(function (a) {
      if (a.items.length) el.aisles.appendChild(aisleSection(String(a.id), a.name, a.items));
    });
    if (data.other.length) el.aisles.appendChild(aisleSection('other', 'Other', data.other));
  }

  // ── Arranging the aisles ────────────────────────────────────────────────

  function move(index, by) {
    var ids = data.aisles.map(function (a) { return a.id; });
    var to = index + by;
    if (to < 0 || to >= ids.length) return;
    var moved = ids.splice(index, 1)[0];
    ids.splice(to, 0, moved);
    var a = data.aisles.splice(index, 1)[0];
    data.aisles.splice(to, 0, a);
    render();
    act(api('POST', '/api/aisles/order', { ids: ids }));
  }

  function renderArranger() {
    el.aisleList.textContent = '';
    data.aisles.forEach(function (a, index) {
      var row = h('li', 'list-row py-2 pr-2');
      row.setAttribute('data-arrange', String(a.id));
      var name = h('input', 'field min-w-0 flex-1');
      name.value = a.name;
      name.maxLength = 40;
      name.setAttribute('aria-label', 'Aisle name');
      name.addEventListener('change', function () {
        if (name.value.trim() && name.value.trim() !== a.name) act(api('PATCH', '/api/aisles/' + a.id, { name: name.value }));
      });
      row.appendChild(name);
      var up = button('btn-secondary shrink-0 border-0 bg-transparent px-0 text-muted', null, function () { move(index, -1); });
      up.setAttribute('aria-label', 'Move ' + a.name + ' up');
      up.disabled = index === 0;
      up.appendChild(icon('up'));
      row.appendChild(up);
      var down = button('btn-secondary shrink-0 border-0 bg-transparent px-0 text-muted', null, function () { move(index, 1); });
      down.setAttribute('aria-label', 'Move ' + a.name + ' down');
      down.disabled = index === data.aisles.length - 1;
      down.appendChild(icon('down'));
      row.appendChild(down);
      var remove = button('btn-secondary shrink-0 border-0 bg-transparent px-0 text-muted');
      remove.setAttribute('aria-label', 'Remove the ' + a.name + ' aisle');
      remove.appendChild(icon('cross'));
      // Its items stay on the list, under Other.
      tapTwice(remove, 'Tap again', function () { act(api('DELETE', '/api/aisles/' + a.id)); });
      row.appendChild(remove);
      el.aisleList.appendChild(row);
    });
  }

  // ── Activity ─────────────────────────────────────────────────────────────

  var VERB = { added: 'added', bought: 'bought', removed: 'removed', cleared: 'cleared' };

  function renderActivity() {
    var events = data.activity;
    el.activity.hidden = !events.length;
    if (!events.length) return;
    var latest = events.filter(function (e) { return !e.mine; })[0];
    el.activityLine.textContent = latest
      ? who(latest.by, false) + ' ' + VERB[latest.verb] + ' ' + latest.text + ', ' + ago(latest.at)
      : '';
    el.activityList.textContent = '';
    events.forEach(function (e) {
      var li = h('li', 'list-row py-2');
      li.appendChild(h('span', 'min-w-0 flex-1 text-small', who(e.by, e.mine) + ' ' + VERB[e.verb] + ' ' + e.text));
      li.appendChild(h('span', 'shrink-0 text-small text-muted', ago(e.at)));
      el.activityList.appendChild(li);
    });
  }

  // ── Loading, empty, error ──────────────────────────────────────────────

  function show(state) {
    el.loading.hidden = state !== 'loading';
    el.error.hidden = state !== 'error';
    if (state !== 'ready') {
      el.aisles.hidden = true;
      el.empty.hidden = true;
      el.tools.hidden = true;
      el.arranger.hidden = true;
    }
  }

  function render() {
    var all = data.aisles.reduce(function (n, a) { return n.concat(a.items); }, []).concat(data.other);
    if (editing && !all.some(function (i) { return i.id === editing; })) editing = null;
    renderAisles();
    el.aisles.hidden = !all.length;
    el.empty.hidden = !!all.length;
    var bought = all.filter(function (i) { return i.bought; }).length;
    el.clear.hidden = !bought;
    el.clear.textContent = 'Clear ' + bought + ' bought';
    el.tools.hidden = false;
    el.arrange.textContent = arranging ? 'Done arranging' : 'Arrange aisles';
    el.arrange.setAttribute('aria-expanded', arranging ? 'true' : 'false');
    el.arranger.hidden = !arranging;
    if (arranging) renderArranger();
    if (!aisleTouched && document.activeElement !== el.aisle) {
      fillAisles(el.aisle, guessAisle(el.form.elements.name.value));
    }
    renderActivity();
    show('ready');
  }

  var loaded = false;
  var loading = null;
  function load() {
    if (loading) return loading;
    loading = api('GET', '/api/list')
      .then(function (d) { loaded = true; data = d; render(); })
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
    var aisleId = el.aisle.value ? Number(el.aisle.value) : null;
    act(api('POST', '/api/items', { name: name.value, note: el.form.elements.note.value, aisleId: aisleId }).then(function () {
      el.form.reset();
      aisleTouched = false;
      name.focus();
    }));
  });
  // As you type, the aisle follows what it sounds like, until you pick one.
  el.form.elements.name.addEventListener('input', function () {
    if (!aisleTouched && data) el.aisle.value = String(guessAisle(el.form.elements.name.value) || '');
  });
  el.aisle.addEventListener('change', function () { aisleTouched = true; });
  el.clear.addEventListener('click', function () { act(api('POST', '/api/items/clear-bought')); });
  el.arrange.addEventListener('click', function () { arranging = !arranging; render(); });
  el.aisleForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = el.aisleForm.elements.name;
    if (!name.value.trim()) return;
    act(api('POST', '/api/aisles', { name: name.value }).then(function () { el.aisleForm.reset(); }));
  });
  el.activityToggle.addEventListener('click', function () {
    var open = el.activityList.hidden;
    el.activityList.hidden = !open;
    el.activityToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.getElementById('retry').addEventListener('click', function () { show('loading'); load(); });

  // Other people shop too: look again every 8 seconds while the app is on
  // screen, and straight away when it comes back. Skipped while someone is
  // typing, editing an item or arranging the aisles.
  setInterval(function () {
    var active = document.activeElement;
    var typing = active && (active.tagName === 'INPUT' || active.tagName === 'SELECT') && active.type !== 'checkbox';
    if (!document.hidden && !typing && editing === null && !arranging) load();
  }, 8000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && editing === null) load(); });

  load();
})();
