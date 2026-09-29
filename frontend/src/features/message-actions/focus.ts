/**
 * Whether a Reply should put the caret in the message box (#2387 follow-up).
 *
 * Yes where there is a mouse or trackpad, which as a rule means a hardware
 * keyboard: the reader clicked Reply and the next thing they do is type. No
 * on a touch-only phone, where focusing the box pops the on-screen keyboard
 * over the message they were replying to — they tap the box when ready.
 * `any-pointer` rather than `pointer`, so a tablet with a trackpad attached
 * counts as a desktop.
 */
export function wantsKeyboardFocus(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(any-pointer: fine)').matches;
  } catch {
    return false;
  }
}
