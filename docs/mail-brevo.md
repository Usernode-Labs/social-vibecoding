# Mail through Brevo

Platform mail can go out through Brevo's transactional email API instead of
Gmail. This page is the operator's side of that switch. Nothing moves until
`PLATFORM_MAIL_PROVIDER` says `brevo`: `BREVO_API_KEY` also sends SMS, so having
it never changes who sends mail. A staging preview always logs instead of
sending, whatever is set.

| File | What it does |
| --- | --- |
| `src/services/mail/transports/brevo.js` | The `POST /v3/smtp/email` call, one attempt, 8 seconds |
| `src/services/mail/select.js` | Picks it when it is named, and tells the admin card what it lacks |
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

## Configuration

| Key | Private | Meaning |
| --- | --- | --- |
| `PLATFORM_MAIL_PROVIDER` | no | `brevo` selects this transport. If it is named and `BREVO_API_KEY` is empty, mail is reported as broken rather than falling back. |
| `BREVO_API_KEY` | yes | Sent as the `api-key` header. Shared with Brevo SMS. |
| `BREVO_MAIL_WEBHOOK_TOKEN` | yes | Bearer token Brevo's webhook sends. Unset, the webhook answers 404 and the admin reports leave out delivery counts. |
| `BREVO_MAIL_TEMPLATES` | no | Which kinds use a template kept in Brevo, as JSON: `{"project_invite":12}`. Empty means every mail uses Homeroom's templates. |

On Kubernetes these are `secrets.platformMailProvider`, `secrets.brevoApiKey`,
`secrets.brevoMailWebhookToken` and `secrets.brevoMailTemplates` in the infra
repository's SOPS-encrypted values.
See the [chart configuration](../deploy/helm/social-vibecoding-platform/README.md).

## Using Brevo's templates

By default every mail is written by `src/services/mail/templates.js`. A kind
listed in `BREVO_MAIL_TEMPLATES` is sent with that Brevo template instead, using
its subject and body. Kinds not listed are unchanged, so they can move one at a
time. The template must use Brevo's New Template Language, and be active.

The sender stays `PLATFORM_MAIL_FROM`, whatever the template says. The kind's tag
and headers, and the webhook, work as before.

A template reads the values the mail was sent with as `{{ params.<name> }}`. An
empty value is left out, so `{% if params.code %}` works.

| Kind | Params |
| --- | --- |
| `otp`, `account_email`, `username_change` | `code` |
| `password_reset` | `url` |
| `waitlist_joined` | `code`, `url`, `confirmUrl` |
| `waitlist_code` | `code`, `confirmed`, `confirmUrl`, `statusUrl` |
| `waitlist_released` | `url`, `hasAccount`, `signInLink`, `mobile.ios`, `mobile.android` |
| `project_invite` | `inviter`, `project`, `url` |

For any other kind, read what its caller passes to `send()` and what its template
in `templates.js` reads.

**What you give up on a kind you move:**

- **Nothing checks the template.** If it leaves out `params.code` or uses a name
  that is not there, the mail goes out without it, and nothing on the platform
  notices. Send one to yourself before relying on it. An activity mail's template
  must show `params.unsubscribeUrl` itself.
- **Edits go live at once**, with no proposal or vote. Sign-in codes and password
  resets are safest left on Homeroom's templates.
- **No opens or clicks on the platform.** The platform's own link and pixel are in
  its templates, so a mail sent with a Brevo template is recorded as untracked and
  reports only delivery. Brevo's open and click events are still not imported.
- **English only.** Somebody whose language is not English gets Homeroom's
  template, translated, so they still read it in their own language.

If Brevo refuses a template with a 400 or 404 (deleted, inactive, a wrong id),
nothing was sent, so that mail goes out with Homeroom's template and the platform
logs an error. An entry naming an unknown kind or a bad id is logged and ignored,
and so is the whole setting if it is not a JSON object. `admin_test` cannot be
moved, so **Send a test** does not exercise a Brevo template.

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
