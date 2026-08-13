/**
 * One adopt / lift / restore, for all three native-kit surfaces.
 *
 * ── What this replaces ────────────────────────────────────────────────
 *
 * The kit's `modal()`, `sheet()` and `panel()` all work the same way: you
 * hand them a `contentEl` and they PHYSICALLY REPARENT it into their own
 * shell. Everything around that call is bookkeeping the caller has to get
 * right — stamp `platform-<kind>-adopted` so `app.css` stops drawing the
 * legacy chrome, put the node back where it came from when the surface goes
 * away, and undo both if the kit refuses the presentation.
 *
 * Four places had written that bookkeeping out by hand:
 *
 *   * lib/static-modal.ts — the nine dialogs' card lift (`modal`);
 *   * features/dev-console/store.ts — the dev console panel (`sheet`);
 *   * features/header/header-menu-controller.js — the hamburger drawer
 *     (`panel`);
 *   * features/work-drawer/work-drawer.js — the cog drawer (`sheet`).
 *
 * They agreed on the shape and disagreed on the details, which is the failure
 * mode this module exists to end: only one of the four rolled the class back
 * when the kit returned null, only one guarded against a newer presentation
 * stealing the node mid-teardown, and each spelled the class name itself.
 *
 * ── What stayed with the callers ──────────────────────────────────────
 *
 * Deliberately NOT absorbed here, because they differ for real reasons:
 *
 *   * the `hidden` class. The dialogs' roots, the dev console's panel and the
 *     work drawer's panel each mean something different by it, and the
 *     dialogs' is owned by React state through `useStaticModal`.
 *   * the gate. The dialogs adopt whenever the kit is present (`hasKit()`) —
 *     desktop included, which is what the retired `adoptStaticModal` did and
 *     what this must keep doing. The other three adopt only on touch.
 *   * everything each caller does with its own state on the way out; that is
 *     what `onDismiss` is for.
 */

export type KitSurfaceKind = 'modal' | 'sheet' | 'panel';

export interface KitSurfaceHandle {
  el?: HTMLElement | null;
  dismiss(): void;
}

type KitPresent = (opts: {
  contentEl: HTMLElement;
  onDismiss?: () => void;
  [key: string]: unknown;
}) => KitSurfaceHandle | null;

interface KitLike {
  hasKit?(): boolean;
  isTouch(): boolean;
  modal?: KitPresent;
  sheet?: KitPresent;
  panel?: KitPresent;
}

function kit(): KitLike | null {
  const host = globalThis as unknown as { PlatformUI?: KitLike };
  const ui = host.PlatformUI;
  return ui && typeof ui.isTouch === 'function' ? ui : null;
}

export interface AdoptKitSurfaceOptions {
  kind: KitSurfaceKind;
  /** The node handed to the kit, which the kit then reparents. */
  contentEl: HTMLElement;
  /**
   * The node that carries `platform-<kind>-adopted`. Defaults to `contentEl`.
   *
   * The dialogs are the exception: the kit takes the CARD, but the class goes
   * on the modal ROOT, because that is the node `app.css` keys the legacy
   * scrim off.
   */
  adoptedOn?: HTMLElement;
  /**
   * Where `contentEl` goes when the surface is torn down.
   *
   * `'body'` re-appends it to `<body>`, off-screen, which is where the three
   * drawer/sheet panels live between presentations. `'placeholder'` swaps a
   * comment node into its original position and restores it there — the
   * dialogs need that, because their card has to end up back inside its own
   * backdrop for the prerendered tree (and React's picture of it) to hold.
   */
  home: 'body' | 'placeholder';
  /**
   * `'touch'` presents only on touch platforms; `'kit'` presents whenever the
   * kit is loaded, desktop included. See the note above about why the dialogs
   * differ.
   */
  gate: 'touch' | 'kit';
  /** Extra options forwarded to the kit call — `side: 'right'` for panels. */
  present?: Record<string, unknown>;
  /**
   * Size the kit shell to the content's own `max-width` rather than letting
   * it default to 480px. Only the dialogs ask for this; their cards are
   * `max-w-sm` / `max-w-md` / `max-w-lg` and a fixed shell width made the
   * small ones look padded and the large one cramped.
   */
  hugDesignWidth?: boolean;
  /** Ran the moment the kit reports a dismissal, before anything is undone. */
  onDismissStart?: () => void;
  /**
   * Checked after `onDismissStart`. Return false when a NEWER adoption owns
   * `contentEl` — this teardown then leaves the DOM completely alone.
   *
   * One caller: the hamburger drawer, whose teardown is deferred behind an
   * exit spring long enough for a second tap to re-adopt the same node
   * (#977). Restoring it here would yank it straight back out of the panel
   * the user just opened.
   */
  stillOwns?: () => boolean;
  /** Ran after the node is home and the adopted class is off. */
  onDismiss?: () => void;
}

