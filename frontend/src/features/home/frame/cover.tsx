/**
 * What a community's picture card says on its cover in Communities to join,
 * on Home signed in (./home-frame.tsx) and signed out
 * (../../guest/frame/landing-frame.tsx): "New" for its first 30 days, and
 * how many people used it lately. Every card says the second (#6658): a
 * number from one person, and "No one active yet" for none, so a card with
 * nothing in its corner is never mistaken for one that hides its number.
 * A screen reader hears the same with the community's name.
 */
import { Icon } from '@/components/ui/kit';
import { type GuestApp, isNew } from '../../guest/guest-data';

type Say = (id: string, values?: Record<string, string | number>) => string;

export function coverPills(app: GuestApp, ta: Say): { flag?: React.ReactNode; badge: React.ReactNode; label: string } {
  const n = app.active_users || 0;
  const name = app.name || app.slug;
  return {
    flag: isNew(app) ? ta('auth:guest.card.new') : undefined,
    badge: n >= 1 ? <><Icon name="users" size={14} />{n.toLocaleString()}</> : ta('auth:guest.card.noOneYet'),
    label: n >= 1 ? ta('auth:guest.card.peopleLabel', { name, count: n }) : ta('auth:guest.card.noOneLabel', { name }),
  };
}
