# SMS through Twilio

Twilio is the third choice in **Admin → Platform → SMS delivery**, beside
Firebase and Brevo, and it works the way Brevo does: Homeroom makes, hashes
and checks the sign-in code itself (`services/sms/otp.js`), and Twilio only
carries the text. Everything in [SMS through Brevo](sms-brevo.md) about codes,
the delivery log, marketing consent, quiet hours, staging and country
compliance applies unchanged. This page covers what is different.

The client is `src/services/sms/twilio.js`; `index.js` hands a send to it when
Twilio is the selected provider.

## Environment variables

Declared in `dapp.json` under `platform_env` (group **Phone sign-in**), read
by `src/config.js`.

| Key | Private | Default | Meaning |
| --- | --- | --- | --- |
| `PLATFORM_SMS_PROVIDER` | no | `firebase` | `firebase`, `brevo` or `twilio`. An admin's saved choice wins. |
| `TWILIO_ACCOUNT_SID` | no | | The Account SID (`AC…`), the user half of the Basic credential. |
| `TWILIO_AUTH_TOKEN` | yes | | The Auth Token: the password half, and the key Twilio signs webhooks with. The status card reports presence only. |
| `TWILIO_SMS_SENDER_IDS` | no | `{}` | Twilio's own country registry, the same shape as `BREVO_SMS_SENDER_IDS`. |
| `TWILIO_STATUS_CALLBACK_URL` | no | | This server's public webhook URL, e.g. `https://app.onhomeroom.com/api/sms/webhooks/twilio`. |

Neither credential is needed on a staging preview, which logs instead of
sending. On Kubernetes, supply them as `secrets.twilioAccountSid`,
`secrets.twilioAuthToken`, `secrets.twilioSmsSenderIds` and
`secrets.twilioStatusCallbackUrl` (see the
[chart configuration](../deploy/helm/social-vibecoding-platform/README.md)).

## Sender IDs are registered per provider

A Sender ID approved at Brevo is not approved at Twilio, so Twilio has its own
registry and never reads Brevo's. List only what Twilio's console shows as
approved for each country. An entry is either a sender string or
`{sender, registered, optOut}`:

```json
{
  "FR": "Homeroom",
  "US": { "sender": "18885550100", "registered": true }
}
```

An alphanumeric sender is sent as it is. A numeric sender of seven digits or
more is a phone number and goes out in E.164 (`+18885550100`); a shorter one
is a short code. As with Brevo, an unlisted country is refused, and the
United States and Canada need `"registered": true` with a numeric sender (a
toll-free or 10DLC number whose registration Twilio has approved).

## The call the platform makes

```
POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
Authorization: Basic base64(AccountSid:AuthToken)
Content-Type: application/x-www-form-urlencoded

To=+33680065433&From=Homeroom&Body=Your Homeroom code is 123456. It expires in 10 minutes.
```

With `TWILIO_STATUS_CALLBACK_URL` set, `StatusCallback` names it too. The
answer's `sid` (`SM…`) is stored as the delivery's message id; a refusal's
numeric `code` (21211 invalid number, 21610 the number replied STOP, 21408 a
country not enabled in Geo Permissions …) is stored as the provider code and
shown in the admin console. Retries follow Brevo's rule exactly: at most three
attempts, only on 429, a 5xx or a connection error, never on a timeout.

Twilio has no transactional/marketing field. Marketing texts still pass
Homeroom's consent, opt-out and quiet-hour gates before they reach Twilio.

## Webhook

Point both of these at the URL in `TWILIO_STATUS_CALLBACK_URL`:

- the status callback, which every message names itself, and
- the sending number's (or Messaging Service's) **A message comes in**
  webhook, for STOP replies.

Twilio sends no token. `POST /api/sms/webhooks/twilio` checks
`X-Twilio-Signature`, an HMAC-SHA1 of that exact URL plus the sorted form
parameters keyed by `TWILIO_AUTH_TOKEN`, and answers 404 while either the URL
or the token is unset and 401 for a signature that does not match. A reply
Twilio marks `OptOutType=STOP`, or whose body is a STOP word, records a
marketing opt-out for the sender. A `MessageSid` with a `MessageStatus`
updates the delivery's status. Every other request is answered with an empty
TwiML document, so Twilio sends no reply text. Twilio's own STOP handling
also stops further texts from that sender to that number, including sign-in
codes, until the person replies START.
