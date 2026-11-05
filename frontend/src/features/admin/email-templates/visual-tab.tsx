'use strict';

import { useId, useLayoutEffect, useRef, useState } from 'react';

import { AdminUI } from '../admin-console.js';
import {
  editableBlocks, EditRefused, escapeText, findBlocks, insertAfterBlock, spliceBlock, tokenize, type Block,
} from './html-runs';
import type { Placeholder } from './shared';

// The Visual tab: the email drawn as it looks, where an admin clicks a piece of
// text and retypes it. The owner's rule is that the design and the conditions
// always survive it, so it never rewrites the HTML from the page it draws.
// The frame shows a decorated COPY of the source (each editable block marked
// contenteditable, each placeholder a chip, each condition a label); when a
// block is edited, its content is read back from the frame's DOM, chips turned
// back into {{name}}, and spliced into the source by ./html-runs.ts, which
// refuses an edit that would drop a placeholder or add structure. Every other
// byte stays as it was. Structure (tables, conditions) is changed in the HTML
// tab, which is always the full truth.
//
// The frame is sandboxed without scripts, so nothing in the email runs; it is
// same-origin so this module can reach its DOM and listen to it.

const BRAND_ACCENT = '#0a6ee0';
// The seeded emails' button, so a new one matches them.
const BUTTON_STYLE = `display:inline-block;padding:11px 20px;border-radius:8px;background:${BRAND_ACCENT};`
  + 'color:#ffffff;font-size:15px;font-weight:600;text-decoration:none';
const LINK_STYLE = `color:${BRAND_ACCENT}`;

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeAttr = (value: string) => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// What the decoration adds, spelled once, so undecorate can take exactly it off.
const STRUCTURE_TITLE = 'This part depends on a condition. Change it in the HTML tab.';
const editableAttrs = (index: number, editable: boolean) => (editable
  ? ` data-hr-block="${index}" contenteditable="true" role="textbox" aria-label="Email text"`
  : ` data-hr-block="${index}"`);
const STRUCTURE_ATTRS = ` data-hr-structure="" title="${STRUCTURE_TITLE}"`;

/** A placeholder as the frame draws it: a chip nobody can type inside. */
export function chipHtml(name: string): string {
  return `<span data-hr-chip="${escapeAttr(name)}" contenteditable="false" class="hr-chip">${escapeText(name)}</span>`;
}

