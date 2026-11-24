'use strict';

// One reply checker for Homeroom bot (docs/plans/bot-one-model.md, step 2 of
// the brief). Every surface that lets the model speak runs its words through
// it before they are sent: Main and private threads (homeroom-bot-mayor.js,
// its plain fallback too), the voice in a project's threads and its reports
// of a follow-up (homeroom-bot-voice.js converse, composeReport), and design
// threads (design-bot.js). A server template that states a claim goes
// through checkedNote.
//
// What a reply says was done is a CLAIM. A claim is backed by what this turn
// did (its flags), or by what Homeroom has stored: the request's work state
// (work_states), the bot's cards (bot_cards), the reports it filed
// (feedback_reports), its posts and the asks on a change, the request's own
// state (closed, moved), and the bot's SERVER notes in this conversation
// (metadata.kind filed, closing, withdrawn, design_filed). The model's own
// earlier chat words are never proof.
//
// A claim is a problem only when it is SHOWN false: an action the bot never
// takes ("I closed it", "I moved it"), something only this turn could have
// done and did not ("I'm drawing it"), or a record that every read found to
// say otherwise. A sentence that cannot be confirmed (a read failed, or
// nothing names what it is about) stays. The model is asked once more with a
// note (repairNote) that asks for a lookup with the tools its place has,
// never a denial; whatever is still shown false is cut (cut), which never
// adds a line of its own.

const log = require('./logger');
const { withoutEmDashes } = require('./em-dashes');
const { labelledAsPullRequest } = require('./request-mentions');

// ── Words ─────────────────────────────────────────────────────────────────

/** Pure: words compared ignoring case, spacing and punctuation. */
const squashWords = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// #3769: "[about Ear Trainer request #14] " opened replies. It was the label
// the bot's own past messages carried in the model's history, copied. The
// history no longer carries it; a reply that still starts with one, or with
// any bracketed note of the same shape, loses it.
const LEADING_NOTE_RE = /^\s*\[(?:about|re|homeroom)\b[^\]\n]{0,200}\]\s*/i;

/** Pure: a reply's words as they are sent: no leading bracketed note, and no em dash. */
function cleanReply(text) {
  let out = String(text ?? '');
  for (let i = 0; i < 3 && LEADING_NOTE_RE.test(out); i += 1) out = out.replace(LEADING_NOTE_RE, '');
  return withoutEmDashes(out).trim();
}

const LIST_LINE = /^\s*(?:[-*]|\d+\.)\s/;

/**
 * Pure (#6566): a paragraph's sentences. Lines are joined within it, so a
 * sentence wrapped over two lines is one sentence, never a fragment; a list
 * line is one piece as it is.
 */
function sentencesOf(paragraph) {
  const out = [];
  let buf = '';
  for (const line of String(paragraph || '').split('\n')) {
    if (LIST_LINE.test(line)) {
      if (buf) { out.push(buf); buf = ''; }
      out.push(line);
      continue;
    }
    buf = buf ? `${buf} ${line}` : line;
    if (/[.!?:]\s*$/.test(line)) { out.push(buf); buf = ''; }
  }
  if (buf) out.push(buf);
  return out.flatMap((piece) => (LIST_LINE.test(piece) ? [piece] : piece.split(/(?<=[.!?])\s+/)));
}

/** Pure: every sentence of `text`, paragraph by paragraph. */
function sentences(text) {
  return String(text || '').split(/\n{2,}/).flatMap(sentencesOf).map((s) => s.trim()).filter(Boolean);
}

// ── Request numbers ───────────────────────────────────────────────────────

/**
 * Pure: does the `#N` between `before` and `after` read as a request in a
 * reply, rather than a colour or a ranking (#6583)? A request number is the
 * usual case; these are the contexts that make it something else.
 */
function usedAsRequest(before, after) {
  // "Use #222 for the header", "the colour #222".
  if (/\b(?:use|using|colour|color|hex|shade|background)\s*$/i.test(before)) return false;
  // "#1 priority", "#3 on the list".
  if (/^\s*(?:priority|(?:on|in|of)\s+(?:the|your|that)\s+list)\b/i.test(after)) return false;
  return true;
}

/**
 * Pure: the request numbers `text` names ("#14", "request #14"), less those
 * of a proposal, pull request or change ("proposal #6011", "PR #12",
 * "Change #6002"; request-mentions.js). #6583: only a #N used as a request
 * counts, so a colour ("#222") or a ranking ("#1 priority") is not one.
 */
function requestNumbers(text) {
  const out = new Set();
  const said = String(text || '');
  const re = /#(\d{1,7})\b/g;
  let m;
  while ((m = re.exec(said)) !== null) {
    const at = m.index;
    // A number written as part of a word or an entity ("x#9", "&#39;").
    if (at > 0 && /[\w&/#]/.test(said[at - 1])) continue;
    if (labelledAsPullRequest(said, at)) continue;
    const before = said.slice(Math.max(0, at - 100), at);
    const after = said.slice(at + m[0].length, at + m[0].length + 48);
    if (!usedAsRequest(before, after)) continue;
    out.add(Number(m[1]));
  }
  return [...out];
}

// ── The claims ────────────────────────────────────────────────────────────
//
// On 3 October the bot answered a typed "file it" with "Filed: Ear Trainer
// request #14 …" and nothing was filed (#3769, #3772); it promised to "look
// into" a duplicate proposal it had no way to look into (#11, WP3); it told
// people to close a thread "from your side" (#6159); and it said it was
// drawing a screen it never handed to the designer (1 Nov 2026). #6583: it
// also cut true sentences about earlier turns and put a fixed "I haven't…"
// in their place. Each claim below says where its proof is:
//
//   never    the bot never does this; always false.
//   turn     only this turn could have done it (turn(t)).
//   records  this turn (turn(t)) or the stored records (standing(s, m)):
//            true backs it, false shows it false, null cannot tell (kept).
//
// `applies(t)`, where present, limits a claim to the surface that knows its
// facts (a design thread, a voice turn that tracks what it read).

// 1 Nov 2026: says a screen is being drawn: "I'm drawing", "I'll draw it",
// "rendering it now"; not "I can draw it" or "I'll draw it once you say which".
const DRAWING_CLAIM = new RegExp(
  '\\bI(?:\'m| am)\\s+(?:now\\s+|just\\s+)?(?:drawing|sketching|designing|rendering|mocking (?:it |this |that )?up|laying (?:it |this |that )?out)\\b'
  + '|\\b(?:I(?:\'ll| will)|let me)\\s+(?:now\\s+|just\\s+|go ahead and\\s+)?(?:draw|sketch|design|render|mock(?: it| this| that)? up|lay (?:it |this |that )?out)\\b'
  + '(?![^.!?\\n]*\\b(?:if|when|once|after|as soon as) you\\b)'
  // "Drawing it now…", "Drawing the main screen next"; not "Rendering the list as cards would fit".
  + '|(?:^|[.!\\n]\\s*)(?:drawing|rendering|sketching|designing|mocking up)\\s+'
  + '(?:it|this|that|them|(?:the|your|a|an)\\s+(?:[\\w\'-]+\\s+){0,2}(?:screens?|designs?|pages?|versions?|mock-?ups?|layouts?))\\b'
  + '|\\b(?:drawing|rendering|sketching) (?:it|this|that|them) (?:now|up)\\b',
  'i',
);

// 17 Nov 2026 (#6763): a reply that points at the New project button under
// it ("tap New project", "New project below", "the New project button"), when
// none is showing. Only words that tell them to tap it, or say it is under the
// reply, count: "a new project of its own" is an idea, not a door.
const NEW_PROJECT_CLAIM = new RegExp(
  String.raw`\b(?:tap|press|click|hit|use)\s+(?:the\s+)?\**["“]?New project\b`
  + String.raw`|\bNew project\b[^.!?\n]{0,80}\b(?:appear|show(?:s|n)? up|below|under (?:this|my|the|that) (?:message|reply))\b`
  + String.raw`|\bNew project button\b`
  // #6783: the offer is a card under the reply now, so a reply points at it
  // there ("the card below", "check ... below, then Make it").
  + String.raw`|\b(?:card|offer)\b[^.!?\n]{0,60}\b(?:below|under (?:this|my|the|that) (?:message|reply))\b`
  + String.raw`|\bbelow\b[^.!?\n]{0,40}\bthen\s+\**["“]?Make it\b`,
  'i',
);

/** Pure (#6763): a reply's leftover words for the button, cut with a false claim about it. */
const NEW_PROJECT_WORDS_RE = /\bNew project\b/;

/**
 * Pure (#6784, 17 Nov 2026): a New project offered with a one-line pitch
 * while the reply beside it sets out a plan. The reply's plan points are its
 * bullet lines ("- ", "* ", "• ", "1."); true when there are at least three,
 * the idea has fewer than half as many lines, and the idea is under 40% of
 * their length. A short idea with a short reply is no problem.
 */
function briefShortOfPlan(idea, text) {
  const said = typeof idea === 'string' ? idea.trim() : '';
  if (!said) return false;
  const points = String(text || '').split(/\r?\n/).filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line));
  if (points.length < 3) return false;
  const lines = said.split(/\r?\n/).filter((line) => line.trim());
  return lines.length < points.length / 2 && said.length < points.join('\n').length * 0.4;
}

/**
 * Pure (#6763): does this turn's thread already show New project at its foot,
 * or does the turn itself offer one? True when it called offer_new_project
 * (newProjectOffer); in the thread the bot opened for a new project
 * (threadDraft changeKind 'project'); or in a thread that holds a drawn
 * screen for no project yet (threadDesign with no app), which the thread bar
 * draws the door for (private-thread-bar.tsx doorsFor).
 */
function newProjectDoorShown(t) {
  if (!t) return false;
  if (t.newProjectOffer) return true;
  const draft = t.deps?.threadDraft || null;
  if (draft?.kind === 'ask' && draft.changeKind === 'project') return true;
  const design = t.deps?.threadDesign || null;
  // Artifacts: only a design's thread draws the door (private-threads.js
  // stateOf); a plain page is never made into a project.
  if (design && (design.artifactKind || 'design') !== 'design') return false;
  return !!(design && !design.app?.slug && design.surface !== 'platform');
}

/**
 * #6159 (3 Nov 2026): "close it from your side", "I can't close threads":
 * there is no such control on their side, and the bot can close a private
 * thread itself (close_thread).
 */
