import { useEffect, useMemo, useRef, useState } from "react";
import { createCalendar, destroyCalendar, DayGrid, TimeGrid, Interaction } from "@event-calendar/core";
import "@event-calendar/core/index.css";
import { RRule } from "rrule";
import { CalendarEvent, EventOverride, Task, TaskList } from "../types";
import { selectWidth } from "../selectWidth";
import { appLocale, firstDayOfWeek, formatTime } from "../dateFormat";
import ContextMenu from "./ContextMenu";

export type CalendarShow = "both" | "tasks" | "events";

interface Props {
  events: CalendarEvent[];
  tasks: Task[];
  lists: TaskList[];
  calendarShow: CalendarShow;
  onSetCalendarShow: (v: CalendarShow) => void;
  selectedTaskId: string | null;
  selectedEventId: string | null;
  onSelectTask: (id: string) => void;
  onSelectEvent: (id: string, occurrenceStart?: string | null) => void;
  /** Fires with a "YYYY-MM-DD" date, to create a new (non-recurring) event
   *  there -- double-click a blank day, or "New Event" on its context menu. */
  onCreateEvent: (dateStr: string) => void;
  /** "New Task" on a day's context menu -- creates a task due that day. */
  onCreateTask: (dateStr: string) => void;
  listFilter: string; // "all" or a single list id
  onSetListFilter: (id: string) => void;
  /** Persist a drag/resize of an event bar (same path the detail panel's
   *  Save uses -- writes the row + flags it dirty for CalDAV push). */
  onUpdateEvent: (id: string, patch: Partial<CalendarEvent>) => void;
  /** Persist a drag/resize of a task bar. */
  onUpdateTask: (id: string, patch: Partial<Task>) => void;
}

type DisplayMode = "range" | "due" | "start";
// Event equivalent of DisplayMode. "end" is the event's analogue of a task's
// "due" (a single-day bar on the last day); "range" spans start..end.
type EventDisplayMode = "range" | "start" | "end";

/** One day after a date-only string ("YYYY-MM-DD"), for the exclusive `end`
 *  that all-day ranges use (matches iCalendar's own DTEND convention). */