function conditionLabel(marker: string): string {
  const body = marker.slice(2, -2).trim();
  let m: RegExpExecArray | null;
  if ((m = /^#if\s+(\S+)$/.exec(body))) return `Shown only when ${m[1]}`;
  if ((m = /^#unless\s+(\S+)$/.exec(body))) return `Shown only when not ${m[1]}`;
  if (body === 'else') return 'Otherwise';
  return 'End of condition';
}

const conditionHtml = (marker: string) => `<span data-hr-cond="${escapeAttr(marker)}" contenteditable="false" class="hr-cond">${escapeText(conditionLabel(marker))}</span>`;

// Puts `attrs` into an opening tag right after its name, ahead of the email's
// own attributes, so where both name one (a title, contenteditable) the
// browser takes the editor's.
function withAttrs(tag: string, name: string, attrs: string): string {
  const cut = 1 + name.length;
  return tag.slice(0, cut) + attrs + tag.slice(cut);
}

// The conditions open around a point in the source, innermost last.
interface Condition { name: string; negated: boolean; inElse: boolean }

function conditionsLabel(open: Condition[]): string {
  return `Shown only when ${open.map((c) => (c.negated !== c.inElse ? `not ${c.name}` : c.name)).join(' and ')}`;
}

const inConditionAttrs = (label: string) => ` data-hr-in-cond="${escapeAttr(label)}" title="${escapeAttr(label)}"`;

/** Placeholders as chips and conditions as labels, in markup with no blocks marked. */
export function chipify(html: string): string {
  return tokenize(html).map((t) => {
    if (t.type === 'placeholder') return chipHtml(t.name);
    if (t.type === 'marker') return conditionHtml(t.html);
    return t.html;
  }).join('');
}

/**
 * The copy of `source` the frame draws: editable blocks marked (and
 * contenteditable when `editable`), structure blocks outlined, placeholders as
 * chips and conditions as labels. An editable block inside a condition stays
 * editable (its markers are outside it) and is outlined and labelled with the
 * condition it is shown under. undecorate(decorate(s)) === s.
 */
export function decorate(source: string, { editable }: { editable: boolean }): string {
  const { structure } = findBlocks(source);
  const blocks = editableBlocks(source);
  const blockAt = new Map(blocks.map((b, i) => [b.outerStart, i]));
  const structureAt = new Set(structure.map((b) => b.outerStart));
  const open: Condition[] = [];
  return tokenize(source).map((t) => {
    if (t.type === 'tag' && !t.closing) {
      if (blockAt.has(t.start)) {
        const attrs = editableAttrs(blockAt.get(t.start) as number, editable) + (open.length ? inConditionAttrs(conditionsLabel(open)) : '');
        return withAttrs(t.html, t.name, attrs);
      }
      if (structureAt.has(t.start)) return withAttrs(t.html, t.name, STRUCTURE_ATTRS);
    }
    if (t.type === 'placeholder') return chipHtml(t.name);
    if (t.type === 'marker') {
      const body = t.html.slice(2, -2).trim();
      const m = /^#(if|unless)\s+(\S+)$/.exec(body);
      if (m) open.push({ name: m[2], negated: m[1] === 'unless', inElse: false });
      else if (body === 'else') { if (open.length) open[open.length - 1].inElse = true; }
      else open.pop();
      return conditionHtml(t.html);
    }
    return t.html;
  }).join('');
}

// Only a span carrying all of the editor's own markers is a chip; the email's
// own markup that happens to use data-hr-chip stays markup.
const CHIP = /<span\b(?=[^>]*\sdata-hr-chip=")([^>]*)>([\s\S]*?)<\/span>/g;
const isChip = (attrs: string) => /\scontenteditable="false"/.test(attrs) && /\sclass="hr-chip"/.test(attrs);
const CONDITION = /<span\b[^>]*?\sdata-hr-cond="([^"]*)"[^>]*>[\s\S]*?<\/span>/g;

/** A block's HTML as the frame's DOM gives it back, with every chip its {{name}} again. */
export function fromEditorHtml(html: string): string {
  return html.replace(CHIP, (whole: string, attrs: string) => {
    if (!isChip(attrs)) return whole;
    const name = /\sdata-hr-chip="([^"]*)"/.exec(attrs) as RegExpExecArray;
    return `{{${unescapeAttr(name[1])}}}`;
  });
}

/** Takes off everything decorate added. */
export function undecorate(html: string): string {
  return fromEditorHtml(html)
    .replace(CONDITION, (_, marker: string) => unescapeAttr(marker))
    .replace(/ data-hr-block="\d+"( contenteditable="true" role="textbox" aria-label="Email text")?( data-hr-in-cond="[^"]*" title="[^"]*")?/g, '')
    .split(STRUCTURE_ATTRS).join('');
}

export interface VisualModel {
  source: string;
  /** The editable blocks, in the order the frame numbers them, kept at their current offsets. */
  blocks: Block[];
  /** Each block's content when the tab opened. */
  opened: string[];
}

export function openModel(source: string): VisualModel {
  const blocks = editableBlocks(source);
  return { source, blocks, opened: blocks.map((b) => b.html) };
}

/**
 * The block's new content, given what the DOM holds now (`now`), what it held
 * when the frame loaded (`baseline`, the browser's own spelling of the block)
 * and the block's bytes then (`opened`). Back where it started is the bytes it
 * started with, however the browser spells them.
 */
export function readEdit(now: string, baseline: string, opened: string): string {
  const html = fromEditorHtml(now);
  return html === fromEditorHtml(baseline) ? opened : html;
}

/**
 * The model with block `index`'s content replaced by `html`; the blocks after
 * it move by the difference. Throws EditRefused (from spliceBlock) for an edit
 * that would drop a placeholder or add anything but inline text markup.
 */
export function applyBlockEdit(model: VisualModel, index: number, html: string, allowAdded: string[]): VisualModel {
  const block = model.blocks[index];
  const source = spliceBlock(model.source, block, html, { allowAdded });
  const delta = source.length - model.source.length;
  if (!delta && source === model.source) return model;
  const blocks = model.blocks.map((b, j) => {
    if (j < index) return b;
    if (j === index) return { ...b, html, end: b.end + delta, outerEnd: b.outerEnd + delta };
    return { ...b, start: b.start + delta, end: b.end + delta, outerStart: b.outerStart + delta, outerEnd: b.outerEnd + delta };
  });
  return { ...model, source, blocks };
}

/**
 * What one input in block `index` does: `{ model }`, moved on by the edit (the
 * same model when nothing changed), or `{ refused, restore }`: why the edit
 * cannot be kept, and the block's content to put back, as the source has it.
 */
export function blockInput(model: VisualModel, index: number, innerHTML: string, baseline: string, allowed: string[]):
  { model: VisualModel; refused?: undefined; restore?: undefined } | { model?: undefined; refused: string; restore: string } {
  if (!model.blocks[index]) return { model };
  const html = readEdit(innerHTML, baseline, model.opened[index]);
  try {
    return { model: applyBlockEdit(model, index, html, allowed) };
  } catch (err) {
    return { refused: err instanceof Error ? err.message : String(err), restore: chipify(model.blocks[index].html) };
  }
}

/** What a paste puts in: the clipboard's plain text as HTML, lines kept as line breaks. Its HTML is never read. */
export function pastedHtml(clipboard: { getData: (type: string) => string } | null): string {
  const text = clipboard ? clipboard.getData('text/plain') || '' : '';
  return text.replace(/\r\n?/g, '\n').split('\n').map(escapeText).join('<br>');
}

/** Why `href` cannot be a link's address, or null. A link placeholder is always fine. */
export function linkProblem(href: string, placeholder: string | null): string | null {
  if (placeholder) return null;
  if (/^https?:\/\/[^\s"<>]+$/i.test(href.trim())) return null;
  return 'Use a web address that starts with http:// or https://, or pick a link placeholder.';
}

export function buttonSnippet(href: string, label: string): string {
  return `<p><a href="${escapeAttr(href)}" style="${BUTTON_STYLE}">${escapeText(label)}</a></p>`;
}

// Drawn into the frame on load, never into the source.
const FRAME_CSS = `
[data-hr-block][contenteditable="true"]{outline:1px dashed transparent;outline-offset:3px;border-radius:2px;cursor:text}
[data-hr-block][contenteditable="true"]:hover{outline-color:rgba(10,110,224,.5)}
[data-hr-block][contenteditable="true"]:focus{outline:2px solid ${BRAND_ACCENT}}
[data-hr-structure]{outline:1px dashed rgba(127,127,127,.7);outline-offset:3px;border-radius:2px}
[data-hr-block][data-hr-in-cond]{outline:1px dashed rgba(176,128,0,.8);outline-offset:3px;border-radius:2px}
[data-hr-in-cond]::before{content:attr(data-hr-in-cond);display:block;margin:0 0 2px;font:600 11px/1.6 -apple-system,system-ui,sans-serif;color:#6b4e00;letter-spacing:0;text-transform:none;font-style:normal}
.hr-chip{display:inline-block;padding:0 6px;border-radius:999px;background:#e6f0fd;color:#0a4fa8;font:600 0.85em/1.5 ui-monospace,Menlo,monospace;letter-spacing:0;text-transform:none;user-select:all;cursor:default}
.hr-chip::before{content:"{{"}.hr-chip::after{content:"}}"}
.hr-cond{display:inline-block;margin:2px 4px;padding:0 6px;border-radius:4px;background:#fff3d1;color:#6b4e00;font:600 11px/1.6 -apple-system,system-ui,sans-serif;letter-spacing:0;text-transform:none;cursor:default}
`;

type LinkForm = { kind: 'link' | 'button'; href: string; placeholder: string; label: string };

/**
 * The Visual tab for `source` (a template's middle, or a whole layout).
 * `onChange` gets the whole new source after each accepted edit; `opened` is
 * what Revert goes back to. `placeholders` are the ones this email may use.
 */
export function VisualTab({ source, opened, onChange, placeholders, readOnly = false }: {
  source: string;
  opened: string;
  onChange: (source: string) => void;
  placeholders: Placeholder[];
  readOnly?: boolean;
}) {
  const insertable = placeholders.filter((p) => p.kind !== 'flag' && p.name !== 'content');
  const linkable = placeholders.filter((p) => p.kind === 'url');
  const allowed = insertable.map((p) => p.name);
  const [first] = useState(() => openModel(source));
  const model = useRef<VisualModel>(first);
  // The frame's document, and a count that remounts the frame whenever it is
  // drawn again: going back to what was opened draws the same document as
  // the first time, and a frame given the same srcdoc keeps its edited DOM.
  const [drawn, setDrawn] = useState(() => ({ doc: decorate(source, { editable: !readOnly }), count: 0 }));
  const redraw = (next: string) => setDrawn((d) => ({ doc: decorate(next, { editable: !readOnly }), count: d.count + 1 }));
  const frame = useRef<HTMLIFrameElement | null>(null);
  const baseline = useRef<string[]>([]);
  const current = useRef<number | null>(null);
  const saved = useRef<Range | null>(null);
  const [height, setHeight] = useState(320);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<LinkForm | null>(null);
  const [toInsert, setToInsert] = useState('');
  const imageNote = useId();
  const latest = useRef({ onChange, allowed, source });
  latest.current = { onChange, allowed, source };

  // A source changed from outside (the HTML tab, Revert, a reload) is drawn
  // afresh; one this tab produced is already on screen. Before paint, so no
  // input in the old frame is read against the old model.
  useLayoutEffect(() => {
    if (source === model.current.source) return;
    model.current = openModel(source);
    redraw(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, readOnly]);

  const doc = () => (frame.current && frame.current.contentDocument) || null;
  const blockEl = (node: Node | null): HTMLElement | null => {
    let n: Node | null = node;
    while (n && n.nodeType !== 1) n = n.parentNode;
    return n ? ((n as Element).closest('[data-hr-block]') as HTMLElement | null) : null;
  };
  const fit = () => {
    const d = doc();
    if (d && d.documentElement) setHeight(Math.max(160, d.documentElement.scrollHeight + 4));
  };

  const emit = (next: VisualModel) => {
    model.current = next;
    latest.current.onChange(next.source);
  };

  const readBlock = (el: HTMLElement) => {
    // The source moved on from outside and the frame is about to be drawn
    // again: this input belongs to the old one.
    if (model.current.source !== latest.current.source) return;
    const index = Number(el.getAttribute('data-hr-block'));
    const m = model.current;
    if (!Number.isInteger(index)) return;
    const result = blockInput(m, index, el.innerHTML, baseline.current[index] ?? '', latest.current.allowed);
    if (result.refused !== undefined) {
      // Put the block back as the source still has it, and say why.
      el.innerHTML = result.restore;
      setNotice(result.refused);
    } else {
      setNotice(null);
      if (result.model !== m) emit(result.model);
    }
    fit();
  };

  const chipNear = (d: Document, backward: boolean): Element | null => {
    const sel = d.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!r.collapsed) {
      const el = blockEl(r.commonAncestorContainer);
      const chips = el ? Array.from(el.querySelectorAll('[data-hr-chip]')) : [];
      return chips.find((c) => r.intersectsNode(c)) || null;
    }
    let node: Node | null = r.startContainer;
    let sibling: Node | null;
    if (node.nodeType === 3) {
      const text = node as Text;
      if (backward ? r.startOffset > 0 : r.startOffset < text.data.length) return null;
      sibling = backward ? node.previousSibling : node.nextSibling;
    } else {
      sibling = node.childNodes[backward ? r.startOffset - 1 : r.startOffset] || null;
    }
    // At the edge of an inline element, the neighbour is its parent's.
    while (!sibling && node && !(node as Element).hasAttribute?.('data-hr-block')) {
      sibling = backward ? node.previousSibling : node.nextSibling;
      node = node.parentNode;
    }
    while (sibling && sibling.nodeType === 1 && !(sibling as Element).hasAttribute('data-hr-chip')) {
      sibling = backward ? sibling.lastChild : sibling.firstChild;
    }
    return sibling && sibling.nodeType === 1 ? (sibling as Element) : null;
  };

  const protectChip = (chip: Element) => {
    const name = chip.getAttribute('data-hr-chip');
    setNotice(`Placeholders stay in the email. To remove {{${name}}}, use the HTML tab.`);
  };

  const wire = () => {
    const d = doc();
    if (!d) return;
    const style = d.createElement('style');
    style.textContent = FRAME_CSS;
    (d.head || d.documentElement).appendChild(style);
    baseline.current = Array.from(d.querySelectorAll('[data-hr-block]')).map((el) => el.innerHTML);
    current.current = null;
    saved.current = null;
    fit();
    if (readOnly) {
      d.addEventListener('click', (ev) => { if ((ev.target as Element).closest?.('a')) ev.preventDefault(); });
      return;
    }
    d.addEventListener('input', (ev) => {
      const el = blockEl(ev.target as Node);
      if (el) readBlock(el);
    });
    d.addEventListener('beforeinput', (ev) => {
      const e = ev as InputEvent;
      if (!blockEl(e.target as Node)) return;
      if (e.isComposing) return;
      if (e.inputType === 'insertParagraph') {
        // A phone keyboard's Enter often arrives only here: a new paragraph
        // is structure, a line break is text.
        e.preventDefault();
        d.execCommand('insertLineBreak');
        return;
      }
      const deleting = e.inputType.startsWith('delete');
      const replacing = e.inputType.startsWith('insert') && !!d.getSelection() && !d.getSelection()!.isCollapsed;
      if (!deleting && !replacing) return;
      const chip = chipNear(d, e.inputType.endsWith('Backward'));
      if (chip && (replacing || deleting)) { e.preventDefault(); protectChip(chip); }
    });
    d.addEventListener('keydown', (ev) => {
      const el = blockEl(ev.target as Node);
      if (!el) return;
      if (ev.key === 'Enter' && !ev.isComposing) {
        // A new paragraph is structure; a line break is text.
        ev.preventDefault();
        d.execCommand('insertLineBreak');
        return;
      }
      if (ev.key === 'Backspace' || ev.key === 'Delete') {
        const chip = chipNear(d, ev.key === 'Backspace');
        if (chip) { ev.preventDefault(); protectChip(chip); }
      }
    });
    d.addEventListener('paste', (ev) => {
      if (!blockEl(ev.target as Node)) return;
      ev.preventDefault();
      const html = pastedHtml(ev.clipboardData);
      if (html) d.execCommand('insertHTML', false, html);
    });
    d.addEventListener('drop', (ev) => { ev.preventDefault(); });
    d.addEventListener('click', (ev) => { if ((ev.target as Element).closest?.('a')) ev.preventDefault(); });
    d.addEventListener('focusin', (ev) => {
      const el = blockEl(ev.target as Node);
      if (el) current.current = Number(el.getAttribute('data-hr-block'));
    });
    d.addEventListener('selectionchange', () => {
      const sel = d.getSelection();
      if (sel && sel.rangeCount && blockEl(sel.anchorNode)) saved.current = sel.getRangeAt(0).cloneRange();
    });
  };

  // Puts the caret back where it was in the block, for a toolbar command.
  const focusBlock = (): { d: Document; el: HTMLElement } | null => {
    const d = doc();
    if (!d || current.current == null) {
      setNotice('Click into the text first.');
      return null;
    }
    const el = d.querySelector(`[data-hr-block="${current.current}"]`) as HTMLElement | null;
    if (!el) return null;
    el.focus();
    const sel = d.getSelection();
    if (sel && saved.current && el.contains(saved.current.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(saved.current);
    }
    return { d, el };
  };

  const command = (name: 'bold' | 'italic') => {
    const at = focusBlock();
    if (at) at.d.execCommand(name);
  };

  const insertPlaceholder = (name: string) => {
    const at = focusBlock();
    if (at && name) at.d.execCommand('insertHTML', false, chipHtml(name));
  };

  const applyForm = () => {
    if (!form) return;
    const href = form.placeholder ? `{{${form.placeholder}}}` : form.href.trim();
    const problem = linkProblem(href, form.placeholder || null);
    if (problem) { setNotice(problem); return; }
    if (form.kind === 'button') {
      const index = current.current;
      const m = model.current;
      if (m.source !== latest.current.source) return;
      if (index == null || !m.blocks[index]) { setNotice('Click into the text the button goes after first.'); return; }
      try {
        const next = insertAfterBlock(m.source, m.blocks[index], buttonSnippet(href, form.label.trim() || 'Open'));
        setForm(null);
        setNotice(null);
        // The button is new structure, so the frame is drawn again from it.
        emit(openModel(next));
        redraw(next);
      } catch (err) {
        setNotice(err instanceof EditRefused || err instanceof Error ? err.message : String(err));
      }
      return;
    }
    const at = focusBlock();
    if (!at) return;
    const sel = at.d.getSelection();
    setForm(null);
    if (!sel || sel.isCollapsed) {
      const text = form.label.trim() || (form.placeholder ? 'link' : href);
      at.d.execCommand('insertHTML', false, `<a href="${escapeAttr(href)}" style="${LINK_STYLE}">${escapeText(text)}</a>`);
      return;
    }
    at.d.execCommand('createLink', false, href);
    // A new link wears the seeds' link colour, as a typed one would.
    for (const a of Array.from(at.el.querySelectorAll('a'))) {
      if (a.getAttribute('href') === href && !a.hasAttribute('style')) a.setAttribute('style', LINK_STYLE);
    }
    readBlock(at.el);
  };

  const tool = AdminUI.btn.outlineSm;
  return (
    <div className="space-y-2">
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Format text">
          <button type="button" className={`${tool} font-bold`} aria-label="Bold" title="Bold"
            onMouseDown={(ev) => ev.preventDefault()} onClick={() => command('bold')}>B</button>
          <button type="button" className={`${tool} italic`} aria-label="Italic" title="Italic"
            onMouseDown={(ev) => ev.preventDefault()} onClick={() => command('italic')}>I</button>
          <button type="button" className={tool} aria-label="Link" aria-expanded={form?.kind === 'link'}
            onClick={() => setForm({ kind: 'link', href: 'https://', placeholder: '', label: '' })}>Link</button>
          <button type="button" className={tool} aria-label="Button" aria-expanded={form?.kind === 'button'}
            onClick={() => setForm({ kind: 'button', href: 'https://', placeholder: '', label: '' })}>Button</button>
          {/* Focusable, so the reason can be reached and read; it does nothing until images land. */}
          <button type="button" className={`${tool} opacity-50`} aria-label="Image" aria-disabled="true"
            aria-describedby={imageNote} title="Coming in the next part"
            onClick={() => setNotice('Images are coming in the next part.')}>Image</button>
          <span id={imageNote} className="sr-only">Images are coming in the next part.</span>
          {/* A choice, then Insert: a closed select changes value while it is browsed by keyboard. */}
          <select className={`${AdminUI.select} w-auto`} aria-label="Placeholder to insert" value={toInsert}
            onChange={(ev) => setToInsert(ev.target.value)}>
            <option value="">Choose a placeholder</option>
            {insertable.map((p) => <option key={p.name} value={p.name}>{`{{${p.name}}}`}</option>)}
          </select>
          <button type="button" className={tool} aria-label="Insert placeholder" disabled={!toInsert}
            onClick={() => { insertPlaceholder(toInsert); setToInsert(''); }}>Insert</button>
          <button type="button" className={tool} aria-label="Revert to opened" disabled={source === opened}
            title="Undo every change since this email was opened" onClick={() => { setNotice(null); onChange(opened); }}>
            Revert to opened
          </button>
        </div>
      )}
      {form ? (
        <div className="flex flex-wrap items-end gap-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 p-2">
          <label className="text-xs min-w-0 flex-1">
            <span className="text-zinc-500 dark:text-zinc-400">Web address</span>
            <input className={`${AdminUI.input} mt-1`} type="url" value={form.href} disabled={!!form.placeholder}
              onChange={(ev) => setForm({ ...form, href: ev.target.value })} />
          </label>
          {linkable.length ? (
            <label className="text-xs">
              <span className="text-zinc-500 dark:text-zinc-400">Or a link placeholder</span>
              <select className={`${AdminUI.select} mt-1`} value={form.placeholder}
                onChange={(ev) => setForm({ ...form, placeholder: ev.target.value })}>
                <option value="">None</option>
                {linkable.map((p) => <option key={p.name} value={p.name}>{`{{${p.name}}}`}</option>)}
              </select>
            </label>
          ) : null}
          <label className="text-xs min-w-0 flex-1">
            <span className="text-zinc-500 dark:text-zinc-400">{form.kind === 'button' ? 'Button text' : 'Text, if none is selected'}</span>
            <input className={`${AdminUI.input} mt-1`} value={form.label} onChange={(ev) => setForm({ ...form, label: ev.target.value })} />
          </label>
          <div className="flex gap-2">
            <button type="button" className={AdminUI.btn.primarySm} onClick={applyForm}>{form.kind === 'button' ? 'Add button' : 'Add link'}</button>
            <button type="button" className={tool} onClick={() => setForm(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
      {notice ? (
        <p role="alert" className="rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">{notice}</p>
      ) : null}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Click any text to retype it. Outlined parts depend on a condition; change those, and the layout, in the HTML tab.
      </p>
      <iframe key={drawn.count} ref={frame} title="Visual editor" sandbox="allow-same-origin" srcDoc={drawn.doc} onLoad={wire}
        className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white" style={{ width: '100%', height }} />
    </div>
  );
}
