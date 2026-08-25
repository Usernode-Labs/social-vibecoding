/**
 * `#dc-spec-viewer`'s children — the shared-spec reader.
 * See ./spec-viewer-store.ts for what the seam carries and what stays the
 * module's.
 *
 * ── What this component owns that nothing owned before ────────────────
 *
 * The panel's own transient state. `_renderSpecViewer` bound six listeners
 * over closures that lived exactly as long as ONE innerHTML write, so the
 * copy button's flash, the share popover's open flag, its typed username, its
 * error line and its fetched suggestions all died on any repaint — a version
 * switch, a `spec_updated` push, a frozen-version fetch landing. They are
 * `useState` here and survive, which is the point of the conversion rather
 * than a side effect of it.
 *
 * Two consequences are deliberate and both are behaviour changes:
 *
 *   - A BACKGROUND refresh no longer wipes what you are typing into the share
 *     popover. What still closes it is a change of VERSION, which is what the
 *     popover is scoped to.
 *   - The suggestion list renders the same way on every open. It used to be
 *     cleared on open and re-rendered only when the one-shot fetch resolved,
 *     so the first open listed six names and every later one listed none
 *     until you typed. Picking a name still collapses it, which is the part
 *     of that behaviour that was intended.
 *
 * ── What it does NOT own ──────────────────────────────────────────────
 *
 * Every fetch. `_switchSpecViewerVersion`, `closeSpecViewer`, `_setSpecTab`,
 * `_shareSpecVersion`, `_shareSpecToUser` and `_loadSpecMentionSuggestions`
 * are dev-chat.js's, reached by name — the module holds the `specViewer` slot
 * five other places read, and each of those calls ends in a publish.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
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

const POP = { on: 'dc-spec-share-pop', off: 'dc-spec-share-pop hidden' } as const;

const ERR = { on: 'dc-spec-share-error', off: 'dc-spec-share-error hidden' } as const;

const BUILD_HINT
  = 'This is a plan, not a built change. Ready? Ask the AI in chat to build it.';

const SHARE_USER_LABEL = 'Share to user';

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

/** Everything the "Share to user" button and its popover share. */
interface SharePopover {
  open: boolean;
  value: string;
  error: string;
  sending: boolean;
  label: string;
  matches: string[];
  popRef: RefObject<HTMLDivElement | null>;
  btnRef: RefObject<HTMLButtonElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  toggle: () => void;
  type: (next: string) => void;
  pick: (name: string) => void;
  send: () => void;
  close: () => void;
}

