/**
 * A stable colour per author, so the same person is the same swatch in every
 * row without the server having to store one. Same idea as `tintFor` for app
 * tiles, and deliberately not the accent ramp: an identity is not a state.
 *
 * Shared by the transcript's message rows, the proposal event rows
 * (./proposal-event.tsx) and a request's and a change's pages
 * (../dev-board/topic/), which draw a person with the avatar their own
 * messages wear.
 *
 * AUDIT Y06 (2 Nov 2026): ONE HASH FOR A PERSON EVERYWHERE. This file kept
 * the group chat's old `h * 31` pick while Messages, the hub's faces and the
 * notifications used ../../lib/community-color.ts's (FNV-1a, then mixed), so
 * the same person was blue on the hub and purple on a request's page. It is
 * that one function now, not a copy of it.
 */
export { swatchFor } from '../../lib/community-color';
