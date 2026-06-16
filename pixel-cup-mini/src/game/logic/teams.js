// Pure team data + opponent assignment. No Phaser dependency so this
// module is importable by both the bundled game (via esbuild) and the
// headless Node test runner.
//
// Colours are 24-bit ints (0xRRGGBB) so they can be fed straight into
// Phaser's setTint()/fillStyle without conversion.

const TEAMS = [
  {
    id: 'brazil',
    name: 'Brazil',
    shirt: 0xffdf1b, // yellow
    shorts: 0x1b6ec2, // blue
    trim: 0x1f9e4a, // green
    flag: [0x1f9e4a, 0xffdf1b, 0x1b6ec2],
  },
  {
    id: 'japan',
    name: 'Japan',
    shirt: 0x1f4fb0, // blue
    shorts: 0xffffff,
    trim: 0xd32d3a, // red accent
    flag: [0xffffff, 0xd32d3a, 0xffffff],
  },
  {
    id: 'argentina',
    name: 'Argentina',
    shirt: 0x76b6e6, // light blue
    shorts: 0x1a2a6c,
    trim: 0xffffff,
    flag: [0x76b6e6, 0xffffff, 0x76b6e6],
  },
  {
    id: 'france',
    name: 'France',
    shirt: 0x1d3f8f, // blue
    shorts: 0xffffff,
    trim: 0xd32d3a, // red
    flag: [0x1d3f8f, 0xffffff, 0xd32d3a],
  },
  {
    id: 'germany',
    name: 'Germany',
    shirt: 0xf4f4f4, // white
    shorts: 0x111111,
    trim: 0x111111, // black
    flag: [0x111111, 0xd32d3a, 0xffdf1b],
  },
];

function getTeam(id) {
  return TEAMS.find((t) => t.id === id) || null;
}

// Deterministic-friendly opponent picker. `rand` is an optional
// () => number in [0,1) (defaults to Math.random) so tests can inject a
// seeded generator. Always returns a team whose id differs from
// `playerId`.
function pickOpponent(playerId, rand) {
  const rng = typeof rand === 'function' ? rand : Math.random;
  const pool = TEAMS.filter((t) => t.id !== playerId);
  if (pool.length === 0) return null;
  const idx = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
  return pool[idx];
}

module.exports = { TEAMS, getTeam, pickOpponent };
