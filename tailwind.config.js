// Tailwind config for the platform shell's COMPILED stylesheet.
//
// This is a verbatim port of the inline `tailwind.config` that used to sit
// next to the `https://cdn.tailwindcss.com` script tag in
// public/index.html. The Play CDN compiled utilities in the browser on
// every page load; we now compile them once per image build into
// public/css/tailwind.css (see Dockerfile and scripts/build-tailwind.js), so
// the shell has no cross-origin asset requests and the generated file never
// needs to be committed.
//
// Pinned to tailwindcss 3.4.17 — the exact version the Play CDN resolved
// to (cdn.tailwindcss.com 302s to /3.4.17), so the compiled output matches
// what the browser was generating utility-for-utility. Do NOT jump to v4
// here: it changes utility semantics (default border colour, ring width,
// opacity utilities, `space-*` selector) and would silently restyle the
// whole shell. The React shell migration adopts v4 in its own frontend/
// tree instead.
//
// Docker compiles after copying every scanned source. For local browser work,
// run `npm run build:css`; tests/tailwind-build.test.js also performs a fresh
// compile into a temporary directory and validates the result.
module.exports = {
  // Every surface that gets its utilities from the compiled stylesheet.
  // index.html + the shell's JS (which builds markup as template strings)
  // + the usernode-native kit's demo page, which also loads
  // /css/tailwind.css now.
  content: [
    './public/index.html',
    './public/js/**/*.js',
    './public/usernode-native/v1/demo.html',
    // The React chassis. public/index.html is generated FROM these sources
    // now, so scanning it alone would still find every class in the shell —
    // but shadcn primitives under frontend/@/components/ui hold classes in
    // `cva` variant tables that only some call sites use, and a step-2
    // component will hold classes that appear in no static markup at all.
    // Scan the source, not just the artifact.
    './frontend/src/**/*.{ts,tsx}',
    './frontend/@/**/*.{ts,tsx}',
    // The legacy modules step 2 has MOVED into that tree (features/settings/
    // settings.js, features/admin/admin-*.js, …). They are the same
    // template-string DOM builders they were under public/js/**, so they hold
    // the same class literals, and this glob is the only thing that keeps them
    // in the scan after the move — the admin console alone is ~12k lines of
    // them, and losing it would strip the whole console's styling with no
    // error anywhere.
    './frontend/src/**/*.js',
  ],

  // Every class name in the shell is a COMPLETE literal in source — the
  // conditional ones are whole strings picked out of maps/ternaries (see
  // the CHIP/BADGES tables in features/admin/admin-gallery.js,
  // features/admin/admin-merges.js, app-secrets.js, …), never assembled from
  // fragments like `bg-${tone}-500`.
  // That's what makes a compiled stylesheet safe here: Tailwind's extractor
  // is a regex over source text and finds all of them.
  //
  // If a future change ever does build a class name dynamically, add the
  // resulting classes here rather than reaching back for the CDN. Note that
  // classes arriving from *content* (sanitized markdown allows `class`, see
  // renderMarkdown in public/js/dev-chat.js) are deliberately NOT
  // safelisted — message content should not be able to restyle the shell.
  safelist: [],

  darkMode: 'class',
  future: { hoverOnlyWhenSupported: true },
  // ── The widget-language palette (step 1 of the reskin) ──────────────
  //
  // THE SCALE NAMES ARE DELIBERATELY UNCHANGED; ONLY THE VALUES MOVED.
  // `zinc-*` is no longer a violet-tinted grey and `violet-*` is no longer
  // violet — they are the new language's neutral ramp and its blue accent.
  // That reads wrong at first glance and is still the right call:
  //
  //   * ~80k lines across frontend/src/**, frontend/@/** and public/js/**
  //     spell these scales as complete class literals (`bg-zinc-900`,
  //     `text-violet-400`). Re-keying them to `neutral-*`/`blue-*` would be a
  //     rename touching every one of those literals — an enormous diff whose
  //     rendered output is identical to this four-line one.
  //
  // So the scale name is now an IDENTITY ("the shell's neutral", "the shell's
  // accent"), not a hue. Read the hex, not the key.
  //
  // WHAT USED TO BE HERE, because it is the thing most likely to be
  // reintroduced: this note used to say the admin console "is untouched and
  // stays gray/indigo", and that tests/admin-ui-registry.test.js kept the two
  // systems apart BY PALETTE NAME. Both stopped being true when the
  // widget-language reskin folded the console into this vocabulary. That test
  // now asserts the OPPOSITE — `gray-` and `indigo-` appear nowhere in
  // frontend/@/components/ui/**, frontend/src/** or public/js/** — because the
  // two keys below are overridden and a stray stock `bg-gray-100` renders an
  // untuned hue beside the platform's. The boundary between the two systems is
  // a DENSITY one now, and it lives in AGENTS.md's "One language, two
  // surfaces" rule.
  //
  // Values come from the Brand Kit 2026 frames in the Streamlined Concept
  // Figma (subtle-y2k v2: GREY ground, YELLOW accent) and are CORRECTED for
  // contrast where a brand hex fails in a role; the anchors:
  //   zinc-100  the page background the cards float on — a warm-NEUTRAL
  //             grey (not blue-grey, so the yellow accent harmonizes)
  //   violet-300  the brand yellow #FFEE6F, verbatim — decorative
  //   violet-600  the CTA fill (#FFC93A). No vibrant yellow can carry white
//               text (~1.5:1), so the accent convention INVERTS here: fills
//               take near-black ink (12.6:1) — button.tsx's `ink` table and
//               --accent-ink in public/css/app.css are where that flip
//               lives — and ink-on-white moves down-ramp to violet-700.
  //   violet-700  the accent as INK (links, chip text): #8A5B0B, a dark
  //             gold — 5.86:1 on white, 5.09:1 on the grey ground.
  theme: { extend: {
    // The shell's content keyline, aliased from app.css's --screen-gutter so
    // `px-gutter` and the raw CSS rules resolve ONE declaration by reference.
    // A second literal here would be a second number to drift, which is the
    // failure this alias exists to prevent — the same value is currently
    // spelled px-3, 12px and 0.75rem across the tree, and a sweep matching
    // one spelling misses the others. See the token's comment in app.css for
    // which tier this is and why 16px chrome is NOT it.
    spacing: { gutter: 'var(--screen-gutter)' },
    colors: {
      // The warm-neutral grey. zinc-500 is the product's SECONDARY INK, and
      // an earlier live WCAG sweep found 63 failing styles when this shade
      // sat at 4.35:1 on the ground. #6B6B64 cleared 4.66:1 on the grey
      // ground and 5.37:1 on a white card. Correcting the RAMP rather than
      // the call sites is the whole reason this is a token.
      //
      // #6B6B64 -> #595953 when the product moved to APCA. Under Lc that shade
      // measured 67.1 on the grey page — below the 75 body floor — while
      // reading a comfortable 76.8 on a white card, so the deficit was the
      // GROUND, not the ink. #595953 is 74.8 on the page and 84.5 on a card.
      //
      // Retuning the ramp beat the alternative of moving 365 call sites to
      // zinc-600 for a reason that is not about effort: zinc-600 measures 90.4
      // on a card, which is within 5 Lc of BODY ink (95.7), so secondary text
      // would have stopped reading as secondary. 84.5 keeps an 11-point step.
      // The 69 non-text uses of this shade (42 backgrounds, 21 placeholders,
      // 5 borders, a ring) move with it and are imperceptible at 10% alpha.
      zinc: { 50:'#F7F7F3',100:'#EFEFEB',200:'#E4E4DF',300:'#CFCFC8',400:'#97968E',500:'#595953',600:'#4B4A44',700:'#3C3C36',800:'#2D2D28',900:'#1F1F1B',950:'#0E0E0B' },
      // The FULL ramp, deliberately. The pre-reskin config pinned only
      // 400/500/600/700, so 280 call sites using violet-50 (191 of them),
      // -100, -200, -300, -800, -900 and -950 were quietly rendering STOCK
      // Tailwind violet all along. That was invisible while the pinned shades
      // were violet too; against a blue accent every one of them would have
      // read as a stray purple tint. Closing the ramp is what makes the
      // remap total rather than partial.
      //
      // Yellow's geometry is unlike a blue's: 300–600 are all light (every
      // fill wants dark ink), so the ramp jumps at 700 to the dark gold that
      // does ink duty. Consequences enforced by the ink sweep, not by this
      // table: nothing may spell `text-violet-600` (1.5:1 — use 700), and
      // accent `hover:bg-violet-700` became `hover:bg-violet-500` (a dark
      // gold hover fill under near-black ink would be unreadable).
      //
      // ── THE THREE TIERS ────────────────────────────────────────────
      //
      // A blue accent could be one colour doing every job. A yellow cannot,
      // and being forced to split the roles made the roles explicit. Which
      // treatment a surface takes says WHAT KIND OF THING it is:
      //
      //   accent yellow fill + TRUE BLACK ink   "this is the action"
      //     The one thing a screen wants you to do: Improve, New change,
      //     Send, Create app, Promote. `bg-violet-600` + `text-black`, or
      //     --accent-fill + --accent-ink in app.css. Mode-INVARIANT: the
      //     action looks identical in light and dark, which is the point of
      //     giving it a saturated hue.
      //
      //   near-black fill + white ink           "this is where you are"
      //     Selected state in a set — tabs, segmented controls, filter
      //     chips, toggles. `bg-zinc-900 text-white dark:bg-zinc-100
      //     dark:text-zinc-900`, which INVERTS with the mode. Already the
      //     convention in @/components/ui/tabs.tsx (SECTION_TAB_ACTIVE) and
      //     chip.tsx; the yellow accent is what made it general, because
      //     selection and action finally have different colours and stop
      //     competing for the one fill.
      //
      //   neutral grey                          "everything else"
      //     Unselected segments, secondary actions, badges, avatar discs,
      //     informational panels, card washes. What the 11-step neutral
      //     ramp is FOR. An accent tint on any of these spends the accent
      //     on something that is not an action and not a state, which is
      //     how a product ends up with an accent that signals nothing.
      //
      // ── YELLOW IS PRECIOUS, AND BLUE TAKES THE REST ────────────────
      //
      // The tiers above held, but yellow kept leaking: it also painted
      // links, your own chat bubble, unread counts, badges and every
      // "mine" mark. A colour that means six things means none of them,
      // so the fourth rule is scarcity — and the brand kit's blue
      // (`azure`, above) absorbs everything the yellow was doing that is
      // not an action:
      //
      //   yellow  ONLY a filled primary action, and at most ONE per
      //           screen. Where two controls open the same thing (the
      //           Messages header `+` and its empty-state CTA), the
      //           persistent one keeps the yellow and the duplicate takes
      //           the near-black fill.
      //   blue    links, text buttons, your own message bubble, unread
      //           counts, identity marks, badges — ink AND wash, so a
      //           blue-inked chip sits on a blue wash rather than a
      //           yellow one.
      //   black   selection, as before.
      //   grey    quiet, as before.
      //
      // Mechanically: `bg-violet-600` and `hover:bg-violet-500` are the
      // ONLY yellow surfaces left in the product. Every other accent
      // surface and every accent ink is `azure`.
      //
      // Corollary the tiers settle: a FOCUS RING is neither the action nor
      // a selection, and yellow made a famously weak one (violet-500 is
      // 1.38:1 on white — a focus indicator you cannot see). Rings are
      // `focus:ring-zinc-900 dark:focus:ring-zinc-100` now: 16.5:1, and
      // consistent with black meaning "the current thing".
      violet: {
        50:'#FFFBE6',100:'#FFF6C7',200:'#FFF09B',300:'#FFEE6F',400:'#FFE768',
        500:'#FFD84D',600:'#FFC93A',700:'#8A5B0B',800:'#6E4809',900:'#533607',950:'#302005',
      },
      // The brand kit's BLUE (#3090E1), as the accent's INK and its
      // non-action fill. A real scale rather than a re-hued end of the
      // `violet` ramp, because 700–950 there are used as surfaces too and
      // a two-hue ramp would bleed blue into yellow washes.
      //
      // Why a second accent hue exists at all: yellow is PRECIOUS. It marks
      // the one action on a screen and nothing else — the moment it also
      // paints links, your own chat bubble and every badge, it stops
      // meaning "do this". Blue takes everything that wants accent-ness
      // without being an action: links, text buttons, your message, the
      // accent's identity marks.
      //
      // 700 is the working value and it does BOTH jobs at 4.14:1 — as ink
      // on white, and as a fill under white ink (contrast is symmetric).
      // Deliberately a little under AA's 4.5 for now, Lukas's call, to keep
      // it close to the brand hex; 800 is the same hue at 5.65:1 when a
      // surface needs to clear it. 500 IS the brand hex, for decoration and
      // large type (3.39:1 — never body text) and as the dark-mode ink.
      azure: {
        50:'#F0F7FE',100:'#DBEDFB',200:'#BCDDF7',300:'#8FC6EF',400:'#5CACE8',
        500:'#3090E1',600:'#2589D9',700:'#1D81CD',800:'#186BA9',900:'#135285',950:'#0D3757',
      },
      // ── `lemon` WAS HERE, and is deliberately not coming back ──────────
      //
      // An eleven-step yellow (50–950) anchored on the brand kit's pale
      // #FCFAB3 and core #FFEE6F, added as a NEW scale key alongside `meadow`
      // when the two supporting brand accents landed together. `meadow` grew
      // call sites; this one finished with ZERO. Not a `lemon-<step>` utility,
      // arbitrary value, `cva` entry or template-literal class anywhere in
      // frontend/**, public/js/**, app.css, the scanned kit demo or the test
      // suite — the compiled stylesheet emitted no rule for it at all, which
      // is why removing the key leaves public/css/tailwind.css byte-identical.
      //
      // It was also largely a SECOND NAME for a colour the product already
      // spells: 300 (#FFEE6F) and 950 (#302005) were byte-identical to
      // `violet`'s, and 900 differed by a rounding error. Two yellow ramps
      // with no rule for choosing between them is how a palette drifts, and
      // `violet` IS the yellow (read the hex, not the key — see the note
      // above). If a yellow that is not the action fill is ever wanted, argue
      // it against `violet` rather than reinstating this table.
      //
      // `bg-aura-lemon` in `backgroundImage` below is a DIFFERENT THING and
      // must survive. It is one of the four brand aura gradients; its stops
      // are raw hexes written into the gradient string and never read this
      // table. The landing hero renders it and tests/tailwind-build.test.js
      // pins both the utility and its minified stops.
      //
      // The brand kit's supporting GREEN, as a new scale key — meadow-300
      // #A9CF97 is the core green verbatim, and the 600/700 steps are
      // corrected dark enough to be ink (meadow-600 5.16:1 on white;
      // meadow-700 6.17:1 on the ground). Stock `emerald`/`green` are not a
      // second green: the stock-hue pass folded them onto this ramp, because
      // two green families were an accident of authorship, not a distinction.
      meadow: {
        50:'#F2F8ED',100:'#E4F0DB',200:'#CCE2BD',300:'#A9CF97',400:'#8ABD74',
        500:'#69A855',600:'#427A36',700:'#38672E',800:'#2E5326',900:'#25411F',950:'#142711',
      },
      // ── The two STATUS ramps, tuned. Danger and warning. ────────────────
      //
      // These override stock Tailwind rather than adding a key, because 440
      // red and 400 amber call sites already spell them and the brand kit has
      // no red or amber of its own to rename them after. Both are HARMONIZED
      // rather than remapped: the palette's four anchors are cream #FFFEEA,
      // yellow #FFEE6F, blue #3090E1 and green #A9CF97, all warm or soft, and
      // stock red at hue 0 read cold beside them.
      //
      // Hue is the whole design. red sits at 8 deg and amber at 30 — 22 apart,
      // which is what keeps "blocked" and "needs review" distinguishable as
      // adjacent badges, the thing they most often are. Amber is a further
      // 13.6 off the ACTION yellow at 43.6 (violet-600 #FFC93A), which it must
      // be: yellow means "the one filled action on this screen" and warning is
      // not an action. Pushing amber toward orange also happens to be the one
      // move that HELPS its three `bg-amber-500 text-white` sites.
      //
      // Steps are solved to APCA Lc, not picked. The pairing that matters is
      // 700 and 200: 700 is the light-mode ink at Lc 80 on white, 200 is the
      // DARK-mode ink at Lc -80 on the #1F1F1B card. That is parity to a
      // decimal, and parity — not an absolute floor — is the target, because
      // it is self-calibrating and it is what the dark-mode guidance asks for.
      // 600/800/900 are Lc 72/90/100 for the surfaces that need a step either
      // side. 500 is the wash and fill hue; 50-100 the light tints.
      //
      // Note 200 does double duty, exactly as it does in azure and meadow: a
      // pale tint in light mode AND the dark-mode ink. That is not a clash —
      // on a dark ground a pale tint IS the readable ink, and the alternative
      // (a saturated dark-mode red) cannot reach Lc 80 at any lightness.
      red: {
        50:'#FDF3F2',100:'#FAE1DD',200:'#F7CDC6',300:'#F09D91',400:'#E96E5B',500:'#E3462E',
        600:'#D5351D',700:'#B42D18',800:'#882212',900:'#55150C',950:'#340D07',
      },
      amber: {
        50:'#FEF7F1',100:'#FCECDB',200:'#F8D0A7',300:'#F5B97C',400:'#F2A252',500:'#EE8822',
        600:'#B05F0D',700:'#95500B',800:'#713C08',900:'#462505',950:'#2B1703',
      },
    },
    // The four "aura" gradients from the brand kit, stops verbatim from the
    // Figma node (503-20258). Radial, dark centre → light edge, sized to the
    // element (closest-side matches the Figma render, whose radius is half
    // the square). Decorative moments only — tiles, covers, empty states —
    // never on density surfaces (buttons, tab strips, the admin console).
    backgroundImage: {
      'aura-sky': 'radial-gradient(closest-side, #6717FB 0%, #5A32FB 12.5%, #4E4DFC 25%, #3484FC 50%, #1BBAFD 75%, #0FD5FD 87.5%, #02F0FD 100%)',
      'aura-meadow': 'radial-gradient(closest-side, #41B24A 0%, #66C459 25%, #8BD669 50%, #B0E878 75%, #D6FA87 100%)',
      'aura-sunset': 'radial-gradient(closest-side, #FB179D 0%, #FC3776 25%, #FC5750 50%, #FD7629 75%, #FD8615 87.5%, #FD9602 100%)',
      'aura-lemon': 'radial-gradient(closest-side, #FFAE2B 0%, #FFCE4D 50%, #FFEE6F 100%)',
    },
    // Geist (vendored, see public/vendor/geist/ and the @font-face block at
    // the top of public/css/app.css) ahead of the previous system stack, so
    // every glyph the webfont covers renders Geist and everything else falls
    // back to exactly what shipped before. Geist Mono likewise fronts the
    // mono stack — it is the licensed stand-in for the brand kit's Berkeley
    // Mono (commercial, not vendorable).
    fontFamily: {
      sans: ['Geist', 'ui-sans-serif', 'system-ui', 'sans-serif', '"Apple Color Emoji"', '"Segoe UI Emoji"', '"Segoe UI Symbol"', '"Noto Color Emoji"'],
      mono: ['"Geist Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', '"Liberation Mono"', '"Courier New"', 'monospace'],
    },
    // ── The type scale. SEVEN owned steps, in the TUPLE form so a size
    //    CARRIES its leading ──────────────────────────────────────────────
    //
    // THE PRODUCT SHIPS 23 DISTINCT FONT SIZES AND CHOSE ABOUT SIX OF THEM.
    // This config overrode no `fontSize` at all until now, so every size was
    // either one of Tailwind's stock steps or an arbitrary `text-[...]`: 8
    // named steps, 13 arbitrary spellings across 147 utilities, and 5 values
    // that exist only as raw `font-size:` in app.css (9, 11.5, 12.5, 13.5 and
    // 32px). Nobody weighed 12.5px against 13px. The second one just never had
    // a name to be spelled with, and an unnamed size is decided by whoever
    // typed last.
    //
    // The tuple form is the load-bearing part, not decoration. `text-lg` with
    // no owned scale means 18px over 28px leading, and the 28 is INVISIBLE at
    // the call site — so anyone who wants a tighter heading reaches for
    // `leading-snug`, the leading moves into a second class, and the next call
    // site forgets it. Binding leading to size makes the ramp one decision in
    // one place. A `leading-*` utility still wins where a site genuinely needs
    // to override, because Tailwind emits lineHeight after fontSize.
    //
    // WHAT THIS DELIBERATELY DOES NOT MOVE: xs/sm/base/xl/2xl are restated at
    // Tailwind's exact values (12/16, 14/20, 16/24, 20/28, 24/32) because 868
    // `text-xs` and 675 `text-sm` sites render from them. This pass is a
    // scale, not a restyle. Two steps DO move, both on purpose:
    //
    //   lg   18px, leading 28 -> 24. A 1.56 ratio is a PARAGRAPH value, and
    //        this size is used almost exclusively for single-line headings
    //        and icon buttons. 51 sites spell `text-lg` across the scanned
    //        sources; 6 already pin `leading-none` and are untouched (4 in
    //        the product, and both of the kit demo's), so 45 tighten by 4px.
    //
    //   3xl  30px -> 32px, leading held at 36. 30 is a point on TAILWIND's
    //        ramp, not a size this product ever asked for; 32 is one it did
    //        ask for, twice, as a bare `font-size: 32px` in app.css. Giving
    //        the product's own display size the ordinal name is the whole
    //        point — otherwise 30 and 32 sit adjacent and the scale is not a
    //        scale. 6 class sites move +2px: 4 emoji glyphs with
    //        `leading-none` in fixed `overflow-hidden` tiles (tightest is the
    //        browse row's w-11/44px, still clear at 32px), 1 landing h1 and 1
    //        wallet balance, both in flow.
    //
    // 12PX IS THE FLOOR and the ramp has no step beneath it — the same number
    // tests/dev-chip-geometry.test.js pins for badges. That floor governs the
    // NAMED ladder only: 90 arbitrary utilities still spell 9.6–11.2px, and
    // arbitrary values keep compiling on purpose (tailwind-build.test.js's
    // sentinel list requires `text-[11px]` and `text-[0.65rem]` to). Raising
    // them is a call-site pass, not a config one.
    //
    // NO STEPS FOR 13/15/17/22/34PX, though 50 utilities spell them. That is
    // the iOS system ramp, and the shell components that mimic native metrics
    // (feed, chat, chip, grouped-list, icon-tile) sit on it DELIBERATELY — it
    // is the ladder public/usernode-native/v1/ publishes as a frozen contract.
    // Naming those sizes here would invite two ladders to be read as one and
    // drift into each other.
    //
    // letterSpacing appears ONCE, on 3xl, at Tailwind's own `tracking-tight`
    // value — so the display sites that already hand-write that class render
    // identically and the class simply goes redundant. Body sizes get none;
    // adding tracking there would have moved every site at that size.
    //
    // 4xl and up are left at stock Tailwind, unowned. One site uses `text-4xl`
    // (the profile points numeral) and one spells `text-[2.75rem]`; both fold
    // into this ladder in the call-site pass, not here.
    fontSize: {
      xs:    ['0.75rem',  { lineHeight: '1rem' }],     // 12/16  Tailwind's own
      sm:    ['0.875rem', { lineHeight: '1.25rem' }],  // 14/20  Tailwind's own
      base:  ['1rem',     { lineHeight: '1.5rem' }],   // 16/24  Tailwind's own
      lg:    ['1.125rem', { lineHeight: '1.5rem' }],   // 18/24  was 18/28
      xl:    ['1.25rem',  { lineHeight: '1.75rem' }],  // 20/28  Tailwind's own
      '2xl': ['1.5rem',   { lineHeight: '2rem' }],     // 24/32  Tailwind's own
      '3xl': ['2rem',     { lineHeight: '2.25rem', letterSpacing: '-0.025em' }], // 32/36, was 30/36
    },
    // The language is markedly rounder than the shell was. Remapping the
    // scale rather than editing call sites rounds every existing
    // `rounded-lg`/`rounded-xl` up one step at once, with no class churn.
    // `rounded-full` is untouched (pills stay pills).
    // ── FIVE radius steps, and the missing rung ────────────────────────
    //
    // The scale rendered SIXTEEN distinct radii across classes and app.css.
    // Five survive, each with a role: 4 a mark inside a text line · 8 the
    // INNER of a control · 12 a control · 20 a container · full a pill or
    // disc. Plus 0.
    //
    // 8px is the whole point. Nested corners only look right when they share
    // a centre of curvature — inner = outer − padding — and this product's
    // three CORRECT nestings are all 12 outer / 4 padding / 8 inner
    // (.dev-card-menu, .gc-mention-menu, .attr-popover). Every one of them had
    // to spell that 8 as a bare `border-radius: 8px` in app.css, because no
    // class could say it: 8px WAS `rounded-lg` in stock Tailwind and the
    // reskin overrode it away, leaving a 6 -> 12 hole. 8 is the answer to five
    // of the twenty common outer/padding combinations in the product, and
    // there are 31 raw 8px declarations proving the demand.
    //
    // `md` 6 -> 8 was vetoed once, correctly, on the grounds that 17 raw
    // `border-radius: 6px` declarations would then disagree with the 50
    // `rounded-md` sites on the same cards. That veto is answered by moving
    // those 17 in the same pass, not by leaving the hole open.
    //
    // sm 2 -> 4 merges a 4-site step into DEFAULT; 2px is not a radius anyone
    // can see. xl 16 -> 20 and 3xl 24 -> 20 collapse three container radii to
    // one — 16/20/24 are 1.25 and 1.2 apart, below anything perceivable on a
    // card edge. lg (284 sites) and 2xl (39) do not move at all.
    borderRadius: {
      sm: '0.25rem',   //  4px  was 2 — merged into DEFAULT's value
      md: '0.5rem',    //  8px  was 6 — THE INNER STEP, see above
      lg: '0.75rem',   // 12px  unchanged, 256 sites
      xl: '1.25rem',   // 20px  was 16 — merged up into the container step
      '2xl': '1.25rem',// 20px  unchanged, 33 sites
      '3xl': '1.25rem',// 20px  was 24 — 1 site
    },
  } },
};
