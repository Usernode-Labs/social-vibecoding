/**
 * Invite — the third pane of the app-context sheet: a link to this project
 * that anyone can use to join it (/invite/<token>,
 * src/services/community-invites.js).
 *
 * ── What it does, in order ────────────────────────────────────────────
 *
 *   1. THE LINK. Your newest live link for this project, or a new one made
 *      the first time you open the pane: opening it again does not mint
 *      another. Copy, and Share where the device has a share sheet.
 *   2. WHAT IT DOES, in one sentence: who can use it, for how long, for how
 *      many people, and — what a new person meets — that somebody new to
 *      Homeroom joins the waitlist first and this project when let in.
 *   3. CHANGE. How long and for how many, within the server's limits; a new
 *      link is made with them. The old one keeps working until turned off.
 *   4. YOUR LINKS. Every live one, with Turn off. Someone who manages the
 *      project sees everyone's, with who made each.
 *
 * ── It is a PANE, for About's reason ──────────────────────────────────
 *
 * The kit cannot present a sheet while it is still dismissing another, and
 * inviting is where this menu goes rather than something opened over it
 * (./about-pane.tsx). The header row's back arrow is the way back.
 *
 * Nothing here is in the prerender: `view` is 'menu' there, so the pane only
 * ever renders on the client, and its data loads in an effect.
 */

import { useCallback, useEffect, useState } from 'react';

import { CopyIcon, ShareIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

import { daysUntil } from './invite-model';

export type InviteLink = {
  id: number;
  token: string;
  path: string;
  /** null: any number of people (WP-D). */
  maxUses: number | null;
  uses: number;
  /** null: no end date; it works until it is turned off (WP-D). */
  expiresAt: string | null;
  createdBy: string | null;
  mine: boolean;
};

export type InviteState = {
  links: InviteLink[];
  manages: boolean;
  canCreate: boolean;
  grant: 'member' | 'collaborator';
  defaults: { days: number; maxUses: number };
  limits: { minDays: number; maxDays: number; minUses: number; maxUses: number };
  skipsLeft: number | null;
  /** WP-D: what joining means here, from the project's real rule. */
  joiningRule?: string | null;
};

const ROW = 'flex items-center gap-3 px-5 min-h-[44px] text-sm w-full text-left '
  + 'text-zinc-700 dark:text-zinc-200';
const SECTION = 'px-5 pt-4 pb-1 text-[0.7rem] font-semibold uppercase tracking-wide '
  + 'text-zinc-400 dark:text-zinc-500';
const NOTE = 'px-5 py-2 text-sm text-zinc-500 dark:text-zinc-400';
const PRIMARY = 'inline-flex flex-1 basis-0 min-w-0 items-center justify-center gap-1.5 h-10 px-4 '
  + 'rounded-full text-sm font-semibold bg-violet-600 hover:bg-violet-500 text-white transition-colors';
const SECONDARY = 'inline-flex flex-1 basis-0 min-w-0 items-center justify-center gap-1.5 h-10 px-4 '
  + 'rounded-full text-sm font-semibold bg-zinc-200 hover:bg-zinc-300 dark:bg-zinc-800 '
  + 'dark:hover:bg-zinc-700 text-zinc-900 dark:text-zinc-100 transition-colors';

// 0 asks for no limit (WP-D): no end date, or any number of people.
const NO_LIMIT = 0;
const DAY_CHOICES = [1, 7, 30, NO_LIMIT];
const USE_CHOICES = [1, 5, 10, 25, 50, 100, NO_LIMIT];

/** The sentence under the link. */
export function linkSentence(link: Pick<InviteLink, 'expiresAt' | 'maxUses' | 'uses'>, grant: string, now = Date.now()): string {
  const who = grant === 'collaborator'
    ? 'Anyone with this link can join and build with you.'
    : 'Anyone with this link can join.';
  if (link.expiresAt == null && link.maxUses == null) return `${who} It works until you turn it off.`;
  const days = link.expiresAt == null ? null : daysUntil(link.expiresAt, now);
  const when = days == null ? 'It has no end date' : days <= 1 ? 'It expires within a day' : `It expires in ${days} days`;
  if (link.maxUses == null) return `${who} ${when}.`;
  // Before anyone has used it, the number it was made for; after, what is
  // left of it.
  const count = link.uses ? Math.max(0, link.maxUses - link.uses) : link.maxUses;
  const more = link.uses ? ' more' : '';
  return `${who} ${when} and works for ${count}${more} ${count === 1 ? 'person' : 'people'}.`;
}

/** "3 of 25 used · 5 days left", for a row of Your links. */
export function linkDetail(link: Pick<InviteLink, 'expiresAt' | 'maxUses' | 'uses'>, now = Date.now()): string {
  const used = link.maxUses == null ? `${link.uses} joined` : `${link.uses} of ${link.maxUses} used`;
  if (link.expiresAt == null) return `${used} · no end date`;
  const days = daysUntil(link.expiresAt, now);
  return `${used} · ${days <= 1 ? 'under a day left' : `${days} days left`}`;
}

/** The line about people new to Homeroom. */
export function newcomerLine(skipsLeft: number | null): string {
  if (skipsLeft && skipsLeft > 0) {
    return `You can let ${skipsLeft} ${skipsLeft === 1 ? 'person' : 'people'} new to Homeroom skip the waitlist.`;
  }
  return 'Someone new to Homeroom joins the waitlist first, and this project when they are let in.';
}

function absolute(path: string): string {
  try { return new URL(path, window.location.origin).toString(); } catch { return path; }
}

async function api(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || 'Something went wrong. Try again.');
  return body;
}

