/**
 * Every [data-settings-section] pane of the #settings screen, in the order the
 * shell has always emitted them (#1081 chunk D).
 *
 * There are SIXTEEN of them, one per entry in Settings.SECTIONS. THE UI
 * OVERHAUL added Theme (lifted out of the hamburger drawer) and retired
 * "Home screen widgets" (there is nothing left to configure now that the
 * three widgets are fixed sections), which was a net zero at fifteen; 
 * added Username, which is the sixteenth. (#1081 said sixteen when there were
 * fifteen — the registry, the shell and tests/settings-screen.test.js, which
 * parses SECTIONS out of settings.js and asserts a wrapper per key, were the
 * authority then and still are.)
 *
 * This file is the MARKUP half of the settings screen. Behaviour stays in
 * ./settings.js — the module binds every control below by id, ONCE, and the
 * chassis in ../index.tsx only ever toggles `hidden` on the wrappers. That
 * split is load-bearing:
 *
 *  - a pane must never be innerHTML-rebuilt, or the id-bound listeners on the
 *    controls inside it silently stop firing. React re-rendering one of these
 *    subtrees would be the same failure, so every component here is STATIC:
 *    no state, no props, no effects. They render once, at hydration, and are
 *    never reconciled again. ThemeSection is the ONE exception, and it earns
 *    it the same way the drawer's copy did: settings.js binds nothing inside
 *    its track, so React is the only writer there. See ./theme.tsx.
 *  - each wrapper ships `hidden`, exactly as the hand-written shell did, and
 *    the router unhides exactly one. That is the SECTION-ROUTING hidden.
 *  - #wallet-section, #settings-usernode-section and #settings-admin-section
 *    carry a SECOND, inner `hidden`. That one is a CAPABILITY GATE, owned by
 *    settings.js and read back by Settings._visibleSections() to decide menu
 *    membership. The two concepts are deliberately separate — collapsing them
 *    would make an ungated section unreachable the moment its wrapper hid.
 */

import { AdminPreviewSection } from './admin-preview';
import { AgentFilesSection } from './agent-files';
import { AlertsSection } from './alerts';
import { ApiKeySection } from './api-key';
import { AppAiSection } from './app-ai';
import { CliSection } from './cli';
import { ConnectorsSection } from './connectors';
import { DevConsoleSection } from './dev-console';
import { ExperimentalSection } from './experimental';
import { LanguageSection } from './language';
import { OpenRouterSection } from './openrouter';
import { PasswordSection } from './password';
import { ThemeSection } from './theme';
import { UsernameSection } from './username';
import { UsernodeSection } from './usernode';
import { WalletSection } from './wallet';

export function SettingsSections() {
  return (
    <>
      {/* THE UI OVERHAUL moved Theme out of the hamburger drawer and made it
          the FIRST setting — and the default section, so a bare #settings
          lands on it. See ./theme.tsx for why it is the one stateful pane. */}
      <ThemeSection />
      <ApiKeySection />
      <ConnectorsSection />
      <OpenRouterSection />
      <AppAiSection />
      <AgentFilesSection />
      <UsernameSection />
      <PasswordSection />
      <WalletSection />
      <LanguageSection />
      <AlertsSection />
      {/* HomePanelsSection sat here — the per-widget show/hide list for the
          home screen. THE UI OVERHAUL made those three fixed sections, so
          there is nothing to configure. */}
      <CliSection />
      <DevConsoleSection />
      <ExperimentalSection />
      <UsernodeSection />
      <AdminPreviewSection />
    </>
  );
}
