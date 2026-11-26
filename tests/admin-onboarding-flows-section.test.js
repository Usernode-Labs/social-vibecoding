'use strict';

// The admin console's Onboarding flows section
// (frontend/src/features/admin/admin-onboarding-flows.tsx): where it sits,
// that it mounts the console's way, that the chart engine and the frame
// React renders agree on every host, that its styles stay inside the
// section, and that what was a guess in the prototype is not drawn as one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SECTION = 'frontend/src/features/admin/admin-onboarding-flows.tsx';
const ENGINE = 'frontend/src/features/admin/onboarding-flows/engine.js';

test('it sits under Insights beside Journey and is not public', () => {
  const src = read('frontend/src/features/admin/admin-console.js');
  assert.match(src, /\{ key: 'onboarding-flows', label: 'Onboarding flows', group: 'Growth' \}/, 'admin-only: no `public: true`');
  const sections = src.slice(src.indexOf('SECTIONS: ['), src.indexOf('LEGACY_SECTION_KEYS'));
  const at = (key) => sections.indexOf(`{ key: '${key}'`);
  assert.ok(at('journey') < at('onboarding-flows') && at('onboarding-flows') < at('analytics'), 'right after Journey');
  assert.match(src, /'onboarding-flows': 'AdminOnboardingFlows',/);
  assert.match(src, /'onboarding-flows': '<svg /, 'a nav icon like every section');
  assert.match(read('frontend/src/features/admin/sections.ts'), /import '\.\/admin-onboarding-flows\.tsx';/);
});

test('it mounts through the render/destroy portal seam and nothing in it writes', () => {
  const src = read(SECTION);
  assert.match(src, /render\(el: Element\) \{\s*host = el;\s*mountLegacyPortal\(el, <OnboardingFlowsSection \/>\);/);
  assert.match(src, /destroy\(\) \{\s*unmountLegacyPortal\(host\);\s*host = null;/);
  assert.match(src, /import \{ AdminUI \} from '\.\/admin-console\.js';/);
  assert.doesNotMatch(src, /@\/components\/ui/, 'no admin source imports the shell primitives');
  assert.doesNotMatch(src, /requireAdminWrite|canWrite/, 'nothing here writes, so view-only admins see all of it');
  assert.match(src, /className=\{AdminUI\.loading\}>Loading the onboarding flows…/);
  assert.match(src, /fetchJson\(DEMO \? `\$\{PATH\}\?demo=1` : PATH\)/, 'the demo payload under ?demo=1, like Journey');
  const audit = read('scripts/audit-react-ownership.mjs');
  assert.match(audit, /\{ sel: '#admin-section-content', when: '#admin\/onboarding-flows' \}/);
  assert.match(audit, /'#admin\/onboarding-flows'/);
});

test('the chart is one engine over hosts React renders once', () => {
  const src = read(SECTION);
  const engine = read(ENGINE);
  assert.match(src, /const Frame = memo\(function Frame/, 'a re-render cannot reconcile over what the engine drew');
  assert.match(src, /const chart = mountFlows\(root\.current, reading\);\s*return \(\) => chart\.destroy\(\);/);
  const hosts = new Set([...src.matchAll(/data-of="([a-zA-Z0-9]+)"/g)].map((m) => m[1]));
  const wanted = new Set([...engine.matchAll(/byId\('([a-zA-Z0-9]+)'\)/g)].map((m) => m[1]));
  assert.ok(wanted.size > 25, 'the engine names its hosts');
  assert.deepEqual([...wanted].filter((id) => !hosts.has(id)), [], 'every host the engine asks for is rendered');
  assert.deepEqual([...hosts].filter((id) => !wanted.has(id)), [], 'and nothing is rendered for it that it never takes');
  assert.doesNotMatch(engine, /getElementById|document\.querySelector/, 'it looks nothing up outside its root');
  assert.doesNotMatch(engine, /(window|document)\.addEventListener/, 'every listener goes through listen(), so destroy() takes it');
  assert.match(engine, /return \{ destroy: function\(\)\{\s*dead=true;\s*cleanups\.forEach/);
  assert.doesNotMatch(engine, /innerHTML/, 'names and project titles are written as text');
  // The fills the drawing refers to are the engine's own, under the section's prefix.
  for (const id of ['of-hatch', 'of-hatchSoft', 'of-bothStripe', 'of-arr']) assert.match(engine, new RegExp(`id:'${id}'`));
  assert.match(engine, /url\(#of-arr\)/);
  assert.match(engine, /var reduce=reducedMotion\(\);/, 'the Reduce motion setting, not the media query alone');
});

test('nothing is drawn as inferred: the reading settles private or public, lapsed and too early', () => {
  const engine = read(ENGINE);
  assert.doesNotMatch(engine, /[Ii]nferred/);
  assert.match(engine, /'got:new':\{l:'Let off this week, too early to say'[^}]*neutral:true\}/);
  assert.match(engine, /if\(!on&&!\(N\[Y\.id\]\|\|\{\}\)\.neutral\)/, 'a card that is too early to judge is not a loss');
  assert.match(engine, /'out:lapsed'/);
  // Signed up while waiting and not back since being let in: an end card in Getting in, not "Made an account".
  assert.match(engine, /'got:away':\{l:'Had an account, has not come back'/);
  assert.match(engine, /order:\['got:in','got:mail','got:away','got:waiting','got:nomail','got:new'\]/);
  assert.match(engine, /function isIn\(p\)\{return p\.got==='in'\|\|p\.got==='acct';\}/, 'so their thread stops there');
  assert.match(engine, /var EARLY=\(DATA\.early&&DATA\.early\.label\)\|\|'Earlier members';/, 'the early group is named by the reading');
  assert.match(engine, /if\(count\(ALL,function\(p\)\{return p\.s1;\}\)\)\{\s*out\.push\(\{id:'late'/, 'no early choices when nobody is early');
  for (const view of ['whole', 'priv', 'pub', 'share', 'drop']) assert.match(engine, new RegExp(`id:'${view}'`), `the ${view} view`);
});

test('the Who menu draws everyone, a season, one day\'s admits or an invite\'s people', () => {
  const engine = read(ENGINE);
  const src = read(SECTION);
  assert.match(src, /<select data-of="who" aria-label="[^"]+" \/>/, 'a named control, filled by the engine');
  assert.doesNotMatch(src, /s1Toggle/, 'the switch it replaced is gone');
  // A cohort is the people let off the waitlist on one day: one batch of admit mails.
  assert.match(engine, /out\.push\(\{id:'c:'\+c\[0\],g:'Let off the waitlist on',l:dayWords\(c\[0\]\)/);
  assert.match(engine, /f:function\(p\)\{return p\.door==='waitlist'&&p\.cohort===c\[0\];\}/);
  assert.match(engine, /function setWho\(id,animate\)\{\s*var w=WBY\[id\]\|\|WBY\.all; WHO=w\.id; P=ALL\.filter\(w\.f\);/);
  // The box of people still waiting belongs to everyone, not to a day's admits.
  assert.match(engine, /if\(mode==='cards'&&\(WHO==='all'\|\|WHO==='late'\)&&!col\.nodes\[id\]\)/);
  // The switch's old choice carries over.
  assert.match(engine, /if\(sw==null&&localStorage\.getItem\('admin\.onboardingFlows\.noEarly'\)==='1'\)sw='late';/);
});

test('who came in from the admit mail or a nudge, and what they chose to make first', () => {
  const engine = read(ENGINE);
  // Made an account, off the waitlist: split by the mail they came in after.
  assert.match(engine, /if\(g==='got:in'\)return p\.door==='waitlist'\?'gi:'\+\(p\.mailIn\|\|'unk'\):'gmp:in';/);
  for (const id of ['gi:admit', 'gi:nudge1', 'gi:nudge2', 'gi:had', 'ask:template', 'ask:custom', 'ask:look', 'ask:none']) {
    assert.match(engine, new RegExp(`'${id}':\\{l:`), id);
  }
  // "What do you want to make?" breaks Made an account down, like the admit mail: not a step of its own.
  assert.match(engine, /\{t:'What to make\?',short:'w',detail:true,node:function\(p\)\{ var f=firstNode\(p\); if\(!f\)return null; if\(f==='first:never'\)return 'askp:never';/);
  assert.match(read(SECTION), /\(Time on waitlist, Admit mail, What to make\?\) are not steps of their own/);
  assert.match(engine, /gridAt:9,/, 'the grid moved one column right');
});

test('too early to say is read by the admit mail, and none of it is a loss', () => {
  const engine = read(ENGINE);
  // Let off this week and not in: split by what the mail shows so far, in the Admit mail column.
  assert.match(engine, /if\(g==='got:new'\)return newMail\(p\);/);
  assert.match(engine, /function newMail\(p\)\{ if\(p\.noAccount&&p\.stuck==='mail_sent'\)return 'gn:nomail'; if\(!p\.mail\|\|p\.mail\[0\]==null\)return 'gn:untracked'; return p\.mail\[1\]\?'gn:clicked':\(p\.mail\[0\]\?'gn:opened':'gn:unopened'\); \}/);
  for (const id of ['gn:unopened', 'gn:opened', 'gn:clicked', 'gn:untracked', 'gn:nomail']) {
    assert.match(engine, new RegExp(`'${id}':\\{l:["']Too early: [^}]*neutral:true\\}`), `${id} is too early to judge, never lost`);
  }
  // The findings and the admit-day table say the same.
  assert.match(engine, /' more were let off this week and are too early to say: '\+earlyMail\(/);
  assert.match(engine, /\['Opened the admit mail','num'\],\['Clicked it','num'\]/);
});

test('each column title says how many people reach that step', () => {
  const engine = read(ENGINE);
  assert.match(engine, /function reach\(L,ci\)\{var n=0,k=0;L\.nodes\.forEach\(function\(nd\)\{if\(nd\.col!==ci\|\|nd\.meta\.pass\|\|nd\.meta\.phantom\)return;/,
    'a pass-through and the waiting box are not people reaching a step');
  assert.match(engine, /txt=REL\?\(r\.k\+' of '\+REL\.n\+' selected'\):\(r\.n\+' \\u00b7 '\+pct\(r\.n,all\)\)/, 'of the selection while one is made');
  assert.match(engine, /function refreshLabels\(\)\{\s*if\(!cur\)return;\s*drawZones\(cur,1\);/, 'so a selection redraws them');
  assert.match(engine, /tables\(id\); stepsTable\(L\.full\|\|L\); onboardingTables\(id\);/,
    'and Notes has the same numbers, read off the fully open chart whichever steps are folded');
});

test('the whole funnel folds into its steps, and an open step keeps its cards inside one bar', () => {
  const engine = read(ENGINE);
  // Six steps over the whole funnel's columns, each with who enters it and what became of them there.
  for (const [id, cols] of [['came', '0,1,2'], ['getin', '3,4'], ['first', '5,6'], ['made', '7'], ['now', '8'], ['eng', '9,10,11,12']]) {
    assert.match(engine, new RegExp(`\\{id:'${id}',t:'[^']+',cols:\\[${cols}\\],enter:`), `${id} covers columns ${cols}`);
  }
  assert.match(engine, /\{id:'getin',[^\n]*out:function\(p\)\{return isIn\(p\)\?'go':\(p\.got==='new'\?'early':'stop'\);\}/,
    'too early to say is its own part of a bar, never a stop');
  // A folded step is one narrow column of up to three bars; an open one is its own columns, marked as the step's.
  assert.match(engine, /cols\.push\(\{t:st\.t,step:st,fold:true,cpad:0,cardMin:1,node:function\(p\)\{return st\.enter\(p\)\?'fold:'\+st\.id\+':'\+st\.out\(p\):null;\}/);
  assert.match(engine, /cols\.push\(Object\.assign\(\{\},view\.cols\[ci\],\{step:st,cpad:3,cardMin:24\}\)\)/);
  assert.match(engine, /function build\(id\)\{var v=stepView\(VBY\[id\]\),L=layout\(v,width\(v\)\);if\(v\.stepsOn\)L\.full=layout\(VBY\[id\],width\(VBY\[id\]\)\);return L;\}/,
    'the open chart is laid out too, for Notes');
  // Which steps are open is kept for the next visit, and a bar or a step's name opens and folds it.
  assert.match(engine, /localStorage\.getItem\('admin\.onboardingFlows\.open'\)/);
  assert.match(engine, /if\(n\.meta\.fold\)\{toggleStep\(n\.meta\.stepId\);return;\}/);
  assert.match(engine, /head\.addEventListener\('click',function\(ev\)\{ev\.stopPropagation\(\);toggleStep\(st\.id\);\}\);/);
  assert.match(engine, /'aria-expanded':fold\?'false':'true'/);
  // A card in an open step is filled by what became of its people: carries on, too early, stopped.
  assert.match(engine, /function partsOf\(n,cd\)\{ if\(!cd\.step\|\|n\.meta\.pass\|\|n\.meta\.phantom\)return null;/);
  assert.match(engine, /\['go','early','stop'\]\.forEach\(function\(k\)\{box\.before\(s\('rect',\{'class':'part '\+k\}\)\);\}\);/);
  // A folded bar is too narrow to hide threads changing places in it, so they keep one order through it.
  assert.match(engine, /if\(view\.cols\[ci\]\.fold\)R\.forEach\(function\(pa,i\)\{pa\.slotL\[ci-pa\.start\]=i;\}\);/);
  // Only the whole funnel has steps: the other views are drawn as before.
  assert.equal((engine.match(/\.steps=\[/g) || []).length, 1);
  assert.match(engine, /function stepView\(view\)\{\s*if\(!view\.steps\)return view;/);
  const css = read('public/css/app.css');
  for (const rule of [/#admin-onboarding-flows \.nodeg \.part\.go\{fill:var\(--go\)\}/, /#admin-onboarding-flows \.nodeg \.part\.early\{fill:var\(--early\)\}/,
    /#admin-onboarding-flows \.nodeg \.part\.stop\{fill:var\(--drop\)\}/, /#admin-onboarding-flows \.stepbox\{/, /#admin-onboarding-flows \.stephead\{/,
    /#admin-onboarding-flows \.of-flow\.dim \.nodeg:not\(\.hl\) \.part\{opacity:\.3\}/]) {
    assert.match(css, rule);
  }
  assert.match(css, /html\.dark #admin-onboarding-flows \{[^}]*--go:[^}]*--early:/, 'with dark inks');
});

test('its styles are scoped to the section and use no untuned palette', () => {
  const css = read('public/css/app.css');
  const from = css.indexOf('/* ── Onboarding flows (features/admin/admin-onboarding-flows.tsx)');
  assert.ok(from > 0, 'the block is in app.css');
  // With the console's other section styles: the end of the file belongs to the looks.
  const to = css.indexOf('/* ── Analytics (was public/dashboard.html)');
  assert.ok(to > from, 'beside the other admin sections\' styles');
  assert.ok(from > css.indexOf('#admin-status-root:not(.is-admin)'));
  const block = css.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, '');
  // Every selector, inside a media query or not, starts at the section root.
  const selectors = [...block.matchAll(/(^|[{}])\s*([^{}@]+?)\s*\{/g)].map((m) => m[2].trim())
    .filter((s) => !/^(from|to|\d+%)$/.test(s));
  assert.ok(selectors.length > 150);
  for (const list of selectors) {
    for (const sel of list.split(',')) {
      assert.match(sel.trim(), /^(html\.dark |:where\(html\[data-motion="reduce"\]\) )?#admin-onboarding-flows\b/, `scoped: ${sel.trim()}`);
    }
  }
  assert.match(block, /html\.dark #admin-onboarding-flows \{/, 'dark inks follow the shell\'s own switch');
  assert.doesNotMatch(block, /font:[^;}]*var\(/, 'no font shorthand over a variable: an inherited family voids the whole declaration');
  assert.doesNotMatch(block, /url\(#(hatch|hatchSoft|bothStripe|arr)\)/, 'pattern ids carry the section prefix');
  assert.doesNotMatch(block, /fonts\.googleapis|@import/, 'no cross-origin assets');
  assert.doesNotMatch(block, /safe-area-inset/, 'the section sits inside the page, clear of the screen\'s edges');
  assert.match(block, /#admin-onboarding-flows \.scroller\{[^}]*direction:ltr/, 'the drawing reads left to right in every language');
  // Focusing a card must not scroll the drawing's box: it moves by its transform alone.
  assert.match(block, /#admin-onboarding-flows \.scroller\{[^}]*overflow:hidden;overflow:clip;/);
  assert.match(read(ENGINE), /\[sc,root\]\.forEach\(function\(box\)\{listen\(box,'scroll',function\(\)\{if\(box\.scrollLeft\|\|box\.scrollTop\)\{box\.scrollLeft=0;box\.scrollTop=0;\}\}\);\}\);/,
    'and where a browser scrolls it anyway, it is put back');
  // Nor the admin page around it: a press moves no focus, and keyboard focus puts every scrolled box back.
  const engine = read(ENGINE);
  assert.match(engine, /sc\.addEventListener\('mousedown',function\(e\)\{\s*var f=e\.target\.closest&&e\.target\.closest\('\[tabindex\]'\);if\(!f\|\|!sc\.contains\(f\)\)return;\s*e\.preventDefault\(\);/);
  assert.match(engine, /listen\(document,'scroll',function\(e\)\{[^}]*hold\(b\);\},true\);/, 'where each box belongs, from its own scroll events');
  assert.match(engine, /sc\.addEventListener\('focusin',function\(e\)\{\s*around\(\)\.forEach\(function\(b\)\{var at=held\.get\(b\);[^\n]*b\.scrollTop=at\[1\];\}\}\);\s*reveal\(e\.target\);/,
    'and the chart moves to the card instead');
  // The fade that sends what a selection does not touch to the background is scoped to the chart's own class, so
  // the chart must carry it: without it the engine's dim and hl classes changed nothing on screen.
  assert.match(read(SECTION), /<svg className="of-flow" data-of="flow"/);
  assert.match(block, /#admin-onboarding-flows \.of-flow\.dim \.thread\{opacity:\.1\}/);
  assert.match(block, /#admin-onboarding-flows \.of-flow\.dim \.nodeg:not\(\.hl\) \.nbox,[^{]*\.nlabel,[^{]*\.nsub,[^{]*\.caption\{opacity:\.3\}/);
  assert.match(read(ENGINE), /svg\.classList\.add\('dim'\);/);
  // A pressed card stays where it is: the native kit's [role="button"]:active is a CSS transform, which would
  // replace an SVG shape's transform attribute and throw it to the drawing's corner. Cards and marks are placed
  // by an inline style instead, and the press does nothing inside the drawing.
  const eng = read(ENGINE);
  assert.match(eng, /function at\(g,x,y\)\{g\.style\.transform='translate\('\+x\.toFixed\(1\)\+'px,'\+y\.toFixed\(1\)\+'px\)';\}/);
  assert.doesNotMatch(eng, /setAttribute\('transform'|transform:'translate\(/, 'no card or mark is placed by its transform attribute');
  assert.match(block, /#admin-onboarding-flows svg \[role="button"\],#admin-onboarding-flows svg \[role="button"\]:active\{transition:none;filter:none\}/);
  assert.match(block, /#admin-onboarding-flows svg text\[role="button"\]:active\{transform:none\}/);
  assert.match(read('public/usernode-native/v1/native.css'), /\[role="button"\]:active,[\s\S]*?transform: scale\(0\.97\)/,
    'the press this guards against; if the kit drops it, these rules can go');
  // A double-click on a box, a mark or a thread is two clicks on it, not a zoom.
  assert.match(eng, /sc\.addEventListener\('dblclick',function\(e\)\{\s*if\(e\.target\.closest&&e\.target\.closest\('\[tabindex\]'\)\)return;\s*if\(cur&&e\.target\.closest&&e\.target\.closest\('svg'\)&&nearest\(svgPoint\(e\)\)\)return;/);
  for (const src of [read(SECTION), read(ENGINE)]) assert.doesNotMatch(src, /\b(gray|indigo)-\d/);
});

test('the screen has its declared check', () => {
  const dapp = JSON.parse(read('dapp.json'));
  const check = dapp.tests.find((c) => c.path === '/?demo=1#admin/onboarding-flows');
  assert.ok(check, 'a check opens the section on the demo payload');
  assert.equal(check.expectSelector, '#admin-onboarding-flows [data-tab="drop"]');
  assert.match(read(ENGINE), /'data-tab':v\.id/);
});
