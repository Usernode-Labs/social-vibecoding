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
// And every page opens as a first visit to a project's Workshop. Its "Since
// your last visit" counts from a stamp each page load writes for the next
// (AppView._workshopBaseline, `workshopSeen:<slug>`), and the shots agent
// loads the two addresses a different number of times (it finds the state on
// the after one first), so the sides counted from different moments: 154
// rows on one side of #4460's shots and 5 on the other. Dropping the stamp
// before the page reads it gives both sides the first visit the declared
// checks' fresh browsers see; `?shot=since-visit` still draws the list.
//
// Top-level pages only: a hosted app runs in a frame of the shell, and the
// frame is the app being photographed, so its storage is left as it is.
try {
  if (window.top === window) sessionStorage.setItem('mobileInstallBannerDismissed', '1');
} catch {
  /* An opaque origin (about:blank) has no storage; there is no banner there. */
}
try {
  if (window.top === window) {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (typeof key === 'string' && key.startsWith('workshopSeen:')) localStorage.removeItem(key);
    }
  }
} catch {
  /* No storage, so no stamp to drop. */
}
