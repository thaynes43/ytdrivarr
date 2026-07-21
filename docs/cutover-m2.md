# M2 cutover runbook — YouTube YAML takeover + first-class music

This is the exact, prepared-not-executed runbook for cutting the `ytdl-sub-youtube` downloader from
its hand-edited git `subscriptions.yaml` to ytdrivarr's projected config, and standing up the
first-class music library. It is **non-destructive**: existing YouTube video files are never touched,
and every step has a clean rollback.

Design of record:
[DESIGN-045 D-12/D-13/D-14/D-19](https://github.com/thaynes43/haynesnetwork/blob/main/docs/designs/045-ytdrivarr-architecture.md).

## What changes, and what does not

| Thing                         | Before                                                              | After M2                                                                               |
| ----------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| YouTube `subscriptions.yaml`  | hand-edited in git, mounted as a configMap                          | rendered by ytdrivarr, projected to NFS, mounted from there                            |
| YouTube channels              | ~73 subscriptions incl. 5 under `= Music` (filed as video TV shows) | 68 video Sources + 5 **music** Sources in a music Library                              |
| The `*/15` downloader CronJob | unchanged                                                           | **unchanged** (schedule, image, throttle, memory) — only the file source moves         |
| Existing video files on disk  | —                                                                   | **untouched** (non-destructive; the `= Music` artists keep their existing video files) |

## Preconditions (gates)

1. **ytdrivarr is live** in `downloads` — its deploy is on `haynes-ops` main
   (`kubernetes/main/apps/downloads/ytdrivarr/`); the 1Password `ytdrivarr` item carries a strong
   `YTDRIVARR_API_KEYS`, and the pinned image is published. Confirm `GET /health` is `ok` on
   `https://ytdrivarr.haynesops.com` (LAN) or `ytdrivarr.downloads.svc.cluster.local:8080`.
2. The projection volume is mounted at `PROJECTION_ROOT=/projections` (NFS
   `gasha01.haynesnetwork:/hdd-nfs-repl` subPath `data/media`). A Library with `projectionPath:
youtube` therefore renders to `data/media/youtube/…` — the same NFS dir the downloader already
   mounts as `/media/youtube`.
3. You have the API key. All calls below send `X-Api-Key: <key>`.

## Step 1 — Create the two Libraries

The video Library projects into the existing YouTube media dir (beside `cookies.txt`, the estate's
proven on-volume-config pattern). The music Library projects to a sibling dir.

```bash
API=https://ytdrivarr.haynesops.com
hdr=(-H "X-Api-Key: $KEY" -H 'content-type: application/json')

# Video library — projectionPath youtube → data/media/youtube/{config,subscriptions}.yaml
curl -sX POST "$API/api/v1/libraries" "${hdr[@]}" -d '{
  "name": "YouTube",
  "mediaRoot": "/media/youtube",
  "libraryKind": "video",
  "presetName": "Plex TV Show by Date",
  "projectionPath": "youtube"
}'   # → note the returned id as VIDEO_LIB

# Music library — projectionPath youtube-music → data/media/youtube-music/{config,subscriptions}.yaml
# emitPolicy is the derived music family (see the music-target proposal below).
curl -sX POST "$API/api/v1/libraries" "${hdr[@]}" -d '{
  "name": "YouTube Music",
  "mediaRoot": "/media/youtube-music",
  "libraryKind": "music",
  "presetName": "YouTube Releases",
  "projectionPath": "youtube-music",
  "emitPolicy": { "overrides": { "music_directory": "/media/youtube-music" },
                  "throttle_protection": { "sleep_per_download_s": {"min":20,"max":70},
                    "sleep_per_subscription_s": {"min":60,"max":90},
                    "max_downloads_per_subscription": {"min":25,"max":75},
                    "subscription_download_probability": 0.5 },
                  "ytdl_options": { "cookiefile": "/media/youtube-music/cookies.txt" } }
}'   # → note the returned id as MUSIC_LIB
```

The music `emitPolicy` above is exactly what `deriveMusicEmitPolicy(videoPreset, "/media/youtube-music")`
produces from the estate's `__preset__` (music_directory swapped in, the TV-only `only_recent_*`
window dropped, the shared throttle governance kept, the cookiefile repointed).

## Step 2 — Import the live estate file (idempotent)

Fetch the current git `subscriptions.yaml` and import it. `= Music` channels become music Sources,
everything else video; `applyPreset` sets the video Library's `__preset__` from the file.

```bash
curl -sX POST "$API/api/v1/import/ytdl-sub" "${hdr[@]}" -d "$(jq -n \
  --rawfile y ./youtube/config/subscriptions.yaml \
  --arg v "$VIDEO_LIB" --arg m "$MUSIC_LIB" \
  '{subscriptionsYaml:$y, videoLibraryId:$v, musicLibraryId:$m, applyPreset:true}')"
# expect: {"channels":73,"video":68,"music":5,"created":73,"unchanged":0,"presetApplied":true,…}
```

Equivalent CLI (inside the pod, `DATABASE_URL` set):
`tsx scripts/import-subscriptions.ts --file subscriptions.yaml --video-library $VIDEO_LIB --music-library $MUSIC_LIB --apply-preset`

