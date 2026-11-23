/**
 * Artifacts (docs/plans/artifacts.md): the document a page the bot wrote is
 * drawn in, whatever the page is: a design's version in its pane, on its
 * card and in a comparison, a plan's screen, a laid-out answer, a first
 * look's drawn screen. The frame itself is ./frame.tsx; the policy is
 * ./policy.ts (one text, shared with the server). This file was the design
 * pane's own (../design/frame.ts, #6071) until every page moved onto it.
 *
 * ── Three modes, and never the site's own origin ──────────────────────
 *
 *   run     `sandbox="allow-scripts"` and nothing more: an origin of its
 *           own, so a script in it reaches none of the shell's cookies,
 *           storage or DOM; no forms, no popups, no top navigation. Its
 *           policy lets it load the page's stylesheets, fonts and images
 *           from this site (when the page draws with them) and nothing from
 *           anywhere else: no fetch, socket or beacon, no frame, no form
 *           target, no <base>. Scripts run so a page can try an interactive
 *           state (a menu that opens, a tab that switches).
 *   static  `sandbox=""`: nothing of the page's runs, and its scripts and
 *           handlers are taken out before it is drawn (`staticMarkup`), so
 *           the policy has nothing to refuse.
 *   helper  a page that must say how tall it is and where its links are (a
 *           laid-out answer): cleaned as a static page is, and drawn with
 *           `sandbox="allow-scripts"` (an origin of its own) under a policy
 *           that lets one script run, the helper below, by a nonce made new
 *           for the frame (./policy.ts). Nothing of the page's runs.
 *
 * No frame ever has allow-same-origin.
 *
 * One way out remains that no policy closes: a script can navigate its own
 * frame. A pane that draws a running page draws it again whenever the frame
 * loads a second time (../messages/design-pane.tsx).
 *
 * ── The helper ────────────────────────────────────────────────────────
 *
 * The shell cannot look inside the frame (another origin), so a small
 * helper, put first in the frame's head, does the frame's half:
 *
 *   pins      shell → { __artifact: 'mode', on }   { __artifact: 'pins', pins: [{ n, x, y, open }] }
 *             frame → { __artifact: 'pin', x, y, element }
 *             With comment mode on, a click is taken (never passed to the
 *             page) and answered with its point, as fractions of the page's
 *             size, and the element under it in a few words; the pins the
 *             shell hands it are drawn on the page, so they scroll with it.
 *             Any artifact takes pins: nothing in this is a design's.
 *   picture   shell → { __artifact: 'picture', id, scale, lib }
 *             frame → { __artifact: 'picture', id, blob }  or  { ..., id, error }
 *             A picture of the shell leaves every frame out, so a frame
 *             draws its own (#6261): the vendored SnapDOM source is sent in
 *             the message and run on the frame's own body. Running and
 *             helper frames.
 *   size      shell → { __artifact: 'measure', selector }
 *             frame → { __artifact: 'size', height, hits: [{ x, y, w, h, href }] }
 *             On load, and each time either changes. `hits` are the boxes
 *             of the page's links and summaries (href null), in the frame's
 *             own coordinates, so the shell knows what a press on the frame
 *             lands on without asking (a link must open in the same tick as
 *             the press, or a browser treats it as a popup).
 *   taps      shell → { __artifact: 'tap', x, y }      a press on a summary: its details toggle, and the new size follows
 *             frame → { __artifact: 'link', href }     a link activated inside a static frame (keyboard, screen reader), never followed there
 *
 * The frame's messages are only believed from the frame the shell drew
 * (event.source). A running page's own script could still send one: the
 * most it can do is place a pin, which the person sees before sending,
 * supply its own frame's picture, which is drawn only inside that frame's
 * own rectangle, or name a height, which the shell caps.
 */

import { cspFor, sandboxFor, type FrameMode } from './policy';

/** Every frame this module's component draws carries it, with the mode it was drawn in. */
export const ARTIFACT_FRAME_ATTR = 'data-artifact-frame';
/** How the shell finds the frames that draw their own picture (../comment-pin/picture.ts). */
export const ARTIFACT_PICTURED_ATTR = 'data-artifact-pictured';

