# Image generation: choosing models for Homeroom bot

This is a plan, not a feature. It answers the two questions Evan asked on
3 Nov 2026, when he approved the request but scoped the first step to a
written plan:

1. Which outside image providers are worth adding, what they cost against
   what they produce, and which are already on OpenRouter.
2. How image generation would fit into Homeroom bot's interface.

It also states plainly why the shape the request describes, where every app
configures its own provider endpoints and holds its own keys, cannot be
built. Nothing in this document is approved for a build yet.

For contrast, the bot's picture path today (services/bot-pictures.js) already
draws through one OpenRouter model on the platform key, refuses content that
breaks the platform rules before it calls or charges anything, keeps every
picture in the platform media store, and counts each picture against a weekly
allowance. That path is the integration target.

## What people can already do

- In a chat with Homeroom bot, ask for pictures. It draws up to four at once,
  in square (1:1), wide (16:9) or tall (9:16) shapes, and can draw a dark
  version of a light one.
- From the gallery card under the bot's reply, open a picture in the viewer,
  propose it as a project's featured picture, use it in the app, add it to a
  design, or ask for "More like A". That last one is image-to-image.
- Each picture counts toward a weekly picture allowance (24 by default) and
  toward the person's weekly building time with the bot.
- A request that breaks the content rules (sexual, violent or weapons,
  gambling, aimed at children, a real person's likeness, brands) is refused
  before anything is drawn or charged.
- One image model is used for everyone. Only an admin can change it.

## Why the request cannot be built as written

The request asks for a section where each app connects to outside image
providers through endpoints it configures and keys it manages. Homeroom's
rules forbid that:

- An app must never call an outside AI service directly.
- An app must never ask people for API keys.
- The AI access Homeroom gives apps forwards only text Conversations
  (`v1/messages` and `v1/messages/count_tokens`), not pictures
  (src/routes/app-llm-proxy.js:53).

The compliant version puts image generation inside Homeroom, on the
platform's own key and storage. Apps receive no keys and no raw provider
endpoints. Every picture still goes through the platform's content rules,
including no sexual or suggestive content, no violence or weapons, no
gambling, nothing aimed at children and no real person's likeness.

## Providers worth considering

The figures below were checked against OpenRouter's live model catalog
(`GET https://openrouter.ai/api/v1/models`) on 3 Nov 2026. The catalog held
451 models, of which 12 declare image output: ten named image models and two
Auto Routers. The ten named models are all from Google (Gemini image models,
sold as Nano Banana) or OpenAI (GPT-5 image models).

Cost per picture is still **approximate**. OpenRouter prices image output per
output token, and the number of tokens in one picture depends on the model,
the resolution and the quality setting. The per-image figures below are
derived from those token prices at typical picture sizes, so they need
confirming with a real call before any model is offered.

| Model | On OpenRouter? | Approx. cost per picture | Quality and strengths | Verdict |
| --- | --- | --- | --- | --- |
| Google Gemini 2.5 Flash Image (today's default, `google/gemini-2.5-flash-image`) | Yes, verified | about $0.04 | Good everyday pictures, strong at editing an existing picture, fast | Keep as the default for now |
| Google Gemini 3 Pro Image (`google/gemini-3-pro-image`) | Yes, verified | about $0.13 to $0.24 depending on resolution | Higher detail, much better text inside pictures, stronger reasoning about the request | Offer as "Best quality" |
| Google Gemini 3.1 Flash Image (`google/gemini-3.1-flash-image`) | Yes, verified | about $0.08 | A newer generation of the default line; the catalog has both stable and preview ids | Evaluate as the next default |
| Google Gemini 3.1 Flash Lite Image (`google/gemini-3.1-flash-lite-image`) | Yes, verified | about $0.04 | The cheapest Google image model in the catalog | Consider as the cheap option |
| Google Nano Banana 2.1 (`google/gemini-nano-banana-2.1`) | Yes, verified | about $0.04 | Google's newest branded image model; capability details still need checking | Consider once confirmed |
| OpenAI GPT-5 Image (`openai/gpt-5-image`) | Yes, verified | about $0.01 to $0.17 depending on quality | Follows long instructions closely, good at diagrams and text, expensive at high quality | Consider the Mini first |
| OpenAI GPT-5 Image Mini (`openai/gpt-5-image-mini`) | Yes, verified | about $0.002 to $0.03 depending on quality | Cheaper, good for diagrams and simple edits | Offer as the inexpensive option |
| OpenAI GPT-5.4 Image 2 (`openai/gpt-5.4-image-2`) | Yes, verified | about $0.01 to $0.13 depending on quality | OpenAI's newer image model; quality against GPT-5 Image still needs a side-by-side check | Consider once compared |
| Black Forest Labs FLUX.2 (Pro, Flex) | No, not in the catalog checked | about $0.03 to $0.06 (provider list price, unverified) | Photo-like and illustration styles, consistent results | Not now: needs a separate provider decision |
| ByteDance Seedream 4.x | No, not in the catalog checked | about $0.03 to $0.04 (provider list price, unverified) | Strong at high resolution and at editing | Not now: needs a separate provider decision |
| Google Imagen 4 | No (Google Cloud only) | about $0.02 to $0.06 | High quality text to image | Not now: needs a separate provider decision |
| Stability AI (Stable Image Core, Ultra) | No | about $0.03 to $0.08 | Many styles, supports negative prompts and seeds | Not now: needs a separate provider decision |
| Ideogram 3 | No | about $0.03 to $0.09 | Best known for lettering and posters | Not now: needs a separate provider decision |
| Recraft V3 | No | about $0.04, vector costs more | Icons, vector and brand-style art | Not now: needs a separate provider decision |
| Midjourney | No (no public API) | not available | High artistic quality | Cannot be integrated |

Two points are worth stating because they correct early assumptions:

- The first draft of this plan expected FLUX.2 and Seedream to be reachable
  through OpenRouter. The live catalog named neither, and it named no Imagen,
  Stability, Ideogram or Recraft model with image output. A provider outside
  OpenRouter would each need a separate platform decision: a contract, a key
  held only by the platform, a privacy review, and its own spend tracking and
  no-training guarantees.
- Every one of the ten image models in the catalog also advertises
  OpenRouter's Images endpoint (`/api/v1/images`) beside Chat Completions.
  The bot uses Chat Completions today. Before building, confirm which
  parameters the Images endpoint accepts (size, count, seed, negative prompt)
  rather than assuming it carries all of them.

**Recommendation:** stay on OpenRouter. It is already wired in, runs on the
platform key, reports what each call cost, and already denies the use of our
requests for training. The first build would offer a short, curated list of
three or four verified models: the current default, Gemini 3 Pro Image as
"Best quality", and GPT-5 Image Mini as the inexpensive option, with
Gemini 3.1 Flash Image evaluated as the next default. Providers outside
OpenRouter are left out of this plan.

## How it would fit into Homeroom bot

This section describes a later build. Nothing here is implemented in this
step.

1. **A curated model list, chosen by an admin.** The single `imageModel`
   setting becomes a list of enabled models. Each entry has its OpenRouter id,
   a label people see, a cost weight against the weekly allowance, and
   capability flags. `imageModel` stays as the default so stored settings keep
   working, and every id is still checked as an OpenRouter model id.
2. **A model choice in the chat.** A person can ask for a model by name ("draw
   it with the best quality model") or choose from the short list the admin
   enabled. Each choice shows what the model is good at, its relative cost and
   what it supports. Nobody ever sees a key or an endpoint.
3. **A fair allowance.** A costlier model uses more of the weekly allowance.
   For example, one "Best quality" picture could count as four. The chat says
   how much of the week is left ("10 of 24 pictures left this week") and says
   plainly when a picture failed or was refused.
4. **The gallery card names the model** that drew each picture, and "More like
   A" can be asked with a different model.
5. **A Pictures page under the AI tab** lists the pictures a person has made,
   newest first, so they can open one, download it, or ask for a variation
   later.
6. **Download** from the picture viewer.
7. **Reference pictures:** starting from a picture already in the conversation
   is what "More like" does today. Attaching a new reference picture would use
   the existing upload path, and it depends on uploads working (see #5804).
8. **Advanced parameters:** negative prompts, seeds and extra resolutions are
   offered only where the chosen model actually supports them through
   OpenRouter. They appear as a capability of that model, never as a promise
   that every model takes them.

Behind the screen, the pieces would be:

- A model allowlist in the bot settings, written only by admins. Each entry
  carries `id`, `label`, `costWeight`, `enabled` and capability flags such as
  `edit`, `aspects`, `size`, `seed`.
- `make_pictures` (src/services/homeroom-bot-thread-tools/pictures.js) and
  its `normalizeAsk` accept an optional model key, which must be in the
  allowlist. Anything else is refused in plain words, never passed through.
- The gallery card shows the model's label for each picture, and "More like"
  can carry a different model key into the next draw.
- The Pictures list reads the signed-in person's rows from
  `homeroom_bot_picture_images`, behind the same membership check as the
  existing picture route.
- The allowance line comes from `picturesThisWeek` and the configured weekly
  cap, with each model's cost weight applied.

### Content rules stay ahead of every model

The existing path already refuses obvious disallowed requests before any
call or charge, and puts the platform's rules at the front of every prompt.
That does not change with more models:

- The same `guard()` and refusal text apply to every model in the list.
- An image-to-image request is checked on its prompt as well as its source
  picture, and the no-real-person-likeness rule stays in the prompt.
- Every model must accept the prompt rules. A provider whose own policy cannot
  carry them is not eligible, whatever its quality.
- The existing no-training provider settings stay on every call.
- A model that returns no picture is still a failure the person hears, never
  an empty gallery.

## How related requests fit in

- **#5319** asks for real image and video generation inside Pixmotion AI, an
  app. Like this request, it needs Homeroom to give apps an image capability:
  a picture service the platform runs and meters per app, never an app holding
  keys. This plan's model list would serve both. Video is out of scope: no
  video model is offered through this path today, and video costs far more per
  clip.
- **#5804** reports a bug uploading to storage. Reference picture uploads and
  a Pictures page both depend on uploads working, so that bug should be fixed
  before those parts are built. This plan does not change it.

The full text of #5319 and #5804 could not be read from this checkout, so the
description above relies on how the request's discussion summarized them.

## Decisions the platform team still has to make

1. Which models are enabled at launch, and which one is the default.
2. Whether to keep Chat Completions or move to OpenRouter's Images endpoint.
3. The cost weight of each model against the 24-picture weekly allowance.
4. Which resolutions and shapes are offered per model.
5. Whether people may choose any enabled model or only the default plus a
   named alternative.
6. How long generated pictures are kept, and whether the Pictures page is the
   only history.
7. Whether apps get a metered image route for #5319, and on what terms.

## What this step changes

No runtime code. It adds this document only. It adds no configurable
endpoints, no key management, no new providers, no new declared checks and no
interface text. The proposal for it declares that nobody sees a change.

| File | Change |
| --- | --- |
| `docs/plans/image-generation.md` | New: this plan |

## Grounding

| Fact | Where |
| --- | --- |
| Default model `google/gemini-2.5-flash-image`, weekly cap 24, `ESTIMATED_USD_PER_IMAGE = 0.04` (used only when OpenRouter reports no `usage.cost`), four pictures at once | src/services/bot-pictures.js:46, 47, 64, 66 |
| Drawn through Chat Completions with `modalities: ['image', 'text']` and `image_config.aspect_ratio` from `ASPECTS` (square 1:1, wide 16:9, tall 9:16). Image-to-image runs through `sourceImage` and `fromImage` ('variant', 'like'). Every request carries the no-training provider settings (#5123) | bot-pictures.js `buildImageRequest`, `promptFor`, `withNoTraining` |
| Content-rule pre-check `guard()` (sexual, violence and weapons, gambling, children, real people, brands) before any call or charge, plus the rules in the prompt itself | bot-pictures.js `GUARDS`, `guard`, `refusalText` |
| Pictures stored in the media store, referenced by `homeroom_bot_picture_images`, served at `GET /api/conversations/homeroom-bot/pictures/:id` to chat members only | bot-pictures.js, src/services/media-store.js |
| `imageModel` is one OpenRouter model id, checked by `MODEL_ID_RE` and written by admins only (`PUT /api/admin/homeroom-bot/settings`). No shell screen shows it | src/services/homeroom-bot.js:308, 700, 1020; src/routes/admin.js:1721 |
| Gallery card: letters A to D, viewer, Propose / Use / More like, "Paid from your weekly building time" | frontend/src/features/messages/bot-cards/gallery.tsx |
| Build workers draw through `generateForSession` | bot-pictures.js:851, src/routes/internal.js |
| The app-facing proxy forwards only `v1/messages` and `v1/messages/count_tokens` | src/routes/app-llm-proxy.js:53 (the discussion cited line 64, which has moved) |

## Tests

None are added, because no runtime code changes. The repository's whole-tree
guards still run on this file through `npm run test:changed`; it contains no
em dashes.
