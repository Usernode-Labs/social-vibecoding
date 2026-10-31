/**
 * #ai-screen — the AI tab's main view (#6019 follow-up; plan v3, "the
 * Homeroom bot tab: what needs you comes first, then your private threads,
 * with a lock on the tile, then Up next: what's moving without you, soonest
 * first. Ask Homeroom bot opens Main"). Needs you here is only the threads
 * you are in; Communities › Needs you has every decision you owe.
 *
 * 29 Oct 2026 (Evan): the first list is Needs you, since it holds other
 * people's threads too, and only what waits on you; In progress is what is
 * being worked on; what waits on someone else (other people's votes, a free
 * builder or slot) is Waiting. 30 Oct 2026, from his Task Assistant
 * prototype: one line a row, grouped by project, on three sheets, with a
 * chip for each project (./lists.tsx draws them):
 *
 *   [bot] Homeroom bot             Needs you: 2 · In progress: 1
 *   ( All ) ( Garden club ) ( Bread bot )
 *
 *   NEEDS YOU · 2
 *   [tile] Garden club
 *     ☑ #403  Dark mode                                     Vote
 *     ▶ #410  A reminder email                          Build it
 *   ─────────
 *   IN PROGRESS · 1
 *   ─────────
 *   WAITING · 2
 *
 *   LIVE THIS WEEK · 1
 *   ( Ask Homeroom bot )                  ← narrower than a desktop: Main
 *
 * Main Chat, the private conversation with the bot, is the Messages
 * screen's chat with it (`#homeroom-bot/main`, ../messages). On a desktop
 * it is docked beside this list (EmbeddedConversation), and a private
 * thread opens in it. On a phone the list and Main are one drawer, as
 * Messages' list and a conversation are (./phone-drawer.tsx): Main peeks at
 * the list's right, and the Ask bar, the peek or a private thread slides it
 * in. Between the two, the Ask bar opens `#homeroom-bot/main`.
 *
 * A REQUEST, A CHANGE OR A DECISION OPENS HERE TOO. On a wide window in the
 * column beside the list, in Main's place: the side panel, drawn as this
 * page's own column (‹ Main Chat and the page's own name over it, no
 * Expand, no Close; ../side-panel/side-panel.tsx), and Main's composer
 * takes it as the item a question is about. Anywhere else on its page,
 * whose back chip says ‹ Homeroom bot and comes back here, with the
 * project's Workshop beside it (Improve.enterTopicFrom), and the tab bar
 * keeps Homeroom bot lit (App._isBotTopic). The phone's drawer holds only
 * Main and its threads (Evan, 30 Oct: "the Messages approach").
 *
 * THE FIRST RENDER IS THE PRERENDER: the screen hidden, the bot's name and
 * no rows. The lists load in effects once the screen is shown to somebody
 * signed in, and the docked pane and the drawer exist only after mount.
 * While the screen is up they are read again whenever a thread they list
 * moves (./live.ts), not only when it is shown again.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { LockIcon, MicrophoneIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { FRESH } from '../../lib/live-reads';
import { useVisibility, useVisibilityHiddenClass } from '../../lib/visibility-store';
import { EmbeddedConversation } from '../messages';
import { NewThreadButton } from '../messages/new-thread';
import { openBotConversation } from '../messages/api';
import { BOT_AVATAR } from '../messages/format';
import { SidePanelDivider } from '../side-panel/side-panel';
import { useLiveLists } from './live';
import { AiLists } from './lists';
import { AiDrawer, MainPane, usePhone } from './phone-drawer';
import {
  heroWords, inProgress, isTopicHref, needsYou, owedCount, rankProjects, upNext,
  type AiApp, type AiThread, type AiWork, type NeedItem, type Phrase, type WorkRow,
} from './model';

const WIDE = '(min-width: 1024px)';
/** This page's address: where a thread opened from it comes back to. */
const BOT_PAGE = '#homeroom-bot';

