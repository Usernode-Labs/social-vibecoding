/**
 * `#dc-spec-viewer`'s children — the shared-spec reader.
 * See ./spec-viewer-store.ts for what the seam carries and what stays the
 * module's.
 *
 * ── What this component owns that nothing owned before ────────────────
 *
 * The panel's own transient state. `_renderSpecViewer` bound its listeners
 * over closures that lived exactly as long as ONE innerHTML write, so the
 * copy button's flash died on any repaint — a version switch, a
 * `spec_updated` push, a frozen-version fetch landing. It is `useState` here
 * and survives, which is the point of the conversion rather than a side
 * effect of it.
 *
 * #1343 retired the private-share popover this component used to hold (its
 * open flag, typed username, error line and fetched suggestions). Private
 * sharing goes through Messages now: the button hands the selected version
 * to the composer as a shared-object card, and the access grant is written
 * when that message is actually sent.
 *
 * ── What it does NOT own ──────────────────────────────────────────────
 *
 * Every fetch. `_switchSpecViewerVersion`, `closeSpecViewer`, `_setSpecTab`,
 * `_shareSpecVersion` and `_shareSpecInMessages` are dev-chat.js's, reached
 * by name — the module holds the `specViewer` slot
 * five other places read, and each of those calls ends in a publish.
 */

import {
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useStoreState } from '../../lib/use-store-state';
import {
  specViewerStore,
  type SpecAction,
  type SpecBody,
  type SpecGroupShare,
  type SpecViewerState,
} from './spec-viewer-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).DevChat : null) || null;
}

