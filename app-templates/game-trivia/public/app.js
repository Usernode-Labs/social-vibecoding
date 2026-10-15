// The trivia game's screen: a game show on three screens.
//
// - The title screen: the show's name in lights, the contestants (the
//   lobby: join, start), the way to writing questions, and the leaderboard.
// - Writing questions: your own questions about yourself, with their
//   answers, and the form to add one. Nobody else sees your answers.
// - The show, filling the screen: the question, the clock, four answer
//   tiles, and everyone's score along the bottom; then who picked what,
//   and at the end who knows everyone best.
//
// The game room (public/game/room.js) keeps it up to date over a live
// connection. Every answer goes to the server, whose rules (game/rules.js)
// score it; the right answer never reaches the page before it shows.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it. Class names are whole literals so the Tailwind
// build can see them.

(function () {
  function $(id) { return document.getElementById(id); }
  var el = {
    title: $('title'),
    loading: $('loading'),
    error: $('error'),
    lobbyBody: $('lobby-body'),
    lobbyTitle: $('lobby-title'),
    lobbyNote: $('lobby-note'),
    players: $('players'),
    empty: $('empty'),
    join: $('join'),
    start: $('start'),
    resume: $('resume'),
    watch: $('watch'),
    leave: $('leave'),
    toWrite: $('to-write'),
    bankLine: $('bank-line'),
    leadersSection: $('leaders-section'),
    leaders: $('leaders'),
    builder: $('builder'),
    builderBack: $('builder-back'),
    mineCount: $('mine-count'),
    form: $('question-form'),
    builderGuest: $('builder-guest'),
    mine: $('mine'),
    mineEmpty: $('mine-empty'),
    bankAll: $('bank-all'),
    stage: $('stage'),
    toTitle: $('to-title'),
    askCount: $('ask-count'),
    timer: $('timer'),
    timerText: $('timer-text'),
    askAbout: $('ask-about'),
    askText: $('ask-text'),
    askNote: $('ask-note'),
    joinIn: $('join-in'),
    options: $('options'),
    scores: $('scores'),
    over: $('over'),
    overLine: $('over-line'),
    standings: $('standings'),
    again: $('again'),
    overTitle: $('over-title'),
    connection: $('connection'),
    toast: $('toast'),
    toastText: $('toast-text'),
  };

  // The four tiles: a quiz show's colours and shapes, by position.
  var TILES = [
    { cls: 'tile tile-red', shape: '▲', name: 'triangle' },
    { cls: 'tile tile-blue', shape: '◆', name: 'diamond' },
    { cls: 'tile tile-yellow', shape: '●', name: 'circle' },
    { cls: 'tile tile-green', shape: '■', name: 'square' },
  ];
  var FACES = ['face face-red', 'face face-blue', 'face face-yellow', 'face face-green'];
  var FACES_SMALL = ['face face-small face-red', 'face face-small face-blue', 'face face-small face-yellow', 'face face-small face-green'];
  var CLOCK = 97.4; // the clock's circumference, in its SVG units

  var view = null;
  var bank = null;
  var screen = 'title';
  var leftGameNo = null;
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
  // Everyone keeps the same colour all show long: by their id.
  function face(id, username, small) {
    var list = small ? FACES_SMALL : FACES;
    var f = h('span', list[Math.abs(Number(id)) % list.length], (username || '?').charAt(0).toUpperCase());
    f.setAttribute('aria-hidden', 'true');
    return f;
  }

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

  // ── The show ──────────────────────────────────────────────────────────

  function drawAsk() {
    var g = view.game;
    if (!g || view.phase === 'lobby') return;
    var q = g.question;
    var mine = isMe(q.authorId);
    var revealing = g.stage === 'reveal' || g.done;
    var joined = !!(view.you && view.you.joined);
    el.askCount.textContent = 'Question ' + g.number + ' of ' + g.of;
    el.askAbout.textContent = mine ? 'About you' : 'About @' + q.author;
    el.askText.textContent = q.text;
    el.options.textContent = '';
    q.options.forEach(function (text, i) {
      var t = TILES[i % TILES.length];
      var cls = t.cls;
      if (revealing) cls += i === q.correct ? ' tile-right' : ' tile-dim';
      if (g.yours === i) cls += ' tile-chosen';
      var b = button(cls, null, function () {
        view.game.yours = i;
        drawAsk();
        room.act({ type: 'answer', choice: i });
      });
      b.setAttribute('data-option', String(i));
      b.setAttribute('aria-label', t.name + ': ' + text + (revealing && i === q.correct ? ' (the answer)' : ''));
      b.disabled = revealing || mine || !joined || g.yours != null;
      b.appendChild(h('span', 'tile-shape', revealing && i === q.correct ? '✓' : t.shape));
      b.appendChild(h('span', 'tile-text', text));
      if (revealing && g.picks) {
        var picks = h('span', 'tile-picks');
        Object.keys(g.picks).forEach(function (id) {
          if (g.picks[id] === i) picks.appendChild(face(id, g.scores[id] ? g.scores[id].username : '?', true));
        });
        if (picks.childNodes.length) b.appendChild(picks);
      }
      el.options.appendChild(b);
    });

    var note = '';
    el.askNote.className = 'ask-note';
    if (revealing) {
      var gained = view.you && g.points ? g.points[view.you.id] : null;
      if (gained) {
        el.askNote.className = 'ask-note gain';
        note = '+' + gained;
      } else if (mine) note = 'Nobody knew this one about you.';
      else if (g.yours != null) note = 'Not quite.';
      else note = 'Here is the answer.';
    } else if (mine) {
      note = 'This one is about you. Watch them guess!';
    } else if (!joined) {
      note = view.you ? 'You are watching.' : 'Make an account to play.';
    } else if (g.yours != null) {
      note = 'Locked in. ' + plural(g.answered.length, 'answer', 'answers') + ' so far.';
    } else {
      note = 'Pick an answer, quickly: a quick right answer scores more.';
    }
    el.askNote.textContent = note;
    el.joinIn.hidden = joined || !view.you || view.phase !== 'playing';
  }

  // The clock runs down on this device between views.
  function tickClock() {
    var g = view && view.game;
    if (screen === 'stage' && g && view.phase === 'playing' && !g.done) {
      var left = Math.max(0, g.deadline - (Date.now() + clockOffset));
      var part = Math.min(1, left / g.askMs);
      el.timer.setAttribute('stroke-dashoffset', String((CLOCK * (1 - part)).toFixed(2)));
      el.timer.style.color = g.stage === 'asking' && left < 5000 ? '#e2364b' : '#ffd166';
      el.timerText.textContent = String(Math.ceil(left / 1000));
    }
    requestAnimationFrame(tickClock);
  }

  function drawScores() {
    var g = view.game;
    el.scores.textContent = '';
    if (!g) return;
    Object.keys(g.scores)
      .map(function (id) { return { id: Number(id), username: g.scores[id].username, score: g.scores[id].score }; })
      .sort(function (a, b) { return b.score - a.score; })
      .forEach(function (r) {
        var li = h('li', 'score');
        li.setAttribute('data-score', String(r.id));
        li.appendChild(face(r.id, r.username, true));
        li.appendChild(h('span', '', who(r.id, r.username)));
        li.appendChild(h('span', '', String(r.score)));
        var gained = g.points && g.points[r.id];
        if (gained) li.appendChild(h('span', 'score-gain', '+' + gained));
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
      var li = h('li', 'rank');
      li.appendChild(h('span', 'rank-place', String(r.place)));
      li.appendChild(face(r.id, r.username, true));
      li.appendChild(h('span', 'min-w-0 flex-1 truncate font-bold', who(r.id, r.username)));
      li.appendChild(h('span', 'font-bold', String(r.score)));
      el.standings.appendChild(li);
    });
  }

  // ── The title screen ──────────────────────────────────────────────────

  function drawLobby() {
    var you = view.you;
    var joined = !!(you && you.joined);
    var lobby = view.phase === 'lobby';
    var on = view.phase === 'playing';
    el.players.textContent = '';
    view.players.forEach(function (p) {
      var li = h('li', p.here ? 'contestant' : 'contestant contestant-away');
      li.setAttribute('data-player', String(p.id));
      li.appendChild(face(p.id, p.username));
      li.appendChild(h('span', 'contestant-name', who(p.id, p.username)));
      el.players.appendChild(li);
    });
    el.empty.hidden = !!view.players.length;
    el.players.hidden = !view.players.length;
    el.lobbyTitle.textContent = lobby ? 'Contestants' : on ? 'The show is on' : 'The show is over';
    // Trivia lets people join a show that is already on.
    el.join.hidden = joined || view.phase === 'over';
    el.start.hidden = !joined || !lobby;
    el.resume.hidden = !joined || !on;
    el.watch.hidden = !(on || view.phase === 'over') || (joined && on);
    el.watch.textContent = on ? 'Watch' : 'See the results';
    el.leave.hidden = !joined || view.phase === 'over';
    var note = '';
    if (!you) note = 'Make an account to play. You can watch the show.';
    else if (lobby) note = joined ? 'Anyone who joined can start. A show asks up to eight questions.' : 'Join, then start the show when everyone is here.';
    else if (on) note = joined ? 'You are in it.' : 'Join in: you can answer the rest of it.';
    else if (view.results) note = (isMe(view.results[0].id) ? 'You' : '@' + view.results[0].username) + ' won the last show.';
    el.lobbyNote.textContent = note;
    el.lobbyNote.hidden = !note;
  }

  function drawLeaders() {
    el.leadersSection.hidden = !view.leaders.length;
    el.leaders.textContent = '';
    view.leaders.forEach(function (l, i) {
      var li = h('li', 'rank');
      li.setAttribute('data-leader', '');
      li.appendChild(h('span', 'rank-place', String(i + 1)));
      li.appendChild(h('span', 'min-w-0 flex-1 truncate font-bold', '@' + l.username));
      li.appendChild(h('span', 'card-note', plural(l.wins, 'win', 'wins') + ', best ' + l.best));
      el.leaders.appendChild(li);
    });
  }

  // ── Writing questions ─────────────────────────────────────────────────

  function drawBank() {
    if (!bank) return;
    var total = bank.authors.reduce(function (n, a) { return n + a.count; }, 0);
    var yours = bank.mine.length;
    el.bankLine.textContent = yours
      ? 'You have written ' + plural(yours, 'question', 'questions') + '. ' + plural(total, 'question', 'questions') + ' in the show so far.'
      : total
        ? plural(total, 'question', 'questions') + ' in the show so far. Write some about yourself.'
        : 'No questions yet. Write the first ones, about yourself.';
    el.mineCount.textContent = yours + ' of ' + bank.perPerson;
    var signedIn = !!(view && view.you);
    el.form.hidden = !signedIn;
    el.builderGuest.hidden = signedIn;
    el.mineEmpty.hidden = !!yours || !signedIn;
    el.mine.textContent = '';
    bank.mine.forEach(function (q) {
      var li = h('li', 'q-card');
      li.setAttribute('data-question', String(q.id));
      var body = h('div', 'min-w-0 flex-1');
      body.appendChild(h('p', 'font-bold', q.text));
      var answers = h('div', 'q-answers');
      answers.appendChild(h('span', 'q-answer q-answer-right', '✓ ' + q.answer));
      q.wrong.forEach(function (w) { answers.appendChild(h('span', 'q-answer', w)); });
      body.appendChild(answers);
      li.appendChild(body);
      var del = button('btn-soft min-h-11 shrink-0 px-3 text-small', 'Delete');
      del.setAttribute('aria-label', 'Delete "' + q.text + '"');
      tapTwice(del, 'Tap again', function () {
        GameRoom.api('DELETE', '/api/questions/' + q.id).then(loadBank, function (err) { toast(err.message); loadBank(); });
      });
      li.appendChild(del);
      el.mine.appendChild(li);
    });
    var others = bank.authors.filter(function (a) { return !view || !view.you || a.author !== view.you.username; });
    el.bankAll.textContent = others.length
      ? 'Also in the show: questions about ' + others.slice(0, 5).map(function (a) { return '@' + a.author; }).join(', ') + (others.length > 5 ? ' and more' : '') + '.'
      : '';
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
      toast('Added. It may come up in the next show.');
      loadBank();
    }, function (err) { toast(err.message); });
  });

  // ── Which screen ──────────────────────────────────────────────────────

  function show(next) {
    screen = next;
    el.title.hidden = screen !== 'title';
    el.builder.hidden = screen !== 'builder';
    el.stage.hidden = screen !== 'stage';
    if (screen === 'builder') loadBank();
  }

  // A player goes on stage when the show starts (unless they stepped out
  // of it), and the lobby brings the stage back to the title screen.
  function chooseScreen() {
    var joined = !!(view.you && view.you.joined);
    if (view.phase === 'lobby' && screen === 'stage') show('title');
    else if (view.phase === 'playing' && joined && leftGameNo !== view.gameNo && screen !== 'builder') show('stage');
  }

  function render(next) {
    view = next;
    clockOffset = view.now - Date.now();
    el.loading.hidden = true;
    el.error.hidden = true;
    el.lobbyBody.hidden = false;
    chooseScreen();
    drawAsk();
    drawScores();
    drawOver();
    drawLobby();
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

  el.join.addEventListener('click', function () { leftGameNo = null; room.join(); });
  el.joinIn.addEventListener('click', function () { leftGameNo = null; room.join(); });
  el.start.addEventListener('click', function () { leftGameNo = null; room.start(); });
  el.leave.addEventListener('click', function () { room.leave(); show('title'); });
  el.resume.addEventListener('click', function () { leftGameNo = null; show('stage'); });
  el.watch.addEventListener('click', function () { show('stage'); render(view); });
  el.toTitle.addEventListener('click', function () {
    if (view && view.phase === 'playing') leftGameNo = view.gameNo;
    show('title');
  });
  el.toWrite.addEventListener('click', function () { show('builder'); });
  el.builderBack.addEventListener('click', function () { show('title'); });
  el.again.addEventListener('click', function () { leftGameNo = null; room.again(); show('title'); });
  el.overTitle.addEventListener('click', function () { show('title'); });
  $('retry').addEventListener('click', function () { window.location.reload(); });
  loadBank();
  requestAnimationFrame(tickClock);
})();
