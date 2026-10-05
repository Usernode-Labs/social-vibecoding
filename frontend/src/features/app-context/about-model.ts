import { getLanguage } from "../../lib/i18n/runtime";
import { t as tr } from "../../lib/i18n/runtime";
/**
 * What the About pane SAYS — pure, so the wording is pinned by tests with
 * plain objects rather than by a browser.
 *
 * ── The build-by-vote note has to be true for THIS app ──────────────────
 *
 * The design's line is "Anyone can propose; a proposal merges when a majority
 * of active members vote yes and checks pass." That is one of three regimes
 * the platform actually runs, per app, from dapp.json's `governance` block
 * (services/governance.js, apps.approver_policy / apps.approvals_required):
 *
 *   the default    every eligible vote counts, over a dynamic time-and-
 *                  majority gate among the app's active members — a clear
 *                  majority merges fast, thin unopposed support after a
 *                  window, and No votes raise the bar;
 *   'invited'      the same gate, but only the app's invited approvers'
 *                  votes count;
 *   at least N     a fixed number of yes votes (approvers' only, when the
 *                  policy is 'invited') and no clock at all.
 *
 * Two more facts hold whatever the regime: a LOCKED app also needs an admin's
 * yes (services/admin-approval.js), and nothing merges until its checks pass.
 * And "anyone can propose" is only true where anyone can build: an
 * invite-only-build app (collab_visibility 'private') takes proposals from
 * its members.
 *
 * So the sentence is assembled from the row the pane already has — both
 * GET /api/apps and GET /api/apps/:slug carry all four columns — and a row
 * that lacks them reads as the default, which is what an absent column means
 * on the server too. It is deliberately a SUMMARY: the Workshop's "How voting
 * works" popover (../dev-board/voting-help.tsx) is where the clocks are
 * spelled out.
 */

export type AppRow = Record<string, any>;

/** "a, b and c" — the list a sentence can carry. */
export function joinClauses(parts: Array<string | null | undefined | false>): string {
  const list = parts.filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (list.length <= 1) return list[0] || '';
  if (list.length === 2) return tr("apps:value1_and_value2_f4780f76", { value1: list[0], value2: list[1] });
  return tr("apps:value1_and_value2_e09cf1fd", { value1: list.slice(0, -1).join(', '), value2: list[list.length - 1] });
}

function approvalsRequired(row: AppRow | null | undefined): number | null {
  const raw = row ? row.approvals_required : null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * The vote half of "a proposal merges once …", for `who` ("the app’s",
 * "the platform’s").
 */
export function voteClause(row: AppRow | null | undefined, who: string): string {
  const invited = !!row && row.approver_policy === 'invited';
  const n = approvalsRequired(row);
  if (n != null) {
    if (invited) {
      return n === 1
        ? tr("apps:one_of_value1_invited_approvers_votes_yes_24299137", { value1: who })
        : tr("apps:value1_of_value2_invited_approvers_vote_yes_268909fb", { value1: n, value2: who });
    }
    return n === 1 ? tr("apps:it_has_a_yes_vote_9e51da49") : tr("apps:it_has_value1_yes_votes_e0ad056f", { value1: n });
  }
  return invited
    ? tr("apps:value1_invited_approvers_back_it_in_a_vote_6d55ff80", { value1: who })
    : tr("apps:value1_active_members_back_it_in_a_vote_5e4429fe", { value1: who });
}

/** Everything a proposal waits on, in the order it reads. */
export function mergeConditions(row: AppRow | null | undefined, who: string): string {
  return joinClauses([
    voteClause(row, who),
    row && row.locked ? tr("apps:an_admin_votes_yes_f374f906") : null,
    tr("apps:its_checks_pass_85bea711"),
  ]);
}

/** The build-by-vote note under an app's actions. */
export function appNote(row: AppRow | null | undefined): string {
  const proposers = row && row.collab_visibility === 'private'
    ? tr("apps:its_members_can_suggest_a_change_58c89ae4")
    : tr("apps:anyone_can_suggest_a_change_3083fce2");
  return tr("apps:built_by_the_group_one_approved_change_at_a_time_de81fe73")
    + tr("apps:value1_it_goes_live_once_value2_2f85f4b4", { value1: proposers, value2: mergeConditions(row, tr("apps:the_app_s_9d9b617e")) });
}

/**
 * The platform's note. `row` is the self-hosted row when this viewer is
 * served it; `restricted` when they are not, in which case they cannot
 * propose to it either, and the sentence says how it is built without
 * inviting them to do something the platform will refuse.
 */
export function platformNote(row: AppRow | null | undefined, restricted: boolean): string {
  const tail = tr("apps:this_menu_is_the_same_one_every_app_has_df83d740");
  if (restricted) {
    return tr("apps:the_platform_is_built_the_same_way_as_the_apps_o_e7fc2475") + tail;
  }
  const proposers = row && row.collab_visibility === 'private'
    ? tr("apps:its_members_can_suggest_b6212546")
    : tr("apps:anyone_can_suggest_35f21e7f");
  return tr("apps:the_platform_is_built_the_same_way_as_the_apps_o_3ccd0ff9", { value1: proposers })
    + tr("apps:tabs_the_bell_or_the_workshop_and_it_goes_live_o_390748f6", { value1: mergeConditions(row, tr("apps:the_platform_s_958bdcd1")) })
    + tail;
}

/** The app's tagline: its manifest's one-line description (HomePanels.appBlurb's rule). */
export function taglineOf(row: AppRow | null | undefined): string | null {
  const snap = row && row.manifest_snapshot;
  const raw = snap && typeof snap === 'object' ? snap.description : null;
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 160) : null;
}

