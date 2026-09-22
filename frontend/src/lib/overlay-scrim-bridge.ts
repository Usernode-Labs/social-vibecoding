import { attachOverlayScrim } from './overlay-scrim.js';

// Kit surfaces are imperative siblings appended by PlatformUI. Preserve that
// order, including nested alerts and sheets, without allocating new z-indexes.
const bridge = ((window as any).UsernodeReact ||= {});
bridge.decorateOverlay = (surface: HTMLElement) => {
  const backdrop = surface?.previousElementSibling;
  if (!surface || !backdrop?.classList.contains('un-backdrop')) return () => {};
  const paint = document.createElement('div');
  paint.className = 'overlay-scrim';
  paint.setAttribute('aria-hidden', 'true');
  surface.after(paint);
  const detach = attachOverlayScrim(surface, backdrop, paint);
  return () => { detach(); paint.remove(); };
};
