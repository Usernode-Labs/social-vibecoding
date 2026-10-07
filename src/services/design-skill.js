'use strict';

// The `frontend-design` skill every new project's repository starts with,
// and what the Homeroom bot is told about it: App bench context pack 4
// ("frontend-design-kit" v2), made live. Its content hashes, as the
// bench hashes a pack (services/bench/packs.js hashOf), to the pack's own
// b6f8432f01512c04a2f90b14cc6e7880a7670f8afeb71b2ec905a23263b94577
// (tests/design-skill.test.js).
//
// In App bench studio run 8, GLM 5.3 Flash built three briefs (Tier List,
// RSS Reader, Bread Bot) three ways: with no pack (the platform as it was),
// with pack 2 (v1: the skill, and a nudge at the spec and the build to read
// it) and with pack 4 (v2: the same, plus a longer look-and-fix loop for the
// build). A blind review picked pack 4's build as the best of each brief, so
// every first version now gets it:
//
//   * the skill, as files in the new repository's first commit
//     (services/template.js getTemplateFiles), at the path the bench's
//     first commit put them (services/bench/scaffold.js), so it is in the
//     repository when the spec and the build run. Its text is the pack's,
//     byte for byte: src/templates/app-scaffold/frontend-design/, adapted
//     from Anthropic's `frontend-design` skill (Apache License 2.0, its
//     LICENSE.txt shipped beside it, the change noted at its top);
//   * the nudge to read it, at the spec and the build, and the look-and-fix
//     loop at the build (src/prompts/design-skill-nudge.md and
//     first-version-look-loop.md), word for word as the pack had them, and
//     said where the bench said them: under the spec's and the build's
//     "additional guidance" heading (homeroom-bot-live.js guidanceLines). A
//     first version's prompts are therefore the ones pack 4's arm read.
//
// A LATER build gets the nudge alone, at the spec and the build, and only
// when the repository has the skill: the loop is a first version's. Nothing
// on the platform decides, before a build, whether a change touches what
// people see. The design text every build already reads gates itself by its
// wording instead ("when the change adds or alters something a person sees",
// "IF YOUR CHANGE TOUCHES WHAT PEOPLE SEE"), and so does the nudge ("Before
// you plan or build anything people will see"), so the one thing checked
// here is whether the file it names is there (repoHasSkill).
//
// THE BENCH. A studio trial makes its first commit with the same template and
// builds through the same prompts, so its pack 0 ("today's platform") is now
// what pack 4 was. A pack that repeats a paragraph said here (pack 2's
// nudge; pack 4's nudge and loop) is not said twice (guidanceWith): pack 4
// on the bench is pack 0, and its files replace the template's identical
// ones at the same paths.

const fs = require('fs');
const path = require('path');
const log = require('./logger');

const SKILL_DIR = '.claude/skills/frontend-design';
const SKILL_PATH = `${SKILL_DIR}/SKILL.md`;
const SOURCE_DIR = path.join(__dirname, '..', 'templates', 'app-scaffold', 'frontend-design');
const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

const read = (file) => fs.readFileSync(file, 'utf8');

// Read once, at load, as the scaffold's freshness hook is: a missing file is
// a broken install, not a state to run in.
const SKILL_FILES = Object.freeze(['LICENSE.txt', 'SKILL.md'].map((name) => Object.freeze({
  path: `${SKILL_DIR}/${name}`,
  content: read(path.join(SOURCE_DIR, name)),
})));
const NUDGE = read(path.join(PROMPTS_DIR, 'design-skill-nudge.md')).trim();
const FIRST_VERSION_LOOP = read(path.join(PROMPTS_DIR, 'first-version-look-loop.md')).trim();

/** The skill's files, as a new repository's first commit lists them. Pure. */
function skillFiles() {
  return SKILL_FILES.map((f) => ({ path: f.path, content: f.content }));
}

/**
 * What the platform itself adds to one stage's prompt about the skill: a
 * first version's spec the nudge, its build the nudge and the look-and-fix
 * loop; a later spec or build the nudge, when the repository has the skill;
 * anything else nothing. Pure; '' for nothing.
 */
function stageGuidance(stage, { firstVersion = false, hasSkill = false } = {}) {
  if (stage !== 'spec' && stage !== 'build') return '';
  if (firstVersion) return stage === 'build' ? `${NUDGE}\n\n${FIRST_VERSION_LOOP}` : NUDGE;
  return hasSkill ? NUDGE : '';
}

const paragraphsOf = (text) => String(text || '').split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);
const flat = (text) => text.replace(/\s+/g, ' ');

/**
 * The platform's guidance for a stage with a bench pack's after it, leaving
 * out every paragraph of the pack's the platform's already says, so a pack
 * made of text that has since gone live (pack 4) is not said twice. A pack
 * that repeats nothing is kept exactly as written. Pure; '' for neither.
 */
function guidanceWith(builtIn, packGuidance) {
  const own = String(builtIn || '').trim();
  const extra = String(packGuidance || '').trim();
  if (!own || !extra) return own || extra;
  const said = new Set(paragraphsOf(own).map(flat));
  const kept = paragraphsOf(extra).filter((p) => !said.has(flat(p)));
  const rest = kept.length === paragraphsOf(extra).length ? extra : kept.join('\n\n');
  return rest ? `${own}\n\n${rest}` : own;
}

/**
 * Whether the repository has the skill at `ref`, read through GitHub before
 * a later build's spec. Never throws: no client, an error or a missing file
 * is false, and the build is then told nothing about it, as before.
 */
async function repoHasSkill({ github, repo, ref = null } = {}) {
  if (!github || typeof github.getFileContent !== 'function' || !repo?.owner || !repo?.repo) return false;
  try {
    const text = await github.getFileContent(repo.owner, repo.repo, SKILL_PATH, ref || undefined);
    return typeof text === 'string' && text.trim().length > 0;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not read whether the repository has the design skill (not mentioning it)', {
      repo: `${repo.owner}/${repo.repo}`, err: err.message,
    });
    return false;
  }
}

module.exports = {
  SKILL_DIR,
  SKILL_PATH,
  NUDGE,
  FIRST_VERSION_LOOP,
  skillFiles,
  stageGuidance,
  guidanceWith,
  repoHasSkill,
};
