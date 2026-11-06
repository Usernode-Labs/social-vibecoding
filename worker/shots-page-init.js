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
// A change to the strip itself must still be shootable (4420, 4321): a page
// opened with `?shots-install-strip=show` has the dismissal taken away
// instead, so the phone browser, whose user agent the strip shows for, shows
// it. The brief's installStrip tells the shots agent (shots-orchestrator.js).
// The dismissal lasts the tab's session, so the flag holds for the page it
// was opened with and every in-app step after it; a later page load without
// it dismisses the strip again.
//
// Top-level pages only: a hosted app runs in a frame of the shell, and the
// frame is the app being photographed, so its storage is left as it is.
try {
  if (window.top === window) {
    if (/[?&]shots-install-strip=show(?:&|$)/.test(window.location?.search || '')) {
      sessionStorage.removeItem('mobileInstallBannerDismissed');
    } else {
      sessionStorage.setItem('mobileInstallBannerDismissed', '1');
    }
  }
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
// #6379: the picture was sometimes taken while the page was still loading,
// so a request's or change's conversation was missing from it. The patched
// browser_take_screenshot (patch-playwright-mcp-screenshot.js) waits until
// the page's own requests are done and its markup has stopped changing;
// this counts them. Top-level pages only: a frame's requests are not the
// page's own. Without fetch or XMLHttpRequest the counter stays absent, and
// the wait reads it as zero.
try {
  if (window.top === window) {
    if (window.__usernodeShotsInFlight == null) window.__usernodeShotsInFlight = 0;
    const started = () => { window.__usernodeShotsInFlight += 1; };
    const finished = () => { window.__usernodeShotsInFlight = Math.max(0, window.__usernodeShotsInFlight - 1); };
    if (typeof window.fetch === 'function') {
      const originalFetch = window.fetch;
      window.fetch = function fetch(...args) {
        started();
        let answered;
        try {
          answered = originalFetch.apply(this, args);
        } catch (error) {
          finished();
          throw error;
        }
        return Promise.resolve(answered).finally(finished);
      };
    }
    if (typeof window.XMLHttpRequest === 'function' && window.XMLHttpRequest.prototype
        && typeof window.XMLHttpRequest.prototype.send === 'function') {
      const proto = window.XMLHttpRequest.prototype;
      const originalSend = proto.send;
      proto.send = function send(...args) {
        started();
        // loadend fires once whether it loaded, failed or was aborted.
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          finished();
        };
        if (typeof this.addEventListener === 'function') this.addEventListener('loadend', done);
        try {
          return originalSend.apply(this, args);
        } catch (error) {
          done();
          throw error;
        }
      };
    }
  }
} catch {
  /* A page whose fetch cannot be wrapped is photographed as it is. */
}
