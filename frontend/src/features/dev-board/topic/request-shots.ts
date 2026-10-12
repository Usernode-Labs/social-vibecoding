/**
 * The screenshots in a request's words (request-head.tsx `RequestWords`).
 *
 * Two requests from the board, both about the pictures a C comment posts:
 *
 *   - #4482: the comment's pin is DATA on its screenshot's link (the
 *     `#pin=…&note=…` fragment, ../../comment-pin/pin-data.ts), not pixels in
 *     it. Here every picture that carries one gets the comment drawn over it
 *     as a layer, the pin's square corner on the point and the words in a
 *     card beside it, and a small "Hide comment" button on the picture's
 *     corner that takes the layer away and puts it back. The picture itself
 *     stays clean. Everyone sees this.
 *   - #4481: the blocks that hold a screenshot are lifted out of the words,
 *     so the fold at four lines folds only the words and the pictures are
 *     always shown under them. Everyone sees this too.
 *
 * Both work on the markup DevChat.renderMarkdown built and sanitised: it is
 * parsed with DOMParser (an inert document: nothing in it loads or runs),
 * changed with DOM calls, and written back out. The note is only ever a text
 * node, and the layer's position is built from two numbers. Where there is
 * nothing to change, or no parser (a server render), the markup is returned
 * exactly as it came in, so a request with neither is drawn as it always was.
 */

import { t as translate } from '../../../lib/i18n/runtime';
import { readPins, type PinData } from '../../comment-pin/pin-data';

/** Where the platform keeps a request's screenshots (src/routes/feedback.js `buildScreenshotsEmbed`). */
export const SHOT_PATH = '/issue-images/';

/** Past this far across the picture, the note goes on the pin's left. */
export const NOTE_LEFT_FROM = 0.6;
/** Closer than this to the picture's top, the note hangs below the point instead of standing above it. */
export const NOTE_DOWN_ABOVE = 0.25;

export interface PinPlacement {
  /** The point, as CSS percentages of the picture's width and height. */
  x: string;
  y: string;
  side: 'right' | 'left';
  rise: 'up' | 'down';
}

const percent = (n: number) => `${Number((Math.max(0, Math.min(1, n)) * 100).toFixed(2))}%`;

/** Where the pin and its note sit on the picture. */
export function pinPlacement(pin: Pick<PinData, 'x' | 'y'>): PinPlacement {
  return {
    x: percent(pin.x),
    y: percent(pin.y),
    side: pin.x > NOTE_LEFT_FROM ? 'left' : 'right',
    rise: pin.y < NOTE_DOWN_ABOVE ? 'down' : 'up',
  };
}

/** What the corner button says while the comments are shown, and while they are not. */
export function pinToggleLabel(shown: boolean, many = false): string {
  if (shown) return many ? translate('project:topic.request.shots.hideComments') : translate('project:topic.request.shots.hideComment');
  return many ? translate('project:topic.request.shots.showComments') : translate('project:topic.request.shots.showComment');
}

export interface RequestShots {
  /** The words, to fold; the markup as given when nothing changed. */
  words: string;
  /** The lifted blocks, to show under the fold; empty unless the lift took any. */
  shots: string;
}

export type ParseHtml = (html: string) => Element | null;

/** The browser's parser, or null where there is none (a server render). */
export function parseHtml(html: string): Element | null {
  if (typeof DOMParser === 'undefined') return null;
  try {
    return new DOMParser().parseFromString(html, 'text/html').body;
  } catch {
    return null;
  }
}

const ELEMENT = 1;
const TEXT = 3;

function hasClass(node: Node | null, name: string): node is Element {
  return !!node && node.nodeType === ELEMENT && ` ${(node as Element).getAttribute('class') || ''} `.includes(` ${name} `);
}

function isTag(node: Node | null, tag: string): node is Element {
  return !!node && node.nodeType === ELEMENT && (node as Element).tagName.toUpperCase() === tag;
}

/** A node that shows something: an element, or text that is not only space. */
function meaningful(node: Node): boolean {
  return node.nodeType === ELEMENT || (node.nodeType === TEXT && /\S/.test(node.nodeValue || ''));
}

/** Every <img> under `node`, in document order. */
function imagesIn(node: Node, out: Element[] = []): Element[] {
  for (const child of Array.from(node.childNodes)) {
    if (isTag(child, 'IMG')) out.push(child);
    else if (child.nodeType === ELEMENT) imagesIn(child, out);
  }
  return out;
}

const isShot = (img: Element) => (img.getAttribute('src') || '').includes(SHOT_PATH);

function make(doc: Document, tag: string, className: string): Element {
  const el = doc.createElement(tag);
  el.setAttribute('class', className);
  return el;
}

