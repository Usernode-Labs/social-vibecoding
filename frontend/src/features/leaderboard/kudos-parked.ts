// Kudos is parked (#5249).
//
// While this is true nobody sees or gives kudos: no kudos slot or "Thank"
// on a change, no "Pledge kudos" on a request, no Kudos tab, no kudos stat
// or row on Me, no kudos notification. Nothing is deleted. The tables, the
// server routes, the weekly allowance and the bounties already pledged all
// stay as they are, so flipping this back to false brings the feature back
// as it was.
//
// ONE switch, read two ways:
//   * React modules import it from here (or from ./kudos.js, which
//     re-exports it).
//   * Classic scripts and the planted controllers read it as the ABSENCE of
//     `window.Kudos`: ./kudos.js publishes that global only while this is
//     false, and every legacy caller (AppView._kudosOffered,
//     AppView._bountiesOffered, App's budget boot, the kudos_update handler)
//     already asks `window.Kudos` before it draws anything.
//
// It lives in its own module so a surface that only needs to know (the
// feedback dialog, the comment pin, Me) does not pull the kudos widget into
// its chunk.
export const KUDOS_PARKED = true;
