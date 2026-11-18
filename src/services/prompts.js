'use strict';

// Loads and caches the platform conventions doc injected into every
// Mayor + Claude Code system prompt. One source of truth — edit
// `app-conventions.md` and both prompts update on next restart.

const fs = require('fs');
const path = require('path');
const log = require('./logger');
const { platformOrigin } = require('./app-identity-env');
const { stripPartMarkers } = require('./homeroom-bot-prompt-parts');

const CONVENTIONS_PATH = path.join(__dirname, '..', 'prompts', 'app-conventions.md');

// The doc names the platform's own origin in a handful of places — the three
// centrally hosted assets, the conventions URL. It is injected verbatim into
// every build agent's system prompt and published at /claude.md, so a literal
// hostname in the file is a literal hostname in every agent's prompt: that is
// how the last platform domain move left this document telling agents to
// load three files from a host that no longer answers, and inviting them to
// write that host into the apps they were building. The file carries a token
// instead, resolved here from the same USERNODE_DOMAIN every other caller
// reads. Unset (local dev, tests) it resolves to the empty string, leaving
// the relative path — which Kubernetes deployments serve from the app's own
// origin, and which is in any case the better failure than a dead host.
const PLATFORM_ORIGIN_TOKEN = '{{PLATFORM_ORIGIN}}';

let cached = null;

function getAppConventions() {
  if (cached !== null) return cached;
  try {
    const raw = fs.readFileSync(CONVENTIONS_PATH, 'utf-8');
    cached = raw.split(PLATFORM_ORIGIN_TOKEN).join(platformOrigin() || '');
  } catch (err) {
    log.error('prompts', 'Failed to read app-conventions.md', { err: err.message });
    cached = '';
  }
  return cached;
}

// #2817: the design guidance every coding agent builds with. It asks for the
// platform's own kit before anything invented, one primary action and one
// word per concept, the four data states, and a self-check before commit.
// Claude and OpenRouter sessions get the same text so the two backends stay
// in parity; the one line that differs is HOW the agent checks its work, and
// it follows what the model running the turn can see, not which backend or
// CLI runs it. Claude, and an OpenRouter model whose catalog entry lists
// image input, look at screenshots: since #3426 both OpenRouter runners hand
// such a model its screenshots (Codex's model catalog declares image input,
// worker/build-codex-model-catalog.js; Claude Code's request adapter passes
// image blocks, worker/claude-openrouter-request.js). A text-only model gets
// a note in place of each screenshot, so it reads the page's accessibility
// snapshot instead. See runtimeReadsImages below. A separate file so it can
// be tuned without touching the 150 KB conventions document.
const DESIGN_GUIDANCE_PATH = path.join(__dirname, '..', 'prompts', 'design-guidance.md');
const DESIGN_SELF_CHECK_TOKEN = '{{DESIGN_SELF_CHECK}}';
// #3737: both looks. Every new app has a light and a dark one (#3688), and
// the frame URL's `?un-theme=` parameter opens a page in either, so the
// self-check walks both: a colour picked in one look and never seen in the
// other is how an app shipped pale violet labels on a white card.
const DESIGN_BOTH_LOOKS = 'in the light and the dark look (add `?un-theme=light`, then `?un-theme=dark`, to the URL; just the one look when the app\'s `CLAUDE.md` declares a single fixed look)';
const DESIGN_CHECKLIST = 'confirm: one primary action where the screen\'s job is an action (a screen for reading or browsing may have none); headings make sense on their own; no new colours or fonts; text and controls readable in each look; nothing boxed in a card that could be plain layout; the same words as the rest of the app. Fix what fails and check again, within the in-loop browser\'s time budget.';
const DESIGN_SELF_CHECK = Object.freeze({
  images: `Checking your work: when the in-loop browser is available, take screenshots (\`browser_take_screenshot\`) of each changed screen at a phone width (\`browser_resize\` to 390x844) and a desktop width, ${DESIGN_BOTH_LOOKS}, including its empty and error states, and ${DESIGN_CHECKLIST}`,
  text: `Checking your work: you read text, not images. When the in-loop browser is available, check the running app with its accessibility snapshot (\`browser_snapshot\`) rather than screenshots. Walk each changed screen at a phone width (\`browser_resize\` to 390x844) and a desktop width, ${DESIGN_BOTH_LOOKS}, including its empty and error states, and ${DESIGN_CHECKLIST}`,
});

