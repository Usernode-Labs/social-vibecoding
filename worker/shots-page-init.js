// Runs in every page the shots browsers open, before the page's own scripts
// (Playwright MCP --init-script; write-shots-mcp-config.js passes it).
//
// #4087: the phone-size shots opened under the "Add Homeroom to your home
// screen" strip, so the top of every first screen was the banner rather than
// the screen being judged. This records the same dismissal a person's tap on
// the strip's × records (install-banner.tsx, DISMISS_KEY), so the shots show
// what a member sees once they have closed it. Only the shots browsers run
// it: declared checks and real visitors still get the banner as before.
//
// Top-level pages only: a hosted app runs in a frame of the shell, and the
// frame is the app being photographed, so its storage is left as it is.
try {
  if (window.top === window) sessionStorage.setItem('mobileInstallBannerDismissed', '1');
} catch {
  /* An opaque origin (about:blank) has no storage; there is no banner there. */
}
