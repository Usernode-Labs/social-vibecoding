import { SectionHeading, StatusLine } from '@/components/ui/field';
import { SwitchRow } from '@/components/ui/switch';

/**
 * #138: Dev-chat sound & alerts (default ON). Client-only preference
 * (localStorage key devchat_alerts_enabled); wired in settings.js. Plays a
 * chime when an AI dev-chat turn finishes while you're in the app, or a system
 * notification when it's in the background.
 *
 * Below it, the mobile push categories. Those rows are NOT SwitchRows: their
 * shape is the other way round (caption block first, switch right-aligned and
 * top-aligned) and their checkbox writes `type`/`class`/`disabled` in that
 * order, which the primitive's prop order does not produce. They stay literal
 * — the same call alert.tsx makes for the banner with a display conflict.
 */
const MOBILE_PUSH_CATEGORIES = [
  {
    key: 'direct_interactions',
    title: 'Direct interactions',
    blurb: 'Mentions and replies to your messages.',
  },
  {
    key: 'invitations',
    title: 'Invitations',
    blurb: 'Collaboration and approver invitations, including when yours are accepted.',
  },
  {
    key: 'shared_work',
    title: 'Shared work',
    blurb: 'Specs that someone privately shares with you.',
  },
  {
    key: 'developer_sessions',
    title: 'Developer sessions',
    blurb: 'Interactive and unattended coding sessions that finish while you are away.',
  },
  {
    key: 'proposal_alerts',
    title: 'Proposal alerts',
    blurb: 'Proposals needing attention, failed previews, and new proposals ready for voting.',
  },
  {
    key: 'lightweight_activity',
    title: 'Lightweight activity',
    blurb: 'Reactions and kudos on your work.',
  },
];

export function AlertsSection() {
  return (
    <div data-settings-section="alerts" className="hidden">
      <div id="settings-alerts-section">
        <SectionHeading title={<>Dev-chat sound &amp; alerts</>}>
          Get a heads-up when a dev-chat AI agent finishes and is waiting for your reply.
        </SectionHeading>
        <SwitchRow id="devchat-alerts-toggle">
          Play a sound, and notify me when the app is in the background
        </SwitchRow>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
          When you're in the app a soft chime plays; when the app is backgrounded or closed you get a system notification instead. Your browser or device may ask permission to show notifications the first time.
        </p>
        <button
          id="devchat-alerts-test"
          type="button"
          className="mt-3 rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        >
          Send a test alert
        </button>
        <StatusLine
          as="p"
          id="devchat-alerts-test-status"
          size="xs"
          className="text-zinc-500 dark:text-zinc-400"
        />

        <div
          id="settings-mobile-push-preferences"
          className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800"
        >
          <SectionHeading title="Mobile push categories" blurbClassName="leading-relaxed">
            Choose which Social activity can send a phone notification. Your phone&apos;s Activity notifications switch remains the master control for that device.
          </SectionHeading>
          <div className="space-y-3">
            {MOBILE_PUSH_CATEGORIES.map((category) => (
              <label key={category.key} className="flex items-start justify-between gap-4 cursor-pointer select-none" data-mobile-push-category={category.key}>
                <span>
                  <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{category.title}</span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{category.blurb}</span>
                </span>
                <input type="checkbox" className="un-switch mt-0.5 shrink-0" disabled />
              </label>
            ))}
          </div>
          <p data-mobile-push-status aria-live="polite" className="text-xs mt-3 text-zinc-500 dark:text-zinc-400">
            Loading mobile push preferences…
          </p>
        </div>
      </div>
    </div>
  );
}
