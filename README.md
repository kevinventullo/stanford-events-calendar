# Stanford Events — my view

A small, static personal view of the [Stanford Events Calendar](https://events.stanford.edu).
It pulls from Stanford's [Localist read-only JSON API](https://events-help.stanford.edu/programmatic-connections)
(no scraping, no API key), applies a personal set of filters, collapses
long-running events into single entries, and shows everything in a month
calendar with a per-day list.

## What it does

**Keeps only events that are:**

- **Public** — audience includes `Everyone` or `General Public`
- **In person** — `experience` is `inperson` or `hybrid`

**Drops events that are:**

- `Academic Dates` (exams, quarter dates, "application opens", etc.)
- `Student Billing Dates`

**Aggregates instead of repeating.** Events fall into three buckets:

- **Ongoing** — spans ≥ 7 days and is an Exhibition or all-day run (e.g.
  months-long exhibitions). Collapsed into a single entry with its date range.
- **Recurring** — flagged `recurring` by Localist (standing tours, drop-ins).
  Collapsed into a single entry with a weekday pattern (e.g. "Sat, Sun · 1 PM")
  instead of appearing on every day it occurs.
- **One-off** — everything else; placed on its real calendar day(s).

Only one-off events populate the day grid, so the calendar shows genuinely
distinct happenings rather than the same tour repeated across months.

Clicking any event opens it on the official Stanford site.

All filter/aggregation settings live at the top of
[`scripts/fetch_events.py`](scripts/fetch_events.py) and are easy to tweak.

## Architecture

- `scripts/fetch_events.py` — fetches the API, filters, aggregates, and writes
  `data/events.json`.
- `data/events.json` — the generated, pre-filtered data (committed to the repo).
- `index.html` / `app.js` / `style.css` — a dependency-free static front-end
  that reads `data/events.json`.
- `.github/workflows/update-events.yml` — a GitHub Action that re-runs the
  fetch script on a schedule and commits any changes, so the site stays fresh
  without a server.

Doing the filtering at build time (rather than in the browser) keeps the page
fast, avoids any CORS issues, and means the data is fully under your control.

## Run locally

```sh
python3 scripts/fetch_events.py     # refresh data/events.json
python3 -m http.server 8765         # serve the site
# open http://localhost:8765
```

(`pip install certifi` if you hit SSL certificate errors on macOS.)

## Deploy on GitHub Pages

1. Create a GitHub repo and push this directory.
2. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from
   a branch**, branch `main`, folder `/ (root)`.
3. In **Settings → Actions → General → Workflow permissions**, ensure
   **Read and write permissions** is enabled (so the Action can commit data
   refreshes).
4. The site will be live at `https://<you>.github.io/<repo>/`. The Action
   refreshes the data twice a day; you can also trigger it manually from the
   **Actions** tab.