function nextDay(dateStr: string): string {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** True when a stored value carries a time-of-day (a full datetime) rather
 *  than a date-only "YYYY-MM-DD". Timed tasks/events draw as time-grid blocks;
 *  date-only ones stay all-day bars. */
function hasTime(v: string | null | undefined): boolean {
  return !!v && v.length > 10;
}

function splitTags(tags: string): string[] {
  return tags.split(",").map((t) => t.trim()).filter(Boolean);
}

/** Strips the timezone off a stored UTC datetime, replacing it with the
 *  equivalent LOCAL wall-clock digits as a floating (no "Z"/offset) string.
 *  @event-calendar/core does its own timezone-offset math on whatever string
 *  it's given, and that math doesn't line up with how its event-time-badge
 *  text gets formatted (see the `eventTimeFormat` comment where the calendar
 *  is created) -- feeding it a real UTC "Z" string made the badge show the
 *  wrong hour (off by the local UTC offset) even though every other place in
 *  the app (Details panel, reminder notifications) reads the same stored
 *  value correctly via a plain `new Date(...).getHours()`. Handing the
 *  library an already-local, offset-free string sidesteps its conversion
 *  entirely -- there's nothing left for it to (mis)convert. All-day
 *  "YYYY-MM-DD" values pass through unchanged; they have no time-of-day
 *  component for this bug to affect. */
function toLocalFloating(v: string): string {
  if (v.length <= 10) return v;
  const d = new Date(v);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The local "YYYY-MM-DD" day a stored value falls on. Date-only values pass
 *  through unchanged; datetimes are resolved to their local wall-clock day
 *  (via toLocalFloating) so single-day event modes anchor on the day the user
 *  sees, not a UTC-shifted one. */
function localDay(v: string): string {
  return toLocalFloating(v).slice(0, 10);
}

/** Move a stored timed value onto a different calendar DAY while keeping its
 *  local wall-clock time-of-day, returning a UTC ISO string (the stored shape
 *  for timed events). Used by the horizontal "span across days" drag, which
 *  changes only the day the start/end falls on. */
function withDayLocal(stored: string, targetDate: Date): string {
  const local = toLocalFloating(stored);
  const time = local.length > 10 ? local.slice(10) : "T00:00:00";
  const pad = (n: number) => String(n).padStart(2, "0");
  const ds = `${targetDate.getFullYear()}-${pad(targetDate.getMonth() + 1)}-${pad(targetDate.getDate())}`;
  return new Date(`${ds}${time}`).toISOString();
}
/** Local-midnight epoch of a stored value's day -- for comparing which day two
 *  values fall on (drag clamping so end never precedes start, and vice versa). */
function dayEpochOf(stored: string): number {
  return new Date(`${localDay(stored)}T00:00:00`).getTime();
}
/** A Date at local midnight of a stored value's day. */
function dayDateOf(stored: string): Date {
  return new Date(`${localDay(stored)}T00:00:00`);
}

/** "YYYY-MM-DD" from a Date's LOCAL wall-clock date -- deliberately not
 *  toISOString().slice(0, 10), which converts to UTC and can land on the
 *  wrong day near midnight in negative-UTC-offset timezones. */
function localDateStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Shift a stored date value by `deltaMs`, PRESERVING its stored shape so a
 *  drag/resize round-trips through the same format the rest of the app reads:
 *  a date-only "YYYY-MM-DD" (all-day items, date-only task due/start) stays
 *  date-only and moves by whole days; a full datetime stays an ISO UTC string.
 *  Date-only shifting is done in whole days off a noon anchor so a DST
 *  transition inside the moved span can't nudge it onto the wrong calendar
 *  day (midnight ± a DST hour would). */
function shiftStored(v: string, deltaMs: number): string {
  if (v.length <= 10) {
    const days = Math.round(deltaMs / 86400000);
    const d = new Date(`${v.slice(0, 10)}T12:00:00`);
    d.setDate(d.getDate() + days);
    return localDateStr(d);
  }
  return new Date(new Date(v).getTime() + deltaMs).toISOString();
}

/** Occurrence offsets (ms from the item's anchor date) for a recurring item's
 *  RRULE that land within [windowStart, windowEnd]. Returned as deltas -- not
 *  absolute dates -- so the caller can shift the item's *stored* start/due via
 *  shiftStored and reuse every existing format/timezone path: the interval
 *  between occurrences is what rrule.js gives us reliably, sidestepping its
 *  known absolute-UTC quirks. dtstart handling mirrors db.ts's nextOccurrence
 *  (date-only anchored at UTC midnight). Capped so a pathological rule can't
 *  emit unbounded bars. Returns [] on a malformed rule. */
function occurrenceDeltas(rruleStr: string, anchor: string, windowStart: Date, windowEnd: Date): number[] {
  try {
    const dateOnly = anchor.length <= 10;
    const dtstart = new Date(dateOnly ? `${anchor}T00:00:00Z` : anchor);
    const rule = new RRule({ ...RRule.parseString(rruleStr), dtstart });
    const occs = rule.between(windowStart, windowEnd, true).slice(0, 400);
    return occs.map((o) => o.getTime() - dtstart.getTime());
  } catch {
    return [];
  }
}

/** Epoch ms for an occurrence key, tolerant of date-only vs datetime, so a
 *  RECURRENCE-ID / EXDATE matches the occurrence regardless of string format. */
function occEpoch(v: string): number {
  return new Date(v.length <= 10 ? `${v}T00:00:00Z` : v).getTime();
}
function parseExdates(json: string | undefined): string[] {
  try { return JSON.parse(json || "[]"); } catch { return []; }
}
function parseOverrides(json: string | undefined): EventOverride[] {
  try { return JSON.parse(json || "[]"); } catch { return []; }
}

export default function CalendarView({
  events, tasks, lists, calendarShow, onSetCalendarShow, selectedTaskId, selectedEventId, onSelectTask, onSelectEvent, onCreateEvent, onCreateTask, listFilter, onSetListFilter, onUpdateEvent, onUpdateTask
}: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const ecRef = useRef<ReturnType<typeof createCalendar> | null>(null);
  const [ready, setReady] = useState(false);
  // The calendar's currently-visible date span (activeRange, incl. the
  // leading/trailing days a month view shows). Set by the datesSet handler on
  // mount and on every navigate/view change; recurring items are expanded only
  // across this window (Thunderbird-style), so `rangeVersion` bumps force a
  // rebuild whenever it moves.
  const visibleRangeRef = useRef<{ start: Date; end: Date } | null>(null);
  const [rangeVersion, setRangeVersion] = useState(0);
  const [dayMenu, setDayMenu] = useState<{ x: number; y: number; dateStr: string } | null>(null);
  // Refs so the mount-once eventClick handler and the DOM dblclick/contextmenu
  // listeners always call the latest callback, even though they're wired up
  // once and never re-attached.
  const onSelectTaskRef = useRef(onSelectTask);
  const onSelectEventRef = useRef(onSelectEvent);
  const onCreateEventRef = useRef(onCreateEvent);
  const onCreateTaskRef = useRef(onCreateTask);
  useEffect(() => { onSelectTaskRef.current = onSelectTask; });
  useEffect(() => { onSelectEventRef.current = onSelectEvent; });
  useEffect(() => { onCreateEventRef.current = onCreateEvent; });
  useEffect(() => { onCreateTaskRef.current = onCreateTask; });
  // Same latest-value pattern for the drag/resize handlers, which are wired
  // once at mount but need the current events/tasks (to read the row being
  // moved), the current task display mode (which task date a bar maps to),
  // and the update callbacks.
  const onUpdateEventRef = useRef(onUpdateEvent);
  const onUpdateTaskRef = useRef(onUpdateTask);
  const eventsRef = useRef(events);
  const tasksRef = useRef(tasks);
  useEffect(() => { onUpdateEventRef.current = onUpdateEvent; });
  useEffect(() => { onUpdateTaskRef.current = onUpdateTask; });
  useEffect(() => { eventsRef.current = events; });
  useEffect(() => { tasksRef.current = tasks; });
  // Live preview of the event currently being dragged wider/narrower across
  // days (custom horizontal resize -- see the grip handlers in the mount
  // effect). buildEcEvents substitutes these dates for that one event while a
  // drag is in progress; null when idle.
  const hPreviewRef = useRef<{ id: string; start_date: string; end_date: string } | null>(null);
  // Latest buildEcEvents, so the once-wired grip drag can rebuild with current
  // data (the mount effect's own closure is frozen at first render).
  const buildEcEventsRef = useRef<() => any[]>(() => []);
  const [categoryFilter, setCategoryFilter] = useState(() => localStorage.getItem("calendarCategoryFilter") || "all");
  const [displayMode, setDisplayMode] = useState<DisplayMode>(
    () => (localStorage.getItem("calendarTaskDisplayMode") as DisplayMode) || "due"
  );
  // Events default to the full start..end range (multi-day events span every
  // day). Persisted separately from the task mode.
  const [eventDisplayMode, setEventDisplayMode] = useState<EventDisplayMode>(
    () => (localStorage.getItem("calendarEventDisplayMode") as EventDisplayMode) || "range"
  );
  // The display-mode select shows a short label when closed and expands to
  // the full description while focused/open, then shrinks back on blur.
  const [displayModeFocused, setDisplayModeFocused] = useState(false);
  const [eventDisplayModeFocused, setEventDisplayModeFocused] = useState(false);
  // Month/week/day toggle -- replaces the library's default "today" header
  // button (see headerToolbar in the mount effect below), which sat there
  // not doing anything useful for this app. Week/day use the TimeGrid
  // plugin's hourly views (not DayGrid's dayGridWeek) so hours of the day
  // actually show, rather than just a strip of day cells like month view.
  const CAL_VIEWS: { view: "dayGridMonth" | "timeGridWeek" | "timeGridDay"; label: string }[] = [
    { view: "dayGridMonth", label: "Month" },
    { view: "timeGridWeek", label: "Week" },
    { view: "timeGridDay", label: "Day" }
  ];
  const [calView, setCalView] = useState<"dayGridMonth" | "timeGridWeek" | "timeGridDay">("dayGridMonth");

  useEffect(() => { localStorage.setItem("calendarCategoryFilter", categoryFilter); }, [categoryFilter]);
  useEffect(() => { localStorage.setItem("calendarTaskDisplayMode", displayMode); }, [displayMode]);
  useEffect(() => { localStorage.setItem("calendarEventDisplayMode", eventDisplayMode); }, [eventDisplayMode]);
  const displayModeRef = useRef(displayMode);
  useEffect(() => { displayModeRef.current = displayMode; });
  useEffect(() => { buildEcEventsRef.current = buildEcEvents; });

  const showTasks = calendarShow !== "events";
  const showEvents = calendarShow !== "tasks";

  const allCategories = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) for (const c of splitTags(t.tags)) set.add(c);
    for (const e of events) for (const c of splitTags(e.tags)) set.add(c);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [tasks, events]);

  const colorFor = (listId: string) => lists.find((l) => l.id === listId)?.color || "#4a90d9";
  const matchesCategory = (tags: string) =>
    categoryFilter === "all" || splitTags(tags).includes(categoryFilter);

  // Occurrence offsets (ms) to draw a recurring item at. Non-recurring items
  // (and, defensively, recurring ones before the first datesSet has told us the
  // visible window) get a single [0] -- their stored date, unchanged. Recurring
  // items with a known window get one delta per occurrence inside it (padded 2
  // days each side so an occurrence right at the grid edge isn't clipped by
  // rrule/window timezone rounding); an empty result means the series simply
  // doesn't touch this view, so nothing is drawn -- the whole point of the
  // Thunderbird-style expansion replacing the old always-draw-the-base behavior.
  function deltasFor(recurrence: string | null, anchor: string): number[] {
    if (!recurrence) return [0];
    const range = visibleRangeRef.current;
    if (!range) return [0];
    const pad = 2 * 86400000;
    return occurrenceDeltas(recurrence, anchor, new Date(range.start.getTime() - pad), new Date(range.end.getTime() + pad));
  }

  function buildEcEvents() {
    const out: any[] = [];
    // Timed bars only make sense where hours are shown. Month view has no time
    // grid, so timed tasks/events stay all-day bars there; week/day draw them
    // as blocks at their time. (The reactive rebuild effect lists calView as a
    // dep so switching views re-expands with the right shape.)
    const isTimeGrid = calView !== "dayGridMonth";
    // While a horizontal (across-days) drag is in progress, render the dragged
    // event with its preview dates so the multi-day span updates live.
    const hp = hPreviewRef.current;
    const eventsForRender = hp
      ? events.map((ev) => (ev.id === hp.id ? { ...ev, start_date: hp.start_date, end_date: hp.end_date } : ev))
      : events;
    if (showEvents) {
      for (const e of eventsForRender) {
        if (listFilter !== "all" && e.list_id !== listFilter) continue;
        if (!matchesCategory(e.tags)) continue;
        const recurring = !!e.recurrence;
        // Per-occurrence exceptions: dates the user removed (exdates) are
        // skipped entirely, and edited occurrences (overrides, keyed by their
        // original start = RECURRENCE-ID) are drawn with the override's values.
        const exSet = recurring ? new Set(parseExdates(e.exdates).map(occEpoch)) : null;
        const ovMap = recurring
          ? new Map(parseOverrides(e.overrides).map((o): [number, EventOverride] => [occEpoch(o.recurrence_id), o]))
          : null;
        const deltas = deltasFor(e.recurrence, e.start_date);
        deltas.forEach((d, i) => {
          // This occurrence's ORIGINAL start (its RECURRENCE-ID), used to match
          // exdates/overrides and, on click, to tell step 5 which one was hit.
          const occStart = shiftStored(e.start_date, d);
          if (exSet && exSet.has(occEpoch(occStart))) return; // removed occurrence
          const ov = ovMap ? ovMap.get(occEpoch(occStart)) : undefined;
          const allDay = ov ? !!ov.all_day : !!e.all_day;
          // Stored start and INCLUSIVE end for this occurrence (all-day ends are
          // stored as the last day the event covers -- see ical.ts, which does
          // the exclusive<->inclusive conversion at the sync boundary).
          const startStored = ov ? ov.start_date : occStart;
          const endStored = ov ? (ov.end_date || ov.start_date) : shiftStored(e.end_date || e.start_date, d);
          // Map to the calendar library. It wants an EXCLUSIVE end for all-day
          // bars, so an inclusive last day becomes nextDay(lastDay) -- the same
          // trick the task bars below use. The "start"/"end" modes collapse the
          // event to a single all-day bar on that one day.
          let lStart: string, lEnd: string, lAllDay: boolean;
          if (eventDisplayMode === "start") {
            const day = localDay(startStored);
            lStart = day; lEnd = nextDay(day); lAllDay = true;
          } else if (eventDisplayMode === "end") {
            const day = localDay(endStored);
            lStart = day; lEnd = nextDay(day); lAllDay = true;
          } else if (allDay) {
            lStart = localDay(startStored); lEnd = nextDay(localDay(endStored)); lAllDay = true;
          } else {
            lStart = toLocalFloating(startStored);
            lEnd = toLocalFloating(endStored);
            lAllDay = false;
            // A timed event with no (or a non-positive) duration renders as a
            // zero-height sliver in week/day view, leaving no grabbable bottom
            // edge to stretch. Give it a 1-hour default span so the resize
            // handle is always hittable. Display only -- the stored end_date is
            // untouched; a real drag writes it back via eventResize below.
            if (new Date(lEnd).getTime() <= new Date(lStart).getTime()) {
              lEnd = toLocalFloating(shiftStored(startStored, 3600000));
            }
          }
          // Only the full "range" view is drag/resize-editable -- there each edge
          // maps to a real date field. The collapsed single-day modes are a
          // read-only projection, and recurring occurrences stay locked (a drag
          // would silently shift the whole series; the drag guards also revert).
          const editable = !recurring && eventDisplayMode === "range";
          out.push({
            // Occurrences beyond the first need distinct ids (the library
            // rejects duplicates); the master id is carried in extendedProps so
            // clicks still resolve to the real event. The base occurrence keeps
            // the plain `event-<id>` so the (editable, non-recurring) drag path
            // that slices the id off is unaffected.
            id: recurring ? `event-${e.id}::${i}` : `event-${e.id}`,
            title: ov ? (ov.title || e.title) : e.title,
            start: lStart,
            end: lEnd,
            allDay: lAllDay,
            backgroundColor: colorFor(e.list_id),
            classNames: [
              ...(e.id === selectedEventId ? ["ec-selected"] : []),
              ...(recurring ? ["ec-recurring"] : [])
            ],
            editable,
            // State the drag/resize flags per event rather than leaning on the
            // library's global fallback: in @event-calendar/core an event's
            // editable is only consulted AFTER the global eventStartEditable/
            // eventDurationEditable, so the collapsed single-day modes never
            // actually locked. Being explicit makes the full "range" view (and
            // only it) draggable + edge-resizable, including in week/day view.
            startEditable: editable,
            durationEditable: editable,
            extendedProps: { kind: "event", location: e.location, masterId: e.id, recurring, occurrenceStart: recurring ? occStart : null }
          });
        });
      }
    }
    if (showTasks) {
      for (const t of tasks) {
        if (t.completed || t.deleted) continue;
        if (listFilter !== "all" && t.list_id !== listFilter) continue;
        if (!matchesCategory(t.tags)) continue;
        const recurring = !!t.recurrence;
        // Recurrence is anchored on the due date (Tasks.org convention, matching
        // db.ts's completion roll-forward); the same interval is applied to
        // whichever field(s) the current display mode actually draws.
        const anchor = t.due_date || t.start_date;
        const classNamesFor = () => [
          "task-bar",
          ...(t.id === selectedTaskId ? ["ec-selected"] : []),
          ...(recurring ? ["ec-recurring"] : [])
        ];
        if (displayMode === "start") {
          const startOnly = t.start_date || t.due_date;
          if (!startOnly) continue;
          const deltas = deltasFor(t.recurrence, anchor || startOnly);
          deltas.forEach((d, i) => {
            const s = shiftStored(startOnly, d);
            // A task with a start time draws as a block at that time in week/
            // day view (was always all-day before, so a timed task created in
            // the day view landed in the all-day row). Span start->due when a
            // due time also exists and lands later; otherwise a 1-hour default.
            let lStart: string, lEnd: string, lAllDay: boolean;
            if (isTimeGrid && hasTime(s)) {
              // "Start date only" draws the START alone -- a timed start is a
              // 1-hour block at the start time. It must NOT reach for the due
              // date, or the bar would stop respecting this single-date filter.
              lStart = toLocalFloating(s);
              lEnd = toLocalFloating(shiftStored(s, 3600000));
              lAllDay = false;
            } else {
              lStart = s; lEnd = nextDay(s); lAllDay = true;
            }
            out.push({
              id: recurring ? `task-${t.id}::${i}` : `task-${t.id}`,
              title: t.title,
              start: lStart,
              end: lEnd,
              allDay: lAllDay,
              backgroundColor: colorFor(t.list_id),
              classNames: classNamesFor(),
              // Draggable to reschedule; not resizable in start/due mode -- a
              // single-day anchor has no second date field to grow into (only
              // the start-due "range" mode does). Recurring occurrences locked.
              editable: !recurring,
              startEditable: !recurring,
              durationEditable: false,
              extendedProps: { kind: "task", masterId: t.id, recurring }
            });
          });
          continue;
        }
        const due = t.due_date || t.start_date;
        if (!due) continue;
        const start = displayMode === "range" ? t.start_date || due : due;
        const deltas = deltasFor(t.recurrence, anchor || due);
        deltas.forEach((d, i) => {
          const shiftedDue = shiftStored(due, d);
          const shiftedStart = shiftStored(start, d);
          // Timed rendering when the drawn field(s) carry a time-of-day: range
          // spans start->due; due-only draws start->due if a start time exists
          // and precedes due, else a 1-hour block at the due time. Date-only
          // tasks (and month view) keep the all-day bar.
          const timed = isTimeGrid && (hasTime(shiftedDue) || (displayMode === "range" && hasTime(shiftedStart)));
          let lStart: string, lEnd: string, lAllDay: boolean;
          if (timed && displayMode === "range") {
            lStart = toLocalFloating(shiftedStart);
            lEnd = toLocalFloating(shiftedDue);
            if (new Date(lEnd).getTime() <= new Date(lStart).getTime()) {
              lEnd = toLocalFloating(shiftStored(hasTime(shiftedDue) ? shiftedDue : shiftedStart, 3600000));
            }
            lAllDay = false;
          } else if (timed) {
            // "Due date only" draws the DUE alone -- a timed due is a 1-hour
            // block at the due time. It must NOT reach for the start date, or
            // the bar would span start->due and stop respecting this filter.
            lStart = toLocalFloating(shiftedDue);
            lEnd = toLocalFloating(shiftStored(shiftedDue, 3600000));
            lAllDay = false;
          } else {
            lStart = shiftedStart; lEnd = nextDay(shiftedDue); lAllDay = true;
          }
          out.push({
            id: recurring ? `task-${t.id}::${i}` : `task-${t.id}`,
            title: t.title,
            start: lStart,
            end: lEnd,
            allDay: lAllDay,
            backgroundColor: colorFor(t.list_id),
            classNames: classNamesFor(),
            // Draggable to reschedule. Resizable only in "range" mode, where the
            // bar spans start_date..due_date and each edge maps to a real field
            // (works for timed range blocks too -- eventResize keeps datetimes).
            editable: !recurring,
            startEditable: !recurring,
            durationEditable: !recurring && displayMode === "range",
            extendedProps: { kind: "task", masterId: t.id, recurring }
          });
        });
      }
    }
    return out;
  }

  // Mount once.
  useEffect(() => {
    if (!elRef.current) return;
    ecRef.current = createCalendar(elRef.current, [DayGrid, TimeGrid, Interaction], {
      view: calView,
      // Default is `{start: 'title', center: '', end: 'today prev,next'}` --
      // drop "today" since our own Month/Week/Day toggle button (in
      // .calendar-view-toolbar below) replaces it.
      headerToolbar: { start: "title", center: "", end: "prev,next" },
      // The library formats its own column headings, view title and hour
      // gutter through `Intl`; without a locale it resolves one internally,
      // which needn't match what the rest of the app resolves. Pass ours so
      // the calendar can't disagree with the task table beside it.
      locale: appLocale(),
      // `firstDay` defaults to 0 (Sunday) regardless of locale, so every
      // Monday-first region -- all of Europe -- got the wrong week layout.
      // Resolved once at mount: the locale can't change without a restart.
      firstDay: firstDayOfWeek(),
      // Current-time marker line, only shown in the timeGrid week/day views.
      nowIndicator: true,
      // Enable drag-to-reschedule and edge-resize. Per-event `editable` /
      // `startEditable` / `durationEditable` flags in buildEcEvents() narrow
      // this down (recurring items locked, task bars resizable only in range
      // mode); eventDrop/eventResize below persist the result.
      editable: true,
      eventStartEditable: true,
      eventDurationEditable: true,
      // Put a resize handle on BOTH edges, not just the end. Without this the
      // library only draws the end-edge handle (bottom in week/day, right in
      // month), so the start edge fell through to the drag/move cursor -- a
      // bar looked un-stretchable from its top/left. Now hovering either edge
      // shows the resize cursor (up/down in the hourly grid, left/right across
      // day bars); eventResize already maps the start edge to start_date.
      eventResizableFromStart: true,
      // Default `true` stacks same-time events on top of each other with a
      // slight offset, which makes the ones underneath hard to click in
      // week/day view. `false` lays intersecting events side by side in
      // their own columns instead -- each stays independently clickable.
      slotEventOverlap: false,
      // Fires on mount and on every navigate/view change with the visible span
      // (activeRange). Stash it and bump rangeVersion so the reactive effect
      // re-expands recurring items for the new window. Guard against a no-op
      // re-fire (same bounds) so we don't loop.
      datesSet(info: any) {
        const cur = visibleRangeRef.current;
        if (cur && cur.start.getTime() === info.start.getTime() && cur.end.getTime() === info.end.getTime()) return;
        visibleRangeRef.current = { start: info.start, end: info.end };
        setRangeVersion((v) => v + 1);
      },
      events: buildEcEvents(),
      // Attach the custom horizontal "span across days" grips as each timed
      // event segment mounts (see mkGrip/startHDrag below). Only week view,
      // only real events, and only on the segment owning the true start/end.
      eventDidMount(info: any) {
        if (info?.view?.type !== "timeGridWeek") return;
        const ev = info.event;
        if (ev.allDay) return;
        const props = ev.extendedProps || {};
        if (props.kind !== "event" || props.recurring) return;
        const id = props.masterId ?? String(ev.id).slice(6);
        const elx: HTMLElement = info.el;
        if (!elx.classList.contains("ec-end-clipped")) elx.appendChild(mkGrip("end", id));
        if (!elx.classList.contains("ec-start-clipped")) elx.appendChild(mkGrip("start", id));
      },
      // A day with a lot of tasks/events stretches its whole week row taller
      // (library behavior, unchanged) -- `dayMaxEvents` turned out
      // unreliable here (`true` broke an unrelated week's layout, a fixed
      // number had no visible effect), and capping the day cell's own
      // height fought the library's row layout too. Instead the mount root
      // itself scrolls -- see `.calendar-view-grid { overflow-y: auto }` in
      // styles.css -- so a tall week just makes the grid scrollable instead
      // of pushing later weeks off screen.
      // @event-calendar/core's built-in time-badge text (driven by its
      // `eventTimeFormat` option) comes out wrong here -- off by the local
      // UTC offset -- even though the Details panel and reminder
      // notifications, which just do a plain `new Date(...).getHours()` on
      // the same stored value, show the correct time. Rather than continuing
      // to chase the library's internal conversion, render the time badge
      // ourselves: `arg.event.start`/`.end` here are already a correctly
      //-converted local `Date` (the library's own `toLocalDate()` helper),
      // so formatting it through dateFormat here is trustworthy.
      eventContent(arg: any) {
        const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        // A small ↻ badge marks generated recurrence occurrences so they read
        // as "part of a series" rather than individually-stored items.
        const mark = arg.event.extendedProps?.recurring ? '<span class="ec-recur-mark" aria-label="repeats">↻</span>' : "";
        if (arg.event.allDay) {
          if (!mark) return undefined; // default (title-only) rendering is fine
          return { html: `${mark}<span class="ec-event-title">${escape(arg.event.title)}</span>` };
        }
        const timeText = formatTime(arg.event.start as Date);
        return { html: `${mark}<time class="ec-event-time">${escape(timeText)}</time><h4 class="ec-event-title">${escape(arg.event.title)}</h4>` };
      },
      eventClick(info: any) {
        // A recurring occurrence's id has an `::<n>` suffix, so prefer the
        // master id stashed in extendedProps; fall back to slicing the prefix
        // off the plain `task-`/`event-` id for anything without it.
        const props = info?.event?.extendedProps ?? {};
        const id = String(info?.event?.id ?? "");
        if (props.kind === "task") onSelectTaskRef.current(props.masterId ?? id.slice(5));
        else if (props.kind === "event") onSelectEventRef.current(props.masterId ?? id.slice(6), props.occurrenceStart ?? null);
      },
      // Drag a bar to a new day/time. `info.event`/`info.oldEvent` carry the
      // library's already-local Date start/end; the millisecond diff between
      // them is the move, applied to the stored value via shiftStored (which
      // keeps date-only stays-date-only / datetime-stays-ISO). We shift the
      // *stored* field rather than re-serialize info.event so we don't disturb
      // all-day end semantics or a null end_date -- except when a drag crosses
      // the all-day boundary (week/day view has an all-day row), where we must
      // rebuild from the library dates and flip all_day.
      eventDrop(info: any) {
        const id = String(info?.event?.id ?? "");
        const deltaMs = (info.event.start as Date).getTime() - (info.oldEvent.start as Date).getTime();
        if (id.startsWith("event-")) {
          const ev = eventsRef.current.find((e) => e.id === id.slice(6));
          if (!ev || ev.recurrence) { info.revert?.(); return; }
          const wasAllDay = !!info.oldEvent.allDay;
          const nowAllDay = !!info.event.allDay;
          const patch: Partial<CalendarEvent> = {};
          if (wasAllDay === nowAllDay) {
            patch.start_date = shiftStored(ev.start_date, deltaMs);
            if (ev.end_date) patch.end_date = shiftStored(ev.end_date, deltaMs);
          } else {
            patch.all_day = nowAllDay ? 1 : 0;
            patch.start_date = nowAllDay ? localDateStr(info.event.start) : (info.event.start as Date).toISOString();
            if (ev.end_date && info.event.end) {
              patch.end_date = nowAllDay ? localDateStr(info.event.end) : (info.event.end as Date).toISOString();
            }
          }
          onUpdateEventRef.current(ev.id, patch);
        } else if (id.startsWith("task-")) {
          const t = tasksRef.current.find((x) => x.id === id.slice(5));
          if (!t || t.recurrence) { info.revert?.(); return; }
          const mode = displayModeRef.current;
          const patch: Partial<Task> = {};
          if (mode === "start") {
            if (t.start_date) patch.start_date = shiftStored(t.start_date, deltaMs);
            else if (t.due_date) patch.due_date = shiftStored(t.due_date, deltaMs);
          } else if (mode === "range") {
            // Whole bar moved -- shift both ends that exist by the same delta.
            if (t.start_date) patch.start_date = shiftStored(t.start_date, deltaMs);
            if (t.due_date) patch.due_date = shiftStored(t.due_date, deltaMs);
          } else {
            // "due" -- the bar is anchored to the due date (start fallback).
            if (t.due_date) patch.due_date = shiftStored(t.due_date, deltaMs);
            else if (t.start_date) patch.start_date = shiftStored(t.start_date, deltaMs);
          }
          if (Object.keys(patch).length) onUpdateTaskRef.current(t.id, patch);
          else info.revert?.();
        }
      },
      // Drag an edge to change duration. Resizes report separate startDelta /
      // endDelta; here we recompute each from the Date diff and move only the
      // edge(s) that actually changed. Events map to start_date/end_date; task
      // bars (range mode only, per durationEditable above) map their left edge
      // to start_date and right edge to due_date.
      eventResize(info: any) {
        const id = String(info?.event?.id ?? "");
        const startDeltaMs = (info.event.start as Date).getTime() - (info.oldEvent.start as Date).getTime();
        const endDeltaMs = (info.event.end as Date).getTime() - (info.oldEvent.end as Date).getTime();
        if (id.startsWith("event-")) {
          const ev = eventsRef.current.find((e) => e.id === id.slice(6));
          if (!ev || ev.recurrence) { info.revert?.(); return; }
          const patch: Partial<CalendarEvent> = {};
          if (startDeltaMs) patch.start_date = shiftStored(ev.start_date, startDeltaMs);
          if (endDeltaMs) patch.end_date = shiftStored(ev.end_date || ev.start_date, endDeltaMs);
          if (Object.keys(patch).length) onUpdateEventRef.current(ev.id, patch);
          else info.revert?.();
        } else if (id.startsWith("task-")) {
          const t = tasksRef.current.find((x) => x.id === id.slice(5));
          if (!t || t.recurrence) { info.revert?.(); return; }
          const patch: Partial<Task> = {};
          const startBase = t.start_date || t.due_date;
          const endBase = t.due_date || t.start_date;
          if (startDeltaMs && startBase) patch.start_date = shiftStored(startBase, startDeltaMs);
          if (endDeltaMs && endBase) patch.due_date = shiftStored(endBase, endDeltaMs);
          if (Object.keys(patch).length) onUpdateTaskRef.current(t.id, patch);
          else info.revert?.();
        }
      }
    });
    setReady(true);

    // A single click is used for selecting tasks/events, so day creation
    // needs its own gestures (Thunderbird-style): double-click a blank day to
    // create an event, or right-click for a menu with New Event/New Task/
    // month navigation. Both are attached as plain DOM listeners since the
    // Interaction plugin only offers a single-click dateClick.
    const el = elRef.current;
    // ---- Horizontal "span across days" resize for TIMED events ----
    // The calendar library resizes timed events only vertically (by time).
    // These grips sit on the left/right edges of the segment that owns the
    // event's true start/end; dragging one moves that endpoint onto whatever
    // day is under the pointer (keeping its time-of-day), so a one-day event
    // can be stretched to span several days -- and pulled back. Live preview
    // via hPreviewRef; persisted on release through the same update path as a
    // normal resize.
    function mkGrip(edge: "start" | "end", id: string): HTMLDivElement {
      const g = document.createElement("div");
      g.className = `ec-hgrip ec-hgrip-${edge}`;
      g.addEventListener("pointerdown", (je) => startHDrag(je, edge, id));
      return g;
    }
    function startHDrag(jsEvent: PointerEvent, edge: "start" | "end", id: string) {
      jsEvent.preventDefault();
      jsEvent.stopPropagation(); // stop the library's own drag/resize from also starting
      const ev0 = eventsRef.current.find((x) => x.id === id);
      if (!ev0 || ev0.recurrence) return;
      hPreviewRef.current = { id, start_date: ev0.start_date, end_date: ev0.end_date || ev0.start_date };
      const rebuild = () => ecRef.current?.setOption("events", buildEcEventsRef.current());
      const onMove = (mv: PointerEvent) => {
        const info = ecRef.current?.dateFromPoint(mv.clientX, mv.clientY);
        const cur = hPreviewRef.current;
        if (!info?.date || !cur) return;
        if (edge === "end") {
          let ne = withDayLocal(cur.end_date, info.date);
          if (dayEpochOf(ne) < dayEpochOf(cur.start_date)) ne = withDayLocal(cur.end_date, dayDateOf(cur.start_date));
          cur.end_date = ne;
        } else {
          let ns = withDayLocal(cur.start_date, info.date);
          if (dayEpochOf(ns) > dayEpochOf(cur.end_date)) ns = withDayLocal(cur.start_date, dayDateOf(cur.end_date));
          cur.start_date = ns;
        }
        rebuild();
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const pv = hPreviewRef.current;
        hPreviewRef.current = null;
        if (pv) {
          const orig = eventsRef.current.find((x) => x.id === pv.id);
          const patch: Partial<CalendarEvent> = {};
          if (orig && pv.start_date !== orig.start_date) patch.start_date = pv.start_date;
          if (orig && pv.end_date !== (orig.end_date || orig.start_date)) patch.end_date = pv.end_date;
          if (Object.keys(patch).length) onUpdateEventRef.current(pv.id, patch);
        }
        rebuild();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    }
    function isOnEvent(target: EventTarget | null): boolean {
      return !!(target as HTMLElement)?.closest?.(".ec-event");
    }
    // In month view, dateFromPoint's `date` is midnight with no meaningful
    // time-of-day (allDay: true) -- only a plain "YYYY-MM-DD" makes sense
    // there. In week/day view, a click inside the hourly grid carries a real
    // time (allDay: false), so the full instant is passed through as an ISO
    // string instead, which createEventOnDate/createTaskOnDate (App.tsx)
    // detect via string length to prefill the time field and default a
    // 1-hour span.
    function pointToStr(info: { date: Date; allDay: boolean }): string {
      return info.allDay ? localDateStr(info.date) : info.date.toISOString();
    }
    function onDblClick(e: MouseEvent) {
      if (isOnEvent(e.target)) return;
      const info = ecRef.current?.dateFromPoint(e.clientX, e.clientY);
      if (!info?.date) return;
      onCreateEventRef.current(pointToStr(info));
    }
    function onContextMenu(e: MouseEvent) {
      if (isOnEvent(e.target)) return;
      const info = ecRef.current?.dateFromPoint(e.clientX, e.clientY);
      if (!info?.date) return;
      e.preventDefault();
      setDayMenu({ x: e.clientX, y: e.clientY, dateStr: pointToStr(info) });
    }
    el.addEventListener("dblclick", onDblClick);
    el.addEventListener("contextmenu", onContextMenu);

    return () => {
      el.removeEventListener("dblclick", onDblClick);
      el.removeEventListener("contextmenu", onContextMenu);
      if (ecRef.current) destroyCalendar(ecRef.current);
      ecRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reactive updates: push new event data whenever anything relevant changes,
  // without tearing down/recreating the calendar.
  useEffect(() => {
    if (!ready || !ecRef.current) return;
    ecRef.current.setOption("events", buildEcEvents());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, rangeVersion, events, tasks, calendarShow, lists, categoryFilter, displayMode, eventDisplayMode, listFilter, selectedTaskId, selectedEventId, calView]);

  useEffect(() => {
    if (!ready || !ecRef.current) return;
    ecRef.current.setOption("view", calView);
  }, [ready, calView]);

  const displayModeShortLabel: Record<DisplayMode, string> = {
    due: "Tasks: Due",
    start: "Tasks: Start",
    range: "Tasks: Start–Due"
  };
  const displayModeFullLabel: Record<DisplayMode, string> = {
    due: "Tasks: Due date only",
    start: "Tasks: Start date only",
    range: "Tasks: Start–due range"
  };
  const displayModeLabel = displayModeFocused ? displayModeFullLabel : displayModeShortLabel;
  const eventDisplayModeShortLabel: Record<EventDisplayMode, string> = {
    end: "Events: End",
    start: "Events: Start",
    range: "Events: Start–End"
  };
  const eventDisplayModeFullLabel: Record<EventDisplayMode, string> = {
    end: "Events: End date only",
    start: "Events: Start date only",
    range: "Events: Start–end range"
  };
  const eventDisplayModeLabel = eventDisplayModeFocused ? eventDisplayModeFullLabel : eventDisplayModeShortLabel;
  const listFilterLabel = listFilter === "all" ? "List: All" : `List: ${lists.find((l) => l.id === listFilter)?.name ?? "All"}`;
  const showLabel: Record<CalendarShow, string> = {
    both: "Show both",
    tasks: "Show tasks",
    events: "Show events"
  };

  return (
    <div className="calendar-view">
      <div className="calendar-view-toolbar">
        <select
          className="due-filter-select"
          value={calView}
          title="Switch between month, week, and day view"
          style={{ width: selectWidth(CAL_VIEWS.find((v) => v.view === calView)?.label ?? "Month") }}
          onChange={(e) => setCalView(e.target.value as typeof calView)}
        >
          {CAL_VIEWS.map((v) => <option key={v.view} value={v.view}>{v.label}</option>)}
        </select>
        <select
          className="due-filter-select"
          value={calendarShow}
          title="Show tasks, events, or both on the calendar"
          style={{ width: selectWidth(showLabel[calendarShow]) }}
          onChange={(e) => onSetCalendarShow(e.target.value as CalendarShow)}
        >
          <option value="both">Show both</option>
          <option value="tasks">Show tasks</option>
          <option value="events">Show events</option>
        </select>
        <select
          className="due-filter-select"
          value={displayMode}
          disabled={!showTasks}
          title="How task dates are drawn on the calendar"
          style={{ width: selectWidth(displayModeLabel[displayMode]) }}
          onFocus={() => setDisplayModeFocused(true)}
          onBlur={() => setDisplayModeFocused(false)}
          onChange={(e) => setDisplayMode(e.target.value as DisplayMode)}
        >
          <option value="due">{displayModeLabel.due}</option>
          <option value="start">{displayModeLabel.start}</option>
          <option value="range">{displayModeLabel.range}</option>
        </select>
        <select
          className="due-filter-select"
          value={eventDisplayMode}
          disabled={!showEvents}
          title="How event dates are drawn on the calendar"
          style={{ width: selectWidth(eventDisplayModeLabel[eventDisplayMode]) }}
          onFocus={() => setEventDisplayModeFocused(true)}
          onBlur={() => setEventDisplayModeFocused(false)}
          onChange={(e) => setEventDisplayMode(e.target.value as EventDisplayMode)}
        >
          <option value="end">{eventDisplayModeLabel.end}</option>
          <option value="start">{eventDisplayModeLabel.start}</option>
          <option value="range">{eventDisplayModeLabel.range}</option>
        </select>
        <select
          className="due-filter-select"
          value={listFilter}
          title="Isolate the calendar to one list/calendar (same as right-click → Show only… in the sidebar)"
          style={{ width: selectWidth(listFilterLabel) }}
          onChange={(e) => onSetListFilter(e.target.value)}
        >
          <option value="all">List: All</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>List: {l.name}</option>
          ))}
        </select>
        {allCategories.length > 0 && (
          <select
            className="due-filter-select"
            value={categoryFilter}
            style={{ width: selectWidth(categoryFilter === "all" ? "Category: All" : categoryFilter) }}
            onChange={(e) => setCategoryFilter(e.target.value)}
          >
            <option value="all">Category: All</option>
            {allCategories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
      </div>
      <div ref={elRef} className="calendar-view-grid ec-dark" />
      {dayMenu && (
        <ContextMenu
          x={dayMenu.x}
          y={dayMenu.y}
          onClose={() => setDayMenu(null)}
          items={[
            { label: "New Event", onClick: () => onCreateEventRef.current(dayMenu.dateStr) },
            { label: "New Task", onClick: () => onCreateTaskRef.current(dayMenu.dateStr) },
            { label: "Previous Month", onClick: () => ecRef.current?.prev() },
            { label: "Next Month", onClick: () => ecRef.current?.next() }
          ]}
        />
      )}
    </div>
  );
}
