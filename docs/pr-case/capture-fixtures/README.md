# Frozen capture fixture

`tailwind-play-2026-08-04.js.gz` is the response body fetched from
`https://cdn.tailwindcss.com/` on 2026-08-04 for the pinned current-main
comparison capture.

- Uncompressed SHA-256: `176e894661aa9cdc9a5cba6c720044cbbf7b8bd80d1c9a142a7c24b1b6c50d15`
- The capture harness serves this response only to the archived main page.
- It is not imported by the product, the deck, or the Storybook build.
- Freezing the payload removes a moving network dependency from the visual
  receipt and makes the before image reproducible after the public endpoint
  changes.