let cachedDesignGuidance = null;

// #6777: the file's part markers are budgets, not text. Kept out of what a
// build work order, a triage or an agent's guidance reads, so all of them
// still get exactly the guidance they got before the budgets existed.
function designGuidanceSource({ readsImages = true } = {}) {
  if (cachedDesignGuidance === null) {
    try {
      cachedDesignGuidance = fs.readFileSync(DESIGN_GUIDANCE_PATH, 'utf-8').trim();
    } catch (err) {
      log.error('prompts', 'Failed to read design-guidance.md', { err: err.message });
      cachedDesignGuidance = '';
    }
  }
  if (!cachedDesignGuidance) return '';
  return cachedDesignGuidance
    .split(DESIGN_SELF_CHECK_TOKEN)
    .join(readsImages ? DESIGN_SELF_CHECK.images : DESIGN_SELF_CHECK.text);
}

function getDesignGuidance(opts) {
  return stripPartMarkers(designGuidanceSource(opts));
}

// Whether the model an OpenRouter coding turn runs reads images, from the
// runtime its attempt resolved (agent-turn.js resolveCodexRuntimeContext):
// OpenRouter's catalog flag, agentModelMetadata.supportsImages. It is the
// same value the worker turns into AGENT_MODEL_SUPPORTS_IMAGES, which decides
// whether either runner hands the model a screenshot or a note, so a prompt
// that reads it never tells the model it can see what the runner will not
// show it, or the reverse. Unknown is no, as it is there. A Claude turn on
// Anthropic has no such runtime and always reads images.
function runtimeReadsImages(runtimeContext) {
  return runtimeContext?.agentModelMetadata?.supportsImages === true;
}

// The same decisions, made once at spec time so the build inherits them
// instead of improvising: every scout writes them into the spec as a
// plain-language "### Design" subsection a non-developer can review.
const SPEC_DESIGN_BRIEF = `DESIGN BRIEF: when the change adds or alters something a person sees, end the "User-facing changes" half (before any "### Questions") with a short "### Design" subsection in plain language: the screen's one job, its one primary action if that job is an action (a screen for reading or browsing may have none), which existing screen of this app it should look and behave like, and the exact word it uses for each thing on it, matching the words the app already uses. Prefer the app's existing components and styling to anything new, and say so when nothing existing fits. The build follows this subsection, so decide here rather than leaving it to the build. Omit it for changes nobody sees.`;

