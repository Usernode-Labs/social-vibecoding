// The group poll screen. Talks to api.js; every request carries the
// platform token the frame was opened with, which is how the server knows
// who you are.
//
// Two screens in one page: the polls (each open one with its options, votes
// and bars, then the decided ones with what won) and starting a new poll.
// What the polls are about was filled into index.html when the project was
// made; this script is the same for every topic and reads the option
// example from #open-polls.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it, so an option called "<b>hi</b>" shows exactly that.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';

  var el = {
    main: document.getElementById('main-view'),
    status: document.getElementById('status'),
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    empty: document.getElementById('empty'),
    open: document.getElementById('open-polls'),
    start: document.getElementById('start-poll'),
    decidedSection: document.getElementById('decided-section'),
    decided: document.getElementById('decided'),
    newView: document.getElementById('new-view'),
    back: document.getElementById('new-back'),
    form: document.getElementById('new-form'),
    question: document.getElementById('new-question'),
    options: document.getElementById('new-options'),
    more: document.getElementById('new-more'),
    mode: document.getElementById('new-mode'),
    modeNote: document.getElementById('mode-note'),
    closes: document.getElementById('new-closes'),
    closesNote: document.getElementById('closes-note'),
    secret: document.getElementById('new-secret'),
    secretTrack: document.getElementById('secret-track'),
    secretKnob: document.getElementById('secret-knob'),
    submit: document.getElementById('new-submit'),
    newStatus: document.getElementById('new-status'),
  };

  var OPTION_EXAMPLE = el.open.getAttribute('data-option-example') || '';
  var OPTIONS_MAX = 20;
  var MINUTE = 60 * 1000;
  var DAY = 24 * 60 * MINUTE;

  var current = null; // the last read of the polls
  var drafts = {}; // poll id -> what is typed in its "add an option" field
  var notes = {}; // poll id -> why the last thing done to it did not work
  var expanded = {}; // decided poll id -> its full result is showing
  var refocus = null; // the field to put the cursor back in after a redraw

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

  /** The time it is for this viewer: the platform's, when it says so. */
  function now() {
    return window.usernode && window.usernode.now ? window.usernode.now() : new Date();
  }

  /** A tiny element builder: h('p', 'text-small', 'Hello'). */
  function h(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  var SVG = 'http://www.w3.org/2000/svg';
  var CHECK = ['M5 12.5l4.5 4.5L19 7.5'];
  var CROSS = ['M6 6l12 12M18 6L6 18'];
  var DECIDED = ['M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0z', 'M8 12.5l2.8 2.8L16.5 9.5'];
  var NO_WINNER = ['M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0z', 'M8 12h8'];

  /** A line icon drawn as an SVG, in the text colour around it. */
  function icon(paths, className, width) {
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', width || '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className);
    paths.forEach(function (d) {
      var path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
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

  function showStatus(err, where) {
    var line = where || el.status;
    line.textContent = err ? err.message : '';
    line.hidden = !err;
  }

  /**
   * Something done to one poll: its note says why it did not work, and the
   * polls are read again either way (a poll that closed meanwhile moves to
   * Decided, which is the honest answer to a late vote).
   */
  function actOn(poll, promise) {
    return promise
      .then(function () { delete notes[poll.id]; })
      .catch(function (err) { notes[poll.id] = err.message; })
      .then(load);
  }

  // ── Words ──────────────────────────────────────────────────────────────

  function count(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  /** "you, @ana and @ben", you first, and "and 3 more" past a handful. */
  function people(names) {
    var me = current && current.me ? current.me.username : null;
    var mine = names.indexOf(me) >= 0;
    var list = names.filter(function (n) { return n !== me; }).map(function (n) { return '@' + n; });
    if (mine) list.unshift('you');
    if (list.length > 5) list = list.slice(0, 4).concat([(list.length - 4) + ' more']);
    if (list.length <= 1) return list.join('');
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function timeOf(at) {
    return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  /** "today", "tomorrow", "Fri" or "Oct 30", in the viewer's own time. */
  function dayOf(at, from) {
    var tomorrow = new Date(from.getTime());
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (sameDay(at, from)) return 'today';
    if (sameDay(at, tomorrow)) return 'tomorrow';
    if (at.getTime() - from.getTime() < 6 * DAY) return at.toLocaleDateString(undefined, { weekday: 'short' });
    return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function closesWords(poll, from) {
    if (!poll.closesAt) return poll.mine ? 'Open until you close it.' : 'Open until @' + poll.by + ' closes it.';
    var at = new Date(poll.closesAt);
    var minutes = Math.ceil((at.getTime() - from.getTime()) / MINUTE);
    if (minutes < 60) return 'Closes in ' + count(Math.max(1, minutes), 'minute', 'minutes') + '.';
    return 'Closes ' + dayOf(at, from) + ' at ' + timeOf(at) + '.';
  }

  function voteWords(option, tied) {
    var words = count(option.votes, 'vote', 'votes');
    if (option.leading) words += tied ? ' · tied' : ' · leading';
    return words;
  }

  function turnoutWords(poll) {
    var t = poll.turnout;
    if (t.of != null) {
      if (t.ofVoted === t.of) return 'Everyone has voted.';
      var line = t.ofVoted + ' of ' + t.of + ' ' + (t.ofVoted === 1 ? 'has' : 'have') + ' voted.';
      if (t.waitingOn && t.waitingOn.length) line += ' Still waiting on ' + people(t.waitingOn) + '.';
      return line;
    }
    if (!t.voted) return 'Nobody has voted yet.';
    return count(t.voted, 'person has', 'people have') + ' voted.';
  }

  /** What a decided poll chose: one option, or every option of a tie. */
  function winnerWords(winners) {
    if (winners.length === 1) return winners[0];
    return winners.slice(0, -1).join(', ') + ' and ' + winners[winners.length - 1] + ' (a tie)';
  }

  // ── An open poll ───────────────────────────────────────────────────────

  function topOf(poll) {
    return poll.options.reduce(function (most, o) { return Math.max(most, o.votes); }, 0);
  }

  /** A bar's length is its share of everyone who voted (or of the group). */
  function scaleOf(poll) {
    return Math.max(1, poll.turnout.voted, poll.turnout.of || 0, topOf(poll));
  }

  function bar(option, scale) {
    var track = h('div', 'h-1.5 overflow-hidden rounded-full bg-raised');
    var fill = h('div', option.leading ? 'h-1.5 rounded-full bg-accent' : 'h-1.5 rounded-full bg-accent/35');
    fill.style.width = Math.round((option.votes / scale) * 100) + '%';
    track.appendChild(fill);
    return track;
  }

  function optionRow(poll, option, scale, tied) {
    var single = poll.mode === 'single';
    var row = h('li', 'list-row gap-2 py-3 pl-1.5 pr-3');
    row.setAttribute('data-option', String(option.id));

    // Your vote: a box to tick, or a circle to pick.
    var vote = h('button', 'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus');
    vote.type = 'button';
    vote.setAttribute('role', single ? 'radio' : 'checkbox');
    vote.setAttribute('aria-checked', option.yours ? 'true' : 'false');
    vote.setAttribute('aria-label', (single ? 'Pick ' : 'Tick ') + option.label);
    var mark;
    if (single) {
      mark = h('span', option.yours
        ? 'flex h-6 w-6 items-center justify-center rounded-full bg-accent'
        : 'flex h-6 w-6 items-center justify-center rounded-full border-2 border-muted bg-surface');
      if (option.yours) mark.appendChild(h('span', 'h-2.5 w-2.5 rounded-full bg-on-accent'));
    } else {
      mark = h('span', option.yours
        ? 'flex h-6 w-6 items-center justify-center rounded-md bg-accent text-on-accent'
        : 'flex h-6 w-6 items-center justify-center rounded-md border-2 border-muted bg-surface');
      if (option.yours) mark.appendChild(icon(CHECK, 'h-4 w-4', '3.2'));
    }
    vote.appendChild(mark);
    vote.addEventListener('click', function () {
      vote.disabled = true;
      actOn(poll, api('PUT', '/api/options/' + option.id + '/vote', { on: !option.yours }));
    });
    row.appendChild(vote);

    var body = h('div', 'flex min-w-0 flex-1 flex-col gap-1.5');
    var line = h('div', 'flex items-baseline justify-between gap-2');
    line.appendChild(h('span', 'min-w-0 break-words text-body font-medium', option.label));
    var votes = h('span', option.leading ? 'shrink-0 text-small font-semibold text-accent' : 'shrink-0 text-small text-muted', voteWords(option, tied));
    votes.setAttribute('data-votes', String(option.votes));
    line.appendChild(votes);
    body.appendChild(line);
    body.appendChild(bar(option, scale));
    var by = option.mine ? 'Added by you' : 'Added by @' + option.by;
    if (option.voters && option.voters.length) by += ' · ' + (single ? 'picked by ' : 'ticked by ') + people(option.voters);
    body.appendChild(h('span', 'break-words text-small text-muted', by));
    row.appendChild(body);

    if (option.canRemove) {
      var remove = h('button', 'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Take ' + option.label + ' off the poll');
      remove.appendChild(icon(CROSS, 'h-4 w-4', '2'));
      tapTwice(remove, 'Tap again to remove', function () {
        actOn(poll, api('DELETE', '/api/options/' + option.id));
      });
      row.appendChild(remove);
    }
    return row;
  }

  function addForm(poll) {
    var form = h('form', 'flex gap-2');
    form.setAttribute('autocomplete', 'off');
    var id = 'add-option-' + poll.id;
    var label = h('label', 'sr-only', 'Add an option to ' + poll.question);
    label.htmlFor = id;
    form.appendChild(label);
    var input = h('input', 'field min-w-0 flex-1');
    input.id = id;
    input.type = 'text';
    input.maxLength = 80;
    input.placeholder = OPTION_EXAMPLE;
    input.value = drafts[poll.id] || '';
    input.addEventListener('input', function () { drafts[poll.id] = input.value; });
    form.appendChild(input);
    var add = h('button', 'btn-secondary shrink-0', 'Add');
    add.type = 'submit';
    form.appendChild(add);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!input.value.trim()) return;
      add.disabled = true;
      refocus = id;
      actOn(poll, api('POST', '/api/polls/' + poll.id + '/options', { label: input.value })
        .then(function () { delete drafts[poll.id]; }));
    });
    return form;
  }

  function pollCard(poll, from) {
    var card = h('section', 'flex flex-col gap-3');
    card.setAttribute('data-poll', String(poll.id));

    var head = h('div', 'flex flex-col gap-0.5 px-1');
    head.appendChild(h('p', 'text-small font-medium text-muted', poll.mine ? 'Open poll · you started it' : 'Open poll · started by @' + poll.by));
    head.appendChild(h('h2', 'break-words text-heading', poll.question));
    var how = poll.mode === 'single' ? 'Pick one; picking another moves your vote.' : 'Tick every option you\'d be happy with.';
    head.appendChild(h('p', 'text-small text-muted', how + ' ' + closesWords(poll, from) + (poll.secret ? ' Votes are secret.' : '')));
    card.appendChild(head);

    var scale = scaleOf(poll);
    var tied = poll.options.filter(function (o) { return o.leading; }).length > 1;
    var list = h('ul', 'list');
    list.setAttribute('aria-label', poll.question);
    poll.options.forEach(function (o) { list.appendChild(optionRow(poll, o, scale, tied)); });
    card.appendChild(list);

    card.appendChild(addForm(poll));
    var note = h('p', 'px-1 text-small text-danger');
    note.setAttribute('role', 'alert');
    showStatus(notes[poll.id] ? new Error(notes[poll.id]) : null, note);
    card.appendChild(note);
    card.appendChild(h('p', 'px-1 text-small text-muted', turnoutWords(poll)));

    if (poll.canClose || poll.canDelete) {
      var actions = h('div', 'flex flex-wrap items-center gap-2');
      if (poll.canClose) {
        var close = h('button', 'btn-secondary', 'Close the poll');
        close.type = 'button';
        tapTwice(close, 'Tap again to close it now', function () {
          actOn(poll, api('POST', '/api/polls/' + poll.id + '/close'));
        });
        actions.appendChild(close);
      }
      actions.appendChild(deleteButton(poll));
      card.appendChild(actions);
    }
    return card;
  }

  function deleteButton(poll) {
    var del = h('button', 'btn-secondary ml-auto border-0 bg-transparent px-2 text-danger', 'Delete poll');
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete the poll ' + poll.question);
    tapTwice(del, 'Tap again to delete it', function () {
      actOn(poll, api('DELETE', '/api/polls/' + poll.id));
    });
    return del;
  }

  // ── A decided poll ─────────────────────────────────────────────────────

  function decidedRow(poll) {
    var item = h('li', 'flex flex-col');
    item.setAttribute('data-poll', String(poll.id));
    var showing = !!expanded[poll.id];
    var won = poll.winners.length > 0;

    var head = h('button', 'list-row w-full text-left hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus');
    head.type = 'button';
    head.setAttribute('aria-expanded', showing ? 'true' : 'false');
    head.appendChild(icon(won ? DECIDED : NO_WINNER, won ? 'h-5 w-5 shrink-0 text-accent' : 'h-5 w-5 shrink-0 text-muted'));
    var text = h('span', 'flex min-w-0 flex-1 flex-col');
    var answer = h('span', won ? 'break-words text-body font-medium' : 'text-body font-medium text-muted', won ? winnerWords(poll.winners) : 'No votes');
    if (won) answer.setAttribute('data-winner', poll.winners.join(', '));
    text.appendChild(answer);
    text.appendChild(h('span', 'break-words text-small text-muted', poll.question));
    head.appendChild(text);
    var t = poll.turnout;
    head.appendChild(h('span', 'shrink-0 text-small text-muted', t.of != null ? t.ofVoted + ' of ' + t.of + ' voted' : t.voted + ' voted'));
    head.addEventListener('click', function () {
      expanded[poll.id] = !showing;
      render(current);
    });
    item.appendChild(head);
    if (showing) item.appendChild(result(poll));
    return item;
  }

  /** A decided poll's whole count, most votes first. */
  function result(poll) {
    var box = h('div', 'flex flex-col gap-3 px-4 pb-4');
    var scale = scaleOf(poll);
    var single = poll.mode === 'single';
    poll.options.slice().sort(function (a, b) { return b.votes - a.votes; }).forEach(function (o) {
      var row = h('div', 'flex flex-col gap-1');
      var line = h('div', 'flex items-baseline justify-between gap-2');
      line.appendChild(h('span', 'min-w-0 break-words text-body', o.label));
      line.appendChild(h('span', o.leading ? 'shrink-0 text-small font-semibold text-accent' : 'shrink-0 text-small text-muted', count(o.votes, 'vote', 'votes')));
      row.appendChild(line);
      row.appendChild(bar(o, scale));
      if (o.voters && o.voters.length) row.appendChild(h('span', 'break-words text-small text-muted', (single ? 'Picked by ' : 'Ticked by ') + people(o.voters)));
      box.appendChild(row);
    });
    var closed = new Date(poll.decidedAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    var about = 'Closed ' + closed + ' · ' + (poll.mine ? 'you started it' : 'started by @' + poll.by);
    if (poll.secret) about += ' · secret votes';
    var foot = h('div', 'flex flex-wrap items-center gap-2');
    foot.appendChild(h('p', 'min-w-0 flex-1 text-small text-muted', about));
    if (poll.canDelete) foot.appendChild(deleteButton(poll));
    box.appendChild(foot);
    var note = h('p', 'text-small text-danger');
    note.setAttribute('role', 'alert');
    showStatus(notes[poll.id] ? new Error(notes[poll.id]) : null, note);
    box.appendChild(note);
    return box;
  }

  // ── Loading, empty, error ──────────────────────────────────────────────

  function show(state) {
    el.loading.hidden = state !== 'loading';
    el.error.hidden = state !== 'error';
    if (state !== 'ready') {
      el.open.hidden = true;
      el.empty.hidden = true;
      el.decidedSection.hidden = true;
    }
  }

  function render(data) {
    current = data;
    var from = new Date(data.now);
    var shown = {};

    el.open.textContent = '';
    data.open.forEach(function (p) { shown[p.id] = true; el.open.appendChild(pollCard(p, from)); });
    el.open.hidden = !data.open.length;
    el.empty.hidden = !!data.open.length;
    el.start.className = data.open.length ? 'btn-secondary w-full' : 'btn-primary w-full';

    el.decided.textContent = '';
    data.decided.forEach(function (p) { shown[p.id] = true; el.decided.appendChild(decidedRow(p)); });
    el.decidedSection.hidden = !data.decided.length;

    // A note about a poll that is no longer here (deleted meanwhile) shows
    // at the top, once.
    var orphans = Object.keys(notes).filter(function (id) { return !shown[id]; });
    if (orphans.length) {
      showStatus(new Error(notes[orphans[0]]));
      orphans.forEach(function (id) { delete notes[id]; });
    }
    show('ready');

    if (refocus) {
      var field = document.getElementById(refocus);
      refocus = null;
      if (field) field.focus();
    }
  }

  var loaded = false;
  var loading = null;
  var again = false;
  function load() {
    // A read already on its way may have left before the change just made:
    // read once more when it is back.
    if (loading) { again = true; return loading; }
    loading = api('GET', '/api/polls')
      .then(function (data) { loaded = true; render(data); })
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

  // ── Starting a poll ────────────────────────────────────────────────────

  var choice = { mode: 'approval', closes: 'tomorrow', secret: false };

  /** When a poll started now closes, by the starter's own clock; null: when they close it. */
  function closingTime(kind, from) {
    var at = new Date(from.getTime());
    at.setSeconds(0, 0);
    if (kind === 'hour') return new Date(at.getTime() + 60 * MINUTE);
    if (kind === 'tonight') {
      at.setHours(21, 0, 0, 0);
      if (at.getTime() <= from.getTime()) at.setDate(at.getDate() + 1);
      return at;
    }
    if (kind === 'tomorrow') {
      at.setDate(at.getDate() + 1);
      return at;
    }
    return null;
  }

  function closingWords(kind, from) {
    var at = closingTime(kind, from);
    if (!at) return 'It stays open until you close it.';
    if (kind === 'hour') return 'Closes in an hour, at ' + timeOf(at) + '.';
    if (kind === 'tonight') return 'Closes ' + (sameDay(at, from) ? 'tonight' : 'tomorrow night') + ' at ' + timeOf(at) + '.';
    return 'Closes tomorrow at ' + timeOf(at) + '.';
  }

  var MODE_NOTES = {
    approval: 'Everyone ticks every option they\'d be happy with. Most ticks wins, so nobody gets stuck with their last choice.',
    single: 'Everyone picks one. Picking another moves their vote, and the most picks wins.',
  };

  function paintChoices(group, attr, value) {
    Array.prototype.forEach.call(group.querySelectorAll('[' + attr + ']'), function (b) {
      var on = b.getAttribute(attr) === value;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.className = on
        ? 'min-h-11 flex-1 rounded-lg bg-accent px-2 text-body font-medium text-on-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus'
        : 'min-h-11 flex-1 rounded-lg px-2 text-body font-medium text-muted hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
    });
  }

  function paintForm() {
    paintChoices(el.mode, 'data-mode', choice.mode);
    paintChoices(el.closes, 'data-closes', choice.closes);
    el.modeNote.textContent = MODE_NOTES[choice.mode];
    el.closesNote.textContent = closingWords(choice.closes, now());
    el.secret.setAttribute('aria-checked', choice.secret ? 'true' : 'false');
    el.secretTrack.className = choice.secret
      ? 'relative h-7 w-12 rounded-full bg-accent transition-colors'
      : 'relative h-7 w-12 rounded-full bg-line transition-colors';
    el.secretKnob.className = choice.secret
      ? 'absolute left-0.5 top-0.5 h-6 w-6 translate-x-5 rounded-full bg-on-accent shadow transition-transform'
      : 'absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-surface shadow transition-transform';
  }

  function optionFields() {
    return Array.prototype.slice.call(el.options.querySelectorAll('input'));
  }

  function resetForm() {
    el.form.reset();
    optionFields().slice(3).forEach(function (field) { el.options.removeChild(field); });
    el.more.hidden = false;
    choice = { mode: 'approval', closes: 'tomorrow', secret: false };
    showStatus(null, el.newStatus);
    paintForm();
  }

  function openNew() {
    paintForm();
    el.main.hidden = true;
    el.newView.hidden = false;
    window.scrollTo(0, 0);
    el.question.focus();
  }

  function closeNew() {
    el.newView.hidden = true;
    el.main.hidden = false;
    el.start.focus();
  }

  el.start.addEventListener('click', openNew);
  el.back.addEventListener('click', closeNew);

  el.mode.addEventListener('click', function (e) {
    var b = e.target.closest('[data-mode]');
    if (!b) return;
    choice.mode = b.getAttribute('data-mode');
    paintForm();
  });
  el.closes.addEventListener('click', function (e) {
    var b = e.target.closest('[data-closes]');
    if (!b) return;
    choice.closes = b.getAttribute('data-closes');
    paintForm();
  });
  el.secret.addEventListener('click', function () {
    choice.secret = !choice.secret;
    paintForm();
  });

  el.more.addEventListener('click', function () {
    var n = optionFields().length;
    if (n >= OPTIONS_MAX) return;
    var field = h('input', 'field');
    field.type = 'text';
    field.name = 'option';
    field.maxLength = 80;
    field.setAttribute('aria-label', 'Option ' + (n + 1));
    el.options.appendChild(field);
    el.more.hidden = n + 1 >= OPTIONS_MAX;
    field.focus();
  });

  el.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var question = el.question.value.trim();
    var options = optionFields().map(function (f) { return f.value; }).filter(function (v) { return v.trim(); });
    if (!question) return showStatus(new Error('Say what the group is deciding.'), el.newStatus);
    if (options.length < 2) return showStatus(new Error('Give the poll at least two options.'), el.newStatus);
    var closesAt = closingTime(choice.closes, now());
    el.submit.disabled = true;
    api('POST', '/api/polls', {
      question: question,
      options: options,
      mode: choice.mode,
      closesAt: closesAt ? closesAt.toISOString() : null,
      secret: choice.secret,
    })
      .then(function () {
        resetForm();
        closeNew();
        showStatus(null);
        window.scrollTo(0, 0);
        return load();
      })
      .catch(function (err) { showStatus(err, el.newStatus); })
      .then(function () { el.submit.disabled = false; });
  });

  document.getElementById('retry').addEventListener('click', function () { show('loading'); load(); });

  // Other people vote and add options too: whenever anybody changes
  // something, the polls are fetched again at once, and looked at every
  // minute regardless (public/live-updates.js), so a poll whose closing time
  // passes moves to Decided within the minute. Not while someone is typing
  // or starting a poll: what changed then is fetched the moment they are
  // done, so a refresh never interrupts them.
  function quiet() {
    var a = document.activeElement;
    var typing = a && a.tagName === 'INPUT' && a.type === 'text' && a.value;
    return !typing && el.newView.hidden;
  }
  if (window.LiveUpdates) window.LiveUpdates.watch({ refresh: load, quiet: quiet });

  paintForm();
  // The first screen, drawn: Homeroom keeps its opening cover up until then
  // (usernode.ready, the platform bridge), so the app appears in one step
  // rather than as loading shapes that then change. The cover lifts after a
  // few seconds regardless.
  var first = load();
  if (window.usernode && window.usernode.ready) window.usernode.ready(first);
})();
