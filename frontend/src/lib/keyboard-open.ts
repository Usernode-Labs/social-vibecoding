/**
 * THE KEYBOARD IS UP IN THE HOMEROOM APP TOO (first-session run, 4 Oct 2026).
 *
 * In the iOS app, Messages with the on-screen keyboard open drew the Resume
 * strip and the tab bar ON the keyboard, over the bottom of the composer, half
 * covering Send. Mobile Safari never shows that: there the kit's tracker
 * (usernode-native/v1/native.js) sees the keys cover the page, sets
 * `html.un-kb`, and app.css takes the bar and the strip away
 * (`html.un-kb #platform-tabs`, `html.un-kb #platform-parked`).
 *
 * The app gets there differently. It is a Flutter shell around a WKWebView,
 * and the Scaffold that holds the web view resizes it to end at the keyboard
 * (Flutter's default `resizeToAvoidBottomInset`; flutter-mobile-app,
 * lib/features/dapps/dapp_webview_screen.dart). So the PAGE gets shorter and
 * nothing covers it: the layout viewport and the visual viewport shrink
 * together, the kit's `layout - visualViewport.height` stays 0, and `un-kb`
 * never comes on. The bar, fixed to the foot of a page that now ends at the
 * keys, sits on them, and every screen still reserves its band. The Android
 * app's web view is resized the same way.
 *
 * So this asks the question in the page's own terms: is a field that raises
 * the keyboard focused, AND is the visible page shorter than it is at rest by
 * more than any toolbar could account for? That is the keyboard however the
 * host made room for it: covered (Safari, Chrome; the visual viewport shrinks)
 * or resized (the app's web view; everything shrinks). It publishes the answer
 * as `platform-kb-open` on <html>, on a phone layout only, and app.css hides
 * the bar and the strip on it and drops the band they reserve, so the composer
 * sits directly on the keyboard, the usual iOS arrangement. They come back
 * when it closes.
 *
 * ── Shorter than at REST, not shorter than the screen ────────────────
 *
 * "At rest" is the tallest the visible page has been at this width. Safari's
 * toolbar grows and shrinks the page by well under 150px; a phone's keyboard
 * takes more than 200. A width change (rotation) starts the measure again.
 * A focused field with the page NOT shorter is not the keyboard either: a
 * field focused from code gets no keyboard on iOS until it is tapped, and a
 * hardware keyboard raises only a slim bar, and in both the tab bar stays.
 *
 * ── Off the moment the field lets go ─────────────────────────────────
 *
 * On a blur that takes focus nowhere a keyboard can live, the class comes off
 * IN the event, as the kit clears its inset (native.js `onFocusOut`): the
 * keys start down at once, and the bar should come back with them rather
 * than when the host finally reports the taller page. A hop from one field
 * to another keeps the keyboard, so `relatedTarget` decides.
 *
 * ── Except under a finger: then it waits for the click ───────────────
 *
 * Production run, 5 Oct 2026, the iOS app, a project's Discussion: with the
 * keyboard up, a tap on the group chat's Send closed the keyboard and sent
 * nothing. The tap's mousedown blurred the field, the class came off in that
 * blur, the bar and the strip came back, and the composer fell by the
 * keyboard's height before the click was dispatched, so the click landed on
 * nothing. Every composer's Send now keeps the field focused through the
 * press (`onMouseDown` prevents the default, as Messages' always did). This
 * is the net under every other button pressed with the keyboard up: a blur
 * during a press (a touch or pointer down in the last PRESS_WINDOW_MS,
 * counting its release, that has not yet ended in a click or a cancel) leaves
 * the class on until that click has been dispatched, or CLICK_WAIT_MS at the
 * most, and then reads the page again, so focus that moved to another field
 * keeps it. The keyboard's Done (the ✓ above the keys) is no press in the
 * page, and a tap on empty space ends in its click in the same moment, so
 * the bars still come back with the keys there.
 *
 * Whether a focused element can be holding the keyboard is the kit's own
 * classifier (`unNative.physics.keyboardCanBeUp`), read at call time, so
 * this and `un-kb` never disagree about what a text field is.
 */

/** The class on <html> while the on-screen keyboard is open (phone only). */
export const KB_OPEN_CLASS = 'platform-kb-open';
/** The phone layout, the same breakpoint as the bar and the strip in app.css,
 *  on a touch screen (where an on-screen keyboard is). */