function ui(): any {
  return (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
}

/**
 * The version picker's class run.
 *
 * Deliberately NOT routed through `@/components/ui/select`: that primitive's
 * cva base is `w-full rounded-lg` and this control is `text-xs rounded … px-2
 * py-1`, so adopting it would move the rendered class attribute of the one
 * element on this screen a dapp.json check anchors on. Widening the table to
 * spell a second, narrower field is its own slice with its own evidence.
 */
const VERSION_SELECT
  = 'text-xs rounded bg-zinc-100 dark:bg-zinc-900 border border-zinc-300'
  + ' dark:border-zinc-700 px-2 py-1';

const MUTED_BLOCK = 'p-4 text-sm text-zinc-500 dark:text-zinc-400';

const TAB = {
  on: 'dc-spec-viewer-tab dc-spec-viewer-tab-active',
  off: 'dc-spec-viewer-tab',
} as const;



const BUILD_HINT
  = 'This is a plan, not a built change. Ready? Ask the AI in chat to build it.';

const SHARE_USER_LABEL = 'Share in Messages';

/**
 * Memoised on the STRING so the `{__html}` wrapper keeps its identity across
 * re-renders — React diffs host props by reference and re-assigns `innerHTML`
 * for a new object even when the string is identical. Same note as the
 * transcript's `Body` and the group chat's spec panel.
 */
function MarkdownBody(
  { html, className, role }: { html: string; className: string; role?: string },
): ReactNode {
  const wrapper = useMemo(() => ({ __html: html }), [html]);
  return <div className={className} role={role} dangerouslySetInnerHTML={wrapper} />;
}

function TabButton({ tab, active, label }: {
  tab: 'user' | 'tech';
  active: 'user' | 'tech';
  label: string;
}): ReactNode {
  return (
    <button
      className={active === tab ? TAB.on : TAB.off}
      role="tab" aria-selected={active === tab} data-spec-tab={tab}
      onClick={() => controller()?._setSpecTab?.(tab)}
    >{label}</button>
  );
}

function Body({ body }: { body: SpecBody }): ReactNode {
  if (body.kind === 'loading') return <div className={MUTED_BLOCK}>Loading spec…</div>;
  if (body.kind === 'empty') return <div className={MUTED_BLOCK}>{body.copy}</div>;
  if (body.kind === 'plain') {
    return <MarkdownBody className="dc-spec-viewer-body" html={body.html} />;
  }
  return (
    <>
      {body.preambleHtml
        ? (
          <MarkdownBody
            className="dc-spec-viewer-body dc-spec-viewer-preamble"
            html={body.preambleHtml}
          />
        )
        : null}
      <div className="dc-spec-viewer-tabs" role="tablist" aria-label="Spec sections">
        <TabButton tab="user" active={body.tab} label="User-facing" />
        <TabButton tab="tech" active={body.tab} label="Technical" />
      </div>
      {/* An empty-but-present half keeps its tab and says so, so the toggle
          does not appear and disappear between versions. */}
      {body.halfHtml
        ? <MarkdownBody className="dc-spec-viewer-body" role="tabpanel" html={body.halfHtml} />
        : (
          <div className="dc-spec-viewer-body" role="tabpanel">
            <p className="dc-spec-tab-empty">Nothing in this section.</p>
          </div>
        )}
    </>
  );
}

/**
 * #1012: the copy source is the RAW selected version — both halves plus their
 * marker headings — never the rendered half and never the active tab.
 */
function CopyButton({ action, raw }: { action: SpecAction; raw: string }): ReactNode {
  const [label, setLabel] = useState('Copy markdown');
  if (action.kind !== 'live') {
    return (
      <button
        className="dc-spec-action-btn dc-spec-copy-btn" disabled
        title="No spec to copy yet"
      >Copy markdown</button>
    );
  }
  return (
    <button
      id="dc-spec-viewer-copy" className="dc-spec-action-btn dc-spec-copy-btn"
      title="Copy the whole spec (both sections) as markdown"
      onClick={async () => {
        const ok = await ui()?.copyText?.(raw);
        setLabel(ok ? 'Copied!' : 'Copy failed');
        if (!ok) ui()?.toast?.('Couldn’t copy. Select the text and copy it manually');
        setTimeout(() => setLabel('Copy markdown'), 1500);
      }}
    >{label}</button>
  );
}

function GroupShareButton(
  { action, version }: { action: SpecGroupShare; version: number | null },
): ReactNode {
  if (action.kind === 'absent') return null;
  if (action.kind === 'blank') {
    return (
      <button
        className="dc-spec-action-btn" disabled title="No spec version to share yet"
      >Share to group</button>
    );
  }
  return (
    <button
      id="dc-spec-viewer-share" className="dc-spec-action-btn" disabled={action.shared}
      title={action.shared
        ? 'Already shared to group chat'
        : 'Post a card linking to this spec in the group chat'}
      onClick={() => controller()?._shareSpecVersion?.(version)}
    >{action.shared ? 'Shared' : 'Share to group'}</button>
  );
}

function UserShareButton(
  { action, version }: { action: SpecAction; version: number | null },
): ReactNode {
  if (action.kind === 'absent') return null;
  if (action.kind === 'blank') {
    return (
      <button
        className="dc-spec-action-btn" disabled title="No spec version to share yet"
      >{SHARE_USER_LABEL}</button>
    );
  }
  // #1343: repeatable — the owner can send the same version into any number
  // of conversations, so there is no "already shared" disabled state here.
  return (
    <button
      id="dc-spec-viewer-share-user" className="dc-spec-action-btn"
      title="Send this spec version to someone in Messages"
      onClick={() => controller()?._shareSpecInMessages?.(version)}
    >{SHARE_USER_LABEL}</button>
  );
}

export function SpecViewerView({ s }: { s: SpecViewerState }): ReactNode {
  if (s.kind === 'closed') return null;
  return (
    <>
      <div className="dc-spec-viewer-header">
        <select
          id="dc-spec-viewer-version" className={VERSION_SELECT}
          disabled={s.versions.length === 0} value={s.selected}
          onChange={(e) => controller()?._switchSpecViewerVersion?.(e.target.value)}
        >
          {s.versions.length
            ? s.versions.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)
            : <option value="">No versions yet</option>}
        </select>
        <CopyButton action={s.copy} raw={s.raw} />
        <UserShareButton action={s.userShare} version={s.version} />
        <GroupShareButton action={s.groupShare} version={s.version} />
        <button
          id="dc-spec-viewer-close" className="dc-spec-viewer-close"
          aria-label="Close spec viewer"
          onClick={() => controller()?.closeSpecViewer?.()}
        >×</button>
      </div>
      <div className="dc-spec-viewer-body-wrap"><Body body={s.body} /></div>
      {s.buildHint ? <div className="dc-spec-viewer-build-hint">{BUILD_HINT}</div> : null}
    </>
  );
}

export function SpecViewer(): ReactNode {
  return <SpecViewerView s={useStoreState(specViewerStore)} />;
}
