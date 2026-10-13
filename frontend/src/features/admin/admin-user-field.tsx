import { useEffect, useRef, useState, type ReactNode } from 'react';

import { AdminUI } from './admin-console.js';

// One username row of an admin people list: a field that suggests accounts
// as you type, a beat behind (a late answer to an older query never
// replaces a newer one), with the create dialog's keyboard: arrows move,
// Enter picks, Escape closes. An option is taken on mousedown, before the
// field's blur can close the list.
//
// Shared by Welcome messages (admin-welcome-dm.tsx) and the Homeroom bot's
// DM list (admin-homeroom-bot.tsx). Each passes its own ids, data attribute
// prefix and search route, so either section's markup is its own; the
// search route answers `{ users: [{ id, username }] }`.

export interface UserSuggestion { id: number; username: string }

const SUGGEST_DELAY_MS = 150;

export function userHandle(raw: string): string {
  return raw.trim().replace(/^@/, '');
}

export function UserFieldRow({
  idPrefix, dataPrefix, searchPath, index, value, taken, disabled, canWrite,
  ariaLabel, badge = null, children = null, onEdit, onRemove, inputRef,
}: {
  /** The field's id is `${idPrefix}-${index}`; its suggestion list hangs off it. */
  idPrefix: string;
  /** The row and its Remove carry `data-${dataPrefix}-row` / `-remove` = index. */
  dataPrefix: string;
  /** The admin route that suggests accounts for `?q=`. */
  searchPath: string;
  index: number;
  value: string;
  // The other rows' handles, lowercased and newline-joined: a string, so the
  // suggestion effect below only re-runs when they actually change.
  taken: string;
  disabled: boolean;
  canWrite: boolean;
  ariaLabel: string;
  /** Beside the field, before Remove (Welcome messages' "Sends"). */
  badge?: ReactNode;
  /** Under the row: a note about the person it names. */
  children?: ReactNode;
  onEdit: (username: string) => void;
  onRemove: () => void;
  inputRef?: (el: HTMLInputElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<UserSuggestion[]>([]);
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const q = userHandle(value);

  useEffect(() => {
    if (!open || !q) { seq.current += 1; setSuggestions([]); return undefined; }
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      const { data } = await (window as any).AdminConsole
        .fetchJson(`${searchPath}?q=${encodeURIComponent(q)}`);
      if (mine !== seq.current) return;
      const found: UserSuggestion[] = Array.isArray(data?.users) ? data.users : [];
      const others = new Set(taken.split('\n'));
      setSuggestions(found.filter((u) => !others.has(u.username.toLowerCase())));
      setActive(0);
    }, SUGGEST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [open, q, taken, searchPath]);

  const pick = (username: string) => {
    onEdit(username);
    setSuggestions([]);
    setOpen(false);
  };
  // Nothing to offer when the one suggestion is what is already typed.
  const shown = open && suggestions.length > 0
    && !(suggestions.length === 1 && suggestions[0].username.toLowerCase() === q.toLowerCase());
  const listId = `${idPrefix}-${index}-suggestions`;
  const optionId = (i: number) => `${listId}-${i}`;
  const name = q ? `@${q}` : `person ${index + 1}`;

  return (
    <div className="relative" {...{ [`data-${dataPrefix}-row`]: index }}>
      <div className="flex items-center gap-2">
        <input
          id={`${idPrefix}-${index}`} ref={inputRef}
          type="text" autoComplete="off" spellCheck={false}
          className={`${AdminUI.input} disabled:opacity-60`}
          placeholder="@username" disabled={disabled}
          aria-label={ariaLabel}
          role="combobox" aria-autocomplete="list" aria-expanded={shown} aria-controls={listId}
          aria-activedescendant={shown ? optionId(active) : undefined}
          value={value}
          onChange={(e) => { onEdit(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (!shown) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % suggestions.length); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((active - 1 + suggestions.length) % suggestions.length); }
            else if (e.key === 'Enter') { e.preventDefault(); pick(suggestions[active].username); }
            else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
          }}
        />
        {badge}
        {canWrite ? (
          <button type="button" className={`${AdminUI.btn.outlineSm} shrink-0`}
            {...{ [`data-${dataPrefix}-remove`]: index }} aria-label={`Remove ${name}`}
            disabled={disabled} onClick={onRemove}>Remove</button>
        ) : null}
      </div>
      {children}
      {shown ? (
        <ul id={listId} role="listbox" aria-label={`Accounts matching ${q}`}
          className="absolute left-0 right-0 z-10 mt-1 max-h-60 overflow-y-auto rounded-lg bg-white py-1 shadow-lg ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700">
          {suggestions.map((u, i) => (
            <li key={u.id} id={optionId(i)} role="option" aria-selected={i === active}
              className="cursor-pointer px-3 py-1.5 text-sm text-zinc-900 aria-selected:bg-zinc-100 dark:text-zinc-100 dark:aria-selected:bg-zinc-700"
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(u.username); }}>
              @{u.username}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
