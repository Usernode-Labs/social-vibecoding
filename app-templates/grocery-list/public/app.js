// The grocery list screen. Talks to api.js; every request carries the
// platform token the frame was opened with, which is how the server knows
// who you are.
//
// One list the whole project shares, working the way a list works in
// Homeroom's Todo List app:
//   - General items first, with no heading, then each category. Quick-add
//     puts an item at the top of General; a category's + puts one at the top
//     of that category.
//   - Ticking keeps an item's place: each category shows its open items,
//     then "N done" and the ticked ones below, each in their own order. Who
//     last ticked or unticked an item shows on it.
//   - A category folds away by tapping its name, and a finished one starts
//     folded. Which ones are folded is remembered on this device, and so is
//     whether ticked items show at all; a category's own "N done" overrides
//     that until the page is reloaded.
//   - Drag to reorder: items within and between categories (press and hold
//     on a touch screen), categories by their handle. Not while searching,
//     and not items while due dates are on, because then dates set the order.
//   - Undo and redo (up to 50 steps) for adding, deleting, editing, ticking
//     and due dates; also Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z or Ctrl+Y.
//   - Search filters as you type; a category whose name matches shows all of
//     its items.
//   - Markdown export and import, in Todo List's format.
// Changes show at once and go to the server in order behind the scenes.
// Other people's changes arrive by asking again every few seconds.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it, so an item called "<b>hi</b>" shows exactly that.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';
  // A touch screen: no drag handles on items (press and hold instead), and
  // leaving an add field with something typed in it adds it.
  var TOUCH = window.matchMedia('(hover: none)').matches;
  var HISTORY_MAX = 50;
  var POLL_MS = 5000;
  var KEY_COLLAPSED = 'grocery-list:collapsed';
  var KEY_SHOW_COMPLETED = 'grocery-list:showCompleted';

  var el = {
    undo: document.getElementById('undo'),
    redo: document.getElementById('redo'),
    menuButton: document.getElementById('menu-button'),
    menu: document.getElementById('menu'),
    dueSwitch: document.getElementById('due-switch'),
    activity: document.getElementById('activity'),
    exportPanel: document.getElementById('export'),
    exportText: document.getElementById('export-text'),
    importPanel: document.getElementById('import'),
    importText: document.getElementById('import-text'),
    search: document.getElementById('search'),
    searchClear: document.getElementById('search-clear'),
    quickAdd: document.getElementById('quick-add'),
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    empty: document.getElementById('empty'),
    noResults: document.getElementById('no-results'),
    categories: document.getElementById('categories'),
    newCategory: document.getElementById('new-category'),
    toast: document.getElementById('toast'),
    toastText: document.getElementById('toast-text'),
  };

  var data = null; // { me, now, list, categories, items, activity }
  var loaded = false;

  // What is open on screen.
  var query = '';
  var catDoneOverrides = {}; // category id -> show its ticked items (this visit)
  var openAdders = {}; // category id -> its add field is open
  var editingId = null; // the item whose text is being edited
  var dueId = null; // the item whose due date is being set
  var renamingCat = null; // the category being renamed
  var armed = 0; // buttons waiting for their second tap

  // ── Small helpers ────────────────────────────────────────────────────────

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
            var err = new Error(d.error === 'account_required'
              ? 'Make an account to join in.'
              : d.error || 'Something went wrong (' + res.status + ').');
            err.status = res.status;
            throw err;
          }
          return d;
        });
      }, function () {
        var err = new Error("Couldn't reach the list. Check your connection.");
        err.status = 0;
        throw err;
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

  var PATHS = {
    cross: 'M5 5l10 10M15 5L5 15',
    chevron: 'M7 5l5 5-5 5',
    plus: 'M10 4v12M4 10h12',
    pencil: 'M4 16l1-4 8-8 3 3-8 8-4 1zM11 6l3 3',
    undo: 'M8 4L4 8l4 4M4 8h8a4 4 0 010 8H9',
    redo: 'M12 4l4 4-4 4M16 8H8a4 4 0 000 8h3',
    menu: 'M4 6h12M4 10h12M4 14h12',
    grip: 'M7.5 5h.01M12.5 5h.01M7.5 10h.01M12.5 10h.01M7.5 15h.01M12.5 15h.01',
  };

  /** A small icon drawn as an SVG, from PATHS. */
  function icon(kind, className) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('class', className || 'h-5 w-5');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', PATHS[kind]);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', kind === 'grip' ? '2.5' : '1.75');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function iconButton(kind, label, onClick, className) {
    var b = button(className || 'flex h-11 w-10 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-fg', null, onClick);
    b.setAttribute('aria-label', label);
    b.title = label;
    b.appendChild(icon(kind, 'h-4 w-4'));
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
      armed--;
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
      armed++;
      resting = Array.prototype.slice.call(btn.childNodes);
      label = btn.getAttribute('aria-label');
      className = btn.className;
      btn.textContent = typeof armedLabel === 'function' ? armedLabel() : armedLabel;
      btn.setAttribute('aria-label', btn.textContent);
      btn.className = 'btn-secondary shrink-0 whitespace-nowrap border-0 bg-transparent px-2 text-small text-danger';
      timer = setTimeout(rest, 4000);
    });
  }

  var toastTimer = null;
  function toast(message) {
    el.toastText.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 3200);
  }

  function stored(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* this visit only */ }
  }

  // The moment it is for the viewer: a preview's chosen time, or the device's.
  function clock() {
    return window.usernode && window.usernode.previewNow ? window.usernode.now() : new Date();
  }

  function me() { return data && data.me ? data.me.username : null; }
  function datesOn() { return !!(data && data.list.due_dates_enabled); }
  function findItem(id) {
    for (var i = 0; i < data.items.length; i++) if (data.items[i].id === id) return data.items[i];
    return null;
  }
  function findCat(id) {
    for (var i = 0; i < data.categories.length; i++) if (data.categories[i].id === id) return data.categories[i];
    return null;
  }
  function defaultCat() {
    return data.categories.filter(function (c) { return c.is_default; })[0] || null;
  }

  // General first, then the categories in their order.
  function displayCategories() {
    return data.categories.slice().sort(function (a, b) {
      return (b.is_default - a.is_default) || (a.sort_order - b.sort_order) || (a.id - b.id);
    });
  }

  // An item's place in its section: by hand, or by due date when dates are
  // on (undated last; on one day, timed before all-day), then by hand.
  function itemOrder(a, b) {
    var manual = (a.sort_order - b.sort_order) || (a.id - b.id);
    if (!datesOn()) return manual;
    var ad = a.due_date || '';
    var bd = b.due_date || '';
    if (ad !== bd) {
      if (!ad) return 1;
      if (!bd) return -1;
      return ad < bd ? -1 : 1;
    }
    var at = a.due_time || '';
    var bt = b.due_time || '';
    if (ad && at !== bt) {
      if (!at) return 1;
      if (!bt) return -1;
      return at < bt ? -1 : 1;
    }
    return manual;
  }

  function sectionItems(catId, checked) {
    return data.items
      .filter(function (i) { return i.category_id === catId && !!i.checked === checked; })
      .sort(itemOrder);
  }

  // ── Showing ticked items, folding categories ────────────────────────────

  function showCompleted() { return stored(KEY_SHOW_COMPLETED) !== 'false'; }

  // A category with at least one item and nothing left to get.
  function isCatFullyDone(catId) {
    var open = 0;
    var done = 0;
    data.items.forEach(function (i) {
      if (i.category_id !== catId) return;
      if (i.checked) done++; else open++;
    });
    return !open && done > 0;
  }

  function catShowDone(catId) {
    if (catDoneOverrides[catId] !== undefined) return catDoneOverrides[catId];
    return showCompleted();
  }

  // Folded categories, as a set of ids: +id folded, -id kept open. With
  // neither, a finished category starts folded.
  var collapsed = (function () {
    try { return new Set((JSON.parse(stored(KEY_COLLAPSED) || '[]') || []).map(Number)); } catch (e) { return new Set(); }
  })();
  function persistCollapsed() { store(KEY_COLLAPSED, JSON.stringify(Array.from(collapsed))); }

  function catCollapsed(cat) {
    if (cat.is_default) return false;
    if (collapsed.has(cat.id)) return true;
    if (collapsed.has(-cat.id)) return false;
    return isCatFullyDone(cat.id);
  }
  function setCatCollapsed(catId, on) {
    collapsed.delete(catId);
    collapsed.delete(-catId);
    collapsed.add(on ? catId : -catId);
    persistCollapsed();
  }
  // Back to the default: folded when finished, open otherwise.
  function clearKeepOpen(catId) {
    if (collapsed.delete(-catId)) persistCollapsed();
  }

  function toggleCatCollapsed(cat) {
    if (searchActive()) return;
    var opening = catCollapsed(cat);
    setCatCollapsed(cat.id, !opening);
    // Opening shows the ticked items too, so the category is never an empty card.
    if (opening && !catShowDone(cat.id)) catDoneOverrides[cat.id] = true;
    render();
  }

  function toggleCatDone(catId) {
    if (searchActive()) return;
    catDoneOverrides[catId] = !catShowDone(catId);
    render();
  }

  function setShowCompleted(on) {
    store(KEY_SHOW_COMPLETED, on ? 'true' : 'false');
    catDoneOverrides = {};
    // Finished categories start folded, so "Show all" keeps them open, and
    // "Hide all" lets them fold again.
    data.categories.forEach(function (c) {
      if (!isCatFullyDone(c.id)) return;
      if (on) setCatCollapsed(c.id, false); else clearKeepOpen(c.id);
    });
    render();
  }

  function toggleAdder(cat) {
    if (openAdders[cat.id]) {
      delete openAdders[cat.id];
    } else {
      openAdders[cat.id] = true;
      // Somewhere the new item will be seen.
      if (catCollapsed(cat)) setCatCollapsed(cat.id, false);
      if (!catShowDone(cat.id)) catDoneOverrides[cat.id] = true;
    }
    render();
    if (openAdders[cat.id]) focusKey('adder:' + cat.id);
  }

  // ── Search ───────────────────────────────────────────────────────────────

  function searchText() { return query.trim().toLowerCase(); }
  function searchActive() { return !!searchText(); }

  // ── Sending changes ──────────────────────────────────────────────────────
  //
  // Every item change shows at once and joins a queue that goes to the server
  // one request at a time, in order. A new item has a temporary (negative) id
  // until the server answers; anything queued behind it uses the real one.

  var queue = [];
  var sending = false;
  var failures = [];
  var tempSeq = -1;
  var realIds = {};
  var generation = 0; // bumped by every local change, so a stale refresh is dropped

  function isTemp(id) { return id < 0; }
  function resolveId(id) { return isTemp(id) ? (realIds[id] || null) : id; }
  function opId() { return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }

  function commit(op) {
    generation++;
    // Deleting an item whose add has not gone out yet: drop both and send nothing.
    if (op.type === 'delete' && isTemp(op.itemId) && !realIds[op.itemId]) {
      var start = sending ? 1 : 0;
      var waiting = queue.slice(start).some(function (o) { return o.type === 'add' && o.itemId === op.itemId; });
      if (waiting) {
        queue = queue.filter(function (o, i) { return i < start || o.itemId !== op.itemId; });
        return;
      }
    }
    queue.push(op);
    pump();
  }

  function pump() {
    if (sending || !queue.length) return;
    var op = queue[0];
    var creates = op.type === 'add';
    var id = creates || op.itemId == null ? null : resolveId(op.itemId);
    // Its item's add never reached the server, so there is nothing to change.
    if (!creates && op.itemId != null && id == null) {
      queue.shift();
      pump();
      return;
    }
    sending = true;
    send(op, id, 0);
  }

  function send(op, id, attempt) {
    api(op.method, op.path.replace('{id}', id), op.body).then(function (d) {
      if (op.type === 'add') adopt(op.itemId, d.item);
      sent();
    }, function (err) {
      // A dropped connection or a busy server is worth a few more tries.
      if ((err.status === 0 || err.status === 429 || err.status >= 500) && attempt < 4) {
        setTimeout(function () { send(op, id, attempt + 1); }, 2000 * Math.pow(2, attempt));
        return;
      }
      failures.push(err);
      sent();
    });
  }

  function sent() {
    queue.shift();
    sending = false;
    if (queue.length) { pump(); return; }
    if (!failures.length) return;
    // What the server refused is put back the way the server has it.
    var gone = failures.filter(function (e) { return e.status === 404; }).length;
    toast(gone === failures.length
      ? (gone === 1 ? "1 change couldn't be applied (the item was deleted)" : gone + " changes couldn't be applied (the item was deleted)")
      : failures[failures.length - 1].message);
    failures = [];
    refresh(true);
  }

  // The server's answer to an add: the item's real id, everywhere it is used.
  function adopt(tempId, item) {
    realIds[tempId] = item.id;
    var local = findItem(tempId);
    if (local) {
      local.id = item.id;
      local.sort_order = item.sort_order;
    }
    undoStack.concat(redoStack).forEach(function (e) { if (e.itemId === tempId) e.itemId = item.id; });
    if (editingId === tempId) editingId = item.id;
    if (dueId === tempId) dueId = item.id;
    Array.prototype.forEach.call(document.querySelectorAll('[data-focus-key$=":' + tempId + '"]'), function (n) {
      n.setAttribute('data-focus-key', n.getAttribute('data-focus-key').replace(/:-\d+$/, ':' + item.id));
    });
    render();
  }

  // ── Item changes ─────────────────────────────────────────────────────────

  // A new item's place: the top of its category's open items.
  function localNewItem(id, catId, text) {
    var min = 1;
    data.items.forEach(function (i) { if (i.category_id === catId && i.sort_order < min) min = i.sort_order; });
    return {
      id: id, category_id: catId, text: text, checked: false, sort_order: min - 1, completed_at: null,
      created_by: me(), last_checked_by: null, due_date: null, due_time: null,
    };
  }

  function addItem(cat, text, quick) {
    var tempId = tempSeq--;
    var item = localNewItem(tempId, cat.id, text);
    data.items.push(item);
    commit({
      type: 'add', itemId: tempId, method: 'POST', path: quick ? '/api/items' : '/api/categories/' + cat.id + '/items',
      body: { text: text, client_op_id: opId() },
    });
    record({ kind: 'add', itemId: tempId, snapshot: copy(item) });
    render();
    return tempId;
  }

  function toggleItem(id, checked) {
    var item = findItem(id);
    if (!item || !!item.checked === checked) return;
    commit({ type: 'toggle', itemId: id, method: 'PATCH', path: '/api/items/{id}', body: { checked: checked } });
    record({ kind: 'toggle', itemId: id, before: { checked: !checked }, after: { checked: checked } });
    item.checked = checked;
    item.completed_at = checked ? clock().toISOString() : null;
    item.last_checked_by = me() || item.last_checked_by;
    // Ticking the last open item: with ticked items showing, the category
    // stays open; with them hidden, it folds.
    if (checked && isCatFullyDone(item.category_id)) {
      if (catShowDone(item.category_id)) setCatCollapsed(item.category_id, false);
      else clearKeepOpen(item.category_id);
    }
    render();
  }

  function editText(id, text) {
    var item = findItem(id);
    if (!item) return false;
    if (item.text === text) return true;
    commit({ type: 'edit', itemId: id, method: 'PATCH', path: '/api/items/{id}', body: { text: text } });
    record({ kind: 'edit', itemId: id, before: { text: item.text }, after: { text: text } });
    item.text = text;
    render();
    return true;
  }

  function setDue(id, date, time) {
    var item = findItem(id);
    if (!item) return false;
    var before = { due_date: item.due_date || null, due_time: item.due_time || null };
    var after = { due_date: date || null, due_time: date ? (time || null) : null };
    if (before.due_date === after.due_date && before.due_time === after.due_time) return true;
    commit({ type: 'due', itemId: id, method: 'PATCH', path: '/api/items/{id}', body: after });
    record({ kind: 'due', itemId: id, before: before, after: after });
    item.due_date = after.due_date;
    item.due_time = after.due_time;
    render();
    return true;
  }

  // No question asked: Undo brings it back.
  function deleteItem(id) {
    var item = findItem(id);
    if (!item) return;
    commit({ type: 'delete', itemId: id, method: 'DELETE', path: '/api/items/{id}' });
    record({ kind: 'delete', itemId: id, snapshot: copy(item) });
    data.items = data.items.filter(function (i) { return i !== item; });
    if (editingId === id) editingId = null;
    if (dueId === id) dueId = null;
    render();
  }

  // Undoing a delete: the server's row is gone, so this is a new item with
  // the old one's text, category, tick and due date, at the top of its
  // category (or General, if its category went too).
  function restoreItem(snap) {
    var cat = findCat(snap.category_id) || defaultCat() || data.categories[0];
    if (!cat) { toast("That item's category is gone"); return null; }
    var id = addItem(cat, snap.text, false);
    if (snap.checked) toggleItem(id, true);
    if (snap.due_date) setDue(id, snap.due_date, snap.due_time || null);
    return id;
  }

  function copy(item) {
    var out = {};
    for (var k in item) out[k] = item[k];
    return out;
  }

  // ── Undo and redo ────────────────────────────────────────────────────────

  var undoStack = [];
  var redoStack = [];
  var historyBusy = false;

  function record(entry) {
    if (historyBusy) return;
    undoStack.push(entry);
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack = [];
    syncHistory();
  }

  function runHistory(entry, dir) {
    historyBusy = true;
    try {
      if (entry.kind === 'add' || entry.kind === 'delete') {
        var removing = (entry.kind === 'add') === (dir === 'undo');
        if (removing) {
          if (!findItem(entry.itemId)) return false;
          deleteItem(entry.itemId);
          return true;
        }
        var newId = restoreItem(entry.snapshot);
        if (newId == null) return false;
        var oldId = entry.itemId;
        undoStack.concat(redoStack).forEach(function (e) { if (e.itemId === oldId) e.itemId = newId; });
        entry.itemId = newId;
        return true;
      }
      if (!findItem(entry.itemId)) return false;
      var v = dir === 'undo' ? entry.before : entry.after;
      if (entry.kind === 'edit') return editText(entry.itemId, v.text);
      if (entry.kind === 'toggle') { toggleItem(entry.itemId, v.checked); return true; }
      if (entry.kind === 'due') return setDue(entry.itemId, v.due_date, v.due_time);
      return false;
    } finally {
      historyBusy = false;
    }
  }

  function undo() {
    if (!data || !undoStack.length) return;
    var entry = undoStack.pop();
    if (!runHistory(entry, 'undo')) {
      syncHistory();
      toast("Can't undo that: the item is gone");
      return;
    }
    redoStack.push(entry);
    if (redoStack.length > HISTORY_MAX) redoStack.shift();
    syncHistory();
    toast('Undone');
  }

  function redo() {
    if (!data || !redoStack.length) return;
    var entry = redoStack.pop();
    if (!runHistory(entry, 'redo')) {
      syncHistory();
      toast("Can't redo that: the item is gone");
      return;
    }
    undoStack.push(entry);
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    syncHistory();
    toast('Redone');
  }

  function syncHistory() {
    el.undo.disabled = !undoStack.length;
    el.redo.disabled = !redoStack.length;
  }

  // ── Category changes (these need the server's answer first) ────────────

  function addCategory(name) {
    return api('POST', '/api/categories', { name: name }).then(function (d) {
      data.categories.push(d.category);
      render();
    });
  }

  function renameCategory(cat, name) {
    renamingCat = null;
    if (!name || name === cat.name) { render(); return; }
    var before = cat.name;
    cat.name = name;
    render();
    api('PATCH', '/api/categories/' + cat.id, { name: name }).catch(function (err) {
      cat.name = before;
      toast(err.message);
      refresh(true);
    });
  }

  function deleteCategory(cat) {
    if (data.categories.length <= 1) {
      toast("Can't delete the only category: a list needs at least one");
      return;
    }
    api('DELETE', '/api/categories/' + cat.id).then(function () {
      data.categories = data.categories.filter(function (c) { return c.id !== cat.id; });
      data.items = data.items.filter(function (i) { return i.category_id !== cat.id; });
      delete openAdders[cat.id];
      render();
    }, function (err) { toast(err.message); refresh(true); });
  }

  // ── Due dates ────────────────────────────────────────────────────────────

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function todayISO() { var d = clock(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function nowHM() { var d = clock(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function parseISODate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function fmtTime(t) {
    var m = /^(\d{1,2}):(\d{2})/.exec(t || '');
    if (!m) return '';
    return new Date(2000, 0, 1, +m[1], +m[2]).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  // Nearby days by name, the rest as a date.
  function dueLabel(item) {
    var d = parseISODate(item.due_date);
    if (!d) return '';
    var t = parseISODate(todayISO());
    var diff = Math.round((d - t) / 86400000);
    var day;
    if (diff === 0) day = 'Today';
    else if (diff === 1) day = 'Tomorrow';
    else if (diff === -1) day = 'Yesterday';
    else if (diff > 1 && diff < 7) day = d.toLocaleDateString(undefined, { weekday: 'short' });
    else {
      var opts = { month: 'short', day: 'numeric' };
      if (d.getFullYear() !== t.getFullYear()) opts.year = 'numeric';
      day = d.toLocaleDateString(undefined, opts);
    }
    return day + (item.due_time ? ' · ' + fmtTime(item.due_time) : '');
  }

  // A ticked item is never overdue, and an all-day item is due all day.
  function isOverdue(item) {
    if (!item.due_date || item.checked) return false;
    var today = todayISO();
    if (item.due_date < today) return true;
    if (item.due_date > today) return false;
    return !!item.due_time && item.due_time < nowHM();
  }

  function setDueDates(on) {
    var before = datesOn();
    if (before === on) return;
    data.list.due_dates_enabled = on;
    toast(on ? 'Due dates on: this list now sorts by date' : 'Due dates off');
    render();
    api('PATCH', '/api/list', { due_dates_enabled: on }).catch(function (err) {
      data.list.due_dates_enabled = before;
      toast(err.message);
      render();
    });
  }

  function dateSortHint() {
    toast('This list is sorted by due date: turn due dates off to reorder by hand');
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  function focusKey(key) {
    var node = el.categories.querySelector('[data-focus-key="' + key + '"]');
    if (node) node.focus();
  }

  // Leaving an add field on a touch screen adds what was typed.
  function commitOnBlur(input) {
    input.addEventListener('blur', function () {
      if (!TOUCH || !input.value.trim() || !input.form) return;
      if (input.form.requestSubmit) input.form.requestSubmit();
      else input.form.dispatchEvent(new Event('submit', { cancelable: true }));
    });
  }

  function itemRow(item, cat) {
    var row = h('li', 'list-row select-none gap-1 py-0 pl-1 pr-1');
    row.setAttribute('data-item', String(item.id));
    row.setAttribute('data-checked', item.checked ? '1' : '0');

    if (!TOUCH && !searchActive()) {
      var grip = button('flex h-11 w-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted');
      grip.setAttribute('data-grip', '');
      grip.setAttribute('aria-label', datesOn() ? 'Sorted by due date' : 'Drag to reorder ' + item.text);
      grip.title = datesOn() ? 'Sorted by due date' : 'Drag to reorder';
      grip.appendChild(icon('grip', 'h-4 w-4'));
      if (datesOn()) grip.addEventListener('click', dateSortHint);
      else grip.addEventListener('pointerdown', function (e) { startItemDrag(e, row, item); });
      row.appendChild(grip);
    }

    var tick = h('label', 'flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center');
    var box = h('input', 'h-5 w-5 accent-accent');
    box.type = 'checkbox';
    box.checked = !!item.checked;
    box.setAttribute('aria-label', (item.checked ? 'Untick ' : 'Tick ') + item.text);
    box.addEventListener('change', function () { toggleItem(item.id, box.checked); });
    tick.appendChild(box);
    row.appendChild(tick);

    if (editingId === item.id) {
      row.appendChild(editForm(item));
      return row;
    }

    var body = h('div', 'flex min-w-0 flex-1 cursor-pointer flex-col py-2');
    body.appendChild(h('span', item.checked ? 'break-words text-body text-muted line-through' : 'break-words text-body', item.text));
    if (item.last_checked_by) {
      var by = h('span', 'text-small text-muted', (item.checked ? '✓ @' : '↺ @') + item.last_checked_by);
      by.title = (item.checked ? 'Last checked by @' : 'Last unchecked by @') + item.last_checked_by;
      body.appendChild(by);
    }
    row.appendChild(body);
    // Tapping the item edits it.
    row.addEventListener('click', function (e) {
      if (Date.now() - justDragged < 400) return;
      if (e.target.closest('button, input, label, [data-grip], [data-due]')) return;
      editingId = item.id;
      dueId = null;
      render();
      focusKey('edit:' + item.id);
    });
    if (TOUCH && !searchActive()) {
      row.addEventListener('pointerdown', function (e) {
        if (e.target.closest('button, input, label')) return;
        if (datesOn()) return;
        startItemDrag(e, row, item);
      });
    }

    if (datesOn()) {
      var chip = button('flex h-11 shrink-0 items-center px-1');
      chip.setAttribute('data-due', '');
      var label = dueLabel(item);
      chip.setAttribute('aria-label', label ? 'Due ' + label + ', change it' : 'Add a due date');
      var pill = h('span', label
        ? (isOverdue(item)
          ? 'whitespace-nowrap rounded-full border border-danger px-2 py-0.5 text-small text-danger'
          : 'whitespace-nowrap rounded-full border border-line bg-raised px-2 py-0.5 text-small text-muted')
        : 'whitespace-nowrap rounded-full border border-dashed border-line px-2 py-0.5 text-small text-muted', label || '+ date');
      chip.appendChild(pill);
      chip.addEventListener('click', function () {
        dueId = dueId === item.id ? null : item.id;
        editingId = null;
        render();
        if (dueId) focusKey('due-date:' + item.id);
      });
      row.appendChild(chip);
    }

    row.appendChild(iconButton('cross', 'Delete ' + item.text, function () { deleteItem(item.id); },
      'flex h-11 w-10 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-danger'));
    return row;
  }

  function editForm(item) {
    var form = h('form', 'flex min-w-0 flex-1 gap-2 py-1.5');
    form.setAttribute('autocomplete', 'off');
    var input = h('input', 'field min-w-0 flex-1');
    input.value = item.text;
    input.maxLength = 500;
    input.setAttribute('aria-label', 'Edit ' + item.text);
    input.setAttribute('data-focus-key', 'edit:' + item.id);
    form.appendChild(input);
    var done = false;
    function finish(save) {
      if (done) return;
      done = true;
      var value = input.value.trim();
      editingId = null;
      if (save && value) editText(item.id, value);
      else render();
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); finish(true); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
    input.addEventListener('blur', function () { if (!refreshing) finish(true); });
    var save = h('button', 'btn-secondary shrink-0', 'Save');
    save.type = 'submit';
    save.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    form.appendChild(save);
    return form;
  }

  function dueEditor(item) {
    var li = h('li', 'flex flex-col gap-3 px-4 py-3');
    li.setAttribute('data-due-editor', String(item.id));
    li.appendChild(h('p', 'text-body font-medium', 'Due date'));
    li.appendChild(h('p', 'break-words text-small text-muted', item.text));
    var fields = h('div', 'flex flex-wrap gap-2');
    var date = h('input', 'field w-auto min-w-0 flex-1');
    date.type = 'date';
    date.value = item.due_date || '';
    date.setAttribute('aria-label', 'Date');
    date.setAttribute('data-focus-key', 'due-date:' + item.id);
    var time = h('input', 'field w-auto min-w-0 flex-1');
    time.type = 'time';
    time.value = item.due_time || '';
    time.setAttribute('aria-label', 'Time (optional)');
    time.title = 'Time (optional)';
    time.setAttribute('data-focus-key', 'due-time:' + item.id);
    fields.appendChild(date);
    fields.appendChild(time);
    li.appendChild(fields);
    var actions = h('div', 'flex flex-wrap justify-end gap-2');
    if (item.due_date) {
      actions.appendChild(button('btn-secondary mr-auto border-0 bg-transparent px-2 text-danger', 'Clear', function () {
        dueId = null;
        setDue(item.id, null, null);
      }));
    }
    actions.appendChild(button('btn-secondary', 'Cancel', function () { dueId = null; render(); }));
    actions.appendChild(button('btn-primary', 'Save', function () {
      if (!date.value && time.value) {
        toast('Pick a date first: a time on its own has nothing to be due on');
        return;
      }
      dueId = null;
      setDue(item.id, date.value || null, time.value || null);
      render();
    }));
    li.appendChild(actions);
    return li;
  }

  function adderForm(cat) {
    var form = h('form', 'flex gap-2 px-3 py-2');
    form.setAttribute('autocomplete', 'off');
    var input = h('input', 'field min-w-0 flex-1');
    input.name = 'text';
    input.maxLength = 500;
    input.placeholder = 'Add an item…';
    input.setAttribute('aria-label', 'Add an item to ' + cat.name);
    input.setAttribute('data-focus-key', 'adder:' + cat.id);
    form.appendChild(input);
    var add = h('button', 'btn-secondary shrink-0', 'Add');
    add.type = 'submit';
    form.appendChild(add);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      var keep = document.activeElement === input;
      input.value = '';
      addItem(cat, text, false);
      if (keep) focusKey('adder:' + cat.id);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); delete openAdders[cat.id]; render(); }
    });
    commitOnBlur(input);
    return form;
  }

  function categoryHeader(cat, isCollapsed, open, done) {
    var head = h('div', 'flex items-center gap-1');
    var searching = searchActive();
    if (renamingCat === cat.id) {
      var form = h('form', 'flex min-w-0 flex-1 gap-2');
      form.setAttribute('autocomplete', 'off');
      var input = h('input', 'field min-w-0 flex-1');
      input.value = cat.name;
      input.maxLength = 100;
      input.setAttribute('aria-label', 'Rename ' + cat.name);
      input.setAttribute('data-focus-key', 'rename:' + cat.id);
      var finished = false;
      var finish = function (save) {
        if (finished) return;
        finished = true;
        if (save) renameCategory(cat, input.value.trim());
        else { renamingCat = null; render(); }
      };
      form.addEventListener('submit', function (e) { e.preventDefault(); finish(true); });
      input.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
      input.addEventListener('blur', function () { if (!refreshing) finish(true); });
      form.appendChild(input);
      var save = h('button', 'btn-secondary shrink-0', 'Save');
      save.type = 'submit';
      save.addEventListener('pointerdown', function (e) { e.preventDefault(); });
      form.appendChild(save);
      head.appendChild(form);
      return head;
    }
    if (!searching) {
      var grip = button('flex h-11 w-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted');
      grip.setAttribute('data-grip', '');
      grip.setAttribute('aria-label', 'Drag to reorder ' + cat.name);
      grip.title = 'Drag to reorder';
      grip.appendChild(icon('grip', 'h-4 w-4'));
      grip.addEventListener('pointerdown', function (e) { startCategoryDrag(e, cat); });
      head.appendChild(grip);
    }
    var toggle = button('flex min-h-11 min-w-0 flex-1 items-center gap-2 px-1 text-left', null, function () { toggleCatCollapsed(cat); });
    toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    if (!searching) toggle.appendChild(icon('chevron', isCollapsed ? 'h-4 w-4 shrink-0 text-muted' : 'h-4 w-4 shrink-0 rotate-90 text-muted'));
    toggle.appendChild(h('span', 'min-w-0 truncate text-body font-medium', cat.name));
    if (isCollapsed) {
      var count = open.length + done.length;
      toggle.appendChild(h('span', 'shrink-0 text-small text-muted',
        !open.length && done.length ? done.length + ' done' : count + (count === 1 ? ' item' : ' items')));
    }
    head.appendChild(toggle);
    if (!searching && !isCollapsed) head.appendChild(iconButton('plus', 'Add to ' + cat.name, function () { toggleAdder(cat); }));
    head.appendChild(iconButton('pencil', 'Rename ' + cat.name, function () {
      renamingCat = cat.id;
      render();
      focusKey('rename:' + cat.id);
    }));
    var remove = iconButton('cross', 'Delete ' + cat.name, null,
      'flex h-11 w-10 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-danger');
    tapTwice(remove, function () {
      var n = data.items.filter(function (i) { return i.category_id === cat.id; }).length;
      return n ? 'Delete with its ' + n + (n === 1 ? ' item?' : ' items?') : 'Delete it?';
    }, function () { deleteCategory(cat); });
    head.appendChild(remove);
    return head;
  }

  function categorySection(cat) {
    var q = searchText();
    var open = sectionItems(cat.id, false);
    var done = sectionItems(cat.id, true);
    var all = open.length + done.length;
    var searching = !!q;
    if (searching) {
      // A category whose name matches shows everything in it; otherwise only
      // the items that match. General's name never matches.
      var nameHit = !cat.is_default && cat.name.toLowerCase().indexOf(q) !== -1;
      if (!nameHit) {
        var hit = function (i) { return i.text.toLowerCase().indexOf(q) !== -1; };
        open = open.filter(hit);
        done = done.filter(hit);
      }
      if (!open.length && !done.length) return null;
    }
    // General has no heading and shows only when something is in it.
    if (cat.is_default && !all) return null;

    var section = h('section', 'flex flex-col gap-1');
    section.setAttribute('data-category', String(cat.id));
    if (cat.is_default) section.setAttribute('data-default', '');
    var isCollapsed = !searching && catCollapsed(cat);
    if (!cat.is_default) section.appendChild(categoryHeader(cat, isCollapsed, open, done));
    if (isCollapsed) return section;

    var showDone = searching || catShowDone(cat.id);
    var card = h('div', 'list');
    var adderOpen = !searching && openAdders[cat.id];
    if (adderOpen) card.appendChild(adderForm(cat));

    var openList = h('ul', 'divide-y divide-line');
    openList.setAttribute('data-section', 'open');
    open.forEach(function (i) {
      openList.appendChild(itemRow(i, cat));
      if (dueId === i.id && datesOn()) openList.appendChild(dueEditor(i));
    });
    openList.hidden = !open.length;
    card.appendChild(openList);

    if (done.length && !searching) {
      var toggle = button('flex min-h-11 w-full items-center gap-2 px-4 text-left text-small text-muted hover:bg-raised',
        (showDone ? '▾ ' : '▸ ') + done.length + ' done', function () { toggleCatDone(cat.id); });
      toggle.title = showDone ? 'Hide completed in this category' : 'Show completed in this category';
      toggle.setAttribute('aria-expanded', showDone ? 'true' : 'false');
      card.appendChild(toggle);
    }
    var doneList = h('ul', 'divide-y divide-line');
    doneList.setAttribute('data-section', 'done');
    if (showDone) {
      done.forEach(function (i) {
        doneList.appendChild(itemRow(i, cat));
        if (dueId === i.id && datesOn()) doneList.appendChild(dueEditor(i));
      });
    }
    doneList.hidden = !showDone || !done.length;
    card.appendChild(doneList);

    // A finished or empty category keeps a way to add to it.
    if (!searching && !cat.is_default && !adderOpen && (!all || !open.length)) {
      var lane = button('flex min-h-11 w-full items-center px-4 text-left text-small text-muted hover:bg-raised',
        all ? 'All done, add another' : 'No items yet', function () { toggleAdder(cat); });
      lane.title = all ? 'Add another item' : 'Add the first item';
      card.appendChild(lane);
    }
    section.appendChild(card);
    return section;
  }

  // What is typed into the fields drawn inside the list survives a redraw,
  // and so does where the cursor was.
  function captureFields() {
    var state = { values: {}, focus: null };
    Array.prototype.forEach.call(el.categories.querySelectorAll('[data-focus-key]'), function (n) {
      state.values[n.getAttribute('data-focus-key')] = n.value;
    });
    var active = document.activeElement;
    if (active && el.categories.contains(active) && active.getAttribute('data-focus-key')) {
      state.focus = { key: active.getAttribute('data-focus-key'), start: active.selectionStart, end: active.selectionEnd };
    }
    return state;
  }

  function restoreFields(state) {
    Object.keys(state.values).forEach(function (key) {
      var n = el.categories.querySelector('[data-focus-key="' + key + '"]');
      if (n) n.value = state.values[key];
    });
    if (state.focus) {
      var n = el.categories.querySelector('[data-focus-key="' + state.focus.key + '"]');
      if (n) {
        n.focus();
        try { n.setSelectionRange(state.focus.start, state.focus.end); } catch (e) { /* date and time fields */ }
      }
    }
  }

  var refreshing = false; // a redraw is replacing the fields, so their blur is not a save
  var renderWanted = false;

  function render() {
    if (!data) return;
    // Mid-drag the rows stay put; the redraw happens when it ends.
    if (drag) { renderWanted = true; return; }
    if (editingId != null && !findItem(editingId)) editingId = null;
    if (dueId != null && (!findItem(dueId) || !datesOn())) dueId = null;
    if (renamingCat != null && !findCat(renamingCat)) renamingCat = null;

    refreshing = true;
    var fields = captureFields();
    el.categories.textContent = '';
    var shown = 0;
    displayCategories().forEach(function (cat) {
      var section = categorySection(cat);
      if (section) { el.categories.appendChild(section); shown++; }
    });
    restoreFields(fields);
    refreshing = false;

    var searching = searchActive();
    var anything = data.items.length || data.categories.some(function (c) { return !c.is_default; });
    el.categories.hidden = !shown;
    el.empty.hidden = searching || !!anything;
    el.noResults.hidden = !searching || !!shown;
    el.noResults.textContent = 'No items match "' + query.trim() + '"';
    el.quickAdd.hidden = searching;
    el.newCategory.hidden = searching;
    el.searchClear.hidden = !query;
    el.dueSwitch.checked = datesOn();
    renderActivity();
    syncHistory();
    el.loading.hidden = true;
    el.error.hidden = true;
  }

  function renderActivity() {
    var a = data.activity;
    el.activity.hidden = !(a && a.actor);
    if (!a || !a.actor) return;
    var verb = a.verb === 'added' || a.verb === 'removed' ? a.verb : 'checked';
    var text = a.text.length > 44 ? a.text.slice(0, 43) + '…' : a.text;
    el.activity.textContent = '@' + a.actor + ' ' + verb + ' “' + text + '”';
  }

  // ── Dragging ─────────────────────────────────────────────────────────────
  //
  // The row (or category) being dragged stays in the list, faded, and moves
  // to wherever it would land; a copy follows the pointer. On a touch screen
  // an item lifts after a short hold, so a swipe still scrolls the page.

  var drag = null;
  var justDragged = 0;

  function startItemDrag(e, row, item) {
    if (drag || searchActive() || datesOn() || e.button > 0) return;
    beginPointer(e, { kind: 'item', node: row, item: item, hold: TOUCH });
  }

  function startCategoryDrag(e, cat) {
    if (drag || searchActive() || e.button > 0) return;
    var section = el.categories.querySelector('[data-category="' + cat.id + '"]');
    if (!section) return;
    e.preventDefault();
    beginPointer(e, { kind: 'category', node: section, cat: cat, hold: false });
  }

  function beginPointer(e, d) {
    d.x = e.clientX;
    d.y = e.clientY;
    d.pointerId = e.pointerId;
    d.active = false;
    d.timer = null;
    drag = d;
    if (d.hold) drag.timer = setTimeout(lift, 300);
    else if (d.kind === 'category') lift();
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', cancelDrag);
  }

  function lift() {
    if (!drag || drag.active) return;
    drag.active = true;
    var source = drag.kind === 'category' ? drag.node.firstChild : drag.node;
    var rect = source.getBoundingClientRect();
    var ghost = source.cloneNode(true);
    ghost.className = 'pointer-events-none fixed z-50 flex items-center gap-1 overflow-hidden rounded-xl border border-accent bg-surface px-1 opacity-90 shadow-lg';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    ghost.style.width = rect.width + 'px';
    drag.offsetX = drag.x - rect.left;
    drag.offsetY = drag.y - rect.top;
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.node.classList.add('opacity-40');
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 6) return;
      // Moving before the hold is a scroll on a touch screen; with a mouse it is a drag.
      if (drag.hold) { cancelDrag(); return; }
      lift();
    }
    drag.ghost.style.left = (e.clientX - drag.offsetX) + 'px';
    drag.ghost.style.top = (e.clientY - drag.offsetY) + 'px';
    if (e.clientY < 60) window.scrollBy(0, -12);
    else if (e.clientY > window.innerHeight - 60) window.scrollBy(0, 12);
    if (drag.kind === 'item') placeItem(e.clientX, e.clientY);
    else placeCategory(e.clientX, e.clientY);
  }

  function placeItem(x, y) {
    var under = document.elementFromPoint(x, y);
    if (!under || !el.categories.contains(under)) return;
    var row = under.closest('[data-item]');
    if (row && row !== drag.node) {
      var rect = row.getBoundingClientRect();
      row.parentNode.insertBefore(drag.node, y < rect.top + rect.height / 2 ? row : row.nextSibling);
      return;
    }
    if (row) return;
    // Over a category but not a row: to the end of its open items, or the
    // start of its ticked ones.
    var section = under.closest('[data-category]');
    if (!section) return;
    var list = section.querySelector('ul[data-section="' + (drag.item.checked ? 'done' : 'open') + '"]');
    if (!list) return;
    list.hidden = false;
    if (drag.node.parentNode !== list) {
      if (drag.item.checked) list.insertBefore(drag.node, list.firstChild);
      else list.appendChild(drag.node);
    }
  }

  function placeCategory(x, y) {
    var under = document.elementFromPoint(x, y);
    if (!under || !el.categories.contains(under)) return;
    var section = under.closest('[data-category]');
    if (!section || section === drag.node || section.hasAttribute('data-default')) return;
    var rect = section.getBoundingClientRect();
    el.categories.insertBefore(drag.node, y < rect.top + rect.height / 2 ? section : section.nextSibling);
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var d = drag;
    var wasActive = d.active;
    stopDrag();
    if (!wasActive) return;
    justDragged = Date.now();
    if (d.kind === 'item') dropItem(d);
    else dropCategory();
  }

  function cancelDrag() {
    var wasActive = drag && drag.active;
    stopDrag();
    if (wasActive) render();
  }

  function stopDrag() {
    if (!drag) return;
    clearTimeout(drag.timer);
    if (drag.ghost) drag.ghost.remove();
    drag.node.classList.remove('opacity-40');
    drag = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', cancelDrag);
    if (renderWanted) { renderWanted = false; render(); }
  }

  // Once a drag is under way on a touch screen, the page must not scroll under it.
  document.addEventListener('touchmove', function (e) { if (drag && drag.active) e.preventDefault(); }, { passive: false });
  // A long press is a drag here, not the system's menu.
  document.addEventListener('contextmenu', function (e) { if (drag) e.preventDefault(); });

  function dropItem(d) {
    var item = findItem(d.item.id);
    var section = d.node.closest('[data-category]');
    if (!item || !section) { render(); return; }
    var toCat = Number(section.getAttribute('data-category'));
    var fromCat = item.category_id;
    var checked = !!item.checked;
    var landedInDone = d.node.parentNode.getAttribute('data-section') === 'done';
    // Within one category, the open and ticked items are ordered apart, so a
    // drop across that line springs back. Into another category, the item
    // joins whichever part matches it.
    if (fromCat === toCat) {
      var others = Array.prototype.filter.call(section.querySelectorAll('[data-item]'), function (r) { return r !== d.node; });
      if (others.length && landedInDone !== checked) { render(); return; }
    }
    // A ticked item put into a category hiding its ticked items would vanish.
    if (fromCat !== toCat && checked && !catShowDone(toCat)) catDoneOverrides[toCat] = true;
    var ids = Array.prototype.filter.call(section.querySelectorAll('[data-item]'), function (r) {
      return (r.getAttribute('data-checked') === '1') === checked;
    }).map(function (r) { return Number(r.getAttribute('data-item')); });
    var before = sectionItems(toCat, checked).map(function (i) { return i.id; });
    if (fromCat === toCat && before.join() === ids.join()) { render(); return; }
    item.category_id = toCat;
    ids.forEach(function (id, index) {
      var it = findItem(id);
      if (it) it.sort_order = index + 1;
    });
    generation++;
    render();
    if (ids.some(isTemp)) {
      toast('Still saving that item: its position will settle in a moment.');
      return;
    }
    if (fromCat !== toCat) commit({ type: 'move', itemId: item.id, method: 'PATCH', path: '/api/items/{id}', body: { category_id: toCat } });
    commit({ type: 'order', itemId: null, method: 'POST', path: '/api/categories/' + toCat + '/reorder-items', body: { itemIds: ids } });
  }

  function dropCategory() {
    var ids = Array.prototype.map.call(el.categories.querySelectorAll('[data-category]:not([data-default])'), function (s) {
      return Number(s.getAttribute('data-category'));
    });
    var before = displayCategories().filter(function (c) { return !c.is_default; }).map(function (c) { return c.id; });
    if (before.join() === ids.join()) { render(); return; }
    ids.forEach(function (id, index) {
      var c = findCat(id);
      if (c) c.sort_order = index + 1;
    });
    generation++;
    render();
    commit({ type: 'order', itemId: null, method: 'POST', path: '/api/categories/reorder', body: { categoryIds: ids } });
  }

  // ── Markdown ─────────────────────────────────────────────────────────────

  function listName() { return document.querySelector('h1').textContent.trim() || 'Groceries'; }

  function buildMarkdown() {
    var active = [];
    var done = [];
    displayCategories().forEach(function (c) {
      var un = sectionItems(c.id, false);
      var ch = sectionItems(c.id, true);
      if (un.length || !ch.length) {
        active.push('* ' + c.name);
        un.forEach(function (i) { active.push('  * ' + i.text); });
      }
      if (ch.length) {
        done.push('* ' + (un.length ? c.name : '~~' + c.name + '~~'));
        ch.forEach(function (i) { done.push('  * ~~' + i.text + '~~'); });
      }
    });
    var lines = ['# **' + listName() + '**', ''].concat(active);
    if (done.length) lines = lines.concat(['', '---', ''], done);
    return lines.join('\n') + '\n';
  }

  function stripMd(s) { return s.replace(/\*\*/g, '').replace(/~~/g, '').trim(); }

  function parseMarkdown(md) {
    var name = null;
    var categories = [];
    var byKey = {};
    var cur = null;
    md.split(/\r?\n/).forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      if (!line.trim() || /^-{3,}$/.test(line.trim())) return;
      var heading = line.match(/^#+\s+(.*)$/);
      if (heading) { if (!name) name = stripMd(heading[1]); return; }
      var m = line.match(/^(\s*)[*+-]\s+(.*)$/);
      if (!m) return;
      var indent = m[1].replace(/\t/g, '  ').length;
      var text = m[2].trim();
      var checked = false;
      var struck = text.match(/^~~([\s\S]*)~~$/);
      if (struck) { checked = true; text = struck[1].trim(); }
      text = text.replace(/\*\*/g, '').trim();
      if (!text) return;
      if (indent === 0) {
        var key = text.toLowerCase();
        cur = byKey[key];
        if (!cur) {
          cur = { name: text, items: [] };
          byKey[key] = cur;
          categories.push(cur);
        }
      } else {
        if (!cur) {
          cur = byKey.general || { name: 'General', items: [] };
          if (!byKey.general) { byKey.general = cur; categories.push(cur); }
        }
        cur.items.push({ text: text, checked: checked });
      }
    });
    return { name: name, categories: categories };
  }

  var importing = false;
  function runImport(mode) {
    if (importing) return;
    var parsed = parseMarkdown(el.importText.value);
    if (!parsed.categories.length || !parsed.categories.some(function (c) { return c.items.length; })) {
      toast('Nothing to import: expected bullets like "* Category" with "  * item" beneath');
      return;
    }
    importing = true;
    api('POST', '/api/import', { categories: parsed.categories, mode: mode }).then(function () {
      el.importText.value = '';
      el.importPanel.hidden = true;
      toast(mode === 'replace' ? 'List replaced' : 'Imported');
      return refresh(true);
    }, function (err) { toast(err.message); }).then(function () { importing = false; });
  }

  function copyExport() {
    function fallback() {
      el.exportText.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      toast(ok ? 'Copied to clipboard' : 'Select the text and copy it');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(el.exportText.value).then(function () { toast('Copied to clipboard'); }, fallback);
    } else {
      fallback();
    }
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  var loading = null;
  // force: also when something is open or being sent (after an import, or a
  // change the server refused).
  function refresh(force) {
    if (loading) return loading;
    var asked = generation;
    loading = api('GET', '/api/list')
      .then(function (d) {
        // A change made while this was on its way would be undone by it.
        if (loaded && !force && (asked !== generation || queue.length)) return;
        loaded = true;
        data = d;
        render();
      })
      .catch(function (err) {
        // A refresh that fails keeps what is on screen; only a first load
        // with nothing to show turns into the error state.
        if (loaded) { if (force) toast(err.message); }
        else { el.loading.hidden = true; el.error.hidden = false; }
      })
      .then(function () { loading = null; });
    return loading;
  }

  function busy() {
    return !!drag || queue.length > 0 || armed > 0 || editingId != null || dueId != null || renamingCat != null;
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  el.undo.appendChild(icon('undo'));
  el.redo.appendChild(icon('redo'));
  el.menuButton.appendChild(icon('menu'));
  el.searchClear.appendChild(icon('cross', 'h-4 w-4'));
  el.undo.addEventListener('click', undo);
  el.redo.addEventListener('click', redo);

  function setMenu(open) {
    el.menu.hidden = !open;
    el.menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  el.menuButton.addEventListener('click', function () { setMenu(el.menu.hidden); });
  // A tap anywhere else closes it, and so does Escape.
  document.addEventListener('click', function (e) {
    if (!el.menu.hidden && !el.menu.contains(e.target) && !el.menuButton.contains(e.target)) setMenu(false);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !el.menu.hidden) setMenu(false); });
  document.getElementById('show-completed').addEventListener('click', function () { setMenu(false); if (data) setShowCompleted(true); });
  document.getElementById('hide-completed').addEventListener('click', function () { setMenu(false); if (data) setShowCompleted(false); });
  el.dueSwitch.addEventListener('change', function () { if (data) setDueDates(el.dueSwitch.checked); });
  document.getElementById('open-export').addEventListener('click', function () {
    if (!data) return;
    setMenu(false);
    el.importPanel.hidden = true;
    el.exportText.value = buildMarkdown();
    el.exportPanel.hidden = false;
  });
  document.getElementById('open-import').addEventListener('click', function () {
    setMenu(false);
    el.exportPanel.hidden = true;
    el.importPanel.hidden = false;
    el.importText.focus();
  });
  document.getElementById('export-close').addEventListener('click', function () { el.exportPanel.hidden = true; });
  document.getElementById('export-copy').addEventListener('click', copyExport);
  document.getElementById('import-cancel').addEventListener('click', function () { el.importPanel.hidden = true; });
  document.getElementById('import-add').addEventListener('click', function () { runImport('add'); });
  tapTwice(document.getElementById('import-replace'), 'Tap again to replace everything', function () { runImport('replace'); });

  el.search.addEventListener('input', function () { query = el.search.value; render(); });
  el.search.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); el.search.value = ''; query = ''; render(); }
  });
  el.searchClear.addEventListener('click', function () { el.search.value = ''; query = ''; render(); el.search.focus(); });

  el.quickAdd.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = el.quickAdd.elements.text;
    var text = input.value.trim();
    if (!text || !data) return;
    var general = defaultCat() || displayCategories()[0];
    if (!general) { toast('This list has no category to add to'); return; }
    input.value = '';
    addItem(general, text, true);
  });
  commitOnBlur(el.quickAdd.elements.text);

  el.newCategory.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = el.newCategory.elements.name;
    var name = input.value.trim();
    if (!name || !data) return;
    input.value = '';
    addCategory(name).catch(function (err) {
      if (!input.value) input.value = name;
      toast(err.message);
    });
  });
  commitOnBlur(el.newCategory.elements.name);

  // Cmd/Ctrl+Z undoes; Shift+Cmd/Ctrl+Z or Ctrl+Y redoes. Not while typing:
  // there the field's own undo is the right one.
  document.addEventListener('keydown', function (e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    var k = (e.key || '').toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    if (k === 'y' || e.shiftKey) redo(); else undo();
  });

  document.getElementById('retry').addEventListener('click', function () {
    el.error.hidden = true;
    el.loading.hidden = false;
    refresh();
  });

  // Other people shop too: look again every few seconds while the app is on
  // screen, and straight away when it comes back. Not mid-drag, mid-edit or
  // while changes are still going out.
  setInterval(function () {
    if (!document.hidden && !busy()) refresh();
  }, POLL_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !busy()) refresh(); });

  refresh();
})();
