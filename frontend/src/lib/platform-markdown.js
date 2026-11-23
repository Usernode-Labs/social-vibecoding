// The platform's Markdown renderer: Markdown in, sanitized HTML out.
//
// One renderer for every surface that shows text a person or Homeroom bot
// wrote: message bodies and bot threads (features/messages/format.tsx), a
// request's and a change's description (features/dev-board/topic/), group
// chat and channels (public/js/group-chat.js), the staging overlay and the
// image viewer. It was a method of the dev chat's module until that chat was
// retired; the output and its `dc-*` classes (styled in public/css/app.css)
// are unchanged.
//
// `marked` and `DOMPurify` are the vendored classic scripts the shell loads
// (public/vendor/). Without them the source is shown as it was written.
//
// A side-effect module with no imports or exports: the browser entry imports
// it (frontend/src/main.tsx) and classic scripts read `window.PlatformMarkdown`;
// suites evaluate this file as a classic script.
const PlatformMarkdown = {
  _markdownReady: false,
  _renderImagesInline: false,
  _renderImageWithinLink: false,

  // Render markdown to sanitized HTML.
  //   opts.breaks — when true (default) soft single newlines become <br>
  //     (desirable for chat). Spec surfaces pass { breaks: false } so a
  //     prose spec keeps standard markdown paragraph semantics instead of
  //     getting a <br> on every wrapped line (F5).
  render(text, opts = {}) {
    if (!text) return '';

    const breaks = opts.breaks !== undefined ? opts.breaks : true;

    // F7: if the markdown libs failed to load (CDN blocked, SRI mismatch,
    // offline native shell), don't flatten the doc into <br>-joined text —
    // that hides fences and headings and reads exactly like "markdown is
    // broken". Show the raw source in a <pre> (whitespace + fences intact)
    // behind a small notice so the degradation is obvious and diagnosable.
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<div class="dc-md-fallback-notice">${PlatformI18n.htmlText('devchat:markdown.fallbackNotice')}</div>`
        + `<pre class="dc-md-fallback">${escaped}</pre>`;
    }

    if (!PlatformMarkdown._markdownReady) {
      const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
      const inlineImage = (src, alt) => {
        const image = `<img class="dc-inline-img" src="${escAttr(src)}" alt="${escAttr(alt)}" loading="lazy">`;
        // Preserve an explicit Markdown image link. Otherwise make the
        // scaled issue screenshot itself the link to its original asset, so
        // a click, tap or keyboard activation opens the full-size image.
        if (PlatformMarkdown._renderImageWithinLink) return image;
        return `<a class="dc-inline-img-link" href="${escAttr(src)}" target="_blank" rel="noopener noreferrer" aria-label="${PlatformI18n.htmlText('devchat:markdown.viewImage')}">${image}</a>`;
      };

      marked.use({
        breaks: true,
        gfm: true,
        // #6035: underline has no commonmark form, so `++text++` is its own
        // inline token. It sits beside emphasis rather than inside it, and
        // an anchored tokenizer leaves code spans, which marked reads first,
        // untouched.
        extensions: [{
          name: 'underline',
          level: 'inline',
          start(src) { return src.indexOf('++'); },
          tokenizer(src) {
            const match = /^\+\+(?=\S)([\s\S]*?\S)\+\+(?!\+)/.exec(src);
            if (!match) return undefined;
            return { type: 'underline', raw: match[0], tokens: this.lexer.inlineTokens(match[1]) };
          },
          renderer(token) {
            return `<u>${this.parser.parseInline(token.tokens)}</u>`;
          },
        }],
        renderer: {
          code({ text, lang, escaped }) {
            let language = lang || '';
            let filepath = '';
            if (language.includes(':')) {
              const i = language.indexOf(':');
              filepath = language.slice(i + 1);
              language = language.slice(0, i);
            }
            const safe = escaped ? text : esc(text);
            const header = filepath
              ? `<div class="dc-code-header">${esc(filepath)}</div>`
              : (language ? `<div class="dc-code-header">${esc(language)}</div>` : '');
            return `${header}<pre class="dc-code-block"><code>${safe}</code></pre>`;
          },
          codespan({ text }) {
            return `<code class="dc-inline-code">${esc(text)}</code>`;
          },
          html({ text }) {
            // GitHub emits a dragged/resized issue-comment screenshot as a
            // raw <img ...> tag rather than Markdown image syntax. Raw HTML
            // stays escaped everywhere by default. On an image-enabled
            // surface, accept only one standalone image tag, extract only its
            // quoted src/alt values, re-check the same URL policy as the
            // Markdown image renderer, and rebuild controlled markup. Width,
            // event handlers, styles and every other supplied attribute are
            // deliberately discarded before DOMPurify sees the result.
            // HTML comments are dropped as GitHub drops them: Homeroom's own
            // GitHub comments end with an invisible governance marker that
            // must not print as text. Only a whole-comment token is dropped;
            // anything else stays escaped.
            const raw = String(text || '');
            if (/^\s*<!--[\s\S]*?-->\s*$/.test(raw)
                && raw.indexOf('<!--', raw.indexOf('<!--') + 4) === -1) {
              return '';
            }
            const tag = raw.trim();
            if (PlatformMarkdown._renderImagesInline && /^<img\b[^>]*\/?>$/i.test(tag)) {
              const srcMatch = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
              const altMatch = /\salt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
              const src = srcMatch ? (srcMatch[1] ?? srcMatch[2] ?? '') : '';
              const alt = altMatch ? (altMatch[1] ?? altMatch[2] ?? '') : '';
              if (/^https:\/\//i.test(src) || /^\/[^/]/.test(src)) {
                return inlineImage(src, alt);
              }
            }
            return esc(text);
          },
          // F3: real heading hierarchy. # → h3 (largest), ## → h4,
          // ### and deeper → h5, so a spec's title, sections and
          // subsections are visually distinct instead of all collapsing
          // into one or two levels.
          heading({ tokens, depth }) {
            const inner = this.parser.parseInline(tokens);
            const tag = depth === 1 ? 'h3' : depth === 2 ? 'h4' : 'h5';
            const cls = depth === 1 ? 'dc-h3' : depth === 2 ? 'dc-h4' : 'dc-h5';
            return `<${tag} class="${cls}">${inner}</${tag}>`;
          },
          blockquote({ tokens }) {
            const body = this.parser.parse(tokens);
            return `<div class="dc-blockquote">${body}</div>`;
          },
          list(token) {
            const { ordered, start, items } = token;
            const tag = ordered ? 'ol' : 'ul';
            const cls = ordered ? 'dc-ol' : 'dc-ul';
            const startAttr = ordered && start !== 1 && start !== '' ? ` start="${start}"` : '';
            let body = '';
            for (const item of items) {
              body += this.listitem(item);
            }
            return `<${tag} class="${cls}"${startAttr}>${body}</${tag}>`;
          },
          // F4: GFM task items. marked's default emits an <input
          // type=checkbox>, which DOMPurify strips (input isn't allowed),
          // leaving a bare bullet. Render a non-interactive span marker
          // instead so checklists in specs keep their ☐ / ✓ state.
          listitem(item) {
            const body = this.parser.parse(item.tokens, !!item.loose);
            if (item.task) {
              const mark = item.checked
                ? '<span class="dc-task-check dc-task-checked" aria-hidden="true">&#10003;</span> '
                : '<span class="dc-task-check" aria-hidden="true">&#9744;</span> ';
              return `<li class="dc-task-item">${mark}${body}</li>`;
            }
            return `<li>${body}</li>`;
          },
          // F1: tag the table with dc-table so it can be styled globally
          // (the old .dc-msg-content table rules never reached the spec
          // viewer or preview snippet). Alignment attributes are
          // intentionally dropped — DOMPurify strips them anyway — so cells
          // left-align by default.
          table(token) {
            let header = '';
            for (const cell of token.header) header += this.tablecell(cell);
            let body = '';
            for (const row of token.rows) {
              let rowHtml = '';
              for (const cell of row) rowHtml += this.tablecell(cell);
              body += this.tablerow({ text: rowHtml });
            }
            return `<table class="dc-table"><thead>${this.tablerow({ text: header })}</thead>`
              + `${body ? `<tbody>${body}</tbody>` : ''}</table>`;
          },
          paragraph({ tokens }) {
            return `<p class="dc-p">${this.parser.parseInline(tokens)}</p>`;
          },
          link({ href, title, tokens }) {
            // #3940: an issue-body video embed is a plain markdown LINK to
            // /issue-videos/<id> — GitHub renders an external <video> as an
            // anchor anyway, so the embed is a link everywhere but here. On
            // an image-enabled surface the link becomes the inline player
            // instead; everywhere else it stays an ordinary link.
            if (PlatformMarkdown._renderImagesInline
                && /^(?:https?:\/\/[^/]+)?\/issue-videos\/[a-f0-9]{32}$/i.test(href || '')) {
              return `<video class="dc-inline-video" src="${escAttr(href)}" controls playsinline preload="metadata"></video>`;
            }
            const linkOk = /^https?:\/\//i.test(href);
            const previous = !!PlatformMarkdown._renderImageWithinLink;
            if (linkOk) PlatformMarkdown._renderImageWithinLink = true;
            let inner;
            try {
              inner = this.parser.parseInline(tokens);
            } finally {
              PlatformMarkdown._renderImageWithinLink = previous;
            }
            if (!linkOk) return inner;
            return `<a href="${href}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
          },
          image({ href, title, text }) {
            const safeText = esc(text || '');
            // #683: opt-in inline images (render's images option,
            // consulted via the per-parse flag below — the registered
            // renderers are global). Used for issue bodies so attached
            // screenshots render in the topic view. Only https URLs and
            // same-origin absolute paths qualify; everything else keeps
            // the legacy link/text degradation.
            const inlineOk = PlatformMarkdown._renderImagesInline
              && (/^https:\/\//i.test(href) || (/^\/[^/]/.test(href)));
            if (inlineOk) {
              return inlineImage(href, text || '');
            }
            if (!/^https?:\/\//i.test(href)) return safeText;
            return `<a href="${href}" target="_blank" rel="noopener noreferrer">${safeText || esc(href)}</a>`;
          },
        },
      });

      DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'A') {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
          const href = node.getAttribute('href') || '';
          if (href && !/^https?:\/\//i.test(href) && !/^\/[^/]/.test(href)) {
            node.removeAttribute('href');
          }
        }
      });

      PlatformMarkdown._markdownReady = true;
    }

    // breaks is overridden per-call (the global default set above is true);
    // the registered renderers persist regardless of the per-parse options.
    // #683: `images: true` (issue bodies) lets markdown images render
    // inline — the flag is read by the global image renderer above during
    // this synchronous parse, and 'img' joins the sanitizer allowlist.
    const allowImages = !!opts.images;

    // The cache (see `_mdCacheGet`). `_renderImageWithinLink` is the one
    // piece of module state the renderers read that no option sets: the
    // `link` renderer raises it for the duration of its own children and the
    // `finally` below lowers it, so it is always false on entry — unless a
    // renderer ever re-entered this function mid-parse, which is exactly the
    // case whose output the key could not describe. That call renders
    // uncached rather than being answered from a key that does not hold.
    const cacheable = opts.cache !== false && typeof text === 'string'
      && !PlatformMarkdown._renderImageWithinLink;
    const flags = `${breaks ? 'b' : '-'}${allowImages ? 'i' : '-'}`;
    if (cacheable) {
      const hit = PlatformMarkdown._mdCacheGet(text, flags);
      if (hit !== undefined) return hit;
    }

    PlatformMarkdown._renderImagesInline = allowImages;
    let html;
    try {
      html = marked.parse(PlatformMarkdown.fencesOnOwnLines(text), { breaks });
    } finally {
      PlatformMarkdown._renderImagesInline = false;
      PlatformMarkdown._renderImageWithinLink = false;
    }

    const out = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['a', 'b', 'strong', 'i', 'em', 'code', 'pre', 'h3', 'h4', 'h5',
        'p', 'br', 'ol', 'ul', 'li', 'div', 'span', 'table', 'thead', 'tbody',
        'tr', 'th', 'td', 'hr', 'del', 'u',
        // #3940: the inline issue-video player rides the same opt-in as
        // the images it sits beside (render's images option).
        ...(allowImages ? ['img', 'video'] : [])],
      // 'start' keeps non-1 ordered lists numbering correctly (F2).
      ALLOWED_ATTR: ['class', 'href', 'target', 'rel', 'start',
        ...(allowImages ? ['src', 'alt', 'loading', 'aria-label',
          'controls', 'playsinline', 'preload'] : [])],
      ALLOW_DATA_ATTR: false,
    });
    if (cacheable && typeof out === 'string') PlatformMarkdown._mdCachePut(text, flags, out);
    return out;
  },

  // ── A fence written at the end of a line (phone review #29) ──────
  //
  // A fence opens a code block only at the start of its own line. Written
  // after words ("Below it, two lines: ```js", then the code), it is a code
  // span instead: the language word became its first word, the lines were
  // joined by spaces, and the block was a grey run wrapping mid-statement.
  // So, outside a block, a run of three or more backticks (with a language
  // word or none) that ends a line of words, and has lines after it, moves
  // onto a line of its own; inside a block opened that way, one that ends
  // a line of code closes it on a line of its own. Everything else is left
  // as it was written: a block opened on its own line keeps every line in
  // it, and a one-line ```code``` span stays a span. Pure.
  fencesOnOwnLines(text) {
    if (typeof text !== 'string' || text.indexOf('```') < 0) return text;
    const lines = text.split('\n');
    const out = [];
    let open = '';
    let moved = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const cr = line.endsWith('\r') ? '\r' : '';
      const bare = cr ? line.slice(0, -1) : line;
      if (!open) {
        const opener = /^ {0,3}(`{3,})[^`]*$/.exec(bare);
        if (opener) { open = opener[1]; moved = false; out.push(line); continue; }
        const glued = i < lines.length - 1 ? /^(.*[^`\s])[ \t]*(`{3,})([\w+#.:-]*)[ \t]*$/.exec(bare) : null;
        if (glued) {
          out.push(glued[1] + cr, glued[2] + glued[3] + cr);
          open = glued[2];
          moved = true;
          continue;
        }
        out.push(line);
        continue;
      }
      if (new RegExp(`^ {0,3}\`{${open.length},}[ \\t]*$`).test(bare)) { open = ''; out.push(line); continue; }
      const closed = moved ? /^(.*[^`\s])[ \t]*(`{3,})[ \t]*$/.exec(bare) : null;
      if (closed && closed[2].length >= open.length) {
        out.push(closed[1] + cr, closed[2] + cr);
        open = '';
        continue;
      }
      out.push(line);
    }
    return out.join('\n');
  },

  // ── The rendered-markdown cache ───────────────────────────────────
  //
  // A transcript renders every message again whenever anything about it
  // changes, and each render was a full `marked.parse` + `DOMPurify.sanitize`
  // of text that had not changed. On a long thread that is most of a
  // repaint's cost, paid on a phone many times a second.
  //
  // The output is a pure function of the text and of what the key names:
  //
  //   - `breaks`, which marked reads per call;
  //   - `images`, which the `image` and `html` renderers read (through
  //     `_renderImagesInline`) and which widens the sanitizer's allowlists;
  //   - `_renderImageWithinLink`, which is not keyed but EXCLUDED: see the
  //     call site — it is false on every call that reaches the cache.
  //
  // Everything else the pipeline reads is fixed once `_markdownReady` is set:
  // the renderers are registered once, DOMPurify's single hook is added once,
  // and the sanitizer config is rebuilt from `allowImages` on every call. Only
  // this module registers marked renderers or DOMPurify hooks. The one thing
  // that could still change underneath — a different `marked` or `DOMPurify`
  // object appearing on the page — empties the cache (`_mdCacheLibs`), and
  // the fallback path that runs without them is never cached.
  //
  // Bounded both ways, least-recently-used first. The entry bound is generous
  // on purpose: a republish walks the whole transcript in order, and an LRU
  // smaller than the transcript it serves misses on EVERY row of every walk.
  // The keys are mostly the very strings the caller already holds, so what
  // an entry adds is its html, which the DOM is holding a copy of too.
  //
  // A caller rendering text that changes on every call (a reply still being
  // written) passes `cache: false`, so the cache is not filled with prefixes
  // of one message.
  _MD_CACHE_MAX_ENTRIES: 1500,
  _MD_CACHE_MAX_CHARS: 6000000,
  /** Map<text, { size, html: { [flags]: string } }>, in LRU order. */
  _mdCache: null,
  _mdCacheChars: 0,
  _mdCacheLibs: null,

  _mdCacheGet(text, flags) {
    const libs = PlatformMarkdown._mdCacheLibs;
    if (!PlatformMarkdown._mdCache || !libs || libs[0] !== marked || libs[1] !== DOMPurify) {
      PlatformMarkdown._mdCacheClear();
      return undefined;
    }
    const entry = PlatformMarkdown._mdCache.get(text);
    if (!entry || !Object.prototype.hasOwnProperty.call(entry.html, flags)) return undefined;
    // Most recently used moves to the end of the Map's insertion order.
    PlatformMarkdown._mdCache.delete(text);
    PlatformMarkdown._mdCache.set(text, entry);
    return entry.html[flags];
  },

  _mdCachePut(text, flags, html) {
    if (!PlatformMarkdown._mdCache) PlatformMarkdown._mdCacheClear();
    const cache = PlatformMarkdown._mdCache;
    let entry = cache.get(text);
    if (entry) {
      cache.delete(text);
    } else {
      entry = { size: text.length, html: Object.create(null) };
      PlatformMarkdown._mdCacheChars += entry.size;
    }
    if (Object.prototype.hasOwnProperty.call(entry.html, flags)) {
      PlatformMarkdown._mdCacheChars -= entry.html[flags].length;
      entry.size -= entry.html[flags].length;
    }
    entry.html[flags] = html;
    entry.size += html.length;
    PlatformMarkdown._mdCacheChars += html.length;
    cache.set(text, entry);
    // Evict from the least-recently-used end. The entry just written is the
    // newest, so it survives unless it alone is over the character budget.
    for (const [oldest, old] of cache) {
      if (cache.size <= PlatformMarkdown._MD_CACHE_MAX_ENTRIES
        && PlatformMarkdown._mdCacheChars <= PlatformMarkdown._MD_CACHE_MAX_CHARS) break;
      cache.delete(oldest);
      PlatformMarkdown._mdCacheChars -= old.size;
    }
  },

  _mdCacheClear() {
    PlatformMarkdown._mdCache = new Map();
    PlatformMarkdown._mdCacheChars = 0;
    PlatformMarkdown._mdCacheLibs = [
      typeof marked === 'undefined' ? undefined : marked,
      typeof DOMPurify === 'undefined' ? undefined : DOMPurify,
    ];
  },
};

if (typeof window !== 'undefined') window.PlatformMarkdown = PlatformMarkdown;
