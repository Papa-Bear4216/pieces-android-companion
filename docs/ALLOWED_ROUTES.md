# ALLOWED_ROUTES.md — evidence log

Live discovery against PiecesOS 12.5.0, `http://127.0.0.1:39300` (see correction below),
2026-07-26. Every route below was either called directly with `curl` or read verbatim
from the official `@pieces.app/pieces-os-client@4.1.0` TS client source (installed to a
scratch dir and inspected — not guessed, not taken from docs/memory).

**No route is added to the proxy allowlist unless it appears in this file with evidence.**

## Correction to task brief

Brief assumed PiecesOS listens on `http://127.0.0.1:1000`. Live check found:

```
Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 39300
  → 127.0.0.1:39300, owned by pieces_for_x (PID confirmed running)
```

Port 1000 is not listening. **Actual base URL: `http://127.0.0.1:39300`.**
Confirm this hasn't drifted before building the proxy against it — PiecesOS is known to
occasionally change its listening port across versions/reinstalls; the proxy setup step
should re-verify at install time rather than hardcode 39300 blindly (see README).

## Confirmed working (200, real response body)

| Method | Path | Purpose | Evidence |
|---|---|---|---|
| GET | `/.well-known/health` | liveness check | `curl` → `ok:29943f30-c772-4530-a0f8-e22071d9e69f` |
| GET | `/.well-known/version` | version string | `curl` → `12.5.0` |
| GET | `/conversations` | list conversations ("Recent") | `curl` → 200, 29549 bytes, real conversation objects (id, name, created, updated, messages.indices) |
| GET | `/assets` | list assets/snippets | `curl` → 200, 81111 bytes, real asset objects (id, name, creator, created, formats) |
| GET | `/assets/search?query=<text>` | full-text-ish search over assets | `curl` → 200, real matching asset returned for query "android" (found the actual task-brief snippet saved earlier this session) |
| POST | `/qgpt/relevance` (body: `{"query": "<text>"}` only, no scope) | first phase of Ask flow — embeds query, returns relevant snippets | `curl` → 200, `{"relevant":{"iterable":[]}}` — clean, documented behavior when no search space (paths/seeds/assets/database) is given |

## Confirmed to exist, but broken/unusable in this PiecesOS install right now

| Method | Path | What happened |
|---|---|---|
| POST | `/qgpt/relevance` with `options.database:true` | HTTP 500 `"qGPT Relevance Endpoint failed."` |
| POST | `/qgpt/relevance` with `assets.iterable:[{"id": "<real-asset-id>"}]` | HTTP 500 `"qGPT Relevance Endpoint failed."` |
| POST | `/qgpt/relevance` with `options.question:true` (any scope) | HTTP 500, same error |
| POST | `/qgpt/question` (direct, `relevant.iterable: []`) | HTTP 500 `"qGPT Question Endpoint failed."` |

**Read on this:** the route/shape itself is real — confirmed from the official TS client's
`QGPTApi.js`, and the plain no-scope relevance call succeeds cleanly at 200. The moment an
actual answer-generation path is exercised (full-DB search, asset-scoped search, or the
`question:true` shortcut), the server 500s consistently. Most likely cause: no LLM
model/runtime configured for this PiecesOS install (local or cloud-backed) — not a wrong
path or wrong request shape on our end. **This blocks a working "Ask" feature until
resolved on the PiecesOS side.** Needs your input: check Pieces desktop app settings for
model configuration before the mobile Ask screen can do anything beyond a "service
unavailable" state.

