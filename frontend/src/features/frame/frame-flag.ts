/**
 * Says on <html> that a screen is drawn in the kit, while its kit page is
 * mounted (`data-<name>`), so app.css can give the screen's own hosts the
 * frame's page area without looking inside them with :has(). Counted per
 * name: one kit page may hand over to the next inside one commit.
 */
import { useEffect } from 'react';

const up = new Map<string, number>();

export function useFrameFlag(name: string, on = true): void {
  useEffect(() => {
    // `on` false: mounted but not the page on show (a tab that is hidden
    // behind another), so the screen's own layout must not be given away.
    if (!on) return undefined;
    up.set(name, (up.get(name) || 0) + 1);
    document.documentElement.setAttribute(`data-${name}`, '');
    return () => {
      const left = (up.get(name) || 1) - 1;
      up.set(name, left);
      if (left <= 0) document.documentElement.removeAttribute(`data-${name}`);
    };
  }, [name, on]);
}
