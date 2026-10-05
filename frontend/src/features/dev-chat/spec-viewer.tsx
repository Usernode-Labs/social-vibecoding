import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
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
  = () => tr("workshop:this_is_a_plan_not_a_built_change_ready_ask_the__55521b3b");

const SHARE_USER_LABEL = () => tr("workshop:share_to_user_2957a7aa");

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
  if (body.kind === 'loading') return <div className={MUTED_BLOCK}><Message id="workshop:loading_spec_d1c120fc" /></div>;
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
      <Localized element={<div className="dc-spec-viewer-tabs" role="tablist" aria-label={catalogText("workshop:spec_sections_2c81579b")}>
        <Localized element={<TabButton tab="user" active={body.tab} label={catalogText("workshop:user_facing_9f6f005f")} />} messages={{"label":"workshop:user_facing_9f6f005f"}} />
        <Localized element={<TabButton tab="tech" active={body.tab} label={catalogText("workshop:technical_e851504f")} />} messages={{"label":"workshop:technical_e851504f"}} />
      </div>} messages={{"aria-label":"workshop:spec_sections_2c81579b"}} />
      {/* An empty-but-present half keeps its tab and says so, so the toggle
          does not appear and disappear between versions. */}
      {body.halfHtml
        ? <MarkdownBody className="dc-spec-viewer-body" role="tabpanel" html={body.halfHtml} />
        : (
          <div className="dc-spec-viewer-body" role="tabpanel">
            <p className="dc-spec-tab-empty"><Message id="workshop:nothing_in_this_section_04506069" /></p>
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
  useUiLanguage();
  const [label, setLabel] = useState(tr("workshop:copy_markdown_7a99a712"));
  if (action.kind !== 'live') {
    return (
      <Localized element={<button
        className="dc-spec-action-btn dc-spec-copy-btn" disabled title={catalogText("workshop:no_spec_to_copy_yet_388b77ab")}
      ><Message id="workshop:copy_markdown_7a99a712" /></button>} messages={{"title":"workshop:no_spec_to_copy_yet_388b77ab"}} />
    );
  }
  return (
    <Localized element={<button
      id="dc-spec-viewer-copy" className="dc-spec-action-btn dc-spec-copy-btn" title={catalogText("workshop:copy_the_whole_spec_both_sections_as_markdown_4e43ede6")}
      onClick={async () => {
        const ok = await ui()?.copyText?.(raw);
        setLabel(ok ? 'Copied!' : tr("workshop:copy_failed_5b50e7a6"));
        if (!ok) ui()?.toast?.(tr("workshop:couldn_t_copy_select_the_text_and_copy_it_manual_9181be57"));
        setTimeout(() => setLabel(tr("workshop:copy_markdown_7a99a712")), 1500);
      }}
    >{label}</button>} messages={{"title":"workshop:copy_the_whole_spec_both_sections_as_markdown_4e43ede6"}} />
  );
}

function GroupShareButton(
  { action, version }: { action: SpecGroupShare; version: number | null },
): ReactNode {
  if (action.kind === 'absent') return null;
  if (action.kind === 'blank') {
    return (
      <Localized element={<button
        className="dc-spec-action-btn" disabled title={catalogText("workshop:no_spec_version_to_share_yet_f7682399")}
      ><Message id="workshop:share_to_group_57f22054" /></button>} messages={{"title":"workshop:no_spec_version_to_share_yet_f7682399"}} />
    );
  }
  return (
    <LocalizedDynamic element={<button
      id="dc-spec-viewer-share" className="dc-spec-action-btn" disabled={action.shared}
      title={action.shared
        ? tr("workshop:already_shared_to_group_chat_33449e1f")
        : tr("workshop:post_a_card_linking_to_this_spec_in_the_group_ch_035662ee")}
      onClick={() => controller()?._shareSpecVersion?.(version)}
    ><LocalizedValue render={() => (action.shared ? tr("workshop:shared_e3c4b39d") : tr("workshop:share_to_group_57f22054"))} /></button>} resolve={() => ({ "title": action.shared
        ? tr("workshop:already_shared_to_group_chat_33449e1f")
        : tr("workshop:post_a_card_linking_to_this_spec_in_the_group_ch_035662ee") })} />
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
  const [label, setLabel] = useState(SHARE_USER_LABEL());
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
    if (!username) { setError(tr("workshop:enter_a_username_35b68c13")); return; }
    setSending(true);
    const result = await controller()?._shareSpecToUser?.(version, username);
    setSending(false);
    if (!result || !result.ok) {
      setError((result && result.error) || tr("workshop:failed_to_share_cc171656"));
      return;
    }
    setError('');
    setPicked(false);
    setValue('');
    const sentName = (result.recipient && result.recipient.username) || username;
    setLabel(tr("workshop:sent_to_value1_0d534827", { value1: sentName }));
    setOpen(false);
    setTimeout(() => setLabel(SHARE_USER_LABEL()), 2500);
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
      <Localized element={<button
        className="dc-spec-action-btn" disabled title={catalogText("workshop:no_spec_version_to_share_yet_f7682399")}
      ><Message id="workshop:share_to_user_2957a7aa" /></button>} messages={{"title":"workshop:no_spec_version_to_share_yet_f7682399"}} />
    );
  }
  return (
    <Localized element={<button
      ref={pop.btnRef} id="dc-spec-viewer-share-user" className="dc-spec-action-btn" title={catalogText("workshop:privately_share_this_spec_version_with_one_perso_d8da3298")}
      aria-haspopup="dialog" aria-expanded={pop.open} aria-controls="dc-spec-share-pop"
      onClick={pop.toggle}
    >{pop.label}</button>} messages={{"title":"workshop:privately_share_this_spec_version_with_one_perso_d8da3298"}} />
  );
}

