#!/usr/bin/env python3
"""
Fetch events from the Stanford Events Calendar (Localist JSON API), apply a
personal set of filters, aggregate long-running events into single entries, and
write a static data/events.json for the front-end to consume.

No scraping and no API key required. The Localist read-only API is documented at
https://events-help.stanford.edu/programmatic-connections.

Run:  python3 scripts/fetch_events.py
"""

import json
import ssl
import sys
import time
import urllib.request
import urllib.error
from datetime import date, datetime, timedelta
from pathlib import Path

try:
    # Use certifi's CA bundle if present (avoids macOS Python cert issues).
    import certifi
    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CONTEXT = ssl.create_default_context()

API_BASE = "https://events.stanford.edu/api/2/events"
USER_AGENT = "stanford-events-calendar/1.0 (+https://github.com/)"

# How far ahead to pull events.
DAYS_AHEAD = 180

# Per-page size for the API (max is 100).
PAGE_SIZE = 100

# --- Filter configuration -------------------------------------------------
# An event is kept only if its audience includes one of these.
PUBLIC_AUDIENCES = {"Everyone", "General Public"}

# An event is kept only if its "experience" is one of these (in-person, incl. hybrid).
ALLOWED_EXPERIENCES = {"inperson", "hybrid"}

# An event is dropped if it carries any of these event types...
EXCLUDED_TYPES = {"Academic Dates", "Student Billing Dates"}
# ...or any of these subjects.
EXCLUDED_SUBJECTS = set()

# --- Aggregation configuration --------------------------------------------
# An event is treated as "ongoing" (a single aggregate entry, kept out of the
# per-day calendar) when it spans at least this many days AND is either an
# Exhibition or an all-day run.
ONGOING_MIN_SPAN_DAYS = 7
# ---------------------------------------------------------------------------


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60, context=SSL_CONTEXT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_instance_rows(start, end):
    """Collect one row per event-instance across the whole date range.

    Querying the API with start/end expands recurring events into one entry per
    day. We paginate by page number: the first response reports `page.total`,
    which is the reliable count of pages for the requested window. (The
    response's `date.last` just echoes the requested `end` for large windows, so
    it can't be used as a coverage cursor.)
    """
    rows = []
    page = 1
    total_pages = 1
    while page <= total_pages and page <= 400:
        url = (
            f"{API_BASE}?start={start.isoformat()}&end={end.isoformat()}"
            f"&pp={PAGE_SIZE}&page={page}"
        )
        try:
            data = fetch_json(url)
        except urllib.error.HTTPError as e:
            print(f"  HTTP error {e.code} on page {page}; stopping", file=sys.stderr)
            break
        events = data.get("events", [])
        if not events:
            break
        rows.extend(e["event"] for e in events)
        total_pages = (data.get("page") or {}).get("total", page)
        page += 1
        time.sleep(0.2)  # be polite to the API
    return rows


def names(event, key):
    return [f["name"] for f in (event.get("filters") or {}).get(key, []) or []]


def passes_filters(event):
    audiences = set(names(event, "event_audience"))
    if not (audiences & PUBLIC_AUDIENCES):
        return False
    if event.get("experience") not in ALLOWED_EXPERIENCES:
        return False
    types = set(names(event, "event_types"))
    if types & EXCLUDED_TYPES:
        return False
    subjects = set(names(event, "event_subject"))
    if subjects & EXCLUDED_SUBJECTS:
        return False
    return True


def span_days(event):
    try:
        a = date.fromisoformat(event["first_date"])
        b = date.fromisoformat(event["last_date"])
        return (b - a).days
    except (KeyError, TypeError, ValueError):
        return 0


def location_str(event):
    parts = [event.get("location_name"), event.get("room_number"), event.get("address")]
    parts = [p.strip() for p in parts if p and p.strip()]
    return ", ".join(parts)


WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def recurrence_pattern(instances):
    """Human-readable weekday pattern, e.g. 'Saturdays' or 'Tue, Thu'."""
    if not instances:
        return ""
    from collections import Counter

    wd = Counter(date.fromisoformat(i["date"]).weekday() for i in instances)
    distinct = sorted(wd)
    if len(distinct) == 1:
        return WEEKDAYS[distinct[0]] + "s"
    if len(distinct) <= 3:
        return ", ".join(WEEKDAYS[d][:3] for d in distinct)
    return "Various days"


