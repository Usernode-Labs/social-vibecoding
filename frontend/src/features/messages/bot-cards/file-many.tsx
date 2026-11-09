// #6305: the "file_many" card: one request on several projects, with a row
// for each and one File on all (services/homeroom-bot-cards/file-many.js).
//
// The row for a project whose name matches says "Matches X" and starts
// ticked. A row whose name does not match asks "Did you mean ...?" with the
// closest projects to tap, and stays unticked until one is picked. A row for
// an app that already does what the request asks says so in one sentence and
// starts unticked. Nothing files until File on all is tapped.
//
// Every field is read defensively: the card is whatever the server stored.

import { useState } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { issueRefHref } from '../channels';
import { decideCard, type BotCardProps } from './index';
import { CARD_BUTTON, CardLabel, CardShell, CardTitle, cardText } from './card-ui';

export type FileManyMatch = 'exact' | 'guess' | 'none';

export interface FileManyChoice { slug: string; name: string }
export interface FileManyRow {
  named: string;
  match: FileManyMatch;
  slug: string | null;
  name: string;
  choices: FileManyChoice[];
  done: string | null;
  disabled: 'not_member' | null;
  ticked: boolean;
  issueNumber?: number | null;
  error?: 'not_member' | 'busy' | 'failed' | null;
}
export interface FileManyCardData {
  state: 'open' | 'filing' | 'filed' | 'dropped';
  title: string;
  details: string;
  rows: FileManyRow[];
  forMe: boolean;
}

const MAX_ROWS = 12;

const text = (v: unknown, max = 240) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** Pure: the card as stored, read defensively. */
export function fileManyOf(card: Record<string, unknown>): FileManyCardData {
  const state = card.state === 'filing' || card.state === 'filed' || card.state === 'dropped' ? card.state : 'open';
  const forUserId = num(card.forUserId);
  const me = typeof window !== 'undefined' ? num((window as any).App?.user?.id) : null;
  const rows = (Array.isArray(card.rows) ? card.rows : []).slice(0, MAX_ROWS).flatMap((value) => {
    const row = (value || {}) as Record<string, unknown>;
    const named = text(row.named) || text(row.name) || text(row.slug);
    if (!named) return [];
    const match: FileManyMatch = row.match === 'guess' || row.match === 'none' ? row.match : 'exact';
    const choices: FileManyChoice[] = (Array.isArray(row.choices) ? row.choices : []).flatMap((c) => {
      const choice = (c || {}) as Record<string, unknown>;
      const slug = text(choice.slug, 80);
      return slug ? [{ slug, name: text(choice.name, 120) || slug }] : [];
    }).slice(0, 3);
    const error: FileManyRow['error'] = row.error === 'not_member' || row.error === 'busy' || row.error === 'failed' ? row.error : null;
    return [{
      named,
      match,
      slug: text(row.slug, 80) || null,
      name: text(row.name, 120) || named,
      choices,
      done: text(row.done, 140) || null,
      disabled: row.disabled === 'not_member' ? 'not_member' as const : null,
      ticked: row.ticked === true,
      issueNumber: num(row.issueNumber),
      error,
    }];
  });
  return {
    state,
    title: text(card.title, 400),
    details: text(card.details, 2000),
    rows,
    forMe: forUserId == null || me == null || forUserId === me,
  };
}

/**
 * Pure: the picks a set of ticks sends, as "index:slug": an exact row's own
 * slug, or the project picked on a "Did you mean" row.
 */
export function picksOf(rows: FileManyRow[], ticked: boolean[], chosen: Record<number, string>): string[] {
  const out: string[] = [];
  rows.forEach((row, i) => {
    if (!ticked[i]) return;
    const slug = row.match === 'exact' ? row.slug : chosen[i];
    if (slug) out.push(`${i}:${slug}`);
  });
  return out;
}

type T = ReturnType<typeof useMessages>;

export interface FileManyRowsProps {
  data: FileManyCardData;
  ticked: boolean[];
  chosen: Record<number, string>;
  onToggle?: (index: number) => void;
  onChoose?: (index: number, slug: string) => void;
}

