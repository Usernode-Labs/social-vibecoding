==== UI DESIGN (for anything a person will see) ====

Design system first
- Before writing UI, open the closest existing screen in this app and the parts of the native UI kit it uses (the "Native-feel UI kit" platform convention). Build from the same components, `--un-*` tokens, type scale, radii and spacing, and start from that screen's structure.
- Add no new fonts, hex colours, arbitrary Tailwind values (such as `w-[37px]`), shadows or gradients. If the kit has nothing for what you need, compose it from kit parts and say so in your final message.
- The app's own palette is always right. The bans below apply only to what you invent.

Decide before you build, in a few lines of your plan: who uses this screen, its one job, its one primary action, which existing components you will reuse, and the word you will use for each thing on it. Then ask whether you would build exactly this for any app. If you would, make it fit this app's content instead.

Hierarchy
- One job and one primary (filled) button per view. Everything else is secondary or plain.
- The most important content comes first and largest. At most three heading levels.
- Use spacing, alignment, lists and dividers before cards. A card only when the card itself is what you tap. Never nest cards.
- One accent colour, kept for the primary action and status.

Words and naming (one idea, one word, across the whole app)
- Reuse the words the app already uses for the same things. If the button says "Publish", the confirmation says "Published", not "Posted".
- Headings say what the area is or what you can do there. No taglines, hero banners or marketing copy inside the app.
- Buttons name the outcome ("Save changes", not "Submit"). Sentence case.
- No emoji as icons, no ALL-CAPS labels above headings, no arrow on every button, no numbering on things that are not steps.

States: every list or data view has an empty state that offers the primary action, a loading state, an error state that says what happened and what to do next, and the populated state.

Consistency pass before you commit: compare what you built with the screens around it. Same header pattern, same place for the primary action, same component and the same word for the same concept. If the app's screens already disagree, follow the kit and mention the drift in your final message.

Quality floor: works at 360px wide, visible keyboard focus, respects reduced motion, readable contrast. Animate only to show the result of something the user did.

{{DESIGN_SELF_CHECK}}

==== END UI DESIGN ====
