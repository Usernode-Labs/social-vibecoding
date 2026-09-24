/**
 * The two halves of the Channels section (#2967): the viewer's own apps,
 * headed "Your apps", then the other app channels behind a toggle.
 *
 * Which channel belongs where is ./inbox.ts's (`buildInbox` groups them,
 * `collapseChannels` folds them); this file is only what the list draws
 * between the rows, kept apart from the screen so a test can render it.
 */

import { useCallback, useEffect, useState } from 'react';

import { ChevronDownIcon } from '@/components/ui/icons';

/** The subheading over the viewer's own app channels. */
export function YourAppsHead() {
  return <h4 className="messages-section-head messages-group-head" data-inbox-group="yours">Your apps</h4>;
}

/**
 * The disclosure. A real button with `aria-expanded`, so a screen reader
 * hears the state and the label can say what a tap will do.
 */
export function MoreChannelsToggle({ expanded, hidden, onToggle }: {
  expanded: boolean;
  hidden: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      id="messages-more-channels"
      className="messages-more-toggle"
      aria-expanded={expanded}
      data-more-channels={hidden}
      onClick={onToggle}
    >
      <span>{expanded ? 'Show less' : `Show more (${hidden})`}</span>
      <ChevronDownIcon className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
    </button>
  );
}

function storageKey(): string {
  const id = (window as unknown as { App?: { user?: { id?: number } } }).App?.user?.id;
  return `messages.moreChannels.${id == null ? 'anon' : id}`;
}

/**
 * Whether the other channels are shown, remembered per viewer on this device.
 *
 * Collapsed on the first render, always — that is what the prerendered
 * document has — and the remembered value is read after mount, so hydration
 * never disagrees with the server. Storage can be missing or throw (a
 * private window, blocked site data); the toggle then just forgets.
 */
export function useMoreChannelsExpanded(): [boolean, () => void] {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(storageKey()) === '1') setExpanded(true);
    } catch { /* no storage: stay collapsed */ }
  }, []);
  const toggle = useCallback(() => {
    setExpanded((was) => {
      const next = !was;
      try {
        if (next) window.localStorage.setItem(storageKey(), '1');
        else window.localStorage.removeItem(storageKey());
      } catch { /* no storage: this visit only */ }
      return next;
    });
  }, []);
  return [expanded, toggle];
}
