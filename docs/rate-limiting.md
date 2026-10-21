# Request rate limits

The API applies a fixed-window limit by client IP to account registration, login, new submissions, and re-runs:

| Request type          |             Limit |
| --------------------- | ----------------: |
| Registration          |        5 per hour |
| Login                 | 10 per 15 minutes |
| Submission and re-run |     20 per minute |

Requests over the limit receive HTTP `429`, a structured `RATE_LIMITED` API error, and a `Retry-After` header. Response headers report the configured limit, remaining requests, and seconds until reset. The middleware stores only request counts and reset times; it does not retain request bodies or submitted source.

The counter store is in memory and shared by requests handled by one API process. This matches the current single API service. If the API is later run as multiple replicas, use a shared rate-limit store so a client cannot get a fresh allowance from each process. Redis is permitted for this narrow purpose if deployment needs it; it is not required by the current compose setup.

Express trusts no proxy by default. Set `TRUST_PROXY_HOPS` to the number of known reverse proxies in front of the API so `request.ip` uses the client's forwarded address. Do not set this to an arbitrary value: trusting headers from an uncontrolled proxy lets clients spoof their rate-limit key. The default is `0` for direct local access.

## Learning notes

- **Problem solved:** repeated login guesses, account creation, and queued work are bounded before they consume unbounded API or worker capacity.
- **Why a fixed window:** it is easy to explain and adequate for the first single-process deployment; it avoids introducing Redis before horizontal API replicas exist.
- **Important failure case:** an in-memory counter resets on process restart and does not coordinate replicas. A multi-replica deployment must switch to a shared store before relying on these limits.
- **Interview question — Why key limits by IP?** Authentication and anonymous registration happen before there is a trusted account identity, so the request's client network address is the common available key.
- **Interview question — What does `TRUST_PROXY_HOPS` control?** It tells Express how many known proxy addresses to skip when deriving the client IP from forwarded headers.
