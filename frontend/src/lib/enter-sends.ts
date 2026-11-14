import { useEffect, useState } from 'react';

/**
 * ENTER SENDS, SHIFT + ENTER IS A NEW LINE: one rule for a message box.
 *
 * The product had two. A project's channel and the threads of requests and
 * changes (public/js/group-chat.js, public/js/app-view.js) sent on Enter.
 * Messages, the chat with Homeroom bot and its New thread box made Enter a
 * new line and sent only on Cmd/Ctrl + Enter (#5361), with nothing on screen
 * saying so, and a tester's first message to the bot "felt stuck". This is
 * the channels' rule, written once for the React boxes
 * (features/messages/composer.tsx and new-thread.tsx):
 *
 *   - on a device with a keyboard, Enter sends and Shift + Enter is a new
 *     line;
 *   - Cmd/Ctrl + Enter sends anywhere, touch included (#2145): it is the one
 *     way to send from a hardware keyboard on a touch screen;
 *   - on a touch device Enter stays a new line and the button sends: an
 *     on-screen keyboard has no Shift + Enter;
 *   - an Enter that commits an IME composition is never a send
 *     (`isComposing`, or WebKit's keyCode 229 on the Enter that ends one, as
 *     lib/return-to-next.ts reads it).
 *
 * The rule only says the key is a send. Whether there is anything to send
 * (an empty box, a file still uploading, dictation running) stays the box's
 * own check, the same one its button is disabled by. A list that is open
 * over the box (an emoji, a person, a channel) takes its keys first.
 *
 * Touch is `GroupChat._isTouch()`'s reading, `(hover: none)`, so a channel's
 * box and a conversation's agree on every device.
 *
 * NOT under this rule: the Workshop's coding-agent chats
 * (features/dev-chat, features/agent-session). Enter is a new line there
 * because a prompt is often several lines, and Ctrl/Cmd + Enter saves a
 * draft while the agent works.
 */
export const NO_HOVER_QUERY = '(hover: none)';

type WinLike = { matchMedia?: (query: string) => { matches: boolean } };

/** A device whose main pointer cannot hover: a phone or a tablet. */
export function isTouchInput(
  win: WinLike | undefined = typeof window !== 'undefined' ? (window as unknown as WinLike) : undefined,
): boolean {
  try {
    return !!win?.matchMedia?.(NO_HOVER_QUERY).matches;
  } catch {
    return false;
  }
}

/** Whether this keydown sends the message. Pass the native event. */
export function enterSends(
  info: { key?: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; isComposing?: boolean; keyCode?: number },
  touch: boolean = isTouchInput(),
): boolean {
  if (info.key !== 'Enter') return false;
  if (info.isComposing || info.keyCode === 229) return false;
  if (info.metaKey || info.ctrlKey) return true;
  return !info.shiftKey && !touch;
}

/**
 * Whether plain Enter sends on this device, for what a box SAYS about its
 * keys (the hint under it, the send button's tooltip). False on the first
 * render, which is the prerender's and the hydration's, and read in an
 * effect; it follows a keyboard or trackpad being attached or taken away.
 * The key handler does not use this: it asks `enterSends` at the keypress.
 */
export function useEnterSends(): boolean {
  const [sends, setSends] = useState(false);
  useEffect(() => {
    const read = () => setSends(!isTouchInput());
    read();
    let list: MediaQueryList | null = null;
    try {
      list = typeof window.matchMedia === 'function' ? window.matchMedia(NO_HOVER_QUERY) : null;
    } catch {
      list = null;
    }
    if (!list || typeof list.addEventListener !== 'function') return undefined;
    const watched = list;
    watched.addEventListener('change', read);
    return () => watched.removeEventListener('change', read);
  }, []);
  return sends;
}