The import is **idempotent** — re-running it reports `created:0, unchanged:73` and never duplicates.

## Step 3 — Run discovery → project both Libraries

```bash
curl -sX POST "$API/api/v1/runs" "${hdr[@]}" -d '{"scope":"all","trigger":"api"}'
# expect counts: {libraries:2, sources:73, discovered:73, emitted:73, queued:0}
```

ytdrivarr atomically writes `data/media/youtube/{config,subscriptions}.yaml` and
`data/media/youtube-music/{config,subscriptions}.yaml`.

## Step 4 — The diff gate (the safety check before repointing)

Verify the projected **video** file matches the current git YAML by **shape**. This must be a
STRUCTURAL compare, not a raw `diff`: ytdrivarr sorts channels deterministically and Postgres `jsonb`
does not preserve `__preset__` key order, so the bytes differ while the meaning is identical. The
**only** intended structural difference is that the `= Music` group has moved to the music Library.

```js
// node diff-gate.mjs  (run where both files are readable)
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import assert from 'node:assert';

const gitYaml = parse(readFileSync('./youtube/config/subscriptions.yaml', 'utf8'));
const projected = parse(readFileSync('/projections/youtube/subscriptions.yaml', 'utf8'));

// __preset__ must be identical in meaning.
assert.deepStrictEqual(projected.__preset__, gitYaml.__preset__, '__preset__ drift');

// The video preset block must equal the git block MINUS the relocated = Music group.
const expected = { ...gitYaml['Plex TV Show by Date'] };
delete expected['= Music'];
assert.deepStrictEqual(projected['Plex TV Show by Date'], expected, 'video channel drift');

// The 5 music channels must be present in the music Library, ungrouped.
const music = parse(readFileSync('/projections/youtube-music/subscriptions.yaml', 'utf8'));
assert.strictEqual(Object.keys(music['YouTube Releases']).length, 5, 'music count drift');
console.log('DIFF GATE PASS — video shape matches git minus = Music; 5 music channels relocated');
```

If the gate fails, STOP — do not repoint. Investigate the drift (a channel added/removed since the
snapshot, a chip rename) and re-run from Step 2.

## Step 5 — Repoint the downloader (the haynes-ops PR)

Only after the diff gate passes: merge the prepared draft PR that repoints
`ytdl-sub-youtube`'s config/subscriptions mounts from the git configMaps to the NFS-projected files:

- **haynes-ops PR:** https://github.com/thaynes43/haynes-ops/pull/2179 (`feat/ytdl-sub-youtube-ytdrivarr-cutover`)

It changes only `persistence.config` / `persistence.subscriptions` (configMap → NFS subPath
`data/media/youtube/{config,subscriptions}.yaml`) and drops the now-unused `configMapGenerator`s.
The `*/15` schedule, image, throttle, and 6Gi memory are untouched.

**Ordering matters:** the projected files must EXIST on NFS (Step 3) before this merges, or the
downloader pod's subPath mount will fail to bind. That is why the diff gate (which reads the
projected files) is a hard predecessor.

## Step 6 — Verify + rollback

- Watch the next `*/15` `ytdl-sub-youtube` CronJob pod start clean and log the projected subscription
  set. New video grabs continue exactly as before.
- **Rollback:** `git revert` the haynes-ops PR — it restores the configMap mounts and the generators
  exactly. ytdrivarr keeps projecting (harmlessly) until re-cut.

### Non-destructive note on the 5 music artists

At cutover the 5 `= Music` channels leave the VIDEO subscription set, so the downloader stops fetching
NEW **videos** for them; their existing video files stay on disk (non-destructive). New **audio**
grabs begin once the music downloader stands up (below). To avoid a gap, obtain the music-target nod
before or at video cutover so both land together. Back-catalog audio re-grabs are an owner-requested
follow-up, not automatic (DESIGN-045 D-12 as amended).

---

## The music target — proposal for the owner's nod

M2 carries one owner decision: **where the music lands** (media root + which Plex library). Proposed
default, drawn from the estate layout in `haynes-ops`:

- **Media root:** `data/media/youtube-music` on `gasha01.haynesnetwork:/hdd-nfs-repl` — a new sibling
  of the existing `data/media/youtube` on the **same NFS export**. ytdrivarr's projection volume
  already mounts `data/media`, so the music Library's `projectionPath: youtube-music` needs no infra
  change on the ytdrivarr side.
- **Plex library:** a new **music-type "YouTube Music" library on K8Plex** (the `plex` instance —
  `gethomepage` name "K8Plex"), which already hosts the current YouTube video library and mounts the
  media export at `/cephfs-hdd`. The new library scans `/cephfs-hdd/media/youtube-music`. (The
  secondary `plexops` instance is not the YouTube host.)
- **Music downloader:** a new `ytdl-sub-youtube-music` CronJob — a copy of the YouTube downloader
  mounting `data/media/youtube-music` at `/media/youtube-music` and reading its projected config from
  there. This is a **separate, gated** haynes-ops change (not in PR #2179); it stands up only on the
  owner's nod.

Net: one new NFS subdir (same export, no new storage decision), one new Plex library on the server
that already carries YouTube, and one downloader CronJob cloned from the proven YouTube one. Nothing
about the video path changes.
