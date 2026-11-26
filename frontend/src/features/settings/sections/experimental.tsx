import { SectionHeading } from '@/components/ui/field';

import { useMessages } from '../../../lib/i18n/react';

import { InterfaceModeControl } from '../interface-mode-control';

/**
 * Experimental: Advanced mode (./interface-mode-control.tsx), a switch kept
 * on the DEVICE.
 *
 * #3624 Homeroom bot used to have a switch here too, while it was tried out
 * one person at a time. It works for everyone now, so the switch is gone.
 *
 * #4289 Comment on the page used to be a switch here too ("Press C to
 * comment on the page" until 13 Oct 2026, a name with no meaning on a
 * phone). Comment mode is no longer experimental: Suggest an improvement
 * opens it for everyone, with its form one switch away, so the switch is
 * gone. The setting itself stays on the DEVICE
 * (../../improve/suggest-settings.ts, localStorage), off only where a device
 * stored that.
 *
 * New Needs you used to be a switch here too. The review flow is what every
 * Needs you draws now, so there is nothing to turn on.
 *
 * New look used to be a switch here too ("Baseplate", request #6278), and
 * a Look menu after it offered the looks to admins (Standard, then "Paper,
 * simplified, with brand styling"). There is one look now, so both are
 * gone.
 */
export function ExperimentalSection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="experimental" className="hidden">
      <div id="settings-experimental-section">
        <SectionHeading title={t('settings:experimental.title')}>
          {t('settings:experimental.intro')}
        </SectionHeading>
        {/* Two neutral wrappers: ui-card round the switch, and ui-swrow (in
            InterfaceModeControl) round the switch with its sentences. */}
        <div className="ui-card">
        <InterfaceModeControl />
        </div>
      </div>
    </div>
  );
}