// #3737: a project's FIRST version (#3624) has no screen of its own to look
// like. The starter's is placeholder, and its zinc and violet are the
// platform shell's own palette, so first versions all came out looking like
// Homeroom and like each other. The bot's spec for one decides the app's own
// look instead, and its build records it in the app's CLAUDE.md for every
// later change to follow (homeroom-bot-live.js buildPrompt). Every other
// spec keeps the brief above.
//
// 7 Oct 2026: and decides its finish, so the build does not invent it: what
// each repeated row or card shows and how prominently, which control each
// setting uses, how dense the main screen is, and what the populated demo
// shows. In App bench run 9 the GLM builds' populated screens looked empty
// (a ranking app's own list was six empty rows: only other people's votes
// were seeded) or hid their actions (a "view only" demo), where the builds
// that seeded the viewer's own state looked lived in. The brief's examples
// were two of the bench's own starter briefs, so they are gone: an example
// here is copied, and an example from the benchmark leaks into it.
// And its colours are no longer "an accent plus neutrals": the colours a
// subject already has were being avoided as clichés, where the designs
// people preferred used them and kept the action colour quiet (App bench
// runs 7 and 9).
// Later on 7 Oct 2026 ("V1", from running this spec prompt on Opus and
// rendering the drawn screens, which came out closer to what Opus makes
// building an app alone): a screen for reading or browsing keeps its
// actions quiet, the signature element is part of a visual language drawn
// from the subject, and the demo says "Sample data" once, not on every row
// (all nine test drawings cluttered each row with it).
// Newcomer run seven (14 Oct 2026): on an element marked
// data-usernode-demo-note, which Homeroom hides where it shows the app with
// its sample data under a label of its own (homeroom-bot-live.js
// FIRST_VERSION_DESIGN_LINES, the platform conventions' "Labelled once").
const FIRST_VERSION_SPEC_DESIGN_BRIEF = `DESIGN BRIEF (FIRST VERSION): the app has no screen of its own yet (the starter template's is placeholder), so there is no existing screen for it to look like, and the triage only sketched one. In the "User-facing changes" half, before "### Assumptions", write a "### Design" subsection in plain language that decides this app's own look and its finish, so the build does not have to invent either: the main screen's one job, and what a person does most on it: when that is an action (adding, logging, calculating), its one primary action; when it is reading, browsing or comparing, say so, keep the actions quiet and give the content the room (a screen for reading needs no big filled button); its colours, chosen for this app and each a kit token with a light and a dark value (the dark one in the light one's hue): the neutrals, one action colour for the primary action (ink is fine when the subject's own colours carry the screen), and any set of colours the subject itself uses, the ones people already read in its world (a map's water and parks, team colours, card suits, traffic-light statuses), which fit the subject rather than being a cliché to avoid (not the starter's default palette, unless you choose it on purpose and say why); a visual language drawn from the app's subject: its signature element (something a generic app would not have) and the consistent details that carry the subject through the whole screen, such as a small drawn icon for each kind of thing, the subject's own colours and materials, or a typeface that suits it; a sketch of the main screen's layout at phone width, a few plain lines from top to bottom, and how dense it is there (how many rows or cards show before the first scroll, and how much room is around them); for each repeated row or card, what it shows and in what order and prominence (its main text, its secondary text, and its small details such as a time, a count or a status); which control each setting or input uses (a text field, a stepper, a slider, a switch, a segmented control, a list to pick from) and what it starts at; what the populated demo shows, the staging preview opened with ?demo=1, which is how this first version is first seen: the viewer's own data and not only other people's (their own items, choices, progress or saved things, whatever this app keeps for a person), the app's main result already there (the scores added up, the schedule filled in, the totals worked out) and not only what goes into it, varied and realistic rows filling about a screen and a half at phone width, and every control the real populated screen has (a view-only demo that hides actions is not a populated screen), labelled "Sample data" once, plainly and visibly, in a banner or a line of its own at the top of the screen (never the app's name, nor in place of its tagline) or in the name of the list or collection its rows belong to, rather than on each row, with the rows themselves still obviously made up (no real people and no real private data), and the element that carries the label marked with the attribute \`data-usernode-demo-note\` (in a list's name, a span around the label's own words) so Homeroom can hide it where it shows the app with its sample data; and the exact word it uses for each thing on it. Use the platform's native UI kit for the parts it has. If the app keeps one fixed look (such as a game drawn as its own scene), say so here. If the app is a game, its play area (the board, the field, the pieces, the cards) is drawn on a canvas and played with pointer events, never built from HTML elements, a grid game such as minesweeper, sudoku or chess included: say so here, and the technical half plans it that way (the platform conventions' "Games: draw the play area on a canvas"), with everything around the play (the title, menus, the score, results) in HTML. A game starter's own drawing is kept. The build follows this subsection and records it in the app's CLAUDE.md, so decide here rather than leaving it to the build. The "Technical implementation" half says how the demo is made: on staging and with ?demo=1 only, idempotent, either added to those responses or written once for the viewing account on its first ?demo=1 request (the platform conventions' "Staging mock data" has the rules, including keeping it out of anything the app's own logic reads). If the repository has \`design/sketch.json\`, it is the featured card its creator was shown while the app was made: an emoji (already the app's icon), a tagline and a few points that sum up the idea. Read them as context for what the app is for, never as a design: the card shows no screen, so this subsection still decides the look.`;