export const PHONE_QUERY = '(max-width: 767px) and (pointer: coarse)';
/** How much shorter than at rest the page must be to be the keyboard (px). */
export const KB_SHRINK_MIN = 150;
/** A press this recent (its touch, or its release) may still be on its way
 *  to a click (ms). */
export const PRESS_WINDOW_MS = 500;
/** The longest a blur during a press keeps the class on for its click (ms). */
export const CLICK_WAIT_MS = 350;

type FocusTarget = {
  tagName?: string;
  type?: string;
  readOnly?: boolean;
  disabled?: boolean;
  isContentEditable?: boolean;
  shadowRoot?: { activeElement?: FocusTarget | null } | null;
} | null | undefined;

type FieldDescriptor = {
  tag: string;
  type?: string;
  readOnly: boolean;
  disabled: boolean;
  contentEditable: boolean;
};

type KitLike = {
  physics?: { keyboardCanBeUp?: (input: FieldDescriptor | null) => boolean } | null;
} | null | undefined;

/** The kit's descriptor for a focused element (native.js `describe`): focus
 *  inside a shadow root is reported as its host, so follow it down. */
export function describeFocus(el: FocusTarget, body?: unknown, root?: unknown): FieldDescriptor | null {
  let node = el;
  while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
  if (!node || node === body || node === root || !node.tagName) return null;
  return {
    tag: node.tagName,
    type: node.type,
    readOnly: !!node.readOnly,
    disabled: !!node.disabled,
    contentEditable: !!node.isContentEditable,
  };
}

/** Whether `el`, focused, can be holding the on-screen keyboard up. False
 *  without the kit: nothing that keys off the keyboard works without it. */
export function canHoldKeyboard(el: FocusTarget, kit: KitLike, body?: unknown, root?: unknown): boolean {
  const classify = kit?.physics?.keyboardCanBeUp;
  if (typeof classify !== 'function') return false;
  try {
    return !!classify(describeFocus(el, body, root));
  } catch {
    return false;
  }
}

type ViewportLike = { height: number; scale?: number };

/** The visible page's height: the smallest of the window, the layout
 *  viewport and (unzoomed) the visual viewport. Whichever of them the host
 *  shrinks for the keyboard, this shrinks with it. 0 when nothing is
 *  readable. */
export function visibleHeight(input: {
  innerHeight?: number;
  clientHeight?: number;
  vv?: ViewportLike | null;
}): number {
  const heights: number[] = [];
  const add = (n: unknown) => {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0) heights.push(v);
  };
  add(input.innerHeight);
  add(input.clientHeight);
  const vv = input.vv;
  if (vv) {
    const scale = vv.scale == null ? 1 : Number(vv.scale);
    // A pinch-zoomed visual viewport is small because of the zoom, not keys.
    if (Number.isFinite(scale) && Math.abs(scale - 1) <= 0.01) add(vv.height);
  }
  return heights.length ? Math.round(Math.min(...heights)) : 0;
}

/** The decision. `resting` is the tallest `height` seen at this width. */
export function keyboardOpen(input: {
  phone: boolean;
  focused: boolean;
  height: number;
  resting: number;
}): boolean {
  if (!input.phone || !input.focused) return false;
  if (!(input.height > 0) || !(input.resting > 0)) return false;
  return input.resting - input.height >= KB_SHRINK_MIN;
}

type DocLike = {
  activeElement: unknown;
  body?: unknown;
  documentElement: {
    clientHeight?: number;
    classList: Pick<DOMTokenList, 'toggle'>;
  };
  addEventListener(
    type: string,
    fn: (event: { relatedTarget?: unknown }) => void,
    options?: boolean | { capture?: boolean; passive?: boolean },
  ): void;
};
type WinLike = {
  innerHeight?: number;
  innerWidth?: number;
  visualViewport?: (ViewportLike & Pick<EventTarget, 'addEventListener'>) | null;
  matchMedia?: (query: string) => { matches: boolean };
  addEventListener(type: string, fn: () => void, options?: unknown): void;
  unNative?: KitLike;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  performance?: { now(): number } | null;
};