export interface KitAdoption {
  readonly kind: KitSurfaceKind;
  readonly handle: KitSurfaceHandle;
  readonly contentEl: HTMLElement;
  /**
   * Put the node back and drop the adopted class, without telling the kit.
   *
   * Idempotent, and separate from `dismiss()` on purpose: a caller closing
   * the surface itself wants the node back BEFORE the kit runs its exit
   * animation over an empty shell.
   */
  restore(): void;
  /** Ask the kit to tear the surface down. */
  dismiss(): void;
}

function designWidthOf(el: HTMLElement): string | null {
  try {
    const mw = getComputedStyle(el).maxWidth;
    return mw && mw.endsWith('px') ? mw : null;
  } catch {
    /* jsdom and very old engines: fall back to the kit default width */
    return null;
  }
}

/**
 * Present `contentEl` in a native-kit surface, or return null when the kit
 * is absent, gated out, or refuses — in which case nothing has been touched
 * and the caller falls through to its own web presentation.
 */
export function adoptKitSurface(options: AdoptKitSurfaceOptions): KitAdoption | null {
  const ui = kit();
  if (!ui) return null;
  if (options.gate === 'kit') {
    if (typeof ui.hasKit !== 'function' || !ui.hasKit()) return null;
  } else if (!ui.isTouch()) {
    return null;
  }
  const presentFn = ui[options.kind];
  if (typeof presentFn !== 'function') return null;

  const { contentEl } = options;
  const flagEl = options.adoptedOn || contentEl;
  const adoptedClass = `platform-${options.kind}-adopted`;

  // Measured BEFORE the card is neutralized — `platform-modal-card` is what
  // strips its own max-width, so reading afterwards reads the kit's.
  const designWidth = options.hugDesignWidth ? designWidthOf(contentEl) : null;

  // The kit shell already draws surface, radius, shadow and padding; stacking
  // the card's own on top gave double borders and doubled whitespace.
  if (options.kind === 'modal') contentEl.classList.add('platform-modal-card');

  let placeholder: Comment | null = null;
  if (options.home === 'placeholder') {
    placeholder = document.createComment(`platform-${options.kind}-home`);
    contentEl.parentNode?.replaceChild(placeholder, contentEl);
  }
  flagEl.classList.add(adoptedClass);

  // Whether the kit ever took the node. Until it has, a rollback must not
  // re-home `contentEl` — it never left.
  let presented = false;
  let undone = false;
  const undo = () => {
    if (undone) return;
    undone = true;
    if (options.kind === 'modal') contentEl.classList.remove('platform-modal-card');
    if (placeholder) {
      if (placeholder.parentNode) placeholder.parentNode.replaceChild(contentEl, placeholder);
    } else if (presented) {
      document.body.appendChild(contentEl);
    }
    flagEl.classList.remove(adoptedClass);
  };

  const handle = presentFn.call(ui, {
    ...options.present,
    contentEl,
    onDismiss: () => {
      options.onDismissStart?.();
      if (options.stillOwns && !options.stillOwns()) return;
      undo();
      options.onDismiss?.();
    },
  });

  if (!handle) {
    undo();
    return null;
  }
  presented = true;
  if (handle.el && designWidth) {
    handle.el.style.width = `min(${designWidth}, calc(100vw - 32px))`;
  }

  return {
    kind: options.kind,
    handle,
    contentEl,
    restore: undo,
    dismiss: () => handle.dismiss(),
  };
}
