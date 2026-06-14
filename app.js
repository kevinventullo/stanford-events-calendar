"use strict";

// ---- State ---------------------------------------------------------------
let DATA = null;
let byDate = {};          // one-off events:  "YYYY-MM-DD" -> [{event, instance}]
let recurringByDate = {}; // recurring events: "YYYY-MM-DD" -> [{event, instance}]
let viewYear, viewMonth;  // currently displayed month (month is 0-based)
let selectedDate = null;  // "YYYY-MM-DD"

const $ = (id) => document.getElementById(id);

// ---- Date helpers --------------------------------------------------------
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}
function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function todayYmd() {
  return ymd(new Date());
}
function fmtTime(iso, allDay) {
  if (allDay) return "All day";
  const d = new Date(iso);
  let h = d.getHours();
  const min = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return min ? `${h}:${String(min).padStart(2, "0")} ${ap}` : `${h} ${ap}`;
}
function fmtDateLong(s) {
  return parseYmd(s).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
function fmtDateShort(s) {
  return parseYmd(s).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ---- Load ----------------------------------------------------------------
async function load() {
  const resp = await fetch("data/events.json", { cache: "no-cache" });
  DATA = await resp.json();

  const byTime = (a, b) => {
    if (a.instance.all_day !== b.instance.all_day) return a.instance.all_day ? -1 : 1;
    return (a.instance.start || "").localeCompare(b.instance.start || "");
  };
  const indexInstances = (events) => {
    const idx = {};
    for (const ev of events || []) {
      for (const inst of ev.instances || []) {
        (idx[inst.date] = idx[inst.date] || []).push({ event: ev, instance: inst });
      }
    }
    for (const day of Object.values(idx)) day.sort(byTime);
    return idx;
  };
  byDate = indexInstances(DATA.events);
  recurringByDate = indexInstances(DATA.recurring);

  // Meta line
  const gen = DATA.generated_at ? new Date(DATA.generated_at) : null;
  $("meta").textContent =
    `${DATA.counts.dated} one-off · ${DATA.counts.recurring || 0} recurring · ` +
    `${DATA.counts.ongoing} ongoing · ` +
    `window ${fmtDateShort(DATA.window.start)} – ${fmtDateShort(DATA.window.end)}` +
    (gen ? ` · updated ${gen.toLocaleString()}` : "");

  // Start on the current month (or the window start if today is before it).
  const start = parseYmd(
    todayYmd() < DATA.window.start ? DATA.window.start : todayYmd()
  );
  viewYear = start.getFullYear();
  viewMonth = start.getMonth();

  const initial = todayYmd();
  selectedDate = byDate[initial] ? initial : DATA.window.start;

  renderOngoing();
  renderRecurring();
  renderCalendar();
  renderDay();
  wireControls();
}

// ---- Calendar render -----------------------------------------------------
function renderCalendar() {
  $("monthLabel").textContent = new Date(viewYear, viewMonth, 1).toLocaleDateString(
    undefined,
    { month: "long", year: "numeric" }
  );

  const grid = $("calendarGrid");
  grid.innerHTML = "";

  const first = new Date(viewYear, viewMonth, 1);
  const startPad = first.getDay(); // 0=Sun
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const today = todayYmd();

  // Leading blanks
  for (let i = 0; i < startPad; i++) {
    const c = document.createElement("div");
    c.className = "day-cell empty";
    grid.appendChild(c);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dstr = ymd(new Date(viewYear, viewMonth, day));
    const items = byDate[dstr] || [];
    const cell = document.createElement("div");
    cell.className = "day-cell";
    if (dstr === today) cell.classList.add("today");
    if (dstr === selectedDate) cell.classList.add("selected");

    const num = document.createElement("div");
    num.className = "daynum";
    num.textContent = day;
    cell.appendChild(num);

    const shown = items.slice(0, 3);
    for (const it of shown) {
      const chip = document.createElement("div");
      chip.className = "evt-chip";
      chip.textContent = it.event.title;
      cell.appendChild(chip);
    }
    if (items.length > shown.length) {
      const more = document.createElement("div");
      more.className = "evt-more";
      more.textContent = `+${items.length - shown.length} more`;
      cell.appendChild(more);
    }

    cell.addEventListener("click", () => {
      selectedDate = dstr;
      renderCalendar();
      renderDay();
    });
    grid.appendChild(cell);
  }
}

// ---- Day detail render ---------------------------------------------------
function eventCard(ev, timeLabel) {
  const a = document.createElement("a");
  a.className = "evt-card";
  a.href = ev.url;
  a.target = "_blank";
  a.rel = "noopener";

  if (timeLabel) {
    const t = document.createElement("div");
    t.className = "evt-time";
    t.textContent = timeLabel;
    a.appendChild(t);
  }
  const title = document.createElement("div");
  title.className = "evt-title";
  title.textContent = ev.title;
  a.appendChild(title);

  if (ev.location) {
    const loc = document.createElement("div");
    loc.className = "evt-loc";
    loc.textContent = ev.location;
    a.appendChild(loc);
  }

  const tags = document.createElement("div");
  tags.className = "evt-tags";
  for (const t of ev.types || []) {
    const s = document.createElement("span");
    s.className = "tag";
    s.textContent = t;
    tags.appendChild(s);
  }
  if (ev.experience === "hybrid") {
    const s = document.createElement("span");
    s.className = "tag hybrid";
    s.textContent = "Hybrid";
    tags.appendChild(s);
  }
  if (ev.free) {
    const s = document.createElement("span");
    s.className = "tag free";
    s.textContent = "Free";
    tags.appendChild(s);
  }
  if (tags.children.length) a.appendChild(tags);
  return a;
}

function groupHeader(list, text) {
  const h = document.createElement("div");
  h.className = "group-head";
  h.textContent = text;
  list.appendChild(h);
}

function renderDay() {
  $("dayLabel").textContent = fmtDateLong(selectedDate);
  const list = $("dayList");
  list.innerHTML = "";

  const oneoffs = byDate[selectedDate] || [];
  const recurringToday = recurringByDate[selectedDate] || [];
  const onview = (DATA.ongoing || []).filter((e) =>
    // Prefer the explicit open-days when present (exhibitions are only listed on
    // days they actually run); fall back to the date range for older data.
    e.dates
      ? e.dates.includes(selectedDate)
      : e.first_date <= selectedDate && selectedDate <= e.last_date
  );

  if (!oneoffs.length && !recurringToday.length && !onview.length) {
    const p = document.createElement("p");
    p.className = "day-empty";
    p.textContent = "Nothing on this day.";
    list.appendChild(p);
    return;
  }

  // One-off events first.
  if (oneoffs.length) {
    groupHeader(list, "One-off events");
    for (const it of oneoffs) {
      list.appendChild(eventCard(it.event, fmtTime(it.instance.start, it.instance.all_day)));
    }
  }

  // Recurring series that happen to land on this day.
  if (recurringToday.length) {
    groupHeader(list, "Recurring today");
    for (const it of recurringToday) {
      list.appendChild(eventCard(it.event, fmtTime(it.instance.start, it.instance.all_day)));
    }
  }

  // Ongoing exhibitions on view this day.
  if (onview.length) {
    groupHeader(list, "On view");
    for (const e of onview) {
      list.appendChild(eventCard(e, null));
    }
  }
}

// ---- Ongoing render ------------------------------------------------------
function renderOngoing() {
  $("ongoingCount").textContent = DATA.ongoing.length;
  const list = $("ongoingList");
  list.innerHTML = "";
  for (const e of DATA.ongoing) {
    const card = eventCard(e, null);
    card.classList.add("ongoing-card");
    const range = document.createElement("div");
    range.className = "evt-range";
    range.textContent = `${fmtDateShort(e.first_date)} – ${fmtDateShort(e.last_date)}`;
    card.insertBefore(range, card.firstChild);
    list.appendChild(card);
  }
}

// ---- Recurring render ----------------------------------------------------
function renderRecurring() {
  const list = $("recurringList");
  const recurring = DATA.recurring || [];
  $("recurringCount").textContent = recurring.length;
  list.innerHTML = "";
  for (const e of recurring) {
    const card = eventCard(e, null);
    card.classList.add("ongoing-card");
    const when = document.createElement("div");
    when.className = "evt-range";
    const bits = [e.pattern, e.time].filter(Boolean).join(" · ");
    when.textContent = bits || "Recurring";
    card.insertBefore(when, card.firstChild);
    list.appendChild(card);
  }
}

// ---- Controls ------------------------------------------------------------
function wireCollapse(btnId, listId) {
  $(btnId).addEventListener("click", (e) => {
    const btn = e.currentTarget;
    const open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!open));
    $(listId).classList.toggle("collapsed", open);
  });
}

function shiftMonth(delta) {
  viewMonth += delta;
  if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  renderCalendar();
}

function wireControls() {
  $("prevMonth").addEventListener("click", () => shiftMonth(-1));
  $("nextMonth").addEventListener("click", () => shiftMonth(1));
  $("todayBtn").addEventListener("click", () => {
    const t = parseYmd(todayYmd() < DATA.window.start ? DATA.window.start : todayYmd());
    viewYear = t.getFullYear();
    viewMonth = t.getMonth();
    selectedDate = byDate[todayYmd()] ? todayYmd() : selectedDate;
    renderCalendar();
    renderDay();
  });
  wireCollapse("ongoingToggle", "ongoingList");
  wireCollapse("recurringToggle", "recurringList");
}

load().catch((err) => {
  document.getElementById("meta").textContent =
    "Failed to load events data: " + err.message;
  console.error(err);
});
