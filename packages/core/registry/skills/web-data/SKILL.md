---
name: web-data
description: Fetch and extract data from the network with the request budget, the failure modes, and the provenance all stated.
capabilities: net:http
---

# Web and data

Every request you make is slow, can fail, may be rate-limited, and leaves a trace
on someone else's server. Treat the network as an expensive, unreliable dependency
that belongs to a stranger.

## Before the first request

State, in the plan: **which hosts**, **how many requests**, and **what you do when
one fails**. A run that discovers its own request count as it goes cannot be
budgeted and cannot be reviewed.

Prefer, in order: a local cache, a file the user already has, a documented API, a
feed, scraping HTML. Scraping is last because it breaks silently when a page
changes.

## Fetching

- **One request at a time per host**, unless you know its rate limit. Parallel
  requests to the same host are how a tool gets an IP banned for its user.
- **Set a timeout on every request.** A hung fetch with no timeout is a hung run.
- **Retry at most twice, with a growing delay, and only on 429, 502, 503, 504.**
  A 400 or a 404 will not become a 200 because you asked again.
- **Never follow a redirect to a different scheme.** `https` to `http` is a
  downgrade; treat it as a failure.
- **Send no credential unless the task required one**, and never send one to a
  host other than the one it belongs to.

## Extraction

- Parse structure, do not pattern-match prose. A JSON field is a contract; the
  third `<div>` on a page is not.
- **Record where every value came from**: the URL, the field or selector, and when
  you fetched it. A number with no provenance cannot be checked and should not be
  used.
- Missing is not zero. An absent field is `null`, and the difference matters to
  everything downstream.
- Keep the raw response when it is small enough. Re-deriving beats re-fetching.

## Failure, honestly

When a source is unavailable, **say which one and continue** if the task allows a
partial answer. Report the answer as partial, name the gap, and never fill it with
an estimate presented as data. Nineteen sources of twenty is a useful result; a
fabricated twentieth is a corrupt one.

## What not to do

- Do not scrape a site whose terms forbid it, and do not work around a paywall,
  a captcha, or a rate limiter.
- Do not send the user's code, filenames, or environment to a host as part of a
  query.
- Do not report a cached value as fresh. Say when it was fetched.
