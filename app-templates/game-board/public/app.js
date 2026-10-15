// The board game's screen. The game room (public/game/room.js) keeps it up
// to date over a live connection; this draws the room's view on two
// screens:
//
// - the title screen: the game's name, the board lying on the table, and
//   the lobby (who is at the table, join, start) with the leaderboard;
// - the game, filling the screen: the board, everyone's chip along the top
//   with whose turn it is, and the dice tray along the bottom. The results
//   show over it when somebody wins.
//
// Every move goes to the server, whose rules (game/rules.js) decide what
// happens; this page only shows it, stepping a piece square by square so a
// roll can be followed. The board is one SVG drawn from the game's state
// (its squares, shortcuts and slides), so a different board needs no new
// drawing code.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it. Class names are whole literals so the Tailwind
// build can see them.

(function () {
  function $(id) { return document.getElementById(id); }
  var el = {
    title: $('title'),
    titleBoard: $('title-board'),
    loading: $('loading'),
    error: $('error'),
    lobbyBody: $('lobby-body'),
    lobbyTitle: $('lobby-title'),
    lobbyNote: $('lobby-note'),
    players: $('players'),
    empty: $('empty'),
    join: $('join'),
    start: $('start'),
    watch: $('watch'),
    resume: $('resume'),
    newGame: $('new-game'),
    leave: $('leave'),
    leadersSection: $('leaders-section'),
    leaders: $('leaders'),
    stage: $('stage'),
    toTitle: $('to-title'),
    turnOrder: $('turn-order'),
    board: $('board'),
    die: $('die'),
    turnLine: $('turn-line'),
    turnNote: $('turn-note'),
    roll: $('roll'),
    over: $('over'),
    overLine: $('over-line'),
    standings: $('standings'),
    again: $('again'),
    overTitle: $('over-title'),
    connection: $('connection'),
    toast: $('toast'),
    toastText: $('toast-text'),
  };

  // The scene's colours, the same as public/scene.css names: a board game
  // looks the same in any room. Each seat has its piece's colour.
  var C = {
    wood: '#a86b35',
    woodDeep: '#6b3f19',
    paper: '#fbf3dc',
    ink: '#3b2716',
    inkSoft: '#8a6a4c',
    gold: '#f6b93b',
    goldDeep: '#c98a12',
    coral: '#ee6b5a',
    coralDeep: '#b8432f',
    coralLight: '#ffc2b6',
    rail: '#c48a4a',
    railDeep: '#6b3f19',
  };
  var PIECE_COLOURS = ['#2f6fdf', '#e0457b', '#2ea05a', '#f08a24', '#8b5cf6', '#14a3b8'];
  // Each row of the board has a tint; the squares between are paper.
  var ROW_TINTS = ['#fde3a7', '#cfeccb', '#cde3f7', '#fbd2c4', '#e3d7f6'];
  var DEFAULT = { squares: 30, shortcuts: { 3: 15, 8: 20, 12: 24, 21: 28 }, slides: { 16: 4, 23: 11, 27: 22, 29: 18 } };
  var FACES = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  var STEP_MS = 140;

  var view = null;
  var screen = 'title'; // or 'stage'
  var leftGameNo = null; // a game you stepped out of to the title screen
  var watching = false; // on the stage without playing
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

  function isMe(id) {
    return !!(view && view.you && view.you.id === id);
  }
  function who(id, username) {
    return isMe(id) ? 'You' : '@' + username;
  }
  function colourOf(seat) {
    return PIECE_COLOURS[seat % PIECE_COLOURS.length];
  }
  function token(username, seat, small, away) {
    var t = h('span', small ? 'token token-small' : 'token', username.charAt(0).toUpperCase());
    if (away) t.classList.add('token-away');
    t.style.backgroundColor = colourOf(seat);
    t.setAttribute('aria-hidden', 'true');
    return t;
  }
  function whereText(pos, squares) {
    if (pos >= squares) return 'Finish';
    return pos ? 'Square ' + pos : 'Start';
  }

  // ── The board, as one SVG ─────────────────────────────────────────────

  var NS = 'http://www.w3.org/2000/svg';
  var COLS = 6;
  var CELL = 100; // a square's width; its height stretches to fill a tall screen
  var GAP = 8;
  var PAD = 22;
  var LANE = 84;
  var WIDTH = PAD * 2 + COLS * CELL + (COLS - 1) * GAP;

  function s(tag, attrs, parent) {
    var node = document.createElementNS(NS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  // opts.lane: draw the start lane under the board (where pieces wait);
  // opts.fit: stretch the squares to fill the space the board is given.
  function makeBoard(svg, prefix, opts) {
    var config = null;
    var rows = 0;
    var cellH = CELL;
    var piecesLayer = null;
    var pieceNodes = {};

    function fitHeight(forRows) {
      if (!opts.fit) return CELL;
      var box = svg.getBoundingClientRect();
      if (!box.width || !box.height) return cellH;
      var want = WIDTH * (box.height / box.width) - (opts.lane ? LANE : 0) - PAD * 2 - (forRows - 1) * GAP;
      return Math.max(CELL, Math.min(190, Math.round(want / forRows)));
    }

    // Square n's centre: squares zigzag up from the bottom left, six a row.
    function centre(n) {
      var i = n - 1;
      var r = Math.floor(i / COLS);
      var c = i % COLS;
      if (r % 2 === 1) c = COLS - 1 - c;
      return { x: PAD + c * (CELL + GAP) + CELL / 2, y: PAD + (rows - 1 - r) * (cellH + GAP) + cellH / 2 };
    }
    function boardHeight() {
      return PAD * 2 + rows * cellH + (rows - 1) * GAP;
    }
    // A piece at the start waits in the lane under the board.
    function startSpot(k) {
      return { x: PAD + 118 + k * 62, y: boardHeight() + LANE / 2 + 4 };
    }

    function ladder(layer, from, to) {
      var a = centre(from);
      var b = centre(to);
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var len = Math.hypot(dx, dy);
      var ux = dx / len;
      var uy = dy / len;
      var px = -uy * 17;
      var py = ux * 17;
      var x1 = a.x + ux * 14;
      var y1 = a.y + uy * 14;
      var x2 = b.x - ux * 14;
      var y2 = b.y - uy * 14;
      var g = s('g', { opacity: '0.95' }, layer);
      var rungs = Math.max(2, Math.floor((len - 28) / 30));
      [[C.railDeep, 9], [C.rail, 5]].forEach(function (stroke) {
        for (var i = 1; i <= rungs; i++) {
          var t = i / (rungs + 1);
          var cx = x1 + (x2 - x1) * t;
          var cy = y1 + (y2 - y1) * t;
          s('line', { x1: cx - px, y1: cy - py, x2: cx + px, y2: cy + py, stroke: stroke[0], 'stroke-width': stroke[1], 'stroke-linecap': 'round' }, g);
        }
        [-1, 1].forEach(function (side) {
          s('line', { x1: x1 + px * side, y1: y1 + py * side, x2: x2 + px * side, y2: y2 + py * side, stroke: stroke[0], 'stroke-width': stroke[1] + 2, 'stroke-linecap': 'round' }, g);
        });
      });
    }

    function slide(layer, from, to) {
      var a = centre(from);
      var b = centre(to);
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var len = Math.hypot(dx, dy);
      var px = -dy / len;
      var py = dx / len;
      var bend = Math.min(40, len * 0.2);
      var d = 'M' + a.x + ' ' + a.y +
        ' C' + (a.x + px * bend + dx * 0.25) + ' ' + (a.y + py * bend + dy * 0.25) +
        ' ' + (b.x - px * bend - dx * 0.25) + ' ' + (b.y - py * bend - dy * 0.25) +
        ' ' + b.x + ' ' + b.y;
      var g = s('g', { opacity: '0.95' }, layer);
      s('path', { d: d, fill: 'none', stroke: C.coralDeep, 'stroke-width': 30, 'stroke-linecap': 'round' }, g);
      s('path', { d: d, fill: 'none', stroke: C.coral, 'stroke-width': 22, 'stroke-linecap': 'round' }, g);
      s('path', { d: d, fill: 'none', stroke: C.coralLight, 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-dasharray': '2 14' }, g);
      s('circle', { cx: a.x, cy: a.y, r: 17, fill: C.coralDeep }, g);
      s('circle', { cx: a.x, cy: a.y, r: 11, fill: C.coral }, g);
    }

    function drawStatic(next, nextCellH) {
      config = next;
      rows = Math.ceil(config.squares / COLS);
      cellH = nextCellH;
      var width = WIDTH;
      var height = boardHeight();
      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + (height + (opts.lane ? LANE : 0)));
      while (svg.firstChild) svg.removeChild(svg.firstChild);

      var defs = s('defs', {}, svg);
      var wood = s('linearGradient', { id: prefix + '-wood', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      s('stop', { offset: 0, 'stop-color': C.wood }, wood);
      s('stop', { offset: 1, 'stop-color': C.woodDeep }, wood);
      var gold = s('linearGradient', { id: prefix + '-gold', x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
      s('stop', { offset: 0, 'stop-color': '#ffe08a' }, gold);
      s('stop', { offset: 1, 'stop-color': C.gold }, gold);
      var gloss = s('radialGradient', { id: prefix + '-gloss', cx: '35%', cy: '30%', r: '65%' }, defs);
      s('stop', { offset: 0, 'stop-color': '#fff', 'stop-opacity': 0.75 }, gloss);
      s('stop', { offset: 0.5, 'stop-color': '#fff', 'stop-opacity': 0 }, gloss);

      // The board: a wooden frame round a paper face.
      s('rect', { x: 0, y: 0, width: width, height: height, rx: 28, fill: 'url(#' + prefix + '-wood)' }, svg);
      s('rect', { x: 10, y: 10, width: width - 20, height: height - 20, rx: 20, fill: C.paper }, svg);

      var squares = s('g', {}, svg);
      for (var n = 1; n <= config.squares; n++) {
        var p = centre(n);
        var r = Math.floor((n - 1) / COLS);
        var last = n === config.squares;
        var fill = last ? 'url(#' + prefix + '-gold)' : ((n % 2) ? ROW_TINTS[r % ROW_TINTS.length] : '#fffaf0');
        var cell = s('g', { 'data-square': String(n) }, squares);
        s('rect', { x: p.x - CELL / 2, y: p.y - cellH / 2 + 4, width: CELL, height: cellH, rx: 14, fill: 'rgba(59,39,22,0.12)' }, cell);
        s('rect', { x: p.x - CELL / 2, y: p.y - cellH / 2, width: CELL, height: cellH, rx: 14, fill: fill }, cell);
        if (last) {
          var star = s('text', { x: p.x, y: p.y + 12, 'text-anchor': 'middle', 'font-size': 44, fill: C.ink }, cell);
          star.textContent = '★';
          var label = s('text', { x: p.x, y: p.y + 38, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 800, fill: C.ink }, cell);
          label.textContent = 'Finish';
        }
      }
      var paths = s('g', {}, svg);
      Object.keys(config.slides).forEach(function (k) { slide(paths, Number(k), config.slides[k]); });
      Object.keys(config.shortcuts).forEach(function (k) { ladder(paths, Number(k), config.shortcuts[k]); });
      // Numbers on top, haloed in paper so a ladder never hides one.
      var numbers = s('g', { 'font-size': 19, 'font-weight': 800, fill: C.inkSoft, stroke: C.paper, 'stroke-width': 5, 'paint-order': 'stroke' }, svg);
      for (var m = 1; m < config.squares; m++) {
        var q = centre(m);
        var num = s('text', { x: q.x - CELL / 2 + 11, y: q.y - cellH / 2 + 25 }, numbers);
        num.textContent = String(m);
      }
      // The start lane.
      if (opts.lane) {
        var lane = s('g', {}, svg);
        s('rect', { x: PAD, y: height + 12, width: 96, height: LANE - 18, rx: 18, fill: 'rgba(255,248,231,0.14)' }, lane);
        var startLabel = s('text', { x: PAD + 48, y: height + 12 + (LANE - 18) / 2 + 6, 'text-anchor': 'middle', 'font-size': 18, 'font-weight': 800, fill: '#fff8e7' }, lane);
        startLabel.textContent = 'Start';
      }
      piecesLayer = s('g', {}, svg);
      pieceNodes = {};
    }

    function pieceNode(id, username, seat) {
      var g = s('g', { class: 'piece', 'data-piece': String(id) }, piecesLayer);
      s('circle', { class: 'piece-ring', r: 33, fill: 'none', stroke: C.gold, 'stroke-width': 5, opacity: 0 }, g);
      s('ellipse', { cx: 0, cy: 22, rx: 22, ry: 7, fill: 'rgba(0,0,0,0.25)' }, g);
      s('circle', { r: 25, fill: colourOf(seat), stroke: '#fff', 'stroke-width': 5 }, g);
      s('circle', { r: 22, fill: 'url(#' + prefix + '-gloss)' }, g);
      var t = s('text', { y: 8, 'text-anchor': 'middle', 'font-size': 24, 'font-weight': 800, fill: '#fff' }, g);
      t.textContent = username.charAt(0).toUpperCase();
      var title = s('title', {}, g);
      title.textContent = '@' + username;
      return g;
    }

    // pieces: [{ id, username, seat, pos, now }]
    function place(all) {
      // Without the lane, pieces at the start are not drawn.
      var pieces = opts.lane ? all : all.filter(function (p) { return p.pos > 0; });
      var at = {};
      pieces.forEach(function (p) { (at[p.pos] = at[p.pos] || []).push(p); });
      var keep = {};
      pieces.forEach(function (p) {
        keep[p.id] = true;
        var node = pieceNodes[p.id];
        if (!node) node = pieceNodes[p.id] = pieceNode(p.id, p.username, p.seat);
        var group = at[p.pos];
        var k = group.indexOf(p);
        var x;
        var y;
        var scale = 1;
        if (!p.pos) {
          var spot = startSpot(k);
          x = spot.x;
          y = spot.y;
        } else {
          var c = centre(Math.min(p.pos, config.squares));
          x = c.x;
          y = c.y + 8;
          if (group.length === 2) x += k ? 20 : -20;
          else if (group.length > 2) {
            var a = (k / group.length) * Math.PI * 2 - Math.PI / 2;
            x += Math.cos(a) * 24;
            y += Math.sin(a) * 20;
            scale = 0.72;
          }
        }
        node.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(' + scale + ')';
        node.classList.toggle('piece-now', !!p.now);
        node.querySelector('.piece-ring').setAttribute('opacity', p.now ? 1 : 0);
        // The one whose turn it is stands on top.
        if (p.now) piecesLayer.appendChild(node);
      });
      Object.keys(pieceNodes).forEach(function (id) {
        if (!keep[id]) {
          piecesLayer.removeChild(pieceNodes[id]);
          delete pieceNodes[id];
        }
      });
    }

    return {
      draw: function (next, pieces) {
        var h = fitHeight(Math.ceil(next.squares / COLS));
        if (!config || Math.abs(h - cellH) > 1 || JSON.stringify(config) !== JSON.stringify(next)) drawStatic(next, h);
        place(pieces);
      },
    };
  }

  var stageBoard = makeBoard(el.board, 'stage', { lane: true, fit: true });
  var titleBoard = makeBoard(el.titleBoard, 'title', { lane: false, fit: false });

  function boardConfig() {
    var g = view && view.game;
    return g ? { squares: g.squares, shortcuts: g.shortcuts, slides: g.slides } : DEFAULT;
  }

  function piecesNow() {
    var g = view && view.game;
    if (!g || view.phase === 'lobby') {
      // The lobby's players wait at the start.
      return (view ? view.players : []).map(function (p, seat) {
        return { id: p.id, username: p.username, seat: seat, pos: 0, now: false };
      });
    }
    var current = view.phase === 'playing' ? g.order[g.turn % g.order.length] : null;
    return g.order.map(function (id) {
      var piece = g.pieces[id];
      return { id: id, username: piece.username, seat: piece.seat, pos: shown[id] != null ? shown[id] : piece.pos, now: id === current };
    });
  }

  function drawBoards() {
    var pieces = piecesNow();
    stageBoard.draw(boardConfig(), pieces);
    titleBoard.draw(boardConfig(), pieces);
  }

  // ── The die and the tray ──────────────────────────────────────────────

  function setDie(n) {
    var on = FACES[n] || FACES[6];
    var pips = el.die.children;
    for (var i = 0; i < pips.length; i++) pips[i].classList.toggle('pip-on', on.indexOf(i) !== -1);
    el.die.setAttribute('aria-label', n ? 'The die shows ' + n : 'The die');
  }

  // A new roll: the die tumbles, then the piece steps to where it landed and
  // takes any shortcut or slide.
  function showMove(move) {
    clearInterval(stepping);
    rolling = true;
    el.die.classList.add('die-rolling');
    var ticks = 0;
    stepping = setInterval(function () {
      ticks += 1;
      if (ticks < 5) {
        setDie(1 + Math.floor(Math.random() * 6));
        return;
      }
      el.die.classList.remove('die-rolling');
      setDie(move.die);
      var pos = shown[move.id] != null ? shown[move.id] : move.from;
      if (pos < move.landed) shown[move.id] = pos + 1;
      else if (pos !== move.to) shown[move.id] = move.to;
      else {
        clearInterval(stepping);
        stepping = null;
        rolling = false;
        delete shown[move.id];
        drawOver();
      }
      drawBoards();
      drawTray();
      drawTurnOrder();
    }, STEP_MS);
  }

  function drawTray() {
    var g = view.game;
    if (!g) return;
    var playing = view.phase === 'playing';
    var id = g.order[g.turn % g.order.length];
    var mine = playing && isMe(id);
    var player = view.players.filter(function (p) { return p.id === id; })[0];
    if (!rolling) setDie(g.lastMove ? g.lastMove.die : 6);
    if (!playing) {
      el.turnLine.textContent = 'Game over';
      el.turnNote.textContent = g.log.length ? g.log[0].text : '';
    } else {
      el.turnLine.textContent = mine ? 'Your turn' : (g.pieces[id] ? '@' + g.pieces[id].username + '\'s turn' : '');
      var last = !rolling && g.log.length ? g.log[0].text : '';
      if (mine) el.turnNote.textContent = last ? last + '. Your roll.' : 'Roll the die to set off.';
      else if (player && !player.here) el.turnNote.textContent = 'Away, so their roll is made for them.';
      else el.turnNote.textContent = last || (watching ? 'You are watching this game.' : 'Waiting for them to roll.');
    }
    el.roll.hidden = !mine;
    el.roll.disabled = rolling;
  }

  function drawTurnOrder() {
    var g = view.game;
    el.turnOrder.textContent = '';
    if (!g) return;
    var current = view.phase === 'playing' ? g.order[g.turn % g.order.length] : null;
    var here = {};
    view.players.forEach(function (p) { here[p.id] = p.here; });
    g.order.forEach(function (id) {
      var piece = g.pieces[id];
      var chip = h('li', id === current ? 'chip chip-now' : 'chip');
      chip.setAttribute('data-turn', String(id));
      chip.appendChild(token(piece.username, piece.seat, true, here[id] === false));
      chip.appendChild(h('span', 'chip-name', who(id, piece.username)));
      var pos = shown[id] != null ? shown[id] : piece.pos;
      chip.appendChild(h('span', 'chip-where', here[id] === false ? 'away' : whereText(pos, g.squares)));
      el.turnOrder.appendChild(chip);
    });
  }

  function drawOver() {
    var done = view.phase === 'over' && view.results && !rolling;
    el.over.hidden = !done;
    if (!done) return;
    var winner = view.results[0];
    el.overLine.textContent = isMe(winner.id) ? 'You won!' : '@' + winner.username + ' won!';
    el.standings.textContent = '';
    var g = view.game;
    view.results.forEach(function (r) {
      var li = h('li', 'rank');
      li.appendChild(h('span', 'rank-place', String(r.place)));
      var seat = g && g.pieces[r.id] ? g.pieces[r.id].seat : r.place - 1;
      li.appendChild(token(r.username, seat, true));
      li.appendChild(h('span', 'min-w-0 flex-1 truncate font-bold', who(r.id, r.username)));
      li.appendChild(h('span', 'pad-note', whereText(r.score, g ? g.squares : 30)));
      el.standings.appendChild(li);
    });
  }

  // ── The title screen ──────────────────────────────────────────────────

  function drawLobby() {
    var you = view.you;
    var joined = !!(you && you.joined);
    var phase = view.phase;
    var g = view.game;
    var max = view.rules.maxPlayers;

    el.players.textContent = '';
    view.players.forEach(function (p, seat) {
      var li = h('li', 'seat');
      li.setAttribute('data-player', String(p.id));
      var s = g && g.pieces[p.id] && phase !== 'lobby' ? g.pieces[p.id].seat : seat;
      li.appendChild(token(p.username, s, false, !p.here));
      li.appendChild(h('span', 'seat-name', who(p.id, p.username)));
      var note = !p.here ? 'away' : (g && g.pieces[p.id] && phase !== 'lobby' ? whereText(g.pieces[p.id].pos, g.squares) : 'ready');
      li.appendChild(h('span', 'seat-note', note));
      el.players.appendChild(li);
    });
    if (phase === 'lobby' && view.players.length) {
      for (var i = view.players.length; i < max; i++) {
        var open = h('li', 'seat');
        open.appendChild(h('span', 'seat-open', '+'));
        open.appendChild(h('span', 'seat-note', 'Open seat'));
        el.players.appendChild(open);
      }
    }
    el.empty.hidden = !!view.players.length;
    el.players.hidden = !view.players.length;

    var lobby = phase === 'lobby';
    var on = phase === 'playing';
    var over = phase === 'over';
    el.lobbyTitle.textContent = lobby ? 'Around the table' : on ? 'A game is on' : 'The last game is over';
    el.join.hidden = !lobby || joined;
    el.start.hidden = !lobby || !joined;
    el.start.disabled = view.players.length < view.rules.minPlayers;
    el.leave.hidden = !joined || over;
    el.watch.hidden = !on || joined;
    el.resume.hidden = !on || !joined;
    el.newGame.hidden = !over;
    el.leave.textContent = on ? 'Leave the game' : 'Leave';

    var note = '';
    if (!you) note = 'Make an account to play. You can watch any game.';
    else if (lobby) note = joined ? 'Anyone at the table can start. Away players have their rolls made for them.' : 'Take a seat to play in the next game.';
    else if (on) note = joined ? 'You are playing.' : 'You can watch it, and join the next one.';
    else if (view.results) note = (isMe(view.results[0].id) ? 'You' : '@' + view.results[0].username) + ' won it.';
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
      li.appendChild(h('span', 'pad-note', l.wins + (l.wins === 1 ? ' win' : ' wins') + ' of ' + l.played));
      el.leaders.appendChild(li);
    });
  }

  // ── Which screen ──────────────────────────────────────────────────────

  function show(next) {
    screen = next;
    el.title.hidden = screen !== 'title';
    el.stage.hidden = screen !== 'stage';
  }

  // A player goes to the table when their game starts (unless they stepped
  // out of it), and the lobby brings everyone back to the title screen.
  function chooseScreen() {
    var joined = !!(view.you && view.you.joined);
    if (view.phase === 'lobby') {
      watching = false;
      show('title');
    } else if (view.phase === 'playing' && joined && leftGameNo !== view.gameNo) {
      watching = false;
      show('stage');
    }
  }

  function render(next) {
    var before = view;
    view = next;
    el.loading.hidden = true;
    el.error.hidden = true;
    el.lobbyBody.hidden = false;
    var g = view.game;
    // A roll this page has not shown yet.
    if (g && g.lastMove && g.lastMove.rollNo > animatedRoll) {
      var first = !before || !before.game || before.gameNo !== view.gameNo;
      animatedRoll = g.lastMove.rollNo;
      if (!first && screen === 'stage') {
        shown[g.lastMove.id] = g.lastMove.from;
        showMove(g.lastMove);
      }
    }
    if (!g) { animatedRoll = 0; shown = {}; }
    chooseScreen();
    drawBoards();
    drawTray();
    drawTurnOrder();
    drawOver();
    drawLobby();
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

  setDie(6);
  drawBoards();
  window.addEventListener('resize', function () { if (view) drawBoards(); });

  el.roll.addEventListener('click', function () { el.roll.disabled = true; room.act({ type: 'roll' }); });
  el.join.addEventListener('click', function () { room.join(); });
  el.start.addEventListener('click', function () { leftGameNo = null; room.start(); });
  el.leave.addEventListener('click', function () { room.leave(); show('title'); });
  el.watch.addEventListener('click', function () { watching = true; show('stage'); render(view); });
  el.resume.addEventListener('click', function () { leftGameNo = null; show('stage'); render(view); });
  el.newGame.addEventListener('click', function () { room.again(); });
  el.toTitle.addEventListener('click', function () {
    if (view && view.phase === 'playing') leftGameNo = view.gameNo;
    show('title');
  });
  el.again.addEventListener('click', function () { leftGameNo = null; room.again(); });
  el.overTitle.addEventListener('click', function () { show('title'); });
  $('retry').addEventListener('click', function () { window.location.reload(); });
  document.addEventListener('keydown', function (e) {
    if (screen === 'stage' && (e.key === ' ' || e.key === 'Enter') && !el.roll.hidden && !el.roll.disabled && document.activeElement === document.body) {
      e.preventDefault();
      el.roll.click();
    }
  });
})();
