import { SectionHeading } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SwitchRow } from '@/components/ui/switch';

import { useMessages } from '../../../lib/i18n/react';

import { InterfaceModeControl } from '../interface-mode-control';

/**
 * Experimental: Advanced mode (./interface-mode-control.tsx), a switch kept
 * on the DEVICE, and under it the Look menu with its own switch.
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
 * New look used to be a switch here too ("Baseplate", request #6278: white
 * cards on a warm grey plate). Its look was redrawn on 13 Nov 2026 as
 * "Paper, simplified, with brand styling" and moved into the Look menu
 * below, so the switch is gone. The look keeps its id, `brand`: a device
 * that had the switch on shows the redrawn look, and the menu shows there
 * (settings.js _renderAdminSection) so it can go back to Standard.
 *
 * Look (kept on the DEVICE by the head's window.Skin, src/head.html)
 * offers the looks (lib/skin.ts MENU_SKINS): each sets its id as data-skin
 * on <html> before first paint and app.css draws it. The first, `brand`,
 * keeps the standard pages and redraws them in the website's colours and
 * typefaces; since 15 Nov 2026 it is the DEFAULT, what a device with
 * nothing stored is drawn in, and Standard is the look Homeroom had before
 * it. The five after it are the looks of the one frame (FRAME_SKINS, the
 * directions the 2026-11-06 screen tour kept). All are drawn in light and
 * dark. Under the menu, one switch (`settings-look-tools`, window.Skin's
 * `tools`) puts the look menu and the light/dark switch beside the bell on
 * every screen (features/frame/look-picker.tsx); off, which is the
 * default, an admin's header is the one everyone has. The menu is an
 * admin's preview while the looks are drawn screen by screen:
 * #settings-look-section ships hidden and settings.js _renderAdminSection
 * lifts the class only for a REAL admin (App._realIsAdmin), as it does for
 * the admin-preview section. A `?skin=<look>` pin in the address still
 * works for anyone who knows it. settings.js paints and saves the menu
 * through window.Skin. The option values are MENU_SKINS, in its order
 * (tests/glass-skin.test.js holds the two together); each name is read by
 * a whole literal id.
 */
export function ExperimentalSection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="experimental" className="hidden">
      <div id="settings-experimental-section">
        <SectionHeading title={t('settings:experimental.title')}>
          {t('settings:experimental.intro')}
        </SectionHeading>
        {/* Two neutral wrappers (looks v2), nothing in the standard look:
            ui-card round the switch, a card under a look, and ui-swrow
            (in InterfaceModeControl) round the switch with its sentences, a
            row of it with the switch at the end (app.css, SETTINGS). */}
        <div className="ui-card">
        <InterfaceModeControl />
        </div>
        <div id="settings-look-section" className="hidden ui-card ui-fields mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
          <Label className="mb-1" htmlFor="settings-look">{t('settings:experimental.look.label')}</Label>
          <Select id="settings-look" variant="plain">
            <option value="">{t('settings:experimental.look.standard')}</option>
            <option value="wip">{t('settings:experimental.look.wip')}</option>
            <option value="wip:brand">{t('settings:experimental.wipTokens.brand')}</option>
            <option value="wip:brand2">{t('settings:experimental.wipTokens.brand2')}</option>
            <option value="wip:highlighter">{t('settings:experimental.wipTokens.highlighter')}</option>
            <option value="brand">{t('settings:experimental.look.brand')}</option>
            <option value="paper">{t('settings:experimental.look.paper')}</option>
          </Select>
          <p className="ui-hint text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
            {t('settings:experimental.look.description')}
          </p>
          <div className="ui-swrow mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
            <SwitchRow id="settings-look-tools">
              {t('settings:experimental.lookTools.label')}
            </SwitchRow>
            <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
              {t('settings:experimental.lookTools.description')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
