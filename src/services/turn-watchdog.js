'use strict';

// Append `line` to a progress-lines array unless it's already the last
// line (journals from new worker images emit their own [done] /
// [push_failed], so server-side appends would otherwise duplicate it).
// Returns true when the line was appended.
function appendTerminalLine(lines, line) {
  if (!Array.isArray(lines)) return false;
  if (lines.length && lines[lines.length - 1] === line) return false;
  lines.push(line);
  return true;
}

module.exports = {
  appendTerminalLine,
};
