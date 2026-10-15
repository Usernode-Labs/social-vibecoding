// The find-a-time screen. Talks to api.js; every request carries the
// platform token the frame was opened with, which is how the server knows
// who you are.
//
// Two views: home (the open plans, each with its grid of who is free when
// and the best time so far, then the past ones) and "When are you free?",
// where you mark each of one plan's times Free, If needed or Can't.
//
// Times: a suggested time is sent as an ISO string built from your own day
// and time inputs, and shown in your own time zone and language. A whole
// day is sent as that date's midnight UTC with allDay, and shown in UTC, so
// it is the same date for everyone (api.js, "How a time is stored").
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it, so a plan called "<b>hi</b>" shows exactly that.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';

  function byId(id) { return document.getElementById(id); }

  var el = {
    home: byId('home'),
    status: byId('status'),
    loading: byId('loading'),
    error: byId('error'),
    empty: byId('empty'),
    plans: byId('plans'),
    pastSection: byId('past-section'),
    past: byId('past'),
    newPlan: byId('new-plan'),
    planForm: byId('plan-form'),
    planTimes: byId('plan-times'),
    planAddTime: byId('plan-add-time'),
    planStatus: byId('plan-status'),
    markView: byId('mark-view'),
    markPlan: byId('mark-plan'),
    markList: byId('mark-list'),
    markSave: byId('mark-save'),
    markStatus: byId('mark-status'),
    suggestOpen: byId('suggest-open'),
    suggestForm: byId('suggest-form'),
    suggestStatus: byId('suggest-status'),
  };

  var START_MAX = 8;
  var CHOICES = [
    { mark: 'free', label: 'Free', words: 'free' },
    { mark: 'maybe', label: 'If needed', words: 'free if needed' },
    { mark: 'no', label: 'Can\'t', words: 'can\'t' },
  ];

  var current = null; // the last list read
  var marking = null; // { planId, draft: { slotId: mark } } while marking your times
  var choosing = {}; // plan id -> true while its starter picks a time other than the best

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

  /** A line icon drawn as an SVG from path data, in the text colour. */
  function icon(paths, className, width) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', String(width || 2.2));
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    paths.forEach(function (d) {
      var path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }
  var CHECK = ['M5 12.5l4.5 4.5L19 7.5'];
  var TILDE = ['M5 13.5c2.3-3 4.7-3 7 0s4.7 3 7 0'];
  var CROSS = ['M6 6l12 12', 'M18 6L6 18'];

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
      button.textContent = '';
      resting.forEach(function (n) { button.appendChild(n); });
      if (label) button.setAttribute('aria-label', label);
      button.className = className;
    }
    button.addEventListener('click', function () {
      if (timer) {
        clearTimeout(timer);
        rest();
        action();
        return;
      }
      resting = Array.prototype.slice.call(button.childNodes);
      label = button.getAttribute('aria-label');
      className = button.className;
      button.textContent = armedLabel;
      button.setAttribute('aria-label', armedLabel);
      button.className = 'btn-secondary shrink-0 whitespace-nowrap border-0 bg-transparent px-2 text-small text-danger';
      timer = setTimeout(rest, 4000);
    });
  }

  /** An error line under whatever was being done, or the page's own. */
  function showStatus(err, where) {
    var line = where || el.status;
    line.textContent = err ? err.message : '';
    line.hidden = !err;
  }

  function act(promise, where) {
    return promise.then(function () { showStatus(null, where); return load(); }).catch(function (err) { showStatus(err, where); });
  }

  // ── When ───────────────────────────────────────────────────────────────

  // Whether this viewer's clock is a 12-hour one: then 7:00 PM shows as "7 PM".
  var HOUR12 = (function () {
    try { return !!new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12; } catch (e) { return false; }
  })();

  function nowYear() {
    return new Date(current ? current.now : Date.now()).getFullYear();
  }

  /** "Thu, Nov 6": a whole day in UTC (the same date for everyone), a time in yours. */
  function dayText(slot) {
    var at = new Date(slot.startsAt);
    var opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (slot.allDay) opts.timeZone = 'UTC';
    if ((slot.allDay ? at.getUTCFullYear() : at.getFullYear()) !== nowYear()) opts.year = 'numeric';
    return at.toLocaleDateString(undefined, opts);
  }

  /** "7 PM", "7:30 PM" (or "19:00"), or "All day". */
  function timeText(slot) {
    if (slot.allDay) return 'All day';
    var at = new Date(slot.startsAt);
    return at.toLocaleTimeString(undefined, HOUR12 && !at.getMinutes() ? { hour: 'numeric' } : { hour: 'numeric', minute: '2-digit' });
  }

  /** "Thu, Nov 6 at 7 PM", or "Sat, Nov 8" for a whole day. */
  function whenText(slot) {
    return slot.allDay ? dayText(slot) : dayText(slot) + ' at ' + timeText(slot);
  }

  /** "YYYY-MM-DD" of a moment in this viewer's own time zone, for a date input. */
  function localDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /**
   * A suggested time from a day input and an optional time input: the
   * moment they name where you are, or with no time, the whole day.
   */
  function timeFrom(date, time) {
    if (!date) return null;
    if (!time) return { startsAt: date + 'T00:00:00.000Z', allDay: true };
    var at = new Date(date + 'T' + time);
    return Number.isNaN(at.getTime()) ? null : { startsAt: at.toISOString(), allDay: false };
  }

  // ── Words ──────────────────────────────────────────────────────────────

  function isMe(username) {
    return !!(current && current.me && username === current.me.username);
  }

  function nameOf(username) {
    return isMe(username) ? 'you' : '@' + username;
  }

  /** "a", "a and b", "a, b and c". */
  function listWords(words) {
    if (words.length < 2) return words.join('');
    return words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
  }

  /**
   * The letter in a person's column. A staging preview's made-up people are
   * all "staging-demo-...", so theirs is the letter after that.
   */
  function initialOf(username) {
    var name = String(username).replace(/^staging-demo-/, '');
    return (name.charAt(0) || '?').toUpperCase();
  }

  /** "5 of 6 are free; @jo if needed." */
  function countWords(slot, answered) {
    var words;
    if (!slot.free) words = 'Nobody is free';
    else if (slot.free === answered && answered > 1) words = 'All ' + answered + ' are free';
    else words = slot.free + ' of ' + answered + (slot.free === 1 ? ' is' : ' are') + ' free';
    var maybe = slot.maybeNames.map(nameOf);
    if (maybe.length) words += '; ' + (maybe.length > 3 ? maybe.length : listWords(maybe)) + ' if needed';
    return words + '.';
  }

  // ── A plan ─────────────────────────────────────────────────────────────

  function slotOf(plan, id) {
    return plan.slots.filter(function (s) { return s.id === id; })[0] || null;
  }

  function planById(id) {
    return current ? current.plans.filter(function (p) { return p.id === id; })[0] || null : null;
  }

  function haveAnswered(plan) {
    return plan.people.some(function (p) { return p.me; });
  }

  /** The card at the top: the time that is set, or the best so far. */
  function summary(plan) {
    var card = h('div', 'card flex flex-col gap-0.5');
    var set = plan.set ? slotOf(plan, plan.set) : null;
    var best = plan.best ? slotOf(plan, plan.best) : null;
    if (set) {
      card.setAttribute('data-set', String(set.id));
      card.appendChild(h('p', 'text-heading', 'Set: ' + whenText(set)));
      card.appendChild(h('p', 'text-small text-muted', plan.answered ? countWords(set, plan.answered) : 'Nobody marked their times.'));
    } else if (best) {
      card.setAttribute('data-best', String(best.id));
      card.appendChild(h('p', 'text-small text-muted', 'Best so far'));
      card.appendChild(h('p', 'text-heading', whenText(best)));
      card.appendChild(h('p', 'text-small text-muted', countWords(best, plan.answered)));
    } else if (plan.answered) {
      card.appendChild(h('p', 'text-heading', 'No time works yet'));
      card.appendChild(h('p', 'text-small text-muted', 'Nobody can make any of these times. Suggest another one.'));
    } else {
      card.appendChild(h('p', 'text-heading', 'No answers yet'));
      card.appendChild(h('p', 'text-small text-muted', 'Mark your times, and the best one shows here.'));
    }
    return card;
  }

  /** One person's mark on one time, as a small square. */
  function markCell(person, mark) {
    var td = h('td', 'px-0.5 py-2');
    td.setAttribute('data-mark', mark || 'none');
    var choice = CHOICES.filter(function (c) { return c.mark === mark; })[0];
    var who = person.me ? 'You' : '@' + person.username;
    var square;
    if (mark === 'free') {
      square = h('span', 'mx-auto flex h-7 w-7 items-center justify-center rounded-md bg-accent text-on-accent');
      square.appendChild(icon(CHECK, 'h-3.5 w-3.5', 3.4));
    } else if (mark === 'maybe') {
      square = h('span', 'mx-auto flex h-7 w-7 items-center justify-center rounded-md bg-accent/20 text-accent');
      square.appendChild(icon(TILDE, 'h-4 w-4', 2.8));
    } else if (mark === 'no') {
      square = h('span', 'mx-auto flex h-7 w-7 rounded-md border border-line');
    } else {
      square = h('span', 'mx-auto flex h-7 w-7 rounded-md border border-dashed border-line');
    }
    square.setAttribute('role', 'img');
    square.setAttribute('aria-label', who + ': ' + (choice ? choice.words : 'not marked yet'));
    square.title = who + ': ' + (choice ? choice.words : 'not marked yet');
    td.appendChild(square);
    return td;
  }

  /**
   * Who is free when: a row for each time, a column for each person who has
   * answered (you first), and how many are free. With more people than fit,
   * the people scroll sideways between the times and the counts.
   */
  function grid(plan) {
    var highlight = plan.set || plan.best;
    var wrap = h('div', 'overflow-x-auto rounded-xl border border-line bg-surface');
    var table = h('table', 'w-full border-collapse');
    var caption = h('caption', 'sr-only', 'Who is free when for ' + plan.name);
    table.appendChild(caption);

    var head = h('thead');
    var hr = h('tr');
    var th = h('th', 'sticky left-0 z-10 bg-surface py-2 pl-3 pr-2 text-left text-small font-normal text-muted', 'Time');
    th.scope = 'col';
    hr.appendChild(th);
    plan.people.forEach(function (person) {
      var col = h('th', 'px-0.5 py-2');
      col.scope = 'col';
      var who = person.me ? 'You' : '@' + person.username;
      var dot = h('span', person.me
        ? 'mx-auto flex h-7 w-7 items-center justify-center rounded-full bg-accent text-small font-semibold text-on-accent'
        : 'mx-auto flex h-7 w-7 items-center justify-center rounded-full bg-raised text-small font-semibold text-fg', initialOf(person.username));
      dot.setAttribute('aria-label', who);
      dot.title = who;
      col.appendChild(dot);
      hr.appendChild(col);
    });
    var freeHead = h('th', 'sticky right-0 z-10 bg-surface py-2 pl-2 pr-3 text-right text-small font-normal text-muted', 'Free');
    freeHead.scope = 'col';
    hr.appendChild(freeHead);
    head.appendChild(hr);
    table.appendChild(head);

    var body = h('tbody');
    plan.slots.forEach(function (slot) {
      var lit = slot.id === highlight;
      var row = h('tr', lit ? 'border-t border-line bg-raised' : slot.passed ? 'border-t border-line text-muted' : 'border-t border-line');
      row.setAttribute('data-slot', String(slot.id));
      var label = h('th', lit
        ? 'sticky left-0 z-10 bg-raised py-2 pl-3 pr-2 text-left font-normal'
        : 'sticky left-0 z-10 bg-surface py-2 pl-3 pr-2 text-left font-normal');
      label.scope = 'row';
      label.appendChild(h('span', 'block whitespace-nowrap text-body font-medium', dayText(slot)));
      label.appendChild(h('span', 'block whitespace-nowrap text-small text-muted', timeText(slot) + (slot.passed ? ', passed' : '')));
      row.appendChild(label);
      plan.people.forEach(function (person) {
        row.appendChild(markCell(person, slot.marks[String(person.id)]));
      });
      var count = h('td', lit
        ? 'sticky right-0 z-10 bg-raised py-2 pl-2 pr-3 text-right text-body font-semibold text-accent'
        : 'sticky right-0 z-10 bg-surface py-2 pl-2 pr-3 text-right text-body text-muted', plan.answered ? slot.free + '/' + plan.answered : '0');
      count.setAttribute('aria-label', slot.free + ' of ' + plan.answered + ' free');
      row.appendChild(count);
      body.appendChild(row);
    });
    table.appendChild(body);
    wrap.appendChild(table);
    return wrap;
  }

  function legend() {
    var row = h('div', 'flex flex-wrap gap-x-4 gap-y-1 px-1 text-small text-muted');
    row.setAttribute('aria-hidden', 'true');
    [['h-3 w-3 rounded-sm bg-accent', 'Free'], ['h-3 w-3 rounded-sm bg-accent/20', 'If needed'], ['h-3 w-3 rounded-sm border border-line', 'Can\'t']]
      .forEach(function (item) {
        var key = h('span', 'inline-flex items-center gap-1.5');
        key.appendChild(h('span', item[0]));
        key.appendChild(document.createTextNode(item[1]));
        row.appendChild(key);
      });
    return row;
  }

  /** Who in the project has not marked any time yet, from the member list. */
  function waitingLine(plan) {
    if (!plan.open) return null;
    if (plan.waiting) {
      if (!plan.waiting.length) return plan.answered ? h('p', 'px-1 text-small text-muted', 'Everyone has answered.') : null;
      var names = plan.waiting.map(function (w) { return w.me ? 'you' : '@' + w.username; });
      var shown = names.length > 8 ? names.slice(0, 7).concat([(names.length - 7) + ' more']) : names;
      return h('p', 'px-1 text-small text-muted', 'Still to answer: ' + listWords(shown) + '.');
    }
    if (current.me && current.members === 'unavailable') {
      return h('p', 'px-1 text-small text-muted', 'Who still has to answer shows once the member list loads.');
    }
    return null;
  }

  function setTime(plan, slotId, where) {
    delete choosing[plan.id];
    act(api('PUT', '/api/plans/' + plan.id + '/set', { slotId: slotId }), where);
  }

  /**
   * The starter's way to set the time: the best one in one tap, or any of
   * the plan's times from a list.
   */
  function setControls(plan, where) {
    var box = h('div', 'flex flex-col gap-1');
    var best = plan.best ? slotOf(plan, plan.best) : null;
    if (!choosing[plan.id]) {
      if (best) {
        var setBest = h('button', 'btn-secondary w-full', 'Set ' + whenText(best) + ' as the time');
        setBest.type = 'button';
        setBest.addEventListener('click', function () { setTime(plan, best.id, where); });
        box.appendChild(setBest);
      }
      var other = h('button', 'btn-secondary self-center border-0 bg-transparent px-2 text-small text-muted', best ? 'Pick another time' : 'Set the time');
      other.type = 'button';
      other.addEventListener('click', function () { choosing[plan.id] = true; render(current); });
      box.appendChild(other);
      return box;
    }
    var row = h('div', 'flex gap-2');
    var select = h('select', 'field min-w-0 flex-1');
    select.setAttribute('aria-label', 'The time to set');
    plan.slots.forEach(function (s) {
      var o = h('option', null, whenText(s) + (s.id === plan.best ? ' (best so far)' : ''));
      o.value = String(s.id);
      select.appendChild(o);
    });
    if (best) select.value = String(best.id);
    row.appendChild(select);
    var go = h('button', 'btn-secondary shrink-0', 'Set it');
    go.type = 'button';
    go.addEventListener('click', function () { setTime(plan, Number(select.value), where); });
    row.appendChild(go);
    box.appendChild(row);
    var back = h('button', 'btn-secondary self-center border-0 bg-transparent px-2 text-small text-muted', 'Cancel');
    back.type = 'button';
    back.addEventListener('click', function () { delete choosing[plan.id]; render(current); });
    box.appendChild(back);
    return box;
  }

  function planBlock(plan) {
    var block = h('article', 'flex flex-col gap-3');
    block.setAttribute('data-plan', String(plan.id));

    var head = h('div', 'flex flex-col gap-0.5 px-1');
    head.appendChild(h('h2', 'text-heading break-words', plan.name));
    var answered = plan.answered === 0 ? 'nobody has answered yet' : plan.answered + ' answered';
    head.appendChild(h('p', 'text-small text-muted', (plan.mine ? 'Started by you' : 'Started by @' + plan.by) + ' · ' + answered));
    block.appendChild(head);

    block.appendChild(summary(plan));
    block.appendChild(grid(plan));
    block.appendChild(legend());
    var waiting = waitingLine(plan);
    if (waiting) block.appendChild(waiting);

    var error = h('p', 'text-small text-danger');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    var actions = h('div', 'flex flex-col gap-2');
    if (plan.open) {
      var answeredMine = haveAnswered(plan);
      var mark = h('button', answeredMine ? 'btn-secondary w-full' : 'btn-primary w-full', answeredMine ? 'Change your times' : 'Mark your times');
      mark.type = 'button';
      mark.addEventListener('click', function () { openMark(plan.id); });
      actions.appendChild(mark);
      if (plan.mine) actions.appendChild(setControls(plan, error));
    } else if (plan.mine) {
      var reopen = h('button', 'btn-secondary w-full', 'Reopen the plan');
      reopen.type = 'button';
      reopen.addEventListener('click', function () { setTime(plan, null, error); });
      actions.appendChild(reopen);
    }
    actions.appendChild(error);
    if (plan.mine) {
      var remove = h('button', 'btn-secondary self-center border-0 bg-transparent px-2 text-small text-muted', 'Delete this plan');
      remove.type = 'button';
      // Everyone's marks on it go too.
      tapTwice(remove, 'Tap again to delete the plan', function () { act(api('DELETE', '/api/plans/' + plan.id), error); });
      actions.appendChild(remove);
    }
    block.appendChild(actions);
    return block;
  }

  function pastRow(plan) {
    var row = h('li', 'list-row');
    var text = h('div', 'min-w-0 flex-1');
    text.appendChild(h('p', 'text-body break-words', plan.name));
    text.appendChild(h('p', 'text-small text-muted', (plan.set ? 'Set: ' + whenText(plan.set) : 'No time was set')
      + ' · ' + (plan.mine ? 'started by you' : 'started by @' + plan.by)));
    row.appendChild(text);
    return row;
  }

  // ── Marking your times ─────────────────────────────────────────────────

  function showView(markingNow) {
    el.home.hidden = markingNow;
    el.markView.hidden = !markingNow;
  }

  function openMark(planId) {
    var plan = planById(planId);
    if (!plan) return;
    marking = { planId: planId, draft: {} };
    var me = current.me ? String(current.me.id) : null;
    plan.slots.forEach(function (s) {
      if (me && s.marks[me]) marking.draft[s.id] = s.marks[me];
    });
    showStatus(null, el.markStatus);
    closeSuggest();
    renderMark();
    showView(true);
    window.scrollTo(0, 0);
    el.markView.querySelector('h2').focus({ preventScroll: true });
  }

  function closeMark(planId) {
    marking = null;
    closeSuggest();
    showView(false);
    var block = planId ? el.plans.querySelector('[data-plan="' + planId + '"]') : null;
    if (block) block.scrollIntoView({ block: 'start' });
  }

  /** Paint a time's three choices to show which one is picked. */
  function paint(group, picked) {
    Array.prototype.forEach.call(group.children, function (b) {
      var on = b.getAttribute('data-choice') === picked;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.className = on
        ? 'min-h-11 whitespace-nowrap rounded-md bg-accent px-2 text-small font-medium text-on-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus'
        : 'min-h-11 whitespace-nowrap rounded-md px-2 text-small font-medium text-fg hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
    });
  }

  function markRow(plan, slot) {
    var row = h('li', 'flex items-center gap-2 py-2 pl-3 pr-2');
    var label = h('div', 'flex min-w-0 flex-1 flex-col');
    label.appendChild(h('span', 'text-body font-medium break-words', dayText(slot)));
    label.appendChild(h('span', 'text-small text-muted', timeText(slot) + (slot.passed ? ', passed' : '')));
    row.appendChild(label);
    if (slot.canRemove) {
      var remove = h('button', 'btn-secondary shrink-0 border-0 bg-transparent px-0 text-muted');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Take ' + whenText(slot) + ' off the plan');
      remove.appendChild(icon(CROSS, 'h-4 w-4', 2));
      tapTwice(remove, 'Remove', function () {
        delete marking.draft[slot.id];
        api('DELETE', '/api/slots/' + slot.id)
          .then(function () { showStatus(null, el.markStatus); return load(); })
          .catch(function (err) { showStatus(err, el.markStatus); });
      });
      row.appendChild(remove);
    }
    var group = h('div', 'flex shrink-0 gap-0.5 rounded-lg border border-line bg-ground p-0.5');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', whenText(slot));
    CHOICES.forEach(function (c) {
      var b = h('button', null, c.label);
      b.type = 'button';
      b.setAttribute('data-choice', c.mark);
      b.addEventListener('click', function () {
        marking.draft[slot.id] = c.mark;
        paint(group, c.mark);
      });
      group.appendChild(b);
    });
    paint(group, marking.draft[slot.id] || null);
    row.appendChild(group);
    return row;
  }

  function renderMark() {
    var plan = marking && planById(marking.planId);
    if (!plan || !plan.open) {
      // Deleted, or its time was set, while you were here.
      if (marking) {
        closeMark();
        showStatus(new Error(plan ? 'The time for that plan has been set, so it is closed now.' : 'That plan is not here any more.'));
      }
      return;
    }
    el.markPlan.textContent = plan.name;
    el.markList.textContent = '';
    plan.slots.forEach(function (s) { el.markList.appendChild(markRow(plan, s)); });
    var full = plan.slots.length >= current.maxTimes;
    el.suggestOpen.hidden = full || !el.suggestForm.hidden;
    if (full) closeSuggest();
  }

  function closeSuggest() {
    el.suggestForm.reset();
    el.suggestForm.hidden = true;
    showStatus(null, el.suggestStatus);
    el.suggestOpen.hidden = false;
  }

  byId('mark-back').addEventListener('click', function () {
    var id = marking && marking.planId;
    closeMark(id);
  });

  el.markSave.addEventListener('click', function () {
    var plan = marking && planById(marking.planId);
    if (!plan) return;
    var marks = plan.slots
      .filter(function (s) { return marking.draft[s.id]; })
      .map(function (s) { return { slotId: s.id, mark: marking.draft[s.id] }; });
    if (!marks.length) {
      showStatus(new Error('Tap Free, If needed or Can\'t for at least one time.'), el.markStatus);
      return;
    }
    el.markSave.disabled = true;
    api('PUT', '/api/plans/' + plan.id + '/marks', { marks: marks })
      .then(function () {
        showStatus(null, el.markStatus);
        return load().then(function () { closeMark(plan.id); });
      })
      .catch(function (err) { showStatus(err, el.markStatus); })
      .then(function () { el.markSave.disabled = false; });
  });

  el.suggestOpen.addEventListener('click', function () {
    el.suggestOpen.hidden = true;
    el.suggestForm.hidden = false;
    el.suggestForm.elements.date.min = localDate(new Date(current.now));
    el.suggestForm.elements.date.focus();
  });
  byId('suggest-cancel').addEventListener('click', closeSuggest);
  el.suggestForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = el.suggestForm.elements;
    var time = timeFrom(f.date.value, f.time.value);
    if (!time || !marking) return;
    api('POST', '/api/plans/' + marking.planId + '/slots', time)
      .then(function () { closeSuggest(); return load(); })
      .catch(function (err) { showStatus(err, el.suggestStatus); });
  });

  // ── Starting a plan ────────────────────────────────────────────────────

  function timeRows() {
    return el.planTimes.querySelectorAll('[data-time-row]');
  }

  /** Remove buttons only while there are more than two rows; Another up to eight. */
  function tidyRows() {
    var rows = timeRows();
    Array.prototype.forEach.call(rows, function (row, i) {
      row.querySelector('button').hidden = rows.length <= 2;
      row.querySelector('input[type="date"]').setAttribute('aria-label', 'Day ' + (i + 1));
      row.querySelector('input[type="time"]').setAttribute('aria-label', 'Time ' + (i + 1) + ', if any');
    });
    el.planAddTime.hidden = rows.length >= START_MAX;
  }

  function addTimeRow() {
    var row = h('div', 'flex items-center gap-2');
    row.setAttribute('data-time-row', '');
    var date = h('input', 'field min-w-0 flex-1');
    date.type = 'date';
    date.name = 'date';
    if (current) date.min = localDate(new Date(current.now));
    row.appendChild(date);
    var time = h('input', 'field min-w-0 flex-1');
    time.type = 'time';
    time.name = 'time';
    row.appendChild(time);
    var remove = h('button', 'btn-secondary w-11 shrink-0 border-0 bg-transparent px-0 text-muted');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Take this time off');
    remove.appendChild(icon(CROSS, 'h-4 w-4', 2));
    remove.addEventListener('click', function () { row.remove(); tidyRows(); });
    row.appendChild(remove);
    el.planTimes.appendChild(row);
    tidyRows();
    return row;
  }

  function closePlanForm() {
    el.planForm.reset();
    el.planTimes.textContent = '';
    el.planForm.hidden = true;
    el.newPlan.hidden = false;
    showStatus(null, el.planStatus);
  }

  el.newPlan.addEventListener('click', function () {
    el.newPlan.hidden = true;
    el.planForm.hidden = false;
    if (!timeRows().length) { addTimeRow(); addTimeRow(); }
    el.planForm.elements.name.focus();
  });
  el.planAddTime.addEventListener('click', function () {
    addTimeRow().querySelector('input').focus();
  });
  byId('plan-cancel').addEventListener('click', closePlanForm);
  el.planForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = el.planForm.elements.name.value;
    if (!name.trim()) return;
    var times = [];
    Array.prototype.forEach.call(timeRows(), function (row) {
      var t = timeFrom(row.querySelector('input[type="date"]').value, row.querySelector('input[type="time"]').value);
      if (t) times.push(t);
    });
    if (times.length < 2) {
      showStatus(new Error('Suggest at least two times: a day each, and a time if you like.'), el.planStatus);
      return;
    }
    api('POST', '/api/plans', { name: name, times: times })
      .then(function (made) {
        closePlanForm();
        return load().then(function () {
          var block = el.plans.querySelector('[data-plan="' + made.id + '"]');
          if (block) block.scrollIntoView({ block: 'start', behavior: 'smooth' });
        });
      })
      .catch(function (err) { showStatus(err, el.planStatus); });
  });

  // ── Loading, empty, error ──────────────────────────────────────────────

  function show(state) {
    el.loading.hidden = state !== 'loading';
    el.error.hidden = state !== 'error';
    if (state !== 'ready') {
      el.empty.hidden = true;
      el.plans.hidden = true;
      el.pastSection.hidden = true;
    }
  }

  function render(data) {
    current = data;
    Object.keys(choosing).forEach(function (id) {
      var plan = planById(Number(id));
      if (!plan || !plan.open || !plan.mine) delete choosing[id];
    });
    el.plans.textContent = '';
    data.plans.forEach(function (p) { el.plans.appendChild(planBlock(p)); });
    el.plans.hidden = !data.plans.length;
    el.empty.hidden = !!data.plans.length;
    el.past.textContent = '';
    data.past.forEach(function (p) { el.past.appendChild(pastRow(p)); });
    el.pastSection.hidden = !data.past.length;
    show('ready');
    if (marking) renderMark();
  }

  var loaded = false;
  var loading = null;
  function load() {
    if (loading) return loading;
    loading = api('GET', '/api/plans')
      .then(function (data) { loaded = true; showStatus(null); render(data); })
      .catch(function (err) {
        // A refresh that fails keeps what is on screen; only a first load
        // with nothing to show turns into the error state.
        if (loaded) showStatus(err);
        else show('error');
      })
      .then(function () { loading = null; });
    return loading;
  }

  byId('retry').addEventListener('click', function () { show('loading'); load(); });

  // Other people mark their times too: look again every 20 seconds while
  // the app is on screen, and straight away when it comes back. Skipped
  // while you are marking, starting a plan or picking a time to set, so a
  // refresh never undoes what you are in the middle of.
  function busy() {
    return !!marking || !el.planForm.hidden || Object.keys(choosing).length > 0;
  }
  setInterval(function () {
    if (!document.hidden && !busy()) load();
  }, 20000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !busy()) load(); });

  load();
})();
