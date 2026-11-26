'use strict';

// The Admin console's words in the platform header (#7181): on a computer
// the header says where you are and what that means, in the seat the page's
// title has everywhere else, so the console's own band under it is not
// drawn there. A phone keeps the title and the band.
//
// STATIC MARKUP, ALWAYS RENDERED. app.css shows it only while the console
// is on screen for an admin (it reads #admin-console-bar's own `hidden`,
// which AdminConsole._renderShell keeps), so it is no part of hydration:
// the prerender and the first client render are the same nodes. The text
// is the band's own (./index.tsx), and like the rest of the console it is
// English in code.

// The band's Exit, here too: back to where the console was entered from,
// else the Profile tab its address already names.
function onExit(e: { preventDefault(): void }) {
  const target = (window as any).AdminConsole?.exitTarget?.();
  if (!target || target === '#profile') return;
  e.preventDefault();
  location.hash = target;
}

export function AdminHeaderNote() {
  return (
    <div className="admin-header-note" role="note">
      <span className="admin-header-note-mark" aria-hidden="true"></span>
      <p>
        <strong>Admin console</strong>
        <span>{"Platform-wide tools. These are not your settings but the settings of the platform. Be careful before changing anything."}</span>
      </p>
      <a href="#profile" onClick={onExit} className="admin-header-exit">Exit</a>
    </div>
  );
}
