import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { RichMessage } from "../../lib/i18n/react";
import { Message } from "../../lib/i18n/react";
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
  /**
   * The two quick filters, present only while the DIALOG owns them — the
   * filter strip measures its own row and hands them over when they will not
   * fit on its one line (features/dev-board/kanban-filters.tsx, and
   * `_quickFiltersInDialog` in public/js/app-view.js). The strip's toggles and
   * these switches are never both on screen: two controls for one filter,
   * either of which could be the stale one by the time Done is pressed.
   */
  assignedToMe: boolean;
  createdByMe: boolean;
}

export interface BoardFiltersPayload {
  filters: BoardFilterValues;
  /** Category vocabulary — built-ins then customs, in dropdown order. */
  categories: Array<{ value: string; label: string }>;
  /** Top-voted assignees across the cached board data, sorted. */
  assignees: string[];
  /** AppView.KANBAN_ASSIGNEE_UNASSIGNED — the fixed "Unassigned" sentinel. */
  unassigned: string;
  /**
   * Draw the two quick switches? True only when the strip has handed them
   * over AND there is a "you" to filter by. `applyKanbanFilters` applies the
   * same test on the way back, so a Done pressed while the strip owns them
   * cannot write its snapshot over a toggle the reader has since flipped.
   */
  quick: boolean;
}

const FIELD_LABEL_CLS =
  'block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1';

export function BoardFiltersDialog() {
  useUiLanguage();
  const [priority, setPriority] = useState('');
  const [category, setCategory] = useState('');
  const [assignee, setAssignee] = useState('');
  const [needsVote, setNeedsVote] = useState(false);
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [createdByMe, setCreatedByMe] = useState(false);
  const [quick, setQuick] = useState(false);
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
      setAssignedToMe(!!payload.filters.assignedToMe);
      setCreatedByMe(!!payload.filters.createdByMe);
      setQuick(!!payload.quick);
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
      assignedToMe,
      createdByMe,
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
        <h2 className="text-lg font-bold mb-1"><Message id="core:filters_546ebb8e" /></h2>
        <p className="text-xs text-zinc-500 mb-4"><Message id="core:all_conditions_apply_together_f06b2cce" /></p>
        <div className="space-y-4">
          <div>
            <label htmlFor="board-filters-priority" className={FIELD_LABEL_CLS}><Message id="core:priority_d60dbba0" /></label>
            <Select
              id="board-filters-priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            >
              <option value=""><Message id="core:any_priority_b335572e" /></option>
              <option value="high"><Message id="core:high_c4ebc6d4" /></option>
              <option value="medium"><Message id="core:medium_8e588cd1" /></option>
              <option value="low"><Message id="core:low_f793de20" /></option>
            </Select>
          </div>
          <div>
            <label htmlFor="board-filters-category" className={FIELD_LABEL_CLS}><Message id="core:category_292c06f0" /></label>
            <Select
              id="board-filters-category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value=""><Message id="core:any_category_b64819fe" /></option>
              {categories.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="board-filters-assignee" className={FIELD_LABEL_CLS}><Message id="core:assignee_5e20d20e" /></label>
            <Select
              id="board-filters-assignee"
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
            >
              <option value=""><Message id="core:anyone_8d486bb2" /></option>
              <option value={unassigned}><Message id="core:nobody_yet_aca29464" /></option>
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
            <span className="min-w-0"><RichMessage id="core:sentence_0b6e90ca9758" components={[<span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200" />, <span className="block text-xs text-zinc-500" />]} /></span>
            <Switch
              id="board-filters-needsvote"
              checked={needsVote}
              onChange={(event) => setNeedsVote(event.target.checked)}
            />
          </label>
          {/* THE TWO QUICK FILTERS, when the strip could not keep them. They
              are switches here rather than the strip's chips because that is
              what this dialog's other boolean is, and a row of one kind of
              control reads as one list of conditions — which is what the
              subtitle at the top promises. Rendered only when the payload
              says so, so the strip and the dialog never both offer them. */}
          {quick ? (
            <>
              <label
                htmlFor="board-filters-assignedtome"
                className="flex items-center justify-between gap-3 cursor-pointer select-none"
              >
                <span className="min-w-0"><RichMessage id="core:sentence_7aa6aa2e2ebb" components={[<span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200" />, <span className="block text-xs text-zinc-500" />]} /></span>
                <Switch
                  id="board-filters-assignedtome"
                  checked={assignedToMe}
                  onChange={(event) => setAssignedToMe(event.target.checked)}
                />
              </label>
              <label
                htmlFor="board-filters-createdbyme"
                className="flex items-center justify-between gap-3 cursor-pointer select-none"
              >
                <span className="min-w-0"><RichMessage id="core:sentence_b7828f3cd6d4" components={[<span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200" />, <span className="block text-xs text-zinc-500" />]} /></span>
                <Switch
                  id="board-filters-createdbyme"
                  checked={createdByMe}
                  onChange={(event) => setCreatedByMe(event.target.checked)}
                />
              </label>
            </>
          ) : null}
          <div className="flex justify-end">
            <Button
              type="button"
              id="board-filters-done"
              onClick={done}
            ><Message id="core:done_11a6767d" /></Button>
          </div>
        </div>
      </DialogCard>
    </DialogRoot>
  );
}
