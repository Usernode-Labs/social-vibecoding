import { t as tr } from "./i18n/runtime";
/**
 * HTML specs (#3699): the browser half. The server half, and the dialect
 * itself, are described in src/services/spec-html.js.
 *
 * `renderSpecHtml` turns an HTML spec into the same three pieces the markdown
 * viewer works with (a preamble above the tabs, a User-facing half and a
 * Technical half), so every surface keeps its tabs, its copy button and its
 * layout. Two kinds of content come out of it, held to two different rules:
 *
 *   - THE PROSE (headings, paragraphs, lists, tables, diagrams) is drawn in
 *     the platform's own document, so it is sanitised against a fixed list:
 *     no scripts, no styles, no ids, no data attributes, links only to
 *     http(s) or this site. An author's class survives only when it is one of
 *     the spec's own `spec-*` classes, so a spec cannot borrow the shell's
 *     utilities to lay a fake dialog over the app. Diagrams are inline SVG in
 *     the shape the challenge illustrations already allow, plus text.
 *
 *   - THE SCREENS (each `<template data-screen>` of a `<figure data-screens>`)
 *     are not sanitised into the page at all. Each is drawn in its own
 *     sandboxed frame (`sandbox=""`: no scripts, no forms, no navigation, an
 *     origin of its own) with a content security policy that lets it load
 *     nothing but this site's stylesheets, fonts and images. That is what lets
 *     a screen use the app's real classes and stylesheet and look like the app.
 *     Which stylesheets is stamped on the article by the server
 *     (`data-spec-styles`, src/services/spec-html.js): the platform's own
 *     app draws with the shell's stylesheets, which are its own; every other
 *     app's screens get only the native UI kit, which all apps share, and
 *     carry the rest in a <style> block of their own.
 *     The frames go into the before/after viewer the proposal card uses
 *     (AppView._shotsViewerHtml), with the spec's three additions: side by
 *     side, side by side by default when there is room, and close-up / whole
 *     screen.
 *
 * `fitSpecFrames` lays the frames out: a frame is drawn at its screen's size
 * (1280×800 or 390×844) and scaled to its side of the stage, framed on the
 * close-up or on the whole screen. It loads a screen's frames only once that
 * screen is the one showing.
 */

import { useEffect, type RefObject } from 'react';

export interface SpecHtmlDoc {
  /** Both halves were found: draw the tabs. */
  split: boolean;
  preambleHtml: string;
  userHtml: string;
  techHtml: string;
  /** The whole document, for a spec without both halves. */
  html: string;
}

interface RenderOptions {
  /** Unique on the page and stable across renders: it names the viewers' radios. */
  key: string;
}

const SCREEN_SIZES = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
} as const;
const MAX_SCREEN_HEIGHT = 2400;
const MAX_SCREENS = 6;
const MAX_CHANGES = 3;

const PROSE_TAGS = [
  'a', 'b', 'strong', 'i', 'em', 'code', 'pre', 'h3', 'h4', 'h5', 'p', 'br', 'ol', 'ul', 'li',
  'div', 'span', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'hr', 'del', 'small',
  'sub', 'sup', 'mark', 'kbd', 'figure', 'figcaption',
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text',
  'tspan', 'title', 'desc',
];

const PROSE_ATTRS = [
  'class', 'href', 'start', 'colspan', 'rowspan', 'role', 'aria-label',
  'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'dx', 'dy',
  'width', 'height', 'viewBox', 'preserveAspectRatio', 'points', 'transform',
  'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-opacity', 'opacity',
  'font-size', 'font-weight', 'text-anchor', 'dominant-baseline', 'xmlns',
];

// Elements a screen may not carry into its frame. The sandbox already stops
// scripts and navigation; dropping these as well keeps a blocked script from
// logging an error, and keeps a screen from loading anything of its own.
const SCREEN_DROP = 'script,noscript,iframe,frame,frameset,object,embed,applet,base,meta,link,portal,template';

const FRAME_CSS = `html,body{margin:0}
html[data-side="before"] [data-side="after"],html[data-side="after"] [data-side="before"]{display:none!important}
:where([data-change]){position:relative}
[data-change]{outline:2px solid #16a34a;outline-offset:2px;border-radius:4px}
html[data-side="before"] [data-change]{outline-color:#dc2626}
[data-change]::after{content:attr(data-change);position:absolute;left:-12px;top:-12px;z-index:2147483647;width:20px;height:20px;border-radius:999px;background:#16a34a;color:#fff;font:700 11px/20px system-ui,-apple-system,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff;pointer-events:none}
html[data-side="before"] [data-change]::after{background:#dc2626}`;

