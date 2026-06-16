// Pure gameplay math: pass-target selection, shot aiming, and the
// possession re-pickup cooldown. Operates on plain {x,y} points and
// numbers — no Phaser objects — so it is unit-testable and reusable.

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function len(v) {
  return Math.hypot(v.x, v.y);
}

function norm(v) {
  const l = len(v);
  if (l === 0) return { x: 0, y: 0 };
  return { x: v.x / l, y: v.y / l };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

// Choose the best teammate to pass to. Prefers teammates that are both
// within `maxRange` and well-aligned with `facing` (the carrier's aim
// direction). Returns the chosen teammate object or null if none score.
//
//   from       : {x,y} carrier position
//   facing     : {x,y} aim direction (need not be normalised)
//   teammates  : array of objects each with {x,y} (plus any extra fields)
//   opts.maxRange  : ignore teammates farther than this (default 420)
//   opts.minAlign  : minimum alignment dot in [-1,1] (default -0.2)
function choosePassTarget(from, facing, teammates, opts = {}) {
  const maxRange = opts.maxRange != null ? opts.maxRange : 420;
  const minAlign = opts.minAlign != null ? opts.minAlign : -0.2;
  const f = norm(facing.x === 0 && facing.y === 0 ? { x: 1, y: 0 } : facing);

  let best = null;
  let bestScore = -Infinity;
  for (const t of teammates) {
    const to = sub(t, from);
    const dist = len(to);
    if (dist === 0 || dist > maxRange) continue;
    const align = dot(f, norm(to)); // [-1,1]
    if (align < minAlign) continue;
    // Reward alignment, mildly penalise distance so a tightly-aligned
    // close option beats a vaguely-aligned far one.
    const score = align * 2 - dist / maxRange;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

// Compute a shot velocity vector. Blends the straight-line direction to
// the goal mouth with the player's current movement direction, then
// scales by power (+ a small held-button bonus).
//
//   from     : {x,y} ball/carrier position
//   goal     : {x,y} target point (goal-mouth centre)
//   moveDir  : {x,y} player movement direction (may be zero)
//   opts.power      : base speed (default 360)
//   opts.bonus      : extra speed from holding (default 0)
//   opts.aimWeight  : how much moveDir nudges the aim, 0..1 (default 0.35)
function shootAim(from, goal, moveDir, opts = {}) {
  const power = opts.power != null ? opts.power : 360;
  const bonus = opts.bonus != null ? opts.bonus : 0;
  const aimWeight = opts.aimWeight != null ? opts.aimWeight : 0.35;

  const toGoal = norm(sub(goal, from));
  const md = norm(moveDir);
  let dir = {
    x: toGoal.x + md.x * aimWeight,
    y: toGoal.y + md.y * aimWeight,
  };
  dir = norm(dir);
  if (dir.x === 0 && dir.y === 0) dir = toGoal;
  const speed = power + bonus;
  return { x: dir.x * speed, y: dir.y * speed };
}

// Re-pickup gate: after a kick, the kicker (and everyone) is blocked from
// re-grabbing the ball until the cooldown elapses. Returns true when the
// ball may be picked up again.
//
//   now        : current time in ms
//   lastKickAt : timestamp of the last kick in ms (null/undefined = never)
//   cooldownMs : minimum gap (default 350)
function canPickup(now, lastKickAt, cooldownMs = 350) {
  if (lastKickAt == null) return true;
  return now - lastKickAt >= cooldownMs;
}

module.exports = {
  choosePassTarget,
  shootAim,
  canPickup,
  // exported for tests / reuse
  _vec: { sub, len, norm, dot },
};
