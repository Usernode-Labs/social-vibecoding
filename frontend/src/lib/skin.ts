/**
 * The look the device has chosen, for an island that draws differently
 * under one of them.
 *
 * `window.Skin` (frontend/src/head.html) keeps the choice on the device
 * and sets `data-skin` on <html> before first paint; app.css draws a look
 * from that attribute alone. An island that also CHANGES ITS MARKUP under
 * a look must not read it during its first render: the prerendered
 * document is skin-agnostic, so a first render that differed would be a
 * hydration mismatch — a console error, which fails proposal checks. So
 * `useSkin()` answers 'standard' until the island has mounted, then the
 * live value, and follows later changes (the Settings switch, another
 * tab) through `window.Skin.onChange`. One frame of the standard markup
 * before the look's is the price, and it is paid only on devices that
 * switched a look on.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * The looks of the one frame: every one draws the same frame (title, one
 * sentence, one action, labelled groups of one row) with its own tokens,
 * typeface and a few rules in app.css ("THE FRAME'S LOOKS"). Paper is the
 * last of them, and since 20 Nov 2026 no menu offers it and the head
 * neither stores nor pins it, so nothing reaches the frame; the list stays
 * for the screens that still carry a frame drawing, until that is removed.
 */
export const FRAME_SKINS = ['paper'] as const;
export type FrameSkin = typeof FRAME_SKINS[number];
export type Skin = 'standard' | 'brand' | FrameSkin;

/**
 * Every look the Look menu offers after Standard, in its order. 'brand' is
 * "Paper, simplified, with brand styling", which keeps the standard pages.
 * ('wip', "Homeroom brand kit (WIP)", was removed on 24 Nov 2026: the
 * standard look took what was tried on it.) It is the head's SKINS, and the
 * option values of Settings › Experimental › Look and of the look picker.
 */
export const MENU_SKINS = ['brand'] as const;
export type MenuSkin = typeof MENU_SKINS[number];

/**
 * True where Home and the Communities page are drawn with the kit's pieces
 * (the one-column page, the pinned projects card, Recent threads, the
 * challenge posters; the grid of pinned communities and the joined list): the
 * standard look, since 20 Nov 2026. The first render's 'standard' is it, so
 * the prerendered document and the hydrated one agree.
 */
export function isKitHome(skin: Skin): boolean {
  return skin === 'standard';
}

/** True for a look that draws a page in the frame; 'brand' keeps the standard pages. */
export function isFrameSkin(skin: Skin): skin is FrameSkin {
  return (FRAME_SKINS as readonly string[]).includes(skin);
}

declare global {
  interface Window {
    Skin?: {
      get(): Skin;
      set(skin: Skin): void;
      apply(): void;
      onChange(fn: () => void): void;
    };
  }
}

const SKINS: readonly Skin[] = ['standard', ...MENU_SKINS];

/** The Look menu's entries, in its order: Standard, then MENU_SKINS. */
export const LOOK_CHOICES: readonly Skin[] = SKINS;

/** The device's look right now; 'standard' when the head module is absent. */
export function currentSkin(): Skin {
  if (typeof window === 'undefined') return 'standard';
  try {
    const got = window.Skin?.get?.();
    return got !== undefined && SKINS.includes(got) ? got : 'standard';
  } catch {
    return 'standard';
  }
}

/** 'standard' on the first render, the live look after mount. */
export function useSkin(): Skin {
  const [skin, setSkin] = useState<Skin>('standard');
  useEffect(() => {
    setSkin(currentSkin());
    // The head module keeps its listeners for the page's life; there is
    // nothing to unsubscribe, and a stale setter on an unmounted island is
    // a no-op React tolerates.
    window.Skin?.onChange?.(() => setSkin(currentSkin()));
  }, []);
  return skin;
}

// One listener on window.Skin for every reader below, however many there
// are: the head module keeps what it is handed for the page's life.
const skinReaders = new Set<() => void>();
let skinHeard = false;
export function subscribeSkin(onChange: () => void): () => void {
  skinReaders.add(onChange);
  if (!skinHeard && typeof window !== 'undefined' && window.Skin?.onChange) {
    skinHeard = true;
    window.Skin.onChange(() => { for (const reader of [...skinReaders]) reader(); });
  }
  return () => { skinReaders.delete(onChange); };
}

/**
 * The look, for something drawn many times over (a message row, a face):
 * 'standard' while a prerendered island hydrates, as useSkin answers, and
 * the device's look at once for anything mounted after that, so a row that
 * arrives later is never drawn in the standard markup first. All readers
 * share one listener and each lets go of it when it unmounts.
 */
export function useLiveSkin(): Skin {
  return useSyncExternalStore(subscribeSkin, currentSkin, () => 'standard');
}