// The frame's half (see above). Plain ES5 in a string: it runs inside the
// page's document, before any of the page's own.
const HELPER = `(function(F){
var N=(document.currentScript&&document.currentScript.nonce)||'';
var on=false,layer=null;
function size(){var d=document.documentElement,b=document.body||d;return{w:Math.max(d.scrollWidth,b.scrollWidth,1),h:Math.max(d.scrollHeight,b.scrollHeight,1)};}
function describe(el){if(!el||el===document.documentElement||el===document.body)return null;var t=el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('alt')||el.innerText||el.textContent||'';t=String(t).replace(/\\s+/g,' ').trim();if(t.length>60)t=t.slice(0,59).trim()+'\\u2026';return{tag:String(el.tagName||'').toLowerCase().slice(0,30),id:el.id?String(el.id).slice(0,60):'',text:t};}
function say(m){try{parent.postMessage(m,'*');}catch(e){}}
function linkOf(el){return el&&el.closest?el.closest('a[href], summary'):null;}
function take(e){if(!on){if(F&&e.type==='click'){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(a){e.preventDefault();say({__artifact:'link',href:String(a.getAttribute('href')||'')});}}return;}if(layer&&layer.contains(e.target))return;e.preventDefault();e.stopPropagation();if(typeof e.stopImmediatePropagation==='function')e.stopImmediatePropagation();if(e.type!=='click')return;var s=size(),x=e.pageX/s.w,y=e.pageY/s.h;say({__artifact:'pin',x:Math.max(0,Math.min(1,x)),y:Math.max(0,Math.min(1,y)),element:describe(e.target)});}
['click','mousedown','mouseup','pointerdown','pointerup','touchstart','touchend','submit'].forEach(function(n){window.addEventListener(n,take,true);});
function draw(pins){if(!document.body)return;if(!layer){layer=document.createElement('div');layer.setAttribute('data-artifact-pins','');layer.style.cssText='position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';document.body.appendChild(layer);}
var s=size();layer.innerHTML='';(pins||[]).forEach(function(p){var m=document.createElement('div');m.textContent=String(p.n);m.style.cssText='position:absolute;left:'+(p.x*s.w)+'px;top:'+(p.y*s.h-26)+'px;min-width:26px;height:26px;padding:0 6px;box-sizing:border-box;border-radius:50% 50% 50% 0;background:'+(p.open?'#0a6ee0':'#3f3f46')+';color:#fff;font:600 12px/26px system-ui,sans-serif;text-align:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)';layer.appendChild(m);});}
var snap=null,drawing={};
function reply(id,blob,error){say({__artifact:'picture',id:id,blob:blob,error:error});}
function snapshot(d){var id=String(d.id||'');if(!id||drawing[id])return;drawing[id]=true;
function done(blob,error){delete drawing[id];reply(id,blob,error);}
try{
if(!snap){if(typeof d.lib!=='string'||!d.lib){done(null,'no picture');return;}var s=document.createElement('script');if(N)s.nonce=N;s.textContent=d.lib;(document.head||document.documentElement).appendChild(s);snap=window.snapdom;if(s.parentNode)s.parentNode.removeChild(s);}
if(typeof snap!=='function'||!document.body){done(null,'no picture');return;}
snap(document.body,{scale:Number(d.scale)||1,dpr:1,clip:{x:scrollX,y:scrollY,width:innerWidth,height:innerHeight},exclude:['[data-artifact-pins]'],excludeMode:'hide'}).then(function(c){return c.toCanvas();}).then(function(canvas){canvas.toBlob(function(blob){if(blob)done(blob,null);else done(null,'no picture');},'image/png');},function(){done(null,'no picture');});
}catch(err){done(null,'no picture');}
}
var box=null,last='',watching=false;
function hits(){var out=[],els=document.querySelectorAll('a[href], summary');for(var i=0;i<els.length&&out.length<300;i++){var el=els[i],rs=el.getClientRects(),href=el.tagName.toLowerCase()==='summary'?null:String(el.getAttribute('href')||'');for(var j=0;j<rs.length&&out.length<300;j++){var r=rs[j];if(r.width>0&&r.height>0)out.push({x:r.left,y:r.top,w:r.width,h:r.height,href:href});}}return out;}
function tall(){var el=(box?document.querySelector(box):null)||document.body;if(!el)return;var m={__artifact:'size',height:Math.ceil(el.getBoundingClientRect().height),hits:hits()},k=JSON.stringify(m);if(k===last)return;last=k;say(m);}
function measure(d){box=typeof d.selector==='string'&&d.selector.length<80?d.selector:null;last='';tall();if(watching)return;watching=true;
if(typeof ResizeObserver==='function'){var el=(box?document.querySelector(box):null)||document.body;if(el)new ResizeObserver(tall).observe(el);}
window.addEventListener('resize',tall);window.addEventListener('load',tall);
if(document.fonts&&document.fonts.ready&&document.fonts.ready.then)document.fonts.ready.then(tall,function(){});
setTimeout(tall,300);}
function tap(d){var hit=linkOf(document.elementFromPoint(Number(d.x)||0,Number(d.y)||0));if(!hit||!hit.tagName||hit.tagName.toLowerCase()!=='summary')return;var det=hit.parentElement;if(det&&det.tagName.toLowerCase()==='details'){if(det.hasAttribute('open'))det.removeAttribute('open');else det.setAttribute('open','');setTimeout(tall,0);}}
window.addEventListener('message',function(e){if(e.source!==parent)return;var d=e.data;if(!d||typeof d!=='object')return;var k=d.__artifact;if(k==='mode'){on=!!d.on;document.documentElement.style.cursor=on?'crosshair':'';}else if(k==='pins'){draw(d.pins);}else if(k==='picture'){snapshot(d);}else if(k==='measure'){measure(d);}else if(k==='tap'){tap(d);}});
})(__FORWARD__);`;