/** The short SHA of what is running, from either payload shape. */
export function shortVersionOf(row: AppRow | null | undefined): string | null {
  if (!row) return null;
  if (row.version && typeof row.version === 'object' && row.version.shortSha) {
    return String(row.version.shortSha);
  }
  return row.main_sha ? String(row.main_sha).slice(0, 7) : null;
}

/**
 * The pill beside the avatars: "<version> · <updated>".
 *
 * The design writes "v41 · 2h ago". The platform has no version NUMBER — what
 * an app is running is named by its commit, which is what every other
 * version surface here prints — so the pill reads "a1b2c3d · 2h ago". With
 * only one of the two it says that one, and with neither there is no pill:
 * "version —" is worse than silence.
 */
export function versionPillText(version: string | null, updated: string | null): string | null {
  if (version && updated) return `${version} · ${updated}`;
  if (version) return version;
  if (updated) return tr("apps:updated_value1_0041faff", { value1: updated });
  return null;
}

export interface StatCard { key: 'apps' | 'members' | 'merged'; value: string; label: string }

/** About Homeroom's three cards, in the design's order. */
export function statCards(stats: { apps?: number; members?: number; merged?: number } | null): StatCard[] {
  const n = (v: unknown) => {
    const x = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  const s = stats || {};
  const apps = n(s.apps);
  const members = n(s.members);
  const merged = n(s.merged);
  return [
    { key: 'apps', value: apps.toLocaleString(getLanguage()), label: apps === 1 ? tr("apps:app_a172cedc") : tr("apps:apps_d56f6359") },
    { key: 'members', value: members.toLocaleString(getLanguage()), label: members === 1 ? tr("apps:member_e31ab643") : tr("apps:members_17373ca1") },
    { key: 'merged', value: merged.toLocaleString(getLanguage()), get label() { return tr("apps:live_247610f4"); } },
  ];
}

export interface ContributorView { who: string; initial: string; merged: number }

/**
 * One contributor row, from GET /api/apps/:slug/contributors' shape — the
 * payload Discover's app page reads (../apps/browse.js contributorRowView).
 */
export function contributorView(c: AppRow | null | undefined): ContributorView {
  const who = (c && typeof c.username === 'string' && c.username) || 'unknown';
  const merged = parseInt(String(c ? c.merged_count : 0), 10) || 0;
  return { who, initial: (who[0] || '?').toUpperCase(), merged };
}

/**
 * The Open button's words, the way Discover's app page words them
 * (../apps/browse.js _renderDetail): Resume for the app you left, Open for
 * one that can open, and the reason for one that cannot.
 */
export function openLabel(status: string | null | undefined, parked: boolean): { label: string; canOpen: boolean } {
  const canOpen = status === 'running' || status === 'awaiting_secrets';
  if (canOpen) return { label: parked ? tr("apps:resume_d640c742") : tr("apps:open_ed077f3d"), canOpen };
  if (status === 'creating') return { get label() { return tr("apps:spinning_up_7a0d6a5c"); }, canOpen };
  if (status === 'error') return { get label() { return tr("apps:not_running_9e3856ee"); }, canOpen };
  return { label: status || tr("apps:unavailable_ca184496"), canOpen };
}
