---
title: "Usernode Final Polish Boundary — Product Imagery and Motion"
tags: [usernode, frontend, product-imagery, motion, scope]
status: active
created: 2026-08-02
---

# Final polish: governed no-change dispositions

This record closes the product-imagery and motion questions in the final
interface-polish batch. Lead-claude accepted both dispositions in Buzz event
`73be11bbc67f94b659e39c4e0cd4f4c5c9aa9297fef77f8e22c402d4f42463fc`.

## Product imagery

No source change is justified. The challenge view model, lifecycle source, and
application programming interface response contain no artwork or image field,
and the repository owns no challenge artwork. Adding imagery in this batch
would therefore invent product data or assets rather than render an existing
capability.

Evidence:

- `frontend/@/features/community/challenges.tsx`: `ChallengeItem` carries text,
  reward, progress, status, and lifecycle fields only.
- `frontend/@/lib/challenge-lifecycle.ts`: `ChallengeLifecycleSource` contains
  no artwork or image field.
- `frontend/@/lib/challenges-api.ts`: challenge transport types contain no
  artwork or image field.
- Buzz workspace `PLANS/USERNODE_BLOCK7_AUDIT_SKILL_SPEC_2026_08_02.md`:
  product imagery is an outside-capability gap for this program, not an
  unimplemented polish item.

## Motion

No source change is justified. The current shell guide explicitly reserves the
platform-menu appearance pulse as a future candidate and rejects durations,
easing, status animation, or attention animation until a separate motion
contract supplies evidence. This batch has no approved trigger or reduced-motion
contract, so adding animation would manufacture interaction behavior.

Evidence:

- `docs/shell-refinement-guide.md`, “The three signatures”: the appearance pulse
  is a future candidate, not a current dependency or acceptance requirement.
- `docs/shell-refinement-guide.md`, “Explicit deferrals”: motion values and
  attention pulses remain deferred until a separate evidence-backed contract.
- Buzz workspace `PLANS/USERNODE_BLOCK7_AUDIT_SKILL_SPEC_2026_08_02.md`: motion
  is an outside-capability gap for this program, not an unimplemented polish
  item.

## Reopening rule

Either question may reopen only with truthful product inputs: owned imagery or
an image-bearing data contract for product imagery; an approved trigger,
reduced-motion behavior, and evidence-backed timing contract for motion.
