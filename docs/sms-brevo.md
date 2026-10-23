# SMS through Brevo

Homeroom sends two kinds of text: a sign-in code (transactional) and, for a
later campaign, a marketing message (promotional). Firebase Phone Auth sends
sign-in codes until an admin picks Brevo in **Admin → Platform → SMS
delivery**. This page is the operator's side of that switch: what to set, the
exact calls the platform makes, and what Brevo and the recipient countries
require.

The implementation lives in `src/services/sms/`:

| File | What it does |
| --- | --- |
| `select.js` | Which provider sends, the 10-second cached admin switch, readiness |
| `countries.js` | Country of an E.164 number, US/Canada registration, quiet hours |
| `senders.js` | Parses and enforces the country-to-Sender-ID registry |
| `brevo.js` | The `POST /v3/transactionalSMS/send` client, bounded retries |
| `otp.js` | Homeroom's own hashed, expiring, single-use sign-in codes |
| `index.js` | `sendOtpSms`, `sendMarketingSms`, `sendTestSms`, consent helpers |

## Environment variables

Declared in `dapp.json` under `platform_env` (group **Phone sign-in**), read
by `src/config.js`. No secret is ever hardcoded or returned by an API.

| Key | Private | Default | Meaning |
| --- | --- | --- | --- |
| `PLATFORM_SMS_PROVIDER` | no | `firebase` | `firebase` or `brevo`. An admin's saved choice wins; an unknown value falls back to Firebase with a boot warning. |
| `BREVO_API_KEY` | yes | | Sent as the `api-key` header. The status card reports presence only. Not needed on staging, which never sends. |
| `BREVO_SMS_SENDER_IDS` | no | `{}` | JSON object keyed by ISO 3166 alpha-2 country. `{"FR":"Homeroom"}` or `{"US":{"sender":"18885550100","registered":true,"optOut":"Reply STOP to opt out"}}`. A sender is 3–11 alphanumerics or up to 15 digits. A malformed entry is logged and dropped. |
| `BREVO_SMS_WEBHOOK_TOKEN` | yes | | Bearer token Brevo's SMS webhook sends. Unset leaves `POST /api/sms/webhooks/brevo` answering 404. |

On Kubernetes, supply the key as `secrets.brevoApiKey` and the JSON string as
`secrets.brevoSmsSenderIds` in the infra repository's SOPS-encrypted Helm
values, then sync Argo CD. The chart imports them through the platform Secret
and its checksum rolls out both web and conductor Pods. The **Platform
variables** panel does not apply values to Kubernetes. See the
[chart configuration](../deploy/helm/social-vibecoding-platform/README.md).

A staging preview (`USERNODE_ENV=staging`) always logs instead of sending,
like platform mail: the code appears only in the preview's log, and no real
text ever leaves a branch nobody voted on.

## The calls the platform makes

The endpoint is the same for both kinds; `type` is what Brevo keeps apart.
The example in the request is the OTP payload:

```json
{
  "sender": "Homeroom",
  "recipient": "33680065433",
  "content": "Your Homeroom code is 123456",
  "type": "transactional",
  "tag": "otp"
}
```

Homeroom sends exactly that shape, with the recipient in E.164 **without the
leading `+`** (the example above), the Sender ID resolved from the recipient
country's registry entry, and the `api-key` header. A successful answer's
`messageId` is stored beside the delivery and shown to the admin.

### OTP example

A `POST /api/auth/phone/request` for `+33680065433` when Brevo is selected:

1. `services/sms/otp.js` makes a six-digit code and stores only
   `sha256(session)` and `sha256(session:code)`, expiring in ten minutes.
2. `sendOtpSms` resolves the country (`FR`), finds `Homeroom` in the
   registry, and sends:

```json
{
  "sender": "Homeroom",
  "recipient": "33680065433",
  "content": "Your Homeroom code is 123456. It expires in 10 minutes.",
  "type": "transactional",
  "tag": "otp"
}
```