/**
 * #86's private-share card. Rendered for the OWNER whether or not the button
 * above it is live, because that is where the template put it; only a live
 * button can open it.
 */
function SharePopoverCard({ pop }: { pop: SharePopover }): ReactNode {
  return (
    <Localized element={<div
      ref={pop.popRef} id="dc-spec-share-pop" className={pop.open ? POP.on : POP.off}
      role="dialog" aria-label={catalogText("workshop:share_this_spec_with_one_person_09c35a72")}
    >
      <Localized element={<input
        ref={pop.inputRef} id="dc-spec-share-input" className="dc-spec-share-input"
        type="text" placeholder={catalogText("workshop:username_806a9528")} aria-label={catalogText("workshop:username_to_share_with_ce819d48")}
        autoComplete="off" spellCheck={false}
        maxLength={32}
        value={pop.value}
        onChange={(e) => pop.type(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); pop.send(); }
          if (e.key === 'Escape') pop.close();
        }}
      />} messages={{"placeholder":"workshop:username_806a9528","aria-label":"workshop:username_to_share_with_ce819d48"}} />
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
      ><LocalizedValue render={() => (pop.sending ? tr("workshop:sending_b8ed5279") : tr("workshop:send_f6f4688f"))} /></button>
    </div>} messages={{"aria-label":"workshop:share_this_spec_with_one_person_09c35a72"}} />
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
            : <option value=""><Message id="workshop:no_versions_yet_ff76e037" /></option>}
        </select>
        <CopyButton action={s.copy} raw={s.raw} />
        <UserShareButton action={s.userShare} pop={pop} />
        <GroupShareButton action={s.groupShare} version={s.version} />
        <Localized element={<button
          id="dc-spec-viewer-close" className="dc-spec-viewer-close" aria-label={catalogText("workshop:close_spec_viewer_1aa0a813")}
          onClick={() => controller()?.closeSpecViewer?.()}
        >×</button>} messages={{"aria-label":"workshop:close_spec_viewer_1aa0a813"}} />
        {owner ? <SharePopoverCard pop={pop} /> : null}
      </div>
      <div className="dc-spec-viewer-body-wrap"><Body body={s.body} /></div>
      {s.buildHint ? <div className="dc-spec-viewer-build-hint">{BUILD_HINT()}</div> : null}
    </>
  );
}

export function SpecViewer(): ReactNode {
  useUiLanguage();
  return <SpecViewerView s={useStoreState(specViewerStore)} />;
}