**Root cause confirmed (2026-08-01):** `GET /models` (documented in the
`pieces-os-client-openapi-spec` repo, not in `docs.pieces.app`) returns a live snapshot of
every model PiecesOS knows about. On this install, all 98 models — cloud and local —
show `"downloaded": false, "loaded": false`. That's the entire explanation: `/qgpt/*`
500s because there is genuinely no model backing answer generation, not a request-shape
or path problem. `GET /model/{id}` returns the same per-model detail; `POST
/model/{id}/download` then `POST /model/{id}/load` are the fix (both accept only the
model's UUID as a path param, no request body). Download is async — the response comes
back immediately with `downloaded: false`, so poll `GET /model/{id}` for `downloaded:
true` before calling `/load`.

Triggered a live test: `POST /model/6023776a-aea6-4369-8041-e26b690eaddb/download`
(`qwen3:4b-q4_K_S` — chosen because it's small, fully local, and needs no cloud API key,
unlike every `cloud: true` entry in the list such as the Claude/GPT/Gemini chat models).

**Download succeeded** — polled `GET /model/{id}` until `downloaded: true` (confirmed,
persists across calls). **`POST /model/{id}/load` then failed with HTTP 500**:

```
Model load failed: Bad state: Local LLM engine is not initialized. Call
LocalLlmFacade.initialize() first.
```

`LocalLlmFacade.initialize()` is not exposed anywhere in the OpenAPI spec (checked —
grepped all 392 routes for engine/llm/runtime/initialize, nothing matches) — it's internal
PiecesOS engine plumbing, not a callable API route.

**Correction — there is no Settings → Models page.** Walked the actual Pieces Desktop UI
(6.1.0) end to end: profile avatar → Settings has 8 sections (All, Account, Long-Term
Memory, MCP, Connectors, Appearance, Language, Troubleshooting) and none of them expose
model download/load/enable controls. Model selection lives entirely in the chat composer
itself (a "Claude · Extra Thinking"-style dropdown, options Claude/Gemini/GPT/Grok, all
`cloud:true`), not in Settings — so the `qwen3:4b` local-model download/load path above
was very likely the wrong lever entirely, not just blocked on a missing manual step.

**PiecesOS update changed the picture.** While finding Settings, Pieces Desktop flagged
"PiecesOS Update Required" (had drifted to require ≥12.6.0; this install was still on
12.5.0). Updated via the in-app "Download Update & Restart" button — confirmed via
`GET /.well-known/version` → `12.6.0` post-restart. **Re-ran the full test matrix
afterward with real evidence, not assumptions:**

| Call | Result after 12.6.0 update |
|---|---|
| `/qgpt/relevance`, no scope | 200 (unchanged, was already working) |
| `/qgpt/relevance`, `options.database:true` | **200 — now returns ~100 real matched asset IDs.** Previously 500. **Fixed by the version update alone**, nothing to do with model config. |
| `/qgpt/relevance`, `options.database:true, options.question:true` | Still 500 `"qGPT Relevance Endpoint failed."` |
| `/qgpt/question` (direct), empty `relevant.iterable`, no `model` | Still 500 `"qGPT Question Endpoint failed."` |
| `/qgpt/question`, explicit `model` = a random unloaded local model ID | Still 500 (expected — bad test, that model genuinely isn't loaded) |
| `/qgpt/question`, explicit `model` = `a737e3fb-3673-4872-90c1-c8ad70c88099` (`Claude 4.5 Sonnet Chat Model`, a `cloud:true` model matching what the working desktop chat UI uses) | **Still 500**, identical error |

**Revised conclusion:** the 12.6.0 update fixed the *relevance/search* half of Ask
(database-scoped semantic search over assets — genuinely useful on its own for e.g. a
"search my notes" feature) but did **not** fix *answer generation*
(`question:true` / `/qgpt/question`). Ruled out "wrong or unloaded model ID" as the cause
of the remaining 500 — an explicit, correctly-typed cloud chat-model ID (the same category
the desktop app's own working chat uses) still 500s identically to no model specified at
all. This points to either (a) `/qgpt/question` being broken/deprecated server-side
independent of model config — worth trying the `WS /qgpt/stream` variant noted below
instead, since the desktop app's chat may route through that, not the REST endpoint — or
(b) some other undiscovered prerequisite. Not resolvable further via REST alone without
more PiecesOS-side error detail than the plain-text 500 body provides.

**Current state for the mobile Ask feature:** still not viable end-to-end. Recommend
narrowing scope to what's now proven working — database-scoped `/qgpt/relevance` as a
"search your memories" feature — rather than continuing to block on full Q&A-style Ask
until the `/qgpt/question` / `WS /qgpt/stream` question is resolved.

## Semantic search shipped (2026-08-01)

Wired up `/qgpt/relevance` with `options.database:true` as a real feature, separate from
the still-broken Ask/`/qgpt/question` path:

- `PiecesClient.relevantAssets(query)` in `packages/pieces-api` — calls the relevance
  endpoint, then hydrates each returned asset ID via `GET /asset/{id}` (name/created/
  updated) since the relevance response only carries bare IDs. Preserves relevance-ranked
  order; does not re-sort.
- **Timeout note:** the raw relevance call alone measured 5.5s against 108 real assets,
  already over the client's 5s default (tuned for single-call passthrough routes) before
  hydration even starts. `relevantAssets()` uses its own 15s budget (`RELEVANCE_TIMEOUT_MS`)
  for both the relevance call and the hydration fan-out — added a `timeoutMs` override
  param to `PiecesClient`'s private `fetch()` to support this without changing the
  client-wide default other routes rely on.
- `GET /mobile/search/relevant?query=` in `apps/proxy` — special-cased like `/mobile/ask`
  (needs the typed hydration step, not a raw allowlist passthrough). Mirrored into
  `apps/pieces-gateway`'s `isRelevantSearch` passthrough check for the remote-access path;
  no gateway body-forwarding change needed since it's a GET with the query in `url.search`.
- `searchRelevant()` in `apps/mobile/src/lib/api.ts`, wired into `Recent.tsx`'s existing
  search box: tries semantic search first, falls back to the pre-existing
  `searchAssets()` (plain text match via `/assets/search`) if relevance search throws —
  so search keeps working even if PiecesOS regresses on `/qgpt/relevance` again or an
  older home proxy build is in the path. `UsageEvent`'s `"search"` variant gained a
  `mode: "relevant" | "text" | "text-fallback"` field to distinguish which path served
  a given search in the usage log.

**Verified end-to-end** against the live proxy (test instance, port 8799): query
`"pieces-android"` → 200, real hydrated results with names in ~8s (e.g. "AndroidContext
v1: Android Context with Raw Telemetry Block" — genuinely relevant hits pulled from this
debugging session's own captured telemetry, not placeholder data). `apps/mobile` typechecks
and builds clean (`npx tsc --noEmit`, `npm run build`). `apps/proxy` and
`apps/pieces-gateway` have no tsconfig/static typecheck gate (run via `tsx`, validated by
this live test instead).

## Confirmed NOT working

| Method | Path | Result |
|---|---|---|
| POST | `/search/full_text?query=...` | HTTP 404 `Route not found` — either wrong HTTP verb/param shape for this build, or removed/renamed. Not investigated further since `/assets/search` already covers the read-only search need. |

## Real routes seen in the official TS client, not yet called live (candidates only — NOT allowlisted without a live 200)

Pulled directly from `@pieces.app/pieces-os-client@4.1.0`'s generated API classes
(`dist/apis/*.js`), for reference when/if scope expands. Do not add these to the proxy
allowlist without repeating the live-curl-evidence step above.

- `GET /assets/{asset}` — single asset detail
- `GET /assets/{asset}/formats` — asset content/formats
- `GET /conversation/{conversation}` — single conversation detail
- `GET /conversation/{conversation}/messages` — conversation messages
- `WS /qgpt/stream` — streaming Ask variant (untested; may behave differently than the REST `/qgpt/question` path above, worth trying if the REST path stays broken)
- `POST /qgpt/hints` — suggested follow-up questions

## Non-goals reminder (do not implement)

Anything under `/assets/create`, `/assets/{asset}/delete`, `/conversations/create`,
`/asset/update`, `/conversation/update`, or any other write/mutation path — out of scope
per the frozen architecture (read-only Ask/Recent/Status client only).

## Plan B: remote gateway (2026-07-26)

Plan B adds a second entry point — `apps/pieces-gateway`, running on remote-host, fronted
by Caddy at `https://pieces.yourdomain.example` — that reaches the same PC over
Tailscale instead of requiring the phone to be on the home LAN. It imports the exact same
`packages/allowlist` module as the Plan A proxy, so this table is still the single source
of truth for what's allowed; nothing new was added to the allowlist for Plan B, only a new
path to reach it.

**Two auth layers, not one:**
- Phone → gateway: a per-device JWT (see `apps/pieces-gateway/src/jwt.ts`), issued via
  `npm run enroll` and checked against a revocation registry
  (`apps/pieces-gateway/src/device-registry.ts`) on every request — a stateless JWT alone
  cannot be revoked, so the registry is the actual security boundary here, not token expiry.
- Gateway → home proxy: the same Plan A bearer token, sent over Tailscale to the PC's
  tailnet IP. This value lives in a `.env` file on remote-host only (`chmod 600`, never
  committed) — see `HOME_PROXY_TOKEN` in `apps/pieces-gateway/src/server.ts`.

**Fail-closed, proven twice:** both the Plan A proxy and the gateway apply a 5-second
`AbortSignal.timeout` to their upstream call and return an explicit `503` on timeout,
rather than hanging. Verified by literally stopping the Plan A proxy and confirming the
gateway 503s in ~5s over the real deployed HTTPS path — see `docs/ACCEPTANCE.md`.

**DNS**: `pieces.yourdomain.example` is an A record → `203.0.113.10` (remote-host),
added via `vercel dns add` (DNS for this domain is on Vercel, under org
`team_18dH8QMMrUG3oXRNjbX9sSCq`, a different scope than the default CLI login — pass
`--scope team_18dH8QMMrUG3oXRNjbX9sSCq` explicitly if `vercel dns` commands 403). Caddy
issued a real Let's Encrypt cert for this hostname on first run — confirmed via
`certificate obtained successfully` in `docker logs existing-stack-caddy-1`.

**Known gap**: no code changes were needed in the mobile app's request logic for Plan B —
both the proxy and gateway expose the identical `/mobile/*` surface and bearer-token auth
model, so the same Setup screen works for either by just pointing at a different
address/token. What did need updating: Setup's copy (now describes both LAN and remote
modes) and a new `HomeNodeUnreachableError` in `apps/mobile/src/lib/api.ts` so a 503 shows
as "home PC offline" instead of a generic error.

## Setup screen fixed; Ask root cause narrowed to Pieces cloud account, not code (2026-08-21)

**Two real Setup-screen bugs found and fixed, verified live against a real phone
(Galaxy S24 Ultra, wireless ADB) and a real proxy/PiecesOS pair:**

1. **Mixed Content blocked every request.** Capacitor's default `capacitor.config.json`
   serves the WebView over `https://localhost`. Chromium's Mixed Content policy then
   silently blocks any `http://` fetch the page makes — confirmed via
   `adb logcat`: `Mixed Content: The page at 'https://localhost/#/setup' was loaded over
   HTTPS, but requested an insecure resource 'http://<proxy-ip>:8787/mobile/health'.
   This request has been blocked.` The app's own `network_security_config.xml`
   (`cleartextTrafficPermitted="true"`) does **not** cover this — that setting only
   governs Android's OS-level network stack, not the WebView's separate mixed-content
   rule. Fix: added `"server": {"androidScheme": "http"}` to
   `apps/mobile/capacitor.config.json` so the app itself loads over `http://localhost`,
   matching the proxy's scheme. Root-caused by watching live logcat while replaying
   Test & Save — the "Could not reach proxy" message was misleading; curl against the
   same URL from the PC succeeded the whole time.
2. **`checkProxyHealth()` never validated the token.** It called the intentionally
   unauthenticated `/mobile/health` liveness route, so Setup showed "Connected. Saved."
   even with a wrong/stale bearer token — confirmed by deliberately corrupting the
   stored token via `adb shell run-as ... sed -i ...` and observing Setup still report
   success while the (correctly authenticated) Status screen 401'd. Fix:
   `checkProxyHealth(baseUrl, token)` now hits the authenticated
   `/mobile/status/health` route with the entered token, so a bad token now fails at
   Setup instead of surfacing later as a confusing 401 elsewhere. Re-verified with both
   a deliberately wrong token (correctly rejected) and the real token (correctly
   accepted) after the fix.

**Status and Recent confirmed fully working end-to-end** after the Setup fix: Status
shows `PiecesOS reachable`, real health string, real version (`12.6.1`); Recent loads
real conversations and assets from this PiecesOS install.

**Ask investigated further — root cause is not `/qgpt/question` being broken, it's zero
usable models.** Picking up the "worth trying `WS /qgpt/stream`" note from the earlier
session:

- Pulled `@pieces.app/pieces-os-client@4.1.0` fresh and confirmed `/qgpt/stream` is a
  real documented WebSocket endpoint (`QGPTApi.js`: "Provides a WebSocket connection
  that streams inputs to the qGPT model... designed to manage multiple conversations").
- Live `ws://127.0.0.1:39300/qgpt/stream` test, no `model` field:
  `{"status":"FAILED","statusCode":500,"errorMessage":"the model was not provided, so
  we will cancel the stream."}`
- `QGPTQuestionInput.relevant` (type `RelevantQGPTSeeds`) is a **required** field, not
  optional as the earlier REST testing assumed. Added `relevant: { iterable: [] }` plus
  an explicit `model` id — error changed to `"...(failed to fetch model)"`, i.e. it was
  actually trying to fetch that specific model ID and failing.
- **`GET /models` on this install returns 99 models, 71 of them `cloud:true` — and
  `downloaded: false` on every single one.** This is the real root cause, confirmed by
  a full scan, not inferred: there is no model backing generation of any kind right now,
  cloud or local. This matches (and now proves) the "most likely cause: no LLM
  model/runtime configured" hypothesis from the 2026-08-01 session, which had only
  ruled out a *specific* model ID being the problem, not the underlying downloaded
  state of the whole model list.
- Tried the documented fix path: `POST /model/{id}/download` then `POST
  /model/{id}/load` against `Claude 4.5 Sonnet Chat Model`
  (`ed05b98e-3c72-49cb-8e2a-de97653c1a0f`, current ID — the old doc's
  `a737e3fb-3673-4872-90c1-c8ad70c88099` no longer exists in this install's model list,
  model IDs are not stable across time/updates). Both calls returned 200, but
  `GET /model/{id}` still shows `downloaded: false` afterward — for a `cloud:true`
  model, the download/load lifecycle either means something different than it does for
  local models, or requires a prerequisite this install doesn't have.
- Retried `/qgpt/stream` with that model id anyway: error changed again, to a bare
  `"InternalServerError"` — no longer "model not found," now a genuine server-side
  failure during generation.
- `GET /user` shows a real signed-in account (`michael711hebert@gmail.com`, account
  created ~1 month ago) but its `allocation.urls` block shows **two of three cloud
  endpoints in a `FAILED` state** (`id` and `vanity` allocations both `FAILED`; only
  `base` is `RUNNING`). This is the most likely actual root cause: partial/broken
  provisioning on the Pieces cloud account side, not a request-shape or client bug.

**Conclusion: this is not a code problem and should not be worked around in this repo.**
The mobile app, proxy, and `PiecesClient.ask()` already do the right thing — they
surface a typed `"unavailable"` result with a clear reason instead of crashing or
hanging, and that behavior is correct regardless of whether any given PiecesOS install
has a working model. Fixing Ask for real requires action on the Pieces account/cloud
side (Pieces Desktop → account/cloud sync status, or Pieces support, re: the `FAILED`
allocation URLs) — not a proxy, gateway, or mobile app change. Do not build a
workaround (e.g. shelling out to a third-party CLI/LLM) into this repo to paper over an
account provisioning issue on one install; that would trade a clear, honest
"unavailable" error for a maintenance burden every other user of this public repo would
inherit for a problem specific to one Pieces account.
