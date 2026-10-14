// The trivia game's rules: questions about each other. Everyone writes
// questions about themselves (api.js keeps them); a game asks up to eight
// of them, one at a time. Everyone but the question's author picks an
// answer before the time runs out: a right answer scores 100, plus up to 50
// for being quick, and the author scores 25 for everyone who knew. Then the
// answer shows, with who picked what, and the next question comes.
//
// Plain functions of the game's state, kept to the game room's contract
// (game/room.js). `setup` gets the question bank as `extra` (api.js
// prepare). To make it a different quiz, change these and the screen.

'use strict';

const PER_GAME = 8;
const ASK_MS = 20000;
const REVEAL_MS = 6000;
const RIGHT = 100;
const QUICK = 50;
const KNOWN = 25;

function clone(game) {
  return JSON.parse(JSON.stringify(game));
}

function shuffle(list, random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function setup({ players, random, now, extra }) {
  const bank = Array.isArray(extra) ? extra : [];
  if (!bank.length) return { error: 'Write a question about yourself first: a game needs at least one.' };
  // Only questions somebody playing can answer: never one about the only player.
  const answerable = bank.filter((q) => players.some((p) => p.id !== q.authorId));
  if (!answerable.length) return { error: 'Every question so far is about you. Play once somebody else has joined or written one.' };
  const questions = shuffle(answerable, random).slice(0, PER_GAME).map((q) => {
    const options = shuffle([q.answer].concat(q.wrong), random);
    return { id: q.id, authorId: q.authorId, author: q.author, text: q.text, options, correct: options.indexOf(q.answer) };
  });
  return {
    questions,
    index: 0,
    stage: 'asking',
    deadline: now + ASK_MS,
    answers: {},
    points: {},
    order: players.map((p) => p.id),
    scores: Object.fromEntries(players.map((p) => [p.id, { username: p.username, score: 0, right: 0 }])),
    done: false,
  };
}

function question(game) {
  return game.questions[game.index];
}

/** Who answers the current question: everyone playing but its author. */
function answerers(game) {
  const q = question(game);
  return game.order.filter((id) => id !== q.authorId);
}

// The answer shows: score the question and say who picked what.
function reveal(game, now) {
  const g = clone(game);
  const q = question(g);
  g.points = {};
  let knew = 0;
  for (const [id, a] of Object.entries(g.answers)) {
    if (a.choice !== q.correct) continue;
    knew += 1;
    const left = Math.max(0, g.deadline - a.at);
    const pts = RIGHT + Math.round(QUICK * (left / ASK_MS));
    g.points[id] = pts;
    if (g.scores[id]) {
      g.scores[id].score += pts;
      g.scores[id].right += 1;
    }
  }
  if (knew && g.scores[q.authorId]) {
    g.points[q.authorId] = KNOWN * knew;
    g.scores[q.authorId].score += g.points[q.authorId];
  }
  g.stage = 'reveal';
  g.deadline = now + REVEAL_MS;
  return g;
}

function next(game, now) {
  const g = clone(game);
  if (g.index + 1 >= g.questions.length) {
    g.done = true;
    return g;
  }
  g.index += 1;
  g.stage = 'asking';
  g.deadline = now + ASK_MS;
  g.answers = {};
  g.points = {};
  return g;
}

function act(game, action, { player, now, isOnline }) {
  if (game.done) return { error: 'This game is over.' };
  if (action.type !== 'answer') return { error: 'That is not a move in this game.' };
  if (game.stage !== 'asking') return { error: 'Too late: the answer is showing.' };
  const q = question(game);
  if (q.authorId === player.id) return { error: 'This one is about you, so sit back and watch them guess.' };
  if (!game.order.includes(player.id)) return { error: 'Join the game to answer.' };
  if (game.answers[player.id]) return { error: 'You already answered this one.' };
  const choice = Number(action.choice);
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return { error: 'Pick one of the answers.' };
  let g = clone(game);
  g.answers[player.id] = { choice, at: now };
  // Everyone here has answered: no need to wait out the clock.
  const waiting = answerers(g).filter((id) => !g.answers[id] && isOnline(id));
  if (!waiting.length) g = reveal(g, now);
  return { game: g };
}

// Every second: the clock runs out on a question, or on its answer.
function update(game, { now }) {
  if (game.done || now < game.deadline) return null;
  return game.stage === 'asking' ? reveal(game, now) : next(game, now);
}

function addPlayer(game, player) {
  const g = clone(game);
  if (!g.order.includes(player.id)) g.order.push(player.id);
  if (!g.scores[player.id]) g.scores[player.id] = { username: player.username, score: 0, right: 0 };
  return g;
}

function removePlayer(game, id) {
  const g = clone(game);
  g.order = g.order.filter((x) => x !== id);
  return g;
}

// What a player sees: never the right answer while it is being asked, and
// not who picked what until it shows.
function view(game, viewerId) {
  const q = question(game);
  const showing = game.stage === 'reveal' || game.done;
  return {
    number: game.index + 1,
    of: game.questions.length,
    stage: game.stage,
    deadline: game.deadline,
    askMs: game.stage === 'asking' ? ASK_MS : REVEAL_MS,
    question: {
      text: q.text, author: q.author, authorId: q.authorId, options: q.options,
      correct: showing ? q.correct : null,
    },
    answered: Object.keys(game.answers).map(Number),
    yours: viewerId != null && game.answers[viewerId] ? game.answers[viewerId].choice : null,
    picks: showing ? Object.fromEntries(Object.entries(game.answers).map(([id, a]) => [id, a.choice])) : null,
    points: showing ? game.points : null,
    scores: game.scores,
    done: game.done,
  };
}

function result(game) {
  if (!game.done) return null;
  const ranked = Object.entries(game.scores)
    .map(([id, s]) => ({ id: Number(id), username: s.username, score: s.score }))
    .sort((a, b) => b.score - a.score);
  let place = 0;
  return ranked.map((r, i) => {
    if (i === 0 || r.score !== ranked[i - 1].score) place = i + 1;
    return { ...r, place };
  });
}

module.exports = {
  minPlayers: 1,
  maxPlayers: 12,
  dropIn: true,
  leaderboard: 'wins',
  setup,
  act,
  update,
  addPlayer,
  removePlayer,
  view,
  result,
  PER_GAME,
  ASK_MS,
};