function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeText(value: string): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeKey(key: string): string {
  return String(key || 'spec').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 60) || 'spec';
}

interface Geometry {
  kind: 'desktop' | 'phone';
  width: number;
  height: number;
  focus: [number, number, number, number] | null;
}

function geometryOf(el: Element): Geometry {
  const kind = String(el.getAttribute('data-size') || '').toLowerCase() === 'phone' ? 'phone' : 'desktop';
  const base = SCREEN_SIZES[kind];
  const wantH = parseInt(el.getAttribute('data-height') || '', 10);
  const height = Number.isFinite(wantH) ? Math.max(base.height, Math.min(MAX_SCREEN_HEIGHT, wantH)) : base.height;
  const width = base.width;
  const nums = String(el.getAttribute('data-focus') || '').trim().split(/[\s,]+/).map(Number);
  let focus: Geometry['focus'] = null;
  if (nums.length === 4 && nums.every((n) => Number.isFinite(n))) {
    let [x, y, w, h] = nums.map((n) => Math.round(n));
    x = Math.max(0, Math.min(x, width - 1));
    y = Math.max(0, Math.min(y, height - 1));
    w = Math.max(1, Math.min(w, width - x));
    h = Math.max(1, Math.min(h, height - y));
    focus = [x, y, w, h];
  }
  return { kind, width, height, focus };
}

function sameOriginPath(url: string): boolean {
  return /^\/(?!\/)/.test(url);
}

function stripExternalCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)\s*(?!data:|\/(?!\/))[^)]*\)/gi, 'none');
}

