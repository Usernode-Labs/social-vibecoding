// The tier list screen. Talks to api.js; every request carries the platform
// token the frame was opened with, which is how the server knows who you are.
//
// One board, two rankings. "The group's" puts every item in the tier its
// average lands in. "Yours" is the same board with your own tiers on it:
// drag an item into a tier (on a touch screen it lifts as soon as the
// finger moves; the page scrolls from anywhere but an item). Below F, and not a tier, is Want to (go, hike, play:
// index.html's data-verb): drag one there that you have not got to yet. It
// counts toward no tier, and the group's board lists there every one
// somebody wants to, with how many people. Dragging it back to "Not ranked
// yet" takes it off your board. Tapping an item, on either board, opens its
// sheet: the group's tier, who put it in which tier and who wants to,
// taking it off your board, and, for whoever added it, removing it for
// everyone.
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
    want: document.getElementById('want'),
    wantItems: document.getElementById('want-items'),
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
    detailWants: document.getElementById('detail-wants'),
    detailWanters: document.getElementById('detail-wanters'),
    detailYours: document.getElementById('detail-yours'),
    detailOff: document.getElementById('detail-off'),
    detailRemove: document.getElementById('detail-remove'),
  };

  // Whole class names per tier, so the build and the <style> block see them.
  var TIER_CLASS = { S: 'tier-s', A: 'tier-a', B: 'tier-b', C: 'tier-c', D: 'tier-d', F: 'tier-f' };
  var TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];
  // Each item is a 44 px target. One you can move holds the finger
  // (touch-none): pressing it and moving drags it at once, with no hold to
  // time (Evan, 21 Oct 2026: "you need to hold on it just right").
  var CHIP = 'inline-flex min-h-11 max-w-full items-center rounded-lg bg-raised px-3 py-2 text-left text-small font-medium hover:bg-line';
  var CHIP_MOVABLE = 'inline-flex min-h-11 max-w-full cursor-grab touch-none select-none items-center rounded-lg border border-line bg-surface px-3 py-2 text-left text-small font-medium shadow-sm';
  var NAME_CHIP = 'inline-flex max-w-full items-center rounded-lg bg-raised px-2.5 py-1.5 text-small font-medium';
  // Want to (W, a place but not a tier): what to, as this tier list says it.
  var WANT_VERB = el.want.getAttribute('data-verb') || 'try';
  var WANT_LABEL = 'Want to ' + WANT_VERB;
  var SVG = 'http://www.w3.org/2000/svg';

  var data = null;
  // Which ranking is on the board; remembered on this device. Yours first,
  // so somebody new can drag straight away; once they switch, that sticks.
  var view = 'yours';
  try { if (localStorage.getItem('tier-list:view') === 'group') view = 'group'; } catch (e) { /* yours */ }
  // A drag under way: { id, chip, ghost, x, y, pointerId, touch, active, lastX, lastY, frame }.
  var drag = null;
  // How far a press moves before it is a drag rather than a tap, and the band
  // at the top and bottom of the screen that scrolls the page under a drag.
  var SLOP_PX = 6;
  var EDGE_PX = 72;
  var justDragged = false;
  // The sheet that is open, if any: { id, opener, data, failed }.
  var detail = null;
  // A sheet on its way down: the timer that hides it once it is gone.
  var leaving = null;
  // How long a sheet waits for who ranked it what before it comes up without
  // it, and how long its way down takes (index.html's .leaving).
  var OPEN_WAIT_MS = 250;
  var LEAVE_MS = 240;
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
    drag = { id: Number(chip.getAttribute('data-item')), chip: chip, x: e.clientX, y: e.clientY, pointerId: e.pointerId, touch: e.pointerType !== 'mouse', active: false, frame: 0 };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', endDrag);
  }

  // The press has moved: it is a drag. On a touch screen it joins the native
  // UI kit's gesture arbiter first, so pulling to refresh never starts under it.
  function begin() {
    if (!drag || drag.active) return false;
    var gestures = window.unNative && window.unNative.gestures;
    if (drag.touch && gestures && !gestures.claim('touch', 'tier-drag')) { endDrag(); return false; }
    drag.active = true;
    var rect = drag.chip.getBoundingClientRect();
    var ghost = drag.chip.cloneNode(true);
    ghost.className = 'pointer-events-none fixed z-50 inline-flex min-h-11 items-center rounded-lg border border-accent bg-surface px-3 py-2 text-small font-medium shadow-lg';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    ghost.style.width = rect.width + 'px';
    drag.offsetX = drag.x - rect.left;
    drag.offsetY = drag.y - rect.top;
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.chip.classList.add('opacity-40');
    return true;
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < SLOP_PX) return;
      if (!begin()) return;
    }
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    drag.ghost.style.left = (e.clientX - drag.offsetX) + 'px';
    drag.ghost.style.top = (e.clientY - drag.offsetY) + 'px';
    highlight(dropTargetAt(e.clientX, e.clientY));
    if (!drag.frame) drag.frame = requestAnimationFrame(edgeScroll);
  }

  // Held near the top or bottom of the screen, a drag scrolls the page, faster
  // the closer it is, so a tier off screen can still be reached: the page does
  // not scroll under the finger by itself while it holds an item.
  function edgeScroll() {
    if (!drag || !drag.active) return;
    drag.frame = 0;
    var y = drag.lastY;
    var step = y < EDGE_PX ? -(EDGE_PX - y) / 4 : y > window.innerHeight - EDGE_PX ? (y - (window.innerHeight - EDGE_PX)) / 4 : 0;
    if (!step) return;
    var before = window.scrollY;
    window.scrollBy(0, Math.round(step));
    if (window.scrollY === before) return;
    highlight(dropTargetAt(drag.lastX, drag.lastY));
    drag.frame = requestAnimationFrame(edgeScroll);
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
    if (drag.frame) cancelAnimationFrame(drag.frame);
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

  function wantCount(n) {
    return n === 1 ? '1 person wants to ' + WANT_VERB : n + ' people want to ' + WANT_VERB;
  }

  // How many want to, on the group's Want to row: a person and the number.
  function wantBadge(n) {
    var badge = h('span', 'ml-1.5 inline-flex shrink-0 items-center gap-0.5 text-muted');
    badge.setAttribute('aria-hidden', 'true');
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'h-3.5 w-3.5');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    [['circle', { cx: '12', cy: '8', r: '4' }], ['path', { d: 'M4 21c0-4 3.6-6 8-6s8 2 8 6' }]].forEach(function (part) {
      var shape = document.createElementNS(SVG, part[0]);
      Object.keys(part[1]).forEach(function (k) { shape.setAttribute(k, part[1][k]); });
      svg.appendChild(shape);
    });
    badge.appendChild(svg);
    badge.appendChild(document.createTextNode(String(n)));
    return badge;
  }

  function chipFor(item, withWants) {
    var chip;
    if (view === 'group') {
      chip = h('button', CHIP, item.name);
      chip.setAttribute('aria-label', item.name + (item.tier ? ', in the group\'s ' + item.tier + ' tier' : ', not ranked yet')
        + '. ' + count(item.votes, 'person', 'people') + ' ranked it' + (item.wants ? ', ' + wantCount(item.wants) : '')
        + '. Show who ranked it what.');
      if (withWants) chip.appendChild(wantBadge(item.wants));
    } else {
      chip = h('button', CHIP_MOVABLE, item.name);
      chip.setAttribute('aria-label', item.name + (item.yours === 'W' ? ', in your ' + WANT_LABEL
        : item.yours ? ', in your ' + item.yours + ' tier' : ', not ranked yet') + '. Show who ranked it what.');
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

    // Want to: yours, where you put them; the group's, every one somebody
    // wants to, most people first.
    var wanted = view === 'yours'
      ? data.items.filter(function (i) { return i.yours === 'W'; })
      : data.items.filter(function (i) { return i.wants; }).sort(function (a, b) { return b.wants - a.wants; });
    el.wantItems.textContent = '';
    wanted.forEach(function (item) { el.wantItems.appendChild(chipFor(item, true)); });

    // The group's tray leaves out the ones on its Want to row.
    var waiting = data.items.filter(function (i) { return !placeOf(i) && (view === 'yours' || !i.wants); });
    el.trayItems.textContent = '';
    waiting.forEach(function (item) { el.trayItems.appendChild(chipFor(item)); });
    if (view === 'yours') {
      var ranked = data.items.filter(function (i) { return i.yours && i.yours !== 'W'; }).length;
      el.note.textContent = ranked === data.items.length ? 'All ranked' : ranked + ' of ' + data.items.length + ' ranked';
      el.trayLabel.textContent = waiting.length ? 'Not ranked yet' : 'Not ranked yet: drag one here to take it off your board';
      el.tray.hidden = false;
      el.tray.setAttribute('data-drop', '');
      el.want.setAttribute('data-drop', 'W');
      el.hint.textContent = 'Drag each one into a tier, or into ' + WANT_LABEL + ' if you haven\'t yet. Tap one to see who ranked it what.';
    } else {
      el.note.textContent = data.rankers ? 'From ' + count(data.rankers, 'person\'s', 'people\'s') + ' rankings' : 'Nobody has ranked yet';
      el.trayLabel.textContent = 'Nobody has ranked these yet';
      el.tray.hidden = !waiting.length;
      el.tray.removeAttribute('data-drop');
      el.want.removeAttribute('data-drop');
      el.hint.textContent = 'Tap one to see who ranked it what.';
    }
    el.hint.hidden = false;
  }

  // ── One item's sheet: who ranked it what ───────────────────────────────

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // A sheet still on its way down goes at once: another is coming up.
  function finishLeaving() {
    if (!leaving) return;
    clearTimeout(leaving);
    leaving = null;
    el.detail.classList.remove('leaving');
    el.detail.hidden = true;
  }

  function openDetail(id, opener) {
    finishLeaving();
    var opened = { id: id, opener: opener, data: null, failed: false };
    detail = opened;
    renderDetail();
    // It comes up once who ranked it what is in, so it rises at its full
    // height rather than growing under the finger as the rows arrive; a slow
    // read gets OPEN_WAIT_MS, then the sheet comes up with its loading rows.
    var shown = false;
    function present() {
      if (shown || detail !== opened) return;
      shown = true;
      el.detail.hidden = false;
      // The board behind it can be neither reached nor scrolled.
      el.main.inert = true;
      document.body.classList.add('overflow-hidden');
      // Without scrolling: a phone scrolls the page to a focused button,
      // which jolted the sheet as it rose.
      el.detailClose.focus({ preventScroll: true });
    }
    loadDetail().then(present, present);
    setTimeout(present, OPEN_WAIT_MS);
  }

  function closeDetail() {
    if (!detail) return;
    var id = detail.id;
    var opener = detail.opener;
    detail = null;
    removing.disarm();
    el.main.inert = false;
    document.body.classList.remove('overflow-hidden');
    // Back to the item it opened from, or the same item redrawn since.
    var back = opener && opener.isConnected ? opener : el.ranking.querySelector('[data-item="' + id + '"]');
    if (back) back.focus({ preventScroll: true });
    // Down the way it came, then hidden; at once if it never came up, or
    // under reduced motion.
    if (el.detail.hidden || reducedMotion()) { el.detail.hidden = true; return; }
    el.detail.classList.add('leaving');
    leaving = setTimeout(finishLeaving, LEAVE_MS);
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

  // Who wants to, below who ranked it, as on the board: you first.
  function renderWanters() {
    var wanters = (detail.data && detail.data.wanters) || [];
    el.detailWanters.textContent = '';
    el.detailWants.hidden = !wanters.length;
    if (!wanters.length) return;
    wanters = wanters.slice().sort(function (a, b) { return (b.you ? 1 : 0) - (a.you ? 1 : 0); });
    el.detailWanters.setAttribute('aria-label', WANT_LABEL + ': ' + wanters.map(raterName).join(', '));
    wanters.forEach(function (w) { el.detailWanters.appendChild(h('span', NAME_CHIP, raterName(w))); });
  }

  function renderRaters() {
    el.detailRaters.textContent = '';
    renderWanters();
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

  // Pulled down at the top, the board is fetched again and the page bounces
  // in place, as a phone's own lists do, instead of dragging Homeroom's
  // header along with it (the native UI kit, /usernode-native/v1/native.js;
  // nothing on a computer).
  if (window.unNative) window.unNative.attachPullToRefresh(window, refresh);
})();