def representative_time(instances):
    """Most common start time across instances; 'All day' if all-day."""
    from collections import Counter

    if instances and all(i["all_day"] for i in instances):
        return "All day"
    times = Counter()
    for i in instances:
        if not i["all_day"] and i["start"]:
            dt = datetime.fromisoformat(i["start"])
            times[dt.strftime("%-I:%M %p" if dt.minute else "%-I %p")] += 1
    return times.most_common(1)[0][0] if times else ""


def instance_tuples(event):
    """Return (date_str, start_iso_or_None, all_day_bool) for each instance."""
    out = []
    for wrap in event.get("event_instances") or []:
        inst = wrap.get("event_instance", {})
        start = inst.get("start")
        if not start:
            continue
        out.append((start[:10], start, bool(inst.get("all_day"))))
    return out


def main():
    today = date.today()
    end = today + timedelta(days=DAYS_AHEAD)
    print(f"Fetching instances {today} .. {end} ...", file=sys.stderr)
    rows = fetch_instance_rows(today, end)
    print(f"  pulled {len(rows)} instance rows", file=sys.stderr)

    # Group instance rows back into one record per event id.
    by_id = {}
    for ev in rows:
        eid = ev["id"]
        rec = by_id.get(eid)
        if rec is None:
            rec = {"event": ev, "instances": {}}
            by_id[eid] = rec
        for d, start_iso, all_day in instance_tuples(ev):
            if today.isoformat() <= d <= end.isoformat():
                rec["instances"][d] = {"date": d, "start": start_iso, "all_day": all_day}

    kept_ongoing = []
    kept_recurring = []
    kept_dated = []
    for rec in by_id.values():
        ev = rec["event"]
        if not passes_filters(ev):
            continue
        types = names(ev, "event_types")
        subjects = names(ev, "event_subject")
        is_exhibition = "Exhibition" in types
        instances = sorted(rec["instances"].values(), key=lambda i: i["date"])
        if not instances:
            continue
        has_all_day = any(i["all_day"] for i in instances)
        sp = span_days(ev)

        base = {
            "id": ev["id"],
            "title": ev.get("title", "").strip(),
            "url": ev.get("localist_url") or ev.get("url"),
            "experience": ev.get("experience"),
            "location": location_str(ev),
            "types": types,
            "subjects": subjects,
            "photo": ev.get("photo_url") or None,
            "free": bool(ev.get("free")),
        }

        is_ongoing = sp >= ONGOING_MIN_SPAN_DAYS and (is_exhibition or has_all_day)
        if is_ongoing:
            # Months-long exhibitions / all-day runs: one entry with a date range.
            base["first_date"] = ev.get("first_date")
            base["last_date"] = ev.get("last_date")
            kept_ongoing.append(base)
        elif ev.get("recurring"):
            # Standing recurring series: one entry with a weekday pattern, but
            # keep the individual occurrences so the day panel can show them.
            dates = [i["date"] for i in instances]
            base["instances"] = instances
            base["dates"] = dates
            base["pattern"] = recurrence_pattern(instances)
            base["time"] = representative_time(instances)
            base["next_date"] = dates[0]
            base["last_date"] = dates[-1]
            base["count"] = len(dates)
            kept_recurring.append(base)
        else:
            # One-off events: placed on their actual calendar day(s).
            base["instances"] = instances
            base["dates"] = [i["date"] for i in instances]
            kept_dated.append(base)

    kept_ongoing.sort(key=lambda e: (e.get("first_date") or "", e["title"].lower()))
    kept_recurring.sort(key=lambda e: e["title"].lower())
    kept_dated.sort(key=lambda e: (e["dates"][0], e["title"].lower()))

    out = {
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "window": {"start": today.isoformat(), "end": end.isoformat()},
        "filters": {
            "public_audiences": sorted(PUBLIC_AUDIENCES),
            "experiences": sorted(ALLOWED_EXPERIENCES),
            "excluded_types": sorted(EXCLUDED_TYPES),
            "excluded_subjects": sorted(EXCLUDED_SUBJECTS),
            "ongoing_min_span_days": ONGOING_MIN_SPAN_DAYS,
        },
        "counts": {
            "ongoing": len(kept_ongoing),
            "recurring": len(kept_recurring),
            "dated": len(kept_dated),
        },
        "ongoing": kept_ongoing,
        "recurring": kept_recurring,
        "events": kept_dated,
    }

    out_path = Path(__file__).resolve().parent.parent / "data" / "events.json"
    out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False))
    print(
        f"Wrote {out_path} : {len(kept_dated)} one-off events, "
        f"{len(kept_recurring)} recurring, {len(kept_ongoing)} ongoing.",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