/**
 * Keep `platform-kb-open` on <html> current. Re-reads on every resize of the
 * window or the visual viewport (the keyboard's own reports, and the app's
 * web view being resized) and on focus moving in; clears on a blur to
 * nowhere, or, when the blur came from a press, once that press's click has
 * been dispatched. Writes only on a change. Returns the apply step, for tests.
 */
export function initKeyboardOpen(doc: DocLike, win: WinLike): () => void {
  let restWidth = -1;
  let resting = 0;
  let open = false;
  const root = doc.documentElement;

  const now = () => {
    try {
      const t = win.performance?.now?.();
      if (typeof t === 'number' && Number.isFinite(t)) return t;
    } catch { /* fall through */ }
    return Date.now();
  };
  const later = (fn: () => void, ms: number): unknown => (
    typeof win.setTimeout === 'function' ? win.setTimeout(fn, ms) : setTimeout(fn, ms)
  );
  const cancel = (id: unknown) => {
    if (typeof win.clearTimeout === 'function') win.clearTimeout(id);
    else clearTimeout(id as ReturnType<typeof setTimeout>);
  };

  // The press in flight: when it last moved (down, or up), and whether it
  // has ended in its click or a cancel. Touch and pointer events both report
  // one touch, so the second of each pair just restates the first.
  let press: { at: number; done: boolean } | null = null;
  // A clear held back for a press's click. `apply` writes no false while it
  // is held; `settle` lets go and reads the page again.
  let held: unknown = null;
  let holding = false;

  const write = (next: boolean) => {
    if (next === open) return;
    open = next;
    root.classList.toggle(KB_OPEN_CLASS, next);
  };

  const measure = () => {
    const height = visibleHeight({
      innerHeight: win.innerHeight,
      clientHeight: root.clientHeight,
      vv: win.visualViewport,
    });
    const width = Number(win.innerWidth) || 0;
    if (width !== restWidth) {
      restWidth = width;
      resting = 0;
    }
    if (height > resting) resting = height;
    return height;
  };

  const phone = () => {
    try {
      return !!win.matchMedia?.(PHONE_QUERY).matches;
    } catch {
      return false;
    }
  };

  const apply = () => {
    const height = measure();
    const next = keyboardOpen({
      phone: phone(),
      focused: canHoldKeyboard(doc.activeElement as FocusTarget, win.unNative, doc.body, root),
      height,
      resting,
    });
    // The keys going down resize the page too; under a press, the bars still
    // wait for its click.
    if (!next && holding) return;
    write(next);
  };

  const settle = () => {
    if (!holding) return;
    holding = false;
    cancel(held);
    held = null;
    apply();
  };

  const pressing = () => !!press && !press.done && now() - press.at <= PRESS_WINDOW_MS;
  const onPress = () => { press = { at: now(), done: false }; };
  const onRelease = () => { if (press && !press.done) press.at = now(); };
  // The press ends in its click, or in a cancel (a scroll took it), which
  // has no click coming. The click is heard in capture, before its own
  // handlers, so the settle is queued to run after the whole dispatch, the
  // form's submit included.
  const onEnd = () => {
    if (press) press.done = true;
    if (holding) later(settle, 0);
  };

  // A hop to another field keeps the keyboard, and its focusin re-reads;
  // during the focusout itself the document has no active element yet.
  const onFocusOut = (event: { relatedTarget?: unknown }) => {
    if (canHoldKeyboard(event.relatedTarget as FocusTarget, win.unNative, doc.body, root)) return;
    if (open && pressing()) {
      if (!holding) {
        holding = true;
        held = later(settle, CLICK_WAIT_MS);
      }
      return;
    }
    write(false);
  };

  const quiet = { capture: true, passive: true };
  win.addEventListener('resize', apply, { passive: true });
  win.visualViewport?.addEventListener('resize', apply, { passive: true });
  doc.addEventListener('focusin', apply, true);
  doc.addEventListener('focusout', onFocusOut, true);
  doc.addEventListener('pointerdown', onPress, quiet);
  doc.addEventListener('touchstart', onPress, quiet);
  doc.addEventListener('pointerup', onRelease, quiet);
  doc.addEventListener('touchend', onRelease, quiet);
  doc.addEventListener('pointercancel', onEnd, quiet);
  doc.addEventListener('touchcancel', onEnd, quiet);
  doc.addEventListener('click', onEnd, true);
  apply();
  return apply;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  initKeyboardOpen(document as unknown as DocLike, window as unknown as WinLike);
}
