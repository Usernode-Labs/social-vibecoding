// One-off prod repair: unwrap whole-document code-fence wrappers from stored
// specs (chat_sessions.spec_md + chat_session_specs.content). Embeds the new
// stripSpecWrapperFence logic so it works against a container still running the
// pre-fix code. Idempotent. DRY RUN unless invoked with --apply.

function stripSpecWrapperFence(content) {
  if (typeof content !== 'string') return content;
  const text = content.trim();
  if (!text) return content;
  const lines = text.split('\n');
  const open = /^([`~]{3,})(.*)$/.exec(lines[0]);
  if (!open) return content;
  const fence = open[1];
  const marker = fence[0];
  const info = open[2].trim().toLowerCase();
  if (info.includes(marker)) return content;
  if (!isMarkdownWrapperInfo(info)) return content;
  let lastIdx = lines.length - 1;
  while (lastIdx > 0 && !lines[lastIdx].trim()) lastIdx--;
  if (lastIdx === 0) return content;
  const bareCloseRe = new RegExp(`^\\${marker}{${fence.length},}\\s*$`);
  if (!bareCloseRe.test(lines[lastIdx])) return content;
  let insideInner = false;
  let innerMarker = '';
  let innerLen = 0;
  for (let i = 1; i < lastIdx; i++) {
    const m = /^([`~]{3,})(.*)$/.exec(lines[i]);
    if (!m) continue;
    const lm = m[1][0];
    const llen = m[1].length;
    const linfo = m[2].trim();
    if (!insideInner) {
      insideInner = true;
      innerMarker = lm;
      innerLen = llen;
    } else if (lm === innerMarker && llen >= innerLen && linfo === '') {
      insideInner = false;
    }
  }
  if (insideInner) return content;
  const inner = lines.slice(1, lastIdx).join('\n').trim();
  return inner || content;
}

function isMarkdownWrapperInfo(info) {
  if (info === '' || info === 'markdown' || info === 'md' || info === 'gfm') return true;
  let path = info;
  if (path.startsWith('filepath:')) path = path.slice('filepath:'.length);
  else if (path.startsWith('file:')) path = path.slice('file:'.length);
  return /\.(md|markdown)$/.test(path.trim());
}

(async () => {
  const APPLY = process.argv.includes('--apply') || process.env.APPLY === '1';
  const { Pool } = require('/app/node_modules/pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const firstLine = (s) => String(s).split('\n')[0].slice(0, 60);

  let sessChanged = 0;
  const sess = await pool.query('SELECT id, spec_md FROM chat_sessions');
  for (const r of sess.rows) {
    const next = stripSpecWrapperFence(r.spec_md || '');
    if (next !== (r.spec_md || '')) {
      sessChanged++;
      console.log(`session ${r.id}: spec_md  "${firstLine(r.spec_md)}" -> "${firstLine(next)}"`);
      if (APPLY) await pool.query('UPDATE chat_sessions SET spec_md = $1 WHERE id = $2', [next, r.id]);
    }
  }

  let verChanged = 0;
  const vers = await pool.query('SELECT id, session_id, version, content FROM chat_session_specs');
  for (const r of vers.rows) {
    const next = stripSpecWrapperFence(r.content || '');
    if (next !== (r.content || '')) {
      verChanged++;
      console.log(`spec id ${r.id} (session ${r.session_id} v${r.version}): "${firstLine(r.content)}" -> "${firstLine(next)}"`);
      if (APPLY) await pool.query('UPDATE chat_session_specs SET content = $1 WHERE id = $2', [next, r.id]);
    }
  }

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'} — sessions changed: ${sessChanged}, spec versions changed: ${verChanged}`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
