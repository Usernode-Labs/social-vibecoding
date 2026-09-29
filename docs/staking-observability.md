# Direct device reads for Profile staking

Homeroom supplies `{ chainId, observabilityUrl }` from the authenticated
`GET /api/me/staking/context` endpoint. The origin comes from the existing
`STAKING_OBSERVABILITY_URL` platform variable; its default is unchanged.
Changing that variable takes effect on the next platform deployment.

The phone/WebView reads these public observability endpoints directly:

- `GET /v1/observability/vrf/producer-stats?sender=<wallet>&period=current_epoch`
- `GET /v1/observability/vrf/slots?sender=<wallet>&epoch=<epoch>`

Historical producer-stat reads use `period=epoch&epoch=<epoch>`. Validation,
counter calculation and the decision to permanently cache a completed epoch
run on the device. Both full responses are retained under the existing
chain/wallet/epoch cache key. Homeroom does not fetch or process epoch data.

## Required observability deployment change

The receiver currently omits CORS headers. On 2026-09-17 a real Chromium
request from `https://my.onhomeroom.com` was blocked for that reason even
though a direct HTTP client received 200. Deploying this Homeroom proposal
alone will therefore not restore live epoch loading.

Enable CORS on the **observability receiver or its gateway**, for the two
read-only endpoints above. This is not a Homeroom platform variable.
The receiver source is in the `Usernode-Labs/usernode` repository under
`tools/observability-hub-receiver/src/main.rs`, in `add_api_routes`.
That router currently has no CORS layer. A gateway configuration can supply
the same headers without a receiver code change, if the deployment owns one.

Because these are already public GET APIs and the client uses
`credentials: omit`, their responses can include:

```http
Access-Control-Allow-Origin: *
```

Apply the header to error responses as well as successful responses. Limit
the policy to these public reads; there is no need to enable cross-origin
ingestion or credentialed requests. The client sends only a standard Accept
header and does not require a preflight or authorization header.

If policy requires an origin allowlist instead, allow the production
Homeroom origin and its authorized preview origins. Return the matched
origin in `Access-Control-Allow-Origin` and include `Vary: Origin`.
Do not use `no-cors`, disable WebView security, or reintroduce a server proxy:
an opaque response cannot supply the epoch JSON.

## Verify before rollout

1. From an authenticated Homeroom page, confirm the context endpoint returns
   the expected HTTPS receiver origin and canonical chain ID.
2. Open Profile → Staking while Active. Browser network tools must show
   producer-stats and slots requests going to the receiver, with successful
   readable responses and no Homeroom cookies, authorization or referrer.
3. Confirm the current epoch paints first, then the prior epoch is fetched.
   Swipe through history and reopen the sheet to verify completed responses
   remain available from the device cache.
4. Simulate a receiver failure and retry. The sheet must recover without a
   server fallback. Delegated mode must show only Undelegate and make no
   epoch requests.

Local browser verification uses two real HTTP origins to cover both allowed
and blocked CORS, without disabling browser security. Repeat the real
receiver check after its CORS deployment; fixture success does not establish
that the external dependency is configured.
