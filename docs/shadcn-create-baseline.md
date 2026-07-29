# shadcn Create baseline record

**Status:** Exact proposal; user freeze required before application

**Date:** 2026-07-29

**Scope:** React shell upstream primitive and theme baseline

## Decision record

[shadcn Create](https://ui.shadcn.com/create) is the shell's upstream baseline
selector. The current project and proposed Luma target resolve as follows:

| Field | Current | Proposed target |
| --- | --- | --- |
| Preset code | `b2fA` | `b1VlIttI` |
| Primitive base | Base UI | Base UI |
| Style | Nova | Luma |
| Base color | Neutral | Neutral |
| Font | Geist | Inter |
| Icons | Lucide | Lucide |
| Radius | Default | Default |
| Menu accent | Subtle | Subtle |
| Menu color | Default | Default |

`b1VlIttI` is the exact official Base UI + Luma proposal. It is not yet
authorized for application. G0 in
[`shell-execution-plan.md`](shell-execution-plan.md) requires explicit review
of the decoded preset, including the intentional Geist → Inter change. If
reviewers prefer Luma with Geist, Create must generate a new opaque code and
this record must be replaced before implementation.

Do not manually decode the code or construct its URL. Reproduce the record with
the project package runner:

```sh
pnpm dlx shadcn@latest preset resolve --json
pnpm dlx shadcn@latest preset decode b1VlIttI
pnpm dlx shadcn@latest preset url b1VlIttI
```

Record the CLI version and generated URL in the implementation PR evidence.

## Reconnaissance evidence

A fresh official Base UI + Luma scratch project generated the same 29 official
primitives currently installed by this project:

- 3 files were byte-identical;
- 26 files differed;
- aggregate change: 449 insertions and 183 deletions.

Largest component diffs:

| Component | Changed lines |
| --- | ---: |
| `select` | 197 |
| `alert-dialog` | 157 |
| `tabs` | 70 |
| `sidebar` | 39 |
| `input-group` | 25 |
| `button` | 24 |

This is a structural component-style migration, not a palette swap. The result
validates a scratch comparison and component-by-component merge. A blanket
`apply` or overwrite is prohibited.

## Authority consequence

Once frozen, the Create preset owns upstream style, primitive base, geometry,
density, fonts, icons, radius, menu treatment, and baseline theme. Usernode
DTCG owns product semantics only: finite app identity, truthful status,
attention, and theme-storage compatibility. Owned shell patterns own platform
behavior. The content guidelines own words.

## Adoption gate

Production adoption may begin only when:

1. reviewers accept `b1VlIttI` or replace it with another exact code;
2. `preset decode` reproduces the reviewed fields;
3. the font choice is explicit;
4. all 26 differing primitives have a merge disposition;
5. one integration owner is assigned to shared primitives and global CSS.