function useSharePopover(version: number | null): SharePopover {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [label, setLabel] = useState(SHARE_USER_LABEL);
  const [names, setNames] = useState<string[]>([]);
  // Picking a suggestion collapses the list until the next keystroke — the
  // one piece of the old `sugBox.innerHTML = ''` dance that was intentional.
  const [picked, setPicked] = useState(false);

  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The share is scoped to ONE version, so switching versions dismisses it.
  useEffect(() => {
    setOpen(false);
    setValue('');
    setError('');
    setPicked(false);
  }, [version]);

  // Capture phase, on the document, exactly as the module bound it: a
  // pointerdown anywhere but inside the card or on the button dismisses.
  useEffect(() => {
    if (!open) return undefined;
    const onOutside = (e: Event) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (popRef.current?.contains(t) || t === btnRef.current) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onOutside, true);
    return () => document.removeEventListener('pointerdown', onOutside, true);
  }, [open]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  // One-shot, best-effort: exact usernames still work without it.
  useEffect(() => {
    if (!open || names.length) return undefined;
    let live = true;
    Promise.resolve(controller()?._loadSpecMentionSuggestions?.())
      .then((list: string[] | undefined) => {
        if (live && Array.isArray(list) && list.length) setNames(list);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [open, names.length]);

  const matches = useMemo(() => {
    if (picked) return [];
    const q = value.trim().toLowerCase();
    return names.filter((n) => !q || n.toLowerCase().startsWith(q)).slice(0, 6);
  }, [picked, value, names]);

  const close = () => setOpen(false);

  const send = async () => {
    const username = value.trim().replace(/^@/, '');
    if (!username) { setError('Enter a username'); return; }
    setSending(true);
    const result = await controller()?._shareSpecToUser?.(version, username);
    setSending(false);
    if (!result || !result.ok) {
      setError((result && result.error) || 'Failed to share');
      return;
    }
    setError('');
    setPicked(false);
    setValue('');
    const sentName = (result.recipient && result.recipient.username) || username;
    setLabel(`Sent to @${sentName}`);
    setOpen(false);
    setTimeout(() => setLabel(SHARE_USER_LABEL), 2500);
  };

  return {
    open, value, error, sending, label, matches,
    popRef, btnRef, inputRef,
    // Opening starts clean; closing leaves what was typed alone, exactly as
    // the module's `close()` did.
    toggle: () => {
      if (open) { setOpen(false); return; }
      setError('');
      setValue('');
      setPicked(false);
      setOpen(true);
    },
    type: (next: string) => { setValue(next); setPicked(false); setError(''); },
    pick: (name: string) => { setValue(name); setPicked(true); inputRef.current?.focus(); },
    send,
    close,
  };
}

function UserShareButton(
  { action, pop }: { action: SpecAction; pop: SharePopover },
): ReactNode {
  if (action.kind === 'absent') return null;
  if (action.kind === 'blank') {
    return (
      <button
        className="dc-spec-action-btn" disabled title="No spec version to share yet"
      >Share to user</button>
    );
  }
  return (
    <button
      ref={pop.btnRef} id="dc-spec-viewer-share-user" className="dc-spec-action-btn"
      title="Privately share this spec version with one person"
      onClick={pop.toggle}
    >{pop.label}</button>
  );
}

/**
 * #86's private-share card. Rendered for the OWNER whether or not the button
 * above it is live, because that is where the template put it; only a live
 * button can open it.
 */
function SharePopoverCard({ pop }: { pop: SharePopover }): ReactNode {
  return (
    <div ref={pop.popRef} id="dc-spec-share-pop" className={pop.open ? POP.on : POP.off}>
      <input
        ref={pop.inputRef} id="dc-spec-share-input" className="dc-spec-share-input"
        type="text" placeholder="Username…" autoComplete="off" spellCheck={false}
        maxLength={32}
        value={pop.value}
        onChange={(e) => pop.type(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); pop.send(); }
          if (e.key === 'Escape') pop.close();
        }}
      />
      <div id="dc-spec-share-suggestions" className="dc-spec-share-suggestions">
        {pop.matches.map((name) => (
          <button
            key={name} type="button" className="dc-spec-share-sug" data-username={name}
            onClick={() => pop.pick(name)}
          >{`@${name}`}</button>
        ))}
      </div>
      <div id="dc-spec-share-error" className={pop.error ? ERR.on : ERR.off}>{pop.error}</div>
      <button
        id="dc-spec-share-send" className="dc-spec-action-btn dc-spec-share-send"
        disabled={pop.sending} onClick={pop.send}
      >{pop.sending ? 'Sending…' : 'Send'}</button>
    </div>
  );
}

export function SpecViewerView({ s }: { s: SpecViewerState }): ReactNode {
  // Hooks run on every render, so the popover's state is held here rather
  // than inside the branch that draws it.
  const pop = useSharePopover(s.kind === 'open' ? s.version : null);
  if (s.kind === 'closed') return null;
  // `userShare` is `absent` for exactly one reason — a non-owner — and the
  // popover is the owner's affordance whether or not the button is live.
  const owner = s.userShare.kind !== 'absent';
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
        <UserShareButton action={s.userShare} pop={pop} />
        <GroupShareButton action={s.groupShare} version={s.version} />
        <button
          id="dc-spec-viewer-close" className="dc-spec-viewer-close"
          aria-label="Close spec viewer"
          onClick={() => controller()?.closeSpecViewer?.()}
        >×</button>
        {owner ? <SharePopoverCard pop={pop} /> : null}
      </div>
      <div className="dc-spec-viewer-body-wrap"><Body body={s.body} /></div>
      {s.buildHint ? <div className="dc-spec-viewer-build-hint">{BUILD_HINT}</div> : null}
    </>
  );
}

export function SpecViewer(): ReactNode {
  return <SpecViewerView s={useStoreState(specViewerStore)} />;
}
