# ytdrivarr

An **\*arr-shaped ytdl-content suite service**. It does for [ytdl-sub](https://github.com/jmbannon/ytdl-sub)
what an \*arr does for a download client: it owns the domain of **Sources** (subscribe-able content
origins), renders them into per-**Library** ytdl-sub config, schedules discovery, remediates content
per item, and exposes a REST API you integrate with exactly like Sonarr/Radarr — one-way sync in, a
confined write client, ytdrivarr as the source of truth.

It is a generalization of a proven pattern: a bespoke Peloton scraper already runs a
discover → emit config → run loop in the estate this was built for. ytdrivarr lifts that loop out of
Peloton-hardcoding into \*arr-style **provider** extension points, so a trivial source
(YouTube ≈ pure yt-dlp URL enumeration) and a maximally complex one (Peloton: credentialed browser,
scraped catalog, minted bearer, bespoke season/episode mapping) implement the **same stable contract**.

- **Standalone and reusable** — valuable to anyone running ytdl-sub, with no wider ecosystem needed.
- **Not headless** — it ships its own operator/admin console (served at `/`), while a member-facing
  layer stays a downstream concern. Members never touch this service's UI, exactly as they never touch
  Sonarr's.
- **LAN-only, single API key** — no user management, no accounts, no OIDC. One `X-Api-Key` guards the
  API; per-user identity/grants/caps/audit live in the calling application. Two gate modes
  (`AUTH_MODE`): `api-key` (default — a key is required) or `open` (no key required for any request,
  the way Sonarr runs "Authentication: Disabled for Local Addresses" behind a LAN-only ingress).

## Architecture (design of record)

The normative architecture lives in the consuming estate's design repository. Read these before
changing behavior:

- **Design of record:** https://github.com/thaynes43/haynesnetwork/blob/main/docs/designs/045-ytdrivarr-architecture.md
- **Governing ADR:** https://github.com/thaynes43/haynesnetwork/blob/main/docs/adrs/074-ytdrivarr-ytdl-content-suite-service.md

Two hard boundaries frame the whole design:

1. **ytdl-sub stays the execution engine.** ytdrivarr never vendors yt-dlp; it renders the
   `config.yaml` and `subscriptions.yaml` that the existing ytdl-sub downloader CronJobs consume.
   Extractor breakage becomes a per-source health signal, not a treadmill this service owns.
2. **The contracts come before the port.** The C1–C8 provider interfaces are specified first; a
   heavy provider (the Peloton port) validates the seam, it does not define it.

### The \*arr split

| Concern                                                              | Owner                                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Sources, subscriptions, scheduling, media rules, remediation, health | **ytdrivarr** (this service)                                     |
| Rendering config the downloaders read (no git round-trip)            | **ytdrivarr** — atomic projection to a downloader-mounted volume |
| Downloading / organizing / presenting media                          | **ytdl-sub** (pinned, unchanged)                                 |
| Member identity, grants, caps, per-user audit                        | the **calling application**                                      |

### The C1–C8 provider contract

A provider declares the **subset** of capabilities it implements; everything it omits is **negated**
(the core never invokes that path). That negation is what keeps a trivial provider a few lines while a
maximal one declares the full lifecycle against the _same_ interface. See `src/contracts/`.

| #   | Capability                            | Trivial (URL-list)       | Maximal (authenticated scraper)                                    |
| --- | ------------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| C1  | Capability declaration + `test()`     | `[]`, `in_core`          | `[auth, scrape, tokenMint, assets, remediation]`, `out_of_process` |
| C2  | Auth / session + secret lifecycle     | no-op                    | full credential lifecycle (login → bearer mint → delivery)         |
| C3  | `discover(ctx) → SubscriptionEntry[]` | one URL → one entry      | scraped catalog → entries with per-item overrides                  |
| C4  | Scheduling declaration                | event-driven             | cron + a credential-freshness SLA                                  |
| C5  | Per-provider state namespace          | the editable source list | machine state (bearer, scrape history, dedup ids)                  |
| C6  | Per-item remediation (Fix)            | stateless re-download    | auth-gated re-fetch (dispatched to a worker)                       |
| C7  | Health / telemetry                    | trivial                  | credential-age + selector-drift alarms                             |
| C8  | Assets (optional)                     | none                     | thumbnails / poster durability                                     |

The core owns the rest: a **typed provider registry** (a compile-time map — a failed provider load is
a startup error), a **job dispatcher** (`in_core` inline vs `out_of_process` enqueued to a worker),
config **emission** by preset composition (both `video` and `music` preset families), core-owned
**dedup** + an immutable season/episode guard, and **atomic projection** (write-temp-then-rename).

## The operator console

The service serves its own operator/admin console at `/` — the \*arr design language (dark left
sidebar with an expanding sub-nav, black header, page-scoped icon toolbar, hairline tables,
bookmark-as-monitored, the ytdrivarr red accent), responsive from desktop down to a 390px phone.
It is a hash-routed vanilla-TS SPA (no framework, no extra toolchain — the same esbuild that
bundles the service builds it) and a **strict view over the REST API**: every byte it renders
comes from the same endpoints any caller uses, and every page shows its exact API counterpart.
The approved design record lives in `docs/mockups/` (static HTML + rendered PNGs).

![Sources — the watch grain](docs/screenshots/console-sources-1440.png)

- **Sources** — WHAT THE SERVICE IS WATCHING: YouTube channels and the twelve per-activity
  Peloton Sources interleaved as peer rows in one monitored list. The bookmark toggle is
  monitored (instant PATCH — an unmonitored row's entries persist but leave the next
  scrape/emit; re-monitoring restores them); Cap is the effective per-scrape cap (a per-source
  override over the global default 25, edited in the in-row expander); Entries/Last Run/Status
  fill from the enriched list + `/health`. Removal is an inline two-step arm-then-confirm inside
  a width-reserved slot — arming deepens color, nothing moves. Add New is the provider-aware
  form (YouTube URL/handle + library + media kind + genre chip, validated server-side); Import
  takes an existing `subscriptions.yaml`.
- **Activity** — the runs ledger, running rows inline; a row expands in place into the owner's
  **Changes / Health / Issues** summary with the per-activity existing/added/total/cap table.
- **Settings → Providers** — WHAT IS INTEGRATED: one card per registry entry (runtime,
  capabilities with negated ones hollow, scheduling, live worker/session state). Providers
  compile in; watching more of one happens in Sources.
- **Settings → Libraries / General** — the emit units; the access posture (key COUNT only,
  never values).
- **System → Status** — health callouts first (distinct warn/error messages aggregated across
  sources), then the registry table and the About facts from `/api/v1/system/status`.

![Activity — the Changes/Health/Issues expander](docs/screenshots/console-activity-1440.png)

Access follows the deployment (D-21): with `AUTH_MODE=open` (a LAN-only ingress) the console is
keyless — it probes the API without a key on boot and goes straight to Sources, exactly like
opening Sonarr on the LAN; `X-Api-Key` remains for API clients. On an `api-key` deployment the
key screen guards entry and any 401 returns to it.

Console dev loop: `pnpm build:console` rebuilds the assets; `pnpm dev:demo` boots the API over an
embedded Postgres with a seeded dataset (channels + the twelve Peloton activities + real runs) on
http://localhost:3222 (key `demo-key`; `AUTH_MODE=open pnpm dev:demo` for the keyless experience).

## Quickstart

Requirements: Node >= 22, pnpm, a PostgreSQL 16 database (tests use an embedded Postgres 16 binary — no
Docker needed).

```bash
pnpm install

# lint / typecheck / test / build
pnpm lint
pnpm typecheck
pnpm test
pnpm build

# generate a migration after changing src/db/schema
pnpm db:generate

# run migrations against a real database
DATABASE_URL=postgres://user:pass@host:5432/ytdrivarr pnpm db:migrate

# run the service
YTDRIVARR_API_KEYS=your-strong-key \
DATABASE_URL=postgres://user:pass@host:5432/ytdrivarr \
PROJECTION_ROOT=/mnt/downloader-volume \
pnpm start
```

### Configuration

| Env var                  | Required      | Purpose                                                                                                                              |
| ------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `YTDRIVARR_API_KEYS`     | yes\*         | Comma-separated API keys (`X-Api-Key`). In `api-key` mode, no keys ⇒ the API is locked (deny-by-default). \*Optional in `open` mode. |
| `AUTH_MODE`              | no            | `api-key` (default — a key is required) or `open` (no key required for any request; LAN-only).                                       |
| `DATABASE_URL`           | yes (runtime) | PostgreSQL 16 connection string.                                                                                                     |
| `PROJECTION_ROOT`        | no            | Base directory a Library's relative `projectionPath` resolves under.                                                                 |
| `PORT`                   | no            | HTTP port (default `8080`).                                                                                                          |
| `LOG_LEVEL`              | no            | pino level (default `info`).                                                                                                         |
| `YTDRIVARR_SKIP_MIGRATE` | no            | Skip on-boot migrations (`1`/`true`). Migrations otherwise run idempotently on start.                                                |

## API summary

Every request/response is validated with zod; the OpenAPI 3.1 document is generated from those schemas.

- `GET  /` + `GET /ui/*` — the operator console (static shell + assets; the SPA's data calls carry `X-Api-Key`).
- `GET  /livez` — liveness (open).
- `GET  /openapi.json` — the generated spec (open).
- `GET  /health` — service + per-source health (open).
- `GET  /api/v1/providers` — registered providers and their declared capabilities.
- `GET|POST /api/v1/libraries`, `GET|PATCH|DELETE /api/v1/libraries/{id}`
- `GET|POST /api/v1/sources`, `GET|PATCH|DELETE /api/v1/sources/{id}`, `GET /api/v1/sources/{id}/entries`
- `POST /api/v1/import/ytdl-sub` — idempotent, media-kind-aware import of an existing ytdl-sub `subscriptions.yaml` into Sources
- `GET|POST /api/v1/runs` (POST triggers a discovery run + projection), `GET /api/v1/runs/{id}`
- `GET|POST /api/v1/remediation`, `GET /api/v1/remediation/{id}`

Everything under `/api/v1` requires `X-Api-Key` in the default `api-key` mode. With `AUTH_MODE=open`
no key is required for any request (a presented key is still accepted, never rejected), so keyed
clients keep working unchanged.

## Status

**M2 — the YouTube YAML takeover + first-class music.** The real `in_core` `youtube` provider
supports BOTH preset families from one provider — `mediaKind: video` → `{player} TV Show by Date`
under `= Genre` chips, `mediaKind: music` → the `YouTube Releases` music family (audio, its own
Library) — with channel/playlist ref validation as the `test()` probe and stateless remediation
declared (C6). An idempotent, media-kind-aware **import** (`POST /api/v1/import/ytdl-sub` or
`scripts/import-subscriptions.ts`) parses an existing ytdl-sub `subscriptions.yaml` into Sources: the
`= Music` chip channels become music Sources, everything else video, re-import updates in place and
never duplicates. Two Libraries (a video library + a music library) render and project their own
family atomically to their own `projectionPath`, and the emitter output matches the estate's live
YAML by shape. The cutover runbook is `docs/cutover-m2.md`.

Earlier: **M1** stood up the core (REST API, DB + migrations, typed provider registry, job-dispatch
seam, scheduler seam, emitter + atomic projection), the C1–C8 contracts, the trivial `in_core`
reference provider, and the operator-console shell. Later milestones bring the out-of-process
authenticated-scraper (Peloton) worker with per-provider console settings + `test()` buttons, member
edit surfaces, and per-item Fix.

## License

[AGPL-3.0](./LICENSE).