/**
 * Wraps the picture (its viewer link, when the renderer made one) with the
 * comments' layer and the button that toggles it, one mark per pin:
 *
 *   <span class="pin-shot" data-pin-shot="">
 *     <a class="dc-inline-img-link" …><img …></a>
 *     <button type="button" class="pin-shot-toggle touch-target-32" data-shown="true" data-many="">Hide comments</button>
 *     <span class="pin-shot-layer" aria-hidden="true">
 *       <span class="pin-shot-mark" data-side="right" data-rise="up" style="--pin-x: …; --pin-y: …">
 *         <span class="pin-shot-pin">1</span><span class="pin-shot-note">the words</span>
 *       </span>
 *       …
 *     </span>
 *   </span>
 *
 * A pin shows its comment's number when the request has several (`n`), and
 * is plain otherwise. The button's `data-shown` is the one record of whether
 * the comments are shown: app.css hides the layer that follows a button set
 * to false. The layer is hidden from assistive technology because the
 * comments' words are already in the request's text.
 */
function pinShot(doc: Document, img: Element, pins: PinData[]): void {
  const link = img.parentNode;
  const target = hasClass(link, 'dc-inline-img-link') ? link : img;
  const parent = target.parentNode;
  if (!parent) return;
  const many = pins.length > 1;
  const shot = make(doc, 'span', 'pin-shot');
  shot.setAttribute('data-pin-shot', '');
  const button = make(doc, 'button', 'pin-shot-toggle touch-target-32');
  button.setAttribute('type', 'button');
  button.setAttribute('data-shown', 'true');
  if (many) button.setAttribute('data-many', '');
  button.textContent = pinToggleLabel(true, many);
  const layer = make(doc, 'span', 'pin-shot-layer');
  layer.setAttribute('aria-hidden', 'true');
  for (const pin of pins) {
    const place = pinPlacement(pin);
    const mark = make(doc, 'span', 'pin-shot-mark');
    mark.setAttribute('data-side', place.side);
    mark.setAttribute('data-rise', place.rise);
    mark.setAttribute('style', `--pin-x: ${place.x}; --pin-y: ${place.y}`);
    const dot = make(doc, 'span', 'pin-shot-pin');
    if (pin.n) dot.textContent = String(pin.n);
    mark.appendChild(dot);
    if (pin.note) {
      const note = make(doc, 'span', 'pin-shot-note');
      note.textContent = pin.note;
      mark.appendChild(note);
    }
    layer.appendChild(mark);
  }
  parent.insertBefore(shot, target);
  shot.appendChild(target);
  shot.appendChild(button);
  shot.appendChild(layer);
}

/** The node whose children are the words' blocks: the renderer's `.dev-issue-body` box when the markup is one. */
function blocksOf(root: Element): Element {
  const kids = Array.from(root.childNodes).filter(meaningful);
  return kids.length === 1 && hasClass(kids[0], 'dev-issue-body') ? kids[0] : root;
}

/**
 * The request's words, with each pinned picture's comment as a layer and
 * the blocks that hold a screenshot apart from the words.
 */
export function requestShots(
  html: string,
  { parse = parseHtml }: { parse?: ParseHtml } = {},
): RequestShots {
  const same = { words: html, shots: '' };
  const pins = html.includes('#pin=');
  const lifts = html.includes(SHOT_PATH);
  if (!html || !(pins || lifts)) return same;
  const root = parse(html);
  const doc = root && root.ownerDocument;
  if (!root || !doc) return same;

  let changed = false;
  if (pins) {
    for (const img of imagesIn(root)) {
      const pins = readPins(img.getAttribute('src'));
      if (!pins.length) continue;
      pinShot(doc, img, pins);
      changed = true;
    }
  }

  let shots = '';
  if (lifts) {
    const blocks = blocksOf(root);
    const lifted = Array.from(blocks.childNodes).filter((node): node is Element =>
      node.nodeType === ELEMENT && (isTag(node, 'IMG') ? isShot(node) : imagesIn(node).some(isShot)));
    if (lifted.length) {
      const box = doc.createElement('div');
      // The lifted blocks keep the renderer's box, so they are styled as they were.
      const holder = blocks === root ? box : box.appendChild(blocks.cloneNode(false) as Element);
      for (const block of lifted) holder.appendChild(block);
      shots = box.innerHTML;
      changed = true;
    }
  }

  if (!changed) return same;
  const words = Array.from(blocksOf(root).childNodes).some(meaningful) ? root.innerHTML : '';
  return { words, shots };
}

/**
 * The words' delegated click: a press on a picture's "Hide comment" button
 * turns its comment off or on again. True when the click was that, so the
 * caller can keep it from doing anything else.
 */
export function togglePinShot(target: EventTarget | null, scope: Element | null): boolean {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function' || !scope) return false;
  const button = el.closest('button.pin-shot-toggle');
  if (!button || !scope.contains(button)) return false;
  const shown = button.getAttribute('data-shown') !== 'true';
  button.setAttribute('data-shown', String(shown));
  button.textContent = pinToggleLabel(shown, button.hasAttribute('data-many'));
  return true;
}
