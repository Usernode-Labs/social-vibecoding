/**
 * A CONVERSATION KEEPS ITS NEWEST LINE WHILE THE KEYBOARD COMES UP.
 *
 * First-session run, iOS Homeroom app, 5 Oct 2026, the Homeroom bot's DM:
 * tapping the message box to reply sent the transcript back to its oldest
 * line ("11:27 AM … Here's yours:"), so the message being answered was off
 * screen while typing. The same day in iOS Safari a project's Discussion
 * went blank with the keys up. While the keys come up the host resizes the
 * page (the app's web view, frame by frame) or covers and pans it (Safari),
 * iOS reveals the focused field and re-lays the shell, and a transcript's
 * scroller is moved by all of that, not by the reader. Both chats decide
 * whether to follow new lines from the scroller's own scroll events
 * (features/messages/stick-to-bottom.ts `pinned`, public/js/group-chat.js
 * `_lockedToBottom`), and a scroll event the keyboard caused away from the
 * bottom read as the reader scrolling up: the thread un-pinned and nothing
 * put it back. (What exactly moved the DM to its top was not reproduced off
 * the device; this holds the bottom whatever it was.)
 *
 * So focusing a field beside the transcript (its composer) while the reader
 * is at the newest line HOLDS the bottom for the keyboard's arrival: for
 * KEYBOARD_HOLD_MS after the focus, and KEYBOARD_SETTLE_MS after each
 * viewport resize within that, `holding()` is true. While it is, the chat
 * treats a scroll event as the keyboard's, not the reader's (back to the
 * bottom, still pinned), every resize puts it back at the bottom, and the
 * bottom is checked once more when the hold runs out. The reader's own
 * finger, wheel or key on the transcript ends the hold at once, so
 * scrolling up to read while typing works as before. A field INSIDE the
 * transcript (a card's own input) holds nothing, and neither does a focus
 * while the reader is up in the history.
 *
 * Plain DOM, no React: Messages' conversation (stick-to-bottom.ts) and the
 * group chat (a classic script, which reaches it as
 * `window.UsernodeKeyboardHold.attach`) share this one copy.
 */

/** How long the bottom is held after the composer is focused (ms): the keys' animation and the host's resize. */
export const KEYBOARD_HOLD_MS = 1200;
/** And after each viewport resize within that hold (ms). */
export const KEYBOARD_SETTLE_MS = 400;

// Input types that raise no text keyboard: the kit's own list (native.js
// KB_NON_TEXT_INPUT_TYPES).
const NOT_TYPED = new Set(['checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit', 'reset', 'image', 'hidden', 'date', 'time', 'month', 'week', 'datetime-local']);

/** Whether focusing `node` brings up a text keyboard: a text field, a text area, or editable content. */
export function isTypingField(node: unknown): boolean {
  const el = node as { nodeType?: number; tagName?: string; type?: string; isContentEditable?: boolean; readOnly?: boolean; disabled?: boolean } | null;
  if (!el || el.nodeType !== 1 || el.readOnly || el.disabled) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  return !NOT_TYPED.has(String(el.type || 'text').toLowerCase());
}

type Listens = {
  addEventListener(type: string, fn: (event: { target?: unknown }) => void, options?: unknown): void;
  removeEventListener(type: string, fn: (event: { target?: unknown }) => void, options?: unknown): void;
};

/** What the hold listens to and keeps time with: the window in a browser, a fake in a test. */
export interface HoldEnv {
  visualViewport?: Listens | null;
  addEventListener?: Listens['addEventListener'];
  removeEventListener?: Listens['removeEventListener'];
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  performance?: { now(): number } | null;
}

type ScrollerLike = {
  isConnected?: boolean;
  parentElement?: (Partial<Listens> & object) | null;
  contains(node: unknown): boolean;
} & Listens;

export interface KeyboardHold {
  /** True while a scroll event on the transcript is the keyboard's, not the reader's. */
  holding(): boolean;
  detach(): void;
}

/**
 * Hold `el` (a transcript's scroller) at its newest line while the keyboard
 * comes up for a field beside it. `pinned` says whether the reader is at the
 * newest line now; `follow` puts the scroller back there. The column the
 * composer shares with the transcript is `el`'s parent unless named.
 */
export function attachKeyboardHold(
  el: ScrollerLike,
  { pinned, follow, column }: { pinned: () => boolean; follow: () => void; column?: (Partial<Listens> & object) | null },
  env: HoldEnv = globalThis as unknown as HoldEnv,
): KeyboardHold {
  let until = 0;
  let timer: unknown = null;
  let done = false;
  const clock = () => {
    const t = env.performance?.now?.();
    return typeof t === 'number' && Number.isFinite(t) ? t : Date.now();
  };
  const holding = () => until > clock();
  const later = (fn: () => void, ms: number): unknown => (
    typeof env.setTimeout === 'function' ? env.setTimeout.call(env, fn, ms) : setTimeout(fn, ms)
  );
  const cancel = (id: unknown) => {
    if (typeof env.clearTimeout === 'function') env.clearTimeout.call(env, id);
    else clearTimeout(id as ReturnType<typeof setTimeout>);
  };
  const gone = () => el.isConnected === false;

  // When the hold runs out: one last look, in case the move came after the
  // last event that could have answered it.
  const ends = () => {
    timer = null;
    if (done) return;
    if (gone()) { detach(); return; }
    if (holding()) { timer = later(ends, until - clock()); return; }
    until = 0;
    if (pinned()) follow();
  };
  const hold = (ms: number) => {
    until = Math.max(until, clock() + ms);
    if (timer == null) timer = later(ends, ms);
  };
  const letGo = () => {
    until = 0;
    if (timer != null) { cancel(timer); timer = null; }
  };

  // The composer, or any field beside the transcript, taking focus while
  // the reader is at the newest line.
  const onFocusIn = (event: { target?: unknown }) => {
    const target = event.target;
    if (!isTypingField(target) || el.contains(target)) return;
    if (!pinned()) return;
    hold(KEYBOARD_HOLD_MS);
  };
  const onViewport = () => {
    if (gone()) { detach(); return; }
    if (!holding()) return;
    hold(KEYBOARD_SETTLE_MS);
    if (pinned()) follow();
  };

  // The reader's own hand on the transcript ends the hold at once.
  const hands = ['touchstart', 'wheel', 'pointerdown', 'keydown'];
  for (const type of hands) el.addEventListener(type, letGo, { passive: true });
  const col = column === undefined ? el.parentElement : column;
  col?.addEventListener?.('focusin', onFocusIn, true);
  env.visualViewport?.addEventListener('resize', onViewport, { passive: true });
  if (typeof env.addEventListener === 'function') env.addEventListener.call(env, 'resize', onViewport, { passive: true });

  function detach() {
    if (done) return;
    done = true;
    letGo();
    for (const type of hands) el.removeEventListener(type, letGo);
    col?.removeEventListener?.('focusin', onFocusIn, true);
    env.visualViewport?.removeEventListener('resize', onViewport);
    if (typeof env.removeEventListener === 'function') env.removeEventListener.call(env, 'resize', onViewport);
  }

  return { holding, detach };
}

// The group chat is a classic script: it reaches this as a global.
if (typeof window !== 'undefined') {
  (window as unknown as { UsernodeKeyboardHold?: { attach: typeof attachKeyboardHold } }).UsernodeKeyboardHold = {
    attach: attachKeyboardHold,
  };
}
