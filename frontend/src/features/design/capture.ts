/**
 * #6071: capture the screen the person is looking at into a design thread
 * (../messages/design-pane.tsx, src/services/design-threads.js).
 *
 * ── Two kinds of screen ───────────────────────────────────────────────
 *
 * A HOMEROOM PAGE is this document: it is copied as it stands (a detached
 * clone, never the live tree, which React and the legacy modules own), with
 * what the person typed into its fields written in, scripts, frames and
 * hidden subtrees left out, and its stylesheets named by their full address
 * (the design's frame draws them from this site, ../design/frame.ts).
 *
 * AN APP on its App tab is another origin, so the shell cannot read it: it
 * asks the app's bridge (/usernode-bridge/v1/bridge.js, the
 * `__usernode_capture` block), which answers only Homeroom's own origin, as
 * the comment pin's picture does, with the page as HTML and its readable
 * CSS written in.
 *
 * Either way the result is one self-contained HTML document of at most
 * MAX_CAPTURE_BYTES (the server's own cap, design-threads.js MAX_HTML_BYTES).
 */

import type { DesignCapture } from '../messages/api';

export const MAX_CAPTURE_BYTES = 900 * 1024;

// What a capture of Homeroom's own page leaves out: what only works live
// (scripts, frames), what the person never sees (templates, hidden roots),
// and the shell's own layers over the page (a dialog or menu open on top,
// the comment mode's layer, the side panel's frame).
const DROP = [
  'script', 'noscript', 'template', 'object', 'embed', 'base',
  'link:not([rel~="stylesheet"])', 'meta[http-equiv]', '[hidden]',
  '#comment-pin-host', '#platform-side-panel',
].join(',');

// The page's top three levels, where the screens the router is not showing
// sit (App._showOnlyScreen): each one drawn as nothing is left out, which
// keeps a capture to the screen the person sees.
const SHELL_LEVELS = 'body > *, body > * > *, body > * > * > *';

/** Leave out of `clone` the top-level subtrees `live` draws as nothing. */
function dropUnseen(live: Document, clone: HTMLElement): void {
  const win = live.defaultView;
  if (!win) return;
  const from = [...live.querySelectorAll(SHELL_LEVELS)];
  const to = [...clone.querySelectorAll(SHELL_LEVELS)];
  if (from.length !== to.length) return;
  const unseen = to.filter((_, i) => {
    try { return win.getComputedStyle(from[i]!).display === 'none'; } catch { return false; }
  });
  unseen.forEach((node) => node.remove());
}

/** Write what the person typed into each field of `clone` from its twin in `live`, so the copy shows it. */
function carryFields(live: ParentNode, clone: ParentNode): void {
  const from = [...live.querySelectorAll<HTMLElement>('input, textarea, select')];
  const to = [...clone.querySelectorAll<HTMLElement>('input, textarea, select')];
  from.forEach((field, i) => {
    const copy = to[i];
    if (!copy || copy.tagName !== field.tagName) return;
    if (field instanceof HTMLInputElement) {
      if (field.type === 'password' || field.type === 'hidden' || field.type === 'file') {
        copy.removeAttribute('value');
        return;
      }
      if (field.type === 'checkbox' || field.type === 'radio') {
        if (field.checked) copy.setAttribute('checked', ''); else copy.removeAttribute('checked');
      } else {
        copy.setAttribute('value', field.value);
      }
    } else if (field instanceof HTMLTextAreaElement) {
      copy.textContent = field.value;
    } else if (field instanceof HTMLSelectElement) {
      [...copy.querySelectorAll('option')].forEach((option, n) => {
        if (field.options[n]?.selected) option.setAttribute('selected', ''); else option.removeAttribute('selected');
      });
    }
  });
}

