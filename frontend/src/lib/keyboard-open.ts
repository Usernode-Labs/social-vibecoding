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
 *
 * ── And where the visible page is, while it is open ──────────────────
 *
 * iPhone 17 simulator, iOS 26 Safari, 5 Oct 2026: the sign-in sheet's
 * password step had its Sign in button behind the keys and its password
 * field half under the keyboard's floating bar; the first session's make
 * screen had "Make it" under that bar. Both are full-screen `fixed` surfaces,
 * which Safari leaves at the full height of the page with the keys over
 * their foot, and which iOS PANS up (the visual viewport's offsetTop) to
 * reveal a tapped field, wordmark and all. The kit's `--un-kb-inset` is the
 * cover alone, and its pan reset (attachKeyboardAvoidance's settled pin)
 * only runs in a bounded shell, which a phone browser's paged document
 * (#1518) is not.
 *
 * So while the class is on this also publishes the foot of the band of the
 * layout viewport the reader can actually see: `--platform-kb-cover`, how
 * much of the layout viewport is out of sight below the visual viewport (the
 * keys, and in Safari 26 the address pill and the form bar floating over
 * them: the visual viewport ends above all three). Its head is the pan,
 * which ./visual-viewport.ts already publishes as `--platform-vv-top`. A
 * surface that pads itself by the two (`.platform-kb-surface`,
 * `.platform-kb-sheet` in app.css) sits exactly in the band however the host
 * made room: covered (Safari; Chrome on Android), panned or not, or resized
 * (the app's web view, where both are 0). Written in the viewport's own
 * events, with the class, and 0px the moment the class comes off.
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
/** How much of the layout viewport's foot is out of sight while the keyboard is open (px, on <html>). */
export const KB_COVER_VAR = '--platform-kb-cover';

type FocusTarget = {
  tagName?: string;
  type?: string;
  readOnly?: boolean;
  disabled?: boolean;
  isContentEditable?: boolean;
  shadowRoot?: { activeElement?: FocusTarget | null } | null;
  blur?: () => void;
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

/** The element focus really sits in, following shadow roots down: what
 *  describeFocus classifies, and the element the tap-outside checks run
 *  against. */
export function focusedElement(el: FocusTarget): FocusTarget {
  let node = el;
  while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
  return node ?? null;
}

/** The kit's descriptor for a focused element (native.js `describe`): focus
 *  inside a shadow root is reported as its host, so follow it down. */
export function describeFocus(el: FocusTarget, body?: unknown, root?: unknown): FieldDescriptor | null {
  const node = focusedElement(el);
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

/**
 * The band of the layout viewport the reader can see with the keyboard up:
 * `pan` is the visual viewport's offset from the layout viewport's top (iOS
 * moving the page up to reveal a field), `cover` what is out of sight below
 * the band. `layout` is the layout viewport's height, the larger of
 * `innerHeight` and `documentElement.clientHeight` as the kit takes it
 * (native.js `layoutViewportHeight`: iOS collapses `innerHeight` to the
 * visual viewport). Zero when nothing is readable or the page is
 * pinch-zoomed, where a small visual viewport is the zoom, not keys.
 */
export function visibleBand(input: {
  layout: number;
  vv?: (ViewportLike & { offsetTop?: number }) | null;
}): { pan: number; cover: number } {
  const none = { pan: 0, cover: 0 };
  const vv = input.vv;
  const layout = Number(input.layout);
  if (!vv || !Number.isFinite(layout) || layout <= 0) return none;
  const scale = vv.scale == null ? 1 : Number(vv.scale);
  if (!Number.isFinite(scale) || Math.abs(scale - 1) > 0.01) return none;
  const height = Number(vv.height);
  if (!Number.isFinite(height) || height <= 0) return none;
  const top = Number(vv.offsetTop) || 0;
  const pan = Math.max(0, Math.round(top));
  const cover = Math.max(0, Math.round(layout - pan - height));
  return { pan, cover };
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

/** ── A tap outside the field puts the keyboard away ───────────────────
 *
 * With the keys up, a tap anywhere on the screen outside the field being
 * typed in now blurs it, so the keyboard starts down (evan_t1006, 6 Oct
 * 2026). The tap is not spent on that: it is never cancelled, and the
 * thing it was aimed at still happens. Taps that belong to the field keep
 * it: the field itself, the composer controls around it, and the
 * suggestion menus that accept a press while keeping the composer
 * focused. */

type ZoneNode = {
  contains?: (node: unknown) => boolean;
  closest?: (selector: string) => ZoneNode | null;
} | null | undefined;

/** Whether a press at `target` should take the keyboard down from the
 *  keyboard-holding field `focused`. False — the keyboard stays — when the
 *  tap lands in the field itself, in its own composer (the form around it,
 *  and where a composer is not a form, its own surface: Messages'), or in
 *  a suggestion menu that belongs to it. An unreadable target keeps the
 *  field: a press that cannot be placed is left to the browser. */
export function tapOutsideField(target: unknown, focused: unknown): boolean {
  if (!target || typeof target !== 'object' || !focused) return false;
  const at = target as ZoneNode;
  const field = focused as ZoneNode;
  // The @mention, #reference and :emoji menus accept the press on
  // mousedown with preventDefault() to keep the composer focused; an
  // explicit blur would undo exactly that. A label's press puts focus in
  // the control it names, at its click.
  if (typeof at.closest === 'function'
    && (at.closest('.gc-mention-menu') || at.closest('[data-feed-mention-menu]') || at.closest('label'))) return false;
  const inside = (host: ZoneNode, node: ZoneNode) => (
    !!host && (host === node || (typeof host.contains === 'function' && !!host.contains(node)))
  );
  // The field itself: the tap places the caret, natively.
  if (inside(field, at)) return false;
  // The field's own composer: Send, the attach button and every composer
  // control, whose presses already hold focus by design. A composer that
  // is a form answers closest('form'); Messages' is a div, so its own
  // surface stands in for one.
  if (typeof field.closest === 'function') {
    const zone = field.closest('form') || field.closest('.messages-composer');
    if (inside(zone, at)) return false;
  }
  return true;
}

type DocLike = {
  activeElement: unknown;
  body?: unknown;
  documentElement: {
    clientHeight?: number;
    classList: Pick<DOMTokenList, 'toggle'>;
    style?: Pick<CSSStyleDeclaration, 'setProperty'> | null;
  };
  addEventListener(
    type: string,
    fn: (event: { relatedTarget?: unknown; target?: unknown }) => void,
    options?: boolean | { capture?: boolean; passive?: boolean },
  ): void;
};
type WinLike = {
  innerHeight?: number;
  innerWidth?: number;
  visualViewport?: (ViewportLike & { offsetTop?: number } & Pick<EventTarget, 'addEventListener'>) | null;
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

  // The cover last written, so a viewport event that moved nothing writes
  // nothing.
  let cover = 0;
  const writeCover = (next: number) => {
    if (next === cover) return;
    cover = next;
    try {
      root.style?.setProperty(KB_COVER_VAR, `${next}px`);
    } catch { /* a surface without it keeps the kit's own avoidance */ }
  };
  const readCover = () => visibleBand({
    layout: Math.max(Number(win.innerHeight) || 0, Number(root.clientHeight) || 0),
    vv: win.visualViewport,
  }).cover;

  const write = (next: boolean) => {
    // While open the cover follows every viewport event; it is 0 the moment
    // the class comes off, so a surface comes down with the keys.
    writeCover(next ? readCover() : 0);
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
    // wait for its click (and the band stays where it was with them).
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
  // The pan: iOS reports it in its own event, about 30ms after the resize.
  win.visualViewport?.addEventListener('scroll', apply, { passive: true });
  doc.addEventListener('focusin', apply, true);
  doc.addEventListener('focusout', onFocusOut, true);
  doc.addEventListener('pointerdown', onPress, quiet);
  doc.addEventListener('touchstart', onPress, quiet);
  doc.addEventListener('pointerup', onRelease, quiet);
  doc.addEventListener('touchend', onRelease, quiet);
  doc.addEventListener('pointercancel', onEnd, quiet);
  doc.addEventListener('touchcancel', onEnd, quiet);
  doc.addEventListener('click', onEnd, true);

  // A tap outside the field takes the keyboard down, at the first touch —
  // so a scroll that begins there closes it too. Joined to the press
  // handlers above, after them: the blur this makes is a blur during a
  // press, and the class waits for the tap's click, which is never
  // cancelled — the thing the tap was aimed at still happens.
  const onOutsideTap = (event: { target?: unknown }) => {
    if (!event || !event.target) return;
    const field = focusedElement(doc.activeElement as FocusTarget);
    if (!canHoldKeyboard(field, win.unNative, doc.body, root)) return;
    // A hop into another field: the native press moves focus and the
    // keyboard follows it. Blurring first would put the keys down only to
    // raise them again.
    if (canHoldKeyboard(event.target as FocusTarget, win.unNative, doc.body, root)) return;
    if (!tapOutsideField(event.target, field)) return;
    try { field?.blur?.(); } catch { /* a field that refuses keeps the keys */ }
  };
  doc.addEventListener('pointerdown', onOutsideTap, quiet);
  doc.addEventListener('touchstart', onOutsideTap, quiet);
  apply();
  return apply;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  initKeyboardOpen(document as unknown as DocLike, window as unknown as WinLike);
}