// 7 Oct 2026 (with the brief above): an HTML spec of a first version DRAWS
// its finished screens, and the build takes them as its visual target
// (homeroom-bot-live.js FIRST_VERSION_DESIGN_LINES). Words carry structure,
// which a build copies faithfully, but not craft: icons, proportions,
// weight, the rhythm of the spacing. The format's screens were made for
// close-ups of a change, before and after; a first version has no before,
// so these rules replace those for it. Drawn at the fidelity the build
// writes, never as artwork, and within a budget (spec-html.js
// SCREEN_CHAR_BUDGET, measured at capture, never enforced by cutting): the
// point is a better home screen for a little more spec, not a painting.
// Newcomer run five (13 Oct 2026): the first screen is drawn without the
// demo's "Sample data" label, since it is also the maker's first look
// (first-version-screens.js) and showed them the label as if it were the app.
const SCREEN_BUDGET_WORDS = (20000).toLocaleString('en-US');
const FIRST_VERSION_SCREENS_BRIEF = `FIRST VERSION SCREENS: for this spec these rules replace the format's before/after rules above. Open the "user" section with a screens figure that draws UP TO TWO screens of the finished first version, in full, as faithful mocks: the build takes them as its visual target. The first is normally the main screen, populated with the demo data your Design subsection describes but drawn WITHOUT its "Sample data" label: the people who asked for the app see this screen first, as their app's first look, and the label marks only the staging preview (the Design subsection still says where the label goes, and the build adds it there); the second, if you draw one, is whatever best shows the app at work, such as an item opened or the main screen in the middle of its key interaction. Draw each at phone width (data-size="phone") with data-height set to the screen's real scroll length, at most 2400, and no data-focus, so the whole screen shows. A first version has no "before" worth drawing: wrap each screen's whole tree in one <div data-side="after" data-change="N">, N being that screen's item in the figure's <ol data-changes> (one item per screen, saying in plain words what it shows), and mark nothing else, so the before side stays empty rather than showing the starter's placeholder. Draw the light look; the Design subsection gives the dark look's values for the same tokens. In each screen's <style> block, define the colours as CSS custom properties named after the design kit's tokens and written as the kit writes them, "R G B" values used as rgb(var(--accent)): --ground, --surface, --raised, --fg, --muted, --line, --accent and --on-accent, plus any new token the Design subsection defines, so the build can map them one to one. Use the kit's component class names (btn-primary, btn-secondary, field, list, list-row, card, section-label) where the kit has the part.
Draw at the app's REAL fidelity: the HTML and CSS the build should write, not artwork. Every element must be something the build can reproduce with the kit's tokens, its components and plain CSS. A game's play area is the one exception: the build paints it on a canvas, so draw it as one inline <svg> picture of what the canvas shows (as many shapes as the board needs, within the screen's budget), and the build paints that picture rather than copying its elements. An icon or illustration is an inline <svg> inside the screen, so the build can lift it: no emoji as icons, and no images. Icons are line icons: a 24 by 24 viewBox, one stroke width, at most about 8 shapes each, and no gradients, filters, masks, patterns or text turned into paths. A consistent set of them is welcome: one for each kind of thing, the app's own mark, its actions. A larger illustration is fine where it carries the subject, each kept to about 30 shapes. Each screen, its <style> included, stays within about ${SCREEN_BUDGET_WORDS} characters: a screen that needs more is drawn in too much detail. Draw repeated rows with identical structure. Spend the effort where a careful designer would: hierarchy, density, spacing, type and the subject's own details; leave out decoration that carries no meaning.`;