/** A screen's markup with anything that would load, run or navigate taken out. */
function cleanScreenMarkup(markup: string): string {
  const holder = document.createElement('template');
  holder.innerHTML = markup;
  const root = holder.content;
  root.querySelectorAll(SCREEN_DROP).forEach((el) => el.remove());
  root.querySelectorAll('*').forEach((el) => {
    for (const { name, value } of Array.from(el.attributes)) {
      const lower = name.toLowerCase();
      if (lower.startsWith('on') || lower === 'srcdoc' || lower === 'formaction' || lower === 'action' || lower === 'ping') {
        el.removeAttribute(name);
      } else if (lower === 'href' || lower === 'xlink:href') {
        el.removeAttribute(name);
      } else if (lower === 'src' || lower === 'srcset' || lower === 'poster') {
        if (!(lower === 'src' && (sameOriginPath(value) || /^data:image\//i.test(value)))) el.removeAttribute(name);
      } else if (lower === 'style') {
        el.setAttribute('style', stripExternalCss(value));
      }
    }
    if (el.tagName === 'STYLE') el.textContent = stripExternalCss(el.textContent || '');
  });
  const out = document.createElement('div');
  out.appendChild(root.cloneNode(true));
  return out.innerHTML;
}

type SpecStyles = 'platform' | 'kit';

function frameDoc(markup: string, side: 'before' | 'after', styles: SpecStyles): string {
  const origin = window.location.origin;
  const dark = document.documentElement.classList.contains('dark');
  const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
    .map((link) => link.href)
    .filter((href) => href.startsWith(`${origin}/`))
    .filter((href) => styles === 'platform' || href.startsWith(`${origin}/usernode-native/`))
    .map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}">`)
    .join('');
  const csp = `default-src 'none'; style-src 'unsafe-inline' ${origin}; img-src data: ${origin}; font-src data: ${origin}`;
  return `<!doctype html><html${dark ? ' class="dark"' : ''} data-side="${side}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">${links}<style>${FRAME_CSS}</style></head>`
    + `<body>${markup}</body></html>`;
}

interface Change {
  n: string;
  claim: string;
  steps: string;
}

function sideHtml(
  which: 'before' | 'after', markup: string, g: Geometry, label: string, styles: SpecStyles,
): string {
  const crop = g.focus || [0, 0, g.width, g.height];
  const cls = which === 'before' ? 'shots-flip-before' : 'shots-flip-after';
  return `<span class="shots-flip-side ${cls} spec-frame-side" style="--shots-shape:${crop[2]} / ${crop[3]}"`
    + ` role="img" aria-label="${escapeAttr(label)}" data-spec-frame=""`
    + ` data-spec-full="${g.width} ${g.height}" data-spec-focus="${g.focus ? g.focus.join(' ') : ''}">`
    + `<iframe sandbox="" referrerpolicy="no-referrer" tabindex="-1" aria-hidden="true" title="${escapeAttr(label)}"`
    + ` data-srcdoc="${escapeAttr(frameDoc(markup, which, styles))}"></iframe></span>`;
}

function screensHtml(figure: Element, key: string, styles: SpecStyles): string {
  const changes: Change[] = Array.from(figure.querySelectorAll('ol[data-changes] > li')).slice(0, MAX_CHANGES).map((li, index) => ({
    n: String(li.getAttribute('data-change') || index + 1).trim(),
    claim: (li.textContent || '').replace(/\s+/g, ' ').trim(),
    steps: String(li.getAttribute('data-steps') || '').replace(/\s+/g, ' ').trim(),
  }));
  const caption = figure.querySelector(':scope > figcaption');
  const templates = Array.from(figure.querySelectorAll('template[data-screen]')).slice(0, MAX_SCREENS);
  const parts = templates.map((tpl) => {
    const g = geometryOf(tpl);
    const markup = cleanScreenMarkup((tpl as HTMLTemplateElement).innerHTML);
    // The changes on this screen are the ones its markup marks.
    const holder = document.createElement('template');
    holder.innerHTML = markup;
    const marked = new Set(Array.from(holder.content.querySelectorAll('[data-change]')).map((el) => String(el.getAttribute('data-change')).trim()));
    const here = changes.filter((change) => marked.has(change.n));
    const persona = String(tpl.getAttribute('data-persona') || '').replace(/_/g, ' ') || tr("core:member_persona");
    const described = here.map((change) => change.claim).join(' ');
    const list = here.map((change) => `<li class="shots-change" data-shots-n="${escapeAttr(change.n)}"><span class="shots-change-n">${escapeText(change.n)}</span>`
      + `<div class="min-w-0 flex-1"><strong class="text-sm leading-snug">${escapeText(change.claim)}</strong>`
      + `${change.steps ? `<div class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">${escapeText(change.steps)}</div>` : ''}</div></li>`).join('');
    const zoomWords = g.focus ? `<span class="shots-close-only">${escapeText(tr("core:sync_close_up_21bb7416"))}</span><span class="shots-whole-only">${escapeText(tr("core:sync_whole_screen_26446d6d"))}</span>` : "";
    const size = g.kind === 'phone' ? tr("core:sync_phone_63dceb88") : tr("core:sync_desktop_9bd88f24");
    return {
      viewport: g.kind,
      zoomable: !!g.focus,
      afterHtml: sideHtml('after', markup, g, tr("core:sync_after_planned_description_7ac26e58", { description: described }), styles),
      beforeHtml: sideHtml('before', markup, g, tr("core:sync_before_description_334ddead", { description: described }), styles),
      afterChip: tr("core:sync_after_planned_c2b21fad"),
      beforeChip: tr("core:sync_before_today_08f06eaf"),
      notesHtml: `${list ? `<ol class="shots-changes">${list}</ol>` : ''}`
        + `<div class="shots-view-meta"><span>${escapeText(tr("core:sync_size_width_height_ea9f2790", { size, width: g.width, height: g.height }))}${zoomWords}${escapeText(tr("core:sync_seen_as_a_persona_78ee6798", { persona }))}</span></div>`,
    };
  });
  // Grouped by size, as the card groups them: the Desktop / Phone switch picks
  // a size and the arrows step through its screens.
  const ordered = [...parts.filter((p) => p.viewport === 'desktop'), ...parts.filter((p) => p.viewport === 'phone')];
  const viewer = (window as unknown as { AppView?: { _shotsViewerHtml?: (o: unknown) => string } }).AppView?._shotsViewerHtml?.({
    key, screens: ordered, sideBySide: true, autoSide: true, zoom: true, className: 'shots-viewer-spec',
  }) || '';
  const fallback = !viewer && changes.length
    ? `<ol class="dc-ol">${changes.map((change) => `<li>${escapeText(change.claim)}</li>`).join('')}</ol>`
    : '';
  const captionHtml = caption && caption.textContent?.trim()
    ? `<div class="spec-screens-caption">${escapeText(caption.textContent.replace(/\s+/g, ' ').trim())}</div>`
    : '';
  return `<div class="spec-screens">${viewer || fallback}${captionHtml}</div>`;
}

const HEADING_MAP: Record<string, [string, string]> = {
  H1: ['h3', 'dc-h3'], H2: ['h4', 'dc-h4'], H3: ['h5', 'dc-h5'], H4: ['h5', 'dc-h5'], H5: ['h5', 'dc-h5'], H6: ['h5', 'dc-h5'],
};

function retag(el: Element, tag: string): Element {
  const next = el.ownerDocument.createElement(tag);
  for (const { name, value } of Array.from(el.attributes)) next.setAttribute(name, value);
  while (el.firstChild) next.appendChild(el.firstChild);
  el.replaceWith(next);
  return next;
}

/** Author classes that are the spec's own; every other class is dropped. */
function keepSpecClasses(root: ParentNode): void {
  root.querySelectorAll('[class]').forEach((el) => {
    const kept = String(el.getAttribute('class') || '').split(/\s+/).filter((c) => /^spec-[a-z0-9-]+$/.test(c));
    if (kept.length) el.setAttribute('class', kept.join(' '));
    else el.removeAttribute('class');
  });
}

function addClass(el: Element, cls: string): void {
  el.setAttribute('class', [el.getAttribute('class') || '', cls].join(' ').trim());
}

/** The platform's markdown classes on the prose, so both kinds of spec read alike. */
function styleProse(root: ParentNode): void {
  root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((el) => {
    const [tag, cls] = HEADING_MAP[el.tagName] || ['h5', 'dc-h5'];
    addClass(retag(el, tag), cls);
  });
  root.querySelectorAll('blockquote').forEach((el) => addClass(retag(el, 'div'), 'dc-blockquote'));
  root.querySelectorAll('p').forEach((el) => addClass(el, 'dc-p'));
  root.querySelectorAll('ul').forEach((el) => addClass(el, 'dc-ul'));
  root.querySelectorAll('ol').forEach((el) => addClass(el, 'dc-ol'));
  root.querySelectorAll('table').forEach((el) => addClass(el, 'dc-table'));
  root.querySelectorAll('pre').forEach((el) => addClass(el, 'dc-code-block'));
  root.querySelectorAll('figure').forEach((el) => { if (el.querySelector('svg')) addClass(el, 'spec-diagram-wrap'); });
}

function sanitizeProse(container: Element): string {
  const purify = (window as unknown as { DOMPurify?: { sanitize: (s: string, c: object) => DocumentFragment } }).DOMPurify;
  if (!purify) return `<pre>${escapeText(container.textContent || '')}</pre>`;
  const fragment = purify.sanitize(container.innerHTML, {
    ALLOWED_TAGS: PROSE_TAGS,
    ALLOWED_ATTR: PROSE_ATTRS,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  fragment.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href) || sameOriginPath(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      a.removeAttribute('href');
    }
  });
  const out = document.createElement('div');
  out.appendChild(fragment);
  return out.innerHTML;
}

function renderPart(nodes: Node[], key: string, screensBox: { next: number }, styles: SpecStyles): string {
  const doc = document.implementation.createHTMLDocument('');
  const container = doc.createElement('div');
  for (const node of nodes) container.appendChild(doc.importNode(node, true));
  // The screens leave before the prose is sanitised and come back after, as
  // the viewer's own markup: a marker holds each one's place.
  const marker = `spec-screens-${Math.random().toString(36).slice(2)}`;
  const screens: string[] = [];
  container.querySelectorAll('figure[data-screens]').forEach((figure) => {
    const index = screens.length;
    screens.push(screensHtml(figure, `${key}-${screensBox.next++}`, styles));
    const holder = doc.createElement('p');
    holder.textContent = `${marker}-${index}`;
    figure.replaceWith(holder);
  });
  keepSpecClasses(container);
  styleProse(container);
  let html = sanitizeProse(container);
  screens.forEach((viewer, index) => {
    html = html.replace(new RegExp(`<p[^>]*>${marker}-${index}</p>`), () => viewer);
  });
  return html;
}

const cache = new Map<string, SpecHtmlDoc>();
const CACHE_MAX = 24;

/** An HTML spec as a preamble and two halves of safe markup, or null when it is not one. */
export function renderSpecHtml(source: string, options: RenderOptions): SpecHtmlDoc | null {
  if (typeof source !== 'string' || !source.trim() || typeof DOMParser === 'undefined') return null;
  const key = `spec-${safeKey(options && options.key)}`;
  const dark = document.documentElement.classList.contains('dark') ? 'd' : 'l';
  const cacheKey = `${key}\n${dark}\n${source}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const parsed = new DOMParser().parseFromString(source, 'text/html');
  const article = parsed.querySelector('article[data-spec]') || parsed.body;
  // Unstamped means the server did not know the app: the native kit alone.
  const styles: SpecStyles = article.getAttribute('data-spec-styles') === 'platform' ? 'platform' : 'kit';
  const children = Array.from(article.childNodes);
  // A parsed document has no window, so its nodes are told apart by type, not instanceof.
  const sectionOf = (node: Node): 'user' | 'tech' | null => {
    if (node.nodeType !== 1 || (node as Element).tagName !== 'SECTION') return null;
    const which = String((node as Element).getAttribute('data-spec-tab') || '').toLowerCase();
    if (which === 'user') return 'user';
    if (which === 'tech' || which === 'technical') return 'tech';
    return null;
  };
  const userSection = children.find((node) => sectionOf(node) === 'user') as Element | undefined;
  const techSection = children.find((node) => sectionOf(node) === 'tech') as Element | undefined;
  const screensBox = { next: 0 };

  let doc: SpecHtmlDoc;
  if (userSection && techSection) {
    const preamble = children.filter((node) => !sectionOf(node));
    doc = {
      split: true,
      preambleHtml: renderPart(preamble, key, screensBox, styles),
      userHtml: renderPart(Array.from(userSection.childNodes), key, screensBox, styles),
      techHtml: renderPart(Array.from(techSection.childNodes), key, screensBox, styles),
      html: '',
    };
  } else {
    doc = { split: false, preambleHtml: '', userHtml: '', techHtml: '', html: renderPart(children, key, screensBox, styles) };
  }
  doc = {
    ...doc,
    preambleHtml: wrap(doc.preambleHtml),
    userHtml: wrap(doc.userHtml),
    techHtml: wrap(doc.techHtml),
    html: wrap(doc.html),
  };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(cacheKey, doc);
  return doc;
}

function wrap(html: string): string {
  return html.trim() ? `<div class="spec-html">${html}</div>` : '';
}

function numbers(value: string | undefined): number[] {
  return String(value || '').trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
}

function layoutViewer(viewer: HTMLElement): void {
  const closeUp = !!viewer.querySelector<HTMLInputElement>('.shots-zoom-close')?.checked;
  const picks = Array.from(viewer.querySelectorAll<HTMLInputElement>('.shots-screen-pick'));
  const selected = Math.max(0, picks.findIndex((pick) => pick.checked));
  viewer.querySelectorAll<HTMLElement>('.shots-view').forEach((view, index) => {
    const showing = picks.length ? index === selected : true;
    view.querySelectorAll<HTMLElement>('[data-spec-frame]').forEach((side) => {
      const [width, height] = numbers(side.dataset.specFull);
      if (!(width > 0 && height > 0)) return;
      const focus = numbers(side.dataset.specFocus);
      const crop = closeUp && focus.length === 4 ? focus : [0, 0, width, height];
      side.style.setProperty('--shots-shape', `${crop[2]} / ${crop[3]}`);
      const frame = side.querySelector('iframe');
      if (!frame) return;
      if (showing && !frame.getAttribute('srcdoc') && frame.dataset.srcdoc) frame.setAttribute('srcdoc', frame.dataset.srcdoc);
      const scale = side.clientWidth > 0 ? side.clientWidth / crop[2] : 0;
      frame.style.width = `${width}px`;
      frame.style.height = `${height}px`;
      frame.style.transform = `translate(${-crop[0] * scale}px, ${-crop[1] * scale}px) scale(${scale})`;
    });
  });
}

/** Lays out and loads the spec screens under `root`; returns the cleanup. */
export function fitSpecFrames(root: HTMLElement | null | undefined): () => void {
  if (!root || typeof window === 'undefined') return () => {};
  const viewers = Array.from(root.querySelectorAll<HTMLElement>('.shots-viewer-spec'));
  if (!viewers.length) return () => {};
  const cleanups = viewers.map((viewer) => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => { frame = 0; layoutViewer(viewer); });
    };
    layoutViewer(viewer);
    const onChange = () => layoutViewer(viewer);
    viewer.addEventListener('change', onChange);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(viewer);
    return () => {
      viewer.removeEventListener('change', onChange);
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  });
  return () => cleanups.forEach((cleanup) => cleanup());
}

/** `fitSpecFrames` for a React element whose markup is `html`. */
export function useSpecFrames(ref: RefObject<HTMLElement | null>, html: string): void {
  useEffect(() => fitSpecFrames(ref.current), [ref, html]);
}

// The legacy controllers (dev-chat.js, group-chat.js) reach this by name, the
// way they reach every React seam.
if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.specHtml = { render: renderSpecHtml, fit: fitSpecFrames };
}
