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
 * The looks of the one frame, in the order the 2026-11-06 screen tour gives
 * them (five of its nine: Brand kit, Workbench, Today and Playground were
 * retired on 12 Nov 2026, and a device that had stored one of them reads as
 * the standard look, here and in the head): every one draws the same frame (title, one sentence, one action,
 * labelled groups of one row) with its own tokens, typeface and a few rules
 * in app.css ("THE FRAME'S LOOKS"). The head's SKINS is 'brand' and these.
 */
export const FRAME_SKINS = ['glass', 'paper', 'pastel', 'mosaic', 'sunrise'] as const;
export type FrameSkin = typeof FRAME_SKINS[number];
export type Skin = 'standard' | 'brand' | FrameSkin;

/** True for a look that draws a page in the frame; New look ('brand') keeps the standard pages. */
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

const SKINS: readonly Skin[] = ['standard', 'brand', ...FRAME_SKINS];

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
