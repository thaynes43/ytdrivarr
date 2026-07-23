# Changelog

## [0.9.0](https://github.com/thaynes43/ytdrivarr/compare/v0.8.0...v0.9.0) (2026-07-23)


### Features

* **api:** config-override preview (dry-run PR4) ([#36](https://github.com/thaynes43/ytdrivarr/issues/36)) ([2f40e21](https://github.com/thaynes43/ytdrivarr/commit/2f40e21365f9a0d4c8db0b28c5e98e08a24180df))

## [0.8.0](https://github.com/thaynes43/ytdrivarr/compare/v0.7.0...v0.8.0) (2026-07-23)


### Features

* **api:** POST /api/v1/runs/preview — dry-run preview endpoint (dry-run PR3) ([#34](https://github.com/thaynes43/ytdrivarr/issues/34)) ([e2535d5](https://github.com/thaynes43/ytdrivarr/commit/e2535d52445bde4c300b8b6879facbd2c6a821d6))

## [0.7.0](https://github.com/thaynes43/ytdrivarr/compare/v0.6.2...v0.7.0) (2026-07-23)


### Features

* **core:** dry-run preview engine (previewDiscovery) — dry-run PR2 ([#32](https://github.com/thaynes43/ytdrivarr/issues/32)) ([aa432f5](https://github.com/thaynes43/ytdrivarr/commit/aa432f525205d3a529c8bfb05bf45e480a68f2ed))

## [0.6.2](https://github.com/thaynes43/ytdrivarr/compare/v0.6.1...v0.6.2) (2026-07-23)


### Bug Fixes

* **worker:** report login/bearer/scroll telemetry so auth metrics stop reading zero ([#26](https://github.com/thaynes43/ytdrivarr/issues/26)) ([7f30cd5](https://github.com/thaynes43/ytdrivarr/commit/7f30cd5857b4b1bf9ad91ee7249779cc1d0c57ea))


### Refactors

* **core:** extract pure recomposeLibrary + shared rowToEntry (dry-run PR1) ([#31](https://github.com/thaynes43/ytdrivarr/issues/31)) ([20cf161](https://github.com/thaynes43/ytdrivarr/commit/20cf1611e7a140eba321eb0916814c1f39daa0d6))

## [0.6.1](https://github.com/thaynes43/ytdrivarr/compare/v0.6.0...v0.6.1) (2026-07-22)


### Bug Fixes

* calibrate bearer-freshness SLA to the nightly-mint cadence ([#23](https://github.com/thaynes43/ytdrivarr/issues/23)) ([#24](https://github.com/thaynes43/ytdrivarr/issues/24)) ([4d5add1](https://github.com/thaynes43/ytdrivarr/commit/4d5add16fb322c98b452b97baccf018f9ad80f0e))

## [0.6.0](https://github.com/thaynes43/ytdrivarr/compare/v0.5.0...v0.6.0) (2026-07-21)


### Features

* **metrics:** Prometheus /metrics for both providers — the [#2168](https://github.com/thaynes43/ytdrivarr/issues/2168) daily-review surface ([#21](https://github.com/thaynes43/ytdrivarr/issues/21)) ([caf76c3](https://github.com/thaynes43/ytdrivarr/commit/caf76c3b12fff46d2b6e0ef8a1107b1de417ec29))

## [0.5.0](https://github.com/thaynes43/ytdrivarr/compare/v0.4.0...v0.5.0) (2026-07-21)


### Features

* *arr-style operator console + per-activity Peloton sources (the watch grain) ([#20](https://github.com/thaynes43/ytdrivarr/issues/20)) ([9cc8c02](https://github.com/thaynes43/ytdrivarr/commit/9cc8c0244f97e90604308e16092523925e63c6db))
* **core:** donor-parity Peloton emit window — bound subscriptions.yaml, keep the ledger ([#17](https://github.com/thaynes43/ytdrivarr/issues/17)) ([7a4a3b7](https://github.com/thaynes43/ytdrivarr/commit/7a4a3b76fa9327614f994edf6e59afd61ccdd226))

## [0.4.0](https://github.com/thaynes43/ytdrivarr/compare/v0.3.1...v0.4.0) (2026-07-21)


### Features

* **auth:** AUTH_MODE=open (keyless on LAN) + console gate-skip ([#15](https://github.com/thaynes43/ytdrivarr/issues/15)) ([4c88b7f](https://github.com/thaynes43/ytdrivarr/commit/4c88b7fc3abf0a0b389e6219a70a1a5a4c69446e))

## [0.3.1](https://github.com/thaynes43/ytdrivarr/compare/v0.3.0...v0.3.1) (2026-07-21)


### Bug Fixes

* **core:** bind each projected title to one entry — re-aired class dedup (donor parity) ([#11](https://github.com/thaynes43/ytdrivarr/issues/11)) ([9d73e15](https://github.com/thaynes43/ytdrivarr/commit/9d73e15823dcf4225091c16c0fac05d06be66c50))
* **core:** out_of_process health derives from observed state, not env creds ([#12](https://github.com/thaynes43/ytdrivarr/issues/12)) ([1ed8113](https://github.com/thaynes43/ytdrivarr/commit/1ed8113ac0a389700ccf8baa391d5a811ed855be))
* **worker:** survive login-form hydration stale-element races ([#9](https://github.com/thaynes43/ytdrivarr/issues/9)) ([aaaca02](https://github.com/thaynes43/ytdrivarr/commit/aaaca027ce9bcc57f30caf71c87104a3c8d01741))

## [0.3.0](https://github.com/thaynes43/ytdrivarr/compare/v0.2.0...v0.3.0) (2026-07-21)


### Features

* M3 — hardened Peloton plugin port (out-of-process provider, transport, run summaries) ([#7](https://github.com/thaynes43/ytdrivarr/issues/7)) ([33341a5](https://github.com/thaynes43/ytdrivarr/commit/33341a507d22e7a1fd065363cf85c1fa43585eec))
* M3 Peloton worker (hardened out-of-process Selenium scraper) ([#5](https://github.com/thaynes43/ytdrivarr/issues/5)) ([cb6cabc](https://github.com/thaynes43/ytdrivarr/commit/cb6cabc98ae010c773e8860cd19c4bf944c9b74e))

## [0.2.0](https://github.com/thaynes43/ytdrivarr/compare/v0.1.0...v0.2.0) (2026-07-21)

### Features

- M1 walking skeleton + C1–C8 provider contracts ([#1](https://github.com/thaynes43/ytdrivarr/issues/1)) ([a343e7d](https://github.com/thaynes43/ytdrivarr/commit/a343e7d6e5e1945d5b0da9fee917cf91a71c48e5))
- M2 — YouTube YAML takeover + first-class music ([#3](https://github.com/thaynes43/ytdrivarr/issues/3)) ([0b69ce8](https://github.com/thaynes43/ytdrivarr/commit/0b69ce89f130e41967f4162ec5420888c2c81467))
- operator console shell (M1) ([#2](https://github.com/thaynes43/ytdrivarr/issues/2)) ([68df68e](https://github.com/thaynes43/ytdrivarr/commit/68df68e1bc1b45f8f3f5359a43aa68ba3aa9a838))
