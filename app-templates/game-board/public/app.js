// The board game's screen. The game room (public/game/room.js) keeps it up
// to date over a live connection; this draws the room's view: the lobby,
// the board with everyone's piece, whose turn it is and the die, and the
// results. Every move goes to the server, whose rules (game/rules.js)
// decide what happens; this page only shows it, stepping a piece square by
// square so a roll can be followed.
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
    turn: document.getElementById('turn'),
    die: document.getElementById('die'),
    turnLine: document.getElementById('turn-line'),
    turnNote: document.getElementById('turn-note'),
    roll: document.getElementById('roll'),
    over: document.getElementById('over'),
    overLine: document.getElementById('over-line'),
    standings: document.getElementById('standings'),
    again: document.getElementById('again'),
    startArea: document.getElementById('start-area'),
    board: document.getElementById('board'),
    logSection: document.getElementById('log-section'),
    log: document.getElementById('log'),
    players: document.getElementById('players'),
    empty: document.getElementById('empty'),
    lobbyNote: document.getElementById('lobby-note'),
    lobbyActions: document.getElementById('lobby-actions'),
    join: document.getElementById('join'),
    start: document.getElementById('start'),
    leave: document.getElementById('leave'),
    leadersSection: document.getElementById('leaders-section'),
    leaders: document.getElementById('leaders'),
    toast: document.getElementById('toast'),
    toastText: document.getElementById('toast-text'),
  };

  // Each seat's piece colour: the board's own palette, the same in both
  // looks (a game's pieces are part of its scene).
  var PIECE_COLOURS = ['#2563eb', '#db2777', '#16a34a', '#ea580c', '#7c3aed', '#0891b2'];
  var STEP_MS = 140;

  var view = null;
  // Where each piece is drawn, which trails the game while a move is shown.
  var shown = {};
  var animatedRoll = 0;
  var stepping = null;
  var rolling = false;

  function h(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  var toastTimer = null;
  function toast(message) {
    el.toastText.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 3200);
  }

  function who(id, username) {
    return view && view.you && view.you.id === id ? 'You' : '@' + username;
  }

  function piece(id, username, seat, size) {
    var dot = h('span', size === 'small'
      ? 'flex h-4 w-4 items-center justify-center rounded-full text-[0.6rem] font-bold leading-none text-white ring-2 ring-surface'
      : 'flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold leading-none text-white ring-2 ring-surface',
    username.charAt(0).toUpperCase());
    dot.style.backgroundColor = PIECE_COLOURS[seat % PIECE_COLOURS.length];
    dot.setAttribute('data-piece', String(id));
    dot.title = '@' + username;
    return dot;
  }

  // ── The board ─────────────────────────────────────────────────────────

  // Squares run 1..N in a zigzag from the bottom left, six to a row.
  function squareOrder(n) {
    var rows = [];
    for (var r = 0; r * 6 < n; r++) {
      var row = [];
      for (var c = 0; c < 6; c++) row.push(r * 6 + c + 1);
      if (r % 2 === 1) row.reverse();
      rows.push(row);
    }
    return rows.reverse();
  }

  function drawBoard() {
    var g = view.game;
    var squares = g ? g.squares : 30;
    var shortcuts = g ? g.shortcuts : { 4: 12, 9: 18, 16: 24, 20: 27 };
    var slides = g ? g.slides : { 13: 6, 19: 11, 26: 17, 28: 22 };
    var at = {};
    if (g) {
      g.order.forEach(function (id) {
        var pos = shown[id] != null ? shown[id] : g.pieces[id].pos;
        (at[pos] = at[pos] || []).push(id);
      });
    }
    el.board.textContent = '';
    squareOrder(squares).forEach(function (row) {
      row.forEach(function (n) {
        var cls = 'relative flex aspect-square min-w-0 flex-col justify-between rounded-lg border p-1';
        if (n === squares) cls += ' border-accent bg-accent text-on-accent';
        else if (shortcuts[n]) cls += ' border-accent bg-surface';
        else if (slides[n]) cls += ' border-danger bg-surface';
        else cls += ' border-line bg-surface';
        var sq = h('div', cls);
        sq.setAttribute('data-square', String(n));
        var top = h('div', 'flex items-start justify-between gap-0.5');
        top.appendChild(h('span', n === squares ? 'text-small font-bold' : 'text-small text-muted', n === squares ? 'Finish' : String(n)));
        if (shortcuts[n]) top.appendChild(h('span', 'text-small font-bold text-accent', '↗' + shortcuts[n]));
        else if (slides[n]) top.appendChild(h('span', 'text-small font-bold text-danger', '↘' + slides[n]));
        sq.appendChild(top);
        var here = h('div', 'flex flex-wrap gap-0.5');
        (at[n] || []).forEach(function (id) {
          here.appendChild(piece(id, g.pieces[id].username, g.pieces[id].seat, (at[n] || []).length > 2 ? 'small' : null));
        });
        sq.appendChild(here);
        el.board.appendChild(sq);
      });
    });
    // Pieces still at the start, off the board.
    var waiting = g ? (at[0] || []) : [];
    while (el.startArea.childNodes.length > 1) el.startArea.removeChild(el.startArea.lastChild);
    waiting.forEach(function (id) { el.startArea.appendChild(piece(id, g.pieces[id].username, g.pieces[id].seat)); });
    el.startArea.hidden = !waiting.length;
  }

  // A new roll: the die tumbles, then the piece steps to where it landed and
  // takes any shortcut or slide.
  function showMove(move) {
    clearInterval(stepping);
    rolling = true;
    var ticks = 0;
    stepping = setInterval(function () {
      ticks += 1;
      if (ticks < 5) {
        el.die.textContent = String(1 + Math.floor(Math.random() * 6));
        return;
      }
      el.die.textContent = String(move.die);
      var pos = shown[move.id] != null ? shown[move.id] : move.from;
      if (pos < move.landed) shown[move.id] = pos + 1;
      else if (pos !== move.to) shown[move.id] = move.to;
      else {
        clearInterval(stepping);
        stepping = null;
        rolling = false;
        delete shown[move.id];
      }
      drawBoard();
      drawTurn();
    }, STEP_MS);
  }

  // ── Panels ────────────────────────────────────────────────────────────

  function drawTurn() {
    var g = view.game;
    var playing = view.phase === 'playing' && g;
    el.turn.hidden = !playing;
    if (!playing) return;
    if (!rolling) el.die.textContent = g.lastMove ? String(g.lastMove.die) : '?';
    var id = g.order[g.turn % g.order.length];
    var mine = view.you && view.you.id === id;
    var player = view.players.filter(function (p) { return p.id === id; })[0];
    el.turnLine.textContent = mine ? 'Your turn' : who(id, g.pieces[id].username) + '\'s turn';
    el.turnNote.textContent = mine ? 'Roll the die.' : (player && !player.here ? 'Away, so their roll is made for them.' : 'Waiting for them to roll.');
    el.roll.hidden = !mine;
    el.roll.disabled = rolling;
  }

  function drawOver() {
    var done = view.phase === 'over' && view.results;
    el.over.hidden = !done;
    if (!done) return;
    var winner = view.results[0];
    el.overLine.textContent = (view.you && view.you.id === winner.id ? 'You won' : '@' + winner.username + ' won') + '!';
    el.standings.textContent = '';
    view.results.forEach(function (r) {
      var li = h('li', 'list-row py-2');
      li.appendChild(h('span', 'w-6 text-small text-muted', String(r.place)));
      li.appendChild(h('span', 'min-w-0 flex-1 truncate text-body', who(r.id, r.username)));
      li.appendChild(h('span', 'text-small text-muted', r.score >= (view.game ? view.game.squares : 30) ? 'Finished' : 'Square ' + r.score));
      el.standings.appendChild(li);
    });
  }

  function drawLog() {
    var g = view.game;
    var lines = g && view.phase !== 'lobby' ? g.log : [];
    el.logSection.hidden = !lines.length;
    el.log.textContent = '';
    lines.forEach(function (entry) { el.log.appendChild(h('li', 'list-row py-2 text-small', entry.text)); });
  }

  function drawPlayers() {
    var g = view.game;
    el.players.textContent = '';
    view.players.forEach(function (p, seat) {
      var li = h('li', 'list-row py-2');
      li.setAttribute('data-player', String(p.id));
      var s = g && g.pieces[p.id] ? g.pieces[p.id].seat : seat;
      li.appendChild(piece(p.id, p.username, s));
      li.appendChild(h('span', 'min-w-0 flex-1 truncate text-body', who(p.id, p.username)));
      var where = g && g.pieces[p.id] && view.phase !== 'lobby'
        ? (g.pieces[p.id].pos ? 'Square ' + g.pieces[p.id].pos : 'At the start')
        : '';
      li.appendChild(h('span', 'text-small text-muted', [where, p.here ? '' : 'away'].filter(Boolean).join(' · ')));
      el.players.appendChild(li);
    });
    el.empty.hidden = !!view.players.length;
    el.players.hidden = !view.players.length;

    var you = view.you;
    var joined = you && you.joined;
    var lobby = view.phase === 'lobby';
    el.lobbyActions.hidden = !lobby;
    el.join.hidden = !!joined;
    el.leave.hidden = !joined;
    el.start.hidden = !joined;
    el.start.disabled = view.players.length < view.rules.minPlayers;
    if (!you) el.lobbyNote.textContent = 'Make an account to play.';
    else if (view.phase === 'playing') el.lobbyNote.textContent = joined ? '' : 'A game is on. You can join the next one.';
    else if (lobby) el.lobbyNote.textContent = joined ? 'Anyone who joined can start. Players who are away have their rolls made for them.' : 'Join to play in the next game.';
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
      li.appendChild(h('span', 'text-small text-muted', l.wins + (l.wins === 1 ? ' win' : ' wins') + ' of ' + l.played));
      el.leaders.appendChild(li);
    });
  }

  function render(next) {
    var before = view;
    view = next;
    el.loading.hidden = true;
    el.error.hidden = true;
    el.game.hidden = false;
    var g = view.game;
    // A roll this page has not shown yet.
    if (g && g.lastMove && g.lastMove.rollNo > animatedRoll) {
      var first = !before || !before.game || before.gameNo !== view.gameNo;
      animatedRoll = g.lastMove.rollNo;
      if (!first) {
        shown[g.lastMove.id] = g.lastMove.from;
        showMove(g.lastMove);
      }
    }
    if (!g) { animatedRoll = 0; shown = {}; }
    drawBoard();
    drawTurn();
    drawOver();
    drawLog();
    drawPlayers();
    drawLeaders();
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

  el.roll.addEventListener('click', function () { el.roll.disabled = true; room.act({ type: 'roll' }); });
  el.join.addEventListener('click', function () { room.join(); });
  el.leave.addEventListener('click', function () { room.leave(); });
  el.start.addEventListener('click', function () { room.start(); });
  el.again.addEventListener('click', function () { room.again(); });
  document.getElementById('retry').addEventListener('click', function () { window.location.reload(); });
})();
