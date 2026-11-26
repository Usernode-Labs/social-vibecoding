/**
 * You's tabs and their addresses. Pure: ./profile.js reads the address with
 * it, and the page writes its tabs' links with it (./profile-preferences.tsx).
 */
export const YOU_TABS = ['overview', 'changes', 'requests', 'votes', 'activity', 'friends'] as const;
export type YouTab = typeof YOU_TABS[number];

/** `#profile` for the Overview, `#profile?tab=<name>` for the others. */
export function tabAddress(tab: YouTab): string {
  return tab === 'overview' ? '#profile' : `#profile?tab=${tab}`;
}

/** The tab an address names; the Overview for anything else. */
export function tabFromHash(hash: string): YouTab {
  const m = /^#?profile\/?\?(.*)$/.exec(String(hash || ''));
  if (!m) return 'overview';
  let asked: string | null = null;
  try { asked = new URLSearchParams(m[1]).get('tab'); } catch { return 'overview'; }
  return (YOU_TABS as readonly string[]).includes(asked || '') ? asked as YouTab : 'overview';
}