/** The rows of the card, shared by the DM card and a project's thread. */
export function FileManyRows({ data, ticked, chosen, onToggle, onChoose }: FileManyRowsProps) {
  const t = useMessages('messages');
  return (
    <ul className="mt-2 flex flex-col" data-bot-file-many-rows="">
      {data.rows.map((row, i) => {
        const done = row.done ? t('messages:botCards.fileMany.alreadyDone', { sentence: row.done }) : null;
        const reason = row.disabled === 'not_member'
          ? t('messages:botCards.fileMany.notMember', { name: row.name })
          : row.error ? t('messages:botCards.fileMany.failed') : null;
        return (
          <li
            key={`${i}:${row.named}`}
            className="flex items-start gap-2.5 border-t border-[color:var(--app-sheet-line)] py-2.5 first:border-t-0"
            data-bot-file-many-row={i}
            data-match={row.match}
          >
            <button
              type="button"
              role="checkbox"
              aria-checked={ticked[i] === true}
              aria-label={t('messages:botCards.fileMany.tick', { name: row.name })}
              disabled={data.state !== 'open' || row.disabled === 'not_member' || (row.match !== 'exact' && !chosen[i])}
              onClick={() => onToggle?.(i)}
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
                ticked[i] ? 'border-[color:var(--accent)] bg-[color:var(--accent)] text-[color:var(--accent-ink)]' : 'border-zinc-400 dark:border-zinc-500'
              } disabled:opacity-60`}
              data-bot-file-many-tick={ticked[i] ? 'on' : 'off'}
            >
              {ticked[i] ? <span aria-hidden="true" className="text-[0.75rem] leading-none">✓</span> : null}
            </button>
            <div className="min-w-0 flex-1">
              <div className="text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{row.name}</div>
              {row.issueNumber ? (
                <a className="text-[0.8125rem] font-semibold text-[color:var(--accent)]" href={issueRefHref(row.slug || '', String(row.issueNumber))} data-bot-file-many-filed={row.issueNumber}>
                  {t('messages:botCards.fileMany.filed', { number: String(row.issueNumber) })}
                </a>
              ) : reason ? (
                <p className="text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-bot-file-many-reason="">{reason}</p>
              ) : done ? (
                <p className="text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-bot-file-many-done="">{done}</p>
              ) : row.match === 'exact' ? (
                <p className="text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-bot-file-many-matches="">
                  {t('messages:botCards.fileMany.matches', { name: row.name })}
                </p>
              ) : (
                <p className="text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-bot-file-many-ask="">
                  {row.choices.length
                    ? t('messages:botCards.fileMany.didYouMean', { name: row.named })
                    : t('messages:botCards.fileMany.noMatch', { name: row.named })}
                </p>
              )}
              {row.match !== 'exact' && !row.issueNumber && row.choices.length ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {row.choices.map((choice) => (
                    <button
                      key={choice.slug}
                      type="button"
                      disabled={data.state !== 'open'}
                      onClick={() => onChoose?.(i, choice.slug)}
                      className={`${CARD_BUTTON.tint} min-h-[36px] px-3`}
                      aria-pressed={chosen[i] === choice.slug}
                      data-bot-file-many-choice={choice.slug}
                    >
                      {choice.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The whole card: its label, title, rows, File on all and Not now. */
export function FileManyCardView({ data, busy, error, ticked, chosen, onToggle, onChoose, onFile, onNotNow }: {
  data: FileManyCardData;
  busy?: boolean;
  error?: string | null;
  ticked: boolean[];
  chosen: Record<number, string>;
  onToggle?: (index: number) => void;
  onChoose?: (index: number, slug: string) => void;
  onFile?: () => void;
  onNotNow?: () => void;
}) {
  const t = useMessages('messages');
  const filed = data.state === 'filed';
  const open = data.state === 'open' && data.forMe;
  const picks = picksOf(data.rows, ticked, chosen);
  const skipped = data.rows.length - picks.length;
  const count = data.rows.length;
  return (
    <CardShell state={data.state}>
      <CardLabel>{t(count === 1 ? 'messages:botCards.fileMany.label_one' : 'messages:botCards.fileMany.label_other', { count })}</CardLabel>
      <CardTitle>{data.title}</CardTitle>
      {data.details ? (
        <p className="mt-1 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">{data.details}</p>
      ) : null}
      <FileManyRows data={data} ticked={ticked} chosen={chosen} onToggle={onToggle} onChoose={onChoose} />
      {open ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={CARD_BUTTON.primary}
            disabled={busy || !picks.length}
            onClick={() => onFile?.()}
            data-bot-file-many-action="file"
          >
            {t('messages:botCards.fileMany.fileOnAll')}
          </button>
          <button type="button" className={CARD_BUTTON.neutral} disabled={busy} onClick={() => onNotNow?.()} data-bot-file-many-action="not-now">
            {t('messages:botCards.fileMany.notNow')}
          </button>
          <span className="text-[0.8125rem] text-zinc-500 dark:text-zinc-400" data-bot-file-many-counts="">
            {t('messages:botCards.fileMany.counts', { ticked: picks.length, skipped })}
          </span>
        </div>
      ) : filed ? (
        <p className="mt-2 text-[0.8125rem] font-semibold text-zinc-600 dark:text-zinc-300" data-bot-file-many-filed-state="">
          {t('messages:botCards.fileMany.filedAll', { count: picks.length || data.rows.filter((r) => r.issueNumber).length })}
        </p>
      ) : null}
      {error ? <p className="mt-1 text-sm text-red-700 dark:text-red-400" role="alert">{error}</p> : null}
    </CardShell>
  );
}

/** The card is read from the message's card (services/homeroom-bot-cards). */
export function FileManyCard({ message, card }: BotCardProps) {
  const t = useMessages('messages');
  const data = fileManyOf(card as Record<string, unknown>);
  const [ticked, setTicked] = useState<boolean[]>(() => data.rows.map((r) => r.ticked));
  const [chosen, setChosen] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (i: number) => setTicked((was) => was.map((on, j) => (j === i ? !on : on)));
  const choose = (i: number, slug: string) => {
    setChosen((was) => ({ ...was, [i]: slug }));
    setTicked((was) => was.map((on, j) => (j === i ? true : on)));
  };
  async function decide(action: 'file' | 'dismiss', value?: string[]) {
    setError(null);
    setBusy(true);
    try {
      await decideCard(message, action, value);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('messages:botCards.fileMany.busy'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <FileManyCardView
      data={data}
      busy={busy}
      error={error}
      ticked={ticked}
      chosen={chosen}
      onToggle={toggle}
      onChoose={choose}
      onFile={() => { const picks = picksOf(data.rows, ticked, chosen); if (picks.length) void decide('file', picks); }}
      onNotNow={() => { void decide('dismiss'); }}
    />
  );
}
