// The grocery list screen. Talks to api.js; every request carries the
// platform token the frame was opened with, which is how the server knows
// who you are.
//
// One list the whole project shares, working and looking the way a list
// does in Homeroom's Todo List app:
//   - A fixed nav bar (the native UI kit's), with undo, redo and the menu;
//     the large title folds into it as the list scrolls. The menu opens
//     over the page: a sheet on a phone, a dropdown on a computer.
//   - General items first, with no heading, then each category. Quick-add
//     puts an item at the top of General; a category's + puts one at the
//     top of that category.
//   - Ticking keeps an item's place: each category shows its open items,
//     then "N done" and the ticked ones below, each in their own order. Who
//     last ticked or unticked an item shows on it.
//   - Swipe a row left for Complete, Rename and Delete (a full swipe
//     deletes); swipe a category's name for Rename and Delete. Tap an item's
//     words to edit them.
//   - Press and hold an item (or use its handle with a mouse) to drag it
//     within or between categories; categories move by their handle. Not
//     while searching, not items while due dates are on (dates set the
//     order then), and not offline.
//   - A category folds away by tapping its name, and a finished one starts
//     folded. Which ones are folded is remembered on this device, and so is
//     whether ticked items show at all.
//   - Undo and redo (up to 50 steps) for adding, deleting, editing, ticking
//     and due dates; also Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z or Ctrl+Y.
//   - Search filters as you type; a category whose name matches shows all
//     of its items. Pull the list down to fetch it again.
//   - Markdown export and import, in Todo List's format.
//   - Offline: the list opens from the copy saved on this device (the
//     service worker in sw.js keeps the page itself). Adding, ticking,
//     editing, due dates and deleting work offline too: each change shows at
//     once, is saved on this device in a queue, and is sent, in order, the
//     moment the connection is back. A strip under the nav bar says which
//     world the list is in. Categories, reordering, due dates on or off and
//     import need a connection, and say so.
// Other people's changes arrive the moment they are made (live updates,
// public/live-updates.js).
//
// Rendering builds elements and sets textContent, never markup with
// people's words in it, so an item called "<b>hi</b>" shows exactly that.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';
  // A touch screen: no drag handles on items (press and hold instead),
  // swipe for Rename and Delete, and leaving an add field with something
  // typed in it adds it.
  var TOUCH = window.matchMedia('(hover: none)').matches;
  var HISTORY_MAX = 50;
  var KEY_COLLAPSED = 'grocery-list:collapsed';
  var KEY_SHOW_COMPLETED = 'grocery-list:showCompleted';
  var KEY_LAST_USER = 'grocery-list:last-user';
  var LOAD_TIMEOUT_MS = 12000; // a read the screen is waiting to paint
  var WRITE_TIMEOUT_MS = 8000; // a queued write, retried anyway
  var PROBE_TIMEOUT_MS = 3000; // is the server there at all?
  var HINT_MS = 700; // before an unsent change admits it is waiting

  var el = {
    bar: document.getElementById('bar'),
    largeTitle: document.getElementById('large-title'),
    undo: document.getElementById('undo'),
    redo: document.getElementById('redo'),
    menuButton: document.getElementById('menu-button'),
    menu: document.getElementById('menu'),
    strip: document.getElementById('offline-chip'),
    activity: document.getElementById('activity'),
    search: document.getElementById('search'),
    searchIcon: document.getElementById('search-icon'),
    searchClear: document.getElementById('search-clear'),
    quickAdd: document.getElementById('quick-add'),
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    errorText: document.getElementById('error-text'),
    empty: document.getElementById('empty'),
    noResults: document.getElementById('no-results'),
    categories: document.getElementById('categories'),
    newCategory: document.getElementById('new-category'),
  };

  var data = null; // { me, now, list, categories, items, activity }
  var loaded = false;
  var showingSaved = false; // what is on screen came from this device's copy

  // What is open on screen.
  var query = '';
  var catDoneOverrides = {}; // category id -> show its ticked items (this visit)
  var openAdders = {}; // category id -> its add field is open
  var editingId = null; // the item whose text is being edited
  var renamingCat = null; // the category being renamed

  function kit() { return window.unNative || null; }

  // ── Small helpers ────────────────────────────────────────────────────────

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
    search: 'M9 15a6 6 0 100-12 6 6 0 000 12zM17 17l-3.5-3.5',
  };

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
    var b = button(className || 'flex h-11 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:text-fg', null, onClick);
    b.setAttribute('aria-label', label);
    b.title = label;
    b.appendChild(icon(kind, 'h-4 w-4'));
    return b;
  }

  // Short feedback: the kit's toast (a capsule at the bottom on an iPhone or
  // a computer, a snackbar on Android).
  function toast(message) {
    if (kit()) kit().toast(message);
  }

  // A question with a destructive answer, as the platform asks it: an
  // action sheet. Homeroom's app frame allows no browser dialogs.
  function askToConfirm(title, label) {
    if (!kit()) return Promise.resolve(true);
    return kit().actionSheet({ title: title, actions: [{ label: label, destructive: true }], cancelLabel: 'Cancel' })
      .then(function (chosen) { return !!chosen; });
  }

  // The moment it is for the viewer: a preview's chosen time, or the device's.
  function clock() {
    return window.usernode && window.usernode.previewNow ? window.usernode.now() : new Date();
  }

  function me() { return data && data.me ? data.me.username : (identity && identity.username) || null; }
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
  function copy(o) {
    var out = {};
    for (var k in o) out[k] = o[k];
    return out;
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

  // ── Who this is, and this device's storage ──────────────────────────────
  //
  // The token says who is signed in, for the server; the page reads its
  // name and id only to keep each person's saved copy and queued changes
  // apart on a shared device. An offline load has no token (the shell
  // cannot make one with no connection), so the page remembers who last
  // opened it, never the token itself, and uses that. Nothing of anybody's
  // is cleared on a load that does not know who it is.

  var claims = (function () {
    try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return null; }
  })();
  var KNOWN = !!(claims && claims.id != null);

  // Storage that works, or memory standing in for it: a device that refuses
  // this frame its storage still runs the list, and the strip says the
  // queue is only kept until the app is closed.
  var memory = {};
  var DURABLE = (function () {
    try {
      localStorage.setItem('grocery-list:probe', '1');
      var ok = localStorage.getItem('grocery-list:probe') === '1';
      localStorage.removeItem('grocery-list:probe');
      return ok;
    } catch (e) { return false; }
  })();
  function stored(key) {
    if (!DURABLE) return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function store(key, value) {
    if (!DURABLE) { memory[key] = value; return true; }
    try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }
  function storedJSON(key) { try { return JSON.parse(stored(key)); } catch (e) { return null; } }

  var identity = KNOWN ? { id: claims.id, username: claims.username } : storedJSON(KEY_LAST_USER);
  if (KNOWN) store(KEY_LAST_USER, JSON.stringify(identity));
  var NS = 'grocery-list:u' + (identity && identity.id != null ? identity.id : 'anon') + ':';
  var KEY_SAVED = NS + 'list';
  var KEY_QUEUE = NS + 'queue';

  // Another person's saved copy and queue go once this load knows who it is.
  if (DURABLE && KNOWN) {
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (/^grocery-list:u[^:]+:/.test(k) && k.indexOf(NS) !== 0) localStorage.removeItem(k);
      });
    } catch (e) { /* the list still works */ }
  }

  function saveCopy() { if (data) store(KEY_SAVED, JSON.stringify(data)); }

  // ── Talking to the server ────────────────────────────────────────────────

  // Every request has a deadline. A failure says what kind it was: no
  // connection (network), a connection that did not answer in time
  // (timeout), or the server's own answer (status).
  function api(method, url, body, timeoutMs) {
    var headers = { 'x-usernode-token': token };
    // A preview opened at a chosen moment tells the server what time it is
    // there (req.now; "Time-dependent features" in the platform conventions).
    if (window.usernode && window.usernode.previewNow) headers['x-usernode-now'] = window.usernode.now().toISOString();
    if (body) headers['Content-Type'] = 'application/json';
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timedOut = false;
    var timer = ctl ? setTimeout(function () { timedOut = true; ctl.abort(); }, timeoutMs || LOAD_TIMEOUT_MS) : null;
    return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, signal: ctl ? ctl.signal : undefined })
      .then(function (res) {
        clearTimeout(timer);
        return res.json().catch(function () { return {}; }).then(function (d) {
          if (!res.ok) {
            var err = new Error(d.error === 'account_required'
              ? 'Make an account to join in.'
              : d.error || 'Something went wrong (' + res.status + ').');
            err.status = res.status;
            throw err;
          }
          // Anything that came back is the connection working.
          if ((conn === 'offline' || conn === 'slow') && !replaying && !queue().length) markOnline();
          return d;
        });
      }, function () {
        clearTimeout(timer);
        var err;
        if (timedOut) {
          markSlow();
          err = new Error('The connection is slow. Changes will keep trying.');
          err.timeout = true;
        } else {
          markOffline();
          err = new Error('You are offline.');
        }
        err.network = true;
        err.status = 0;
        throw err;
      });
  }

  // The server's health check, which needs no sign-in: is it there at all?
  function reachable() {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, PROBE_TIMEOUT_MS) : null;
    return fetch('/health', { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (res) { clearTimeout(timer); return res.ok; }, function () { clearTimeout(timer); return false; });
  }

  // ── The connection, and the strip that says so ──────────────────────────
  //
  // 'online', 'slow' (connected but not answering in time), 'offline',
  // 'syncing' (sending what waited) or 'blocked' (the server did not accept
  // this load's sign-in, so the queue waits for the next load's).

  var conn = navigator.onLine === false ? 'offline' : 'online';
  function isOnline() { return conn !== 'offline'; }
  function markOffline() {
    var was = conn;
    conn = 'offline';
    renderStrip();
    if (was !== 'offline') { wireNative(); scheduleReplay(); }
  }
  function markSlow() {
    if (conn !== 'offline' && conn !== 'blocked') conn = 'slow';
    renderStrip();
  }
  function markOnline() {
    var was = conn;
    conn = 'online';
    renderStrip();
    if (was === 'offline') wireNative();
  }

  var flash = null;
  var flashTimer = null;
  function flashSynced() {
    flash = 'All changes synced';
    renderStrip();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { flash = null; renderStrip(); }, 2200);
  }

  function changes(n) { return n + (n === 1 ? ' change' : ' changes'); }

  function stripState() {
    if (flash) return { text: flash };
    var n = queue().length;
    // An offline load has no sign-in to send with; the next load has one.
    if (conn === 'blocked') {
      return token ? { text: changes(n) + ' waiting: tap to try again', tap: true } : { text: changes(n) + ' waiting: they sync when the list reopens online' };
    }
    if (conn === 'offline') {
      // Never promise what this device cannot keep.
      if (!DURABLE) return { text: 'Offline: changes are kept until you close the app' };
      if (n) return { text: 'Offline: ' + changes(n) + ' will sync' };
      return { text: showingSaved || loaded ? 'Offline: showing the list saved on this device' : 'Offline: nothing saved on this device yet' };
    }
    if (conn === 'slow') return n ? { text: 'Slow connection: ' + changes(n) + ' will sync', tap: true } : { text: 'Slow connection' };
    if (conn === 'syncing') {
      if (!syncVisible && !hintShown) return null;
      return { text: n > 1 ? 'Syncing ' + changes(n) + '…' : 'Saving…' };
    }
    if (n && hintShown) return { text: n === 1 ? 'Saving…' : changes(n) + ' waiting to sync', tap: true };
    return null;
  }

  function renderStrip() {
    var st = stripState();
    document.body.classList.toggle('is-offline', conn === 'offline');
    el.strip.hidden = !st;
    el.strip.textContent = st ? st.text : '';
    el.strip.classList.toggle('tappable', !!(st && st.tap));
  }
  el.strip.addEventListener('click', function () {
    var st = stripState();
    if (st && st.tap) drain(true);
  });

  // Nothing flashes for a change that lands quickly: a row only shows it is
  // waiting, and the strip only says "Saving…", once a change has been
  // unsent for a moment.
  var hintShown = false;
  var hintTimer = null;
  function syncHint(queued) {
    if (queued) {
      if (!hintShown && !hintTimer) {
        hintTimer = setTimeout(function () {
          hintTimer = null;
          hintShown = true;
          if (replaying) syncVisible = true;
          renderStrip();
          render();
        }, HINT_MS);
      }
      return;
    }
    clearTimeout(hintTimer);
    hintTimer = null;
    if (hintShown) { hintShown = false; render(); }
  }

  // ── The queue of changes ─────────────────────────────────────────────────
  //
  // Every item change (add, tick, edit, due date, delete) shows at once and
  // is saved in a queue on this device, then sent to the server one at a
  // time, in order, by drain(). With no connection the queue waits, and is
  // still there if the app is closed; it is sent when the connection is
  // back (the shell reloads the frame then, with a fresh sign-in). A new
  // item has a temporary (negative) id until the server answers, and every
  // change queued behind it is pointed at the real one. An add carries an
  // idempotency key (client_op_id), so a retried add is the same item.

  var memoryQueue = [];
  function queue() { return DURABLE ? (storedJSON(KEY_QUEUE) || []) : memoryQueue; }
  function saveQueue(q) {
    var ok = DURABLE ? store(KEY_QUEUE, JSON.stringify(q)) : ((memoryQueue = q), true);
    syncHint(q.length > 0);
    renderStrip();
    return ok;
  }

  // Temporary ids start from the clock, so they never meet ids left in a
  // queue saved by an earlier visit.
  var tempSeq = -(Date.now() % 1e9) - 1;
  function isTemp(id) { return id < 0; }
  function opId() { return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  var generation = 0; // bumped by every local change, so a stale read is dropped

  // Saves the change (already on screen) and starts sending. False when it
  // could not be saved, and the caller puts the screen back.
  function commit(op) {
    generation++;
    op.attempts = 0;
    if (!saveQueue(coalesce(queue(), op))) {
      toast('There is no room on this device to keep that change.');
      return false;
    }
    drain();
    return true;
  }

  // Redundant changes collapse: a tick and an untick, or two renames, send
  // one request. The change being sent right now is left alone.
  function coalesce(q, op) {
    var first = replaying ? 1 : 0;
    if (op.type === 'toggle' || op.type === 'edit' || op.type === 'due') {
      for (var i = q.length - 1; i >= first; i--) {
        if (q[i].type === op.type && q[i].itemId === op.itemId) {
          var merged = copy(op);
          merged.undo = q[i].undo || op.undo;
          q[i] = merged;
          return q;
        }
      }
    } else if (op.type === 'delete') {
      // A delete replaces every unsent change to the item; an item whose add
      // never went out simply never existed.
      var cancelsAdd = false;
      for (var j = q.length - 1; j >= first; j--) {
        if (q[j].itemId !== op.itemId) continue;
        if (q[j].type === 'add') cancelsAdd = true;
        q.splice(j, 1);
      }
      if (cancelsAdd) return q;
    }
    q.push(op);
    return q;
  }

  // Which items have unsent changes (a quiet mark on their row).
  function pendingIds() {
    var ids = {};
    queue().forEach(function (o) { ids[o.itemId] = true; });
    return ids;
  }

  // What the server's copy of the list looks like with this device's unsent
  // changes on top, so a read never undoes on screen what is still queued.
  function project(payload) {
    queue().forEach(function (op) {
      var i;
      if (op.type === 'add') {
        if (op.item && !payload.items.some(function (x) { return x.id === op.itemId; })) payload.items.push(copy(op.item));
        return;
      }
      if (op.type === 'delete') {
        payload.items = payload.items.filter(function (x) { return x.id !== op.itemId; });
        return;
      }
      for (i = 0; i < payload.items.length; i++) {
        if (payload.items[i].id !== op.itemId) continue;
        var it = payload.items[i];
        for (var k in op.body) it[k] = op.body[k];
        if (op.type === 'toggle') {
          it.completed_at = op.body.checked ? (op.at || it.completed_at) : null;
          it.last_checked_by = op.by || it.last_checked_by;
        }
      }
    });
    return payload;
  }

  // A change the server refused for good comes off the screen too.
  function applyUndo(op) {
    if (!data) return;
    if (op.type === 'add') {
      data.items = data.items.filter(function (i) { return i.id !== op.itemId; });
    } else if (op.type === 'delete') {
      if (op.undo && !findItem(op.itemId)) data.items.push(copy(op.undo));
    } else if (op.undo) {
      var item = findItem(op.itemId);
      if (item) for (var k in op.undo) item[k] = op.undo[k];
    }
    saveCopy();
    render();
  }

  // ── Sending what waited ──────────────────────────────────────────────────

  var REPLAY_IDLE_MS = 15000;
  var BACKOFF_START_MS = 5000;
  var BACKOFF_MAX_MS = 30000;
  var MAX_ATTEMPTS = 5;
  var replayTimer = null;
  var replaying = false;
  var syncVisible = false;
  var backoff = BACKOFF_START_MS;

  function scheduleReplay(delay) {
    clearTimeout(replayTimer);
    replayTimer = setTimeout(function () { replayTimer = null; drain(); }, delay || REPLAY_IDLE_MS);
  }

  function drain(force) { attemptReplay(force).catch(function () {}); }

  // One change, sent. An add's answer points every change queued behind it,
  // and the row on screen, at the item's real id.
  function runOp(op) {
    if (op.type === 'add') {
      return api('POST', op.path, op.body, WRITE_TIMEOUT_MS).then(function (d) {
        saveQueue(queue().slice(1).map(function (o) {
          if (o.itemId !== op.itemId) return o;
          var moved = copy(o);
          moved.itemId = d.item.id;
          return moved;
        }));
        adopt(op.itemId, d.item);
      });
    }
    if (isTemp(op.itemId)) { saveQueue(queue().slice(1)); return Promise.resolve(); }
    var path = '/api/items/' + op.itemId;
    return api(op.type === 'delete' ? 'DELETE' : 'PATCH', path, op.type === 'delete' ? null : op.body, WRITE_TIMEOUT_MS)
      .then(function () { saveQueue(queue().slice(1)); });
  }

  function attemptReplay(force) {
    if (replaying) return Promise.resolve();
    if (!queue().length) {
      if (conn === 'blocked') markOnline();
      // Nothing waiting, but while offline keep looking, so the strip clears
      // itself the moment the connection is back.
      if (conn !== 'offline') { renderStrip(); return Promise.resolve(); }
      return reachable().then(function (up) {
        if (!up) { scheduleReplay(); return; }
        markOnline();
        refresh(true);
      });
    }
    if (!force && navigator.onLine === false) { markOffline(); return Promise.resolve(); }
    var check = conn === 'offline' || force ? reachable() : Promise.resolve(true);
    return check.then(function (up) {
      if (!up) { markOffline(); return; }
      replaying = true;
      // Catching up after a bad connection says so at once; an ordinary
      // change stays quiet unless it turns out slow.
      syncVisible = conn === 'offline' || conn === 'slow' || conn === 'blocked';
      conn = 'syncing';
      renderStrip();
      var dropped = 0;
      function next() {
        var q = queue();
        if (!q.length) return Promise.resolve(true);
        var op = q[0];
        return runOp(op).then(next, function (err) {
          if (err.timeout) { markSlow(); scheduleReplay(BACKOFF_START_MS); return false; }
          if (err.network) { markOffline(); scheduleReplay(); return false; }
          if (err.status === 401) {
            // This load's sign-in is not accepted (an offline load has
            // none): keep everything for the next load, which has one.
            conn = 'blocked';
            renderStrip();
            scheduleReplay(BACKOFF_MAX_MS);
            return false;
          }
          if ((err.status === 429 || err.status >= 500) && (op.attempts || 0) + 1 < MAX_ATTEMPTS) {
            var q2 = queue();
            q2[0] = copy(op);
            q2[0].attempts = (op.attempts || 0) + 1;
            saveQueue(q2);
            backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
            conn = 'online';
            scheduleReplay(backoff);
            return false;
          }
          // Refused for good (the item was deleted by somebody else, say):
          // it comes off the screen rather than blocking every later change.
          dropped++;
          saveQueue(queue().slice(1));
          applyUndo(op);
          return next();
        });
      }
      return next().then(function (drained) {
        replaying = false;
        if (conn === 'syncing') conn = 'online';
        if (dropped) toast(changes(dropped) + " couldn't be applied (the item was deleted)");
        if (drained) {
          backoff = BACKOFF_START_MS;
          clearTimeout(replayTimer);
          if (!dropped && syncVisible) flashSynced();
          markOnline();
          refresh(true);
        }
        renderStrip();
      });
    });
  }

  window.addEventListener('online', function () { drain(true); });
  window.addEventListener('offline', markOffline);

  // The server's answer to an add: the item's real id, everywhere it is used.
  function adopt(tempId, item) {
    if (!data) return;
    var local = findItem(tempId);
    if (local) {
      local.id = item.id;
      local.sort_order = item.sort_order;
    }
    undoStack.concat(redoStack).forEach(function (e) { if (e.itemId === tempId) e.itemId = item.id; });
    if (editingId === tempId) editingId = item.id;
    Array.prototype.forEach.call(document.querySelectorAll('[data-focus-key$=":' + tempId + '"]'), function (n) {
      n.setAttribute('data-focus-key', n.getAttribute('data-focus-key').replace(/:-\d+$/, ':' + item.id));
    });
    saveCopy();
    render();
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

  // ── Item changes (offline too) ───────────────────────────────────────────

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
    var ok = commit({
      type: 'add', itemId: tempId, path: quick ? '/api/items' : '/api/categories/' + cat.id + '/items',
      body: { text: text, client_op_id: opId() }, item: copy(item),
    });
    if (!ok) { data.items = data.items.filter(function (i) { return i !== item; }); render(); return null; }
    record({ kind: 'add', itemId: tempId, snapshot: copy(item) });
    saveCopy();
    render();
    return tempId;
  }

  function toggleItem(id, checked) {
    var item = findItem(id);
    if (!item || !!item.checked === checked) return;
    var before = { checked: item.checked, completed_at: item.completed_at, last_checked_by: item.last_checked_by };
    var at = clock().toISOString();
    if (!commit({ type: 'toggle', itemId: id, body: { checked: checked }, undo: before, at: at, by: me() })) { render(); return; }
    record({ kind: 'toggle', itemId: id, before: { checked: !checked }, after: { checked: checked } });
    item.checked = checked;
    item.completed_at = checked ? at : null;
    item.last_checked_by = me() || item.last_checked_by;
    // Ticking the last open item: with ticked items showing, the category
    // stays open; with them hidden, it folds.
    if (checked && isCatFullyDone(item.category_id)) {
      if (catShowDone(item.category_id)) setCatCollapsed(item.category_id, false);
      else clearKeepOpen(item.category_id);
    }
    saveCopy();
    render();
  }

  function editText(id, text) {
    var item = findItem(id);
    if (!item) return false;
    if (item.text === text) return true;
    if (!commit({ type: 'edit', itemId: id, body: { text: text }, undo: { text: item.text } })) return false;
    record({ kind: 'edit', itemId: id, before: { text: item.text }, after: { text: text } });
    item.text = text;
    saveCopy();
    render();
    return true;
  }

  function setDue(id, date, time) {
    var item = findItem(id);
    if (!item) return false;
    var before = { due_date: item.due_date || null, due_time: item.due_time || null };
    var after = { due_date: date || null, due_time: date ? (time || null) : null };
    if (before.due_date === after.due_date && before.due_time === after.due_time) return true;
    if (!commit({ type: 'due', itemId: id, body: after, undo: before })) return false;
    record({ kind: 'due', itemId: id, before: before, after: after });
    item.due_date = after.due_date;
    item.due_time = after.due_time;
    saveCopy();
    render();
    return true;
  }

  // No question asked: Undo brings it back.
  function deleteItem(id) {
    var item = findItem(id);
    if (!item) return;
    if (!commit({ type: 'delete', itemId: id, undo: copy(item) })) { render(); return; }
    record({ kind: 'delete', itemId: id, snapshot: copy(item) });
    data.items = data.items.filter(function (i) { return i !== item; });
    if (editingId === id) editingId = null;
    saveCopy();
    render();
  }

  // Undoing a delete: the server's row is gone, so this is a new item with
  // the old one's text, category, tick and due date, at the top of its
  // category (or General, if its category went too).
  function restoreItem(snap) {
    var cat = findCat(snap.category_id) || defaultCat() || data.categories[0];
    if (!cat) { toast("That item's category is gone"); return null; }
    var id = addItem(cat, snap.text, false);
    if (id == null) return null;
    if (snap.checked) toggleItem(id, true);
    if (snap.due_date) setDue(id, snap.due_date, snap.due_time || null);
    return id;
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

  // ── Changes that need a connection ───────────────────────────────────────
  //
  // Categories, reordering, due dates on or off and import go straight to
  // the server and wait for its answer, so they say so when offline rather
  // than pretending.

  function needsConnection() {
    if (isOnline()) return false;
    toast('You are offline: that needs a connection.');
    return true;
  }

  function writeFailed(err) {
    toast(err.network ? 'You are offline: that needs a connection.' : err.message);
    refresh(true);
  }

  function addCategory(name) {
    return api('POST', '/api/categories', { name: name }, WRITE_TIMEOUT_MS).then(function (d) {
      data.categories.push(d.category);
      saveCopy();
      render();
    });
  }

  function renameCategory(cat, name) {
    renamingCat = null;
    if (!name || name === cat.name) { render(); return; }
    if (needsConnection()) { render(); return; }
    var before = cat.name;
    cat.name = name;
    render();
    api('PATCH', '/api/categories/' + cat.id, { name: name }, WRITE_TIMEOUT_MS).then(saveCopy, function (err) {
      cat.name = before;
      render();
      writeFailed(err);
    });
  }

  function deleteCategory(cat) {
    if (needsConnection()) return;
    if (data.categories.length <= 1) {
      toast("Can't delete the only category: a list needs at least one");
      return;
    }
    var n = data.items.filter(function (i) { return i.category_id === cat.id; }).length;
    askToConfirm(n ? 'Delete ' + cat.name + ' and its ' + n + (n === 1 ? ' item?' : ' items?') : 'Delete ' + cat.name + '?', 'Delete').then(function (yes) {
      if (!yes) return;
      api('DELETE', '/api/categories/' + cat.id, null, WRITE_TIMEOUT_MS).then(function () {
        data.categories = data.categories.filter(function (c) { return c.id !== cat.id; });
        data.items = data.items.filter(function (i) { return i.category_id !== cat.id; });
        delete openAdders[cat.id];
        saveCopy();
        render();
      }, writeFailed);
    });
  }

  function setDueDates(on) {
    var before = datesOn();
    if (before === on || needsConnection()) return;
    data.list.due_dates_enabled = on;
    render();
    api('PATCH', '/api/list', { due_dates_enabled: on }, WRITE_TIMEOUT_MS).then(function () {
      saveCopy();
      toast(on ? 'Due dates on: this list now sorts by date' : 'Due dates off');
    }, function (err) {
      data.list.due_dates_enabled = before;
      render();
      writeFailed(err);
    });
  }

  function dateSortHint() {
    toast('This list is sorted by due date: turn due dates off to reorder by hand');
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

  // The due date editor: a dialog over the list, with the device's own date
  // and time pickers.
  function openDueEditor(id) {
    var item = findItem(id);
    if (!item || !kit()) return;
    var box = h('div', 'flex flex-col gap-4');
    box.appendChild(h('p', 'text-heading', 'Due date'));
    box.appendChild(h('p', 'break-words text-small text-muted', item.text));
    var date = h('input', 'field');
    date.type = 'date';
    date.value = item.due_date || '';
    date.setAttribute('aria-label', 'Date');
    var time = h('input', 'field');
    time.type = 'time';
    time.value = item.due_time || '';
    time.setAttribute('aria-label', 'Time (optional)');
    var dateRow = h('label', 'flex flex-col gap-1 text-small text-muted', 'Date');
    dateRow.appendChild(date);
    var timeRow = h('label', 'flex flex-col gap-1 text-small text-muted', 'Time (optional)');
    timeRow.appendChild(time);
    box.appendChild(dateRow);
    box.appendChild(timeRow);
    var actions = h('div', 'flex flex-wrap justify-end gap-2');
    var modal = null;
    if (item.due_date) {
      actions.appendChild(button('btn-secondary mr-auto border-0 bg-transparent px-2 text-danger', 'Clear', function () {
        modal.dismiss();
        setDue(item.id, null, null);
      }));
    }
    actions.appendChild(button('btn-secondary', 'Cancel', function () { modal.dismiss(); }));
    actions.appendChild(button('btn-primary', 'Save', function () {
      if (!date.value && time.value) { toast('Pick a date first: a time on its own has nothing to be due on'); return; }
      modal.dismiss();
      setDue(item.id, date.value || null, time.value ? time.value.slice(0, 5) : null);
    }));
    box.appendChild(actions);
    modal = kit().presentModal({ contentEl: box });
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  function focusKey(key) {
    var node = el.categories.querySelector('[data-focus-key="' + key + '"]');
    if (node) node.focus({ preventScroll: false });
  }

  // The keyboard's done key closes it without submitting: on a touch screen,
  // leaving an add field with something typed in it adds it.
  function commitOnBlur(input) {
    input.addEventListener('blur', function () {
      if (!TOUCH || !input.value.trim() || !input.form) return;
      if (input.form.requestSubmit) input.form.requestSubmit();
      else input.form.dispatchEvent(new Event('submit', { cancelable: true }));
    });
  }

  function itemRow(item, pending) {
    var row = h('div', 'item-row flex min-h-11 cursor-pointer items-center gap-3 bg-surface py-1.5 pl-4 pr-2');
    row.setAttribute('data-item', String(item.id));
    row.setAttribute('data-checked', item.checked ? '1' : '0');

    // A handle for a mouse; a touch screen lifts the row with a long press.
    if (!searchActive() && !TOUCH) {
      var grip = h('span', datesOn() ? 'flex h-11 w-4 shrink-0 items-center justify-center text-muted/60' : 'item-drag flex h-11 w-4 shrink-0 cursor-grab items-center justify-center text-muted/60');
      grip.title = datesOn() ? 'Sorted by due date' : 'Drag to reorder';
      grip.appendChild(icon('grip', 'h-4 w-4'));
      if (datesOn()) grip.addEventListener('click', dateSortHint);
      row.appendChild(grip);
    }

    var hit = h('label', 'check-hit');
    hit.title = item.checked ? 'Mark as not done' : 'Mark as done';
    var box = h('input', 'check');
    box.type = 'checkbox';
    box.checked = !!item.checked;
    box.setAttribute('aria-label', (item.checked ? 'Untick ' : 'Tick ') + item.text);
    box.addEventListener('change', function () { toggleItem(rowId(row), box.checked); });
    hit.appendChild(box);
    row.appendChild(hit);

    if (editingId === item.id) {
      row.appendChild(editForm(item));
      return row;
    }

    var body = h('div', 'flex min-w-0 flex-1 flex-col py-1.5');
    body.appendChild(h('span', item.checked ? 'break-words text-body text-muted line-through' : 'break-words text-body', item.text));
    if (item.last_checked_by) {
      var by = h('span', 'text-small text-muted', (item.checked ? '✓ @' : '↺ @') + item.last_checked_by);
      by.title = (item.checked ? 'Last checked by @' : 'Last unchecked by @') + item.last_checked_by;
      body.appendChild(by);
    }
    row.appendChild(body);
    if (pending) {
      var dot = h('span', 'shrink-0 px-1 text-body leading-none text-muted', '⋯');
      dot.title = 'Waiting to sync';
      dot.setAttribute('aria-label', 'Waiting to sync');
      row.appendChild(dot);
    }

    if (datesOn()) {
      var label = dueLabel(item);
      var chip = button(label
        ? (isOverdue(item)
          ? 'un-touch-target shrink-0 whitespace-nowrap rounded-full bg-raised px-2 py-0.5 text-small text-danger'
          : 'un-touch-target shrink-0 whitespace-nowrap rounded-full bg-raised px-2 py-0.5 text-small text-muted')
        : 'un-touch-target shrink-0 whitespace-nowrap rounded-full border border-dashed border-line px-2 py-0.5 text-small text-muted', label || '+ date',
      function () { openDueEditor(rowId(row)); });
      chip.setAttribute('data-due', '');
      chip.setAttribute('aria-label', label ? 'Due ' + label + ', change it' : 'Add a due date');
      row.appendChild(chip);
    }

    // On a computer, hover shows Edit and Delete; on a touch screen, a swipe does.
    row.appendChild(iconButton('pencil', 'Edit ' + item.text, function () { startEdit(rowId(row)); },
      'hover-action flex h-11 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:text-fg'));
    row.appendChild(iconButton('cross', 'Delete ' + item.text, function () { deleteItem(rowId(row)); },
      'hover-action flex h-11 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:text-danger'));

    // Tapping the words edits them; only the circle ticks.
    row.addEventListener('click', function (e) {
      if (e.target.closest('button, input, label, .item-drag, [data-due]')) return;
      startEdit(rowId(row));
    });
    return row;
  }

  // A row's id is read when it is tapped: an add that has just reached the
  // server changes it under the row.
  function rowId(row) { return Number(row.getAttribute('data-item')); }

  function startEdit(id) {
    if (!findItem(id)) return;
    editingId = id;
    render();
    focusKey('edit:' + id);
  }

  function editForm(item) {
    var form = h('form', 'flex min-w-0 flex-1 gap-2 py-1');
    form.setAttribute('autocomplete', 'off');
    var input = h('input', 'field min-w-0 flex-1');
    input.value = item.text;
    input.maxLength = 500;
    input.setAttribute('enterkeyhint', 'done');
    input.setAttribute('aria-label', 'Edit ' + item.text);
    input.setAttribute('data-focus-key', 'edit:' + item.id);
    form.appendChild(input);
    var done = false;
    function finish(save) {
      if (done) return;
      done = true;
      var value = input.value.trim();
      editingId = null;
      if (save && value) { if (!editText(item.id, value)) render(); } else render();
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); finish(true); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
    input.addEventListener('blur', function () { if (!refreshing) finish(true); });
    return form;
  }

  function adderForm(cat) {
    var form = h('form', 'flex items-center gap-3 bg-surface px-4');
    form.setAttribute('autocomplete', 'off');
    form.appendChild(h('span', 'select-none text-heading font-normal leading-none text-accent', '+'));
    var input = h('input', 'min-h-11 min-w-0 flex-1 bg-transparent py-2 text-body text-fg placeholder:text-muted/60 focus:outline-none');
    input.name = 'text';
    input.maxLength = 500;
    input.placeholder = 'Add an item…';
    input.setAttribute('enterkeyhint', 'done');
    input.setAttribute('aria-label', 'Add an item to ' + cat.name);
    input.setAttribute('data-focus-key', 'adder:' + cat.id);
    form.appendChild(input);
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
    var head = h('div', 'cat-head flex items-center gap-1 rounded-lg bg-ground');
    head.setAttribute('data-cat-head', String(cat.id));
    var searching = searchActive();
    if (renamingCat === cat.id) {
      var form = h('form', 'flex min-w-0 flex-1 gap-2');
      form.setAttribute('autocomplete', 'off');
      var input = h('input', 'field min-w-0 flex-1');
      input.value = cat.name;
      input.maxLength = 100;
      input.setAttribute('enterkeyhint', 'done');
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
      head.appendChild(form);
      return head;
    }
    if (!searching) {
      var grip = h('span', 'cat-drag flex h-11 w-6 shrink-0 cursor-grab items-center justify-center text-muted/60');
      grip.title = 'Drag to reorder categories';
      grip.appendChild(icon('grip', 'h-4 w-4'));
      head.appendChild(grip);
    }
    var toggle = button('flex min-h-11 min-w-0 flex-1 items-center gap-2 px-1 text-left', null, function () { toggleCatCollapsed(cat); });
    toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    if (!searching) toggle.appendChild(icon('chevron', isCollapsed ? 'h-4 w-4 shrink-0 text-muted' : 'h-4 w-4 shrink-0 rotate-90 text-muted'));
    toggle.appendChild(h('span', 'min-w-0 truncate text-body font-semibold', cat.name));
    if (isCollapsed) {
      var count = open.length + done.length;
      toggle.appendChild(h('span', 'shrink-0 text-small text-muted',
        !open.length && done.length ? done.length + ' done' : count + (count === 1 ? ' item' : ' items')));
    }
    head.appendChild(toggle);
    if (!searching && !isCollapsed) {
      head.appendChild(iconButton('plus', 'Add to ' + cat.name, function () { toggleAdder(cat); },
        'flex h-11 w-10 shrink-0 items-center justify-center rounded-lg text-accent'));
    }
    head.appendChild(iconButton('pencil', 'Rename ' + cat.name, function () { startRename(cat.id); },
      'needs-net hover-action flex h-11 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:text-fg'));
    head.appendChild(iconButton('cross', 'Delete ' + cat.name, function () { deleteCategory(cat); },
      'needs-net hover-action flex h-11 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:text-danger'));
    return head;
  }

  function startRename(catId) {
    if (needsConnection()) return;
    renamingCat = catId;
    render();
    focusKey('rename:' + catId);
  }

  function categorySection(cat, pending) {
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

    var section = h('section', 'cat-section flex flex-col gap-1');
    section.setAttribute('data-category', String(cat.id));
    if (cat.is_default) section.setAttribute('data-default', '');
    var isCollapsed = !searching && catCollapsed(cat);
    if (!cat.is_default) section.appendChild(categoryHeader(cat, isCollapsed, open, done));
    if (isCollapsed) return section;

    var showDone = searching || catShowDone(cat.id);
    var card = h('div', 'list');
    var adderOpen = !searching && openAdders[cat.id];
    if (adderOpen) card.appendChild(adderForm(cat));

    var openList = h('div', 'divide-y divide-line');
    openList.setAttribute('data-section', 'open');
    open.forEach(function (i) { openList.appendChild(itemRow(i, pending[i.id])); });
    // A finished or empty category keeps a lane to add to (and to drop an
    // item on when dragging).
    if (!searching && !cat.is_default && !adderOpen && !open.length) {
      var lane = button('empty-note flex min-h-11 w-full items-center gap-3 px-4 text-left text-small text-muted', null, function () { toggleAdder(cat); });
      lane.appendChild(h('span', 'select-none text-heading font-normal leading-none text-accent', '+'));
      lane.appendChild(h('span', null, all ? 'All done, add another' : 'No items yet'));
      lane.title = all ? 'Add another item' : 'Add the first item';
      openList.appendChild(lane);
    }
    openList.hidden = !openList.children.length;
    card.appendChild(openList);

    if (done.length && !searching) {
      var toggle = button('flex min-h-11 w-full items-center justify-between gap-2 px-4 text-left text-small text-muted',
        null, function () { toggleCatDone(cat.id); });
      toggle.appendChild(h('span', null, done.length + ' done'));
      toggle.appendChild(h('span', null, showDone ? '▾' : '▸'));
      toggle.title = showDone ? 'Hide completed in this category' : 'Show completed in this category';
      toggle.setAttribute('aria-expanded', showDone ? 'true' : 'false');
      card.appendChild(toggle);
    }
    var doneList = h('div', 'divide-y divide-line');
    doneList.setAttribute('data-section', 'done');
    if (showDone) done.forEach(function (i) { doneList.appendChild(itemRow(i, pending[i.id])); });
    doneList.hidden = !showDone || !done.length;
    card.appendChild(doneList);
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
        n.focus({ preventScroll: true });
        try { n.setSelectionRange(state.focus.start, state.focus.end); } catch (e) { /* not a text field */ }
      }
    }
  }

  var refreshing = false; // a redraw is replacing the fields, so their blur is not a save
  var renderWanted = false;

  function render() {
    if (!data) return;
    // Mid-drag the rows stay put; the redraw happens when the drop settles.
    if (dragging) { renderWanted = true; return; }
    if (editingId != null && !findItem(editingId)) editingId = null;
    if (renamingCat != null && !findCat(renamingCat)) renamingCat = null;

    refreshing = true;
    var fields = captureFields();
    detachNative();
    el.categories.textContent = '';
    var pending = hintShown || conn === 'offline' ? pendingIds() : {};
    var shown = 0;
    displayCategories().forEach(function (cat) {
      var section = categorySection(cat, pending);
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
    renderActivity();
    syncHistory();
    el.loading.hidden = true;
    el.error.hidden = true;
    wireNative();
  }

  function renderActivity() {
    var a = data.activity;
    el.activity.hidden = !(a && a.actor);
    if (!a || !a.actor) return;
    var verb = a.verb === 'added' || a.verb === 'removed' ? a.verb : 'checked';
    var text = a.text.length > 44 ? a.text.slice(0, 43) + '…' : a.text;
    el.activity.textContent = '@' + a.actor + ' ' + verb + ' “' + text + '”';
  }

  // ── The native UI kit: swipes, reorder, the nav bar ─────────────────────
  //
  // Each redraw replaces the rows, so the kit is attached to the new ones
  // after it: swipe actions on every row and category name, and reorder on
  // the whole list (items across categories, and the categories), while
  // online, not searching and (for items) not sorted by date.

  var reorderItems = null;
  var reorderCats = null;
  var dragging = false;

  function detachNative() {
    if (reorderItems) { reorderItems.detach(); reorderItems = null; }
    if (reorderCats) { reorderCats.detach(); reorderCats = null; }
  }

  function wireNative() {
    var k = kit();
    if (!k || !data) return;
    detachNative();
    Array.prototype.forEach.call(el.categories.querySelectorAll('.item-row:not([data-wired])'), function (row) {
      row.setAttribute('data-wired', '');
      var checked = row.getAttribute('data-checked') === '1';
      k.attachSwipeActions(row, {
        actions: [
          { label: checked ? 'Undo' : 'Complete', color: 'var(--un-accent)', handler: function () { toggleItem(rowId(row), !checked); } },
          { label: 'Rename', handler: function () { startEdit(rowId(row)); } },
          // A full swipe deletes: the kit takes the row away, then this
          // records it (and Undo brings it back).
          { label: 'Delete', destructive: true, handler: function () { deleteItem(rowId(row)); } },
        ],
      });
    });
    Array.prototype.forEach.call(el.categories.querySelectorAll('.cat-head:not([data-wired])'), function (head) {
      head.setAttribute('data-wired', '');
      var cat = findCat(Number(head.getAttribute('data-cat-head')));
      if (!cat) return;
      k.attachSwipeActions(head, {
        actions: [
          { label: 'Rename', handler: function () { startRename(cat.id); } },
          // Red, but never a full-swipe delete: a whole category asks first.
          { label: 'Delete', color: 'var(--un-action-danger)', handler: function () { deleteCategory(cat); } },
        ],
      });
    });
    if (searchActive() || !isOnline()) return;
    if (!datesOn()) {
      reorderItems = k.attachReorder(el.categories, {
        itemSelector: '.un-swipe:has(.item-row), .item-row.un-swipe, .empty-note',
        handle: '.item-drag',
        onLift: function () { dragging = true; },
        onReorder: function (from, to, itemEl) { onItemReorder(itemEl); },
        onSettle: settleDrag,
      });
    }
    reorderCats = k.attachReorder(el.categories, {
      itemSelector: '.cat-section:not([data-default])',
      handle: '.cat-drag',
      onLift: function () { dragging = true; },
      onReorder: function () { onCategoryReorder(); },
      onSettle: settleDrag,
    });
  }

  function settleDrag() {
    dragging = false;
    if (renderWanted) { renderWanted = false; render(); }
  }

  function onItemReorder(dropped) {
    renderWanted = true;
    if (!data || dropped.classList.contains('empty-note')) return;
    var row = dropped.classList.contains('item-row') ? dropped : dropped.querySelector('.item-row');
    var section = dropped.closest('[data-category]');
    if (!row || !section) return;
    var item = findItem(rowId(row));
    if (!item) return;
    var toCat = Number(section.getAttribute('data-category'));
    var fromCat = item.category_id;
    var checked = !!item.checked;
    var landedInDone = !!dropped.closest('[data-section="done"]');
    // Within one category the open and ticked items are ordered apart, so a
    // drop across that line springs back. Into another category, the item
    // joins whichever part matches it.
    if (fromCat === toCat) {
      var others = Array.prototype.filter.call(section.querySelectorAll('.item-row'), function (r) { return r !== row; });
      if (others.length && landedInDone !== checked) return;
    }
    // A ticked item put into a category hiding its ticked items would vanish.
    if (fromCat !== toCat && checked && !catShowDone(toCat)) catDoneOverrides[toCat] = true;
    var ids = Array.prototype.filter.call(section.querySelectorAll('.item-row'), function (r) {
      return (r.getAttribute('data-checked') === '1') === checked;
    }).map(rowId);
    var before = sectionItems(toCat, checked).map(function (i) { return i.id; });
    if (fromCat === toCat && before.join() === ids.join()) return;
    if (ids.some(isTemp)) { toast('Still saving that item: try moving it again in a moment.'); return; }
    item.category_id = toCat;
    ids.forEach(function (id, index) {
      var it = findItem(id);
      if (it) it.sort_order = index + 1;
    });
    generation++;
    var move = fromCat !== toCat ? api('PATCH', '/api/items/' + item.id, { category_id: toCat }, WRITE_TIMEOUT_MS) : Promise.resolve();
    move.then(function () {
      return api('POST', '/api/categories/' + toCat + '/reorder-items', { itemIds: ids }, WRITE_TIMEOUT_MS);
    }).then(saveCopy, writeFailed);
  }

  function onCategoryReorder() {
    renderWanted = true;
    var ids = Array.prototype.map.call(el.categories.querySelectorAll('[data-category]:not([data-default])'), function (s) {
      return Number(s.getAttribute('data-category'));
    });
    var before = displayCategories().filter(function (c) { return !c.is_default; }).map(function (c) { return c.id; });
    if (before.join() === ids.join()) return;
    ids.forEach(function (id, index) {
      var c = findCat(id);
      if (c) c.sort_order = index + 1;
    });
    generation++;
    api('POST', '/api/categories/reorder', { categoryIds: ids }, WRITE_TIMEOUT_MS).then(saveCopy, writeFailed);
  }

  // ── The menu ─────────────────────────────────────────────────────────────
  //
  // Over the page, never pushing it down: the kit's menu, which is a sheet
  // from the bottom on a phone and a dropdown under the button on a
  // computer. Without the kit, a plain dropdown in the same place.

  function menuItems() {
    return [
      { label: 'Show all completed', handler: function () { setShowCompleted(true); } },
      { label: 'Hide all completed', handler: function () { setShowCompleted(false); } },
      { label: datesOn() ? 'Turn off due dates' : 'Turn on due dates', disabled: !isOnline(), handler: function () { setDueDates(!datesOn()); } },
      { label: 'Export markdown', handler: openExport },
      { label: 'Import markdown', disabled: !isOnline(), handler: openImport },
    ];
  }

  function openMenu() {
    if (!data) return;
    var k = kit();
    if (k) {
      el.menuButton.setAttribute('aria-expanded', 'true');
      k.menu({ anchorEl: el.menuButton, items: menuItems(), placement: 'bottom-end' })
        .then(function () { el.menuButton.setAttribute('aria-expanded', 'false'); });
      return;
    }
    setPlainMenu(el.menu.hidden);
  }

  function setPlainMenu(open) {
    el.menu.textContent = '';
    if (open) {
      menuItems().forEach(function (item) {
        var b = button('list-row w-full text-left hover:bg-raised disabled:opacity-40', item.label, function () {
          setPlainMenu(false);
          item.handler();
        });
        b.setAttribute('role', 'menuitem');
        b.disabled = !!item.disabled;
        el.menu.appendChild(b);
      });
    }
    el.menu.hidden = !open;
    el.menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  document.addEventListener('click', function (e) {
    if (!el.menu.hidden && !el.menu.contains(e.target) && !el.menuButton.contains(e.target)) setPlainMenu(false);
  });

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

  // Export and import are dialogs over the list.
  function sheetBox(title, note) {
    var box = h('div', 'flex flex-col gap-3');
    box.appendChild(h('p', 'text-heading', title));
    box.appendChild(h('p', 'text-small text-muted', note));
    return box;
  }

  function openExport() {
    if (!data || !kit()) return;
    var box = sheetBox('Export markdown', 'Copy this markdown, or select it and copy it yourself.');
    var text = h('textarea', 'field min-h-[12rem] resize-y font-mono text-small');
    text.readOnly = true;
    text.spellcheck = false;
    text.setAttribute('aria-label', 'The list as markdown');
    text.value = buildMarkdown();
    box.appendChild(text);
    var actions = h('div', 'flex flex-wrap justify-end gap-2');
    var modal = null;
    actions.appendChild(button('btn-secondary', 'Close', function () { modal.dismiss(); }));
    actions.appendChild(button('btn-primary', 'Copy', function () {
      function fallback() {
        text.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        toast(ok ? 'Copied to clipboard' : 'Select the text and copy it');
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text.value).then(function () { toast('Copied to clipboard'); }, fallback);
      } else {
        fallback();
      }
    }));
    box.appendChild(actions);
    modal = kit().presentModal({ contentEl: box });
  }

  var importing = false;
  function openImport() {
    if (!data || !kit() || needsConnection()) return;
    var box = sheetBox('Import markdown',
      'Paste markdown to import into this list. Add merges into matching categories; Replace clears the list first. ~~Strikethrough~~ items import as completed.');
    var text = h('textarea', 'field min-h-[12rem] resize-y font-mono text-small');
    text.spellcheck = false;
    text.setAttribute('aria-label', 'Markdown to import');
    text.placeholder = '# **My List**\n\n* Category\n  * item\n  * ~~done item~~';
    box.appendChild(text);
    var actions = h('div', 'flex flex-wrap justify-end gap-2');
    var modal = null;
    function run(mode) {
      if (importing) return;
      var parsed = parseMarkdown(text.value);
      if (!parsed.categories.length || !parsed.categories.some(function (c) { return c.items.length; })) {
        toast('Nothing to import: expected bullets like "* Category" with "  * item" beneath');
        return;
      }
      importing = true;
      api('POST', '/api/import', { categories: parsed.categories, mode: mode }, 20000).then(function () {
        modal.dismiss();
        toast(mode === 'replace' ? 'List replaced' : 'Imported');
        return refresh(true);
      }, function (err) { toast(err.network ? 'You are offline: that needs a connection.' : err.message); })
        .then(function () { importing = false; });
    }
    actions.appendChild(button('btn-secondary', 'Cancel', function () { modal.dismiss(); }));
    actions.appendChild(button('btn-secondary text-danger', 'Replace', function () {
      askToConfirm('Replace everything on the list with this?', 'Replace').then(function (yes) { if (yes) run('replace'); });
    }));
    actions.appendChild(button('btn-primary', 'Add', function () { run('add'); }));
    box.appendChild(actions);
    modal = kit().presentModal({ contentEl: box });
    text.focus({ preventScroll: true });
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  var loading = null;
  // force: also when something is being edited or sent (after an import, a
  // refused change, or the queue draining).
  function refresh(force) {
    // A read already on its way may have left before the latest change:
    // read again once things are quiet (public/live-updates.js).
    if (loading) { if (live) live.changed(); return loading; }
    var asked = generation;
    loading = api('GET', '/api/list', null, LOAD_TIMEOUT_MS)
      .then(function (d) {
        // A change made while this was on its way would be undone by it:
        // read again once it has gone out.
        if (loaded && !force && asked !== generation) { if (live) live.changed(); return; }
        loaded = true;
        showingSaved = false;
        data = project(d);
        saveCopy();
        render();
      })
      .catch(function (err) {
        // A read that fails keeps what is on screen, the list saved on this
        // device included; only a first load with nothing to show turns into
        // the error state.
        if (data) { if (force && !err.network) toast(err.message); renderStrip(); return; }
        el.loading.hidden = true;
        el.error.hidden = false;
        el.errorText.textContent = err.network
          ? 'You are offline, and this list has not been saved on this device yet. It will be the next time it opens with a connection.'
          : 'Nothing on it is lost. Check your connection and try again.';
      })
      .then(function () { loading = null; });
    return loading;
  }

  function busy() {
    return dragging || queue().length > 0 || editingId != null || renamingCat != null;
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  el.undo.appendChild(icon('undo'));
  el.redo.appendChild(icon('redo'));
  el.menuButton.appendChild(icon('menu'));
  el.searchIcon.appendChild(icon('search', 'h-4 w-4'));
  el.searchClear.appendChild(icon('cross', 'h-4 w-4'));
  el.undo.addEventListener('click', undo);
  el.redo.addEventListener('click', redo);
  el.menuButton.addEventListener('click', function (e) { e.stopPropagation(); openMenu(); });

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
    if (!name || !data || needsConnection()) return;
    input.value = '';
    addCategory(name).catch(function (err) {
      if (!input.value) input.value = name;
      toast(err.network ? 'You are offline: that needs a connection.' : err.message);
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

  // The nav bar: its hairline once the list scrolls, and the large title
  // folding into it.
  if (kit()) kit().attachNavBar(el.bar, { largeTitleEl: el.largeTitle });
  // Pull the list down to fetch it again: the kit's pull to refresh, which
  // is also what makes the page bounce in place instead of dragging
  // Homeroom around it.
  if (kit()) {
    kit().attachPullToRefresh(window, function () { drain(true); return refresh(true); },
      { content: document.getElementById('page'), topEl: el.bar });
  }

  // Other people shop too: whenever anybody changes something, the list is
  // fetched again at once, and looked at every minute regardless
  // (public/live-updates.js). Not mid-drag, mid-edit or while changes are
  // still going out: what changed then is fetched the moment that is over.
  var live = window.LiveUpdates
    ? window.LiveUpdates.watch({ refresh: function () { return refresh(); }, quiet: function () { return !busy(); } })
    : null;

  // The list saved on this device shows at once, before the network
  // answers, and is all there is offline.
  var saved = storedJSON(KEY_SAVED);
  if (saved && saved.list && Array.isArray(saved.items)) {
    data = saved;
    showingSaved = true;
    render();
  }
  renderStrip();
  if (queue().length) drain();

  // The page and its files, kept by the service worker so the list opens
  // with no connection. Refused in some embedded browsers; the list then
  // works as before, online.
  if ('serviceWorker' in navigator) {
    try { navigator.serviceWorker.register('/sw.js').catch(function () {}); } catch (e) { /* not here */ }
  }

  // The first screen, drawn: Homeroom keeps its opening cover up until then
  // (usernode.ready, the platform bridge), so the app appears in one step
  // rather than as loading shapes that then change. The cover lifts after a
  // few seconds regardless.
  var first = refresh();
  if (window.usernode && window.usernode.ready) window.usernode.ready(first);
})();
