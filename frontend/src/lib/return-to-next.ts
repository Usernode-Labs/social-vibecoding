import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * RETURN MOVES TO THE NEXT FIELD; THE LAST FIELD SUBMITS (request #3907).
 *
 * The Homeroom iOS app is dropping WKWebView's keyboard accessory bar, the
 * up/down chevrons and the check mark above the keys (flutter-mobile-app PR
 * #603). Those chevrons were the only way from one field to the next in
 * several forms: Change password, the sign-up code step's password pair,
 * Edit profile, Ask for a change, the secrets editor. Return did nothing
 * there, or submitted the whole form from its first field and let the
 * browser's required check bounce focus back. The first session's "What do
 * you want to make?" (features/first-session/make.tsx, #3904) did it by
 * hand for its two fields; this is that rule, once, for any form:
 *
 *   - Return in a field that has a field after it moves to that field, as
 *     the chevron did. Its `enterKeyHint` should say "next".
 *   - Return in the last field submits, when the form has a primary action
 *     (`submit`), and its `enterKeyHint` says what that action is ("go",
 *     "done", "send"). Inside a real `<form>` with no `submit` given, the
 *     browser's own implicit submission runs, as before. With neither, the
 *     field is blurred, which is what the gone check mark did: it closes
 *     the keyboard.
 *   - A TEXTAREA KEEPS RETURN AS A NEW LINE unless its `enterKeyHint` asks
 *     otherwise. A bio or a description is several lines, and Return there
 *     is how a line is broken. A textarea whose key says "next" (make.tsx's
 *     description) moves on like a single-line field, and Shift+Return is
 *     still a new line in it.
 *   - Return that belongs to something else is left alone: a modifier held
 *     (⌘/Ctrl+Enter submits where a form has it), an IME composition being
 *     committed (`isComposing`, or WebKit's keyCode 229 on the Enter that
 *     ends one), a handler that already took it (`defaultPrevented`), and a
 *     combobox whose suggestions are open (`aria-expanded="true"`).
 *   - Fields that cannot take focus are stepped over: disabled, read-only,
 *     out of the tab order, under `hidden`/`inert`/`aria-hidden`, or not
 *     rendered at all (a step or a row folded away by a class). So which
 *     field is "last" follows what is actually on screen.
 *
 * The handler goes on a CONTAINER (the form, the card, the step) and walks
 * the text fields inside it in document order, so one line wires a whole
 * form and nothing has to be kept in step with the field list. For a React
 * form it is `onKeyDown={returnKeyHandler({ submit })}`; for a block a
 * legacy controller writes by innerHTML it is `attachReturnKey(root, opts)`.
 * Neither renders anything, so either is safe on a node React renders once
 * and a controller fills (the ownership rule in AGENTS.md).
 *
 * Desktop gets the same rule. Enter in a single-line field moving to the
 * next one is the convention a form like this already follows elsewhere,
 * and where a form submitted from its first field the browser bounced
 * focus to the empty one with an error bubble instead.
 */

/** What Return does in a field. */
export type ReturnStep = 'next' | 'submit' | 'native' | 'blur';

export interface ReturnKeyOptions {
  /**
   * The form's primary action, run by Return in its last field. Leave it
   * out inside a `<form>` whose submit button is the action: the browser's
   * implicit submission runs then, disabled button and validation included.
   */
  submit?: () => void;
}

/** What a field is walked by. Buttons, checkboxes and pickers are not. */
export const RETURN_FIELD_SELECTOR = 'input, textarea, select';

/** Input types that take no typed text, so Return neither starts nor lands there. */
const NOT_TEXT = new Set([
  'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden',
]);

/** The keyboard a textarea opts into moving on with. */
const MOVING_HINTS = new Set(['next', 'go', 'done', 'send', 'search', 'previous']);

type FieldLike = {
  tagName?: string;
  type?: string;
  disabled?: boolean;
  readOnly?: boolean;
  tabIndex?: number;
  enterKeyHint?: string;
  form?: unknown;
  value?: string;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
  getClientRects?: () => { length: number };
  focus?: (opts?: FocusOptions) => void;
  blur?: () => void;
  setSelectionRange?: (start: number, end: number) => void;
};

type KeyLike = {
  key?: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  keyCode?: number;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
  currentTarget?: unknown;
  nativeEvent?: { isComposing?: boolean; defaultPrevented?: boolean; keyCode?: number };
  isDefaultPrevented?: () => boolean;
  preventDefault?: () => void;
};

function tagOf(el: FieldLike | null | undefined): string {
  return String(el?.tagName || '').toLowerCase();
}

function hintOf(el: FieldLike): string {
  const attr = typeof el.getAttribute === 'function' ? el.getAttribute('enterkeyhint') : null;
  return String(attr || el.enterKeyHint || '').toLowerCase();
}

/** Whether `el` is a field typed into: a text-like input or a textarea. */
export function isTextField(el: FieldLike | null | undefined): boolean {
  const tag = tagOf(el);
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  return !NOT_TEXT.has(String(el?.type || 'text').toLowerCase());
}

/** Whether Return can land on `el`: a field that is enabled, editable and on screen. */
export function isReturnField(el: FieldLike | null | undefined): boolean {
  if (!el) return false;
  const tag = tagOf(el);
  if (tag !== 'select' && !isTextField(el)) return false;
  if (el.disabled || (tag !== 'select' && el.readOnly)) return false;
  if (typeof el.tabIndex === 'number' && el.tabIndex < 0) return false;
  if (typeof el.closest === 'function' && el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
  return true;
}

/** The fields Return walks inside `root`, in document order. */
export function returnFields(root: ParentNode | { querySelectorAll?: (s: string) => ArrayLike<unknown> } | null | undefined): HTMLElement[] {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  return (Array.from(root.querySelectorAll(RETURN_FIELD_SELECTOR)) as FieldLike[])
    .filter(isReturnField) as unknown as HTMLElement[];
}

/**
 * What Return does, decided from plain facts so it can be tested without a
 * DOM: the key and its modifiers, the field it was pressed in, where that
 * field is among the walkable ones, and what the form offers to submit with.
 * Null means "not ours": the key does what it did before.
 */
export function returnStep(info: {
  key?: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  defaultPrevented?: boolean;
  /** 'input' | 'textarea' | anything else. */
  tag: string;
  /** The input's type; ignored for a textarea. */
  type?: string;
  /** The field's `enterKeyHint`. */
  hint?: string;
  /** The combobox state, when the field has one. */
  expanded?: boolean;
  /** Where the field is among the walkable fields; -1 when it is not one. */
  index: number;
  count: number;
  hasSubmit: boolean;
  inForm: boolean;
}): ReturnStep | null {
  if (info.key !== 'Enter') return null;
  if (info.defaultPrevented) return null;
  if (info.isComposing || info.keyCode === 229) return null;
  if (info.metaKey || info.ctrlKey || info.altKey) return null;
  if (info.expanded) return null;
  const tag = String(info.tag || '').toLowerCase();
  const textarea = tag === 'textarea';
  if (!isTextField({ tagName: tag, type: info.type })) return null;
  if (textarea && (info.shiftKey || !MOVING_HINTS.has(String(info.hint || '').toLowerCase()))) return null;
  if (info.index < 0 || info.index >= info.count) return null;
  if (info.index < info.count - 1) return 'next';
  if (info.hasSubmit) return 'submit';
  // A real form submits itself from a single-line field, as it always has;
  // a textarea's own Enter is a new line, so there it is the blur.
  if (info.inForm && !textarea) return 'native';
  return 'blur';
}

function nativeOf(event: KeyLike): KeyLike {
  return (event.nativeEvent as KeyLike | undefined) || event;
}

/** Put the caret after what is already typed, as the chevron did. */
function focusField(el: FieldLike): void {
  try { el.focus?.(); } catch { /* a field that went away */ }
  if (tagOf(el) === 'select') return;
  const n = typeof el.value === 'string' ? el.value.length : 0;
  if (!n) return;
  // email and number inputs throw on setSelectionRange; leave those as focus put them.
  try { el.setSelectionRange?.(n, n); } catch { /* not a selectable type */ }
}

/**
 * Do what Return should do for `event`, a keydown inside `root`. Returns the
 * step taken, or null when the key was left alone.
 */
export function handleReturnKey(
  event: KeyboardEvent | ReactKeyboardEvent | KeyLike,
  root: unknown = (event as KeyLike).currentTarget,
  opts: ReturnKeyOptions = {},
): ReturnStep | null {
  const e = event as KeyLike;
  if (e.key !== 'Enter') return null;
  const field = e.target as FieldLike | null;
  if (!field || !isTextField(field)) return null;
  const native = nativeOf(e);
  const prevented = !!(native.defaultPrevented || e.defaultPrevented
    || (typeof e.isDefaultPrevented === 'function' && e.isDefaultPrevented()));
  const fields = returnFields(root as ParentNode) as unknown as FieldLike[];
  const index = fields.indexOf(field);
  const step = returnStep({
    key: e.key,
    shiftKey: e.shiftKey,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    isComposing: !!native.isComposing,
    keyCode: typeof e.keyCode === 'number' ? e.keyCode : native.keyCode,
    defaultPrevented: prevented,
    tag: tagOf(field),
    type: field.type,
    hint: hintOf(field),
    expanded: typeof field.getAttribute === 'function' && field.getAttribute('aria-expanded') === 'true',
    index,
    count: fields.length,
    hasSubmit: typeof opts.submit === 'function',
    inForm: !!field.form,
  });
  if (!step || step === 'native') return step;
  e.preventDefault?.();
  if (step === 'next') focusField(fields[index + 1]);
  else if (step === 'submit') opts.submit?.();
  else { try { field.blur?.(); } catch { /* ignore */ } }
  return step;
}

/**
 * A React `onKeyDown` for a form's container: the container is the root,
 * so put it on the element that holds exactly the fields that belong
 * together (a `<form>`, a step, a card).
 */
export function returnKeyHandler(opts: ReturnKeyOptions = {}) {
  return (event: ReactKeyboardEvent<HTMLElement>): void => {
    handleReturnKey(event, event.currentTarget, opts);
  };
}

/** The same, for a block a legacy controller renders. Returns the detach. */
export function attachReturnKey(root: HTMLElement | null | undefined, opts: ReturnKeyOptions = {}): () => void {
  if (!root || typeof root.addEventListener !== 'function') return () => {};
  const onKey = (event: KeyboardEvent) => { handleReturnKey(event, root, opts); };
  root.addEventListener('keydown', onKey);
  return () => root.removeEventListener('keydown', onKey);
}

/**
 * Press a form's button the way a tap would, for a `submit` that has to go
 * through a button a controller wired: only when it is there, enabled and
 * shown. Returns whether it was pressed.
 */
export function pressButton(el: (HTMLElement & { disabled?: boolean }) | null | undefined): boolean {
  if (!el || el.disabled) return false;
  if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
  el.click();
  return true;
}
