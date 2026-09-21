import { useLayoutEffect, useRef } from 'react';
import { attachOverlayScrim } from './overlay-scrim.js';

/** The owner renders its decoration; legacy scripts never insert React nodes. */
export function OverlayScrim({ panelId, backdropId }: { panelId: string; backdropId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => attachOverlayScrim(
    document.getElementById(panelId), document.getElementById(backdropId), ref.current,
  ), [panelId, backdropId]);
  return <div ref={ref} className="overlay-scrim" aria-hidden="true" />;
}
