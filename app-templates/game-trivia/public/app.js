// The trivia game's screen. The game room (public/game/room.js) keeps it up
// to date over a live connection; this draws the room's view: the lobby,
// the question being asked with its clock, the answer with who picked what,
// the scores and the results. Below the game is the question bank: write
// questions about yourself and see how many everyone else wrote.
//
// Every answer goes to the server, whose rules (game/rules.js) score it;
// the right answer never reaches the page before it shows.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it. Class names are whole literals so the Tailwind
// build can see them.

(function () {
  var el = {
    connection: document.getElementById('connection'),
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    game: document.getElementById('game'),
    ask: document.getElementById('ask'),
    askCount: document.getElementById('ask-count'),
    askAbout: document.getElementById('ask-about'),
    timer: document.getElementById('timer'),
    askText: document.getElementById('ask-text'),
    options: document.getElementById('options'),
    askNote: document.getElementById('ask-note'),
    over: document.getElementById('over'),
    overLine: document.getElementById('over-line'),
    standings: document.getElementById('standings'),
    again: document.getElementById('again'),
    scoresSection: document.getElementById('scores-section'),
    scores: document.getElementById('scores'),
    players: document.getElementById('players'),
    empty: document.getElementById('empty'),
    lobbyNote: document.getElementById('lobby-note'),
    lobbyActions: document.getElementById('lobby-actions'),
    join: document.getElementById('join'),
    start: document.getElementById('start'),
    leave: document.getElementById('leave'),
    bankLine: document.getElementById('bank-line'),
    form: document.getElementById('question-form'),
    mine: document.getElementById('mine'),
    leadersSection: document.getElementById('leaders-section'),
    leaders: document.getElementById('leaders'),
    toast: document.getElementById('toast'),
    toastText: document.getElementById('toast-text'),
  };

  var view = null;
  var bank = null;
  var clockOffset = 0; // the server's clock minus this device's

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

  var toastTimer = null;
  function toast(message) {
    el.toastText.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 3200);
  }

  function isMe(id) { return !!(view && view.you && view.you.id === Number(id)); }
  function who(id, username) { return isMe(id) ? 'You' : '@' + username; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /**
   * A tap that cannot be undone asks for a second one. window.confirm() is
   * no use here: Homeroom's app frame does not allow dialogs, so it returns
   * false without showing anything.
   */
  function tapTwice(btn, armedLabel, action) {
    var timer = null;
    var resting = null;
    btn.addEventListener('click', function () {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        btn.textContent = resting;
        action();
        return;
      }
      resting = btn.textContent;
      btn.textContent = armedLabel;
      timer = setTimeout(function () { timer = null; btn.textContent = resting; }, 4000);
    });
  }

  // ── The question ──────────────────────────────────────────────────────

  function drawAsk() {
    var g = view.game;
    var on = view.phase === 'playing' && g && !g.done;
    el.ask.hidden = !on;
    if (!on) return;
    var q = g.question;
    var mine = isMe(q.authorId);
    var revealing = g.stage === 'reveal';
    el.askCount.textContent = 'Question ' + g.number + ' of ' + g.of;
    el.askAbout.textContent = mine ? 'About you' : 'About @' + q.author;
    el.askText.textContent = q.text;
    el.options.textContent = '';
    var joined = view.you && view.you.joined;
    q.options.forEach(function (text, i) {
      var cls = 'flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border px-4 py-2 text-left text-body';
      if (revealing && i === q.correct) cls += ' border-accent bg-accent text-on-accent';
      else if (revealing && g.yours === i) cls += ' border-danger bg-surface text-danger';
      else if (g.yours === i) cls += ' border-accent bg-surface';
      else cls += ' border-line bg-surface hover:bg-raised';
      var b = button(cls, null, function () { view.game.yours = i; drawAsk(); room.act({ type: 'answer', choice: i }); });
      b.setAttribute('data-option', String(i));
      b.disabled = revealing || mine || !joined || g.yours != null;
      b.appendChild(h('span', 'min-w-0 break-words', text));
      if (revealing && g.picks) {
        var by = Object.keys(g.picks).filter(function (id) { return g.picks[id] === i; })
          .map(function (id) { return isMe(id) ? 'you' : '@' + (g.scores[id] ? g.scores[id].username : '?'); });
        if (by.length) b.appendChild(h('span', 'shrink-0 text-small opacity-80', by.join(', ')));
      }
      el.options.appendChild(b);
    });
    var note = '';
    if (revealing) {
      var mineNow = view.you && g.points ? g.points[view.you.id] : null;
      if (mine) note = mineNow ? 'They know you: +' + mineNow + ' for you.' : 'Nobody knew this one about you.';
      else if (mineNow) note = 'Right! +' + mineNow + '.';
      else if (g.yours != null) note = 'Not quite.';
      else note = 'The answer is showing.';
    } else if (mine) {
      note = 'This one is about you: watch them guess.';
    } else if (!joined) {
      note = view.you ? 'Join the game to answer.' : 'Make an account to play.';
    } else if (g.yours != null) {
      note = 'Answered. ' + plural(g.answered.length, 'person has', 'people have') + ' answered so far.';
    } else {
      note = plural(g.answered.length, 'person has', 'people have') + ' answered.';
    }
    el.askNote.textContent = note;
  }

  // The clock runs down on this device between views.
  function tickTimer() {
    var g = view && view.game;
    if (view && view.phase === 'playing' && g && !g.done) {
      var left = Math.max(0, g.deadline - (Date.now() + clockOffset));
      el.timer.style.width = (100 * left / g.askMs).toFixed(1) + '%';
    }
    requestAnimationFrame(tickTimer);
  }

  function drawScores() {
    var g = view.game;
    var on = view.phase === 'playing' && g;
    el.scoresSection.hidden = !on;
    if (!on) return;
    var rows = Object.keys(g.scores).map(function (id) { return { id: Number(id), username: g.scores[id].username, score: g.scores[id].score }; })
      .sort(function (a, b) { return b.score - a.score; });
    el.scores.textContent = '';
    rows.forEach(function (r) {
      var li = h('li', 'list-row py-2');
      li.setAttribute('data-score', String(r.id));
      li.appendChild(h('span', 'min-w-0 flex-1 truncate text-body', who(r.id, r.username)));
      var gained = g.points && g.points[r.id];
      if (gained) li.appendChild(h('span', 'text-small font-medium text-accent', '+' + gained));
      li.appendChild(h('span', 'w-14 text-right text-body font-medium', String(r.score)));
      el.scores.appendChild(li);
    });
  }

  function drawOver() {
    var done = view.phase === 'over' && view.results;
    el.over.hidden = !done;
    if (!done) return;
    var top = view.results.filter(function (r) { return r.place === 1; });
    el.overLine.textContent = top.length > 1
      ? 'A tie: ' + top.map(function (r) { return who(r.id, r.username); }).join(' and ') + '!'
      : (isMe(top[0].id) ? 'You know everyone best!' : '@' + top[0].username + ' knows everyone best!');
    el.standings.textContent = '';
    view.results.forEach(function (r) {
      var li = h('li', 'list-row py-2');
      li.appendChild(h('span', 'w-6 text-small text-muted', String(r.place)));
      li.appendChild(h('span', 'min-w-0 flex-1 truncate text-body', who(r.id, r.username)));
      li.appendChild(h('span', 'text-body font-medium', String(r.score)));
      el.standings.appendChild(li);
    });
  }

  function drawPlayers() {
    el.players.textContent = '';
    view.players.forEach(function (p) {
      var li = h('li', 'list-row py-2');
      li.setAttribute('data-player', String(p.id));
      li.appendChild(h('span', 'min-w-0 flex-1 truncate text-body', who(p.id, p.username)));
      if (!p.here) li.appendChild(h('span', 'text-small text-muted', 'away'));
      el.players.appendChild(li);
    });
    el.empty.hidden = !!view.players.length;
    el.players.hidden = !view.players.length;
    var you = view.you;
    var joined = you && you.joined;
    var lobby = view.phase === 'lobby';
    var playing = view.phase === 'playing';
    // Trivia lets people join a game that is already on.
    el.lobbyActions.hidden = !(lobby || (playing && !joined));
    el.join.hidden = !!joined;
    el.leave.hidden = !joined || !lobby;
    el.start.hidden = !joined || !lobby;
    if (!you) el.lobbyNote.textContent = 'Make an account to play.';
    else if (playing && !joined) el.lobbyNote.textContent = 'A game is on: join to answer the rest of it.';
    else if (lobby) el.lobbyNote.textContent = joined ? 'Anyone who joined can start. A game asks up to eight questions.' : 'Join to play in the next game.';
    else el.lobbyNote.textContent = '';
    el.lobbyNote.hidden = !el.lobbyNote.textContent;
  }

  function drawLeaders() {
    el.leadersSection.hidden = !view.leaders.length;
    el.leaders.textContent = '';
    view.leaders.forEach(function (l) {
      var li = h('li', 'list-row py-2');
      li.setAttribute('data-leader', '');
      li.appendChild(h('span', 'min-w-0 flex-1 truncate text-body', '@' + l.username));
      li.appendChild(h('span', 'text-small text-muted', plural(l.wins, 'win', 'wins') + ' · best ' + l.best));
      el.leaders.appendChild(li);
    });
  }

  // ── The question bank ─────────────────────────────────────────────────

  function drawBank() {
    if (!bank) return;
    var others = bank.authors.filter(function (a) { return !view || !view.you || a.author !== view.you.username; });
    var total = bank.authors.reduce(function (n, a) { return n + a.count; }, 0);
    el.bankLine.textContent = total
      ? plural(total, 'question', 'questions') + ' so far, about ' + plural(bank.authors.length, 'person', 'people') +
        (others.length ? ': ' + others.slice(0, 4).map(function (a) { return '@' + a.author; }).join(', ') + (others.length > 4 ? ' and more' : '') : '') + '.'
      : 'No questions yet. Write the first one about yourself.';
    el.form.hidden = !(view && view.you);
    el.mine.hidden = !bank.mine.length;
    el.mine.textContent = '';
    bank.mine.forEach(function (q) {
      var li = h('li', 'list-row items-start py-3');
      li.setAttribute('data-question', String(q.id));
      var text = h('div', 'flex min-w-0 flex-1 flex-col gap-0.5');
      text.appendChild(h('span', 'break-words text-body', q.text));
      text.appendChild(h('span', 'break-words text-small text-muted', q.answer + ' (right) · ' + q.wrong.join(' · ')));
      li.appendChild(text);
      var del = button('btn-secondary shrink-0 whitespace-nowrap border-0 bg-transparent px-2 text-small text-muted', 'Delete');
      del.setAttribute('aria-label', 'Delete "' + q.text + '"');
      tapTwice(del, 'Tap again', function () {
        GameRoom.api('DELETE', '/api/questions/' + q.id).then(loadBank, function (err) { toast(err.message); loadBank(); });
      });
      li.appendChild(del);
      el.mine.appendChild(li);
    });
  }

  function loadBank() {
    return GameRoom.api('GET', '/api/questions').then(function (b) { bank = b; drawBank(); }, function () {});
  }

  el.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = el.form.elements;
    var wrong = [f.wrong1.value, f.wrong2.value, f.wrong3.value].filter(function (w) { return w.trim(); });
    GameRoom.api('POST', '/api/questions', { text: f.text.value, answer: f.answer.value, wrong: wrong }).then(function () {
      el.form.reset();
      toast('Added. It may come up in the next game.');
      loadBank();
    }, function (err) { toast(err.message); });
  });

  function render(next) {
    view = next;
    clockOffset = view.now - Date.now();
    el.loading.hidden = true;
    el.error.hidden = true;
    el.game.hidden = false;
    drawAsk();
    drawScores();
    drawOver();
    drawPlayers();
    drawLeaders();
    drawBank();
  }

  var room = window.GameRoom.connect({
    onView: render,
    onError: toast,
    onStatus: function (status) {
      el.connection.hidden = status !== 'offline';
      el.connection.textContent = 'Reconnecting…';
    },
    onFailed: function () {
      if (view) return;
      el.loading.hidden = true;
      el.error.hidden = false;
    },
  });

  el.join.addEventListener('click', function () { room.join(); });
  el.leave.addEventListener('click', function () { room.leave(); });
  el.start.addEventListener('click', function () { room.start(); });
  el.again.addEventListener('click', function () { room.again(); });
  document.getElementById('retry').addEventListener('click', function () { window.location.reload(); });
  loadBank();
  requestAnimationFrame(tickTimer);
})();