3. `sms_deliveries` gets one row: kind `otp`, provider `brevo`, country `FR`,
   sender `Homeroom`, status `sent`, Brevo's message id, and the number's
   last four digits only. The code works once, for ten minutes, and five
   wrong tries end it.

### Marketing example

Marketing has no screen yet. When a caller has a recorded opt-in for the
number and the country is inside its quiet hours:

```js
const sms = require('./src/services/sms');
await sms.sendMarketingSms(pool, config, {
  phoneNumber: '+33680065433',
  content: 'New this week on Homeroom.',
});
```

which sends:

```json
{
  "sender": "Homeroom",
  "recipient": "33680065433",
  "content": "New this week on Homeroom. Reply STOP to unsubscribe",
  "type": "marketing",
  "tag": "marketing"
}
```

The opt-out line comes from the country's registry `optOut`, or defaults to
"Reply STOP to unsubscribe", and is appended only when the content does not
already say STOP. Before that, `sendMarketingSms` refuses with `no_consent`,
`opted_out` or `quiet_hours`. A `Reply STOP` reaches the webhook below and
records the opt-out; sign-in codes still reach that number.

## Brevo webhook

In Brevo, point the SMS webhook at:

```
https://<your-host>/api/sms/webhooks/brevo
```

and send `Authorization: Bearer <BREVO_SMS_WEBHOOK_TOKEN>`. The route is
mounted before the session and JSON-parser middleware, compares the token in
constant time, and answers 404 when no token is set. It records an opt-out
for an `unsubscribe`/`unsubscribed` event or a `reply` whose text is one of
STOP, STOPALL, UNSUBSCRIBE, END, QUIT, CANCEL, ARRET, and updates a delivery
row's `delivery_status` for any other event carrying a message id and a
status. Everything else is answered 200 and ignored.

## Retries

At most three attempts, 500 ms then 1500 ms apart, and only on HTTP 429, a
5xx or a connection error before any response. A 4xx refusal is never
retried, and neither is a timeout: Brevo may already have sent the text.

## Country compliance — what this platform does and does not do

- **Sender ID registration is mandatory per country.** Brevo registers Sender
  IDs in its own dashboard and exposes no API to list them, so
  `BREVO_SMS_SENDER_IDS` is maintained by hand and must be kept in step with
  the dashboard. A country not in the registry is refused, not tried.
- **The United States and Canada need more than a sender.** A US or Canadian
  number needs a registered toll-free or 10DLC number and its campaign
  approved before any text (marketing or transactional) may go out. The
  registry marks that as `"registered": true` with a numeric sender; without
  both, the send is refused with `country_not_registered`. US and Canadian
  numbers are told apart by area code.
- **Marketing is promotional.** It needs prior recorded opt-in, a working
  STOP path and the recipient country's quiet hours. Homeroom encodes France
  (08:00–20:00 Paris, no Sundays) and the US/Canada (11:00–20:00 Eastern,
  which keeps every mainland time zone between 08:00 and 21:00). Quiet-hour
  sends are refused, not queued. Public holidays are not tracked, and no
  other country's window is encoded — its rules remain the operator's
  responsibility.
- **Some countries ignore or replace alphanumeric senders** with a local
  long number or short code regardless of the registry. Brevo's own
  country-specific guidelines and restrictions still apply after every check
  here passes.
- **Transactional and promotional are kept apart** (`type`), so the sign-in
  code path is not subject to marketing opt-outs. Brevo's own compliance
  reporting uses that distinction too.
- **No full number is stored** in the delivery log; only its last four digits,
  the country and the Sender ID are kept there. The sign-in code itself is
  never stored, only its hash.

## Notifications and admin

**Admin → Platform → SMS delivery** shows the switch (Firebase or Brevo),
each provider's readiness and any missing settings, the Sender IDs the
registry holds, a test send, and the 50 most recent texts. Only a full admin
can change the provider or send a test; any admin can read the section.