// #3699: the spec as a small HTML document that leads with pictures: before/
// after screens on the User-facing tab, diagrams and tables on the Technical
// tab. Given to the scout and the Homeroom bot instead of the markdown format
// lines, for apps in config.htmlSpecApps (every app by default). Two versions,
// because the screens of the platform's own app draw with its real stylesheet
// and every other app's draw with the native UI kit and their own <style>
// blocks (spec-html.js, stampSpecStyles). The dialect, and why the screens are drawn rather than
// captured, are in src/services/spec-html.js; the browser half is
// frontend/src/lib/spec-html.ts. The server keeps a markdown copy of every
// HTML spec for the readers that want text.
function specHtmlContract(platformStyles = true) {
  return `HTML SPEC FORMAT: write the spec as ONE small HTML document, not markdown. The spec viewer shows it with the same two tabs, and it should lead with pictures: before/after screens on the User-facing tab, diagrams and tables on the Technical tab. Use exactly this shape:

<article data-spec>
  <h1>Short title</h1>
  <p>One or two sentence summary.</p>
  <section data-spec-tab="user">…</section>
  <section data-spec-tab="tech">…</section>
</article>

The "user" section is the User-facing half and the "tech" section is the Technical half; everything said about those halves applies to these sections. Inside them use plain elements only: h3, h4, p, ul, ol, li, strong, em, code, pre, a (https links only), table/thead/tbody/tr/th/td, blockquote, hr, figure, figcaption. No script, no style attribute, no ids, no images by URL. A class is kept only if it starts with "spec-". Wherever these instructions name a "### X" subsection (Questions, Design, Considerations, Deferred work, Assumptions), write it as <h3>X</h3> inside the matching section.

BEFORE/AFTER SCREENS: when the change is visible, OPEN the "user" section with a screens figure (leave it out only for a change nobody sees):

<figure data-screens>
  <ol data-changes>
    <li data-change="1" data-steps="Dev board → Up for vote → open a proposal" data-area="840 60 440 160">In plain words, what a person sees change.</li>
  </ol>
  <template data-screen data-size="desktop" data-focus="840 60 440 300">…one markup tree of the screen…</template>
  <template data-screen data-size="phone" data-focus="0 120 390 320">…</template>
  <figcaption>Optional line shown under the screens</figcaption>
</figure>

- THE PLAN'S CARD is written from two parts of this document, word for word, so write them for it: the <p> under the <h1> is its summary, at most two plain sentences and at most 280 characters saying what changes for a person and what stays the same; and each <li> in <ol data-changes> is one of its lines, ONE whole sentence of at most 100 characters saying what a person sees change, numbered (data-change) as the screens mark that change, with data-area="x y w h": the box around that change on the first screen that marks it, in that screen's pixels, with a little room around it, so the card shows each change close up and readable. Each line stands on its own: no quotation left open, no bare heading, no line repeating another, nothing a reader has to look elsewhere to finish. The card shows them as written and never shortens them.
- One to three changes, numbered; up to six screens. data-size "desktop" is 1280×800 and "phone" is 390×844; data-height makes a screen taller (up to 2400).
${platformStyles
    ? "- Draw each screen as real HTML using the app's OWN element structure and class names, copied from the components you read: it renders with the app's real stylesheet, so a faithful copy looks like the app."
    : "- Draw each screen as real HTML using the app's own element structure and class names, copied from the components you read. It renders with the platform's native UI kit stylesheet only (native.css, which every app shares), not with this app's own stylesheet or Tailwind, so put the styles each screen needs in a <style> block inside its template, copied from the app's CSS (for Tailwind utility classes, write the equivalent CSS rules), and the screen looks like the app."} Draw the screen as it is today, and mark what differs in the same tree: data-side="before" on parts only today's app shows, data-side="after" on parts only the change shows, and data-change="N" on each changed part (its numbered outline goes there). Unchanged parts appear once and show on both sides. A screen that does not exist yet (a first version, a new page) shows what is there today, or an empty state, on the before side, and the new screen is data-side="after".
- data-focus="x y w h", in the screen's pixels, frames the close-up the viewer opens on: the part that changes plus enough around it to recognise the place. Draw only as much of the screen as that close-up and its surroundings need. data-persona says who is signed in (member, guest, read_only_admin, full_admin); member is the default.
- Screens render in a sandboxed frame with scripts off and no network: no script, no external images or fonts.${platformStyles
    ? " A class the app's stylesheet does not already define will not exist there, so style anything new with a <style> block inside the template or a style attribute."
    : ''}

DIAGRAMS AND TABLES: open the "tech" section with whatever explains the change fastest, such as a <figure> holding an inline <svg viewBox="…" role="img"> that has a <title>, and keep files touched, data model and tests as tables. SVG may use svg, g, path, rect, circle, ellipse, line, polyline, polygon, text, tspan, title and desc with presentation attributes (no ids, markers, gradients or style). Draw with these classes so it reads in light and dark mode: spec-box, spec-box-changed, spec-box-new (dashed, for new code), spec-line, spec-arrow (a small polygon arrowhead), spec-muted, spec-accent, spec-good, spec-bad. Text takes the theme's colour.`;
}

