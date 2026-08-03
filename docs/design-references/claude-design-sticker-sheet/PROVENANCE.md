# Claude Design sticker sheet — provenance and status

**What this is.** A two-file snapshot of the owner-directed "Craft Direction" sticker sheet
from the Claude Design project "Usernode Design System"
(projectId 570c265a-98ed-459d-a142-0a04ae458d58):

- `foundations/sticker-sheet/index.html` — sha256 29a8e346bd4953a14d47b95a6a1a45b46c846b092756e24ce92ccd7aa7d3482f
- `styles.css` — sha256 bb903239ba5d67206177e3ec53e19958d4877984d2d84e4014715cd7d2039d36

Fetched 2026-07-31 by lead-claude through the authenticated DesignSync `get_file` read
(owner request: Buzz fe-cleanup event e9b92cd8…). The copy was render-verified headlessly
at 1440px (full sheet renders, zero page errors, meter script executes); it is a faithful
transcription of the remote read, not a byte-attested export. Open `index.html` in a
browser; the stylesheet resolves relatively. Geist loads from Google Fonts when online,
falls back to system sans offline.

**Status: ADVISORY, OPTIONAL, INSPIRATION-ONLY (owner's classification, "~80% there").**

**Owner directive 2026-07-31 (Buzz event e39fe8d8…):** the Claude Design project is NOT a
styling source for implementation — "do not style anything right now from claude design
project unless I tell you so." Only this sticker sheet is used, and only as inspiration.
Implementation packets cite in-repo authority exclusively: interface-laws.md, tokens.json,
and the RESEARCH specification files.

- It is NOT authority. The five interface laws (`frontend/design-system/interface-laws.md`)
  and canonical tokens (`frontend/design-system/tokens.json`) remain the only binding
  sources. Where this sheet and the law disagree, the law wins.
- It uses its OWN variable palette (`--well`, `--shadow-raise`, `--tint-*`, `--gold`,
  warm hue-95 neutrals) — these are not repository tokens and must never be copied into
  application source directly. Any adoption goes through a token proposal.
- Its content is fictional finance placeholder copy (transfers, tickers, accounts) from
  the reference study; nothing in it describes Usernode product truth.
- Known law tensions, deliberate in a style study: raised-shadow secondary buttons and
  shadowed rails exceed Law 1's elevation restraint; the danger-tinted button treatment
  differs from the governed destructive variant. Treat as directions to argue from,
  not patterns to paste.

**Why it is useful anyway.** Several elements are pixel demonstrations of already-ratified
direction: the nested-Container segmented control (Law 4), tinted
status banners with a cap column (Law 4 / Family B), the gold tier pill and tick-mark
meter (the Challenges "Monthly Millionaire" blueprint, PI-01 lane), and a
lighter-not-brighter dark inversion.