const NO_CONTROL_CLAIM = /\b(?:from|on) your (?:side|end)\b|\bI\s+(?:can['’]?t|cannot|am not able to)\s+close\b[^.?!]{0,30}\bthreads?\b|\bclose (?:it|this thread|the thread) yourself\b/i;

// A design thread (design-bot.js): "I've changed the header", "I just made it
// blue", "here's the new version": done now. Not "In version 2 I made the
// header blue", which tells of a version before.
const DESIGN_DONE = /\bI(?:'ve| have)\s+(?:just\s+|now\s+)?(?:changed|updated|made|moved|added|removed|swapped|replaced|redrawn|drawn|redesigned|reworked)\b|\bI\s+(?:just|now)\s+(?:changed|updated|made|moved|added|removed|swapped|replaced|redrew|drew|redesigned|reworked)\b|\bhere(?:'s| is) (?:the|your) (?:new |next |updated )?(?:version|screen|design)\b/i;

// Artifacts, stage 2: a thread's plain page, said done now in the same
// words a design is ("I've added the totals", "here's the new version"),
// or as the page itself ("here's the page", "the page now shows them").
const PAGE_DONE = new RegExp([
  DESIGN_DONE.source,
  String.raw`\bhere(?:'s| is) (?:the|your) (?:new |next |updated )?page\b`,
  String.raw`\bthe page (?:now )?(?:shows|has)\b`,
].join('|'), 'i');

// Step 6 (#6864, 6): a thread whose live draft is open, answered by the
// chat's own turn: "I've made the button bigger", "I changed it", "it's
// saved", "the preview now shows it". Only an apply_changes that saved this
// turn backs it (live-draft-bot.js), so a reply never claims an edit that
// was not applied.
const DRAFT_DONE = new RegExp([
  String.raw`\bI(?:'ve| have)\s+(?:just\s+|now\s+)?(?:changed|updated|made|moved|added|removed|swapped|replaced|fixed|saved|applied|renamed|edited)\b`,
  String.raw`\bI\s+(?:just|now)\s+(?:changed|updated|made|moved|added|removed|swapped|replaced|fixed|saved|applied|renamed|edited)\b`,
  String.raw`\b(?:it|that|the change|your change|the edit)(?:'s| is| has been| was)\s+(?:now\s+)?(?:saved|applied|live in the preview)\b`,
  String.raw`\bthe preview (?:now )?(?:shows|has) (?:it|the change|your change)\b`,
].join('|'), 'i');

// 20 Nov 2026 (live-draft review, A): ten replies in thread 58972 said one
// delete button was fixed, and the person answered "nope" with a screenshot
// each time. In a draft turn, "it's fixed", "Fixed:", "the button now sits
// on the right", "it looks right now" say how the preview looks; only a look
// at it after the turn's last save (live-draft-bot.js look_at_preview, the
// session's draftLooked) backs them. "It should now sit on the right" and "I
// expect it to" say what is expected, which a reply with no look says, and
// "the preview now shows the change" is what a save says (draft_done).
const DRAFT_LOOKS = new RegExp([
  String.raw`\b(?:it|that|this|everything|the\s+[^.!?\n]{1,40}?)(?:'s|’s|\s+is|\s+are|\s+has been|\s+have been|\s+was|\s+were)\s+(?:now\s+)?(?:all\s+)?(?:fixed|sorted(?:\s+out)?|resolved)\b`,
  String.raw`(?:^|[.!?\n]\s*)[*_]*(?:all\s+)?fixed\b`,
  String.raw`(?<!\b(?:should|will|would|could|might|may|must|to)\s+)(?<!['’]ll\s+)\bnow\s+(?:looks?|shows?|sits?|appears?|lines?\s+up|fits?|displays?|matches|reads?|stays?)\b(?!\s+(?:it|them|the (?:change|changes|edit)|your (?:change|changes|edit))\b)`,
  String.raw`\b(?:looks?|appears?)\s+(?:right|correct|good|fine|better|great|as (?:you|they) (?:asked|wanted))\s+now\b`,
].join('|'), 'i');
// Not a claim about the preview now: the app running again (what the last
// apply itself said), or an earlier change told of.
const DRAFT_NOT_LOOKS = /\b(?:runs?|running|starts?|started|restart(?:s|ed)?|boots?|back up|up again|earlier|previous(?:ly)?|last time)\b/i;

// 24 Nov 2026: in one thread, during a rebuild, the bot said "say 'try now'
// again once it has had a moment and I will look". The preview reloads
// their view by itself, so asking them to prompt again is never right
// (DRAFT_ASK_AGAIN), and a look or a line promised for later is right only
// when this turn armed the follow-up that posts one (live-draft-bot.js
// draftFollowup; live-drafts.js followUp). "Ask me again in a few minutes",
// which a failure on Homeroom's side says, and "let me know if you want it
// bigger" are no such thing.
const UP_WORDS = String.raw`(?:up|ready|built|done|finished|loaded|back|running)`;
const DRAFT_ASK_AGAIN = new RegExp([
  String.raw`\b(?:say|type|send|write)\s+["“'‘]?(?:try (?:it )?(?:now|again)|check again|look again)\b`,
  String.raw`\b(?:ask me|tell me|let me know|ping me|message me|remind me)\s+(?:again\s+)?(?:once|when|after)\b[^.!?\n]{0,60}?\b${UP_WORDS}\b`,
  String.raw`\bask (?:me )?again\b[^.!?\n]{0,50}?\b(?:once|when|after)\b[^.!?\n]{0,50}?\b${UP_WORDS}\b`,
].join('|'), 'i');
const DRAFT_LATER_LOOK = new RegExp([
  String.raw`\bI(?:'ll|’ll| will)\s+(?:then\s+|also\s+)?(?:look|check|take a look|have a look|verify)\b[^.!?\n]{0,60}?\b(?:once|when|after)\b`,
  String.raw`\b(?:once|when|after)\b[^.!?\n]{0,60}?\b${UP_WORDS}\b[^.!?\n]{0,30}?\bI(?:'ll|’ll| will)\s+(?:look|check|take a look|have a look|verify)\b`,
  String.raw`\b(?:I(?:'ll|’ll| will)|Homeroom (?:will|posts))\s+(?:post|send|write|drop|let you know|tell you)\b[^.!?\n]{0,60}?\b(?:once|when|after)\b`,
].join('|'), 'i');
const DRAFT_LATER = new RegExp(`${DRAFT_ASK_AGAIN.source}|${DRAFT_LATER_LOOK.source}`, 'i');

// #6151: a filed design (design-bot.js) said not to be built, or to need
// somebody else to start it: "I can't build it myself", "someone on the
// project has to start it", "building starts on the project's side".
const NOT_BUILT = new RegExp([
  String.raw`\b(?:can['’]?t|cannot|can not|won['’]?t|will not|unable to|not able to)\s+(?:be\s+)?(?:build|built|start building|start the build)\b`,
  String.raw`\b(?:someone|somebody|a person|people|the project|its members|a member|another person)\b[^.?!]{0,40}\b(?:has|have|needs?|must)\s+to\s+(?:start|build|begin|pick it up)\b`,
  String.raw`\bthe project['’]?s side\b`,
].join('|'), 'i');

// #6263: a reply that says what a change's description contains, or that it
// is an earlier version, without having read it this turn: "That's the
// earlier wording, from before the update." was said about text the bot had
// never read and could not read.
const UNREAD_DESCRIPTION_RE = new RegExp(
  String.raw`\b(?:the\s+(?:change'?s?\s+)?|its\s+)?description\s+(?:still\s+)?(?:says?|said|reads?|describes?|described|is|was)\b`
  + String.raw`|\bearlier\s+(?:wording|version|text)\b`,
  'i',
);

// 20 Nov 2026 (live-draft review, E): a reply that says it looked something
// up on the web. Asked to "research how ios apps usually lay out this", the
// bot said "Looking into it:" and answered from what it knew, with no way to
// look. Only a web_search that ran this turn backs it (bot-web-search.js):
// "I researched", "I looked it up", "I searched online", "from my
// research", "I'll research it" (with nothing searched). Not "I searched
// the open requests", which list_requests does.
const SEARCHED_WEB = new RegExp([
  String.raw`\bI(?:'ve| have)?\s+(?:just\s+|now\s+|already\s+|quickly\s+)?(?:researched|googled)\b`,
  String.raw`\bI(?:'ve| have)?\s+(?:just\s+|now\s+|already\s+|quickly\s+)?(?:did|done)\s+(?:some\s+|a bit of\s+|a little\s+|a quick\s+|quick\s+)?(?:research|digging online|searching)\b`,
  String.raw`\bI(?:'m| am)\s+(?:now\s+|just\s+)?(?:researching|googling)\b`,
  String.raw`\b(?:I(?:'ll| will)|let me)\s+(?:now\s+|just\s+|quickly\s+|go\s+)?(?:research|google)\b`,
  String.raw`\b(?:I(?:'ve| have)?|I(?:'m| am)|I(?:'ll| will)|let me)\s+(?:just\s+|now\s+|already\s+|quickly\s+)?(?:searched|searching|search|looked|looking|look|checked|checking|check|read|found)\b[^.!?\n]{0,40}?\b(?:online|on the web|the web|on the internet|the internet|on Google)\b`,
  String.raw`\b(?:my|the|a quick|some|this)\s+(?:research|web search(?:es)?|online search(?:es)?|search results?)\s+(?:shows?|showed|found|finds|turned up|says?|said|suggests?|suggested|points?)\b`,
  String.raw`\b(?:from|after|based on|according to)\s+(?:my|some|a quick|the)\s+(?:research|web search|online search|searching)\b`,
].join('|'), 'i');
// "I looked it up", unless the sentence says it was one of Homeroom's own
// records ("I looked it up in your requests", "looked up request #12").
const LOOKED_UP = /\bI(?:'ve| have)?\s+(?:just\s+|now\s+|already\s+|quickly\s+)?looked\s+(?:it|this|that|them|those|these)\s+up\b|\b(?:I(?:'ll| will)|let me)\s+(?:just\s+|quickly\s+|go\s+)?look\s+(?:it|this|that)\s+up\b/i;
const HOMEROOM_RECORDS = /\b(?:requests?|records?|code|workshop|my_work|progress|discussion|proposals?|changes?|threads?)\b|#\d/i;
const SEARCHED_CLAIM = new RegExp(`${SEARCHED_WEB.source}|${LOOKED_UP.source}`, 'i');

/** Pure: a sentence that says it looked something up on the web (SEARCHED_WEB, LOOKED_UP). */
function claimsSearch(sentence) {
  const text = String(sentence || '');
  return SEARCHED_WEB.test(text) || (LOOKED_UP.test(text) && !HOMEROOM_RECORDS.test(text));
}

// 20 Nov 2026 (live-draft review, C): an offer or a promise to change a
// proposal: "Want me to update PR #142?", "I'll apply this look to the
// proposal", "Shall I push it into PR #142". At 16:05 in thread 58972 the bot
// offered a button "Apply this page's look onto PR #142 now", after saying a
// draft could not be seeded from PR 142, and no tool could do it. Said in a
// reply's words, only an offer or a promise counts: "Update the proposal from
// the preview's header" tells THEM what to tap. A button is a thing they tap
// to say, so there an order counts too ("Apply ... onto PR #142").
const PROPOSAL_TARGET = String.raw`(?:\b(?:PR|pull request|proposal)\s*#?\s*\d{1,7}\b|\b(?:the|your|its|this|that|my|their)\s+(?:(?:open|current|existing|same|old)\s+)?(?:proposal|PR|pull request)\b)`;
const PROPOSAL_VERB = String.raw`(?:update|apply|revise|change|edit|modify|push|add|bring|port|carry|copy|put|move|merge|fold|rework|amend|patch|sync|fix)`;
// The verb, then the proposal at once, or a few words and where they go.
const PROPOSAL_REACH = String.raw`${PROPOSAL_VERB}\b(?:\s+[\w'’-]+){0,6}?\s+(?:(?:onto|into|to|in|on|over to|across to)\s+)?${PROPOSAL_TARGET}`;
const PROPOSAL_OFFER = new RegExp([
  String.raw`\b(?:I(?:['’]ll| will| can| could| would|['’]d| shall| am going to|['’]m going to)|(?:shall|should|can|could|may) I|(?:want|like) me to|let me|let['’]s)\s+(?:(?:also|now|then|just|quickly|first|still|go ahead and|try to)\s+)*${PROPOSAL_REACH}`,
  String.raw`\bI(?:['’]m| am)\s+(?:now\s+)?(?:updating|applying|revising|changing|editing|pushing|adding|bringing|porting|copying|putting|moving|merging|reworking|amending|patching|syncing|fixing)\b(?:\s+[\w'’-]+){0,6}?\s+(?:(?:onto|into|to|in|on)\s+)?${PROPOSAL_TARGET}`,
].join('|'), 'i');
const PROPOSAL_BUTTON = new RegExp([
  PROPOSAL_OFFER.source,
  String.raw`^[\W_]*(?:(?:yes|ok|okay|sure|please|go ahead and|now)[,!.]?\s+)*${PROPOSAL_REACH}`,
].join('|'), 'i');

/** Pure: the proposals a sentence names by number ("PR #142", "proposal #6011"). */
function proposalNumbers(sentence) {
  const out = new Set();
  for (const m of String(sentence || '').matchAll(/\b(?:PR|pull request|proposal)\s*#?\s*(\d{1,7})\b/gi)) out.add(Number(m[1]));
  return [...out];
}

/**
 * Pure (C): whether an offer to change a proposal stands on nothing this turn
 * can do. It stands on (a) this thread's live draft's own proposal while
 * Update proposal is a real tap (`proposalTaps`: the card this turn put under
 * the reply, or the preview header's while the draft has changes the
 * proposal lacks), or (b) a proposal the bot built, which revise_proposal can
 * change (`revisableProposals`, read once by checkReply; unread or a failed
 * read cannot tell, and stands). "The proposal" with no number is the
 * draft's in a thread whose draft has one, else one the bot built for them.
 */
function proposalOfferUnbacked(sentence, t = {}) {
  const taps = t.proposalTaps || {};
  const draftPr = Number(taps.pr) > 0 ? Number(taps.pr) : null;
  const own = t.revisableProposals || null;
  if (own?.unsure) return false;
  const numbers = proposalNumbers(sentence);
  if (!numbers.length) {
    if (draftPr || taps.update) return !taps.update;
    return !(t.revised || own?.theirs);
  }
  return !numbers.every((n) => (taps.update && n === draftPr) || !!own?.prs?.has(n) || !!own?.ids?.has(n));
}

/** The bot's own proposals up for a vote that a sentence names, or that answer requests they asked for. */
const REVISABLE_SQL = `
  SELECT cs.id, cs.pr_number,
         EXISTS (SELECT 1 FROM homeroom_bot_runs r
                   JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
                  WHERE r.proposal_session_id = cs.id AND q.user_id = $3) AS theirs
    FROM chat_sessions cs
   WHERE cs.user_id = $1 AND cs.status = 'promoted' AND cs.is_headless = FALSE
     AND (cs.pr_number = ANY($2::int[]) OR cs.id = ANY($2::int[])
          OR EXISTS (SELECT 1 FROM homeroom_bot_runs r
                       JOIN homeroom_bot_requesters q ON q.app_id = r.app_id AND q.issue_number = r.issue_number
                      WHERE r.proposal_session_id = cs.id AND q.user_id = $3))
   LIMIT 50`;

/**
 * C: what revise_proposal could change for the proposals `pieces` (sentences
 * or buttons) name, read once a turn (again only for a number not read yet)
 * onto `turn.revisableProposals`: { prs, ids, theirs, asked }, or
 * { unsure: true } when the read failed. Nothing to read where the turn has
 * no revise_proposal. Never throws.
 */
async function noteRevisable(pool, turn, pieces) {
  const numbers = [...new Set(pieces.flatMap(proposalNumbers))];
  const had = turn.revisableProposals;
  if (had && !had.unsure && numbers.every((n) => had.asked.has(n))) return;
  const none = { prs: new Set(), ids: new Set(), theirs: false, asked: new Set(numbers) };
  const tools = turn.toolNames;
  const botId = Number(turn.bot?.id);
  if ((tools instanceof Set && !tools.has('revise_proposal')) || !(botId > 0)) {
    turn.revisableProposals = none;
    return;
  }
  try {
    const { rows } = await pool.query(REVISABLE_SQL, [botId, numbers, Number(turn.user?.id) || null]);
    turn.revisableProposals = {
      prs: new Set((rows || []).map((r) => Number(r.pr_number)).filter((n) => n > 0)),
      ids: new Set((rows || []).map((r) => Number(r.id)).filter((n) => n > 0)),
      theirs: (rows || []).some((r) => r.theirs === true),
      asked: new Set(numbers),
    };
  } catch (err) {
    log.warn('reply-claims', 'Could not read the proposals a reply offers to change', { err: err?.message || String(err) });
    turn.revisableProposals = { unsure: true };
  }
}

/**
 * Pure (C): a reply's buttons (the reply tool's suggestions, each sent as
 * their words when tapped) less those that offer to change a proposal no
 * tool of this turn can change. Only where the turn carries its proposal
 * facts (the chat, homeroom-bot-mayor.js proposalTapsOf).
 */
function keptButtons(labels, ctx = null) {
  const list = Array.isArray(labels) ? labels : [];
  if (!ctx || !ctx.proposalTaps) return list;
  return list.filter((label) => !(PROPOSAL_BUTTON.test(String(label || '')) && proposalOfferUnbacked(String(label || ''), ctx)));
}

/** The bot's own work on a request, by its stored stage, never started or since stopped. */
const NOT_STARTED_STAGES = new Set(['waiting_for_you', 'stopped', 'closed']);

const has = (set, n) => !!set && set.has(Number(n));
const any = (list, fn) => (Array.isArray(list) ? list : [...(list || [])]).some(fn);

const CLAIMS = Object.freeze([
  {
    kind: 'no_control',
    proof: 'never',
    re: NO_CONTROL_CLAIM,
    // A thread this turn closed has nothing left to close.
    turn: (t) => !!t.closedThread,
    said: 'tells them to do something there is no control for, or says you cannot close this thread',
  },
  {
    kind: 'filed',
    proof: 'records',
    // "Filed: …" opening a line, "I filed …", or "I opened / created a
    // request". A draft or an offer is not a filing, and a proposal the bot
    // opened is a different thing. Nor is a report to the team (`reported`
    // below): "I've filed a report".
    re: /(?:^|\n)\s*\**filed\b|\bI(?:'ve| have)?(?: just| now)? (?:filed|logged|submitted)\b(?!(?: (?:it|this|that) to the (?:Homeroom )?team| (?:a|an|the|your|that|this|my) (?:\w+ ){0,2}(?:report|problem)))|\bI(?:'ve| have)?(?: just| now)? (?:opened|created|added) (?:a |an |the |that |this |your )?(?:new )?(?:request|issue)\b/i,
    turn: () => false,
    // A filing card done here, a server note that filed it, their own
    // requester row, or a report the bot filed for them.
    standing: (s, m) => {
      if (s.earlier('filed', m)) return true;
      const filedOne = (n) => has(s.filedNumbers, n) || has(s.requesters, n) || has(s.reportNumbers, n);
      if (m.numbers.length) {
        if (m.numbers.some(filedOne)) return true;
      } else if (s.filedAny || (m.near || []).some(filedOne)) return true;
      return s.unsure('filed') ? null : false;
    },
    said: 'says a request was filed',
  },
  {
    kind: 'drafted',
    proof: 'records',
    // #4605: "A File it button will appear under this message", "tap File
    // it", "you'll see File it below", "I've drafted the request". A draft
    // exists only when an offer made one this turn, or when one is still open
    // in this conversation or thread.
    re: /\bFile it\b[^.!?\n]{0,80}\b(?:appear|show(?:s|n)? up|below|under (?:this|my|the|that) (?:message|reply))|\b(?:tap|press|click|hit|use)\s+(?:the\s+)?\**["“]?File it\b|\b(?:you(?:'ll| will| should)? see|there(?:'s| is| will be))\b[^.!?\n]{0,60}\bFile it\b|\bI(?:'ve| have)?(?: just| now)? (?:drafted|prepared|written up|put together)\b[^.!?\n]{0,60}\b(?:request|draft)\b|\b(?:draft|drafted request)\b[^.!?\n]{0,40}\b(?:below|under (?:this|my|the) (?:message|reply))\b/i,
    // #6682: only a draft offer has File it. A plan card (New request, Add to
    // an existing request) and a new project's card (Make the project) do not.
    turn: (t) => !!t.offer && t.offer.kind !== 'plan' && t.offer.kind !== 'project',
    standing: (s, m) => {
      if (s.openDraft) return true;
      if (s.earlier('drafted', m)) return true;
      return s.unsure('drafted') ? null : false;
    },
    said: 'says a drafted request with File it is under it',
  },
  {
    // #6763: "Tap New project under this reply" when no New project is
    // showing. The button is the chat's to offer, so only a turn that carries
    // the flag can be checked here (the design bot's turn does not).
    kind: 'new_project',
    proof: 'turn',
    re: NEW_PROJECT_CLAIM,
    applies: (t) => 'newProjectOffer' in t,
    turn: (t) => newProjectDoorShown(t),
    said: 'points at a New project button under it',
  },
  {
    // #6682: the wrong card described as the right one. A design thread's
    // plan card files only the design; words saying it files some other
    // request (or files on another project) are shown false and cut.
    kind: 'plan_card_other',
    proof: 'turn',
    re: /\b(?:cards?|new request|file it|plans?|files?|posts?|opens?|makes?|taps?|press(?:es)?|clicks?|requests?)\b/i,
    applies: (t) => t.offer?.kind === 'plan',
    when: (sentence, t) => planCardOther(sentence, {
      appName: t.offer?.app?.name, appSlug: t.offer?.app?.slug, title: t.designTitle,
    }),
    turn: () => false,
    said: 'says the plan card files a request it does not file',
  },
  {
    kind: 'posted',
    proof: 'records',
    re: /\bI(?:'ve| have)?(?: just| now)? (?:posted|added|put|passed|left|sent|shared)\b[^.!?\n]{0,80}\b(?:discussion|comment|request|proposal|board|issue|thread)\b/i,
    // P8: pictures put under this reply. P5: a note sent to a running build.
    // A change queued this turn is on its way to the change. A version a
    // design turn made is in its thread.
    turn: (t) => !!(t.revised || t.pictures || t.steered || t.drew),
    // A server note that says so; in a request's or a change's own thread,
    // that thread's history: the bot's posts on the request, an ask
    // recorded on its change. Elsewhere (Main, a private thread) the bot
    // posts nothing but by a tap, which leaves its note.
    standing: (s, m) => {
      if (s.earlier('posted', m)) return true;
      if (s.inThread) {
        if (s.about(m).some((n) => has(s.postNumbers, n) || has(s.askNumbers, n)) || s.scopeAsks) return true;
      }
      return s.unsure('posted') ? null : false;
    },
    said: 'says something was posted',
  },
  {
    // #6534: a reply that says pictures, shots or a design are posted, when
    // nothing was stored under it. In a project's thread only what was stored
    // as an attachment counts; in the bot's own chat the gallery card does.
    kind: 'posted_pictures',
    proof: 'turn',
    re: /\bhere (?:are|is) the (?:pictures|shots|stills|designs?)\b|\bI(?:'ve| have)(?: just| now)? (?:attached|posted|added|put up) (?:the |your |two |three |four )?(?:pictures?|shots?|stills|designs?|before and after)\b|\battached below\b/i,
    turn: (t) => !!(t.attached?.length || (!t.place && t.pictures?.made) || t.drew),
    said: 'says pictures or an artifact were posted',
  },
  {
    kind: 'started',
    proof: 'records',
    re: /\bI(?:'m| am)\s+(?:now\s+)?(?:starting|working on (?:it|that|this|#\d+)|building (?:it|that|this|#\d+)|on it)\b|\bI(?:'ve| have)\s+started\b|\bI(?:'ll| will) (?:start(?: on)?|look at|pick up) (?:it|that|this|#\d+) (?:now|right away|right now)\b/i,
    // P4: a batch queued this turn (work_through).
    turn: (t) => !!(t.started || t.revised || t.workBusy || t.batchQueued),
    // A request whose stored work state is anything but waiting for them,
    // stopped or closed is in the bot's hands.
    standing: (s, m) => {
      if (s.earlier('started', m)) return true;
      const numbers = s.about(m);
      if (numbers.length) {
        const stages = numbers.map((n) => s.stages.get(Number(n))).filter(Boolean);
        if (stages.some((stage) => !NOT_STARTED_STAGES.has(stage))) return true;
        if (stages.length) return false;
        return null;
      }
      if (s.theirBusy === true) return true;
      if (s.theirBusy === false) return false;
      return null;
    },
    said: 'says you started work on something',
  },
  {
    kind: 'revised',
    proof: 'records',
    re: /\bI(?:'ve| have)?(?: just| now)? (?:revised|changed|updated|reworked) (?:the |your |its |that |this )?(?:proposal|it)\b/i,
    // #6263: a description reworded this turn; a revision request_detail found.
    turn: (t) => !!(t.recentRevision || t.described),
    // An ask on the change that a follow-up made.
    standing: (s, m) => {
      if (s.earlier('revised', m)) return true;
      if (s.about(m).some((n) => has(s.doneAskNumbers, n)) || s.scopeDoneAsks) return true;
      return s.unsure('revised') ? null : false;
    },
    said: 'says a proposal was changed',
  },
  {
    kind: 'withdrew',
    proof: 'records',
    // "I withdrew / closed the duplicate proposal", "the proposal has been
    // withdrawn". #6566: a bare passive is about anything ("the window has
    // been withdrawn"); only one that names a proposal, PR or #N counts.
    re: /\bI(?:'ve| have)?(?: just| now| already)? (?:withdrawn|withdrew|closed|cancell?ed|taken down|took down) (?:the |your |its |that |this |my |both |one of the |a )?(?:duplicate |extra |second |other |old |older )?(?:proposals?|duplicates?|PRs?|pull requests?)\b|\b(?:(?:the|your|this|that|my|its) )?(?:duplicate )?(?:proposals?|PRs?|pull requests?)\s+(?:(?:has|have) been|was) withdrawn\b|(?<![\w#&/])#\d+\s+(?:(?:has|have) been|was) withdrawn\b/i,
    turn: (t) => !!t.withdrew,
    standing: (s, m) => {
      if (s.earlier('withdrew', m) || s.withdrawn) return true;
      return s.unsure('withdrew') ? null : false;
    },
    said: 'says a proposal was withdrawn',
  },
  {
    kind: 'moved',
    proof: 'never',
    // #4239: a request is moved only by its Move it to Homeroom tap. #6583:
    // "it was moved" is a fact about the request (moved_status); only "I
    // moved it" is a claim of an action the bot never takes.
    re: /\bI(?:'ve| have)?(?: just| now| already)? moved (?:it|this|that|the request|your request|#\d+)\b/i,
    turn: () => false,
    said: 'says a request was moved',
  },
  {
    kind: 'moved_status',
    proof: 'records',
    // #6583: a passive sentence about a request being moved is checked
    // against the request (a Move it to Homeroom card done: its original
    // number, or the new one on Homeroom's board).
    re: /(?:\b(?:the|your|this|that) request(?: #\d+)?|(?<![\w#&/])#\d+)\s+(?:(?:has|have) been|was) moved\b/i,
    turn: () => false,
    standing: (s, m) => statusOf(s, m, s.moved, 'moved_status'),
    said: 'says a request was moved',
  },
  {
    kind: 'closed_request',
    proof: 'never',
    // #4525: a request closes only when its group votes for it, so the bot
    // never closes one. #6583: only "I closed it" is here; the passive fact
    // is `closed_status` below.
    re: /\bI(?:'ve| have)?(?: just| now| already)? closed (?:it|this|that|the request|your request|#\d+)\b/i,
    turn: () => false,
    said: 'says a request was closed',
  },
  {
    kind: 'closed_status',
    proof: 'records',
    // #6583: "Request #14 is closed" is a fact to check against the request.
    // (A bare "#14" is matched by what may not come before it: no word
    // boundary sits before "#" after a space, so `\b#14` never matched.)
    re: /(?:\b(?:the|your|this|that) request(?: #\d+)?|(?<![\w#&/])#\d+)\s+(?:(?:has|have) been|was|is (?:now )?)\s*closed\b/i,
    turn: () => false,
    standing: (s, m) => statusOf(s, m, s.closed, 'closed_status'),
    said: 'says a request was closed',
  },
  {
    kind: 'reported',
    proof: 'records',
    // "I've told the team", "I've reported it to the admins", "the team has
    // been told".
    re: /\bI(?:'ve| have)?(?: just| now| already)? (?:told|let|notified|alerted|informed|reported (?:it |this |that )?to|passed (?:it |this |that )?(?:on |along )?to|sent (?:it |this |that |a report |your report )?to|raised (?:it |this |that )?with|flagged (?:it |this |that )?(?:to|with|for)) (?:the )?(?:Homeroom )?(?:team|admins?|developers?|devs|staff)\b|\bI(?:'ve| have)?(?: just| now)? (?:filed|sent|made|submitted) (?:a|your|the) (?:bug |problem )?report\b|\bthe (?:Homeroom )?(?:team|admins?|developers?)(?: has| have|'s)? (?:been |now )?(?:told|notified|alerted|informed|made aware)\b/i,
    turn: (t) => !!t.reported,
    // A report on file for them by the number named, or one filed from this
    // conversation.
    standing: (s, m) => {
      if (s.earlier('reported', m)) return true;
      if (m.numbers.length) {
        if (m.numbers.some((n) => has(s.reportNumbers, n))) return true;
      } else if (s.reportHere || (m.near || []).some((n) => has(s.reportNumbers, n))) return true;
      return s.unsure('reported') ? null : false;
    },
    said: 'says the team was told',
  },
  {
    kind: 'drawing',
    proof: 'turn',
    re: DRAWING_CLAIM,
    // A design thread (or a turn that started one, step 6): a version, an
    // offer or a card made this turn.
    turn: (t) => !!t.drew,
    said: 'says you are drawing a screen',
  },
  {
    kind: 'promised',
    proof: 'turn',
    // "I'll look into it", "I'll follow up", "let me sort that out", "I'll
    // get back to you": nothing brings the bot back to it later.
    re: /\b(?:I(?:'ll| will|'m going to| am going to)|let me|we(?:'ll| will))\s+(?:(?:now|also|then|definitely|personally|quickly|go and|try to|make sure to|be sure to)\s+)*(?:follow(?:ing)?[ -]up|look(?:ing)? into|sort(?:ing)? (?:\w+ ){0,2}out|investigate|dig into|get back to|check into|chase (?:\w+ ){0,2}up|escalate)\b/i,
    // P3: a look this turn started that is still running posts what it finds
    // here. P4, P5: a batch's reads, a note sent to a build.
    turn: (t) => !!(t.revised || t.started || t.withdrew || t.reported || t.lookRunning
      || t.batchQueued || t.steered || t.followedUp),
    said: 'promises to come back to something later',
  },
  {
    kind: 'report_back',
    proof: 'turn',
    // P3: "I'll post what I find here", "I'll report back": only a look this
    // turn started, still running, posts anything here later. #6264: a
    // promise stored by tell_me_when is kept by the change's own moment.
    re: /\b(?:I(?:'ll| will|'m going to| am going to)|we(?:'ll| will))\s+(?:(?:then|also|soon|just)\s+)?(?:post|share|send|report|tell you|let you know|come back|update you|write)\b[^.!?\n]{0,60}?(?:\bwhat (?:I|it|they|we|the helper) (?:finds?|turns? up|comes? up)\b|\b(?:the |my |its )?findings\b|\b(?:the |its )?results?\b|\bback\b|\bwhen (?:it|I|the look|the helper)(?:'s| is|'m| am)? (?:done|finished|back)\b)/i,
    turn: (t) => !!(t.lookRunning || t.followedUp || t.started || t.batchQueued),
    said: 'says it will post findings here later',
  },
  {
    kind: 'design_done',
    proof: 'turn',
    re: DESIGN_DONE,
    applies: (t) => !!t.design,
    turn: (t) => !!t.drew,
    said: 'says you changed or drew the artifact',
  },
  {
    // Artifacts, stage 2: a thread's plain page (artifact-session.js), said
    // to be written or changed with nothing written or changed this turn.
    kind: 'page_done',
    proof: 'turn',
    re: PAGE_DONE,
    applies: (t) => !!t.page,
    turn: (t) => !!t.drew,
    said: 'says you wrote or changed the page',
  },
  {
    // Step 6 (#6864, 6): a live draft's change, said with none saved.
    kind: 'draft_done',
    proof: 'turn',
    re: DRAFT_DONE,
    applies: (t) => !!t.liveDraft,
    turn: (t) => !!t.draftSaved,
    said: 'says you changed or saved the draft',
  },
  {
    // A (live-draft review): how the preview looks now, or that it is
    // fixed, said with no look at it since the turn's last save. The app
    // running again is what the apply itself said, and is no such claim.
    kind: 'draft_looks',
    proof: 'turn',
    re: DRAFT_LOOKS,
    applies: (t) => !!t.liveDraft,
    when: (sentence) => !DRAFT_NOT_LOOKS.test(sentence),
    turn: (t) => !!t.draftLooked,
    said: 'says it is fixed or how the preview looks now, without looking at it since your last save',
  },
  {
    // 24 Nov 2026: asks them to prompt again for the preview, or promises a
    // look or a line later, when nothing is set to post one (DRAFT_LATER).
    kind: 'draft_later',
    proof: 'turn',
    re: DRAFT_LATER,
    applies: (t) => !!t.liveDraft,
    when: (sentence, t) => DRAFT_ASK_AGAIN.test(sentence) || !t.draftFollowup,
    turn: () => false,
    said: 'asks them to tell you when the preview is up or to ask again, or promises a look or a line later that nothing is set to do',
  },
  {
    // 20 Nov 2026 (live-draft review, C): an offer or a promise to change a
    // proposal that nothing in this turn can change (proposalOfferUnbacked).
    // Only the chat carries the facts (proposalTaps); its buttons are checked
    // by the same rule (checkReply `buttons`, keptButtons).
    kind: 'proposal_action',
    proof: 'turn',
    re: PROPOSAL_OFFER,
    applies: (t) => !!t.proposalTaps,
    when: (sentence, t) => proposalOfferUnbacked(sentence, t),
    turn: () => false,
    said: 'offers or promises to change a proposal that nothing you can do here changes',
  },
  {
    kind: 'not_built',
    proof: 'turn',
    re: NOT_BUILT,
    // #6151: only on a filed design Homeroom bot builds (design-bot.js
    // filedBuilds). Where a person must decide, saying so is the truth.
    applies: (t) => !!t.design && !!t.filedDesign,
    turn: (t) => !t.designBuilds,
    said: 'says this filed artifact will not be built, or that someone else has to start it',
  },
  {
    kind: 'unread_description',
    proof: 'turn',
    re: UNREAD_DESCRIPTION_RE,
    // #6263: the voice tracks the changes a turn read (get_change).
    applies: (t) => t.readChanges instanceof Set || Array.isArray(t.readChanges),
    turn: (t) => (t.readChanges instanceof Set ? t.readChanges.size : t.readChanges.length) > 0,
    said: 'describes what a change\'s description says without reading it in this turn',
  },
  {
    // 20 Nov 2026 (live-draft review, E): "I looked it up", "I researched",
    // with no web search run this turn. Only on the chat, which counts its
    // searches (homeroom-bot-mayor.js `webSearched`), switched on or off.
    kind: 'searched',
    proof: 'turn',
    re: SEARCHED_CLAIM,
    applies: (t) => Number.isInteger(t.webSearched),
    when: (sentence) => claimsSearch(sentence),
    turn: (t) => t.webSearched > 0,
    said: 'says you looked it up, searched the web or researched it',
  },
]);

const BY_KIND = new Map(CLAIMS.map((c) => [c.kind, c]));

/**
 * A status sentence (closed, moved) against the request it names. With no
 * number it can only be checked in a request's own thread; elsewhere it is
 * a fact the reply may state, and is kept.
 */
function statusOf(s, m, set, kind) {
  const named = m.numbers.length ? m.numbers : s.threadNumbers.slice(0, 1);
  if (!named.length) return true;
  if (named.every((n) => has(set, n))) return true;
  return s.unsure(kind) ? null : false;
}

// ── What a reply mentions ─────────────────────────────────────────────────

/**
 * Pure (#6682): does `sentence` say the card (or New request) files a request
 * other than this design's plan? True when it describes the card's request in
 * words of its own ("the drawing-rule request", "a request about drawing"),
 * or names a project other than the card's as where it files. A sentence that
 * names the design's own title is about this design, never another request.
 */
function planCardOther(sentence, { appName = '', appSlug = '', title = '' } = {}) {
  const text = String(sentence || '');
  if (!text) return false;
  const design = squashWords(title);
  if (design.length > 3 && squashWords(text).includes(design)) return false;
  const subject = /\b(?:the|this|that)\s+(?:plan\s+)?card\b|\bnew request\b|\bthe button\b|\b(?:tap|tapping|press|pressing|click|clicking|hit|hitting)\b/i;
  const verb = /\b(?:files?|filing|posts?|posting|opens?|opening|makes?|making|sends?|sending|puts?|putting|creates?|creating)\b/i;
  if (!subject.test(text) || !verb.test(text)) return false;
  // A request described by its own words: "the drawing-rule request", "a
  // request about drawing". "the new request" and "the plan" are the card's.
  if (/\bthe\s+(?:(?!new\b|plan\b|request\b)[\w'’&.-]+\s+){1,5}requests?\b/i.test(text)) return true;
  if (/\ba request\s+(?:about|for|to|that)\b/i.test(text)) return true;
  // Where it says it files: a project other than the card's.
  const own = new Set([squashWords(appName), squashWords(appSlug)].filter(Boolean));
  for (const m of text.matchAll(/\b(?:files?|posts?|opens?|makes?|sends?|puts?|creates?)\b[^.!?\n]{0,60}?\b(?:on|to)\s+(?:"([^"]{2,60})"|([A-Z][\w'’&.-]*(?:\s+[A-Z0-9][\w'’&.-]*){0,5}))/g)) {
    const named = squashWords(m[1] || m[2]);
    if (named && !own.has(named)) return true;
  }
  return false;
}

/**
 * #6566: the receipt a report's own reply may carry ("Filed as #6564 in
 * Homeroom's Workshop"), accepted only for the number this turn filed.
 */
function receiptPhrases(ctx) {
  const number = Number(ctx?.reported?.number);
  if (!Number.isInteger(number) || number <= 0) return null;
  // "in Homeroom's Workshop" is what it says now (the chat's own naming
  // rule: never a "board"); the older wording is still what a reply written
  // from an earlier message of the thread may repeat.
  return new RegExp(`(?:Already )?[Ff]iled as #${number} (?:in Homeroom['’]s Workshop|on Homeroom['’]s requests board)`, 'i');
}

/**
 * Pure: what `text` claims, read as it would be sent. Each claim it makes,
 * sentence by sentence ({ kind, sentence, numbers, near }), every request number
 * it names, and the project names it gives. `receipt` (receiptPhrases) is a
 * sentence known true, blanked before the claims are read.
 */
function mentions(text, { receipt = null } = {}) {
  const body = cleanReply(text);
  if (!body) return { body: '', claims: [], numbers: [], projects: [] };
  const claimBody = receipt ? body.replace(receipt, ' ') : body;
  const pieces = sentences(claimBody);
  const numbers = requestNumbers(body);
  const claims = [];
  for (const claim of CLAIMS) {
    if (!claim.re.test(claimBody)) continue;
    const said = pieces.filter((sentence) => claim.re.test(sentence));
    for (const sentence of said.length ? said : [claimBody]) {
      // `near`: the reply's own numbers, what "it" in a sentence naming none
      // ("I'll look at it now") is about.
      claims.push({ kind: claim.kind, sentence, numbers: requestNumbers(sentence), near: numbers });
    }
  }
  return { body, claims, numbers, projects: projectMentions(body) };
}

// The flags of what a turn did, which back a claim with no read, are read
// off the surface's own turn context: offer, started, workBusy, batchQueued,
// revised, recentRevision, described, withdrew, reported, lookRunning,
// followedUp, steered, pictures, attached, closedThread; and, on
// a design thread, design, drew, filedDesign, designBuilds; in a plain
// page's thread (artifacts), page, drew; with a live draft
// open (step 6), liveDraft, draftSaved, draftLooked, draftFollowup (24 Nov 2026); on the voice,
// readChanges; on the chat (E, 20 Nov 2026), webSearched.

// ── What a turn's tools returned ──────────────────────────────────────────

/** Note a project a tool returned this turn, so a reply naming another one is caught. */
function noteKnownProjects(ctx, result) {
  if (!ctx || !result || typeof result !== 'object' || result.error) return;
  if (!ctx.knownProjects) ctx.knownProjects = new Set();
  const add = (name, slug) => {
    for (const value of [name, slug]) {
      const key = squashWords(value);
      if (key) ctx.knownProjects.add(key);
    }
  };
  add(result.projectName, result.project);
  if (result.app && typeof result.app === 'object') add(result.app.name, result.app.slug);
  for (const p of Array.isArray(result.projects) ? result.projects : []) {
    if (p && typeof p === 'object') add(p.projectName || p.name, p.project || p.slug);
  }
}

/**
 * #6581: note every request number a tool returned this turn (request_detail,
 * list_requests, get_request, my_work, my_projects, progress), so a reply
 * naming one is not called unknown. Platform tools included: their results
 * are plain JSON with the number in it.
 */
function noteKnownRequests(ctx, result) {
  if (!ctx || !result || typeof result !== 'object' || result.error) return;
  if (!ctx.knownRequests) ctx.knownRequests = new Set();
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 6) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const key of ['number', 'issueNumber']) {
      const n = Number(value[key]);
      if (Number.isInteger(n) && n > 0) ctx.knownRequests.add(n);
    }
    for (const item of Object.values(value)) {
      // A platform tool's answer is JSON text ({ result }).
      if (typeof item === 'string' && /^\s*[[{]/.test(item)) {
        try {
          walk(JSON.parse(item), depth + 1);
          continue;
        } catch { /* not JSON: nothing to read */ }
      }
      walk(item, depth + 1);
    }
  };
  walk(result, 0);
}

/** What a tool returned this turn: the requests and projects a reply may then name. Every surface calls it on every result. */
function noteTool(ctx, result) {
  noteKnownRequests(ctx, result);
  noteKnownProjects(ctx, result);
}

/** The request numbers this turn already knows are real: returned, read, or filed by it. */
function knownNumbers(ctx) {
  const known = new Set([...(ctx?.knownRequests || []), ...(ctx?.seenRequests?.keys?.() || []), ...(ctx?.threadKnown || [])]);
  const filed = Number(ctx?.reported?.number);
  if (Number.isInteger(filed) && filed > 0) known.add(filed);
  return new Set([...known].map(Number));
}

// ── The stored records ────────────────────────────────────────────────────

// The server's own notes in a conversation (metadata.homeroomBot.kind):
// what a tap or a filing said, never the model's words.
const SERVER_NOTE_KINDS = Object.freeze(['filed', 'closing', 'withdrawn', 'design_filed']);
const SERVER_NOTES_SQL = `
  SELECT content, metadata->'homeroomBot'->>'kind' AS kind, metadata->'homeroomBot'->>'issueNumber' AS issue_number
    FROM conversation_messages
   WHERE conversation_id = $1 AND sender_id = $2 AND deleted_at IS NULL
     AND metadata->'homeroomBot'->>'kind' = ANY($3::text[])
   ORDER BY id DESC
   LIMIT 40`;

// The bot's cards where the reply is said: its conversation, or a project's
// thread (a request's, a change's, a topic's, a reply thread) or main chat.
const CARDS_SQL = `
  SELECT a.kind, a.status, a.issue_number, a.source_issue_number FROM bot_cards a WHERE a.kind IN ('file_request', 'move_request', 'withdraw_proposal', 'withdraw_change')
     AND (
       ($2::int IS NOT NULL AND a.place = 'dm' AND a.user_id = $1 AND a.conversation_id = $2)
       OR ($2::int IS NULL AND $3::int IS NOT NULL AND a.place = 'thread' AND a.app_id = $3
           AND ($1::int IS NULL OR a.user_id IS NULL OR a.user_id = $1)
           AND EXISTS (SELECT 1 FROM chat_messages cm
                        WHERE cm.id = a.chat_message_id
                          AND (($4::text IS NULL AND cm.thread_type IS NULL)
                               OR (cm.thread_type = $4::text AND cm.thread_ref = $5::int))))
     )`;

// A request moved anywhere, by its original number on its project or by the
// one it has on Homeroom's board now (homeroom-bot-move.js decideMove).
const MOVES_SQL = `
  SELECT a.kind, a.status, a.issue_number, a.source_issue_number FROM bot_cards a WHERE a.kind = 'move_request' AND a.status = 'done'
     AND ((a.source_issue_number = ANY($1::int[]) AND (cardinality($2::int[]) = 0 OR a.app_id = ANY($2::int[])))
          OR a.issue_number = ANY($1::int[]))`;

const REQUESTERS_SQL = 'SELECT issue_number FROM homeroom_bot_requesters WHERE user_id = $1 AND issue_number = ANY($2::int[])';

const CLOSED_SQL = `
  SELECT github_issue_number AS n FROM issues
   WHERE kind = 'general' AND status = 'closed'
     AND (cardinality($1::int[]) = 0 OR app_id = ANY($1::int[])) AND github_issue_number = ANY($2::int[])
  UNION
  SELECT issue_number AS n FROM homeroom_bot_closed_requests
   WHERE closed_at IS NOT NULL
     AND (cardinality($1::int[]) = 0 OR app_id = ANY($1::int[])) AND issue_number = ANY($2::int[])`;

// Named reports, or (with $3) one filed from this conversation.
const REPORTS_SQL = `SELECT issue_number, created_at FROM feedback_reports
   WHERE user_id = $1 AND (issue_number = ANY($2::int[]) OR ($3::int IS NOT NULL AND conversation_id = $3))`;

// The stored stage of named requests: on the projects this turn touched, or,
// with none, among the person's own.
const STAGES_SQL = `
  SELECT item_ref AS issue_number, stage FROM work_states
   WHERE item_kind = 'request' AND item_ref = ANY($2::int[])
     AND (app_id = ANY($1::int[]) OR (cardinality($1::int[]) = 0 AND requester_id = $3))`;

// Whether any request of theirs is in the bot's hands now.
const THEIR_STAGES_SQL = `
  SELECT stage FROM work_states
   WHERE requester_id = $1 AND item_kind = 'request' AND NOT (stage = ANY($2::text[]))
   LIMIT 1`;

const POSTS_SQL = `
  SELECT issue_number FROM homeroom_bot_posts
   WHERE (cardinality($1::int[]) = 0 OR app_id = ANY($1::int[])) AND issue_number = ANY($2::int[]) AND pending IS NOT TRUE`;

const ASKS_SQL = `
  SELECT session_id, issue_number, status FROM homeroom_bot_change_asks
   WHERE session_id = ANY($1::int[])
      OR ((cardinality($2::int[]) = 0 OR app_id = ANY($2::int[])) AND issue_number = ANY($3::int[]))`;

// What each kind reads.
const READS = Object.freeze({
  filed: ['notes', 'cards', 'requesters', 'reports'],
  drafted: ['notes', 'cards'],
  posted: ['notes', 'posts', 'asks'],
  started: ['notes', 'stages'],
  revised: ['notes', 'asks'],
  withdrew: ['notes', 'cards'],
  moved_status: ['cards', 'moves'],
  closed_status: ['closed'],
  reported: ['notes', 'reports'],
});

const ids = (list) => [...new Set((list || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

/** The requests the place itself is about: a request's thread, or the requests a change is for. */
function threadNumbersOf(ctx) {
  const place = ctx?.place || null;
  return ids([
    ...(place?.type === 'issue' ? [place.ref] : []),
    ...(Array.isArray(ctx?.change?.linked_issues) ? ctx.change.linked_issues : []),
    ...(Array.isArray(ctx?.requestChange?.linked_issues) ? ctx.requestChange.linked_issues : []),
  ]);
}

/** Where a place's thread messages live, for its cards: [threadType, threadRef]. */
function threadOf(place) {
  if (!place) return [null, null];
  if (['issue', 'message', 'category', 'session'].includes(place.type)) return [place.type, Number(place.ref) || null];
  // A project's main chat.
  return [null, null];
}

/** The bot's server notes in a conversation: the text and kinds of what it did there. */
async function serverNotes(pool, ctx) {
  if (typeof ctx?.earlierBotText === 'string') return { text: ctx.earlierBotText, notes: [] };
  const conversationId = Number(ctx?.conversationId);
  const botId = Number(ctx?.bot?.id);
  if (!(conversationId > 0) || !(botId > 0)) return { text: '', notes: [] };
  const { rows } = await pool.query(SERVER_NOTES_SQL, [conversationId, botId, [...SERVER_NOTE_KINDS]]);
  const notes = rows.filter((r) => SERVER_NOTE_KINDS.includes(r?.kind))
    .map((r) => ({ kind: r.kind, content: String(r.content || ''), issueNumber: Number(r.issue_number) || null }));
  return { text: notes.map((n) => n.content).join('\n'), notes };
}

/**
 * What the stored records say about a reply's claims, read once per check.
 * `scope` is the turn's context (user, bot, conversationId, app, place,
 * appIds, change, requestChange, deps); `wanted` the kinds and numbers its
 * claims need. A read that fails marks only the kinds that need it as
 * unsure: their sentences are kept.
 */
async function loadStanding(pool, scope, { kinds = new Set(), numbers = [] } = {}) {
  const ctx = scope || {};
  const reads = new Set();
  for (const kind of kinds) for (const r of READS[kind] || []) reads.add(r);
  const failed = new Set();
  const threadNumbers = threadNumbersOf(ctx);
  const asked = ids([...numbers, ...threadNumbers]);
  const appIds = ids([...(ctx.appIds || []), ctx.app?.id, ctx.place?.appId]);
  const userId = Number(ctx.user?.id) || null;
  const conversationId = Number(ctx.conversationId) || null;
  const s = {
    threadNumbers,
    filedNumbers: new Set(), filedAny: false, openDraft: false, withdrawn: false,
    requesters: new Set(), reportNumbers: new Set(), reportHere: false,
    moved: new Set(), closed: new Set(), stages: new Map(), theirBusy: null,
    postNumbers: new Set(), askNumbers: new Set(), doneAskNumbers: new Set(), scopeAsks: false, scopeDoneAsks: false,
    earlierText: '', earlierNumbers: new Set(),
  };
  const read = async (what, fn) => {
    if (!reads.has(what)) return;
    try {
      await fn();
    } catch (err) {
      failed.add(what);
      log.warn('reply-claims', `Could not read the records for a reply's claims (${what})`, { err: err?.message || String(err) });
    }
  };
  const addNumbersFrom = (set, rows, key = 'issue_number') => {
    for (const row of rows || []) {
      const n = Number(row?.[key]);
      if (Number.isInteger(n) && n > 0) set.add(n);
    }
  };

  await read('notes', async () => {
    const { text, notes } = await serverNotes(pool, ctx);
    s.earlierText = text;
    s.earlierNumbers = new Set(requestNumbers(text));
    for (const note of notes) {
      if (note.kind === 'filed' || note.kind === 'design_filed') {
        s.filedAny = true;
        if (note.issueNumber) s.filedNumbers.add(note.issueNumber);
        for (const n of requestNumbers(note.content)) s.filedNumbers.add(n);
      }
      if (note.kind === 'withdrawn') s.withdrawn = true;
    }
  });
  await read('cards', async () => {
    const [threadType, threadRef] = threadOf(ctx.place);
    const appId = Number(ctx.app?.id || ctx.place?.appId) || null;
    if (!conversationId && !(appId && ctx.place)) return;
    const { rows } = await pool.query(CARDS_SQL, [userId, conversationId, conversationId ? null : appId, threadType, threadRef]);
    for (const row of rows || []) {
      const n = Number(row?.issue_number);
      if (row?.kind === 'file_request' && row.status === 'open') s.openDraft = true;
      if (row?.kind === 'file_request' && row.status === 'done' && n > 0) { s.filedAny = true; s.filedNumbers.add(n); }
      if (row?.kind === 'move_request' && row.status === 'done') {
        for (const m of [n, Number(row.source_issue_number)]) if (m > 0) s.moved.add(m);
      }
      if ((row?.kind === 'withdraw_proposal' || row?.kind === 'withdraw_change') && row.status === 'done') s.withdrawn = true;
    }
  });
  if (asked.length) {
    await read('moves', async () => {
      const { rows } = await pool.query(MOVES_SQL, [asked, appIds]);
      for (const row of rows || []) {
        if (row?.kind !== 'move_request' || row.status !== 'done') continue;
        for (const m of [Number(row.issue_number), Number(row.source_issue_number)]) if (m > 0) s.moved.add(m);
      }
    });
    await read('closed', async () => {
      const { rows } = await pool.query(CLOSED_SQL, [appIds, asked]);
      addNumbersFrom(s.closed, rows, 'n');
    });
    await read('posts', async () => {
      const { rows } = await pool.query(POSTS_SQL, [appIds, asked]);
      addNumbersFrom(s.postNumbers, rows);
    });
    await read('stages', async () => {
      // A caller that reads requests through their tracks (homeroom-bot-track.js) passes its module.
      const track = ctx.deps?.track;
      const trackApp = Number(ctx.app?.id) || appIds[0];
      if (track?.tracksForRequests && trackApp) {
        const tracks = await track.tracksForRequests(pool, { appId: trackApp, numbers: asked, deps: ctx.deps || {} });
        for (const [n, t] of tracks || []) if (t?.work?.stage) s.stages.set(Number(n), t.work.stage);
        return;
      }
      const { rows } = await pool.query(STAGES_SQL, [appIds, asked, userId]);
      for (const row of rows || []) {
        const n = Number(row?.issue_number);
        if (n > 0 && typeof row.stage === 'string') s.stages.set(n, row.stage);
      }
    });
  }
  if (userId && numbers.length) {
    await read('requesters', async () => {
      const { rows } = await pool.query(REQUESTERS_SQL, [userId, ids(numbers)]);
      addNumbersFrom(s.requesters, rows);
    });
  }
  if (userId && (numbers.length || conversationId)) {
    await read('reports', async () => {
      const named = ids(numbers);
      const { rows } = await pool.query(REPORTS_SQL, [userId, named, conversationId]);
      const wanted = new Set(named);
      for (const row of rows || []) {
        const n = Number(row?.issue_number);
        if (n > 0 && wanted.has(n)) s.reportNumbers.add(n);
        // Any other row was filed from this conversation.
        else if (row && (n > 0 || row.created_at)) s.reportHere = true;
      }
    });
  }
  if (userId && !asked.length) {
    await read('stages', async () => {
      const { rows } = await pool.query(THEIR_STAGES_SQL, [userId, [...NOT_STARTED_STAGES]]);
      s.theirBusy = (rows || []).some((row) => typeof row?.stage === 'string' && !NOT_STARTED_STAGES.has(row.stage));
    });
  }
  const sessions = ids([ctx.change?.id, ctx.requestChange?.id]);
  if (sessions.length || asked.length) {
    await read('asks', async () => {
      const { rows } = await pool.query(ASKS_SQL, [sessions, appIds, asked]);
      const inScope = new Set(sessions);
      for (const row of rows || []) {
        const n = Number(row?.issue_number);
        const session = Number(row?.session_id);
        if (!(n > 0) && !(session > 0)) continue;
        if (n > 0) s.askNumbers.add(n);
        if (inScope.has(session)) s.scopeAsks = true;
        if (row.status === 'done') {
          if (n > 0) s.doneAskNumbers.add(n);
          if (inScope.has(session)) s.scopeDoneAsks = true;
        }
      }
    });
  }

  // Which reads a kind's answer depends on, and whether any failed.
  s.unsure = (kind) => (READS[kind] || []).some((r) => failed.has(r));
  // The numbers a claim is about: its own, else the place's, else the
  // reply's (what "it" is about).
  s.about = (m) => (m.numbers.length ? m.numbers : s.threadNumbers.length ? s.threadNumbers : (m.near || []));
  // A request's or a change's own thread, whose history the bot's posts are.
  s.inThread = ctx.place?.type === 'issue' || ctx.place?.type === 'session';
  // #6583: an earlier server note says the same kind of thing, about the
  // same request when this sentence names one.
  s.earlier = (kind, m) => {
    if (!s.earlierText) return false;
    const claim = BY_KIND.get(kind);
    if (!claim || !claim.re.test(s.earlierText)) return false;
    return !m.numbers.length || m.numbers.some((n) => s.earlierNumbers.has(Number(n)));
  };
  s.failed = failed;
  return s;
}

// ── Checking ──────────────────────────────────────────────────────────────

/**
 * Pure: the claims among `found` (mentions(...).claims, or its result) that
 * are shown false, one problem per kind in CLAIMS order: { kind, said,
 * proof, numbers, all }. `numbers` are the requests named by the sentences
 * shown false, `all` that one of them named none (so every sentence of the
 * kind goes). A claim this turn backs, or one the standing cannot tell
 * (null, or no standing read), is no problem.
 */
function check(found, { standing = null, turn = {} } = {}) {
  const list = Array.isArray(found) ? found : (found?.claims || []);
  const bad = new Map();
  for (const m of list) {
    const claim = BY_KIND.get(m.kind);
    if (!claim) continue;
    if (claim.applies && !claim.applies(turn)) continue;
    if (claim.when && !claim.when(m.sentence, turn)) continue;
    if (claim.turn(turn)) continue;
    if (claim.proof === 'records') {
      if (!standing) continue;
      if (claim.standing(standing, { ...m, numbers: m.numbers || [] }) !== false) continue;
    }
    const at = bad.get(m.kind) || { numbers: new Set(), all: false };
    if ((m.numbers || []).length) for (const n of m.numbers) at.numbers.add(Number(n));
    else at.all = true;
    bad.set(m.kind, at);
  }
  return CLAIMS.filter((c) => bad.has(c.kind)).map((c) => {
    const at = bad.get(c.kind);
    return { kind: c.kind, said: c.said, proof: c.proof, numbers: [...at.numbers], all: at.all };
  });
}

/**
 * #6581: the request numbers this conversation already knows: the bot's own
 * request cards in it, and the reports it filed for this person, on any
 * project, Homeroom's own board included (feedback_reports.app_id is null
 * there). Read once a turn and kept on ctx.threadKnown. A read that fails
 * caches an empty set and marks ctx.threadKnownFailed.
 */
async function threadRequestNumbers(pool, ctx) {
  if (!ctx) return new Set();
  if (ctx.threadKnown) return ctx.threadKnown;
  const known = new Set();
  ctx.threadKnown = known;
  const add = (value) => {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0) known.add(n);
  };
  const conversationId = Number(ctx.conversationId);
  const botId = Number(ctx.bot?.id);
  const userId = Number(ctx.user?.id);
  try {
    if (Number.isInteger(conversationId) && conversationId > 0 && Number.isInteger(botId) && botId > 0) {
      const { rows } = await pool.query(
        `SELECT DISTINCT o.object_ref AS n
           FROM conversation_message_objects o
           JOIN conversation_messages m ON m.id = o.message_id
          WHERE m.conversation_id = $1 AND m.sender_id = $2 AND o.object_type = 'github_issue'`,
        [conversationId, botId],
      );
      for (const row of rows) add(row?.n);
    }
    if (Number.isInteger(userId) && userId > 0) {
      const { rows } = await pool.query(
        `SELECT DISTINCT issue_number AS n FROM feedback_reports
          WHERE user_id = $1 AND issue_number IS NOT NULL AND issue_number > 0`,
        [userId],
      );
      for (const row of rows) add(row?.n);
    }
  } catch (err) {
    ctx.threadKnownFailed = true;
    log.warn('reply-claims', 'Could not read the requests this conversation knows', { err: err.message });
  }
  return known;
}

/**
 * The numbers among `numbers` that are no request on any project this
 * person or this turn touches: { missing, unsure }. `unsure` holds those a
 * lookup could not finish for (a read failed, or more than three were left
 * for Homeroom's board): they are looked up again, never cut.
 */
async function lookUpRequests(pool, ctx, numbers) {
  const unsure = new Set();
  if (!numbers.length) return { missing: [], unsure };
  // #6581: what this conversation filed or read is real, whether or not a
  // queue or issues row exists yet.
  const known = knownNumbers(ctx);
  for (const n of await threadRequestNumbers(pool, ctx)) known.add(Number(n));
  const asked = numbers.filter((n) => !known.has(Number(n)));
  if (!asked.length) return { missing: [], unsure };
  if (ctx?.threadKnownFailed) for (const n of asked) unsure.add(Number(n));
  const { rows } = await pool.query(
    `SELECT DISTINCT x.n FROM (
       SELECT github_issue_number AS n, app_id FROM issues WHERE github_issue_number = ANY($2::int[])
       UNION ALL
       SELECT issue_number, app_id FROM homeroom_bot_requesters WHERE issue_number = ANY($2::int[])
       UNION ALL
       SELECT issue_number, app_id FROM homeroom_bot_queue WHERE issue_number = ANY($2::int[])
       UNION ALL
       SELECT issue_number, app_id FROM homeroom_bot_runs WHERE issue_number = ANY($2::int[])
       UNION ALL
       -- A request filed from an app's "Suggest an improvement" dialog has no twin.
       SELECT issue_number, app_id FROM feedback_reports WHERE issue_number = ANY($2::int[])
     ) x
      WHERE x.app_id IN (
        SELECT a.id FROM apps a JOIN community_members m ON m.community_id = a.community_id WHERE m.user_id = $1
        UNION SELECT r.app_id FROM homeroom_bot_requesters r WHERE r.user_id = $1
        UNION SELECT unnest($3::int[])
      )`,
    [ctx.user.id, asked, [...(ctx.appIds || [])]],
  );
  const found = new Set(rows.map((r) => Number(r.n)));
  // #6583: a platform report has no app_id (feedback-reports.js
  // filePlatformReport records app: null), so it never resolved above.
  try {
    const { rows: reports } = await pool.query(
      'SELECT DISTINCT issue_number AS n FROM feedback_reports WHERE user_id = $1 AND issue_number = ANY($2::int[])',
      [ctx.user.id, asked],
    );
    for (const row of reports) found.add(Number(row.n));
  } catch (err) {
    for (const n of asked) unsure.add(Number(n));
    log.warn('reply-claims', 'Could not check the platform reports a reply names', { err: err.message });
  }
  const missing = asked.filter((n) => !found.has(n));
  if (!missing.length) return { missing: [], unsure };
  // #6581: a report filed on Homeroom's own board has no queue row yet. Look
  // the rest up there (at most three) before calling any of them unknown: a
  // row on the board is proof the number is real, whatever project it is on.
  let platform = null;
  try {
    platform = await require('./homeroom-bot-move').platformApp(pool, ctx.deps || {});
  } catch {
    for (const n of missing) unsure.add(Number(n));
    return { missing, unsure };
  }
  if (!platform) return { missing, unsure };
  const batch = missing.slice(0, 3);
  for (const n of missing.slice(3)) unsure.add(Number(n));
  try {
    const { rows: board } = await pool.query(
      `SELECT DISTINCT x.n FROM (
         SELECT github_issue_number AS n FROM issues WHERE app_id = $1 AND github_issue_number = ANY($2::int[])
         UNION ALL SELECT issue_number FROM homeroom_bot_requesters WHERE app_id = $1 AND issue_number = ANY($2::int[])
         UNION ALL SELECT issue_number FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = ANY($2::int[])
         UNION ALL SELECT issue_number FROM homeroom_bot_runs WHERE app_id = $1 AND issue_number = ANY($2::int[])
         UNION ALL SELECT issue_number FROM feedback_reports WHERE issue_number = ANY($2::int[])
       ) x`,
      [platform.id, batch],
    );
    const onBoard = new Set(board.map((r) => Number(r.n)));
    return { missing: [...batch.filter((n) => !onBoard.has(Number(n))), ...missing.slice(3)], unsure };
  } catch (err) {
    for (const n of batch) unsure.add(Number(n));
    log.warn('reply-claims', 'Could not look a request number up on Homeroom\'s board', { err: err.message });
    return { missing, unsure };
  }
}

/** The numbers among `numbers` that are no request on any project this person or this turn touches. */
async function unknownRequests(pool, ctx, numbers) {
  return (await lookUpRequests(pool, ctx, numbers)).missing;
}

// ── The projects a reply names (#6307) ────────────────────────────────────
//
// On 4 November a reply garbled a project's name ("Community Components" for
// Community Tier Lists) and named a project nothing had returned ("Block
// World"). A project a reply names as one must be one of theirs or one this
// turn's tools returned, spelled as it was returned.

/** Places and features on screen, which a sentence may name without it being a project. */
const PROJECT_NAME_STOPWORDS = new Set([
  'main chat', 'workshop', 'discover', 'messages', 'home', 'needs you', 'hub', 'all communities', 'settings',
  'homeroom bot', 'the app',
  // #6566: "in Homeroom's Workshop" names the platform, not a project.
  'homeroom', 'homerooms', 'homeroom s',
]);
// A sentence that speaks of a draft, a request or the next one is where a
// project's name is expected.
const PROJECT_MENTION_ANCHOR = /\b(?:drafts?|drafted|drafting|file it|filed|filing|requests?|next one|projects?)\b/i;
// "the draft for Community Components", "on Ear Trainer", a quoted name too.
const PROJECT_NAME_AFTER = /\b(?:for|on)\s+(?:"([^"]{2,60})"|([A-Z][\w'’&.-]*(?:\s+[A-Z0-9][\w'’&.-]*){0,5}))/g;
const QUOTED_NAME = /"([^"]{2,60})"/g;

// #6376: a day, a month or a time word after "for" or "on" is when a thing
// happens, never a project.
const PROJECT_TIME_WORDS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'today', 'tonight', 'tomorrow', 'yesterday', 'morning', 'afternoon', 'evening', 'night',
  'midnight', 'noon', 'week', 'weekend', 'weekday', 'month', 'year', 'now',
]);
// "next Monday", "this week", "the weekend": the word in front names a time too.
const PROJECT_TIME_LEAD = new Set(['next', 'this', 'the', 'last']);

/** Pure: does `name` open with a time, so it is a date rather than a project? */
function isTimePhrase(name) {
  const words = squashWords(name).split(' ').filter(Boolean);
  while (words.length && PROJECT_TIME_LEAD.has(words[0])) words.shift();
  return !words.length || PROJECT_TIME_WORDS.has(words[0]);
}

/**
 * Pure: the project names `text` gives as a draft's or a request's, once
 * each, as { name, labelled } (#6583: `labelled` is a name plainly given as
 * a project, which may be checked even when it is not a garble).
 */
function projectMentions(text) {
  const out = [];
  const seen = new Set();
  const add = (name, labelled) => {
    // "on Rilo I drafted" gives "Rilo I": a trailing pronoun is not part of a name.
    const clean = String(name).trim().replace(/[.,;:]+$/, '').replace(/\s+(?:I|A)$/, '');
    if (!clean || PROJECT_NAME_STOPWORDS.has(squashWords(clean)) || isTimePhrase(clean)) return;
    const key = squashWords(clean);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: clean, labelled });
  };
  for (const sentence of String(text || '').split(/(?<=[.!?\n])\s+|\n+/)) {
    if (!PROJECT_MENTION_ANCHOR.test(sentence)) continue;
    // #6583: "the X project", "project called X", "projects" plainly names
    // what it says is a project.
    const plainly = /\bprojects?\b/i.test(sentence);
    for (const m of sentence.matchAll(PROJECT_NAME_AFTER)) add(m[1] || m[2], plainly);
    // "Next after this is \"Block World\"" says a project without the word draft.
    if (plainly) for (const m of sentence.matchAll(QUOTED_NAME)) add(m[1], true);
  }
  return out;
}

/** The projects this person can see: theirs (members), their requests' and their pins'. Throws when it cannot read them. */
async function personProjectNames(pool, ctx) {
  const known = new Set();
  if (!ctx?.user?.id) return known;
  const { rows } = await pool.query(
    `SELECT a.name, a.slug FROM apps a JOIN community_members m ON m.community_id = a.community_id WHERE m.user_id = $1
     UNION
     SELECT a.name, a.slug FROM apps a JOIN homeroom_bot_requesters r ON r.app_id = a.id WHERE r.user_id = $1
     UNION
     SELECT a.name, a.slug FROM apps a JOIN app_favorites f ON f.app_id = a.id WHERE f.user_id = $1`,
    [ctx.user.id],
  );
  for (const row of rows) {
    for (const value of [row.name, row.slug]) {
      const key = squashWords(value);
      if (key) known.add(key);
    }
  }
  return known;
}

/**
 * The projects a reply may name: this turn's tools' (ctx.knownProjects),
 * its offer's and place's, the projects it touched, and the person's own.
 * { known, sure }: `sure` is false when a read failed.
 */
async function knownProjectNames(pool, ctx) {
  const known = new Set(ctx?.knownProjects || []);
  let sure = true;
  const add = (name, slug) => {
    for (const value of [name, slug]) {
      const key = squashWords(value);
      if (key) known.add(key);
    }
  };
  add(ctx?.offer?.app?.name, ctx?.offer?.app?.slug);
  add(ctx?.app?.name, ctx?.app?.slug);
  const appIds = ids([...(ctx?.appIds || [])]);
  if (appIds.length) {
    try {
      const { rows } = await pool.query('SELECT name, slug FROM apps WHERE id = ANY($1::int[])', [appIds]);
      for (const row of rows) add(row.name, row.slug);
    } catch (err) {
      sure = false;
      log.warn('reply-claims', 'Could not check the projects a reply names', { err: err.message });
    }
  }
  try {
    for (const key of await personProjectNames(pool, ctx)) known.add(key);
  } catch (err) {
    sure = false;
    log.warn('reply-claims', 'Could not read the projects a reply may name', { err: err.message });
  }
  return { known, sure };
}

/**
 * Pure: does `name`, as a reply wrote it, name a project a tool returned?
 * The mention stops at the first lowercase word ("on Note board request #6"
 * gives "Note"), so a known name that begins with it at a word boundary is
 * the same project said short.
 */
function namesReturnedProject(known, name) {
  const key = squashWords(name);
  if (!key) return true;
  if (known.has(key)) return true;
  for (const candidate of known) {
    if (candidate.startsWith(`${key} `)) return true;
  }
  return false;
}

/**
 * Pure: is `name` a garbled version of a project they have (#6583)? It shares
 * its first word with one, but is not a prefix of it.
 */
function looksLikeKnownProject(known, name) {
  const key = squashWords(name);
  const first = key.split(' ')[0];
  if (!first) return false;
  for (const candidate of known) {
    if (candidate.split(' ')[0] !== first) continue;
    if (candidate === key || candidate.startsWith(`${key} `)) continue;
    return true;
  }
  return false;
}

/**
 * The project names a reply gives that are shown to be no project of theirs:
 * a garble of one of theirs, or a name plainly given as a project, when
 * every read of their projects succeeded. Plain capitalised words after
 * "for"/"on" are left alone.
 */
async function unknownProjects(pool, ctx, text) {
  const found = projectMentions(text);
  if (!found.length) return [];
  const { known, sure } = await knownProjectNames(pool, ctx);
  if (!sure) return [];
  return found
    .filter((m) => !namesReturnedProject(known, m.name))
    .filter((m) => m.labelled || looksLikeKnownProject(known, m.name))
    .map((m) => m.name);
}

/**
 * What `text` claims that is shown false, as [{ kind, said, proof, numbers,
 * all }], plus { kind: 'unknown', numbers, shown } for request numbers no
 * lookup found (`shown`: those every lookup finished for, which are cut) and
 * { kind: 'unknown_project', names } for a project shown to be no project
 * of theirs. `ctx` is the turn's context: its flags (named above), its
 * place, and what its tools returned (noteTool). Empty when it all stands.
 */
async function checkReply(pool, ctx, text, { buttons = null } = {}) {
  const turn = ctx || {};
  const receipt = receiptPhrases(turn);
  const found = mentions(text, { receipt });
  // 20 Nov 2026 (live-draft review, C): the reply tool's buttons that offer
  // to change a proposal, and what revise_proposal could change, read first.
  const pressed = turn.proposalTaps && Array.isArray(buttons)
    ? buttons.map((b) => String(b || '')).filter((b) => PROPOSAL_BUTTON.test(b)) : [];
  const offers = found.claims.filter((m) => m.kind === 'proposal_action').map((m) => m.sentence);
  if (turn.proposalTaps && (offers.length || pressed.length)) await noteRevisable(pool, turn, [...offers, ...pressed]);
  const withButtons = (problems) => {
    const cutButtons = pressed.filter((b) => proposalOfferUnbacked(b, turn));
    if (!cutButtons.length) return problems;
    const at = problems.find((p) => p.kind === 'proposal_action');
    if (at) return problems.map((p) => (p === at ? { ...p, all: true, buttons: cutButtons } : p));
    const claim = BY_KIND.get('proposal_action');
    return [...problems, { kind: claim.kind, said: claim.said, proof: claim.proof, numbers: [], all: true, buttons: cutButtons }];
  };
  if (!found.body) return withButtons([]);
  // A claim the turn backs needs no read; one that is not asks the records.
  const pending = found.claims.filter((m) => {
    const claim = BY_KIND.get(m.kind);
    return claim?.proof === 'records' && (!claim.applies || claim.applies(turn)) && !claim.turn(turn);
  });
  let standing = null;
  if (pending.length) {
    standing = await loadStanding(pool, turn, {
      kinds: new Set(pending.map((m) => m.kind)),
      numbers: ids(pending.flatMap((m) => (m.numbers.length ? m.numbers : m.near || []))),
    });
  }
  const out = check(found.claims, { standing, turn });
  try {
    // #6566: the report just filed is a real request on Homeroom's board.
    const filed = Number(turn.reported?.number);
    const { missing, unsure } = await lookUpRequests(pool, turn,
      found.numbers.filter((n) => !(Number.isInteger(filed) && n === filed)));
    if (missing.length) {
      out.push({
        kind: 'unknown', numbers: missing, shown: missing.filter((n) => !unsure.has(Number(n))),
        said: `names ${missing.map((n) => `request #${n}`).join(' and ')}, which no project of theirs has`,
      });
    }
  } catch (err) {
    log.warn('reply-claims', 'Could not check the requests a reply names', { err: err.message });
  }
  try {
    const projects = await unknownProjects(pool, turn, found.body);
    if (projects.length) {
      out.push({ kind: 'unknown_project', names: projects, said: `names ${projects.map((n) => `"${n}"`).join(' and ')}, which no tool returned this turn` });
    }
  } catch (err) {
    log.warn('reply-claims', 'Could not check the projects a reply names', { err: err.message });
  }
  // #6784: an offer with a one-line idea while this same reply sets out a
  // longer plan: the plan, not the line, is what the project is made from.
  if (briefShortOfPlan(turn.newProjectBrief?.idea, text)) {
    out.push({ kind: 'short_brief', said: 'offers New project with a one-line idea while its reply sets out a longer plan' });
  }
  return withButtons(out);
}

// ── The repair note ───────────────────────────────────────────────────────

/**
 * The note a reply that claimed too much is asked again with. `tools` is the
 * set of tool names offered where the reply is written: a tool is named
 * only when that place has it (#6583). It asks for a lookup or for the
 * claim to be left out, never for a denial or a retraction.
 */
function repairNote(problems, { tools = null } = {}) {
  const offered = (name) => tools == null || tools.has(name);
  const names = (...list) => list.filter(offered);
  const kinds = new Set(problems.map((p) => p.kind));
  const list = problems.map((p) => p.said).join('; and it ');
  // #6581: a number Homeroom cannot find yet is not a thing that did not
  // happen. When that is all that is wrong, the note never says the turn did
  // nothing and never lists the doing-tools.
  const onlyLookups = problems.length > 0 && problems.every((p) => p.kind === 'unknown' || p.kind === 'unknown_project');
  const canDo = [
    offered('offer_request') ? 'offer_request drafts a request for them to file' : null,
    offered('comment_on_request') ? 'comment_on_request posts on a request' : null,
    offered('start_request') ? 'start_request starts one' : null,
    offered('revise_proposal') ? 'revise_proposal changes your proposal' : null,
    offered('update_change') ? 'update_change changes your change' : null,
    offered('withdraw_proposal') ? 'withdraw_proposal withdraws one of your proposals' : null,
    offered('report_problem') ? 'report_problem tells the Homeroom team' : null,
  ].filter(Boolean);
  const primary = names('request_detail');
  const also = names('my_work', 'list_requests');
  let unknownHint = primary.length ? `${primary[0]}${also.length ? ` (or ${also.join(' / ')})` : ''}` : also.join(' / ');
  if (!unknownHint && offered('get_request')) unknownHint = 'get_request';
  const unknownNumbers = problems.find((p) => p.kind === 'unknown')?.numbers || [];
  const keepIt = (unknownHint ? ` with ${unknownHint}, and if a tool returns it, keep the number.` : ', and if a lookup returns it, keep the number.')
    + ' If not, drop the sentence that names it. Never retract an earlier action in this conversation: something you filed earlier stays filed, so do not apologise for it or offer to file it again.';
  // #6583: a note whose only reason is an unfound number asks for a lookup
  // and never says the number was not found.
  const unknown = !unknownNumbers.length
    ? ''
    : onlyLookups
      ? ` Look the number up${keepIt}`
      : ` Homeroom could not find ${unknownNumbers.map((n) => `request #${n}`).join(' or ')} in its records yet: look it up${keepIt}`;
  // #6307: a project named that no tool returned (a garbled name, a guessed one).
  const projectTools = names('my_work', 'list_requests');
  const unknownProject = kinds.has('unknown_project')
    ? ` Look the project up${projectTools.length ? ` (${projectTools.join(', ')})` : ''} and write its name as the tool returns it; never guess or abbreviate a name. Drop the sentence naming any other project.`
    : '';
  const promised = kinds.has('promised') || kinds.has('report_back')
    ? ' Never promise to look into something or come back to it later: say what you cannot do from here, and what they can do (leave it, vote No on the proposal, comment on the request, or use Send feedback)'
      + (offered('report_problem') ? ', or offer report_problem.' : '.')
    : '';
  // #4605, #6307: a draft promised with no offer behind it. The second pass
  // drafts it now, and says one line about it, never its words.
  const drafted = kinds.has('drafted')
    ? ` Your reply says a draft with File it and Not now is under it, but no draft is open in this conversation, so nothing is under it.${offered('offer_request') ? ' Call offer_request now with the project, title and details; if it is refused, say why plainly and do not mention File it.' : ' Do not mention File it.'} Then reply with one short line about the draft at most: the card under it shows its title and words, so never write them in your reply.`
    : '';
  // #6784: the plan in the reply, not a line of it, is what the project is
  // made from, so the offer is asked for again with all of it.
  const shortBrief = kinds.has('short_brief')
    ? ' Your offer_new_project idea is shorter than the plan in your reply. Call offer_new_project again with idea holding every point of the plan and every answer they gave, as bullets, then reply.'
    : '';
  // 17 Nov 2026 (#6763): a New project pointed at with none under the reply.
  const newProject = kinds.has('new_project')
    ? ` Your reply points at a New project card or button under it, but none is there.${offered('offer_new_project') ? ' If they want to make a new app of its own, call offer_new_project now, then reply; otherwise ask what the app is for and do not mention New project.' : ' Do not mention New project.'}`
    : '';
  // 1 Nov 2026: a screen said to be drawing with nothing drawn.
  // Step 6: with the design tools loaded it draws now; else start_design
  // gives it them first (homeroom-bot-mayor.js).
  // A design's thread (capture_page is the design kind's alone), where the generic
  // write and edit draw the screen (stage 3).
  const drawWith = offered('capture_page') ? 'write_artifact (or edit_artifact)' : null;
  // Artifacts: a plain page's thread writes and changes it with its own tools.
  const pageDone = kinds.has('page_done')
    ? (offered('edit_artifact')
      ? ' Nothing in the page was written or changed this turn. Change it with edit_artifact (or write it with write_artifact), then reply; or say plainly that nothing changed.'
      : ' Nothing in the page was changed, so do not say it was.')
    : '';
  const drawing = kinds.has('drawing') || kinds.has('design_done')
    ? (drawWith
      ? ` You have not drawn anything this turn. Call ${drawWith} now, then reply.`
      : offered('start_design')
        ? ' Your reply says you are drawing a screen, but you did not call start_design in this turn, so nothing is being drawn. If they asked for a screen, call start_design now with what to draw and its title, draw it, then reply. If you cannot, say so plainly.'
        : ' Nothing is being drawn here, so do not say it is.')
    : '';
  // Step 6 (#6864, 6): a live draft's change said with nothing saved.
  const draftDone = kinds.has('draft_done')
    ? (offered('apply_changes')
      ? ' Nothing was saved to the draft this turn. Make the change with edit_file and save it with apply_changes, then reply; or say plainly that nothing changed.'
      : ' Nothing was saved to the draft, so do not say it was.')
    : '';
  // A (live-draft review): how the preview looks, said with no look since the last save.
  const draftLooks = kinds.has('draft_looks')
    ? (offered('look_at_preview')
      ? ' You have not looked at the preview since your last save this turn, so you cannot say it is fixed or how it looks now. Look with look_at_preview, then say what it shows; if you cannot look, say the change is applied and what you expect it to show, in those words.'
      : ' Nothing looked at the preview since the last save: say the change is applied and what you expect it to show, never that it is fixed or how it looks now.')
    : '';
  // 24 Nov 2026: asked to prompt again, or a later look promised with none set.
  const draftLater = kinds.has('draft_later')
    ? ' Their view of the preview reloads by itself when it is up, so never ask them to say anything again or to tell you when it is up. Say the change is saved and what you expect it to show; say a line follows here once it is up only when a tool said Homeroom will post one.'
    : '';
  // #6159: there is no control on their side; close_thread finishes a private thread.
  const noControl = kinds.has('no_control')
    ? ` There is no such control on their side${offered('close_thread') ? ': to finish this private thread, call close_thread.' : '.'}`
    : '';
  // #6151: a filed design Homeroom bot builds.
  const notBuilt = kinds.has('not_built')
    ? ' This artifact is filed, and Homeroom bot builds it from its plan. Say so, and where it stands from the FILED line. Never say it cannot be built or that someone else has to start it.'
    : '';
  // #6263: a description described without reading it.
  const unread = kinds.has('unread_description')
    ? ` You described a change's description without reading it in this reply.${offered('get_change') ? ' Read it with get_change, or say you cannot see it.' : ' Leave out what it says, or say you cannot see it.'}`
    : '';
  // 20 Nov 2026 (live-draft review, E): a look at the web said with none run.
  const searched = kinds.has('searched')
    ? (offered('web_search')
      ? ' You did not search the web in this turn. If they asked you to look something up, call web_search now and name the pages you used as links; otherwise say plainly that you are answering from what you know.'
      : ' You cannot search the web here: say plainly that you are answering from what you know, never that you looked it up, searched or researched it.')
    : '';
  // 20 Nov 2026 (live-draft review, C): a proposal offered to be changed, in
  // words or as a button, that nothing here changes.
  const buttons = problems.flatMap((p) => (Array.isArray(p.buttons) ? p.buttons : []));
  const proposalAction = kinds.has('proposal_action')
    ? ` Nothing you can do here changes that proposal, so never offer or promise it, in words or as a button${buttons.length ? ` (leave out ${buttons.map((b) => `"${b}"`).join(' and ')})` : ''}.`
      + (offered('offer_propose_draft') ? ' This thread\'s live draft reaches its own proposal only by their tap: offer_propose_draft puts Propose, or Update proposal, under your reply.' : '')
      + (offered('revise_proposal') ? ' revise_proposal changes only a proposal you built.' : '')
    : '';
  const canDoLine = canDo.length ? `If they want it done now, call the tool that does it: ${canDo.join(', ')}.` : '';
  return [
    `[Homeroom check, not from them: your reply ${list}.`,
    onlyLookups ? '' : 'Nothing this turn did, and nothing in the stored records, shows that yet.',
    onlyLookups ? '' : canDoLine,
    onlyLookups ? '' : 'Answer them again without that claim, and keep the rest of what you said.',
    `${promised}${drafted}${newProject}${shortBrief}${drawing}${pageDone}${draftDone}${draftLooks}${draftLater}${proposalAction}${noControl}${notBuilt}${unread}${searched}${unknown}${unknownProject} Then call reply again.]`,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// ── The cut ───────────────────────────────────────────────────────────────

// #6307: what a reply says about a draft, when the draft it promised was not
// made. Cut with it, so nothing left promises one ("Here's the next one").
const DRAFT_PROMISE_RE = /\b(?:drafts?|drafted|drafting|File it)\b|\bnext one\b|\bthe one below\b/i;

/**
 * Pure: `text` less every sentence shown false by `problems`, and nothing
 * else. It never adds a line: what is left is sent, or nothing is. `ctx`
 * (optional) carries the report's receipt, which is never cut, and the
 * numbers this turn knows, which are never cut as unknown.
 */
function cut(text, problems, ctx = null) {
  if (!problems?.length) return text;
  const kinds = new Set(problems.map((p) => p.kind));
  const res = problems.map((p) => ({ p, claim: BY_KIND.get(p.kind) })).filter((x) => x.claim);
  const unknownProjectNames = (problems.find((p) => p.kind === 'unknown_project')?.names || []).map((n) => squashWords(n)).filter(Boolean);
  const unknown = problems.find((p) => p.kind === 'unknown');
  // #6581: a number this conversation filed or read is never cut as unknown.
  const known = knownNumbers(ctx);
  const falseNumbers = new Set((unknown ? (unknown.shown || unknown.numbers || []) : []).map(Number).filter((n) => !known.has(n)));
  // #6566: a report's own receipt is always true, whatever else is cut.
  const receipt = receiptPhrases(ctx);
  const shownFalse = (sentence) => {
    if (receipt && receipt.test(sentence)) return false;
    const named = requestNumbers(sentence);
    for (const { p, claim } of res) {
      if (!claim.re.test(sentence)) continue;
      if (claim.when && !claim.when(sentence, ctx || {})) continue;
      const numbers = Array.isArray(p.numbers) ? p.numbers.map(Number) : [];
      if (p.all !== false || !numbers.length || named.some((n) => numbers.includes(n)) || !named.length) return true;
    }
    if (kinds.has('drafted') && DRAFT_PROMISE_RE.test(sentence)) return true;
    // #6763: with the false pointer go the rest of its words for the button.
    if (kinds.has('new_project') && NEW_PROJECT_WORDS_RE.test(sentence)) return true;
    if (unknownProjectNames.length && projectMentions(sentence).some((mention) => {
      const key = squashWords(mention.name);
      return key && unknownProjectNames.some((u) => u === key || u.startsWith(`${key} `) || key.startsWith(`${u} `));
    })) return true;
    if (falseNumbers.size && named.some((n) => falseNumbers.has(n))) return true;
    return false;
  };
  return String(text || '').split(/\n{2,}/).map((paragraph) => {
    let out = '';
    let wasList = false;
    for (const piece of sentencesOf(paragraph).filter((s) => !shownFalse(s))) {
      const isList = LIST_LINE.test(piece);
      if (!out) out = piece;
      else out += (isList || wasList ? '\n' : ' ') + piece;
      wasList = isList;
    }
    return out.trim();
  }).filter((paragraph) => paragraph.replace(/[^\p{L}\p{N}]/gu, '').length > 0).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Pure: what a reply whose every sentence was cut still sends: the repair
 * pass's own answer less only what is certainly false, an action the bot
 * never takes or one only this turn could have done. A record's verdict
 * alone does not leave the person with no answer. Empty when nothing is left.
 */
function lastWords(text, problems, ctx = null) {
  const certain = (problems || []).filter((p) => p.proof === 'never' || p.proof === 'turn');
  return certain.length ? cut(String(text || ''), certain, ctx) : String(text || '').trim();
}

/**
 * A server note's words through the same check (a template that states a
 * claim: a fallback's "I withdrew it", a follow-up's plain report): the
 * text less what the records and `ctx`'s flags show false. Never throws; a
 * check that cannot run leaves the words as they are.
 */
async function checkedNote(pool, ctx, text) {
  const words = String(text || '');
  if (!words.trim()) return words;
  try {
    const problems = await checkReply(pool, ctx || {}, words);
    return problems.length ? cut(words, problems, ctx) : words;
  } catch (err) {
    log.warn('reply-claims', 'Could not check a note\'s words', { err: err?.message || String(err) });
    return words;
  }
}

module.exports = {
  CLAIMS,
  DRAWING_CLAIM,
  NEW_PROJECT_CLAIM,
  newProjectDoorShown,
  briefShortOfPlan,
  NO_CONTROL_CLAIM,
  DESIGN_DONE,
  DRAFT_LOOKS,
  NOT_BUILT,
  UNREAD_DESCRIPTION_RE,
  SEARCHED_CLAIM,
  claimsSearch,
  squashWords,
  sentences,
  sentencesOf,
  cleanReply,
  requestNumbers,
  usedAsRequest,
  receiptPhrases,
  mentions,
  noteTool,
  noteKnownRequests,
  noteKnownProjects,
  loadStanding,
  check,
  checkReply,
  repairNote,
  cut,
  lastWords,
  checkedNote,
  threadRequestNumbers,
  unknownRequests,
  projectMentions,
  unknownProjects,
  planCardOther,
  // 20 Nov 2026 (live-draft review, C).
  PROPOSAL_OFFER,
  PROPOSAL_BUTTON,
  proposalNumbers,
  proposalOfferUnbacked,
  keptButtons,
};
