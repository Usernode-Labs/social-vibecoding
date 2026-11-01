/**
 * #6071: the document a design's version is drawn in, in its pane
 * (../messages/design-pane.tsx).
 *
 * ── A frame of its own, scripts and all, and nothing else ─────────────
 *
 * The frame is `sandbox="allow-scripts"` and nothing more: an origin of its
 * own (no allow-same-origin), so a script in it reaches none of the shell's
 * cookies, storage or DOM; no forms, no popups, no top navigation. Its
 * content security policy lets it load the screen's stylesheets, fonts and
 * images from this site and nothing from anywhere else: no fetch, socket or
 * beacon, no frame, no form target, no <base>. Scripts run so a design can
 * try an interactive state (a menu that opens, a tab that switches); a plan
 * filed from it is drawn with them left out (lib/spec-html.ts, `sandbox=""`).
 *
 * One way out remains that no policy closes: a script can navigate its own
 * frame. The pane draws the version again whenever the frame loads a second
 * time (design-pane.tsx), and the bot is told nothing may leave the page.
 *
 * ── Pins ──────────────────────────────────────────────────────────────
 *
 * The pane cannot look inside the frame (another origin), so a small helper,
 * put first in the frame's head, does the frame's half of a pinned comment:
 * with comment mode on, a click is taken (never passed to the design) and
 * answered with its point, as fractions of the page's size, and the element
 * under it in a few words (comment-pin's describeElement); and the pins the
 * pane hands it are drawn on the page, so they scroll with it.
 *
 *   pane  → { __design: 'mode', on }      { __design: 'pins', pins: [{ n, x, y, open }] }
 *   frame → { __design: 'pin', x, y, element }
 *
 * The frame's messages are only believed from the frame the pane drew
 * (event.source). A design's own script could still send one: the most it
 * can do is place a pin, which the person sees before sending.
 */

/** The content security policy a version is drawn under. `origin` is this site's. */
export function designCsp(origin: string): string {
  return [
    "default-src 'none'",
    `style-src 'unsafe-inline' ${origin}`,
    `img-src data: ${origin}`,
    `font-src data: ${origin}`,
    "script-src 'unsafe-inline'",
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** The sandbox a version's frame gets: its own origin, scripts and nothing else. */
export const DESIGN_SANDBOX = 'allow-scripts';

// The frame's half of a pinned comment (see above). Plain ES5 in a string:
// it runs inside the design's document, before any of the design's own.
const HELPER = `(function(){
var on=false,layer=null;
function size(){var d=document.documentElement,b=document.body||d;return{w:Math.max(d.scrollWidth,b.scrollWidth,1),h:Math.max(d.scrollHeight,b.scrollHeight,1)};}
function describe(el){if(!el||el===document.documentElement||el===document.body)return null;var t=el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('alt')||el.innerText||el.textContent||'';t=String(t).replace(/\\s+/g,' ').trim();if(t.length>60)t=t.slice(0,59).trim()+'\\u2026';return{tag:String(el.tagName||'').toLowerCase().slice(0,30),id:el.id?String(el.id).slice(0,60):'',text:t};}
function take(e){if(!on)return;if(layer&&layer.contains(e.target))return;e.preventDefault();e.stopPropagation();if(typeof e.stopImmediatePropagation==='function')e.stopImmediatePropagation();if(e.type!=='click')return;var s=size(),x=e.pageX/s.w,y=e.pageY/s.h;parent.postMessage({__design:'pin',x:Math.max(0,Math.min(1,x)),y:Math.max(0,Math.min(1,y)),element:describe(e.target)},'*');}
['click','mousedown','mouseup','pointerdown','pointerup','touchstart','touchend','submit'].forEach(function(n){window.addEventListener(n,take,true);});
function draw(pins){if(!document.body)return;if(!layer){layer=document.createElement('div');layer.setAttribute('data-design-pins','');layer.style.cssText='position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';document.body.appendChild(layer);}
var s=size();layer.innerHTML='';(pins||[]).forEach(function(p){var m=document.createElement('div');m.textContent=String(p.n);m.style.cssText='position:absolute;left:'+(p.x*s.w)+'px;top:'+(p.y*s.h-26)+'px;min-width:26px;height:26px;padding:0 6px;box-sizing:border-box;border-radius:50% 50% 50% 0;background:'+(p.open?'#0a6ee0':'#3f3f46')+';color:#fff;font:600 12px/26px system-ui,sans-serif;text-align:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)';layer.appendChild(m);});}
window.addEventListener('message',function(e){if(e.source!==parent)return;var d=e.data;if(!d||typeof d!=='object')return;if(d.__design==='mode'){on=!!d.on;document.documentElement.style.cursor=on?'crosshair':'';}else if(d.__design==='pins'){draw(d.pins);}});
})();`;

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
 * Pure: a version's HTML as its frame draws it: the policy and the pin
 * helper first in its head, no <base>, and (for a Homeroom page) today's
 * stylesheets in place of the build's it was captured on.
 */
export function designFrameDoc(html: string, { origin, sheets = [] }: { origin: string; sheets?: readonly string[] }): string {
  let doc = String(html || '').replace(/<base\b[^>]*>/gi, '');
  doc = freshSheets(doc, sheets);
  const head = `<meta http-equiv="Content-Security-Policy" content="${designCsp(origin)}"><script>${HELPER}</script>`;
  if (/<head\b[^>]*>/i.test(doc)) return doc.replace(/<head\b[^>]*>/i, (open) => `${open}${head}`);
  if (/<html\b[^>]*>/i.test(doc)) return doc.replace(/<html\b[^>]*>/i, (open) => `${open}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${doc}</body></html>`;
}

/** The pane's pins as the helper draws them. */
export interface FramePin { n: number; x: number; y: number; open?: boolean }
