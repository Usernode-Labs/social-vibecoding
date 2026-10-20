// The tier list screen. Talks to api.js; every request carries the platform
// token the frame was opened with, which is how the server knows who you are.
//
// One board, two rankings. "The group's" puts every item in the tier its
// average lands in. "Yours" is the same board with your own tiers on it:
// drag an item into a tier (press and hold first on a touch screen, so a
// swipe still scrolls). Dragging it back to "Not ranked yet" takes it off
// your board. Tapping an item, on either board, opens its sheet: the
// group's tier, who put it in which tier, taking it off your board, and,
// for whoever added it, removing it for everyone.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it, so an item called "<b>hi</b>" shows exactly that.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';

  var el = {
    main: document.querySelector('main'),
    form: document.getElementById('add-form'),
    status: document.getElementById('status'),
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    empty: document.getElementById('empty'),
    ranking: document.getElementById('ranking'),
    toggle: document.getElementById('view-toggle'),
    note: document.getElementById('board-note'),
    hint: document.getElementById('hint'),
    board: document.getElementById('board'),
    tray: document.getElementById('tray'),
    trayLabel: document.getElementById('tray-label'),
    trayItems: document.getElementById('tray-items'),
    detail: document.getElementById('detail'),
    detailScrim: document.getElementById('detail-scrim'),
    detailName: document.getElementById('detail-name'),
    detailBy: document.getElementById('detail-by'),
    detailClose: document.getElementById('detail-close'),
    detailGroup: document.getElementById('detail-group'),
    detailRaters: document.getElementById('detail-raters'),
    detailYours: document.getElementById('detail-yours'),
    detailOff: document.getElementById('detail-off'),
    detailRemove: document.getElementById('detail-remove'),
  };

  // Whole class names per tier, so the build and the <style> block see them.
  var TIER_CLASS = { S: 'tier-s', A: 'tier-a', B: 'tier-b', C: 'tier-c', D: 'tier-d', F: 'tier-f' };
  var TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];
  var CHIP = 'inline-flex min-h-9 max-w-full items-center rounded-lg bg-raised px-2.5 py-1.5 text-left text-small font-medium hover:bg-line';
  var CHIP_MOVABLE = 'inline-flex min-h-9 max-w-full cursor-grab touch-manipulation select-none items-center rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left text-small font-medium shadow-sm';
  var NAME_CHIP = 'inline-flex max-w-full items-center rounded-lg bg-raised px-2.5 py-1.5 text-small font-medium';

  var data = null;
  // Which ranking is on the board; remembered on this device. Yours first,
  // so somebody new can drag straight away; once they switch, that sticks.
  var view = 'yours';
  try { if (localStorage.getItem('tier-list:view') === 'group') view = 'group'; } catch (e) { /* yours */ }
  // A drag under way: { id, chip, ghost, x, y, pointerId, touch, active, timer }.
  var drag = null;
  var justDragged = false;
  // The sheet that is open, if any: { id, opener, data, failed }.
  var detail = null;
  // Removals waiting for their second tap: a refresh would put the button back.
  var armed = 0;
  // Live updates (public/live-updates.js), wired up at the bottom.
  var live = null;

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
      armed -= 1;
      button.textContent = '';
      resting.forEach(function (n) { button.appendChild(n); });
      if (label) button.setAttribute('aria-label', label);
      else button.removeAttribute('aria-label');
      button.className = className;
    }
    button.addEventListener('click', function () {
      if (timer) {
        clearTimeout(timer);
        rest();
        action();
        return;
      }
      armed += 1;
      resting = Array.prototype.slice.call(button.childNodes);
      label = button.getAttribute('aria-label');
      className = button.className;
      button.textContent = armedLabel;
      button.setAttribute('aria-label', armedLabel);
      button.className = 'btn-secondary shrink-0 whitespace-nowrap border-0 bg-transparent px-2 text-small text-danger';
      timer = setTimeout(rest, 4000);
    });
    return { disarm: function () { if (timer) { clearTimeout(timer); rest(); } } };
  }

  function showStatus(err) {
    el.status.textContent = err ? err.message : '';
    el.status.hidden = !err;
  }

  // The board, and the open sheet if there is one, fetched again.
  function refresh() {
    return Promise.all([load(), detail ? loadDetail() : null]);
  }

  function act(promise) {
    return promise.then(function () { showStatus(null); return refresh(); }).catch(function (err) { showStatus(err); return refresh(); });
  }

  function count(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  function itemById(id) {
    return data.items.filter(function (i) { return i.id === id; })[0];
  }

  // Where an item sits on the board being shown.
  function placeOf(item) {
    return view === 'yours' ? item.yours : item.tier;
  }

  // ── Placing an item in your tiers ───────────────────────────────────────

  function place(id, tier) {
    var item = itemById(id);
    if (!item || item.yours === tier) return;
    item.yours = tier; // on the board straight away; the server agrees or the reload puts it back
    render();
    act(api('PUT', '/api/items/' + id + '/tier', { tier: tier }));
  }

  // ── Dragging ────────────────────────────────────────────────────────────

  function dropTargetAt(x, y) {
    var under = document.elementFromPoint(x, y);
    return under ? under.closest('[data-drop]') : null;
  }

  function highlight(target) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-drop]'), function (n) {
      n.classList.toggle('bg-raised', n === target);
    });
  }

  function onPointerDown(e) {
    if (view !== 'yours' || e.button > 0) return;
    var chip = e.currentTarget;
    drag = { id: Number(chip.getAttribute('data-item')), chip: chip, x: e.clientX, y: e.clientY, pointerId: e.pointerId, touch: e.pointerType !== 'mouse', active: false, timer: null };
    // On a touch screen a drag starts after a short hold, so a swipe still scrolls.
    if (drag.touch) drag.timer = setTimeout(begin, 220);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', endDrag);
  }

  function begin() {
    if (!drag || drag.active) return;
    drag.active = true;
    var rect = drag.chip.getBoundingClientRect();
    var ghost = drag.chip.cloneNode(true);
    ghost.className = 'pointer-events-none fixed z-50 inline-flex items-center rounded-lg border border-accent bg-surface px-2.5 py-1.5 text-small font-medium shadow-lg';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    ghost.style.width = rect.width + 'px';
    drag.offsetX = drag.x - rect.left;
    drag.offsetY = drag.y - rect.top;
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.chip.classList.add('opacity-40');
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 6) return;
      // Moving before the hold is a scroll on a touch screen; with a mouse it is a drag.
      if (drag.touch) { endDrag(); return; }
      begin();
    }
    drag.ghost.style.left = (e.clientX - drag.offsetX) + 'px';
    drag.ghost.style.top = (e.clientY - drag.offsetY) + 'px';
    highlight(dropTargetAt(e.clientX, e.clientY));
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var wasActive = drag.active;
    var id = drag.id;
    var target = wasActive ? dropTargetAt(e.clientX, e.clientY) : null;
    endDrag();
    if (!wasActive) return; // a tap: the click handler opens its sheet
    justDragged = true;
    setTimeout(function () { justDragged = false; }, 0);
    if (target) place(id, target.getAttribute('data-drop') || null);
  }

  function endDrag() {
    if (!drag) return;
    clearTimeout(drag.timer);
    if (drag.ghost) drag.ghost.remove();
    drag.chip.classList.remove('opacity-40');
    highlight(null);
    drag = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', endDrag);
  }

  // Once a drag is under way on a touch screen, the page must not scroll under it.
  document.addEventListener('touchmove', function (e) { if (drag && drag.active) e.preventDefault(); }, { passive: false });

  // ── The board ───────────────────────────────────────────────────────────

  function chipFor(item) {
    var chip;
    if (view === 'group') {
      chip = h('button', CHIP, item.name);
      chip.setAttribute('aria-label', item.name + (item.tier ? ', in the group\'s ' + item.tier + ' tier' : ', not ranked yet')
        + '. ' + count(item.votes, 'person', 'people') + ' ranked it. Show who ranked it what.');
    } else {
      chip = h('button', CHIP_MOVABLE, item.name);
      chip.setAttribute('aria-label', item.name + (item.yours ? ', in your ' + item.yours + ' tier' : ', not ranked yet') + '. Show who ranked it what.');
      chip.style.webkitTouchCallout = 'none';
      chip.addEventListener('pointerdown', onPointerDown);
      chip.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    }
    chip.type = 'button';
    chip.setAttribute('data-item', String(item.id));
    chip.addEventListener('click', function () {
      if (!justDragged) openDetail(item.id, chip);
    });
    return chip;
  }

  function sorted(items) {
    if (view === 'yours') return items;
    return items.slice().sort(function (a, b) { return b.average - a.average || b.votes - a.votes; });
  }

  function row(tier) {
    var items = sorted(data.items.filter(function (i) { return placeOf(i) === tier; }));
    var r = h('div', 'flex min-h-14 items-stretch');
    r.setAttribute('data-tier', tier);
    if (view === 'yours') r.setAttribute('data-drop', tier);
    var label = h('div', 'flex w-14 shrink-0 items-center justify-center text-heading ' + TIER_CLASS[tier], tier);
    label.setAttribute('aria-label', 'Tier ' + tier);
    r.appendChild(label);
    var chips = h('div', 'flex min-w-0 flex-1 flex-wrap items-center gap-1.5 px-3 py-2');
    items.forEach(function (item) { chips.appendChild(chipFor(item)); });
    r.appendChild(chips);
    return r;
  }

  function renderBoard() {
    el.board.setAttribute('data-view', view);
    el.board.textContent = '';
    TIERS.forEach(function (tier) { el.board.appendChild(row(tier)); });

    Array.prototype.forEach.call(el.toggle.querySelectorAll('[data-view]'), function (b) {
      var on = b.getAttribute('data-view') === view;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.className = on
        ? 'min-h-11 rounded-lg bg-accent px-4 text-body font-medium text-on-accent'
        : 'min-h-11 rounded-lg px-4 text-body font-medium text-muted hover:bg-raised';
    });

    var waiting = data.items.filter(function (i) { return !placeOf(i); });
    el.trayItems.textContent = '';
    waiting.forEach(function (item) { el.trayItems.appendChild(chipFor(item)); });
    if (view === 'yours') {
      var ranked = data.items.length - waiting.length;
      el.note.textContent = ranked === data.items.length ? 'All ranked' : ranked + ' of ' + data.items.length + ' ranked';
      el.trayLabel.textContent = waiting.length ? 'Not ranked yet' : 'Not ranked yet: drag one here to take it off your board';
      el.tray.hidden = false;
      el.tray.setAttribute('data-drop', '');
      el.hint.textContent = 'Drag each one into a tier. Tap one to see who ranked it what.';
    } else {
      el.note.textContent = data.rankers ? 'From ' + count(data.rankers, 'person\'s', 'people\'s') + ' rankings' : 'Nobody has ranked yet';
      el.trayLabel.textContent = 'Nobody has ranked these yet';
      el.tray.hidden = !waiting.length;
      el.tray.removeAttribute('data-drop');
      el.hint.textContent = 'Tap one to see who ranked it what.';
    }
    el.hint.hidden = false;
  }

  // ── One item's sheet: who ranked it what ───────────────────────────────

  function openDetail(id, opener) {
    detail = { id: id, opener: opener, data: null, failed: false };
    renderDetail();
    el.detail.hidden = false;
    // The board behind it can be neither reached nor scrolled.
    el.main.inert = true;
    document.body.classList.add('overflow-hidden');
    el.detailClose.focus();
    loadDetail();
  }

  function closeDetail() {
    if (!detail) return;
    var id = detail.id;
    var opener = detail.opener;
    detail = null;
    removing.disarm();
    el.detail.hidden = true;
    el.main.inert = false;
    document.body.classList.remove('overflow-hidden');
    // Back to the item it opened from, or the same item redrawn since.
    var back = opener && opener.isConnected ? opener : el.ranking.querySelector('[data-item="' + id + '"]');
    if (back) back.focus();
  }

  var detailLoading = null;
  var detailAgain = false;
  function loadDetail() {
    // A read already on its way may have left before the change just made:
    // read once more when it is back.
    if (detailLoading) { detailAgain = true; return detailLoading; }
    var asked = detail && detail.id;
    if (!asked) return Promise.resolve();
    detailLoading = api('GET', '/api/items/' + asked)
      .then(function (d) {
        if (!detail || detail.id !== asked) return;
        detail.data = d;
        detail.failed = false;
        renderDetail();
      }, function (err) {
        if (!detail || detail.id !== asked) return;
        // Removed meanwhile: there is nothing left to show.
        if (err.status === 404) { closeDetail(); showStatus(err); return; }
        detail.failed = true;
        renderDetail();
      })
      .then(function () {
        detailLoading = null;
        if (detailAgain) { detailAgain = false; return loadDetail(); }
      });
    return detailLoading;
  }

  function tierBadge(tier, size) {
    var badge = h('span', (size === 'big'
      ? 'flex h-14 w-14 shrink-0 items-center justify-center rounded-xl text-title '
      : 'flex w-12 shrink-0 items-center justify-center text-heading ') + TIER_CLASS[tier], tier);
    badge.setAttribute('aria-hidden', 'true');
    return badge;
  }

  function raterName(r) {
    if (r.you) return 'You';
    return r.name ? '@' + r.name : 'Someone';
  }

  function renderRaters() {
    el.detailRaters.textContent = '';
    if (detail.failed && !detail.data) {
      var failed = h('div', 'card flex flex-col items-start gap-2');
      failed.appendChild(h('p', 'text-body text-muted', 'Who ranked it did not load. Check your connection and try again.'));
      var retry = h('button', 'btn-secondary', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', function () { detail.failed = false; renderDetail(); loadDetail(); });
      failed.appendChild(retry);
      el.detailRaters.appendChild(failed);
      return;
    }
    if (!detail.data) {
      // Loading: two rows of the list below, with bars for the names.
      var shapes = h('div', 'list');
      shapes.setAttribute('aria-label', 'Loading');
      for (var i = 0; i < 2; i += 1) {
        var r = h('div', 'flex min-h-12 items-stretch');
        r.appendChild(h('div', 'skeleton w-12 shrink-0 rounded-none'));
        var bars = h('div', 'flex min-w-0 flex-1 flex-wrap items-center gap-1.5 px-3 py-2');
        bars.appendChild(h('div', 'skeleton h-8 w-20'));
        bars.appendChild(h('div', 'skeleton h-8 w-16'));
        r.appendChild(bars);
        shapes.appendChild(r);
      }
      el.detailRaters.appendChild(shapes);
      return;
    }
    var raters = detail.data.raters;
    if (!raters.length) {
      el.detailRaters.appendChild(h('p', 'px-1 text-body text-muted', view === 'yours'
        ? 'Nobody has ranked it yet. Drag it into a tier to be the first.'
        : 'Nobody has ranked it yet.'));
      return;
    }
    // The board's own shape: a row for each tier somebody chose, you first in yours.
    var list = h('div', 'list');
    list.setAttribute('aria-label', 'Who ranked it what');
    TIERS.forEach(function (tier) {
      var here = raters.filter(function (r) { return r.tier === tier; });
      if (!here.length) return;
      here.sort(function (a, b) { return (b.you ? 1 : 0) - (a.you ? 1 : 0); });
      var r = h('div', 'flex min-h-12 items-stretch');
      r.setAttribute('data-rated', tier);
      r.appendChild(tierBadge(tier));
      var names = h('div', 'flex min-w-0 flex-1 flex-wrap items-center gap-1.5 px-3 py-2');
      names.setAttribute('aria-label', tier + ': ' + here.map(raterName).join(', '));
      here.forEach(function (rater) { names.appendChild(h('span', NAME_CHIP, raterName(rater))); });
      r.appendChild(names);
      list.appendChild(r);
    });
    el.detailRaters.appendChild(list);
  }

  function renderDetail() {
    if (!detail) return;
    // The board's copy first: it has your tier the moment you choose one.
    var item = itemById(detail.id) || (detail.data && detail.data.item);
    if (!item) { closeDetail(); return; }
    el.detailName.textContent = item.name;
    el.detailBy.textContent = item.mine ? 'Added by you' : 'Added by @' + item.by;

    el.detailGroup.textContent = '';
    if (item.tier) {
      el.detailGroup.appendChild(tierBadge(item.tier, 'big'));
      var words = h('div', 'flex min-w-0 flex-col');
      words.appendChild(h('p', 'text-body font-medium', 'In the group\'s ' + item.tier + ' tier'));
      words.appendChild(h('p', 'text-small text-muted', count(item.votes, 'person', 'people') + ' ranked it · average ' + item.average.toFixed(1) + ' of 5'));
      el.detailGroup.appendChild(words);
    } else {
      el.detailGroup.appendChild(h('p', 'text-body text-muted', 'Not on the group\'s board yet: nobody has ranked it.'));
    }

    renderRaters();

    // Signed in: your own tier, for a keyboard or a screen reader, and taking it off your board.
    var signedIn = !!(data && data.me);
    el.detailYours.hidden = !signedIn;
    Array.prototype.forEach.call(el.detailYours.querySelectorAll('[data-set-tier]'), function (b) {
      var tier = b.getAttribute('data-set-tier') || null;
      b.setAttribute('aria-pressed', item.yours === tier ? 'true' : 'false');
      b.className = item.yours === tier ? 'btn-primary' : 'btn-secondary';
    });
    el.detailOff.hidden = !signedIn || !item.yours;
    el.detailRemove.hidden = !item.mine;
  }

  el.detailClose.addEventListener('click', closeDetail);
  el.detailScrim.addEventListener('click', closeDetail);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && detail) closeDetail();
  });
  el.detailYours.addEventListener('click', function (e) {
    var b = e.target.closest('[data-set-tier]');
    if (b && detail) place(detail.id, b.getAttribute('data-set-tier') || null);
  });
  el.detailOff.addEventListener('click', function () {
    if (!detail) return;
    var id = detail.id;
    closeDetail();
    place(id, null);
  });
  // Everyone's tiers for it go with it.
  var removing = tapTwice(el.detailRemove, 'Tap again to remove', function () {
    if (!detail) return;
    var id = detail.id;
    closeDetail();
    act(api('DELETE', '/api/items/' + id));
  });

  // ── Loading, empty, error ──────────────────────────────────────────────

  function show(state) {
    el.loading.hidden = state !== 'loading';
    el.error.hidden = state !== 'error';
    el.empty.hidden = state !== 'empty';
    // With nothing added yet the empty tiers still show under the empty
    // state, so it is clear what the list will be.
    el.ranking.hidden = state !== 'ready' && state !== 'empty';
  }

  function render() {
    renderBoard();
    var none = !data.items.length;
    // Nothing to switch between, drag or tray yet: just the tiers.
    el.toggle.parentNode.hidden = none;
    if (none) { el.hint.hidden = true; el.tray.hidden = true; }
    show(none ? 'empty' : 'ready');
    renderDetail();
  }

  var loaded = false;
  var loading = null;
  var again = false;
  function load() {
    // A read already on its way may have left before the change just made:
    // read once more when it is back.
    if (loading) { again = true; return loading; }
    loading = api('GET', '/api/items')
      .then(function (d) {
        loaded = true;
        // Not while somebody is mid-drag: the board would move under them.
        // It is fetched again the moment the drag is over.
        if (drag) { if (live) live.changed(); return; }
        data = d;
        render();
      })
      .catch(function (err) {
        // A refresh that fails keeps what is on screen; only a first load
        // with nothing to show turns into the error state.
        if (loaded) showStatus(err);
        else show('error');
      })
      .then(function () {
        loading = null;
        if (again) { again = false; return load(); }
      });
    return loading;
  }

  el.toggle.addEventListener('click', function (e) {
    var b = e.target.closest('[data-view]');
    if (!b) return;
    view = b.getAttribute('data-view');
    try { localStorage.setItem('tier-list:view', view); } catch (err) { /* not kept */ }
    render();
  });
  el.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = el.form.elements.name;
    if (!input.value.trim()) return;
    act(api('POST', '/api/items', { name: input.value }).then(function () { el.form.reset(); }));
  });
  document.getElementById('retry').addEventListener('click', function () { show('loading'); load(); });

  // Other people rank too: whenever anybody changes something, the board
  // (and the sheet, if one is open) is fetched again at once, and looked at
  // every minute regardless (public/live-updates.js). Not while someone is
  // dragging, typing a name or about to remove one: what changed then is
  // fetched the moment they are done, so a refresh never interrupts them.
  function quiet() {
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.value;
    return !drag && !typing && !armed;
  }
  if (window.LiveUpdates) live = window.LiveUpdates.watch({ refresh: refresh, quiet: quiet });

  // The first screen, drawn: Homeroom keeps its opening cover up until then
  // (usernode.ready, the platform bridge), so the app appears in one step
  // rather than as loading shapes that then change. The cover lifts after a
  // few seconds regardless.
  var first = load();
  if (window.usernode && window.usernode.ready) window.usernode.ready(first);
})();
