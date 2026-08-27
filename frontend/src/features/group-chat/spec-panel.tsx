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

import { useMemo, useState } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { specPanelStore, type SpecPanelState } from './spec-panel-store';

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
      {body && body.kind === 'markdown'
        ? <MarkdownBody html={body.html} />
        : (
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
