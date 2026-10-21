'use strict';

// A stand-in for the bug #4648 fixed, for tests/clock-sweep.test.js: a
// browser-style module (loaded into a vm context, as the challenge pane is)
// that shows a card's time left as the sooner of the card's own end and
// the end of the week, Monday 00:00 UTC.
window.WeekClock = {
  weekEnd(now) {
    const d = new Date(now);
    const days = (8 - d.getUTCDay()) % 7 || 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days);
  },
  daysLeft(cardEnd) {
    const now = Date.now();
    return Math.ceil((Math.min(cardEnd, this.weekEnd(now)) - now) / 86400000);
  },
};
