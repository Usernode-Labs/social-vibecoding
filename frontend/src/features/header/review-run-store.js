/**
 * The header while the Needs you run is open (EXPERIMENTAL, features/
 * review-flow/): the bar every other screen wears says where you are,
 * instead of the run drawing a bar of its own over it.
 *
 * On a phone a project's page names itself in this bar as the community
 * and, beside it, the place you are on (#4703, `.header-place-name`). The
 * run across your communities reads the same way: its title is the screen's
 * ("Needs you") and its place tag is the community of the change on screen,
 * which changes as the run moves on. The back arrow leaves the run; it is
 * an action rather than a route, because Needs you is a pane of the
 * Communities screen, not an address of its own.
 *
 * `on` is false everywhere else, and the header is then exactly what it was.
 */
import { createStore } from '../../lib/plain-store.js';

const INITIAL = {
  on: false,
  title: '',
  place: '',
  /** @type {null | (() => void)} */
  back: null,
};

export const reviewRunStore = createStore(INITIAL);

/** Publish the run's header, or take it down with `null`. */
export function setReviewRunHeader(next) {
  reviewRunStore.set(next ? { on: true, title: next.title, place: next.place || '', back: next.back } : INITIAL);
}
