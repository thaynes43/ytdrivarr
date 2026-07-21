# ytdrivarr Peloton worker (M3)

The **worker half** of the ytdrivarr Peloton plugin (DESIGN-045 D-03 `out_of_process`
runtime): a Python + Selenium + Chromium container that claims discovery/refresh jobs
from the TypeScript **core** over an HTTP job protocol, does the credentialed login +
bearer/cookie mint + bounded scrape, and reports `SubscriptionEntry[]` + telemetry back.

It is a **hardened port** of the `ytdl-sub-config-manager` donor. The donor had zero
`WebDriverWait`s (every wait was a fixed `time.sleep`), no MFA/captcha/redirect handling,
no retries, and a bearer-capture failure raised a bare `RuntimeError` that failed the whole
run — so the downloader kept running an aging token and downloads silently stopped with no
alarm. Every one of those is fixed here and proven with tests.

Image: `ghcr.io/thaynes43/ytdrivarr-peloton-worker`.

## Layout

```
worker/
  pyproject.toml            # package + ruff + pytest config (src layout)
  Dockerfile                # python:3.13-slim + chromium + chromium-driver + ffmpeg, non-root
  src/ytdrivarr_peloton_worker/
    session.py              # Chromium session (headless, --no-sandbox, perf-logging cap) + CDP enable
    login.py                # HARDENED login -> typed outcome: ok|bad_credentials|mfa_required|captcha|redirect|timeout
    bearer.py               # HARDENED bearer+cookie mint (CDP sniff) -> BearerCaptureError, Netscape cookies, JWT exp
    scraper.py              # HARDENED scrape (waits, stale-retry, cap, dedup, drift/scroll signals)
    numbering.py            # per-(activity,duration) episode counter; one band per activity, continues from payload high-water mark
    folders.py              # activity->folder + bootcamp collapse (donor-exact)
    metadata.py             # title/instructor/duration parse, normalize/sanitize (donor-exact)
    transport.py            # HTTP client (claim/heartbeat/report/fail) + background heartbeat thread
    emit.py                 # SubscriptionEntry + telemetry/summary + live-shape YAML renderer + shape-diff
    worker.py               # the claim->heartbeat->scrape/refresh->report/fail loop
    validate.py             # VALIDATION / DRY-RUN mode (writes ONLY to a scratch path)
    waits.py, errors.py, baked_sample.py, logging_setup.py, __main__.py
  tests/                    # 92 tests, fully stubbed driver + stub core (no network, no browser)
```

## The transport contract (client side; the core implements the server)

Base URL + API key from env (`YTDRIVARR_CORE_URL`, `YTDRIVARR_API_KEY`), `X-Api-Key` auth.

| Endpoint | Body | Response |
|---|---|---|
| `POST /api/v1/jobs/claim` | `{worker, kinds?, providerId?}` | `{job:{id,kind,providerId,payload,attempts}\|null}` |
| `POST /api/v1/jobs/:id/heartbeat` | `{worker}` | `{ok:true}` (409 ⇒ reclaimed ⇒ abort) |
| `POST /api/v1/jobs/:id/report` | `{worker, result:{entries,session,telemetry,summary}}` | `{}` |
| `POST /api/v1/jobs/:id/fail` | `{worker, error, retryable, alarm?}` | `{}` |

Each reported entry serializes to the live-file shape:

```json
{"entryKey":"<classId>","displayName":"{Title} with {Instructor}",
 "downloadRef":"https://members.onepeloton.com/classes/player/{classId}",
 "preset":"Plex TV Show by Date","chip":"{Activity} ({duration} min)",
 "overrides":{"tv_show_directory":"{mediaRoot}/{Activity}/{Instructor}",
              "season_number":<duration>,"episode_number":<N>}}
```

`session` carries `{bearer, cookies (Netscape cookies.txt), mintedAt, expiresAt?}`.
`mode:'refresh'` = login + bearer mint only (no scrape) for the bearer-freshness SLA (D-07).

The inbound `payload.peloton.episodeNumbering` is **per-(activity, duration)**:
`{ [activitySlug]: { [durationString]: currentMax } }` (donor parity — each activity
carries its OWN band; JSON duration keys are strings, coerced to int at the boundary).
When scraping activity `slug`, the worker seeds a fresh counter from
`episodeNumbering[slug]` and hands out `max+1, max+2, …` per duration — counters are
never shared across activities, so same-season classes advance in disjoint bands (e.g.
Cardio E223 alongside Cycling E2151). The report's `telemetry.episodeHighWater` mirrors
this shape: `{ [activitySlug]: { [durationString]: max } }`.

## Build

```bash
# from the repo root (build context is the repo root, mirroring publish.yml):
docker build -f worker/Dockerfile -t ytdrivarr-peloton-worker:dev .
```

## Run the worker loop

```bash
docker run --rm \
  -e YTDRIVARR_CORE_URL=http://ytdrivarr.core:8080 \
  -e YTDRIVARR_API_KEY=... \
  -e PELOTON_USERNAME=... -e PELOTON_PASSWORD=... \
  --shm-size=2g --memory=6g \
  ytdrivarr-peloton-worker:dev
# (default CMD is `ytdrivarr_peloton_worker` = the long-poll loop)
```

