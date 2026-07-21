"""Hardened out-of-process Peloton discovery/refresh worker for ytdrivarr (M3).

This package is the WORKER half of the ytdrivarr Peloton plugin: a Python +
Selenium + Chromium container that claims discovery/refresh jobs from the
TypeScript CORE over an HTTP job protocol, does the credentialed login +
bearer/cookie mint + bounded scrape, and reports ``SubscriptionEntry[]`` +
telemetry back.

It is a hardened port of the ``ytdl-sub-config-manager`` donor: every fixed
``time.sleep`` is replaced with an explicit ``WebDriverWait``/expected-condition
or an injected, test-observable pause; login/bearer/scrape all return typed
results and raise typed errors that the main loop turns into honest
``fail(retryable, alarm=...)`` calls instead of the donor's silent
``RuntimeError``-fails-the-whole-run behaviour.
"""

__version__ = "0.1.0"