function demoQuery(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('demo') === '1' ? '?demo=1' : '';
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(path, { ...init, credentials: 'same-origin' });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const query = window.matchMedia(WIDE);
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener?.('change', sync);
    return () => query.removeEventListener?.('change', sync);
  }, []);
  return wide;
}

function go(href: string | null): void {
  if (href && typeof window !== 'undefined') window.location.hash = href.replace(/^#/, '');
}

/** The side panel's controller (features/side-panel/), when the shell has one. */
function sidePanel(): {
  take?: (route: string, hint?: { place?: AiApp | null; label?: string | null } | null) => boolean;
  close?: () => void;
} | null {
  return typeof window === 'undefined' ? null : (window as any).UsernodeReact?.sidePanel || null;
}

/**
 * What a row opens, as the item Main's composer can carry (the ◆ chip a
 * shared item gets): a request by its number, a change by its session, a
 * decision by its id. Null for a page that is none of those (a Workshop).
 */
export interface AboutItem {
  type: 'issue' | 'proposal' | 'governance';
  appSlug: string;
  issueNumber?: number;
  sessionId?: number;
  proposalId?: number;
  title: string | null;
}
export function aboutRow(row: { key?: string; href: string | null; title?: string | null; app: AiApp | null; change?: { id: number } | null }): AboutItem | null {
  const slug = row.app?.slug;
  if (!slug) return null;
  const title = row.title || null;
  const issue = String(row.href || '').match(/^#?app\/[^/]+\/dev\/issues\/(\d+)$/);
  if (issue) return { type: 'issue', appSlug: slug, issueNumber: Number(issue[1]), title };
  const need = String(row.key || '').match(/^need:(proposal|governance):(\d+)$/);
  if (need?.[1] === 'proposal') return { type: 'proposal', appSlug: slug, sessionId: Number(need[2]), title };
  if (need?.[1] === 'governance') return { type: 'governance', appSlug: slug, proposalId: Number(need[2]), title };
  if (row.change?.id) return { type: 'proposal', appSlug: slug, sessionId: row.change.id, title };
  return null;
}

/** The Improve controller, which records where a topic page was opened from. */
function improve(): { enterTopicFrom?: (href: string) => void } | null {
  return typeof window === 'undefined' ? null : (window as any).Improve || null;
}

/**
 * A request, a change or a decision, opened from the list. On a wide
 * window in the column beside the list, in Main's place (the side panel,
 * drawn as this page's column: ‹ Main Chat and the page's name over it);
 * anywhere else, and whenever the panel does not take it, its page, which
 * goes back here.
 */
function openPublic(href: string | null, app: AiApp | null, label: string | null, about: AboutItem | null, botId: number | null): void {
  if (!href) return;
  try {
    if (sidePanel()?.take?.(href.replace(/^#/, ''), { place: app, label })) {
      // Main stays mounted under the panel (only hidden), so its composer
      // takes what was opened now, and ‹ Main Chat comes back to it
      // attached: a question about it needs no number (30 Oct 2026, from
      // Evan's Task Assistant prototype). × on the chip takes it off. It is
      // addressed to Main alone: the Messages screen's composer, mounted
      // under its hidden screen, keeps whatever it had.
      if (about && botId) {
        window.dispatchEvent(new CustomEvent('usernode:messages-object-selected', { detail: { ...about, conversationId: botId } }));
      }
      return;
    }
  } catch {
    /* the page instead */
  }
  if (isTopicHref(href)) improve()?.enterTopicFrom?.(BOT_PAGE);
  go(href);
}

export function AiScreen(): ReactNode {
  const t = useMessages('messages');
  const say = (p: Phrase) => t(p.id, p.values);
  const screenRef = useRef<HTMLElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'ai-screen', false);
  const visible = useVisibility('ai-screen', false);
  const wide = useWide();
  const [work, setWork] = useState<AiWork | null>(null);
  const [needs, setNeeds] = useState<NeedItem[] | null>(null);
  const [botId, setBotId] = useState<number | null>(null);
  const [at, setAt] = useState<{ threadRootId: number | null; focusMessageId: number | null } | null>(null);
  // A phone: the list and Main are one drawer (./phone-drawer.tsx); level 1 is Main.
  const phone = usePhone();
  const [level, setLevel] = useState<0 | 1>(0);
  // A boot from the saved session draws this page before the server has
  // confirmed who you are, and a read made in that window can come back
  // with nothing; so could the chat docked beside it. `sv:session` (app.js)
  // is the shell saying who is signed in, so both are asked again then,
  // rather than staying empty until a reload (29 Oct 2026).
  const [session, setSession] = useState(0);
  useEffect(() => {
    const again = () => setSession((n) => n + 1);
    document.addEventListener('sv:session', again);
    return () => document.removeEventListener('sv:session', again);
  }, []);

  // Read on every showing: what is yours changes while you are elsewhere.
  // And again while the page is up, each time a thread it lists moves
  // (./live.ts counts those in `moved`). Every read after the first asks
  // past the service worker's saved copy, since it is for what changed
  // since; one that fails keeps the lists as they were.
  const [moved, setMoved] = useState(0);
  const readBefore = useRef(false);
  useEffect(() => {
    if (!visible || typeof window === 'undefined' || !(window as any).App?.user) return undefined;
    let live = true;
    const qs = demoQuery();
    const again = readBefore.current;
    readBefore.current = true;
    const init = again ? FRESH : undefined;
    void readJson<AiWork>(`/api/ai/work${qs}`, init).then((data) => { if (live && data) setWork(data); });
    void readJson<{ items?: NeedItem[] }>(`/api/workshop/needs-feed?in=threads${qs ? '&demo=1' : ''}`, init)
      .then((data) => {
        if (live && (data || !again)) setNeeds(Array.isArray(data?.items) ? data!.items : []);
      });
    return () => { live = false; };
  }, [visible, session, moved]);

  // Main beside the list, on a desktop, or peeking beside it in a phone's
  // drawer: the chat with the bot, opened once.
  useEffect(() => {
    if (!visible || !(wide || phone) || botId || typeof window === 'undefined' || !(window as any).App?.user) return;
    void openBotConversation().then((id) => { if (id) setBotId(id); }).catch(() => {});
  }, [visible, wide, phone, botId, session]);

  const rows = useMemo(() => needsYou(needs, work), [needs, work]);
  const progress = useMemo(() => inProgress(needs, work), [needs, work]);
  const waiting = useMemo(() => upNext(needs, work), [needs, work]);
  const live: AiThread[] = useMemo(() => work?.live || [], [work]);
  const owed = owedCount(rows);
  const docked = wide && !!botId;
  const projects = useMemo(
    () => new Set(rankProjects(rows, progress, waiting, live).map((p) => p.app.slug)),
    [rows, progress, waiting, live],
  );
  useLiveLists(() => setMoved((n) => n + 1), visible, { projects, botId });

  // Main, slid in on a phone: at a private thread of it, or where it was.
  const openMain = (threadRootId: number | null) => {
    if (threadRootId) setAt({ threadRootId, focusMessageId: null });
    setLevel(1);
  };
  const openRow = (row: WorkRow) => {
    if (row.rootId) {
      // A private thread is Main's: the panel, if a page is up in it, gives
      // Main its place back.
      if (phone) openMain(row.rootId);
      else if (docked) {
        sidePanel()?.close?.();
        setAt({ threadRootId: row.rootId, focusMessageId: null });
      } else go(`#homeroom-bot/thread/${row.rootId}`);
      return;
    }
    openPublic(row.href, row.app, row.title, aboutRow(row), botId);
  };
  const openThread = (th: AiThread) => openPublic(th.href, th.app, th.title, aboutRow(th), botId);

  // #6071 follow-up: "+" starts a new blank thread with the bot, in Main
  // Chat (../messages/new-thread.tsx): docked beside the lists, slid in on a
  // phone, or Main's own page between the two.
  const openBlank = () => {
    if (phone) { setAt(null); openMain(null); return; }
    if (docked) { sidePanel()?.close?.(); return; }
    go('#homeroom-bot/main');
  };
  const hero = (
    <section className="flex items-center gap-3 px-4 pt-3" data-ai-hero="">
      <img src={BOT_AVATAR} alt="" className="w-12 h-12 rounded-2xl object-cover shrink-0" />
      <span className="min-w-0 flex-1 flex flex-col">
        <h1 className="text-[1.375rem] font-bold leading-tight">{t('messages:ai.hero.name')}</h1>
        {work ? (
          <span className="text-[13px] text-zinc-500 dark:text-zinc-400" data-ai-hero-sub="">
            {say(heroWords(owed, progress.length))}
          </span>
        ) : null}
      </span>
      <NewThreadButton
        conversationId={botId || null}
        onOpen={openBlank}
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-zinc-700 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800 [&>svg]:h-5 [&>svg]:w-5"
      />
    </section>
  );

  const listContent = (
    <>
      <div className="ai-screen-body max-w-2xl mx-auto pb-8">
        <AiLists
          hero={hero}
          ready={!!work && !!needs}
          rows={rows}
          owed={owed}
          progress={progress}
          waiting={waiting}
          live={live}
          openRow={openRow}
          openThread={openThread}
        />
        <div className="ai-askbar-gap" aria-hidden="true" />
      </div>

      {/* Ask Homeroom bot: Main. A bar over the tab bar; on a desktop Main
          is docked beside the list and this is not drawn. */}
      <div className="ai-askbar messages-composer" data-ai-askbar="">
        <a
          href="#homeroom-bot/main"
          className="messages-composer-card ai-askbar-card"
          aria-label={t('messages:ai.ask.label')}
          // On a phone's drawer Main is beside the list: in, not away.
          onClick={(e) => { if (phone) { e.preventDefault(); setAt(null); openMain(null); } }}
        >
          <span className="ai-askbar-text">{t('messages:ai.ask.label')}</span>
          <span className="messages-composer-action" aria-hidden="true"><MicrophoneIcon className="h-5 w-5" /></span>
        </a>
      </div>
    </>
  );

  return (
    <main
      ref={screenRef}
      id="ai-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      data-page-bounce=""
      data-ai-docked={docked ? '' : undefined}
      data-ai-drawer={phone ? level : undefined}
      style={{ position: 'relative' }}
    >
      {phone ? (
        <AiDrawer
          level={level}
          onLevel={setLevel}
          list={listContent}
          peekLabel={t('messages:ai.drawer.peek', { title: t('messages:store.header.main') })}
          pane={<MainPane botId={botId} active={visible} at={at} onBack={() => setLevel(0)} />}
        />
      ) : listContent}

      {/* Main's left edge is the side panel's handle (30 Oct 2026): drag it,
          or use the arrow keys, to share the window between the list and
          Main; a page opened in Main's place keeps the width. */}
      {docked ? (
        <aside id="ai-main-pane" ref={mainRef} className="ai-main-pane" aria-labelledby="ai-main-title" data-ai-main="">
          <SidePanelDivider panelRef={mainRef} shown={docked} id="ai-main-divider" controls="ai-main-pane" />
          <header className="ai-main-head" data-ai-main-head="">
            <img src={BOT_AVATAR} alt="" className="w-8 h-8 rounded-[10px] object-cover shrink-0" />
            <span className="min-w-0 flex flex-col">
              <span id="ai-main-title" className="truncate text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">
                {t('messages:store.header.main')}
              </span>
              <span className="flex min-w-0 items-center gap-1 text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">
                <LockIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{t('messages:ai.main.sub')}</span>
              </span>
            </span>
          </header>
          <EmbeddedConversation conversationId={botId!} active={visible} at={at} mainChat />
        </aside>
      ) : null}
    </main>
  );
}