Optional env: `WORKER_NAME` (default hostname), `WORKER_KINDS` (comma list), `WORKER_PROVIDER_ID`
(default `peloton`), `WORKER_POLL_SEC` (5), `WORKER_HEARTBEAT_SEC` (15), `WORKER_HEADLESS` (true),
`CHROMIUM_BINARY` (`/usr/bin/chromium`), `CHROMEDRIVER_PATH` (`/usr/bin/chromedriver`), `LOG_LEVEL`.

## Run the validation dry-run (the in-cluster PR-Health artifact)

Does a **real** login → **real** bearer mint → **real** bounded scrape, renders
`subscriptions.yaml` to a scratch path, and prints a JSON summary + human summary +
shape-diff verdict. **Zero live writes**: it writes ONLY under `--scratch` (no NFS
`bearer.txt`/`cookies.txt`, no core round-trip).

```bash
docker run --rm \
  -e PELOTON_USERNAME=... -e PELOTON_PASSWORD=... \
  --shm-size=2g \
  ytdrivarr-peloton-worker:dev \
  ytdrivarr_peloton_worker.validate \
    --activities Cycling --max-classes 5 --max-scrolls 5 \
    --scratch /tmp/pelo-out --headless
```

Exit code `0` = shape verdict PASS. Artifacts land at `/tmp/pelo-out/subscriptions.yaml`
and `/tmp/pelo-out/summary.json`. (Locally without the image:
`python -m ytdrivarr_peloton_worker.validate --activities Cycling --scratch /tmp/pelo-out --no-container`.)

## Test

```bash
cd worker
pip install -e '.[dev]'
pytest -q           # 92 tests, no network/browser needed
ruff check src tests
```

## Hardening deltas vs the donor

| Leg | Donor | Here |
|---|---|---|
| Login waits | `time.sleep(10)` then `time.sleep(15)` | explicit `WebDriverWait`s for the username/password fields and post-submit navigation |
| Login result | `bool` (`"login" not in url`) | typed `ok\|bad_credentials\|mfa_required\|captcha\|redirect\|timeout` |
| Login MFA/captcha | none | detected + distinguished, mapped to a non-retryable `login` alarm |
| Login retries | none | backoff retry on transient timeout/redirect |
| Bearer poll | `time.sleep(0.5)` loop ≤15s | `WebDriverWait` on a capture predicate (JS hook + CDP perf log) |
| Bearer failure | bare `RuntimeError`, whole run fails silently | typed `BearerCaptureError` → `fail(retryable, alarm=bearer_capture)`; never a stale/empty token |
| Bearer retries | none | re-navigate + retry with backoff |
| Bearer freshness | none | best-effort JWT `exp` decode → `expiresAt` for the SLA |
| Scrape page-load | `time.sleep(10)` | `WebDriverWait` for ≥1 class link |
| Scroll | blind `time.sleep(3)` × N | per-scroll `WebDriverWait` for link growth + stall/bottom detection |
| Stale elements | uncaught | retried (bounded) without losing collected/numbered classes |
| Zero/malformed hits | silently yields nothing | typed `selector_drift` / `scroll_timeout` signals → alarm (D-10) |
| Numbering | rounding-to-nearest-5 latent inconsistency | RAW duration minutes only (owner ruling: parity) |
| Telemetry | text summaries into logs / PR body | structured `telemetry` + `summary` + `alarms[]` in the report |
| Heartbeat / reclaim | n/a (batch CLI) | background heartbeat thread; 409 aborts the job cleanly |

## Assumptions the coordinator should confirm in the live dry-run

1. **Login field names** (donor-inherited, unverified live): username `input[name="usernameOrEmail"]`,
   password `input[name="password"]`, submit `button[type="submit"]`. Success = navigation off
   `.../login`.
2. **MFA/captcha heuristics** (`login.py`): MFA on `input[name="code"|"otp"]` /
   `autocomplete="one-time-code"` / `[data-test-id*="mfa"|"verification"]` or page text
   ("verification code", "two-factor", …); captcha on recaptcha/hcaptcha iframes / `#px-captcha` /
   `[class*="captcha"]` or "press & hold" / "verify you are human". These are best-effort and
   should be tuned against a real challenge.
3. **Bearer capture** fires only on a **class player page**; the metrics request sniffed is
   `api.onepeloton.com/api/metrics/v2/video`. If Peloton changes that path/host the CDP perf-log
   scan needs updating (the JS fetch/XHR hook is host-generic to `api.onepeloton.com`).
4. **Scrape selectors** (donor-inherited): links `a[href*="classId="]`, title
   `[data-test-id="videoCellTitle"]`, subtitle `[data-test-id="videoCellSubtitle"]`, subtitle split
   on `·` (U+00B7). A live change here trips the `selector_drift` alarm (by design) — that alarm
   firing in the dry-run is the signal to update selectors.
5. **`maxClassesPerActivity`** is treated as the cap on **new** (non-existing) classes per activity
   (the payload carries `existingClassIds` for dedup but no separate per-activity existing count).
6. **Refresh mode** mints the bearer from the first `existingClassIds` entry; if none is supplied it
   does a minimal one-class scrape to find a player URL.
