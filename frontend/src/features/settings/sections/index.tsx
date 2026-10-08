/**
 * Every [data-settings-section] part of the #settings screen, in registry
 * order (#1081 chunk D; the settings restructure).
 *
 * One wrapper per entry in Settings.SECTIONS, and the ORDER HERE IS THE
 * ORDER ON SCREEN: a page shows all of its parts at once, so the parts of a
 * page have to sit next to each other, in the order SECTIONS lists them.
 * tests/settings-screen.test.js parses SECTIONS out of settings.js and
 * asserts a wrapper per key, both ways, and that the two orders agree.
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
 *    never reconciled again. ThemeSection and ProfileSection are the
 *    exceptions, and they earn it the same way: settings.js binds nothing
 *    inside them, so React is the only writer there. See ./theme.tsx and
 *    ./profile.tsx.
 *  - each wrapper ships `hidden`, exactly as the hand-written shell did, and
 *    the router unhides the wrappers of exactly one page. That is the
 *    SECTION-ROUTING hidden.
 *  - #wallet-section, #settings-usernode-section and #settings-admin-section
 *    carry a SECOND, inner `hidden`. That one is
 *    a CAPABILITY GATE, owned by settings.js and read back by
 *    Settings._visibleSections() to decide menu membership. The two concepts
 *    are deliberately separate — collapsing them would make an ungated
 *    section unreachable the moment its wrapper hid.
 */

import { useIsomorphicLayoutEffect } from '../../../lib/legacy-dom';

import { AboutSection } from './about';
import { AdminPreviewSection } from './admin-preview';
import { AgentFilesSection } from './agent-files';
import { AlertsSection } from './alerts';
import { BlockedAppsSection } from './blocked-apps';
import { ApiKeySection } from './api-key';
import { AppAiSection } from './app-ai';
import { AppPermissionsSection } from './app-permissions';
import { CliSection } from './cli';
import { ConnectorsSection, LinkedAccountsSection } from './connectors';
import { DevConsoleSection } from './dev-console';
import { ExperimentalSection } from './experimental';
import { GlobalChatSettingsSection } from './global-chat';
import { LanguageSection } from './language';
import { OpenRouterSection } from './openrouter';
import { PasswordSection } from './password';
import { ProfileSection } from './profile';
import { DeleteAccountSection } from './delete-account';
import { ThemeSection } from './theme';
import { TourSection } from './tour';
import { UsageSection } from './usage';
import { UsernameSection } from './username';
import { EmailSection } from './email';
import { UsernodeSection } from './usernode';
import { WalletSection } from './wallet';

export function SettingsSections() {
  // init() binds every control below by id, ONCE, so it has to run when the
  // panes exist and never again. This component mounts exactly once (the
  // chassis gates it on a one-way flag), and a LAYOUT effect runs inside the
  // same flush that committed the panes — before a Settings.open() that
  // forced them in reads a single id. window.Settings is the module by now:
  // the chunk that carries these panes evaluates ./settings.js first.
  useIsomorphicLayoutEffect(() => {
    window.Settings?.init?.();
  }, []);

  return (
    <>
      {/* ── Account ── Profile leads, and Delete account closes the page,
          apart from everything harmless above it. */}
      <ProfileSection />
      <UsernameSection />
      <EmailSection />
      <PasswordSection />
      <DeleteAccountSection />
      <LinkedAccountsSection />
      <WalletSection />
      {/* ── AI & building ── */}
      <UsageSection />
      <OpenRouterSection />
      <ApiKeySection />
      <ConnectorsSection />
      <CliSection />
      <AgentFilesSection />
      <GlobalChatSettingsSection />
      <ExperimentalSection />
      {/* ── Preferences ── THE UI OVERHAUL moved Theme out of the hamburger
          drawer; see ./theme.tsx for why it is a stateful pane. The console
          switch and the admins-only preview share its Appearance page. */}
      <ThemeSection />
      <DevConsoleSection />
      <AdminPreviewSection />
      <LanguageSection />
      <AlertsSection />
      <AppPermissionsSection />
      <AppAiSection />
      <BlockedAppsSection />
      {/* ── Help & about ── The way back to Home's welcome tour, then the
          native app's diagnostics and the version rows: panes you read or
          replay rather than configure. See ./tour.tsx and ./about.tsx. */}
      <TourSection />
      <UsernodeSection />
      <AboutSection />
    </>
  );
}
