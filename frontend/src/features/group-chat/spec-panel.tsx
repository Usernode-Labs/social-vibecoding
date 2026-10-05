/**
 * `#gc-spec-side-panel` — the shared-spec reader's contents, as the only React
 * writer below that host.
 *
 * The host is created at runtime by `AppView.renderDevChatTab` inside
 * `#app-content`, so this is a portal established by group-chat.js on each
 * render — the same arrangement the transcript has, and torn down by the same
 * `unmountAllLegacyPortals` in `AppView._teardownDevRoots`.
 *
 * ── Two body kinds, and the distinction is deliberate ─────────────────
 *
 * A spec renders as markdown; a 404 or a load failure renders as TEXT, because
 * formatting an error message turns it into something that looks like a
 * document. That was two branches of one HTML string and is two tags now, so
 * the error path cannot accidentally acquire markup.
 *
 * ── `Copy markdown` copies the RAW source ─────────────────────────────
 *
 * Not the rendered body — `GroupChat._specPanelRaw` holds the markdown the
 * server sent, and the module clears it on close so a closed panel's document
 * is not still copyable. The button's "Copied!" / "Copy failed" flash is local
 * state here, which is what it was before: a `textContent` write on a node the
 * same closure had created.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { useSpecFrames } from '../../lib/spec-html';
import { useStoreState } from '../../lib/use-store-state';
import { specPanelStore, type SpecPanelBody, type SpecPanelState } from './spec-panel-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).GroupChat : null) || null;
}

function ui(): any {
  return (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
}

/**
 * Memoised on the STRING so the `{__html}` wrapper keeps its identity across
 * re-renders — React diffs host props by reference and re-assigns `innerHTML`
 * for a new object even when the string is identical. Same note as the
 * transcript's `Body`.
 */
function MarkdownBody({ html }: { html: string }) {
  const wrapper = useMemo(() => ({ __html: html }), [html]);
  return <div className="gc-spec-panel-body" dangerouslySetInnerHTML={wrapper} />;
}

/** A piece of an HTML spec (#3699); its before/after screens are frames scaled to fit. */
function HtmlPart({ html, className, role }: { html: string; className?: string; role?: string }) {
  const wrapper = useMemo(() => ({ __html: html }), [html]);
  const ref = useRef<HTMLDivElement>(null);
  useSpecFrames(ref, html);
  return <div ref={ref} className={className} role={role} dangerouslySetInnerHTML={wrapper} />;
}

/**
 * An HTML spec with the dev chat viewer's two tabs, the plain-language half
 * first. The tab is this panel's own and goes back to User-facing for each
 * new spec.
 */
function SpecDocBody({ body }: { body: Extract<SpecPanelBody, { kind: 'spec' }> }) {
  const [tab, setTab] = useState<'user' | 'tech'>('user');
  useEffect(() => { setTab('user'); }, [body.userHtml, body.html]);
  if (!body.split) return <HtmlPart className="gc-spec-panel-body" html={body.html} />;
  const half = tab === 'tech' ? body.techHtml : body.userHtml;
  const tabButton = (which: 'user' | 'tech', label: string) => (
    <button
      type="button"
      className={tab === which ? 'dc-spec-viewer-tab dc-spec-viewer-tab-active' : 'dc-spec-viewer-tab'}
      role="tab" aria-selected={tab === which} data-spec-tab={which}
      onClick={() => setTab(which)}
    >{label}</button>
  );
  return (
    <div className="gc-spec-panel-body">
      {body.preambleHtml ? <HtmlPart className="dc-spec-viewer-preamble" html={body.preambleHtml} /> : null}
      <div className="dc-spec-viewer-tabs" role="tablist" aria-label="Spec sections">
        {tabButton('user', 'User-facing')}
        {tabButton('tech', 'Technical')}
      </div>
      {half
        ? <HtmlPart role="tabpanel" html={half} />
        : <div role="tabpanel"><p className="dc-spec-tab-empty">Nothing in this section.</p></div>}
    </div>
  );
}

function CopyButton() {
  const [label, setLabel] = useState('Copy markdown');
  return (
    <button
      className="gc-spec-panel-copy"
      aria-label="Copy the whole spec as markdown"
      title="Copy the whole spec as markdown"
      onClick={async () => {
        const ok = await ui()?.copyText?.(controller()?._specPanelRaw);
        setLabel(ok ? 'Copied!' : 'Copy failed');
        if (!ok) ui()?.toast?.('Couldn’t copy. Select the text and copy it manually');
        setTimeout(() => setLabel('Copy markdown'), 1500);
      }}
    >
      {label}
    </button>
  );
}

export function SpecPanelView({ open, title, subtitle, canCopy, body }: SpecPanelState) {
  if (!open) return null;
  return (
    <>
      <div className="gc-spec-panel-header">
        <div className="gc-spec-panel-titlewrap">
          <div className="gc-spec-panel-title">{title}</div>
          {subtitle ? <div className="gc-spec-panel-subtitle">{subtitle}</div> : null}
        </div>
        {canCopy ? <CopyButton /> : null}
        <button
          className="gc-spec-panel-close"
          aria-label="Close spec panel"
          onClick={() => controller()?._closeSpecPanel?.()}
        >
          ×
        </button>
      </div>
      {body && body.kind === 'spec' ? <SpecDocBody body={body} /> : null}
      {body && body.kind === 'markdown'
        ? <MarkdownBody html={body.html} />
        : body && body.kind === 'spec' ? null : (
          <div className="gc-spec-panel-body">
            <div className="gc-spec-panel-error">{body ? body.text : ''}</div>
          </div>
        )}
    </>
  );
}

export function SpecPanel() {
  return <SpecPanelView {...useStoreState<SpecPanelState>(specPanelStore)} />;
}