// A static page's links are the shell's to open (a press there is forwarded,
// never followed in the frame); a running page keeps its own clicks.
const helperSource = (forward: boolean): string => HELPER.replace('__FORWARD__', forward ? '1' : '0');

/** The stylesheets a Homeroom page draws with now: this document's own, from this site. */
export function currentSheets(doc: Document = document): string[] {
  const origin = doc.defaultView?.location.origin || '';
  return [...doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]')]
    .map((link) => link.href)
    .filter((href) => !!origin && href.startsWith(`${origin}/`));
}

// A captured Homeroom page names the stylesheets of the build it was
// captured on (`/b/<sha>/css/app.css`); it is drawn with today's, so an old
// version still looks like Homeroom after a deploy.
const SHEET_NAMES = ['native.css', 'app.css', 'tailwind.css'];
function freshSheets(html: string, sheets: readonly string[]): string {
  if (!sheets.length) return html;
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) return tag;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || '';
    const name = SHEET_NAMES.find((n) => href.split('?')[0].endsWith(`/${n}`));
    const now = name ? sheets.find((s) => s.split('?')[0].endsWith(`/${name}`)) : null;
    return now ? tag.replace(href, now) : tag;
  });
}

/**
 * Pure: a page with everything of its own that would run taken out: its
 * scripts, its event handlers and any javascript: address. What a static
 * frame draws, and what anyone but a page's author is shown unless they
 * choose to run it (./frame.tsx). The frame would refuse them anyway
 * (sandbox "", script-src 'none'); a refusal is a console error on the page
 * that holds the frame, so they never reach it.
 */
export function staticMarkup(html: string): string {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*>/gi, '')
    .replace(/(<[a-z][^<>]*?)\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)(?=[^<>]*>)/gi, (tag) => {
      let out = tag;
      for (;;) {
        const next = out.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '');
        if (next === out) return out;
        out = next;
      }
    })
    .replace(/(\b(?:href|src|action|formaction|xlink:href)\s*=\s*)(["']?)\s*javascript:[^"'>\s]*\2/gi, '$1$2#$2');
}

/** A nonce for one frame's helper, made new each time: nothing written before the frame is drawn can name it. */
export function frameNonce(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface FrameDocOptions {
  mode: FrameMode;
  /** This site's origin. */
  origin: string;
  /** Whether the page draws with this site's stylesheets, pictures and fonts (a design, a plan's screen). A page that needs none names no origin and can load nothing. */
  site?: boolean;
  /** Today's stylesheets, for a captured Homeroom page (currentSheets). */
  sheets?: readonly string[];
  /**
   * The helper mode's nonce: its helper goes in with it, and is the one
   * script the frame's policy lets run. Without it the helper mode runs
   * nothing, as a static frame does. No other mode takes one: a running
   * page always has the helper (pins, its own picture), a static page never.
   */
  nonce?: string | null;
}

/**
 * Pure: a page as its frame draws it: the policy and (where its mode has
 * one) the helper first in its head, no <base>, and (for a Homeroom page)
 * today's stylesheets in place of the build's it was captured on. Unless it
 * runs, everything of the page's own that would run is taken out first.
 */
export function artifactFrameDoc(html: string, { mode, origin, site = true, sheets = [], nonce = null }: FrameDocOptions): string {
  const running = mode === 'run';
  let doc = String(html || '').replace(/<base\b[^>]*>/gi, '');
  if (!running) doc = staticMarkup(doc);
  doc = freshSheets(doc, sheets);
  const helped = running || (mode === 'helper' && !!nonce);
  const csp = cspFor(mode, { site: site ? origin : null, nonce: mode === 'helper' ? nonce : null });
  const script = helped ? `<script${running ? '' : ` nonce="${nonce}"`}>${helperSource(!running)}</script>` : '';
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}">${script}`;
  if (/<head\b[^>]*>/i.test(doc)) return doc.replace(/<head\b[^>]*>/i, (open) => `${open}${head}`);
  if (/<html\b[^>]*>/i.test(doc)) return doc.replace(/<html\b[^>]*>/i, (open) => `${open}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${doc}</body></html>`;
}

function escapeAttr(value: string): string {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Pure: a STATIC frame as markup, for the places that build their page as a
 * string (a plan's viewer, lib/spec-html.ts): the frame ./frame.tsx draws,
 * with its document held in `data-srcdoc` until the screen is the one
 * showing (`lazy`), or in `srcdoc` at once. Nothing in it can be tapped or
 * focused. `doc` is a whole document already under the static policy.
 */
export function staticFrameHtml({ doc, title, lazy = false }: { doc: string; title: string; lazy?: boolean }): string {
  return `<iframe sandbox="${escapeAttr(sandboxFor('static'))}" referrerpolicy="no-referrer" tabindex="-1" aria-hidden="true"`
    + ` title="${escapeAttr(title)}" ${lazy ? 'data-srcdoc' : 'srcdoc'}="${escapeAttr(doc)}"></iframe>`;
}

/** The shell's pins as the helper draws them. */
export interface FramePin { n: number; x: number; y: number; open?: boolean }
