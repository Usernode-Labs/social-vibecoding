/**
 * TAPPING A COMPOSER FIELD MUST NOT LET iOS PAN THE PAGE (#3571).
 *
 * Tap the Messages field on mobile Safari and the message box rode off the
 * screen as the keyboard came up. iOS reveals a focused field by panning the
 * viewport down inside the layout viewport, and it pans BEFORE the shell's
 * keyboard reservation has answered: the composer column pads
 * (`--un-kb-inset`, `.platform-kb-column` in app.css) a frame or two into the
 * keyboard's animation, while the pan has already moved the visible band to
 * the foot of the page. Once both have landed the composer sits above the
 * keyboard, and above the band: the screen shows the reserved padding and
 * the keys, and the box is off screen. Nothing puts the pan back while the
 * keyboard is up (lib/browser-scroll.ts settles a stranded pan only once
 * `html.un-kb` has cleared, because a keyboard pan is the browser doing its
 * job), so the box stayed off screen for as long as the field held focus.
 *
 * The pan is also unnecessary here. The reservation's whole point is that
 * the column shrinking reveals the composer, so the field ends above the
 * keyboard without the page moving. The fix is to keep iOS from panning at
 * all: focus the field INSIDE the tap with `preventScroll`, which raises the
 * same keyboard with no pan. It is the kit's own pattern for fields in
 * modals (native.js attachModalFieldFocus, #3150), measured there on the iOS
 * Simulator: refocused inside the tap, the keyboard comes up with no pan.
 *
 * A tap on the already-focused field stays native, so the caret still places
 * where the finger landed. A drag is not a tap and keeps every native
 * behaviour (text selection, the magnifier). The decision is pure so the
 * composer's touch handlers stay one line each and the rules are testable.
 */

/** Px of movement that turns a tap into a drag (the kit's KB_TAP_SLOP). */
export const TAP_SLOP = 8;

export type TapPoint = { x: number; y: number };

/**
 * Pure. What a touchend on a text field calls for:
 *  - 'ignore': not a tap (a drag, a second finger still down, an event the
 *    browser will not let us answer). Do nothing; every native behaviour
 *    stays.
 *  - 'native': the field has focus already. The tap places the caret.
 *  - 'focus':  the caller preventDefaults the tap and focuses the field with
 *    `preventScroll`, so the keyboard comes up with no pan for the
 *    reservation to answer.
 */
export function fieldTapDecision(
  start: TapPoint | null,
  end: TapPoint | undefined,
  event: { touches: ArrayLike<unknown>; changedTouches: ArrayLike<unknown>; cancelable: boolean },
  fieldFocused: boolean,
): 'ignore' | 'native' | 'focus' {
  if (!start || !end) return 'ignore';
  if (event.changedTouches.length !== 1) return 'ignore';
  if (event.touches.length) return 'ignore'; // another finger is still down
  if (Math.abs(end.x - start.x) > TAP_SLOP || Math.abs(end.y - start.y) > TAP_SLOP) return 'ignore';
  if (fieldFocused) return 'native';
  if (!event.cancelable) return 'ignore';
  return 'focus';
}