export function InvitePane({ slug, label }: { slug: string | null; label: string }) {
  const [state, setState] = useState<InviteState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [changing, setChanging] = useState(false);
  const [days, setDays] = useState(7);
  const [uses, setUses] = useState(25);

  const base = slug ? `/api/apps/${encodeURIComponent(slug)}/invite-links` : null;

  const load = useCallback(async (makeIfNone: boolean) => {
    if (!base) return;
    setError(null);
    try {
      let next: InviteState = await api(base);
      if (makeIfNone && next.canCreate && !next.links.some((l) => l.mine)) {
        await api(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        next = await api(base);
      }
      setState(next);
      setDays(next.defaults.days);
      setUses(next.defaults.maxUses);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [base]);

  useEffect(() => { void load(true); }, [load]);

  const current = state?.links.find((l) => l.mine) || null;
  const url = current ? absolute(current.path) : '';

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('Could not copy. Press and hold the link to copy it.');
    }
  };
  const share = async () => {
    if (!url || typeof navigator.share !== 'function') return;
    try { await navigator.share({ title: `Join ${label} on Homeroom`, url }); } catch { /* dismissed */ }
  };
  const make = async () => {
    if (!base) return;
    setBusy(true);
    setError(null);
    try {
      await api(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days, maxUses: uses }),
      });
      setChanging(false);
      await load(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async (link: InviteLink) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/invite-links/${link.id}`, { method: 'DELETE' });
      await load(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!slug) return <div id="app-invite-pane"><p className={NOTE}>Open a project to invite people to it.</p></div>;
  if (!state) {
    return (
      <div id="app-invite-pane">
        <p className={NOTE}>{error || 'Making your link…'}</p>
      </div>
    );
  }
  if (!state.canCreate) {
    return (
      <div id="app-invite-pane">
        <p className={NOTE}>
          {state.grant === 'collaborator'
            ? `Only the people building ${label} can invite others to it.`
            : `Join ${label} to invite people to it.`}
        </p>
      </div>
    );
  }
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <div id="app-invite-pane" className="pb-2">
      <div className="px-5 pt-1">
        <div className="text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100">
          {`Invite people to ${label}`}
        </div>
      </div>
      {current ? (
        <>
          <div className="px-5 pt-3">
            <Input
              id="app-invite-url"
              readOnly
              value={url}
              aria-label="Invite link"
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
          <p id="app-invite-sentence" className="px-5 pt-2 text-[0.8125rem] leading-snug text-zinc-600 dark:text-zinc-300">
            {linkSentence(current, state.grant)}
          </p>
          <div className="flex items-stretch gap-2 px-5 pt-3">
            <button id="app-invite-copy" type="button" className={PRIMARY} onClick={copy}>
              <CopyIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{copied ? 'Copied' : 'Copy link'}</span>
            </button>
            {canShare ? (
              <button id="app-invite-share" type="button" className={SECONDARY} onClick={share}>
                <ShareIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="truncate">Share</span>
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      <p className="px-5 pt-3 text-[0.8125rem] leading-snug text-zinc-500 dark:text-zinc-400">
        {newcomerLine(state.skipsLeft)}
      </p>
      {state.joiningRule ? (
        <p data-invite-rule="" className="px-5 pt-2 text-[0.8125rem] leading-snug text-zinc-500 dark:text-zinc-400">
          {state.joiningRule}
        </p>
      ) : null}
      {error ? <p role="alert" className="px-5 pt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}

      {changing ? (
        <div id="app-invite-change" className="px-5 pt-4 space-y-3">
          <label className="block text-sm text-zinc-700 dark:text-zinc-200">
            <span className="block pb-1">Expires after</span>
            <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              {DAY_CHOICES.filter((d) => d === NO_LIMIT || (d >= state.limits.minDays && d <= state.limits.maxDays)).map((d) => (
                <option key={d} value={d}>{d === NO_LIMIT ? 'Until you turn it off' : d === 1 ? '1 day' : `${d} days`}</option>
              ))}
            </Select>
          </label>
          <label className="block text-sm text-zinc-700 dark:text-zinc-200">
            <span className="block pb-1">Works for</span>
            <Select value={String(uses)} onChange={(e) => setUses(Number(e.target.value))}>
              {USE_CHOICES.filter((n) => n === NO_LIMIT || (n >= state.limits.minUses && n <= state.limits.maxUses)).map((n) => (
                <option key={n} value={n}>{n === NO_LIMIT ? 'Anyone with the link' : n === 1 ? '1 person' : `${n} people`}</option>
              ))}
            </Select>
          </label>
          <div className="flex items-stretch gap-2">
            <button type="button" className={SECONDARY} onClick={() => setChanging(false)}>Cancel</button>
            <button id="app-invite-make" type="button" className={PRIMARY} disabled={busy} onClick={make}>
              Make new link
            </button>
          </div>
        </div>
      ) : (
        <button
          id="app-invite-change-open"
          type="button"
          className="w-full px-5 min-h-[40px] text-left text-sm font-medium text-violet-700 dark:text-violet-400 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
          onClick={() => setChanging(true)}
        >
          Change how long or how many
        </button>
      )}

      {state.links.length ? (
        <div id="app-invite-links">
          <h4 className={SECTION}>{state.manages ? 'Live links' : 'Your links'}</h4>
          {state.links.map((link) => (
            <div key={link.id} className={ROW} data-invite-link={link.id}>
              <span className="flex-1 min-w-0">
                <span className="block truncate">{linkDetail(link)}</span>
                {!link.mine && link.createdBy ? (
                  <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">{`by @${link.createdBy}`}</span>
                ) : null}
              </span>
              <button
                type="button"
                className="shrink-0 text-sm font-medium text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
                disabled={busy}
                onClick={() => turnOff(link)}
              >
                Turn off
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
