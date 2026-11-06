# Mail through Brevo

Platform mail can go out through Brevo's transactional email API instead of
Gmail. This page is the operator's side of that switch. Nothing moves until
Brevo is named, by a full admin in **Admin → Email delivery** or by
`PLATFORM_MAIL_PROVIDER`: `BREVO_API_KEY` also sends SMS, so having it never
changes who sends mail. A staging preview always logs instead of sending,
whatever is set.

| File | What it does |
| --- | --- |
| `src/services/mail/transports/brevo.js` | The `POST /v3/smtp/email` call, one attempt, 8 seconds |
| `src/services/mail/select.js` | Picks it when it is named, keeps the admin's saved choice, and tells the admin card what it lacks |
| `src/services/mail/events.js` | `ingestBrevo`: what a webhook event records |
| `src/routes/mail-webhooks.js` | `POST /api/mail/webhooks/brevo` |

## Before you switch

1. In Brevo, authenticate the domain of `PLATFORM_MAIL_FROM` (default
   `Homeroom <no-reply@onhomeroom.com>`) and add that sender.
2. **Check Brevo's open and click tracking on the account.** Brevo's API has no
   way to turn click tracking off for one message, and its per-message pixel
   switch is for Enterprise plans only. Sign-in codes, password resets and the
   one-time sign-in link in the waitlist mail are meant to carry no pixel or
   redirect of any kind (`src/services/mail/events.js`, `TRACKED_KINDS`). If
   Brevo rewrites links on your account, those links pass through Brevo's
   redirect. Ask Brevo to turn it off for transactional mail, and send yourself
   a password reset to see what actually arrives.
3. Send a test from **Admin → Email delivery** once it is switched, to a mailbox you control.

## Switching in the admin console

**Admin → Email delivery** has a card, "Email is sent by", listing Gmail, the
generic HTTP API and Brevo, each marked Ready or with the names of the settings
it lacks. A full admin picks one and saves; a view-only admin can read the card.

- The choice is kept in `platform_settings` under `mail_provider` and wins over
  `PLATFORM_MAIL_PROVIDER`.
- It needs no redeploy. Every send reads it through a ten-second cache, so each
  running process follows it within seconds.
- A provider that is not ready cannot be chosen (the server answers 409 with
  what is missing). For Brevo that means `BREVO_API_KEY` is set.
- If a saved provider later loses its key, mail is reported as broken. It does
  not fall back to another provider.
- A staging preview saves the choice and goes on logging.
- Each change is recorded as a `mail_provider_changed` event with the admin and
  the two provider names.

The webhook token below still comes from the deploy's configuration: without
it Brevo sends, and the reports leave out delivered, bounced and complained.

## Configuration

| Key | Private | Meaning |
| --- | --- | --- |
| `PLATFORM_MAIL_PROVIDER` | no | `brevo` selects this transport until an admin saves a provider in the console, which wins. If it is named and `BREVO_API_KEY` is empty, mail is reported as broken rather than falling back. |
| `BREVO_API_KEY` | yes | Sent as the `api-key` header. Shared with Brevo SMS. |
| `BREVO_MAIL_WEBHOOK_TOKEN` | yes | Bearer token Brevo's webhook sends. Unset, the webhook answers 404 and the admin reports leave out delivery counts. |

On Kubernetes these are `secrets.platformMailProvider`, `secrets.brevoApiKey`
and `secrets.brevoMailWebhookToken` in the infra
repository's SOPS-encrypted values.
See the [chart configuration](../deploy/helm/social-vibecoding-platform/README.md).

## What Brevo says

Brevo only delivers. Every mail's subject and body come from the email templates
in the admin console, whichever provider sends them, and Brevo's own templates are
not used. The sender stays `PLATFORM_MAIL_FROM`. The kind's tag and headers, and
the webhook, work as before.

A `BREVO_MAIL_TEMPLATES` setting left over from before is ignored.

## The webhook

Create one transactional webhook, unbatched, with Brevo's `POST /v3/webhooks`:

```json
{
  "type": "transactional",
  "url": "https://<your-host>/api/mail/webhooks/brevo",
  "events": ["delivered", "hardBounce", "softBounce", "invalid", "blocked", "spam"],
  "auth": { "type": "bearer", "token": "<BREVO_MAIL_WEBHOOK_TOKEN>" }
}
```

## What is tracked where

**In Brevo:** every send, in its transactional logs, tagged with the mail's kind
(`otp`, `project_invite`, …), with whatever Brevo reports about it.

**On the platform:** every send is a `mail_deliveries` row with provider `brevo`
and Brevo's message id. **Admin → Email delivery** shows them, and the webhook adds:

| Brevo event | Recorded as | Address suppressed |
| --- | --- | --- |
| `delivered` | delivered | no |
| `hard_bounce`, `invalid_email` | bounced | yes |
| `soft_bounce` | bounced | no |
| `blocked` | bounced | no: Brevo refuses it already, and it can be unblocked there |
| `spam` | complained | yes |

As with Resend, a delivery event is stored for the non-transactional kinds only
(`TRACKED_KINDS`), while a suppression applies to any kind. A suppression stays
after the delivery row is pruned.

Opens and clicks on the platform come from its own link and pixel, which need
`PLATFORM_MAIL_TRACKING_SECRET`. Brevo's open and click events are not imported:
the platform's own class scanners and image proxies, and the admin Journey reads
an unclassed open as a person's.

An event for a message id with no row answers 503 for 15 minutes, in case
`send()` is still saving its receipt, and 200 after that, so mail this Brevo
account sent for something else is not retried forever.
