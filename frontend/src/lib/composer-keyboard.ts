import { useCallback, useEffect, useState, type RefCallback } from 'react';

type KeyboardAvoidanceHandle = { detach?: () => void } | null | undefined;

type NativeKeyboardKit = {
  attachKeyboardAvoidance?: (
    scroller: HTMLElement,
    options: { topEl?: HTMLElement },
  ) => KeyboardAvoidanceHandle;
};

/** Keep a Messages composer above Safari's settled keyboard viewport. */
export function useComposerKeyboardAvoidance<T extends HTMLElement>(
  scroller: { current: T | null },
): RefCallback<T> {
  const [element, setElement] = useState<T | null>(null);
  const setScroller = useCallback<RefCallback<T>>((next) => {
    scroller.current = next;
    setElement(next);
  }, [scroller]);

  useEffect(() => {
    if (!element) return;
    const kit = (window as Window & { unNative?: NativeKeyboardKit }).unNative;
    if (typeof kit?.attachKeyboardAvoidance !== 'function') return;

    const header = document.getElementById('platform-header');
    const handle = kit.attachKeyboardAvoidance(element, { topEl: header || undefined });
    if (typeof handle?.detach !== 'function') return;

    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      handle.detach?.();
    };
  }, [element]);

  return setScroller;
}
