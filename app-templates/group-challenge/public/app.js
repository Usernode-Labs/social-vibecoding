// The group challenge screen. Talks to api.js; every request carries the
// platform token the frame was opened with, which is how the server knows
// who you are, and this device's time zone (?tz=), which decides what
// "today" and "this month" are.
//
// What the challenge counts (its unit, and whether amounts have decimals)
// is in the page: <main id="app" data-unit-plural data-unit-one
// data-decimals>, filled in when the project was made. This script holds
// none of it, so it is the same for every challenge.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it, so a note that says "<b>hi</b>" shows exactly that.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var params = new URLSearchParams(window.location.search);
  var token = params.get('token') || '';
  var root = document.getElementById('app');
  var PLURAL = root.getAttribute('data-unit-plural') || 'points';
  var ONE = root.getAttribute('data-unit-one') || 'point';
  var DECIMALS = root.getAttribute('data-decimals') === 'yes';
  // The month whose results card this device put away with "Start <month>".
  var SEEN_KEY = 'group-challenge:results-seen';

  var zone = 'UTC';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (err) { /* UTC, then. */ }

  var el = {
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    results: document.getElementById('results'),
    resultsTitle: document.getElementById('results-title'),
    resultsTotal: document.getElementById('results-total'),
    verdict: document.getElementById('results-verdict'),
    verdictText: document.getElementById('results-verdict-text'),
    check: document.getElementById('results-check'),
    podium: document.getElementById('podium'),
    mostDays: document.getElementById('most-days'),
    others: document.getElementById('results-others'),
    share: document.getElementById('share'),
    shareStatus: document.getElementById('share-status'),
    shareText: document.getElementById('share-text'),
    startMonth: document.getElementById('start-month'),
    startNote: document.getElementById('start-note'),
    back: document.getElementById('back'),
    thisMonth: document.getElementById('this-month'),
    goal: document.getElementById('goal'),
    goalTotal: document.getElementById('goal-total'),
    goalMonth: document.getElementById('goal-month'),
    goalBar: document.getElementById('goal-bar'),
    goalFill: document.getElementById('goal-fill'),
    pace: document.getElementById('pace'),
    goalNote: document.getElementById('goal-note'),
    changeGoal: document.getElementById('change-goal'),
    goalForm: document.getElementById('goal-form'),
    goalLabel: document.getElementById('goal-label'),
    goalAmount: document.getElementById('goal-amount'),
    goalHelp: document.getElementById('goal-help'),
    goalCancel: document.getElementById('goal-cancel'),
    goalReset: document.getElementById('goal-reset'),
    goalStatus: document.getElementById('goal-status'),
    logForm: document.getElementById('log-form'),
    amount: document.getElementById('log-amount'),
    day: document.getElementById('log-day'),
    note: document.getElementById('log-note'),
    logStatus: document.getElementById('log-status'),
    boardSection: document.getElementById('board-section'),
    boardLabel: document.getElementById('board-label'),
    leaderboard: document.getElementById('leaderboard'),
    empty: document.getElementById('empty'),
    notYet: document.getElementById('not-yet'),
    latelySection: document.getElementById('lately-section'),
    lately: document.getElementById('lately'),
    yoursSection: document.getElementById('yours-section'),
    yoursLabel: document.getElementById('yours-label'),
    yoursList: document.getElementById('yours-list'),
    pastSection: document.getElementById('past-section'),
    past: document.getElementById('past'),
  };

  var current = null; // the last month read
  var viewing = null; // a past month being looked at ("2026-09"), or null for this one
  var editingGoal = false;
  var shown = null; // the results on the card, for Share

  el.amount.setAttribute('inputmode', DECIMALS ? 'decimal' : 'numeric');
  el.goalAmount.setAttribute('inputmode', DECIMALS ? 'decimal' : 'numeric');

  function withZone(url) {
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'tz=' + encodeURIComponent(zone);
  }

  function api(method, url, body) {
    var headers = { 'x-usernode-token': token };
    // A preview opened at a chosen moment tells the server what time it is
    // there (req.now; "Time-dependent features" in the platform conventions).
    if (window.usernode && window.usernode.previewNow) headers['x-usernode-now'] = window.usernode.now().toISOString();
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(withZone(url), { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
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

  // ── Words and numbers ──────────────────────────────────────────────────
  //
  // Numbers in the viewer's own locale ("1,284" or "1.284"), and the unit
  // after them: "1 book", "2 books".

  function num(n, most, least) {
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: least || 0, maximumFractionDigits: most });
  }
  function unit(n) {
    return Number(n) === 1 ? ONE : PLURAL;
  }
  /** One entry: "5.25 miles". */
  function amountText(n) {
    return num(n, DECIMALS ? 2 : 0) + ' ' + unit(n);
  }
  /** A sum: "142.3 miles". */
  function sumText(n) {
    return num(n, DECIMALS ? 1 : 0) + ' ' + unit(n);
  }
  /** A sum on the leaderboard, every row alike: "31.0 miles". */
  function boardText(n) {
    return num(n, DECIMALS ? 1 : 0, DECIMALS ? 1 : 0) + ' ' + unit(n);
  }
  /** "the 200-mile goal". */
  function goalWords(n) {
    return 'the ' + num(n, DECIMALS ? 1 : 0) + '-' + ONE + ' goal';
  }

  var pad = function (n) { return (n < 10 ? '0' : '') + n; };

  function monthName(month, withYear) {
    var options = withYear ? { month: 'long', year: 'numeric', timeZone: 'UTC' } : { month: 'long', timeZone: 'UTC' };
    return new Date(month + '-01T00:00:00Z').toLocaleDateString(undefined, options);
  }
  /** A month's name, with its year when that is not this year. */
  function monthOf(month) {
    return monthName(month, !current || month.slice(0, 4) !== current.thisMonth.slice(0, 4));
  }

  function addDays(day, n) {
    var d = new Date(day + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  /** "Today", "Yesterday", or "Mon, Oct 13" in the viewer's own words. */
  function dayLabel(day) {
    var today = current.today;
    if (day === today) return 'Today';
    if (day === addDays(today, -1)) return 'Yesterday';
    return new Date(day + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  /** The calendar day a moment fell on here: "2026-10-13". */
  function ymd(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  /** When an entry was logged, the way people say it: "This morning". */
  function when(iso) {
    var at = new Date(iso);
    var now = new Date(current.now);
    var mins = Math.floor((now.getTime() - at.getTime()) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return mins + ' min ago';
    var days = Math.round((Date.parse(ymd(now) + 'T00:00:00Z') - Date.parse(ymd(at) + 'T00:00:00Z')) / 86400000);
    if (days <= 0) {
      var hour = at.getHours();
      return hour < 12 ? 'This morning' : (hour < 18 ? 'This afternoon' : 'This evening');
    }
    if (days === 1) return 'Yesterday';
    if (days < 7) return at.toLocaleDateString(undefined, { weekday: 'long' });
    return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  /** "you, ana and ben". */
  function names(people, you) {
    var list = people.map(function (p) { return p.me ? you : p.username; });
    if (list.length < 2) return list.join('');
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }

  // ── Status lines ───────────────────────────────────────────────────────

  function say(node, err) {
    node.textContent = err ? err.message : '';
    node.hidden = !err;
  }

  // ── A month that is over: the results card ─────────────────────────────

  function seenResults() {
    try { return localStorage.getItem(SEEN_KEY); } catch (err) { return null; }
  }

  function renderResults(data) {
    var r = data.results;
    var past = !data.current;
    var open = !!r && (past || seenResults() !== r.month);
    el.results.hidden = !open;
    if (!open) { shown = null; return; }
    if (!shown || shown.month !== r.month) {
      el.shareStatus.hidden = true;
      el.shareText.hidden = true;
    }
    shown = r;
    el.resultsTitle.textContent = monthOf(r.month) + ' is done';
    el.resultsTotal.textContent = sumText(r.total);
    el.verdictText.textContent = r.beaten
      ? 'Beat ' + goalWords(r.goal)
      : sumText(r.goal - r.total) + ' short of ' + goalWords(r.goal);
    el.verdict.className = r.beaten
      ? 'inline-flex items-center gap-1.5 text-small font-semibold text-accent'
      : 'inline-flex items-center gap-1.5 text-small font-semibold text-muted';
    if (r.beaten) el.check.removeAttribute('hidden');
    else el.check.setAttribute('hidden', '');

    var medals = [
      'flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-small font-bold text-on-accent',
      'flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-small font-bold text-fg',
      'flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-raised text-small font-bold text-muted',
    ];
    el.podium.textContent = '';
    r.top.forEach(function (p, i) {
      var row = h('li', 'flex min-h-11 items-center gap-3 py-2');
      row.appendChild(h('span', medals[i], String(p.rank)));
      row.appendChild(h('span', p.me ? 'min-w-0 flex-1 truncate text-body font-semibold' : 'min-w-0 flex-1 truncate text-body', p.me ? 'You' : p.username));
      row.appendChild(h('span', 'shrink-0 text-body font-semibold', boardText(p.total)));
      el.podium.appendChild(row);
    });

    var most = r.mostDays;
    el.mostDays.textContent = most
      ? 'Most days logged: ' + names(most.people, 'you') + ', ' + most.days + ' of ' + most.of
      : '';
    el.mostDays.hidden = !most;
    el.others.textContent = r.others.length
      ? 'Also: ' + r.others.map(function (p) { return (p.me ? 'you' : p.username) + ' ' + num(p.total, DECIMALS ? 1 : 0); }).join(' · ')
      : '';
    el.others.hidden = !r.others.length;

    // On a new month's first days, the way on is this month; looking back
    // at a past month, the way back is too.
    var now = monthName(data.thisMonth);
    el.startMonth.textContent = 'Start ' + now;
    el.startMonth.hidden = past;
    el.startNote.textContent = past ? '' : now + '’s goal is ' + sumText(data.goal.amount) + ', and everyone starts again at zero.';
    el.startNote.hidden = past;
    el.back.textContent = 'Back to ' + now;
    el.back.hidden = !past;
  }

  /** The results as a few lines anybody can read, wherever they are pasted. */
  function shareText(r) {
    var lines = [
      monthOf(r.month) + ' in ' + document.title + ': together we logged ' + sumText(r.total)
        + (r.beaten ? ' and beat ' : ' of ') + goalWords(r.goal) + '.',
    ];
    r.top.forEach(function (p) { lines.push(p.rank + '. ' + p.username + ', ' + boardText(p.total)); });
    if (r.mostDays) {
      lines.push('Most days logged: ' + r.mostDays.people.map(function (p) { return p.username; }).join(', ')
        + ' (' + r.mostDays.days + ' of ' + r.mostDays.of + ')');
    }
    return lines.join('\n');
  }

  function shareSaid(text, showText) {
    el.shareStatus.textContent = text;
    el.shareStatus.hidden = false;
    el.shareText.hidden = !showText;
  }

  function copyResults(text) {
    function fallback() {
      // No clipboard here (the frame may not allow it): the text, to select.
      el.shareText.textContent = text;
      shareSaid('Copying is not allowed here. Select the text below to copy it.', true);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        shareSaid('Copied the results. Paste them anywhere you like.', false);
      }, fallback);
    } else {
      fallback();
    }
  }

  el.share.addEventListener('click', function () {
    if (!shown) return;
    var text = shareText(shown);
    if (navigator.share) {
      navigator.share({ title: document.title, text: text }).then(function () {
        shareSaid('Shared.', false);
      }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        copyResults(text);
      });
    } else {
      copyResults(text);
    }
  });

  el.startMonth.addEventListener('click', function () {
    try { if (shown) localStorage.setItem(SEEN_KEY, shown.month); } catch (err) { /* It shows again next time. */ }
    el.results.hidden = true;
    el.amount.focus();
  });

  el.back.addEventListener('click', function () {
    viewing = null;
    show('loading');
    load();
    window.scrollTo(0, 0);
  });

  // ── This month: the goal ───────────────────────────────────────────────

  function paceText(data) {
    var left = data.daysLeft === 0 ? 'Last day of the month.'
      : (data.daysLeft === 1 ? '1 day left.' : data.daysLeft + ' days left.');
    if (!data.total) return left + ' Nothing logged yet this month.';
    if (data.beaten) return left + ' The goal is reached, so everything from here is extra.';
    var projected = data.pace.projected;
    var finish = ' At this pace the group finishes around ' + num(projected, DECIMALS && projected < 100 ? 1 : 0) + ' ' + unit(projected) + '.';
    if (projected >= data.goal.amount) return left + finish;
    var perDay = data.pace.perDay;
    return left + finish + ' Reaching ' + num(data.goal.amount, DECIMALS ? 1 : 0) + ' takes about '
      + (DECIMALS ? num(perDay, 1) : num(Math.ceil(perDay), 0)) + ' ' + unit(perDay) + ' a day from here.';
  }

  function renderGoal(data) {
    var goal = data.goal.amount;
    var month = monthName(data.month);
    el.goal.setAttribute('data-progress', String(data.progress));
    el.goalTotal.textContent = num(data.total, DECIMALS ? 1 : 0) + ' of ' + sumText(goal);
    el.goalMonth.textContent = month + ', together';
    el.goalBar.setAttribute('aria-valuemax', String(goal));
    el.goalBar.setAttribute('aria-valuenow', String(Math.min(data.total, goal)));
    el.goalBar.setAttribute('aria-valuetext', el.goalTotal.textContent);
    el.goalBar.setAttribute('aria-label', 'The group’s ' + PLURAL + ' in ' + month);
    el.goalFill.style.width = data.progress + '%';
    el.pace.textContent = paceText(data);
    var mine = data.me && data.goal.setBy === data.me.username;
    el.goalNote.textContent = data.goal.custom
      ? 'Changed by ' + (mine ? 'you' : data.goal.setBy) + ', for ' + month + ' only.'
      : 'The usual goal for a month.';

    el.goalForm.hidden = !editingGoal;
    el.changeGoal.hidden = editingGoal;
    el.goalLabel.textContent = month + '’s goal, in ' + PLURAL;
    el.goalHelp.textContent = 'For ' + month + ' only. Next month starts with the usual ' + sumText(data.defaultGoal) + '.';
    el.goalReset.textContent = 'Back to the usual ' + num(data.defaultGoal, DECIMALS ? 1 : 0);
    el.goalReset.hidden = !data.goal.custom;
  }

  el.changeGoal.addEventListener('click', function () {
    editingGoal = true;
    say(el.goalStatus, null);
    el.goalAmount.value = current ? String(current.goal.amount) : '';
    if (current) renderGoal(current);
    el.goalAmount.focus();
    el.goalAmount.select();
  });
  el.goalCancel.addEventListener('click', function () {
    editingGoal = false;
    if (current) renderGoal(current);
    el.changeGoal.focus();
  });
  function saveGoal(value) {
    api('PUT', '/api/goal', { goal: value }).then(function () {
      editingGoal = false;
      say(el.goalStatus, null);
      return load();
    }).catch(function (err) { say(el.goalStatus, err); });
  }
  el.goalForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var value = cleanAmount(el.goalAmount.value);
    if (!value) return;
    saveGoal(value);
  });
  el.goalReset.addEventListener('click', function () { saveGoal(null); });

  // ── This month: logging ────────────────────────────────────────────────

  /**
   * What was typed, as the plain number the server reads. Whole units read
   * "8,000" or "8.000" as eight thousand; units with decimals read a lone
   * comma as the decimal point ("3,1").
   */
  function cleanAmount(text) {
    var t = String(text).replace(/\s+/g, '');
    if (/^\d{1,3}([.,]\d{3})+$/.test(t) && !DECIMALS) return t.replace(/[.,]/g, '');
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return t.replace(/,/g, '');
    if (DECIMALS && /^\d*,\d+$/.test(t)) return t.replace(',', '.');
    return t;
  }

  /** Today back to the 1st: any day this month, up to today. */
  function renderDays(data) {
    if (document.activeElement === el.day) return;
    var chosen = el.day.value;
    var first = data.month + '-01';
    el.day.textContent = '';
    for (var day = data.today; day >= first; day = addDays(day, -1)) {
      var option = h('option', null, dayLabel(day));
      option.value = day;
      el.day.appendChild(option);
    }
    el.day.value = chosen && chosen <= data.today && chosen >= first ? chosen : data.today;
  }

  el.logForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var amount = cleanAmount(el.amount.value);
    if (!amount) return;
    api('POST', '/api/entries', { amount: amount, day: el.day.value || undefined, note: el.note.value })
      .then(function () {
        el.amount.value = '';
        el.note.value = '';
        el.day.value = current ? current.today : '';
        say(el.logStatus, null);
        return load();
      })
      .catch(function (err) { say(el.logStatus, err); });
  });

  // ── The leaderboard ────────────────────────────────────────────────────

  function personRow(p, top) {
    var row = h('li', p.me ? 'list-row gap-3 bg-raised py-2.5' : 'list-row gap-3 py-2.5');
    row.setAttribute('data-person', String(p.userId));
    row.appendChild(h('span', 'w-6 shrink-0 text-small font-semibold text-muted', String(p.rank)));
    var body = h('div', 'flex min-w-0 flex-1 flex-col gap-1');
    var line = h('div', 'flex items-baseline justify-between gap-2');
    line.appendChild(h('span', p.me ? 'min-w-0 truncate text-body font-semibold' : 'min-w-0 truncate text-body', p.me ? 'You' : p.username));
    var total = h('span', 'shrink-0 text-body font-semibold', boardText(p.total));
    total.setAttribute('data-total', String(p.total));
    line.appendChild(total);
    body.appendChild(line);
    var track = h('div', p.me ? 'h-1 overflow-hidden rounded-full bg-line' : 'h-1 overflow-hidden rounded-full bg-raised');
    var bar = h('div', p.me ? 'h-1 rounded-full bg-accent' : 'h-1 rounded-full bg-accent/40');
    bar.style.width = (top > 0 ? Math.max(2, Math.round((p.total / top) * 100)) : 0) + '%';
    track.appendChild(bar);
    track.setAttribute('aria-hidden', 'true');
    body.appendChild(track);
    row.appendChild(body);
    return row;
  }

  function renderBoard(data) {
    var people = data.leaderboard;
    el.boardLabel.textContent = data.current ? 'Leaderboard' : 'Everyone in ' + monthOf(data.month);
    el.leaderboard.textContent = '';
    var top = people.length ? people[0].total : 0;
    people.forEach(function (p) { el.leaderboard.appendChild(personRow(p, top)); });
    el.leaderboard.hidden = !people.length;
    el.empty.hidden = !!people.length || !data.current;

    var waiting = data.current && people.length && data.notYet ? data.notYet : [];
    el.notYet.textContent = waiting.length ? 'Not on the board yet: ' + names(waiting, 'you') + '.' : '';
    el.notYet.hidden = !waiting.length;
    el.boardSection.hidden = false;
  }

  // ── Lately, and your own entries ───────────────────────────────────────

  function removeButton(entry) {
    var button = h('button', 'btn-secondary shrink-0 border-0 bg-transparent px-2 text-small text-muted', 'Remove');
    button.type = 'button';
    button.setAttribute('aria-label', 'Remove ' + amountText(entry.amount) + ', ' + dayLabel(entry.day));
    tapTwice(button, 'Tap again to remove', function () {
      api('DELETE', '/api/entries/' + entry.id)
        .then(function () { say(el.logStatus, null); return load(); })
        .catch(function (err) { say(el.logStatus, err); });
    });
    return button;
  }

  function latelyRow(entry) {
    var row = h('li', 'list-row py-2');
    row.setAttribute('data-entry', String(entry.id));
    var text = h('div', 'flex min-w-0 flex-1 flex-col');
    var line = (entry.mine ? 'You' : entry.username) + ' logged ' + amountText(entry.amount);
    if (entry.day !== ymd(new Date(entry.at))) line += ' for ' + dayLabel(entry.day);
    text.appendChild(h('span', 'text-body break-words', line));
    if (entry.note) text.appendChild(h('span', 'text-small text-muted break-words', entry.note));
    row.appendChild(text);
    row.appendChild(h('span', 'shrink-0 text-small text-muted', when(entry.at)));
    if (entry.mine) row.appendChild(removeButton(entry));
    return row;
  }

  function yoursRow(entry) {
    var row = h('li', 'list-row py-2');
    row.setAttribute('data-entry', String(entry.id));
    var text = h('div', 'flex min-w-0 flex-1 flex-col');
    text.appendChild(h('span', 'text-body', amountText(entry.amount) + ', ' + dayLabel(entry.day)));
    if (entry.note) text.appendChild(h('span', 'text-small text-muted break-words', entry.note));
    row.appendChild(text);
    row.appendChild(removeButton(entry));
    return row;
  }

  function renderLately(data) {
    el.lately.textContent = '';
    data.lately.forEach(function (entry) { el.lately.appendChild(latelyRow(entry)); });
    el.latelySection.hidden = !data.current || !data.lately.length;

    el.yoursList.textContent = '';
    data.yours.forEach(function (entry) { el.yoursList.appendChild(yoursRow(entry)); });
    el.yoursLabel.textContent = data.yours.length === 1
      ? 'Your 1 entry this month'
      : 'Your ' + data.yours.length + ' entries this month';
    el.yoursSection.hidden = !data.current || !data.yours.length;
  }

  // ── Past months ────────────────────────────────────────────────────────

  function renderPast(data) {
    el.past.textContent = '';
    data.pastMonths.forEach(function (m) {
      var item = h('li', 'p-0');
      var button = h('button', 'list-row w-full text-left hover:bg-raised');
      button.type = 'button';
      button.setAttribute('data-month', m.month);
      if (m.month === data.month) button.setAttribute('aria-current', 'page');
      var text = h('span', 'flex min-w-0 flex-1 flex-col');
      text.appendChild(h('span', m.month === data.month ? 'text-body font-semibold' : 'text-body', monthOf(m.month)));
      text.appendChild(h('span', 'text-small text-muted',
        num(m.total, DECIMALS ? 1 : 0) + ' of ' + sumText(m.goal) + (m.beaten ? ' · Goal beaten' : '')));
      button.appendChild(text);
      var chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chevron.setAttribute('width', '16');
      chevron.setAttribute('height', '16');
      chevron.setAttribute('viewBox', '0 0 24 24');
      chevron.setAttribute('fill', 'none');
      chevron.setAttribute('stroke', 'currentColor');
      chevron.setAttribute('stroke-width', '2');
      chevron.setAttribute('stroke-linecap', 'round');
      chevron.setAttribute('stroke-linejoin', 'round');
      chevron.setAttribute('aria-hidden', 'true');
      chevron.setAttribute('class', 'shrink-0 text-muted');
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M9 6l6 6-6 6');
      chevron.appendChild(path);
      button.appendChild(chevron);
      button.addEventListener('click', function () {
        viewing = m.month;
        editingGoal = false;
        show('loading');
        load();
        window.scrollTo(0, 0);
      });
      item.appendChild(button);
      el.past.appendChild(item);
    });
    el.pastSection.hidden = !data.pastMonths.length;
  }

  // ── Loading, empty, error ──────────────────────────────────────────────

  function show(state) {
    el.loading.hidden = state !== 'loading';
    el.error.hidden = state !== 'error';
    if (state !== 'ready') {
      el.results.hidden = true;
      el.thisMonth.hidden = true;
      el.boardSection.hidden = true;
      el.latelySection.hidden = true;
      el.yoursSection.hidden = true;
      el.pastSection.hidden = true;
    }
  }

  function render(data) {
    current = data;
    if (!data.current) editingGoal = false;
    renderResults(data);
    el.thisMonth.hidden = !data.current;
    if (data.current) {
      renderGoal(data);
      renderDays(data);
    }
    renderBoard(data);
    renderLately(data);
    renderPast(data);
    show('ready');
  }

  var loaded = false;
  var loading = null;
  function load() {
    if (loading) return loading;
    loading = api('GET', '/api/challenge' + (viewing ? '?month=' + encodeURIComponent(viewing) : ''))
      .then(function (data) { loaded = true; render(data); })
      .catch(function (err) {
        // A refresh that fails keeps what is on screen; only a first load
        // with nothing to show turns into the error state.
        if (loaded && current && el.loading.hidden && !el.thisMonth.hidden) say(el.logStatus, err);
        else show('error');
      })
      .then(function () { loading = null; });
    return loading;
  }

  document.getElementById('retry').addEventListener('click', function () { show('loading'); load(); });

  // Everybody else logs too: look again every 30 seconds while the app is
  // on screen, and straight away when it comes back. Skipped while someone
  // is typing or changing the goal, so a refresh never interrupts them, and
  // while a past month is open, since a past month does not change.
  function quiet() {
    var active = document.activeElement;
    var typing = active && (active.tagName === 'INPUT' || active.tagName === 'SELECT') && active.value;
    return !document.hidden && !typing && !editingGoal && viewing === null;
  }
  setInterval(function () { if (quiet()) load(); }, 30000);
  document.addEventListener('visibilitychange', function () { if (quiet()) load(); });

  load();
})();