/** Each frame in `clone` as a plain box of its twin's size: a frame is a page of its own, and none is captured. */
function boxFrames(live: ParentNode, clone: ParentNode): void {
  const from = [...live.querySelectorAll('iframe')];
  const to = [...clone.querySelectorAll('iframe')];
  to.forEach((frame, i) => {
    const rect = from[i]?.getBoundingClientRect();
    const box = frame.ownerDocument.createElement('div');
    box.setAttribute('data-design-frame', '');
    box.className = frame.className;
    box.setAttribute('style', `${frame.getAttribute('style') || ''};width:${Math.round(rect?.width || 300)}px;height:${Math.round(rect?.height || 150)}px;background:#e4e4e7`);
    frame.replaceWith(box);
  });
}

/** Pure-ish: the byte size of a capture, as the server counts it. */
export function bytes(html: string): number {
  return new TextEncoder().encode(html).length;
}

/** A name for the page: its document title without " · Homeroom", else its address. */
export function pageTitle(doc: Document = document): string {
  const raw = String(doc.title || '').replace(/\s*[·|–-]\s*Homeroom\s*$/i, '').trim();
  return (raw || doc.defaultView?.location.hash.replace(/^#/, '') || 'This screen').slice(0, 120);
}

/**
 * Homeroom's own page as a design's first version: the whole document as
 * the person sees it now (header, tabs and the screen under them), or null
 * when it is too big to keep.
 */
export function capturePlatformPage(doc: Document = document): DesignCapture | null {
  const win = doc.defaultView;
  const clone = doc.documentElement.cloneNode(true) as HTMLElement;
  carryFields(doc, clone);
  boxFrames(doc, clone);
  dropUnseen(doc, clone);
  clone.querySelectorAll(DROP).forEach((node) => node.remove());
  // Inline event handlers never run there; nor should they be kept.
  clone.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
  });
  // The stylesheets by their full address: the frame has no base of its own.
  clone.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]').forEach((link) => {
    const href = link.getAttribute('href');
    if (href) link.setAttribute('href', new URL(href, doc.baseURI).href);
  });
  const html = `<!doctype html>\n${clone.outerHTML}`;
  if (bytes(html) > MAX_CAPTURE_BYTES) return null;
  return {
    html,
    surface: 'platform',
    title: pageTitle(doc),
    route: win ? win.location.hash || '/' : null,
    appSlug: null,
    width: Math.round(win?.innerWidth || 1280),
    height: Math.round(win?.innerHeight || 800),
  };
}

let seq = 0;

/**
 * An app's page, asked of its bridge (the frame's own origin), or null when
 * it does not answer in time, refuses, or the page is too big. `slug` and
 * `name` are the app's, from the shell.
 */
export function captureAppPage(frame: HTMLIFrameElement, { slug, name }: { slug: string; name: string }, timeoutMs = 10_000): Promise<DesignCapture | null> {
  return new Promise((resolve) => {
    const target = frame.contentWindow;
    let origin = '';
    try { origin = new URL(frame.src, document.baseURI).origin; } catch { origin = ''; }
    if (!target || !origin || origin === 'null') { resolve(null); return; }
    seq += 1;
    const id = `capture-${Date.now()}-${seq}`;
    let done = false;
    const finish = (value: DesignCapture | null) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timer);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== target || event.origin !== origin) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.__usernode_capture !== 'page' || data.id !== id) return;
      const html = typeof data.html === 'string' ? data.html : '';
      if (!html || data.error || bytes(html) > MAX_CAPTURE_BYTES) { finish(null); return; }
      const path = typeof data.path === 'string' ? data.path.slice(0, 200) : null;
      const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : name;
      finish({
        html,
        surface: 'app',
        title: `${name}${title && title !== name ? `: ${title}` : ''}`.slice(0, 120),
        route: path,
        appSlug: slug,
        width: Math.round(Number(data.width) || frame.clientWidth || 1280),
        height: Math.round(Number(data.height) || frame.clientHeight || 800),
      });
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    window.addEventListener('message', onMessage);
    try { target.postMessage({ __usernode_capture: 'take', id }, origin); } catch { finish(null); }
  });
}
