// The sign-up sheet screen. Talks to api.js; every request carries the
// platform token the frame was opened with, which is how the server knows
// who you are.
//
// Each event is drawn by its own kind: a 'slots' event lists its slots,
// each with dots for its spots, who took them and a Sign up button; an
// 'rsvp' event asks "Are you coming?" and shows the headcount, who is going
// (with their notes), and who might come or can't. A new event is the
// kind this app was made for (data-mode on <main>).
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it, so an event called "<b>hi</b>" shows exactly that.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';
  var root = document.getElementById('app');
  var mode = root.getAttribute('data-mode') === 'rsvp' ? 'rsvp' : 'slots';
  var slotExample = root.getAttribute('data-example-slot') || '';

  var el = {
    status: document.getElementById('status'),
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    empty: document.getElementById('empty'),
    events: document.getElementById('events'),
    newButton: document.getElementById('new-event'),
    newForm: document.getElementById('new-form'),
    newStatus: document.getElementById('new-status'),
    pastSection: document.getElementById('past-section'),
    past: document.getElementById('past'),
  };

  // The words that differ by mode are in the page, in both versions.
  Array.prototype.forEach.call(document.querySelectorAll('[data-copy-' + mode + ']'), function (node) {
    node.textContent = node.getAttribute('data-copy-' + mode);
  });
  // Shifts usually start in the morning; get-togethers in the evening.
  el.newForm.elements.time.value = mode === 'slots' ? '09:00' : '19:00';

  var ANSWERS = [
    { key: 'going', label: 'Going' },
    { key: 'maybe', label: 'Maybe' },
    { key: 'cant', label: 'Can\'t' },
  ];
  // A long Going list shows this many, then "And N more".
  var GOING_SHOWN = 5;

  var current = null; // the last list read
  var adding = null; // the event whose add-a-slot form is open, by id
  var editing = null; // the event whose slots its maker is removing, by id
  var showAll = {}; // events whose whole Going list is open, by id
  var trouble = null; // { id, message }: what last went wrong on an event

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

  function button(className, text) {
    var b = h('button', className, text);
    b.type = 'button';
    return b;
  }

  /** A small line icon, drawn as an SVG: 'plus' or 'check'. */
  function icon(name, className) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', className);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    var shapes = name === 'check'
      ? [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M8 12.5l2.8 2.8L16.5 9.5' }]]
      : [['path', { d: 'M12 5v14' }], ['path', { d: 'M5 12h14' }]];
    shapes.forEach(function (s) {
      var node = document.createElementNS(ns, s[0]);
      Object.keys(s[1]).forEach(function (k) { node.setAttribute(k, s[1][k]); });
      svg.appendChild(node);
    });
    return svg;
  }

  /**
   * A tap that cannot be undone asks for a second one. window.confirm() is no
   * use here: Homeroom's app frame does not allow dialogs, so it returns false
   * without showing anything. The first tap says what the second will do, and
   * the button goes back to how it was after a few seconds.
   */
  function tapTwice(target, armedLabel, action) {
    var timer = null;
    var resting = null;
    var label = null;
    var className = null;
    function rest() {
      timer = null;
      target.textContent = '';
      resting.forEach(function (n) { target.appendChild(n); });
      if (label) target.setAttribute('aria-label', label);
      target.className = className;
    }
    target.addEventListener('click', function () {
      if (timer) {
        clearTimeout(timer);
        rest();
        action();
        return;
      }
      resting = Array.prototype.slice.call(target.childNodes);
      label = target.getAttribute('aria-label');
      className = target.className;
      target.textContent = armedLabel;
      target.setAttribute('aria-label', armedLabel);
      // A button pulled into a line of text (-my-2) stays there while armed.
      target.className = /(^| )-my-2( |$)/.test(className)
        ? 'btn-secondary -my-2 shrink-0 whitespace-nowrap border-0 bg-transparent px-2 text-small text-danger'
        : 'btn-secondary shrink-0 whitespace-nowrap border-0 bg-transparent px-2 text-small text-danger';
      timer = setTimeout(rest, 4000);
    });
  }

  function showStatus(err, where) {
    var line = where || el.status;
    line.textContent = err ? err.message : '';
    line.hidden = !err;
  }

  /** Do something to an event, then read the list again; a failure is shown on that event. */
  function act(eventId, promise) {
    return promise
      .then(function () { trouble = null; return load(); })
      .catch(function (err) {
        trouble = { id: eventId, message: err.message };
        if (current) render(current);
      });
  }

  // ── Words ──────────────────────────────────────────────────────────────

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  /** "Today, 6:00 PM", "Tomorrow, 6:00 PM" or "Sat, Oct 17, 6:00 PM", in the viewer's own time. */
  function when(iso, nowIso) {
    var at = new Date(iso);
    var now = new Date(nowIso);
    var tomorrow = new Date(now.getTime());
    tomorrow.setDate(tomorrow.getDate() + 1);
    var time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (sameDay(at, now)) return 'Today, ' + time;
    if (sameDay(at, tomorrow)) return 'Tomorrow, ' + time;
    var opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (at.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return at.toLocaleDateString(undefined, opts) + ', ' + time;
  }

  function count(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  /** "a", "a and b", "a, b and c". */
  function listWords(words) {
    if (words.length < 2) return words.join('');
    return words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
  }

  function who(p) {
    return p.mine ? 'You' : '@' + p.username;
  }

  // ── An event ───────────────────────────────────────────────────────────

  function eventHead(e, data) {
    var head = h('div', 'flex flex-col gap-1 px-1');
    head.appendChild(h('h2', 'text-heading break-words', e.name));
    head.appendChild(h('p', 'text-body text-muted', when(e.startsAt, data.now) + (e.place ? ' · ' + e.place : '')));
    var by = h('div', 'flex items-center gap-1');
    by.appendChild(h('p', 'min-w-0 flex-1 text-small text-muted', e.mine ? 'Made by you' : 'Made by @' + e.by));
    if (e.mine) {
      if (e.kind === 'slots' && e.slots.length) {
        var edit = button('btn-secondary -my-2 shrink-0 border-0 bg-transparent px-2 text-small text-muted', editing === e.id ? 'Done' : 'Remove slots');
        edit.setAttribute('aria-pressed', editing === e.id ? 'true' : 'false');
        edit.addEventListener('click', function () { editing = editing === e.id ? null : e.id; render(current); });
        by.appendChild(edit);
      }
      var remove = button('btn-secondary -my-2 shrink-0 border-0 bg-transparent px-2 text-small text-muted', 'Delete');
      remove.setAttribute('aria-label', 'Delete ' + e.name);
      // Every slot and answer on it goes too.
      tapTwice(remove, 'Tap again to delete', function () {
        act(e.id, api('DELETE', '/api/events/' + e.id));
      });
      by.appendChild(remove);
    }
    head.appendChild(by);
    return head;
  }

  /** The dots for a slot's spots (or a bar, for a big slot), and how many are open. */
  function meter(s) {
    var line = h('div', 'flex flex-wrap items-center gap-x-2 gap-y-1');
    line.setAttribute('data-taken', String(s.taken));
    var shape = h('span', 'flex flex-wrap items-center gap-1');
    shape.setAttribute('aria-hidden', 'true');
    if (s.size <= 12) {
      for (var i = 0; i < s.size; i++) {
        shape.appendChild(h('span', i < s.taken
          ? 'h-2.5 w-2.5 rounded-full bg-accent'
          : 'box-border h-2.5 w-2.5 rounded-full border-[1.5px] border-muted/60'));
      }
    } else {
      var bar = h('span', 'block h-2 w-24 overflow-hidden rounded-full bg-line');
      var fill = h('span', 'block h-full rounded-full bg-accent');
      fill.style.width = Math.round((s.taken / s.size) * 100) + '%';
      bar.appendChild(fill);
      shape.appendChild(bar);
    }
    line.appendChild(shape);
    // A full slot says so where its button would be.
    if (!s.full) line.appendChild(h('span', 'text-small text-muted', count(s.open, 'spot', 'spots') + ' open'));
    return line;
  }

  function slotRow(s, e) {
    var row = h('li', 'list-row');
    row.setAttribute('data-slot', String(s.id));
    var text = h('div', 'flex min-w-0 flex-1 flex-col gap-1');
    text.appendChild(h('span', 'text-body font-medium break-words', s.name));
    text.appendChild(meter(s));
    var people = s.people.slice().sort(function (a, b) { return (b.mine ? 1 : 0) - (a.mine ? 1 : 0); });
    text.appendChild(h('span', 'text-small text-muted break-words', people.length ? people.map(who).join(', ') : 'Nobody yet'));
    row.appendChild(text);

    if (editing === e.id) {
      var remove = button('btn-secondary shrink-0 px-3 text-danger', 'Remove');
      remove.setAttribute('aria-label', 'Remove ' + s.name + (s.taken ? ', and ' + count(s.taken, 'person', 'people') + ' on it' : ''));
      tapTwice(remove, 'Tap again to remove', function () { act(e.id, api('DELETE', '/api/slots/' + s.id)); });
      row.appendChild(remove);
    } else if (s.mine) {
      // You're on it: a second tap leaves it.
      var on = button('btn-secondary shrink-0 border-0 bg-transparent px-2 font-semibold text-accent', 'You\'re on');
      on.setAttribute('aria-label', 'You\'re on ' + s.name + '. Tap twice to leave it.');
      tapTwice(on, 'Tap again to leave', function () { act(e.id, api('DELETE', '/api/slots/' + s.id + '/signup')); });
      row.appendChild(on);
    } else if (s.full) {
      row.appendChild(h('span', 'shrink-0 px-2 text-small text-muted', 'Full'));
    } else {
      var join = button('btn-secondary shrink-0 px-3', 'Sign up');
      join.setAttribute('aria-label', 'Sign up for ' + s.name);
      join.addEventListener('click', function () {
        join.disabled = true;
        act(e.id, api('PUT', '/api/slots/' + s.id + '/signup'));
      });
      row.appendChild(join);
    }
    return row;
  }

  function addSlotForm(e) {
    var form = h('form', 'card flex flex-col gap-3');
    form.setAttribute('autocomplete', 'off');
    form.appendChild(h('p', 'text-body font-medium', 'Add a slot'));
    var nameField = h('div', 'flex flex-col gap-1');
    var nameLabel = h('label', 'px-1 text-small text-muted', 'What needs people?');
    nameLabel.htmlFor = 'slot-name-' + e.id;
    nameField.appendChild(nameLabel);
    var name = h('input', 'field');
    name.id = 'slot-name-' + e.id;
    name.name = 'name';
    name.type = 'text';
    name.maxLength = 80;
    name.required = true;
    name.placeholder = slotExample;
    nameField.appendChild(name);
    form.appendChild(nameField);

    var sizeField = h('div', 'flex flex-col gap-1');
    var sizeLabel = h('label', 'px-1 text-small text-muted', 'How many people');
    sizeLabel.htmlFor = 'slot-size-' + e.id;
    sizeField.appendChild(sizeLabel);
    var size = h('input', 'field w-28');
    size.id = 'slot-size-' + e.id;
    size.name = 'size';
    size.type = 'number';
    size.inputMode = 'numeric';
    size.min = '1';
    size.max = '50';
    size.step = '1';
    size.required = true;
    size.value = '2';
    sizeField.appendChild(size);
    form.appendChild(sizeField);

    var actions = h('div', 'flex flex-wrap gap-2');
    var add = h('button', 'btn-primary', 'Add slot');
    add.type = 'submit';
    actions.appendChild(add);
    var cancel = button('btn-secondary', 'Cancel');
    cancel.addEventListener('click', function () { adding = null; render(current); });
    actions.appendChild(cancel);
    form.appendChild(actions);

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!name.value.trim()) return;
      act(e.id, api('POST', '/api/events/' + e.id + '/slots', { name: name.value, size: Number(size.value) })
        .then(function () { adding = null; }));
    });
    setTimeout(function () { if (document.body.contains(name)) name.focus(); }, 0);
    return form;
  }

  function slotsBody(block, e) {
    if (e.yours.length) {
      var on = h('p', 'flex items-center gap-2 px-1 text-body font-medium text-accent');
      on.appendChild(icon('check', 'h-5 w-5 shrink-0'));
      on.appendChild(document.createTextNode('You\'re on ' + listWords(e.yours)));
      block.appendChild(on);
    }
    var section = h('section', 'flex flex-col');
    var top = h('div', 'mb-2 flex items-baseline justify-between gap-3 px-1');
    top.appendChild(h('h3', 'text-small font-medium text-muted', 'Slots'));
    if (e.slots.length) {
      top.appendChild(h('p', 'text-small text-muted', e.open
        ? count(e.open, 'spot', 'spots') + ' still open'
        : 'Every spot is taken'));
    }
    section.appendChild(top);
    if (e.slots.length) {
      var list = h('ul', 'list');
      e.slots.forEach(function (s) { list.appendChild(slotRow(s, e)); });
      section.appendChild(list);
    } else {
      section.appendChild(h('p', 'px-1 text-body text-muted', 'No slots yet. Add what needs people, and how many each takes.'));
    }
    block.appendChild(section);

    // Anyone can add a slot.
    if (adding === e.id) {
      block.appendChild(addSlotForm(e));
    } else {
      var open = button('btn-secondary w-full');
      open.appendChild(icon('plus', 'h-4 w-4'));
      open.appendChild(document.createTextNode('Add a slot'));
      open.addEventListener('click', function () { adding = e.id; editing = null; render(current); });
      block.appendChild(open);
    }
  }

  function noteForm(e) {
    var form = h('form', 'flex gap-2');
    form.setAttribute('autocomplete', 'off');
    var note = h('input', 'field min-w-0 flex-1');
    note.name = 'note';
    note.type = 'text';
    note.enterKeyHint = 'done';
    note.maxLength = 80;
    note.value = e.answer.note || '';
    note.placeholder = 'Add a note, e.g. +1 or bringing snacks';
    note.setAttribute('aria-label', 'Your note for ' + e.name);
    form.appendChild(note);
    var save = h('button', 'btn-secondary shrink-0', 'Save');
    save.type = 'submit';
    form.appendChild(save);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      note.blur();
      act(e.id, api('PUT', '/api/events/' + e.id + '/answer', { answer: e.answer.answer, note: note.value }));
    });
    return form;
  }

  function nameWithNote(p) {
    return who(p) + (p.note ? ' (' + p.note + ')' : '');
  }

  function rsvpBody(block, e) {
    // Your answer: one tap, changed whenever you like.
    var ask = h('div', 'flex flex-col gap-2');
    ask.appendChild(h('p', 'px-1 text-small text-muted', 'Are you coming?'));
    var group = h('div', 'flex gap-1 rounded-xl border border-line bg-surface p-1');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Are you coming to ' + e.name + '?');
    ANSWERS.forEach(function (a) {
      var chosen = !!e.answer && e.answer.answer === a.key;
      var b = button(chosen
        ? 'min-h-11 flex-1 rounded-lg bg-accent px-2 text-body font-medium text-on-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus'
        : 'min-h-11 flex-1 rounded-lg px-2 text-body font-medium text-fg hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus', a.label);
      b.setAttribute('data-answer', a.key);
      b.setAttribute('aria-pressed', chosen ? 'true' : 'false');
      b.addEventListener('click', function () {
        if (chosen) return;
        act(e.id, api('PUT', '/api/events/' + e.id + '/answer', { answer: a.key }));
      });
      group.appendChild(b);
    });
    ask.appendChild(group);
    if (e.answer) ask.appendChild(noteForm(e));
    block.appendChild(ask);

    // The headcount.
    var c = e.counts;
    var head = h('div', 'flex flex-col px-1');
    head.setAttribute('data-headcount', String(c.going));
    head.appendChild(h('p', 'text-title', c.going ? c.going + ' going' : 'Nobody going yet'));
    var rest = [];
    if (c.maybe) rest.push(c.maybe + ' maybe');
    if (c.cant) rest.push(c.cant + ' can\'t');
    if (c.unsaid) rest.push(c.unsaid + (c.unsaid === 1 ? ' hasn\'t said' : ' haven\'t said'));
    if (rest.length) head.appendChild(h('p', 'text-small text-muted', rest.join(', ')));
    block.appendChild(head);

    // Who is going, you first, with their notes.
    if (e.going.length) {
      var section = h('section', 'flex flex-col');
      section.appendChild(h('h3', 'section-label', 'Going'));
      var list = h('ul', 'list');
      var going = e.going.slice().sort(function (a, b) { return (b.mine ? 1 : 0) - (a.mine ? 1 : 0); });
      var cut = !showAll[e.id] && going.length > GOING_SHOWN + 1;
      (cut ? going.slice(0, GOING_SHOWN) : going).forEach(function (p) {
        var row = h('li', 'list-row');
        row.setAttribute('data-person', p.username);
        row.appendChild(h('span', p.mine ? 'min-w-0 flex-1 text-body font-semibold break-words' : 'min-w-0 flex-1 text-body break-words', who(p)));
        if (p.note) row.appendChild(h('span', 'min-w-0 max-w-[55%] text-right text-small text-muted break-words', p.note));
        list.appendChild(row);
      });
      if (cut) {
        var more = h('li', 'flex');
        var all = button('flex min-h-11 flex-1 items-center justify-between gap-3 px-4 py-2 text-left text-body text-muted hover:bg-raised');
        all.appendChild(h('span', null, 'And ' + (going.length - GOING_SHOWN) + ' more'));
        all.appendChild(h('span', 'text-small font-medium text-accent', 'Show all'));
        all.addEventListener('click', function () { showAll[e.id] = true; render(current); });
        more.appendChild(all);
        list.appendChild(more);
      }
      section.appendChild(list);
      block.appendChild(section);
    }

    // Who might come, and who can't.
    var others = h('div', 'flex flex-col gap-2 px-1');
    [['Maybe: ', e.maybe], ['Can\'t: ', e.cant]].forEach(function (pair) {
      if (!pair[1].length) return;
      var line = h('p', 'text-small text-muted break-words');
      line.appendChild(h('span', 'font-medium', pair[0]));
      line.appendChild(document.createTextNode(pair[1].map(nameWithNote).join(', ')));
      others.appendChild(line);
    });
    if (others.childNodes.length) block.appendChild(others);
  }

  function eventBlock(e, data) {
    var block = h('article', 'flex flex-col gap-4');
    block.setAttribute('data-event', String(e.id));
    block.setAttribute('data-kind', e.kind);
    block.appendChild(eventHead(e, data));
    if (e.kind === 'rsvp') rsvpBody(block, e);
    else slotsBody(block, e);
    if (trouble && trouble.id === e.id) {
      var line = h('p', 'px-1 text-small text-danger', trouble.message);
      line.setAttribute('role', 'alert');
      block.appendChild(line);
    }
    return block;
  }

  function pastRow(e, data) {
    var row = h('li', 'list-row');
    row.setAttribute('data-past-event', String(e.id));
    var text = h('div', 'min-w-0 flex-1');
    text.appendChild(h('p', 'text-body break-words', e.name));
    var summary = e.kind === 'rsvp'
      ? e.counts.going + ' going'
      : (e.spots - e.open) + ' of ' + count(e.spots, 'spot', 'spots') + ' taken';
    text.appendChild(h('p', 'text-small text-muted', when(e.startsAt, data.now) + ' · ' + summary));
    row.appendChild(text);
    return row;
  }

  // ── Loading, empty, error ──────────────────────────────────────────────

  function show(state) {
    el.loading.hidden = state !== 'loading';
    el.error.hidden = state !== 'error';
    if (state !== 'ready') {
      el.empty.hidden = true;
      el.events.hidden = true;
      el.pastSection.hidden = true;
    }
  }

  function render(data) {
    current = data;
    var ids = data.upcoming.map(function (e) { return e.id; });
    if (adding !== null && ids.indexOf(adding) < 0) adding = null;
    var withSlots = data.upcoming.filter(function (e) { return e.slots && e.slots.length; }).map(function (e) { return e.id; });
    if (editing !== null && withSlots.indexOf(editing) < 0) editing = null;
    // Keep a half-typed note or slot through a re-draw.
    var focused = document.activeElement;
    var keep = focused && el.events.contains(focused) && focused.tagName === 'INPUT'
      ? { id: focused.id, label: focused.getAttribute('aria-label'), value: focused.value }
      : null;

    el.events.textContent = '';
    data.upcoming.forEach(function (e) { el.events.appendChild(eventBlock(e, data)); });
    el.events.hidden = !data.upcoming.length;
    el.empty.hidden = !!data.upcoming.length;
    el.past.textContent = '';
    data.past.forEach(function (e) { el.past.appendChild(pastRow(e, data)); });
    el.pastSection.hidden = !data.past.length;

    if (keep) {
      var again = keep.id ? document.getElementById(keep.id) : null;
      if (!again && keep.label) {
        again = Array.prototype.filter.call(el.events.querySelectorAll('input'), function (i) {
          return i.getAttribute('aria-label') === keep.label;
        })[0];
      }
      if (again) { again.value = keep.value; again.focus(); }
    }

    // The new event's day starts no earlier than today.
    var now = new Date(data.now);
    el.newForm.elements.date.min = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    show('ready');
  }

  var loaded = false;
  var loading = null;
  var again = false;
  function load() {
    // A read already on its way may have left before the change just made:
    // read once more when it is back.
    if (loading) { again = true; return loading; }
    loading = api('GET', '/api/events')
      .then(function (data) { loaded = true; showStatus(null); render(data); })
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

  // ── A new event ────────────────────────────────────────────────────────

  function openNew(open) {
    el.newForm.hidden = !open;
    el.newButton.hidden = open;
    el.newButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    showStatus(null, el.newStatus);
    if (open) el.newForm.elements.name.focus();
  }

  el.newButton.addEventListener('click', function () { openNew(true); });
  document.getElementById('new-cancel').addEventListener('click', function () {
    el.newForm.reset();
    el.newForm.elements.time.value = mode === 'slots' ? '09:00' : '19:00';
    openNew(false);
  });

  el.newForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var f = el.newForm.elements;
    if (!f.name.value.trim() || !f.date.value || !f.time.value) return;
    // The maker's own day and time, sent as one moment.
    var startsAt = new Date(f.date.value + 'T' + f.time.value);
    api('POST', '/api/events', { name: f.name.value, place: f.place.value, startsAt: startsAt.toISOString() })
      .then(function (made) {
        el.newForm.reset();
        f.time.value = mode === 'slots' ? '09:00' : '19:00';
        openNew(false);
        // A new sheet needs its slots next: open the form for them.
        if (made.kind === 'slots') adding = made.id;
        return load().then(function () {
          var block = el.events.querySelector('[data-event="' + made.id + '"]');
          if (block) block.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      })
      .catch(function (err) { showStatus(err, el.newStatus); });
  });

  document.getElementById('retry').addEventListener('click', function () { show('loading'); load(); });

  // Other people sign up and answer too: whenever anybody changes
  // something, the sheets are fetched again at once, and looked at every
  // minute regardless (public/live-updates.js). Not while someone is typing
  // or adding something: what changed then is fetched the moment they are
  // done, so a refresh never eats what they are writing.
  function busy() {
    var active = document.activeElement;
    var typing = active && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA');
    return typing || adding !== null || !el.newForm.hidden;
  }
  if (window.LiveUpdates) window.LiveUpdates.watch({ refresh: load, quiet: function () { return !busy(); } });

  // The first screen, drawn: Homeroom keeps its opening cover up until then
  // (usernode.ready, the platform bridge), so the app appears in one step
  // rather than as loading shapes that then change. The cover lifts after a
  // few seconds regardless.
  var first = load();
  if (window.usernode && window.usernode.ready) window.usernode.ready(first);

  // Pull down to fetch again, as a native list does. The native kit
  // (/usernode-native/v1/native.js) draws the spinner and bounces the page
  // in place, so a drag past the top no longer carries Homeroom's header
  // with it. Not on a computer, where the kit leaves the page alone.
  if (window.unNative) first.then(function () { window.unNative.attachPullToRefresh(window, load); });
})();
