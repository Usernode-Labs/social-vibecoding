'use strict';

// Score one replayed build: the unified diff it produced (and, when captured,
// its transcript) against a case's signatures. Pure, so the scoring is tested
// without a model or a network.

// The path in a `diff --git a/<p> b/<p>` header. Without a rename both sides
// are the same path, which may itself contain " b/", so split in the middle
// when the halves agree; otherwise take the text after the last " b/".
function headerPath(line) {
  const rest = line.slice('diff --git '.length);
  const mid = (rest.length - 1) / 2;
  if (Number.isInteger(mid) && rest[mid] === ' '
      && rest.startsWith('a/') && rest.slice(mid + 1).startsWith('b/')
      && rest.slice(2, mid) === rest.slice(mid + 3)) {
    return rest.slice(mid + 3);
  }
  const at = rest.lastIndexOf(' b/');
  return at === -1 ? rest : rest.slice(at + 3);
}

// Parse `git diff` output into files with their added and removed lines.
function parseDiff(diffText) {
  const files = [];
  let current = null;
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { path: headerPath(line), added: [], removed: [], isNew: false, isDeleted: false };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode')) { current.isNew = true; continue; }
    if (line.startsWith('deleted file mode')) { current.isDeleted = true; continue; }
    // The +++ line names the new side exactly; it wins over the header.
    if (line.startsWith('+++ b/')) { current.path = line.slice(6); continue; }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) current.added.push(line.slice(1));
    else if (line.startsWith('-')) current.removed.push(line.slice(1));
  }
  return files;
}

function pathMatches(sig, path) {
  if (!sig.path) return true;
  return sig.path === path;
}

// Returns the evidence (a short string) when the signature fires, else null.
function evaluate(sig, files, transcript) {
  const re = new RegExp(sig.pattern, 'm');
  switch (sig.kind) {
    case 'added-line':
    case 'removed-line': {
      const key = sig.kind === 'added-line' ? 'added' : 'removed';
      for (const f of files) {
        if (!pathMatches(sig, f.path)) continue;
        const hit = f[key].find((l) => re.test(l));
        if (hit !== undefined) return `${f.path}: ${sig.kind === 'added-line' ? '+' : '-'}${hit.trim().slice(0, 160)}`;
      }
      return null;
    }
    case 'added-file': {
      const f = files.find((x) => x.isNew && re.test(x.path));
      return f ? `new file ${f.path}` : null;
    }
    case 'touched-file': {
      const f = files.find((x) => re.test(x.path));
      return f ? `changed ${f.path}` : null;
    }
    case 'transcript': {
      if (typeof transcript !== 'string' || !transcript) return null;
      const m = re.exec(transcript);
      return m ? `transcript: ${m[0].slice(0, 160)}` : null;
    }
    default:
      throw new Error(`unknown signature kind: ${sig.kind}`);
  }
}

/**
 * @returns {{ verdict: 'fail'|'warn'|'pass', findings: Array<{id, severity, why, evidence}>,
 *   filesChanged: string[] }}
 */
function scoreReplay(caseDef, { diff, transcript = null } = {}) {
  const files = parseDiff(diff);
  const findings = [];
  for (const sig of caseDef.signatures || []) {
    const evidence = evaluate(sig, files, transcript);
    if (evidence) findings.push({ id: sig.id, severity: sig.severity, why: sig.why, evidence });
  }
  const verdict = findings.some((f) => f.severity === 'fail') ? 'fail'
    : (findings.length ? 'warn' : 'pass');
  return { verdict, findings, filesChanged: files.map((f) => f.path) };
}

module.exports = { parseDiff, scoreReplay };