// The platform's own app: its screens draw with the shell's stylesheets.
const SPEC_HTML_CONTRACT = specHtmlContract(true);

/**
 * #6269 (4 Nov 2026): one repair turn for a plan's card text. A card whose
 * summary or lines broke their rules is not dropped whole: the writer is
 * shown the plan's title, its card as it is now, and only the problems, and
 * is asked to rewrite only the part that failed, within its limits. It never
 * clips a sentence to fit. Pure.
 */
function cardRepairPrompt({ title = '', summary = '', lines = [], problems = [] } = {}) {
  const current = [];
  if (summary) current.push(`The summary, as it is now: ${summary}`);
  if (lines.length) {
    current.push('Its lines, as they are now:');
    for (const line of lines) current.push(`- Line ${line.n || '?'}: ${line.text}`);
  }
  return [
    'You are fixing only the card text of a plan you already wrote, because part of it broke the card\'s rules.',
    'The card text is two parts of the same HTML document: the <p> straight under the <h1> (the summary), and each <li> of <ol data-changes> (one line, numbered data-change as the screens mark it).',
    ...(title ? [`The plan is titled: ${title}`] : []),
    ...current,
    '',
    `What broke: ${problems.join('; ')}.`,
    '',
    'Rewrite ONLY the part or parts that broke, and nothing else. The summary is at most two plain sentences and at most 280 characters. Each line is ONE whole sentence of at most 110 characters saying what a person sees change, numbered as its screens mark it. Never shorten a sentence to make it fit: rewrite it.',
    'Reply with only the replacement elements: a <p> for the summary and/or one <li data-change="N"> per line you rewrote. No other text, no explanation, and no em dashes.',
    'If a part already fits, do not repeat it.',
  ].join('\n');
}

// The offline excerpt carried inside a connector work order.
//
// Every app's notes tell a coding agent to fetch these conventions from the
// Homeroom site at the start of a session. A hosted agent's container blocks
// that host, so it never reads them — and then reasons its way to the very
// things the document forbids (vendoring the hosted assets, "fixing" the
// styling, shipping a screen with no test). The work order therefore carries
// a compact excerpt with it.
//
// The excerpt is a REGION OF THE SAME FILE, delimited by the markers below,
// rather than a second document: a copy would drift, and a drifted copy of
// platform rules is worse than none. Cached alongside getAppConventions().
const WORK_ORDER_BEGIN = '<!-- work-order:begin -->';
const WORK_ORDER_END = '<!-- work-order:end -->';

let cachedEssentials = null;

function getWorkOrderEssentials() {
  if (cachedEssentials !== null) return cachedEssentials;
  const doc = getAppConventions();
  const start = doc.indexOf(WORK_ORDER_BEGIN);
  const end = doc.indexOf(WORK_ORDER_END);
  if (start < 0 || end < 0 || end < start) {
    // Never fatal: the work order loses background guidance, not the base
    // commit or the push commands.
    log.warn('prompts', 'work-order markers missing from app-conventions.md');
    cachedEssentials = '';
    return cachedEssentials;
  }
  cachedEssentials = doc.slice(start + WORK_ORDER_BEGIN.length, end).trim();
  return cachedEssentials;
}

