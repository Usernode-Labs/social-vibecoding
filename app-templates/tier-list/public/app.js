// The tier list screen. Talks to api.js; every request carries the platform
// token the frame was opened with, which is how the server knows who you are.
//
// One board, three rankings. "The group's" puts every item in the tier its
// average lands in. "Yours" is the same board with your own tiers on it:
// drag an item into a tier (on a touch screen it lifts as soon as the
// finger moves; the page scrolls from anywhere but an item). Below F, and not a tier, is Want to (go, hike, play:
// index.html's data-verb): drag one there that you have not got to yet. It
// counts toward no tier, and the group's board lists there every one
// somebody wants to, with how many people. Dragging it back to "Not ranked
// yet" takes it off your board. "Other people" is another member's whole
// board, chosen from a row of names; it is for looking, never moving.
// Tapping an item, on any board, opens its sheet: the group's tier, who put
// it in which tier and who wants to, its comments (write one, @ a member,
// delete your own or report someone else's), taking it off your board, and,
// for whoever added it, removing it for everyone. The question mark beside
// the switch opens a short sheet on what a tier list is and what each board
// does. Under the title, a quiet line names the other signed-in people who
// have the list open right now.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it, so an item called "<b>hi</b>" shows exactly that.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';

  var el = {
    main: document.querySelector('main'),
    presence: document.getElementById('presence'),
    form: document.getElementById('add-form'),
    status: document.getElementById('status'),
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    empty: document.getElementById('empty'),
    ranking: document.getElementById('ranking'),
    toggle: document.getElementById('view-toggle'),
    helpOpen: document.getElementById('help-open'),
    note: document.getElementById('board-note'),
    people: document.getElementById('people'),
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
    detailComments: document.getElementById('detail-comments'),
    commentForm: document.getElementById('comment-form'),
    commentBody: document.getElementById('comment-body'),
    commentPost: document.getElementById('comment-post'),
    commentStatus: document.getElementById('comment-status'),
    mentionList: document.getElementById('mention-list'),
    help: document.getElementById('help'),
    helpScrim: document.getElementById('help-scrim'),
    helpClose: document.getElementById('help-close'),
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
  // The Other people row: the chosen name filled with the accent, the rest outlined.
  var PERSON_ON = 'inline-flex min-h-11 items-center rounded-lg bg-accent px-3 text-small font-medium text-on-accent';
  var PERSON_OFF = 'inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-small font-medium';
  // The @ list's choices, the highlighted one and the rest.
  var MENTION_ON = 'flex min-h-11 w-full items-center bg-raised px-3 text-left text-small font-medium';
  var MENTION_OFF = 'flex min-h-11 w-full items-center px-3 text-left text-small font-medium';
  var COMMENT_ACTION = 'btn-secondary shrink-0 border-0 bg-transparent px-2 text-small text-muted';
  // Want to (W, a place but not a tier): what to, as this tier list says it.
  var WANT_VERB = el.want.getAttribute('data-verb') || 'try';
  var WANT_LABEL = 'Want to ' + WANT_VERB;
  var SVG = 'http://www.w3.org/2000/svg';

  var data = null;
  // Which ranking is on the board; remembered on this device. Yours first,
  // so somebody new can drag straight away; once they switch, that sticks.
  var view = 'yours';
  try { if (localStorage.getItem('tier-list:view') === 'group') view = 'group'; } catch (e) { /* yours */ }
  try { if (localStorage.getItem('tier-list:view') === 'person') view = 'person'; } catch (e) { /* yours */ }
  // The Other people row (everyone else with something on a board: your own
  // is Yours), whose board is showing, and where that person put each item.
  // Remembered on this device.
  var people = [];
  var personId = null;
  var person = null;
  var personPlaces = {};
  try { personId = Number(localStorage.getItem('tier-list:person')) || null; } catch (e) { personId = null; }
  // The project's members, for the comment field's @ list: read once, the
  // first time a sheet opens while signed in, and kept.
  var members = null;
  var membersAsked = false;
  // The @ list's current choices and which one is highlighted.
  var mentionChoices = [];
  var mentionAt = 0;
  var mentioning = false;
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
    return Promise.all([load(), detail ? loadDetail() : null, loadPresence()]);
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
    if (view === 'yours') return item.yours;
    if (view === 'person') return personPlaces[item.id] || null;
    return item.tier;
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
    if (view === 'yours') {
      chip = h('button', CHIP_MOVABLE, item.name);
      chip.setAttribute('aria-label', item.name + (item.yours === 'W' ? ', in your ' + WANT_LABEL
        : item.yours ? ', in your ' + item.yours + ' tier' : ', not ranked yet') + '. Show who ranked it what.');
      chip.style.webkitTouchCallout = 'none';
      chip.addEventListener('pointerdown', onPointerDown);
      chip.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    } else if (view === 'person') {
      // Looking only: the same chip as the group's board, no drag.
      var place = placeOf(item);
      var whose = person && person.name ? '@' + person.name + '\'s' : 'their';
      chip = h('button', CHIP, item.name);
      chip.setAttribute('aria-label', item.name + (place === 'W' ? ', in ' + whose + ' ' + WANT_LABEL
        : place ? ', in ' + whose + ' ' + place + ' tier' : ', not on their board yet')
        + '. Show who ranked it what.');
    } else {
      chip = h('button', CHIP, item.name);
      chip.setAttribute('aria-label', item.name + (item.tier ? ', in the group\'s ' + item.tier + ' tier' : ', not ranked yet')
        + '. ' + count(item.votes, 'person', 'people') + ' ranked it' + (item.wants ? ', ' + wantCount(item.wants) : '')
        + '. Show who ranked it what.');
      if (withWants) chip.appendChild(wantBadge(item.wants));
    }
    chip.type = 'button';
    chip.setAttribute('data-item', String(item.id));
    chip.addEventListener('click', function () {
      if (!justDragged) openDetail(item.id, chip);
    });
    return chip;
  }

  function sorted(items) {
    if (view !== 'group') return items;
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

  // The Other people row: a name for each other person with something on a
  // board, filled when it is whose board is showing.
  function renderPeople() {
    el.people.textContent = '';
    if (view !== 'person') { el.people.hidden = true; return; }
    el.people.hidden = false;
    if (!people.length) {
      el.people.appendChild(h('p', 'px-1 text-small text-muted', 'Nobody else has ranked anything yet.'));
      return;
    }
    people.forEach(function (p) {
      var b = h('button', p.id === personId ? PERSON_ON : PERSON_OFF,
        p.name ? '@' + p.name : 'Someone');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', p.id === personId ? 'true' : 'false');
      b.setAttribute('data-person', String(p.id));
      el.people.appendChild(b);
    });
  }

  function renderBoard() {
    el.board.setAttribute('data-view', view);
    el.board.textContent = '';
    TIERS.forEach(function (tier) { el.board.appendChild(row(tier)); });

    Array.prototype.forEach.call(el.toggle.querySelectorAll('[data-view]'), function (b) {
      var on = b.getAttribute('data-view') === view;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.className = on
        ? 'min-h-11 rounded-lg bg-accent px-3 text-body font-medium text-on-accent'
        : 'min-h-11 rounded-lg px-3 text-body font-medium text-muted hover:bg-raised';
    });
    renderPeople();

    // Want to: yours, where you put them; the group's, every one somebody
    // wants to, most people first; a person's, the ones on their board.
    var wanted;
    if (view === 'person') wanted = data.items.filter(function (i) { return placeOf(i) === 'W'; });
    else if (view === 'yours') wanted = data.items.filter(function (i) { return i.yours === 'W'; });
    else wanted = data.items.filter(function (i) { return i.wants; }).sort(function (a, b) { return b.wants - a.wants; });
    el.wantItems.textContent = '';
    wanted.forEach(function (item) { el.wantItems.appendChild(chipFor(item, view === 'group')); });

    // The group's tray leaves out the ones on its Want to row. A person's
    // tray is what they have not ranked; with nobody chosen there is no tray.
    var waiting = view === 'person'
      ? (personId ? data.items.filter(function (i) { return !placeOf(i); }) : [])
      : data.items.filter(function (i) { return !placeOf(i) && (view === 'yours' || !i.wants); });
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
    } else if (view === 'person') {
      var total = data.items.length;
      if (person) {
        el.note.textContent = (person.name ? '@' + person.name + ' ranked ' : 'They ranked ')
          + person.ranked + ' of ' + total;
      } else {
        el.note.textContent = '';
      }
      el.trayLabel.textContent = 'Not on their board yet';
      el.tray.hidden = !waiting.length;
      el.tray.removeAttribute('data-drop');
      el.want.removeAttribute('data-drop');
      el.hint.textContent = 'Tap one to see who ranked it what.';
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
    var opened = { id: id, opener: opener, data: null, failed: false, comments: null, commentsFailed: false };
    detail = opened;
    hideMentions();
    showCommentStatus(null);
    // The @ list's names come from the project's member list, read once.
    loadMembers();
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
    hideMentions();
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
    var itemRead = api('GET', '/api/items/' + asked)
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
      });
    // The comments are their own read, with their own loading and failure
    // lines, so a slow one never holds back who ranked it what.
    var commentRead = api('GET', '/api/items/' + asked + '/comments')
      .then(function (d) {
        if (!detail || detail.id !== asked) return;
        detail.comments = d.comments || [];
        detail.commentsFailed = false;
        renderComments();
      }, function (err) {
        if (!detail || detail.id !== asked) return;
        // A 404 closes the sheet through the other read: nothing to say.
        if (err.status === 404) return;
        detail.commentsFailed = true;
        renderComments();
      });
    detailLoading = Promise.all([itemRead, commentRead]).then(function () {
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

  // ── Comments ───────────────────────────────────────────────────────────

  function showCommentStatus(err) {
    el.commentStatus.textContent = err ? err.message : '';
    el.commentStatus.hidden = !err;
  }

  // A delete or a report: the sheet says what happened, then reads again.
  function commentAct(promise) {
    return promise
      .then(function () { showCommentStatus(null); return refresh(); })
      .catch(function (err) { showCommentStatus(err); return refresh(); });
  }

  function commentTime(at) {
    var date = new Date(at);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  // The comment's words, line breaks kept, with each @handle naming a
  // project member drawn in the accent. Everything is a text node: a
  // comment that says "<b>hi</b>" shows exactly that.
  function commentBody(c) {
    var p = h('p', 'text-body');
    p.style.whiteSpace = 'pre-wrap';
    var body = c.body || '';
    var mentions = c.mentions || [];
    var at = /@([A-Za-z0-9_.-]+)/g;
    var last = 0;
    var m;
    while ((m = at.exec(body))) {
      if (m.index > last) p.appendChild(document.createTextNode(body.slice(last, m.index)));
      var handle = m[1];
      var known = mentions.some(function (x) { return String(x).toLowerCase() === handle.toLowerCase(); });
      p.appendChild(known ? h('span', 'font-medium text-accent', '@' + handle) : document.createTextNode(m[0]));
      last = m.index + m[0].length;
    }
    if (last < body.length) p.appendChild(document.createTextNode(body.slice(last)));
    return p;
  }

  function renderComments() {
    el.detailComments.textContent = '';
    if (!detail) return;
    if (detail.commentsFailed) {
      var failed = h('div', 'card flex flex-col items-start gap-2');
      failed.appendChild(h('p', 'text-body text-muted', 'The comments did not load. Check your connection and try again.'));
      var retry = h('button', 'btn-secondary', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', function () { detail.commentsFailed = false; renderComments(); loadDetail(); });
      failed.appendChild(retry);
      el.detailComments.appendChild(failed);
      return;
    }
    if (!detail.comments) {
      // Loading: the list's own shape, with bars for the words.
      var shapes = h('div', 'list');
      shapes.setAttribute('aria-label', 'Loading comments');
      for (var i = 0; i < 2; i += 1) {
        var shape = h('div', 'flex flex-col gap-2 px-3 py-3');
        shape.appendChild(h('div', 'skeleton h-4 w-24'));
        shape.appendChild(h('div', 'skeleton h-4 w-3/4'));
        shapes.appendChild(shape);
      }
      el.detailComments.appendChild(shapes);
      return;
    }
    if (!detail.comments.length) {
      el.detailComments.appendChild(h('p', 'px-1 text-body text-muted', 'No comments yet.'));
      return;
    }
    var list = h('div', 'list');
    list.setAttribute('aria-label', 'Comments');
    detail.comments.forEach(function (c) {
      var row = h('div', 'flex flex-col gap-1 px-3 py-3');
      var top = h('div', 'flex items-center gap-2');
      var who = h('div', 'flex min-w-0 items-center gap-2');
      who.appendChild(h('span', 'min-w-0 truncate text-small font-medium', c.you ? 'You' : '@' + c.name));
      who.appendChild(h('span', 'shrink-0 whitespace-nowrap text-small text-muted', commentTime(c.at)));
      top.appendChild(who);
      top.appendChild(h('span', 'flex-1'));
      var action = h('button', COMMENT_ACTION, c.you ? 'Delete' : 'Report');
      action.type = 'button';
      if (c.you) {
        tapTwice(action, 'Tap again to delete', function () {
          commentAct(api('DELETE', '/api/comments/' + c.id));
        });
      } else {
        tapTwice(action, 'Tap again to report', function () {
          commentAct(api('POST', '/api/comments/' + c.id + '/report'));
        });
      }
      top.appendChild(action);
      row.appendChild(top);
      row.appendChild(commentBody(c));
      list.appendChild(row);
    });
    el.detailComments.appendChild(list);
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
    el.commentForm.hidden = !signedIn;
    renderComments();
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
    if (e.key !== 'Escape') return;
    // The @ list goes first; the next press puts the sheet away.
    if (mentioning) { hideMentions(); return; }
    if (helpShown) { closeHelp(); return; }
    if (detail) closeDetail();
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

  // ── Comments: writing one, and the @ list ──────────────────────────────

  /** The project's members, once, the first time a sheet opens signed in. */
  function loadMembers() {
    if (membersAsked || !data || !data.me) return;
    membersAsked = true;
    api('GET', '/api/members').then(function (d) {
      members = (d.members || []).filter(function (m) { return m && m.username; });
    }, function () { members = null; });
  }

  function hideMentions() {
    mentioning = false;
    mentionChoices = [];
    mentionAt = 0;
    el.mentionList.textContent = '';
    el.mentionList.hidden = true;
  }

  function paintMentions() {
    Array.prototype.forEach.call(el.mentionList.children, function (b, i) {
      b.className = i === mentionAt ? MENTION_ON : MENTION_OFF;
      b.setAttribute('aria-selected', i === mentionAt ? 'true' : 'false');
    });
  }

  function renderMentions(found) {
    el.mentionList.textContent = '';
    mentionChoices = found;
    mentionAt = 0;
    if (!found.length) { hideMentions(); return; }
    found.forEach(function (m, i) {
      var b = h('button', i === 0 ? MENTION_ON : MENTION_OFF, '@' + m.username);
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
      b.addEventListener('click', function (e) { e.preventDefault(); insertMention(m.username); });
      el.mentionList.appendChild(b);
    });
    mentioning = true;
    el.mentionList.hidden = false;
  }

  // The words before the caret end in "@something": that narrows the @ list.
  function updateMentions() {
    if (!members || !members.length || el.commentForm.hidden) { hideMentions(); return; }
    var caret = el.commentBody.selectionStart == null ? el.commentBody.value.length : el.commentBody.selectionStart;
    var m = el.commentBody.value.slice(0, caret).match(/(^|\s)@([A-Za-z0-9_.-]*)$/);
    if (!m) { hideMentions(); return; }
    var q = m[2].toLowerCase();
    var found = members.filter(function (p) { return p.username.toLowerCase().indexOf(q) === 0; }).slice(0, 5);
    renderMentions(found);
  }

  function insertMention(name) {
    var value = el.commentBody.value;
    var caret = el.commentBody.selectionStart == null ? value.length : el.commentBody.selectionStart;
    var before = value.slice(0, caret);
    var m = before.match(/(^|\s)@([A-Za-z0-9_.-]*)$/);
    var start = m ? before.length - m[2].length - 1 : caret;
    el.commentBody.value = value.slice(0, start) + '@' + name + ' ' + value.slice(caret);
    var pos = start + name.length + 2;
    hideMentions();
    el.commentBody.focus();
    el.commentBody.setSelectionRange(pos, pos);
  }

  el.commentBody.addEventListener('input', updateMentions);
  el.commentBody.addEventListener('keydown', function (e) {
    if (!mentioning) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!mentionChoices.length) return;
      var step = e.key === 'ArrowDown' ? 1 : mentionChoices.length - 1;
      mentionAt = (mentionAt + step) % mentionChoices.length;
      paintMentions();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (mentionChoices[mentionAt]) insertMention(mentionChoices[mentionAt].username);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hideMentions();
    }
  });
  el.commentForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!detail) return;
    if (!el.commentBody.value.trim()) { showCommentStatus(new Error('Type a comment first.')); return; }
    var asked = detail.id;
    var body = el.commentBody.value;
    el.commentPost.disabled = true;
    api('POST', '/api/items/' + asked + '/comments', { body: body })
      .then(function () {
        el.commentBody.value = '';
        hideMentions();
        showCommentStatus(null);
        return refresh();
      }, function (err) {
        showCommentStatus(err);
        // What did not post stays in the field; only the comments read again.
        return loadDetail();
      })
      .then(function () { el.commentPost.disabled = false; });
  });

  // ── The help sheet ─────────────────────────────────────────────────────

  var helpShown = false;
  var helpLeaving = null;

  function finishHelpLeaving() {
    if (!helpLeaving) return;
    clearTimeout(helpLeaving);
    helpLeaving = null;
    el.help.classList.remove('leaving');
    el.help.hidden = true;
  }

  function openHelp() {
    finishHelpLeaving();
    helpShown = true;
    el.help.hidden = false;
    // The board behind it can be neither reached nor scrolled.
    el.main.inert = true;
    document.body.classList.add('overflow-hidden');
    el.helpClose.focus({ preventScroll: true });
  }

  function closeHelp() {
    if (!helpShown) return;
    helpShown = false;
    el.main.inert = false;
    document.body.classList.remove('overflow-hidden');
    el.helpOpen.focus({ preventScroll: true });
    if (el.help.hidden || reducedMotion()) { el.help.hidden = true; return; }
    el.help.classList.add('leaving');
    helpLeaving = setTimeout(finishHelpLeaving, LEAVE_MS);
  }

  el.helpOpen.addEventListener('click', openHelp);
  el.helpClose.addEventListener('click', closeHelp);
  el.helpScrim.addEventListener('click', closeHelp);

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
    // Nothing to switch between, drag or tray yet: just the tiers. The
    // question mark is in the header, so it stays.
    el.toggle.hidden = none;
    el.note.hidden = none;
    if (none) { el.hint.hidden = true; el.tray.hidden = true; el.people.hidden = true; }
    show(none ? 'empty' : 'ready');
    renderDetail();
  }

  // ── Who else is here ────────────────────────────────────────────────────

  // The other people with the list open, read from the app's memory of who
  // has checked in lately. A failed read keeps what the line last said, and
  // never shows an error: it is a quiet line, not part of what the board is.
  function loadPresence() {
    return api('GET', '/api/presence')
      .then(function (d) { drawPresence(d.here || [], d.more || 0); })
      .catch(function () { /* keep what the line says */ });
  }

  function drawPresence(names, more) {
    // Not while somebody is mid-drag: the line is drawn the moment it is
    // over, as the board is.
    if (drag) { if (live) live.changed(); return; }
    var total = names.length + more;
    if (!total) {
      el.presence.hidden = true;
      el.presence.textContent = '';
      return;
    }
    // "@ana" / "@ana and @ben" / "@ana, @ben and @cy", then "and N more".
    var at = names.slice(0, 3).map(function (name) { return '@' + name; });
    var rest = total - at.length;
    var text;
    if (rest > 0) text = at.join(', ') + ' and ' + rest + ' more';
    else if (at.length === 1) text = at[0];
    else text = at.slice(0, -1).join(', ') + ' and ' + at[at.length - 1];
    el.presence.textContent = 'Also here: ' + text;
    el.presence.hidden = false;
  }

  // Whose board Other people shows: remembered on this device, else the
  // first one listed.
  function rememberPerson() {
    try { localStorage.setItem('tier-list:person', personId == null ? '' : String(personId)); } catch (e) { /* not kept */ }
  }

  function choosePerson() {
    var listed = people.some(function (p) { return p.id === personId; });
    if (listed) return;
    personId = people[0] ? people[0].id : null;
    rememberPerson();
  }

  // Where one person put each item. A person who has removed everything has
  // no board any more (404): fall back to the first listed person.
  function loadPerson() {
    if (!personId) { person = null; personPlaces = {}; return Promise.resolve(); }
    var asked = personId;
    return api('GET', '/api/people/' + asked)
      .then(function (d) {
        if (personId !== asked) return;
        person = d.person;
        personPlaces = d.places || {};
      }, function (err) {
        if (personId !== asked) return;
        person = null;
        personPlaces = {};
        if (err.status !== 404) return;
        var next = people.filter(function (p) { return p.id !== asked; })[0];
        if (next) { personId = next.id; rememberPerson(); return loadPerson(); }
        personId = null;
        rememberPerson();
      });
  }

  var loaded = false;
  var loading = null;
  var again = false;
  function load() {
    // A read already on its way may have left before the change just made:
    // read once more when it is back.
    if (loading) { again = true; return loading; }
    var itemsRead = api('GET', '/api/items');
    // The Other people row is read beside the board; a failed read leaves it empty
    // rather than failing the screen.
    var peopleRead = api('GET', '/api/people').catch(function () { return { people: [] }; });
    loading = Promise.all([itemsRead, peopleRead])
      .then(function (out) {
        // Not while somebody is mid-drag: the board would move under them.
        // It is fetched again the moment the drag is over.
        if (drag) { if (live) live.changed(); return null; }
        loaded = true;
        data = out[0];
        // Everyone else: your own board is Yours.
        people = (out[1].people || []).filter(function (p) { return !p.you; });
        choosePerson();
        return view === 'person' ? loadPerson() : null;
      })
      .then(function () {
        if (drag) return;
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
    if (view === 'person') loadPerson().then(function () { if (view === 'person') render(); });
  });
  // Picking whose board to look at, on the Other people row.
  el.people.addEventListener('click', function (e) {
    var b = e.target.closest('[data-person]');
    if (!b) return;
    var id = Number(b.getAttribute('data-person'));
    if (!id || id === personId) return;
    personId = id;
    rememberPerson();
    person = null;
    personPlaces = {};
    render();
    loadPerson().then(function () { if (view === 'person') render(); });
  });
  el.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = el.form.elements.name;
    if (!input.value.trim()) return;
    act(api('POST', '/api/items', { name: input.value }).then(function () { el.form.reset(); }));
  });
  document.getElementById('retry').addEventListener('click', function () { show('loading'); load(); loadPresence(); });

  // Other people rank too: whenever anybody changes something, the board
  // (and the sheet, if one is open) is fetched again at once, and looked at
  // every minute regardless (public/live-updates.js). Not while someone is
  // dragging, typing a name or about to remove one: what changed then is
  // fetched the moment they are done, so a refresh never interrupts them.
  function quiet() {
    var active = document.activeElement;
    var typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.value;
    return !drag && !typing && !armed && !mentioning;
  }
  if (window.LiveUpdates) live = window.LiveUpdates.watch({ refresh: refresh, quiet: quiet });

  // The first screen, drawn: Homeroom keeps its opening cover up until then
  // (usernode.ready, the platform bridge), so the app appears in one step
  // rather than as loading shapes that then change. The cover lifts after a
  // few seconds regardless.
  var first = load();
  // Who is here is not what the board is: it is read beside it, so the
  // opening cover never waits on it.
  loadPresence();
  if (window.usernode && window.usernode.ready) window.usernode.ready(first);

  // Pulled down at the top, the board is fetched again and the page bounces
  // in place, as a phone's own lists do, instead of dragging Homeroom's
  // header along with it (the native UI kit, /usernode-native/v1/native.js;
  // nothing on a computer).
  if (window.unNative) window.unNative.attachPullToRefresh(window, refresh);
})();
