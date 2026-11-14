# Pixlings Edge Gateway

A small, opt-in Cloudflare Workers service that puts Pixlings' SerpApi location discovery and Gemini generation calls behind a private provider boundary. The original browser → Node API flow and the existing seed/heuristic fallback behavior are retained. ElevenLabs and Meta calls are unchanged. No new browser credentials, database, or frontend migration.

```
Browser → existing Node backend → authenticated Worker → SerpApi / Gemini
            original routes          fixed provider routes
```

## What it does

- Authenticates the Node service with a server-side bearer secret (minimum 32 characters); rejects unknown routes and methods and does not forward arbitrary URLs or follow redirects.
- Validates the existing location search categories, coordinates, JSON request shape, and Gemini text/image payloads. Enforces bounded request and response sizes.
- Applies separate Cloudflare rate-limiting bindings (30 SerpApi and 20 Gemini requests/minute per location by default); rejects before contacting paid providers. These limits are **approximate per Cloudflare location**, not strict global quota or per-player authentication. Configure provider spending caps and consider per-player rate limiting at the public Node API separately.
- Aborts upstream requests after 15s (SerpApi) or 30s (Gemini), including response reads; returns generic errors and request IDs instead of exposing provider credentials or error details.
- Logs route, status, error code, request ID and elapsed time. Does not log or cache prompts, images, location coordinates or API keys. No response caching is added because location data and proof content require privacy and provider-policy review. Existing Node cache and fallback logic are unchanged.

## Local checks

Run from `edge-gateway` with Node 22.16+:

```sh
npm install
npm test
npm run typecheck
```

The tests use injected fetch and rate-limit bindings (no credentials or paid API calls). They exercise authentication, input validation, rate limiting, provider failure/timeout handling, and the Node client. Run the existing app's `npm test` separately at repository root. Node's built-in test runner with TypeScript stripping is used to avoid an extra test framework.

## Run against the actual app

1. Copy `.dev.vars.example` to `.dev.vars` inside `edge-gateway`. Generate a random secret (for example, `openssl rand -hex 32`) and set `GATEWAY_TOKEN`, `SERPAPI_API_KEY`, `GEMINI_API_KEY`. Optionally set `GEMINI_ENDPOINT=vertex` or `studio` and `GEMINI_MODEL` to match your existing provider configuration. Keep `.dev.vars` private.
2. Start the Worker: `npm run dev` (normally `http://localhost:8787`).
3. In the root `.env`, set `PIXLINGS_GATEWAY_URL=http://localhost:8787` and `PIXLINGS_GATEWAY_TOKEN` to the identical random secret. Start the Node app with `npm start`. Existing API keys can remain in `.env` during development; once the gateway URL is set, SerpApi and Gemini use the Worker, not direct fallback calls. Existing seed/heuristic fallback paths still apply on gateway failure.
4. Open the app, request daily quests, submit a proof or use pet chat, and inspect gateway logs. Confirm provider responses and fallback behavior. Test with dummy/mock providers first if you do not want to incur API charges. Unset `PIXLINGS_GATEWAY_URL` to revert to the original direct provider path.

## Deploy (not done by this change)

Use a development Cloudflare account/environment first. Run `npx wrangler login`, then set the three secrets using `npx wrangler secret put GATEWAY_TOKEN`, `npx wrangler secret put SERPAPI_API_KEY`, and `npx wrangler secret put GEMINI_API_KEY`. Check the configured model/endpoint, change the rate-limit namespace IDs if already in use in your account, and run `npm run deploy`. Use the emitted HTTPS Worker origin as `PIXLINGS_GATEWAY_URL` and set the matching token on the Node/Vercel server, never in public frontend configuration. Do not modify the original production deployment until you've completed the development smoke tests and obtained teammate approval.

The local tests do not simulate Cloudflare's actual globally distributed runtime, validate Wrangler bindings against an account, or establish a production latency improvement. The extra network hop can increase latency; the intended benefit is a provider boundary and centralized policy. Keep provider usage budgets enabled. See [Workers rate-limiting documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