// ── Section index — the connector's conventions lookup ──────────────────
//
// The offline excerpt above is ~6 KB of the document's 116 KB. It is what a
// work order can afford to carry, and it is deliberately the eleven rules an
// agent working blind gets WORST. It is not the native UI kit's component
// list, the LLM proxy's request shape, or the `secrets` declaration format —
// and an agent that needs one of those still has nowhere to read it, because
// its own container cannot reach this host.
//
// MCP connector traffic can: it egresses through the chat product's
// infrastructure rather than the sandbox's. So the same document is also
// served section by section over the connector (get_platform_conventions in
// services/mcp-tools.js). These helpers do the slicing.
//
// The parse is one line of intent: the document's own `## ` headings ARE the
// index, so there is no second table of contents to keep in step. Slugs are
// kebab-cased heading text, computed once with the split and cached beside
// the two caches above, so a tool call is a map lookup rather than a
// re-parse of 116 KB.
let cachedSections = null;

// Heading text → slug. Backticks, emphasis markers and apostrophes are
// dropped rather than turned into separators, so "Don't `git push` yourself"
// is `dont-git-push-yourself` and not `don-t-git-push-yourself`; every other
// run of non-alphanumerics collapses to a single dash.
function slugifyHeading(title) {
  return String(title)
    .replace(/[`*’']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseSections() {
  if (cachedSections !== null) return cachedSections;
  const doc = getAppConventions();
  const sections = [];
  if (!doc) {
    // Same posture as the excerpt: an unreadable document costs the lookup
    // tool its answer, never a whole turn.
    cachedSections = sections;
    return cachedSections;
  }
  const heads = [];
  const re = /^## (.+)$/gm;
  for (let m; (m = re.exec(doc)) !== null; ) {
    heads.push({ title: m[1].trim(), start: m.index });
  }
  const used = new Set();
  heads.forEach((head, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].start : doc.length;
    // The heading line travels WITH its body: a section handed to an agent
    // on its own should still say what it is.
    const content = doc.slice(head.start, end).trim();
    let slug = slugifyHeading(head.title) || `section-${i + 1}`;
    if (used.has(slug)) {
      let n = 2;
      while (used.has(`${slug}-${n}`)) n += 1;
      slug = `${slug}-${n}`;
    }
    used.add(slug);
    sections.push({
      slug,
      title: head.title,
      bytes: Buffer.byteLength(content, 'utf8'),
      content,
    });
  });
  cachedSections = sections;
  return cachedSections;
}

// The index: one entry per H2 section, without the bodies. `bytes` lets the
// caller (and the model) see what a section costs before asking for it.
function getConventionSections() {
  return parseSections().map(({ slug, title, bytes }) => ({ slug, title, bytes }));
}

// One section by slug, or null when the slug is unknown. Returns
// { slug, title, bytes, content } — `content` includes the heading line.
function getConventionSection(slug) {
  const want = typeof slug === 'string' ? slug.trim().toLowerCase() : '';
  if (!want) return null;
  return parseSections().find((s) => s.slug === want) || null;
}

// Exported for the tests, which pin the slug list so a heading edit that
// silently breaks a slug an agent has already learned shows up as a failure.
function getConventionSlugs() {
  return parseSections().map((s) => s.slug);
}

module.exports = {
  getAppConventions,
  getDesignGuidance,
  designGuidanceSource,
  runtimeReadsImages,
  SPEC_DESIGN_BRIEF,
  FIRST_VERSION_SPEC_DESIGN_BRIEF,
  FIRST_VERSION_SCREENS_BRIEF,
  SPEC_HTML_CONTRACT,
  specHtmlContract,
  cardRepairPrompt,
  getWorkOrderEssentials,
  getConventionSections,
  getConventionSection,
  getConventionSlugs,
  WORK_ORDER_BEGIN,
  WORK_ORDER_END,
};
