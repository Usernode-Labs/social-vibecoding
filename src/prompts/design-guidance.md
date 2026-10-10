==== UI DESIGN (for anything a person will see) ====

Design system first
- Before writing UI, open the closest existing screen in this app and the parts of the native UI kit it uses (the "Native-feel UI kit" platform convention). Build from the same components, `--un-*` tokens, type scale, radii and spacing, and start from that screen's structure.
- Add no new fonts, hex colours, arbitrary Tailwind values (such as `w-[37px]`), shadows or gradients. If the kit has nothing for what you need, compose it from kit parts and say so in your final message.
- The app's own palette is always right. The bans below apply only to what you invent.
- If the app's `CLAUDE.md` has a "## Design" section (or a `Design:` note under "App-specific conventions"), that is this app's look: its accent, neutrals, type, spacing and signature element. Follow it, and update it in the same change when a request changes the look on purpose.

Decide before you build, in a few lines of your plan: who uses this screen, its one job, its one primary action if that job is an action, which existing components you will reuse, and the word you will use for each thing on it. Then ask whether you would build exactly this for any app. If you would, make it fit this app's content instead.

Hierarchy
- One job per view, and one primary (filled) button when that job is an action; a screen for reading or browsing may have none. Everything else is secondary or plain.
- The most important content comes first and largest. At most three heading levels.
- Use spacing, alignment, lists and dividers before cards. A card only when the card itself is what you tap. Never nest cards.
- One accent colour, kept for the primary action and status. Colours the app's "## Design" section gives its subject (a map's water and parks, team colours, card suits, traffic-light statuses) are not accents: use them as that section says.

Words and naming (one idea, one word, across the whole app)
- Reuse the words the app already uses for the same things. If the button says "Publish", the confirmation says "Published", not "Posted".
- Headings say what the area is or what you can do there. No taglines, hero banners or marketing copy inside the app.
- Buttons name the outcome ("Save changes", not "Submit"). Sentence case.
- No emoji as icons, no ALL-CAPS labels above headings, no arrow on every button, no numbering on things that are not steps.

States: every list or data view has an empty state that offers the primary action, a loading state, an error state that says what happened and what to do next, and the populated state.

Consistency pass before you commit: compare what you built with the screens around it. Same header pattern, same place for the primary action, same component and the same word for the same concept. If the app's screens already disagree, follow the kit and mention the drift in your final message.

Quality floor: works at 360px wide, visible keyboard focus, respects reduced motion, readable contrast. Animate only to show the result of something the user did.

Both looks: every new app has a light and a dark look that follow the viewer's Homeroom theme. Give everything you build both, with readable contrast in each, and check both (`?un-theme=light` and `?un-theme=dark` on the URL). Only an app whose `CLAUDE.md` declares one fixed look, or an older app built with one look, keeps a single look.

{{DESIGN_SELF_CHECK}}

==== END UI DESIGN ====
