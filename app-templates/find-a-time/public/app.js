// The find-a-time screen. Talks to api.js; every request carries the
// platform token the frame was opened with, which is how the server knows
// who you are.
//
// Two modes, chosen when the project was made (data-mode on <main>):
//
// - dates: two views, home (the open plans, each with its grid of who is
//   free when and the best time so far, then the past ones) and "When are
//   you free?", where you mark each of one plan's times Free, If needed or
//   Can't.
// - weekly: the week ("The week" below), one grid of the days and the
//   hours. Everyone's shades each hour by how many people can make it; on
//   Yours you tap the hours that work for you every week, or hold one and
//   drag across several. The best weekly hours are named above it.
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
  // The keyboard's Done key on the name closes the keyboard (the times are
  // still to fill in), rather than starting the plan half done.
  el.planForm.elements.name.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.target.blur();
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
  var again = false;
  function load() {
    // A read already on its way may have left before the change just made:
    // read once more when it is back.
    if (loading) { again = true; return loading; }
    loading = api('GET', '/api/plans')
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


  // ── The week (weekly mode) ─────────────────────────────────────────────
  //
  // An hour is "day-hour": the day of the week (0 Monday to 6 Sunday) and
  // the hour it starts, a wall-clock time for the group with no time zone
  // (api.js, "How an hour is stored"). Your own hours change here at once
  // and are saved a moment after you stop; the counts and the best hours
  // come back with the next read.

  var week = (function () {
    var w = {
      section: byId('week'),
      best: byId('week-best'),
      toggle: byId('week-toggle'),
      saved: byId('week-saved'),
      hint: byId('week-hint'),
      grid: byId('week-grid'),
      legend: byId('week-legend'),
      detail: byId('week-detail'),
      detailText: byId('week-detail-text'),
      waiting: byId('week-waiting'),
      status: byId('week-status'),
    };
    var HOLD_MS = 280;
    var SLOP_PX = 8;
    var SAVE_WAIT_MS = 350;
    var MONDAY = Date.UTC(2024, 0, 1);

    var data = null; // the last read
    var mine = {}; // "day-hour" -> true: your week as it is on screen
    var view = null; // 'group' (everyone's) or 'yours'
    var tapped = null; // the hour whose people show under the grid, on everyone's
    var paint = null; // a drag marking several hours: { anchor, to, add }
    var hold = null; // a finger resting on an hour, before it becomes a drag
    var swallowClick = false; // the click that ends a drag is not a tap
    var saveTimer = null;
    var saving = null;
    var saveAgain = false;

    var key = function (day, hour) { return day + '-' + hour; };
    var parts = function (k) { return k.split('-').map(Number); };

    /** "Mon", or "Monday" with style 'long', in the viewer's language. */
    function dayName(day, style) {
      return new Date(MONDAY + day * 864e5).toLocaleDateString(undefined, { weekday: style || 'short', timeZone: 'UTC' });
    }

    /** "7 PM" (or "19:00"). */
    function hourName(hour) {
      return new Date(2024, 0, 1, hour).toLocaleTimeString(undefined, HOUR12 ? { hour: 'numeric' } : { hour: '2-digit', minute: '2-digit' });
    }

    /** "Tuesdays at 7 PM". */
    function whenWords(k) {
      var p = parts(k);
      return dayName(p[0], 'long') + 's at ' + hourName(p[1]);
    }

    function meId() { return data && data.me ? data.me.id : null; }

    /** Who has answered, with your hours as they are on screen: you first. */
    function people() {
      var me = meId();
      var list = data.people.filter(function (p) { return p.id !== me; });
      if (me !== null && Object.keys(mine).length) list.unshift({ id: me, username: data.me.username, me: true });
      return list;
    }

    /** The ids of everyone who can make an hour, yours as on screen. */
    function freeAt(k) {
      var me = meId();
      var ids = (data.free[k] || []).filter(function (id) { return id !== me; });
      if (me !== null && mine[k]) ids.unshift(me);
      return ids;
    }

    function nameOfId(id) {
      if (id === meId()) return 'you';
      var p = data.people.filter(function (x) { return x.id === id; })[0];
      return '@' + (p ? p.username : '?');
    }

    /** "5 of 6 can make it", "All 4 can make it", "Nobody can make it yet". */
    function countWords(n, answered) {
      if (!n) return 'Nobody can make it yet';
      if (n === answered && answered > 1) return 'All ' + answered + ' can make it';
      return n + ' of ' + answered + ' can make it';
    }

    /** Can and can't for one hour: "Can: you and @ana. Can't: @ben." */
    function whoWords(k) {
      var can = freeAt(k);
      var cant = people().filter(function (p) { return can.indexOf(p.id) < 0; }).map(function (p) { return p.id; });
      var words = [];
      if (can.length) words.push('Can: ' + listWords(can.map(nameOfId)) + '.');
      if (cant.length) words.push('Can\'t: ' + listWords(cant.map(nameOfId)) + '.');
      return words.join(' ');
    }

    // The shading of an hour on everyone's, by the share of those who
    // answered that can make it. Whole class names, for the Tailwind build.
    function shade(n, answered) {
      if (!n || !answered) return '';
      var share = n / answered;
      if (share >= 1) return 'bg-accent text-on-accent';
      if (share > 0.75) return 'bg-accent/80 text-on-accent';
      if (share > 0.5) return 'bg-accent/60 text-fg';
      if (share > 0.25) return 'bg-accent/35 text-fg';
      return 'bg-accent/15 text-fg';
    }

    /** The hours from the drag's first to where the finger is now, as a block. */
    function inPaint(k) {
      if (!paint) return false;
      var a = parts(paint.anchor);
      var b = parts(paint.to);
      var p = parts(k);
      return p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])
        && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
    }

    /** One hour's cell, drawn for the view: shading and a count, or yours. */
    function drawCell(cell) {
      var k = cell.getAttribute('data-cell');
      var answered = people().length;
      var ids = freeAt(k);
      var best = data.best.length && key(data.best[0].day, data.best[0].hour) === k;
      cell.setAttribute('data-free', String(ids.length));
      cell.textContent = '';
      var base = 'relative h-10 min-w-0 border-l border-t border-line text-small font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus';
      if (view === 'yours') {
        var on = paint && inPaint(k) ? paint.add : !!mine[k];
        cell.setAttribute('aria-pressed', on ? 'true' : 'false');
        cell.className = base + (on ? ' bg-accent text-on-accent' : ' bg-surface');
        if (on) cell.appendChild(icon(CHECK, 'mx-auto h-4 w-4', 3));
        cell.setAttribute('aria-label', whenWords(k) + (on ? ': works for you' : ': does not work for you'));
        return;
      }
      cell.removeAttribute('aria-pressed');
      // The hour tapped is outlined; the best one, named above, more lightly.
      var ring = k === tapped ? ' ring-2 ring-inset ring-fg' : best ? ' ring-2 ring-inset ring-fg/40' : '';
      cell.className = base + ' ' + (shade(ids.length, answered) || 'bg-surface text-muted') + ring;
      if (ids.length) cell.appendChild(document.createTextNode(String(ids.length)));
      cell.setAttribute('aria-label', whenWords(k) + ': ' + countWords(ids.length, answered).toLowerCase());
    }

    function drawCells() {
      Array.prototype.forEach.call(w.grid.querySelectorAll('[data-cell]'), drawCell);
    }

    /** The grid's frame: the days across, the hours down, a cell for each. */
    function buildGrid() {
      w.grid.textContent = '';
      w.grid.appendChild(h('div', 'h-9'));
      for (var d = 0; d < data.days; d += 1) {
        var head = h('div', 'flex h-9 items-center justify-center border-l border-line text-small font-medium text-muted', dayName(d));
        head.setAttribute('aria-hidden', 'true');
        w.grid.appendChild(head);
      }
      for (var hour = data.firstHour; hour < data.lastHour; hour += 1) {
        var label = h('div', 'flex h-10 items-center justify-end whitespace-nowrap border-t border-line pr-1.5 text-small text-muted', hourName(hour));
        label.setAttribute('aria-hidden', 'true');
        w.grid.appendChild(label);
        for (var day = 0; day < data.days; day += 1) {
          var cell = h('button');
          cell.type = 'button';
          cell.setAttribute('data-cell', key(day, hour));
          w.grid.appendChild(cell);
        }
      }
    }

    /** The card at the top: the best weekly hour, and the next best. */
    function drawBest() {
      w.best.textContent = '';
      var answered = data.people.length;
      var best = data.best.map(function (b) { return key(b.day, b.hour); });
      if (!best.length) {
        w.best.removeAttribute('data-best');
        w.best.appendChild(h('p', 'text-heading', 'No answers yet'));
        w.best.appendChild(h('p', 'text-small text-muted', 'Mark the hours that work for you every week, and the best time shows here.'));
        return;
      }
      var counted = function (k) { return (data.free[k] || []).length; };
      w.best.setAttribute('data-best', best[0]);
      w.best.appendChild(h('p', 'text-small text-muted', 'Best weekly time'));
      w.best.appendChild(h('p', 'text-heading', whenWords(best[0])));
      var cant = data.people.filter(function (p) { return (data.free[best[0]] || []).indexOf(p.id) < 0; }).map(function (p) { return p.me ? 'you' : '@' + p.username; });
      w.best.appendChild(h('p', 'text-small text-muted', countWords(counted(best[0]), answered) + '.' + (cant.length ? ' Can\'t: ' + listWords(cant) + '.' : '')));
      if (best.length > 1) {
        var also = best.slice(1).map(function (k) { return whenWords(k) + ' (' + counted(k) + ' of ' + answered + ')'; });
        w.best.appendChild(h('p', 'text-small text-muted', 'Also good: ' + listWords(also) + '.'));
      }
    }

    /** Under the grid on everyone's: who can and can't make the hour tapped. */
    function drawDetail() {
      w.detailText.textContent = '';
      w.detail.hidden = view !== 'group' || !tapped;
      // Room below the grid for the card, so the last hours can scroll above it.
      w.section.classList.toggle('pb-40', !w.detail.hidden);
      if (w.detail.hidden) return;
      w.detailText.appendChild(h('p', 'text-heading', whenWords(tapped)));
      var answered = people().length;
      w.detailText.appendChild(h('p', 'text-small text-muted', answered ? countWords(freeAt(tapped).length, answered) + '. ' + whoWords(tapped) : 'Nobody has answered yet.'));
    }

    function drawLegend() {
      w.legend.textContent = '';
      w.legend.hidden = view !== 'group' || !data.people.length;
      if (w.legend.hidden) return;
      w.legend.appendChild(document.createTextNode('Fewer'));
      ['bg-accent/15', 'bg-accent/35', 'bg-accent/60', 'bg-accent/80', 'bg-accent'].forEach(function (c) {
        w.legend.appendChild(h('span', 'h-3 w-5 rounded-sm ' + c));
      });
      w.legend.appendChild(document.createTextNode('More people'));
    }

    function drawWaiting() {
      var line = null;
      if (data.waiting) {
        var names = data.waiting.filter(function (x) { return !(x.me && Object.keys(mine).length); })
          .map(function (x) { return x.me ? 'you' : '@' + x.username; });
        if (names.length) {
          var shown = names.length > 8 ? names.slice(0, 7).concat([(names.length - 7) + ' more']) : names;
          line = 'Still to answer: ' + listWords(shown) + '.';
        } else if (data.people.length) {
          line = 'Everyone has answered.';
        }
      }
      w.waiting.textContent = line || '';
      w.waiting.hidden = !line;
    }

    function drawToggle() {
      Array.prototype.forEach.call(w.toggle.querySelectorAll('[data-view]'), function (b) {
        var on = b.getAttribute('data-view') === view;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.className = on
          ? 'min-h-11 rounded-lg bg-accent px-4 text-body font-medium text-on-accent'
          : 'min-h-11 rounded-lg px-4 text-body font-medium text-muted hover:bg-raised';
      });
      w.hint.textContent = view === 'yours'
        ? 'Tap the hours that work for you every week. Hold one and drag to mark several.'
        : 'The deeper the colour, the more people can make it. Tap an hour to see who.';
      w.grid.setAttribute('aria-label', view === 'yours' ? 'Your week' : 'Everyone\'s week');
    }

    function draw() {
      drawToggle();
      drawBest();
      drawCells();
      drawLegend();
      drawDetail();
      drawWaiting();
    }

    function setView(next) {
      view = next;
      tapped = null;
      draw();
    }

    // ── Saving your hours ───────────────────────────────────────────────

    function save() {
      saveTimer = null;
      if (saving) { saveAgain = true; return; }
      var hours = Object.keys(mine).map(parts);
      w.saved.textContent = 'Saving';
      saving = api('PUT', '/api/week/mine', { hours: hours })
        .then(function () { w.saved.textContent = 'Saved'; showStatus(null, w.status); })
        .catch(function (err) { w.saved.textContent = ''; showStatus(err, w.status); })
        .then(function () {
          saving = null;
          if (saveAgain) { saveAgain = false; save(); } else { load(); }
        });
    }

    function changed() {
      drawCells();
      drawDetail();
      drawWaiting();
      w.saved.textContent = '';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, SAVE_WAIT_MS);
    }

    // ── Tapping, and holding to drag across several hours ──────────────

    function cellAt(x, y) {
      var target = document.elementFromPoint(x, y);
      var cell = target && target.closest ? target.closest('[data-cell]') : null;
      return cell && w.grid.contains(cell) ? cell.getAttribute('data-cell') : null;
    }

    function startPaint(k) {
      paint = { anchor: k, to: k, add: !mine[k] };
      swallowClick = true;
      drawCells();
    }

    function movePaint(k) {
      if (!paint || !k || k === paint.to) return;
      paint.to = k;
      drawCells();
    }

    function endPaint(commit) {
      if (!paint) return;
      if (commit) {
        Array.prototype.forEach.call(w.grid.querySelectorAll('[data-cell]'), function (cell) {
          var k = cell.getAttribute('data-cell');
          if (!inPaint(k)) return;
          if (paint.add) mine[k] = true; else delete mine[k];
        });
      }
      paint = null;
      if (commit) changed(); else drawCells();
      // The click that may follow the lift is the drag's, not a tap.
      setTimeout(function () { swallowClick = false; }, 400);
    }

    w.grid.addEventListener('click', function (e) {
      var cell = e.target.closest ? e.target.closest('[data-cell]') : null;
      if (!cell || !data) return;
      if (swallowClick) { swallowClick = false; return; }
      var k = cell.getAttribute('data-cell');
      if (view === 'yours') {
        if (mine[k]) delete mine[k]; else mine[k] = true;
        changed();
      } else {
        tapped = tapped === k ? null : k;
        drawCells();
        drawDetail();
      }
    });

    // A finger: resting on an hour for a moment turns it into a drag that
    // marks (or clears) the block of hours it crosses. Moving first is a
    // scroll, which is left to the page.
    w.grid.addEventListener('touchstart', function (e) {
      if (view !== 'yours' || e.touches.length !== 1) return;
      var t = e.touches[0];
      var k = cellAt(t.clientX, t.clientY);
      if (!k) return;
      hold = { x: t.clientX, y: t.clientY, timer: setTimeout(function () {
        hold = null;
        startPaint(k);
        if (navigator.vibrate) navigator.vibrate(8);
      }, HOLD_MS) };
    }, { passive: true });
    w.grid.addEventListener('touchmove', function (e) {
      var t = e.touches[0];
      if (paint) {
        e.preventDefault(); // the page stays put while you mark
        movePaint(cellAt(t.clientX, t.clientY));
        return;
      }
      if (hold && Math.hypot(t.clientX - hold.x, t.clientY - hold.y) > SLOP_PX) {
        clearTimeout(hold.timer);
        hold = null;
      }
    }, { passive: false });
    w.grid.addEventListener('touchend', function () {
      if (hold) { clearTimeout(hold.timer); hold = null; }
      endPaint(true);
    });
    w.grid.addEventListener('touchcancel', function () {
      if (hold) { clearTimeout(hold.timer); hold = null; }
      endPaint(false);
    });
    w.grid.addEventListener('contextmenu', function (e) { if (view === 'yours') e.preventDefault(); });

    // A mouse drags at once: press on an hour and move across others.
    w.grid.addEventListener('pointerdown', function (e) {
      if (view !== 'yours' || e.pointerType === 'touch' || e.button !== 0) return;
      var k = cellAt(e.clientX, e.clientY);
      if (!k) return;
      paint = { anchor: k, to: k, add: !mine[k], mouse: true };
    });
    document.addEventListener('pointermove', function (e) {
      if (!paint || !paint.mouse) return;
      var k = cellAt(e.clientX, e.clientY);
      if (k && k !== paint.anchor) swallowClick = true;
      movePaint(k);
    });
    document.addEventListener('pointerup', function () {
      if (!paint || !paint.mouse) return;
      // Pressed and let go on one hour: the click toggles it, as a tap does.
      if (paint.to === paint.anchor && !swallowClick) { paint = null; return; }
      endPaint(true);
    });

    Array.prototype.forEach.call(w.toggle.querySelectorAll('[data-view]'), function (b) {
      b.addEventListener('click', function () { setView(b.getAttribute('data-view')); });
    });
    byId('week-detail-close').addEventListener('click', function () {
      tapped = null;
      drawCells();
      drawDetail();
    });

    // ── Loading ─────────────────────────────────────────────────────────

    function render(next) {
      var first = !data;
      data = next;
      // Your hours from the server, unless you have changed them since.
      if (!saveTimer && !saving) {
        mine = {};
        var me = meId();
        Object.keys(data.free).forEach(function (k) { if (data.free[k].indexOf(me) >= 0) mine[k] = true; });
      }
      if (first) {
        buildGrid();
        // Yours first until you have answered, so marking is the first thing.
        view = Object.keys(mine).length || !data.me ? 'group' : 'yours';
      }
      draw();
      el.loading.hidden = true;
      el.error.hidden = true;
      w.section.hidden = false;
    }

    var loaded = false;
    var loading = null;
    var again = false;
    function load() {
      if (loading) { again = true; return loading; }
      loading = api('GET', '/api/week')
        .then(function (next) { loaded = true; showStatus(null); render(next); })
        .catch(function (err) {
          if (loaded) showStatus(err);
          else show('error');
        })
        .then(function () {
          loading = null;
          if (again) { again = false; return load(); }
        });
      return loading;
    }

    return {
      load: load,
      // Not mid-drag, and not while your own hours are on their way.
      quiet: function () { return !paint && !hold && !saveTimer && !saving; },
    };
  })();

  var weekly = byId('app').getAttribute('data-mode') === 'weekly';
  var refresh = weekly ? week.load : load;

  byId('retry').addEventListener('click', function () { show('loading'); refresh(); });

  // Other people mark their times too: whenever anybody changes something,
  // the plans are fetched again at once, and looked at every minute
  // regardless (public/live-updates.js). Not while you are marking,
  // starting a plan or picking a time to set: what changed then is fetched
  // the moment you are done, so a refresh never undoes what you are in the
  // middle of.
  function busy() {
    return !!marking || !el.planForm.hidden || Object.keys(choosing).length > 0;
  }
  if (window.LiveUpdates) window.LiveUpdates.watch({ refresh: refresh, quiet: function () { return weekly ? week.quiet() : !busy(); } });

  // The first screen, drawn: Homeroom keeps its opening cover up until then
  // (usernode.ready, the platform bridge), so the app appears in one step
  // rather than as loading shapes that then change. The cover lifts after a
  // few seconds regardless.
  var first = refresh();
  if (window.usernode && window.usernode.ready) window.usernode.ready(first);
  // Pulling the page down past its top reads everything again, with the
  // native kit's spinner: the pull stays in the app instead of dragging
  // Homeroom's header along.
  first.then(function () {
    if (window.unNative) window.unNative.attachPullToRefresh(window, refresh);
  });
})();
