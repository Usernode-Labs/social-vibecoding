import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';

import {
  ClockIcon, CupIcon, FaceSmileIcon, HandRaisedIcon, HashIcon, HeartIcon, LightBulbIcon, SearchIcon,
  SunIcon, TrophyOutlineIcon, type IconProps,
} from '@/components/ui/icons';

import { ALL_EMOJI, EMOJI_CATEGORIES, emojiName, searchEmoji, type EmojiEntry } from './emoji-data';
import { useRecentReactions } from './recents';

/**
 * The full reaction picker (#2387): search, a tab per category, the viewer's
 * recent reactions first, and every emoji the app chat's grid offers.
 *
 * One scroller, every category a section of it, and the tabs jump within it
 * rather than swapping pages: that is how Slack's and Discord's pickers read,
 * and it keeps a slow scroll through "all of them" possible. Typing replaces
 * the sections with the matches.
 *
 * It does not position itself. A row places it above or below its bar
 * (`placement`), the phone sheet draws it full width — the picker is the
 * same panel in both.
 */

const TAB_ICONS: Record<string, ComponentType<IconProps>> = {
  recent: ClockIcon,
  smileys: FaceSmileIcon,
  people: HandRaisedIcon,
  hearts: HeartIcon,
  nature: SunIcon,
  food: CupIcon,
  activities: TrophyOutlineIcon,
  objects: LightBulbIcon,
  symbols: HashIcon,
};

const RECENT_SHOWN = 8;

function EmojiButton({ entry, onPick, onPreview }: {
  entry: EmojiEntry;
  onPick: (emoji: string) => void;
  onPreview: (entry: EmojiEntry | null) => void;
}) {
  return (
    <button
      type="button"
      className="msgx-picker-emoji"
      aria-label={entry.name}
      title={entry.name}
      onClick={() => onPick(entry.emoji)}
      onMouseEnter={() => onPreview(entry)}
      onFocus={() => onPreview(entry)}
    >
      {entry.emoji}
    </button>
  );
}

export function EmojiPicker({ onPick, onClose, placement = 'below', className = '', autoFocus = true }: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  placement?: 'above' | 'below' | 'inline';
  className?: string;
  /** Put the caret in the search field on open — a pointer's picker, not a phone's. */
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<EmojiEntry | null>(null);
  const [tab, setTab] = useState('recent');
  const recents = useRecentReactions();
  const scroller = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const recentEntries = useMemo(() => recents.slice(0, RECENT_SHOWN).map((emoji) => (
    ALL_EMOJI.find((entry) => entry.emoji === emoji) || { emoji, name: emojiName(emoji), terms: emoji }
  )), [recents]);
  const hits = useMemo(() => searchEmoji(query), [query]);
  const searching = query.trim().length > 0;

  useEffect(() => {
    if (autoFocus) search.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  function jump(id: string) {
    setTab(id);
    setQuery('');
    const root = scroller.current;
    const target = root?.querySelector<HTMLElement>(`[data-emoji-section="${id}"]`);
    if (root && target) root.scrollTop = target.offsetTop - root.offsetTop;
  }

  // The tab under the top of the scroller follows a manual scroll, so the
  // strip always says where in the list you are.
  function onScroll() {
    const root = scroller.current;
    if (!root || searching) return;
    let current = 'recent';
    for (const section of root.querySelectorAll<HTMLElement>('[data-emoji-section]')) {
      if (section.offsetTop - root.offsetTop <= root.scrollTop + 8) current = section.dataset.emojiSection || current;
    }
    if (current !== tab) setTab(current);
  }

  const sections = [{ id: 'recent', label: 'Recently used', emoji: recentEntries }, ...EMOJI_CATEGORIES];

  return (
    <div
      className={`msgx-picker msgx-picker-${placement} ${className}`}
      role="dialog"
      aria-label="Add a reaction"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      }}
    >
      <label className="msgx-picker-search">
        <SearchIcon className="w-4 h-4" aria-hidden="true" />
        <input
          ref={search}
          type="search"
          value={query}
          placeholder="Search emoji"
          aria-label="Search emoji"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && hits[0]) { event.preventDefault(); onPick(hits[0].emoji); }
          }}
        />
      </label>
      <div className="msgx-picker-tabs" role="tablist" aria-label="Emoji categories">
        {sections.map((section) => {
          const Icon = TAB_ICONS[section.id] || FaceSmileIcon;
          const selected = !searching && tab === section.id;
          return (
            <button
              key={section.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={section.label}
              title={section.label}
              className={`msgx-picker-tab ${selected ? 'msgx-picker-tab-active' : ''}`}
              onClick={() => jump(section.id)}
            >
              <Icon className="w-4 h-4" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <div ref={scroller} className="msgx-picker-scroll" onScroll={onScroll}>
        {searching ? (
          hits.length ? (
            <div className="msgx-picker-grid" role="group" aria-label="Matching emoji">
              {hits.map((entry) => <EmojiButton key={entry.emoji} entry={entry} onPick={onPick} onPreview={setPreview} />)}
            </div>
          ) : <p className="msgx-picker-empty">No emoji match “{query.trim()}”.</p>
        ) : sections.map((section) => (
          <section key={section.id} data-emoji-section={section.id} aria-label={section.label}>
            <h4 className="msgx-picker-head">{section.label}</h4>
            <div className="msgx-picker-grid">
              {section.emoji.map((entry) => <EmojiButton key={`${section.id}-${entry.emoji}`} entry={entry} onPick={onPick} onPreview={setPreview} />)}
            </div>
          </section>
        ))}
      </div>
      <div className="msgx-picker-foot" aria-hidden="true">
        {preview ? <><span className="msgx-picker-foot-emoji">{preview.emoji}</span><span>{preview.name}</span></> : <span>Pick a reaction</span>}
      </div>
    </div>
  );
}
