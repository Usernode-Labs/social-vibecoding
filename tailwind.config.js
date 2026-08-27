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
  // The values were once eyedropped from design screenshots and corrected
  // against measurement afterwards. They are not eyedropped at all now:
  // BRAND KIT 2026 is the source, and both ramps are SOLVED against the
  // grounds the product actually paints on rather than sampled from an image.
  //   zinc      rebuilt at brand cream's hue, every stop holding its previous
  //             luminance — see the note on the ramp below
  //   violet    brand blue #3090E1 verbatim at 500, its ink siblings solved
  //             at that same hue
  //
  // The correction this note used to describe (#0a7cff → #0a6ee0, because
  // white on the original is 3.93:1) survives as a LESSON rather than a value,
  // and it is worth restating because the same mistake was still in the file:
  // the old accent was measured against pure WHITE, but `body` is
  // `bg-zinc-100`, so the ground is #eaeaea — where it actually rendered at
  // 4.46:1 and failed AA. Both ramps here are solved against the real grounds.
  theme: { extend: {
    colors: {
      // WeOS: the neutral is rebuilt at BRAND CREAM'S OWN HUE (OKLCH 104.5°,
      // from #FFFEEA) at very low chroma. Neutrals are ~90% of the product's
      // pixels, so this — not the accent — is where a warm brand identity
      // actually lands.
      //
      // EVERY STOP HOLDS ITS PREVIOUS LUMINANCE (worst drift 0.003). That is
      // deliberate and it is what makes this safe: WCAG contrast is a function
      // of luminance alone, so re-hueing at constant luminance leaves every
      // contrast ratio in the product mathematically unchanged. Only the
      // temperature moves. The prior note's hard-won correction is preserved
      // rather than re-litigated — zinc-500 still carries the 4.61:1 secondary
      // ink it was darkened to reach (#68686c → #696861, same luminance).
      //
      // Chroma FADES as the ramp darkens (0.017 → 0.005). A constant chroma
      // here turns the dark theme brown; the warmth has to read on the light
      // surfaces and disappear on the near-blacks.
      zinc: { 50:'#f7f6e9',100:'#ebebde',200:'#e4e4d9',300:'#c8c8be',400:'#8f8e86',500:'#696861',600:'#494942',700:'#3b3b35',800:'#2d2c28',900:'#1d1c19',950:'#0c0b09' },
      // The FULL ramp, deliberately. The pre-reskin config pinned only
      // 400/500/600/700, so 280 call sites using violet-50 (191 of them),
      // -100, -200, -300, -800, -900 and -950 were quietly rendering STOCK
      // Tailwind violet all along. That was invisible while the pinned shades
      // were violet too; against a blue accent every one of them would have
      // read as a stray purple tint. Closing the ramp is what makes the
      // remap total rather than partial.
      //
      // WeOS: stop 500 is BRAND BLUE #3090E1, byte-for-byte from the brand
      // kit. It sits at 500 rather than 600 because of what it can and cannot
      // do: at luminance 0.26 it carries a black label at 6.20:1 but a white
      // one at only 3.39:1, and as INK on the page ground it is 2.81:1. The
      // brand blue is a FILL colour.
      //
      // The codebase also needs this scale as ink (`text-violet-600`, link
      // colours, icon strokes), which at 4.5:1 on the #ebebde page ground
      // demands luminance <= 0.144. No single lightness does both jobs — so
      // rather than approximate the brand colour into a compromise, the ramp
      // keeps it EXACT at 500 and extends past it at its own hue (OKLCH
      // 248.5°, read off #3090E1 itself). 600 #086bb3 is the ink/fill accent:
      // 4.64:1 on the page ground, 5.58:1 on white, white label 5.58:1.
      violet: {
        50:'#eff7ff',100:'#ddedfe',200:'#bedefe',300:'#92c9ff',400:'#6fb7fb',
        500:'#3090E1',600:'#086bb3',700:'#085a97',800:'#04487a',900:'#003761',950:'#002342',
      },
    },
    // The language is markedly rounder than the shell was. Remapping the
    // scale rather than editing call sites rounds every existing
    // `rounded-lg`/`rounded-xl` up one step at once, with no class churn.
    // `rounded-full` is untouched (pills stay pills).
    borderRadius: { lg: '0.75rem', xl: '1rem', '2xl': '1.25rem', '3xl': '1.5rem' },
    // WeOS: Geist is the brand's SUPPORTING face — the one the kit specifies
    // for the "communication layer", which is exactly what a product shell is.
    // (STK Bureau Serif is the display face; it is not needed for UI chrome
    // and is not openly licensed, so it is deliberately not adopted here.)
    //
    // The shell previously declared no body face at all and rode whatever
    // `ui-sans-serif` resolved to per platform — so type was the one part of
    // the product with no design decision behind it.
    //
    // The system stack is KEPT as the fallback rather than replaced: the
    // @font-face in public/css/app.css declares `font-display: swap`, so a
    // reader sees system type for the first paint and on any request where
    // the woff2 has not arrived. Geist's metrics are close enough to the
    // system UI faces that the swap does not reflow layout.
    fontFamily: {
      sans: [
        'Geist', 'ui-sans-serif', 'system-ui', '-apple-system',
        'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue',
        'Arial', 'sans-serif',
      ],
    },
  } },
};
