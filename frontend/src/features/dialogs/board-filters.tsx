/**
 * Board Filters dialog (#board-filters-modal) — Streamlined Concept.
 *
 * The Figma board moves the Board's priority / category / assignee selects
 * and the "Waiting on you" toggle off the filter bar and into a dialog, so
 * the bar itself is just search + a `Filters (n)` chip + the active-filter
 * chips. This is that dialog.
 *
 * Unlike the nine converted shell dialogs this one is NEW markup — there is
 * no legacy byte-identical baseline to match — but it signs the same
 * `useDialog` contract: the card ships in the prerendered document, the kit
 * lifts it at open, and `window.UsernodeReact.dialogs.boardFilters` is how
 * the one caller (`AppView._openKanbanFiltersDialog` in public/js/app-view.js)
 * drives it.
 *
 * State model: the dialog is a STAGING AREA. It opens with a snapshot of
 * `AppView._kanbanFilters` plus the option vocabularies (both live in
 * app-view.js — a classic script, so they arrive as the open() payload
 * rather than an import), edits locally, and only Done writes back, through
 * `AppView.applyKanbanFilters()`. A backdrop dismiss discards the edits.
 * Search (`q`) deliberately stays out: it lives in the bar's field.
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

import { useDialog } from './use-dialog';

export interface BoardFilterValues {
  priority: string | null;
  category: string | null;
  assignee: string | null;
  needsVote: boolean;
}

export interface BoardFiltersPayload {
  filters: BoardFilterValues;
  /** Category vocabulary — built-ins then customs, in dropdown order. */
  categories: Array<{ value: string; label: string }>;
  /** Top-voted assignees across the cached board data, sorted. */
  assignees: string[];
  /** AppView.KANBAN_ASSIGNEE_UNASSIGNED — the fixed "Unassigned" sentinel. */
  unassigned: string;
}

const FIELD_LABEL_CLS =
  'block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1';

export function BoardFiltersDialog() {
  const [priority, setPriority] = useState('');
  const [category, setCategory] = useState('');
  const [assignee, setAssignee] = useState('');
  const [needsVote, setNeedsVote] = useState(false);
  const [categories, setCategories] = useState<Array<{ value: string; label: string }>>([]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [unassigned, setUnassigned] = useState(' __unassigned__');

  const dialog = useDialog<BoardFiltersPayload>('boardFilters', {
    onOpen: (payload) => {
      if (!payload) return;
      setPriority(payload.filters.priority || '');
      setCategory(payload.filters.category || '');
      setAssignee(payload.filters.assignee || '');
      setNeedsVote(!!payload.filters.needsVote);
      setCategories(payload.categories || []);
      setAssignees(payload.assignees || []);
      setUnassigned(payload.unassigned || ' __unassigned__');
    },
  });

  function done() {
    const appView = window.AppView as
      | { applyKanbanFilters?: (next: Partial<BoardFilterValues>) => void }
      | undefined;
    appView?.applyKanbanFilters?.({
      priority: priority || null,
      category: category || null,
      assignee: assignee || null,
      needsVote,
    });
    dialog.close();
  }

  return (
    <DialogRoot
      id="board-filters-modal"
      ref={dialog.rootRef}
      {...dialog.backdropProps}
    >
      <DialogCard size="sm">
        <h2 className="text-lg font-bold mb-1">
          Filters
        </h2>
        <p className="text-xs text-zinc-500 mb-4">
          All conditions apply together.
        </p>
        <div className="space-y-4">
          <div>
            <label htmlFor="board-filters-priority" className={FIELD_LABEL_CLS}>
              Priority
            </label>
            <Select
              id="board-filters-priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            >
              <option value="">
                Any priority
              </option>
              <option value="high">
                High
              </option>
              <option value="medium">
                Medium
              </option>
              <option value="low">
                Low
              </option>
            </Select>
          </div>
          <div>
            <label htmlFor="board-filters-category" className={FIELD_LABEL_CLS}>
              Category
            </label>
            <Select
              id="board-filters-category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="">
                Any category
              </option>
              {categories.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="board-filters-assignee" className={FIELD_LABEL_CLS}>
              Assignee
            </label>
            <Select
              id="board-filters-assignee"
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
            >
              <option value="">
                Anyone
              </option>
              <option value={unassigned}>
                Unassigned
              </option>
              {assignees.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
          <label
            htmlFor="board-filters-needsvote"
            className="flex items-center justify-between gap-3 cursor-pointer select-none"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                Waiting on you
              </span>
              <span className="block text-xs text-zinc-500">
                Only proposals you haven’t weighed in on yet
              </span>
            </span>
            <Switch
              id="board-filters-needsvote"
              checked={needsVote}
              onChange={(event) => setNeedsVote(event.target.checked)}
            />
          </label>
          <div className="flex justify-end">
            <Button
              type="button"
              id="board-filters-done"
              onClick={done}
            >
              Done
            </Button>
          </div>
        </div>
      </DialogCard>
    </DialogRoot>
  );
}
