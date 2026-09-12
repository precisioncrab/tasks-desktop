import React, { useEffect, useMemo, useState, useCallback } from "react";
import Sidebar from "./components/Sidebar";
import AddonMenuBar from "./components/AddonMenuBar";
import TaskTable from "./components/TaskTable";
import DetailPanel from "./components/DetailPanel";
import ContextMenu from "./components/ContextMenu";
import SettingsModal from "./components/SettingsModal";
import AboutModal from "./components/AboutModal";
import CalendarView, { CalendarShow } from "./components/CalendarView";
import TodayPane from "./components/TodayPane";
import ContactsRail from "./components/ContactsRail";
import EventDetailPanel from "./components/EventDetailPanel";
import ContactsView from "./components/ContactsView";
import ImportVCardModal from "./components/ImportVCardModal";
import ContactsSidebar from "./components/ContactsSidebar";
import ContactDetailPanel from "./components/ContactDetailPanel";
import { ContactFilter, LabelColors, findDuplicateClusters, contactCategories, contactLabels } from "./contactUtils";
import MergeDuplicatesView from "./components/MergeDuplicatesView";
import { Task, TaskList, CaldavAccountPublic, CalendarEvent, Contact, AddressBook, EventOverride } from "./types";
import { selectWidth } from "./selectWidth";
import { RRule } from "rrule";

type Scope = string | "all" | "today";
type SortMode = "priority" | "due" | "title" | "manual";

/** A saved view: every knob in the toolbar plus the selected scope. */
interface SmartFilter {
  id: string;
  name: string;
  scope: Scope;
  search: string;
  dueFilter: "all" | "today" | "week" | "month";
  categoryFilter: string;
  hideCompleted: boolean;
  showScheduled: boolean;
}

function loadSmartFilters(): SmartFilter[] {
  try { return JSON.parse(localStorage.getItem("smartFilters") || "[]"); } catch { return []; }
}

/** Epoch ms for an occurrence key, tolerant of date-only vs datetime, so a
 *  RECURRENCE-ID / EXDATE matches the occurrence regardless of string format. */
function occEpoch(v: string): number {
  return new Date(v.length <= 10 ? `${v}T00:00:00Z` : v).getTime();
}
function parseJsonArr<T>(s: string | undefined): T[] {
  try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
/** Cap a recurrence rule so its last occurrence falls strictly before
 *  `boundary` (the split occurrence). Used by the "this and following" split. */
function addUntilToRule(rruleStr: string, boundary: string): string {
  try {
    const opts = RRule.parseString(rruleStr);
    delete (opts as any).count; // UNTIL and COUNT are mutually exclusive
    opts.until = new Date(occEpoch(boundary) - 1000);
    return RRule.optionsToString(opts).replace(/^RRULE:/, "");
  } catch {
    return rruleStr;
  }
}

export default function App() {
  const [lists, setLists] = useState<TaskList[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [mainView, setMainView] = useState<"tasks" | "calendar" | "contacts">("tasks");
  const [calendarShow, setCalendarShow] = useState<CalendarShow>(
    () => (localStorage.getItem("calendarShow") as CalendarShow) || "both"
  );
  // "all" or a single list id -- right-click a list/calendar in the sidebar
  // ("Show only ...") to isolate the calendar view to it.
  const [calendarListFilter, setCalendarListFilter] = useState(() => localStorage.getItem("calendarListFilter") || "all");
  useEffect(() => { localStorage.setItem("calendarListFilter", calendarListFilter); }, [calendarListFilter]);
  const [accounts, setAccounts] = useState<CaldavAccountPublic[]>([]);
  const [scope, setScope] = useState<Scope>("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  // One-shot signal: the id of a task/event just created, so its detail panel
  // focuses+selects the title field. Cleared once the panel consumes it.
  const [focusTitleId, setFocusTitleId] = useState<string | null>(null);
  // User-chosen default destinations for new tasks/events (from Settings). Empty
  // = no explicit choice; the fallback chain in defaultListId/defaultEventListId
  // then prefers a synced list over a local one.
  const [defaultTaskList, setDefaultTaskList] = useState("");
  const [defaultEventList, setDefaultEventList] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [addressBooks, setAddressBooks] = useState<AddressBook[]>([]);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [contactFilter, setContactFilter] = useState<ContactFilter>({ kind: "all" });
  const [labelColors, setLabelColors] = useState<LabelColors>({});
  const [contactsMode, setContactsMode] = useState<"list" | "duplicates">("list");
  const [dismissedDupPairs, setDismissedDupPairs] = useState<Set<string>>(new Set());
  // The specific occurrence (RECURRENCE-ID) the user opened, set when a
  // recurring event is clicked on the calendar; null when selected another way.
  const [selectedEventOccurrence, setSelectedEventOccurrence] = useState<string | null>(null);
  // Experimental: collapses the Today pane + detail panel column, and/or the
  // sidebar, so the calendar/task table can use the freed width.
  const [railCollapsed, setRailCollapsed] = useState(() => localStorage.getItem("railCollapsed") === "1");
  useEffect(() => { localStorage.setItem("railCollapsed", railCollapsed ? "1" : "0"); }, [railCollapsed]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("sidebarCollapsed") === "1");
  useEffect(() => { localStorage.setItem("sidebarCollapsed", sidebarCollapsed ? "1" : "0"); }, [sidebarCollapsed]);
  // Task and event selection are mutually exclusive -- the right rail shows
  // one detail panel at a time. Selecting something re-expands the rail if
  // it was collapsed, so its details are actually visible.
  function selectTask(id: string | null) {
    setSelectedEventId(null);
    setSelectedContactId(null);
    setSelectedTaskId(id);
    if (id) setRailCollapsed(false);
  }
  function selectEvent(id: string | null, occurrenceStart: string | null = null) {
    setSelectedTaskId(null);
    setSelectedContactId(null);
    setSelectedEventId(id);
    setSelectedEventOccurrence(occurrenceStart);
    if (id) setRailCollapsed(false);
  }
  function selectContact(id: string | null) {
    setSelectedTaskId(null);
    setSelectedEventId(null);
    setSelectedContactId(id);
    if (id) setRailCollapsed(false);
  }

  // One-level undo. Each mutating task action records an inverse closure here,
  // overwriting any previous one (single level, as requested). Ctrl/Cmd+Z runs
  // it. Closures only issue the reversing IPC calls; undoLast handles the
  // refresh, selection cleanup, and sync scheduling.
  const lastActionRef = React.useRef<null | (() => Promise<void>)>(null);
  async function undoLast() {
    const action = lastActionRef.current;
    if (!action) return;
    lastActionRef.current = null; // consume — one level only
    await action();
    const fresh = await window.api.tasks.all();
    setTasks(fresh);
    if (selectedTaskId && !fresh.some((t) => t.id === selectedTaskId)) selectTask(null);
    // Events can also be undone (delete/edit/create), so refresh them too and
    // fix the event selection if the undone action changed what exists.
    const freshEvents = (await window.api.events?.all()) ?? [];
    setEvents(freshEvents);
    if (selectedEventId && !freshEvents.some((e) => e.id === selectedEventId)) selectEvent(null);
    scheduleDirtySync();
  }
  // Keep a live ref so the menu's IPC listener (registered once) always calls
  // the current undoLast closure rather than a stale first-render one.
  const undoRef = React.useRef(undoLast);
  undoRef.current = undoLast;

  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; taskId: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsPane, setSettingsPane] = useState<"accounts" | "calendars" | "contacts" | "sync" | "server" | "notifications" | undefined>(undefined);
  const [showAbout, setShowAbout] = useState(false);
  const [showImport, setShowImport] = useState(false);

  // First-run cue for the built-in sync server: if it's enabled but the setup
  // card hasn't been dismissed yet, open Settings to the Sync Server pane so the
  // user sees (and can change) the auto-generated username/password once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await window.api.server?.status();
        if (!cancelled && s && s.feature && s.enabled && !s.configured) {
          setSettingsPane("server");
          setShowSettings(true);
        }
      } catch { /* no server IPC (add-on) — skip */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // The main process auto-creates/updates Daynizer's own account against the
  // built-in server; refresh lists/accounts/contacts when it signals it's ready
  // so the account and its default Calendar/Contacts appear without a restart.
  useEffect(() => {
    if (!window.api.server) return;
    return window.api.on("server:accountReady", () => {
      loadLists(); loadTasks(); loadAccounts(); loadAddressBooks(); loadContacts();
    });
  }, []);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [forceAddingList, setForceAddingList] = useState(false);
  const [hideCompleted, setHideCompleted] = useState(() => localStorage.getItem("hideCompleted") === "1");
  const [dueFilter, setDueFilter] = useState<"all" | "today" | "week" | "month">("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  // Persisted like hideCompleted/sortMode beside it -- without this the toggle
  // silently reset to "hidden" on every relaunch.
  const [showScheduled, setShowScheduled] = useState(() => localStorage.getItem("showScheduled") === "1");
  const [sortMode, setSortMode] = useState<SortMode>(() => (localStorage.getItem("sortMode") as SortMode) || "priority");
  // These three toolbar selects show a short label when closed and expand to
  // the full description while focused/open (same effect as the calendar's
  // Tasks: Due/Start/Start–Due select).
  const [dueFocused, setDueFocused] = useState(false);
  const [categoryFocused, setCategoryFocused] = useState(false);
  const [sortFocused, setSortFocused] = useState(false);
  const [smartFilters, setSmartFilters] = useState<SmartFilter[]>(loadSmartFilters);
  const [savingView, setSavingView] = useState(false);
  const [viewName, setViewName] = useState("");
  // Set while applying a smart filter so the scope-change effect below doesn't
  // immediately wipe the filter values the smart filter just set.
  const applyingFilterRef = React.useRef(false);

  useEffect(() => {
    localStorage.setItem("hideCompleted", hideCompleted ? "1" : "0");
  }, [hideCompleted]);
  useEffect(() => {
    localStorage.setItem("sortMode", sortMode);
  }, [sortMode]);
  useEffect(() => {
    localStorage.setItem("showScheduled", showScheduled ? "1" : "0");
  }, [showScheduled]);
  useEffect(() => {
    localStorage.setItem("smartFilters", JSON.stringify(smartFilters));
  }, [smartFilters]);
  useEffect(() => {
    localStorage.setItem("calendarShow", calendarShow);
  }, [calendarShow]);

  // Reset filters when switching lists
  useEffect(() => {
    if (applyingFilterRef.current) { applyingFilterRef.current = false; return; }
    setDueFilter("all"); setCategoryFilter("all");
  }, [scope]);

  function applySmartFilter(f: SmartFilter) {
    applyingFilterRef.current = true;
    setScope(f.scope);
    setSearch(f.search);
    setDueFilter(f.dueFilter);
    setCategoryFilter(f.categoryFilter);
    setHideCompleted(f.hideCompleted);
    setShowScheduled(f.showScheduled);
  }

  function saveCurrentView(name: string) {
    const f: SmartFilter = {
      id: String(Date.now()),
      name: name.trim() || "Untitled filter",
      scope, search, dueFilter, categoryFilter, hideCompleted, showScheduled
    };
    setSmartFilters((prev) => [...prev, f]);
    setSavingView(false);
    setViewName("");
  }

  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const syncInFlight = React.useRef(false);
  // Latest runSync without retriggering the timer effect on every render.
  const runSyncRef = React.useRef<(auto?: boolean) => void>(() => {});
  const [syncEveryMin, setSyncEveryMin] = useState(60);

  useEffect(() => { runSyncRef.current = runSync; });

  // Read the auto-sync interval at startup and again whenever Settings closes
  // (the user may have just changed it).
  useEffect(() => {
    if (showSettings) return;
    window.api.settings?.all().then((s: Record<string, string>) => {
      const v = parseInt(s.syncIntervalMinutes ?? "60", 10);
      setSyncEveryMin(Number.isFinite(v) && v >= 0 ? v : 60);
      setDefaultTaskList(s.defaultTaskListId ?? "");
      setDefaultEventList(s.defaultEventListId ?? "");
    }).catch(() => {});
  }, [showSettings]);

  // Background auto-sync. 0 = manual only.
  useEffect(() => {
    if (!syncEveryMin) return;
    const id = setInterval(() => runSyncRef.current(true), syncEveryMin * 60_000);
    return () => clearInterval(id);
  }, [syncEveryMin]);

  // Sync once shortly after launch, mirroring Tasks.org's "sync when the app
  // is opened" behavior. Small delay so it doesn't race the initial list/task
  // load or the window still painting in.
  useEffect(() => {
    const t = setTimeout(() => runSyncRef.current(true), 1500);
    return () => clearTimeout(t);
  }, []);

  // Debounced "sync after edits" — mirrors Tasks.org's dirty-row watcher:
  // creating/editing/completing/deleting a task schedules a quiet auto-sync
  // ~1 minute after the *last* change, so rapid edits collapse into one sync
  // instead of one per keystroke/save.
  const dirtySyncTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleDirtySync = useCallback(() => {
    if (dirtySyncTimer.current) clearTimeout(dirtySyncTimer.current);
    dirtySyncTimer.current = setTimeout(() => {
      dirtySyncTimer.current = null;
      runSyncRef.current(true);
    }, 60_000);
  }, []);
  useEffect(() => () => { if (dirtySyncTimer.current) clearTimeout(dirtySyncTimer.current); }, []);

  const loadLists = useCallback(async () => setLists(await window.api.lists.all()), []);
  const loadTasks = useCallback(async () => setTasks(await window.api.tasks.all()), []);
  const loadAccounts = useCallback(async () => setAccounts(await window.api.accounts.all()), []);
  // Absent in the Thunderbird add-on shim -- always optional-chain.
  const loadEvents = useCallback(async () => setEvents((await window.api.events?.all()) ?? []), []);
  const loadContacts = useCallback(async () => setContacts((await window.api.contacts?.all()) ?? []), []);
  const loadAddressBooks = useCallback(async () => setAddressBooks((await window.api.addressbooks?.all()) ?? []), []);
  const loadLabelColors = useCallback(async () => {
    const s = (await window.api.settings?.all()) ?? {};
    try { setLabelColors(JSON.parse(s.contactLabelColors || "{}")); } catch { setLabelColors({}); }
    try { const a = JSON.parse(s.dismissedDupPairs || "[]"); setDismissedDupPairs(new Set(Array.isArray(a) ? a : [])); } catch { setDismissedDupPairs(new Set()); }
  }, []);

  useEffect(() => { loadLists(); loadTasks(); loadAccounts(); loadEvents(); loadContacts(); loadAddressBooks(); loadLabelColors(); }, [loadLists, loadTasks, loadAccounts, loadEvents, loadContacts, loadAddressBooks, loadLabelColors]);

  const duplicateClusters = useMemo(
    () => findDuplicateClusters(contacts.filter((c) => !c.deleted), dismissedDupPairs),
    [contacts, dismissedDupPairs]
  );

  async function dismissDupPairs(pairKeys: string[]) {
    const next = new Set(dismissedDupPairs);
    for (const k of pairKeys) next.add(k);
    setDismissedDupPairs(next);
    await window.api.settings?.set("dismissedDupPairs", JSON.stringify([...next]));
  }

  async function mergeContacts(keeperId: string, loserIds: string[], patch: Partial<Contact>) {
    await window.api.contacts?.merge(keeperId, loserIds, patch);
    if (selectedContactId && loserIds.includes(selectedContactId)) selectContact(null);
    const fresh = (await window.api.contacts?.all()) ?? [];
    setContacts(fresh);
    scheduleDirtySync();
    // Where to go next: if other duplicate clusters remain, stay in the
    // duplicates view so the user can keep resolving them (the merge editor
    // returns to the cluster list on its own). Only when everything is resolved
    // do we drop back to the contacts list on the surviving contact.
    const remaining = findDuplicateClusters(fresh.filter((c) => !c.deleted), dismissedDupPairs);
    if (remaining.length === 0) {
      setContactsMode("list");
      selectContact(keeperId);
      setSyncMsg(`Merged ${loserIds.length + 1} contacts into one.`);
      setTimeout(() => setSyncMsg(null), 4000);
    }
  }

  useEffect(() => {
    const offs = [
      window.api.on("shortcut:new-task", () => createTaskInScope()),
      window.api.on("shortcut:new-list", () => setForceAddingList(true)),
      window.api.on("shortcut:focus-search", () => searchInputRef.current?.focus()),
      window.api.on("shortcut:sync-now", () => runSync()),
      window.api.on("shortcut:undo", () => undoRef.current()),
      window.api.on("shortcut:open-settings", () => setShowSettings(true)),
      window.api.on("shortcut:open-about", () => setShowAbout(true)),
      window.api.on("notify:select-task", (id: string) => { setScope("all"); setMainView("tasks"); selectTask(id); }),
      window.api.on("notify:select-event", (id: string) => { setMainView("calendar"); selectEvent(id); })
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      const typing = tag === "input" || tag === "textarea" || tag === "select";
      if (typing) return; // let the OS handle native text-field undo while editing
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
        e.preventDefault();
        undoLast();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedTaskId) { e.preventDefault(); deleteTask(selectedTaskId); }
      }
      if (e.key === "n" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        createTaskInScope();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const visibleTasks = useMemo(() => {
    let base = tasks;
    if (scope === "today") {
      const now = new Date();
      base = tasks.filter((t) => {
        if (!t.due_date) return false;
        const due = new Date(t.due_date);
        return !t.completed && (due.toDateString() === now.toDateString() || due < now);
      });
      // include parents of matching subtasks for context, and their other subtasks
      const ids = new Set(base.map((t) => t.id));
      const parentIds = new Set(base.map((t) => t.parent_id).filter(Boolean) as string[]);
      base = tasks.filter((t) => ids.has(t.id) || parentIds.has(t.id) || (t.parent_id && ids.has(t.parent_id)));
    } else if (scope !== "all") {
      base = tasks.filter((t) => t.list_id === scope);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const matchIds = new Set(
        tasks.filter((t) => t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q) || t.tags.toLowerCase().includes(q)).map((t) => t.id)
      );
      base = base.filter((t) => matchIds.has(t.id) || (t.parent_id && matchIds.has(t.parent_id)));
    }
    if (hideCompleted) {
      base = base.filter((t) => !t.completed);
    }
    if (!showScheduled) {
      // "Hide until": tasks whose start date hasn't arrived stay out of sight
      // (Tasks.org behavior). Toggle "Show scheduled" to reveal them.
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      base = base.filter((t) => {
        if (!t.start_date || t.completed) return true;
        const started = t.start_date.length <= 10 ? t.start_date <= today : new Date(t.start_date) <= now;
        if (started) return true;
        // Not started yet -- but due wins over hide-until. A task that is due
        // today or overdue must never be invisible just because someone set a
        // later start date; that silently buries work that is already late.
        if (!t.due_date) return false;
        return t.due_date.length <= 10 ? t.due_date <= today : new Date(t.due_date) <= now;
      });
    }
    if (categoryFilter !== "all" && scope !== "today") {
      base = base.filter((t) => {
        const cats = (t.tags || "").split(",").map((c) => c.trim()).filter(Boolean);
        return cats.includes(categoryFilter);
      });
    }
    if (dueFilter !== "all" && scope !== "today") {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const endOfDay = new Date(startOfToday); endOfDay.setDate(endOfDay.getDate() + 1);
      const endOfWeek = new Date(startOfToday); endOfWeek.setDate(endOfWeek.getDate() + (7 - startOfToday.getDay()));
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      base = base.filter((t) => {
        if (!t.due_date) return false;
        const due = new Date(t.due_date);
        if (dueFilter === "today") return due < endOfDay;
        if (dueFilter === "week") return due < endOfWeek;
        if (dueFilter === "month") return due < endOfMonth;
        return true;
      });
    }
    const prioRank: Record<number, number> = { 1: 0, 5: 1, 9: 2, 0: 3 };
    const byPriority = (a: Task, b: Task) => (prioRank[a.priority] ?? 3) - (prioRank[b.priority] ?? 3);
    const byDue = (a: Task, b: Task) => {
      if (a.due_date === b.due_date) return 0;
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date < b.due_date ? -1 : 1;
    };
    base = [...base].sort((a, b) => {
      if (sortMode === "manual") return a.sort_order - b.sort_order;
      // Completed tasks sink to the bottom in every non-manual mode.
      if (!!a.completed !== !!b.completed) return a.completed ? 1 : -1;
      if (sortMode === "priority") {
        return byPriority(a, b) || byDue(a, b) || a.title.localeCompare(b.title);
      }
      if (sortMode === "due") {
        return byDue(a, b) || byPriority(a, b) || a.title.localeCompare(b.title);
      }
      return a.title.localeCompare(b.title);
    });
    return base;
  }, [tasks, scope, search, hideCompleted, dueFilter, categoryFilter, showScheduled, sortMode]);

  const allCategories = useMemo(() => {
    const seen = new Set<string>();
    for (const t of tasks) {
      (t.tags || "").split(",").map((c) => c.trim()).filter(Boolean).forEach((c) => seen.add(c));
    }
    for (const e of events) {
      (e.tags || "").split(",").map((c) => c.trim()).filter(Boolean).forEach((c) => seen.add(c));
    }
    return [...seen].sort();
  }, [tasks, events]);

  const categoriesInScope = useMemo(() => {
    if (scope === "today") return [];
    if (scope === "all") return allCategories;
    const scopeTasks = tasks.filter((t) => t.list_id === scope);
    const seen = new Set<string>();
    for (const t of scopeTasks) {
      (t.tags || "").split(",").map((c) => c.trim()).filter(Boolean).forEach((c) => seen.add(c));
    }
    return [...seen].sort();
  }, [tasks, scope, allCategories]);

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) || null;
  const subtasksOfSelected = selectedTask ? tasks.filter((t) => t.parent_id === selectedTask.id) : [];

  /** Fallback when no explicit default/context applies: prefer a synced list
   *  (one linked to a CalDAV calendar) over a local-only one, so new items don't
   *  silently land somewhere that never syncs. Last resort is the first list. */
  function firstSyncedListId(): string {
    return lists.find((l) => l.caldav_calendar_url)?.id ?? lists[0]?.id;
  }

  function defaultListId(): string {
    // The list you're currently viewing wins (creating there is intentional).
    if (typeof scope === "string" && scope !== "all" && scope !== "today") return scope;
    // Otherwise the configured default, if it still exists; else synced-first.
    if (defaultTaskList && lists.some((l) => l.id === defaultTaskList)) return defaultTaskList;
    return firstSyncedListId();
  }

  /** Prefers the calendar's isolated-list filter (right-click "Show only…")
   *  when one is set, since that's the calendar the user is currently looking
   *  at; otherwise the configured default calendar, else synced-first. */
  function defaultEventListId(): string {
    if (calendarListFilter !== "all") return calendarListFilter;
    if (defaultEventList && lists.some((l) => l.id === defaultEventList)) return defaultEventList;
    return firstSyncedListId();
  }

  async function createEventOnDate(dateStr: string) {
    const list_id = defaultEventListId();
    if (!list_id) return;
    // A full ISO datetime (from a week/day-view time-slot click) carries a
    // real start time -- default a 1-hour span, editable after in the panel.
    // A plain "YYYY-MM-DD" (month-view day click) stays an all-day event,
    // same as before.
    const hasTime = dateStr.length > 10;
    const e = await window.api.events?.create({
      list_id,
      title: "New event",
      start_date: dateStr,
      all_day: hasTime ? 0 : 1,
      end_date: hasTime ? new Date(new Date(dateStr).getTime() + 60 * 60 * 1000).toISOString() : null
    });
    if (!e) return;
    await loadEvents();
    selectEvent(e.id);
    setFocusTitleId(e.id);
    scheduleDirtySync();
    // Undo a just-created event by removing it outright (it isn't on the server yet).
    lastActionRef.current = async () => { await window.api.events?.delete(e.id, true); };
  }

  async function updateEvent(id: string, patch: Partial<CalendarEvent>) {
    const prev = events.find((e) => e.id === id);
    const before = prev
      ? (Object.fromEntries(Object.keys(patch).map((k) => [k, (prev as any)[k]])) as Partial<CalendarEvent>)
      : null;
    await window.api.events?.update(id, patch);
    await loadEvents();
    scheduleDirtySync();
    if (before) lastActionRef.current = async () => { await window.api.events?.update(id, before); };
  }

  async function deleteEvent(id: string) {
    await window.api.events?.delete(id);
    if (selectedEventId === id) selectEvent(null);
    await loadEvents();
    scheduleDirtySync();
    // Soft delete (deleted=1); undo just clears the flag, same as tasks.
    lastActionRef.current = async () => { await window.api.events?.update(id, { deleted: 0 } as Partial<CalendarEvent>); };
  }

  async function createContact() {
    // Fallback chain: never silently pick a local book when a synced one exists.
    // addressBooks[0] alone resolved to the unsynced "Contacts" book and stranded
    // contacts where nothing could ever push them. Matches the import modal's logic.
    // (An explicit book filter still wins — creating into a local book you picked
    // yourself is intent, not an accident.)
    const book =
      contactFilter.kind === "book"
        ? contactFilter.value
        : (addressBooks.find((b) => b.carddav_addressbook_url)?.id ?? addressBooks[0]?.id);
    if (!book) return;
    const c = await window.api.contacts?.create({ address_book_id: book, fn: "New contact", first_name: "New", last_name: "contact" });
    if (!c) return;
    await loadContacts();
    selectContact(c.id);
    scheduleDirtySync();
  }

  async function createAddressBook(name: string) {
    await window.api.addressbooks?.create(name);
    await loadAddressBooks();
  }

  async function renameAddressBook(id: string, name: string) {
    // The main process pushes the new name to the server (PROPPATCH) when the
    // book is linked, mirroring list rename; here we just persist + reload.
    await window.api.addressbooks?.update(id, { name } as Partial<AddressBook>);
    await loadAddressBooks();
  }

  async function createServerBook(name: string, accountId: string) {
    // Fall back to a local book if this build's bridge has no server-create
    // (e.g. the Thunderbird add-on shim), so the choice never silently no-ops.
    if (!window.api.addressbooks?.createServer) { await createAddressBook(name); return; }
    try {
      await window.api.addressbooks.createServer(accountId, name);
      await loadAddressBooks();
      setSyncMsg(`Created "${name}" on server — syncing…`);
      await syncAccountNow(accountId);
      await loadContacts();
      setSyncMsg(`Created "${name}" on server.`);
      setTimeout(() => setSyncMsg(null), 4000);
    } catch (err: any) {
      setSyncMsg(`Server address book creation failed: ${err?.message || err}`);
      setTimeout(() => setSyncMsg(null), 6000);
    }
  }

  async function disconnectBook(b: AddressBook) {
    if (!window.confirm(`Disconnect "${b.name}" from CardDAV?\n\nIt stops syncing but its contacts stay on this computer. Nothing is deleted on the server.`)) return;
    await window.api.addressbooks?.unlink(b.id);
    await loadAddressBooks();
    await loadContacts();
  }

  async function deleteBook(b: AddressBook) {
    const n = contacts.filter((c) => c.address_book_id === b.id && !c.deleted).length;
    if (!window.confirm(`Delete "${b.name}" and its ${n} local contact(s)?\n\nThis only removes them from this computer — contacts on the server are not deleted.`)) return;
    await window.api.addressbooks?.delete(b.id);
    if (contactFilter.kind === "book" && contactFilter.value === b.id) setContactFilter({ kind: "all" });
    await loadAddressBooks();
    await loadContacts();
  }

  async function setLabelColor(label: string, color: string | null) {
    const next = { ...labelColors };
    if (color) next[label] = color; else delete next[label];
    setLabelColors(next);
    await window.api.settings?.set("contactLabelColors", JSON.stringify(next));
  }

  /** Delete a contact label: strip that CATEGORIES value from every contact
   *  carrying it, then reload + schedule a sync so the removal reaches CardDAV.
   *  Note: a label that a contact inherits only from a CardDAV group card
   *  (group_labels) is not removed here — that would need editing the group
   *  card itself; this handles the category-based labels created in-app. */
  async function deleteLabel(label: string) {
    const affected = contacts.filter(
      (c) => !c.deleted && contactCategories(c).some((x) => x.toLowerCase() === label.toLowerCase())
    );
    if (!window.confirm(
      `Delete the label "${label}"?\n\nIt will be removed from ${affected.length} contact(s). The contacts themselves are not deleted.`
    )) return;
    for (const c of affected) {
      const next = contactCategories(c)
        .filter((x) => x.toLowerCase() !== label.toLowerCase())
        .join(", ");
      await window.api.contacts?.update(c.id, { categories: next });
    }
    if (contactFilter.kind === "label" && contactFilter.value === label) setContactFilter({ kind: "all" });
    if (labelColors[label]) await setLabelColor(label, null);
    await loadContacts();
    scheduleDirtySync();
  }

  async function updateContact(id: string, patch: Partial<Contact>) {
    await window.api.contacts?.update(id, patch);
    await loadContacts();
    scheduleDirtySync();
  }

  async function deleteContact(id: string) {
    await window.api.contacts?.delete(id);
    if (selectedContactId === id) selectContact(null);
    await loadContacts();
    scheduleDirtySync();
  }

  /** Edit just one occurrence ("this") or the occurrence onward ("following")
   *  of a recurring event. "all" edits go through updateEvent directly. */
  async function updateEventScoped(scope: "this" | "following", masterId: string, occurrenceStart: string, patch: Partial<CalendarEvent>) {
    const ev = events.find((e) => e.id === masterId);
    if (!ev) return;
    if (scope === "this") {
      const overrides = parseJsonArr<EventOverride>(ev.overrides)
        .filter((o) => occEpoch(o.recurrence_id) !== occEpoch(occurrenceStart));
      overrides.push({
        recurrence_id: occurrenceStart,
        title: patch.title,
        notes: patch.notes,
        location: patch.location,
        start_date: patch.start_date!,
        end_date: patch.end_date ?? null,
        all_day: patch.all_day ?? ev.all_day
      });
      // Editing an occurrence also un-skips it if it had been deleted before.
      const exdates = parseJsonArr<string>(ev.exdates).filter((x) => occEpoch(x) !== occEpoch(occurrenceStart));
      await updateEvent(masterId, { overrides: JSON.stringify(overrides), exdates: JSON.stringify(exdates) });
      return;
    }
    // "following": cap the existing series before this occurrence, then start a
    // fresh series from here carrying the edited fields.
    await window.api.events?.update(masterId, { recurrence: addUntilToRule(ev.recurrence!, occurrenceStart) });
    await window.api.events?.create({
      list_id: ev.list_id,
      title: patch.title ?? ev.title,
      notes: patch.notes ?? ev.notes,
      location: patch.location ?? ev.location,
      start_date: patch.start_date!,
      end_date: patch.end_date ?? null,
      all_day: patch.all_day ?? ev.all_day,
      recurrence: ev.recurrence,
      tags: patch.tags ?? ev.tags
    });
    await loadEvents();
    scheduleDirtySync();
  }

  /** Delete just one occurrence ("this", via EXDATE) or the occurrence onward
   *  ("following", via a truncating UNTIL) of a recurring event. */
  async function deleteEventScoped(scope: "this" | "following", masterId: string, occurrenceStart: string) {
    const ev = events.find((e) => e.id === masterId);
    if (!ev) return;
    if (scope === "this") {
      const exdates = parseJsonArr<string>(ev.exdates);
      if (!exdates.some((x) => occEpoch(x) === occEpoch(occurrenceStart))) exdates.push(occurrenceStart);
      const overrides = parseJsonArr<EventOverride>(ev.overrides)
        .filter((o) => occEpoch(o.recurrence_id) !== occEpoch(occurrenceStart));
      await updateEvent(masterId, { exdates: JSON.stringify(exdates), overrides: JSON.stringify(overrides) });
      return;
    }
    await updateEvent(masterId, { recurrence: addUntilToRule(ev.recurrence!, occurrenceStart) });
  }

  /** "New Task" on a calendar day's right-click menu -- creates a task due
   *  that day, using the same list-picking rule as the calendar's own
   *  new-event creation. A full ISO datetime (week/day-view time-slot click)
   *  carries a real time, so it's used as the start with the due date
   *  defaulted a 1-hour span later, same as events -- a plain "YYYY-MM-DD"
   *  (month-view day click) stays a due-date-only task, same as before. */
  async function createTaskOnDate(dateStr: string) {
    // Tasks created from the calendar honor the default TASK list (not the
    // default event calendar). An active calendar isolation filter still wins,
    // since that's the collection the user is looking at.
    const list_id = calendarListFilter !== "all"
      ? calendarListFilter
      : ((defaultTaskList && lists.some((l) => l.id === defaultTaskList)) ? defaultTaskList : firstSyncedListId());
    if (!list_id) return;
    const hasTime = dateStr.length > 10;
    const t = await window.api.tasks.create({
      list_id,
      title: "New task",
      due_date: hasTime ? new Date(new Date(dateStr).getTime() + 60 * 60 * 1000).toISOString() : dateStr,
      start_date: hasTime ? dateStr : null
    });
    await loadTasks();
    selectTask(t.id);
    setFocusTitleId(t.id);
    scheduleDirtySync();
    lastActionRef.current = async () => { await window.api.tasks.delete(t.id, true); };
  }

  /** Drop `draggedId` in front of `targetId` among its visible siblings and
   *  renumber that sibling group. Only touches sort_order, which the DB layer
   *  treats as sync-irrelevant (no dirty flag, nothing re-pushed to CalDAV). */
  async function reorderTask(draggedId: string, targetId: string) {
    const dragged = tasks.find((t) => t.id === draggedId);
    const target = tasks.find((t) => t.id === targetId);
    if (!dragged || !target || dragged.id === target.id) return;
    if ((dragged.parent_id ?? null) !== (target.parent_id ?? null)) return; // siblings only
    const siblings = visibleTasks.filter((t) => (t.parent_id ?? null) === (dragged.parent_id ?? null));
    const beforeOrders = siblings.map((t) => ({ id: t.id, sort_order: t.sort_order }));
    const ids = siblings.map((t) => t.id).filter((id) => id !== draggedId);
    ids.splice(ids.indexOf(targetId), 0, draggedId);
    await Promise.all(
      ids.map((id, i) => {
        const t = siblings.find((x) => x.id === id)!;
        return t.sort_order === i ? Promise.resolve() : window.api.tasks.update(id, { sort_order: i } as Partial<Task>);
      })
    );
    await loadTasks();
    lastActionRef.current = async () => {
      for (const s of beforeOrders) await window.api.tasks.update(s.id, { sort_order: s.sort_order } as Partial<Task>);
    };
  }

  /** Pushes the due date forward. Timed tasks keep their clock time. */
  async function snoozeTask(id: string, until: "tomorrow" | "3days" | "nextweek") {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (until === "tomorrow") base.setDate(base.getDate() + 1);
    else if (until === "3days") base.setDate(base.getDate() + 3);
    else base.setDate(base.getDate() + ((8 - base.getDay()) % 7 || 7)); // next Monday
    let due: string;
    if (t.due_date && t.due_date.length > 10) {
      const old = new Date(t.due_date);
      base.setHours(old.getHours(), old.getMinutes(), 0, 0);
      due = base.toISOString();
    } else {
      const pad = (n: number) => String(n).padStart(2, "0");
      due = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
    }
    const beforeDue = { due_date: t.due_date } as Partial<Task>;
    await window.api.tasks.update(id, { due_date: due } as Partial<Task>);
    await loadTasks();
    scheduleDirtySync();
    lastActionRef.current = async () => { await window.api.tasks.update(id, beforeDue); };
  }

  async function createTaskInScope() {
    const list_id = defaultListId();
    if (!list_id) return;
    const t = await window.api.tasks.create({ list_id, title: "New task" });
    await loadTasks();
    selectTask(t.id);
    setFocusTitleId(t.id);
    scheduleDirtySync();
    lastActionRef.current = async () => { await window.api.tasks.delete(t.id, true); };
  }

  async function updateTask(id: string, patch: Partial<Task>) {
    const prev = tasks.find((t) => t.id === id);
    const before = prev
      ? (Object.fromEntries(Object.keys(patch).map((k) => [k, (prev as any)[k]])) as Partial<Task>)
      : null;
    await window.api.tasks.update(id, patch);
    await loadTasks();
    scheduleDirtySync();
    if (before) lastActionRef.current = async () => { await window.api.tasks.update(id, before); };
  }

  async function toggleComplete(id: string) {
    const prev = tasks.find((t) => t.id === id);
    // Capture every field toggleComplete might change (a recurring task
    // reschedules instead of completing, moving due/start dates).
    const before = prev
      ? ({ completed: prev.completed, completed_at: prev.completed_at, due_date: prev.due_date, start_date: prev.start_date } as Partial<Task>)
      : null;
    await window.api.tasks.toggleComplete(id);
    await loadTasks();
    scheduleDirtySync();
    if (before) lastActionRef.current = async () => { await window.api.tasks.update(id, before); };
  }

  async function deleteTask(id: string) {
    // Delete cascades to direct subtasks (DB: id OR parent_id = id). Capture
    // the affected (currently-visible) ids so undo can un-delete them all.
    const affectedIds = tasks.filter((t) => t.id === id || t.parent_id === id).map((t) => t.id);
    await window.api.tasks.delete(id);
    if (selectedTaskId === id) selectTask(null);
    await loadTasks();
    scheduleDirtySync();
    lastActionRef.current = async () => {
      for (const tid of affectedIds) await window.api.tasks.update(tid, { deleted: 0 } as Partial<Task>);
    };
  }

  async function addSubtask(parentId: string, title: string) {
    const parent = tasks.find((t) => t.id === parentId);
    if (!parent) return;
    const t = await window.api.tasks.create({ list_id: parent.list_id, parent_id: parentId, title });
    await loadTasks();
    scheduleDirtySync();
    lastActionRef.current = async () => { await window.api.tasks.delete(t.id, true); };
  }

  async function createList(name: string) {
    await window.api.lists.create(name);
    await loadLists();
  }

  async function createServerList(name: string, accountId: string) {
    try {
      const newList = await window.api.accounts.createServerCalendar(accountId, name);
      await loadLists();
      setScope(newList.id);
      setSyncMsg(`Created "${name}" on server — syncing…`);
      await syncAccountNow(accountId);
      setSyncMsg(`Created "${name}" on server.`);
      setTimeout(() => setSyncMsg(null), 4000);
    } catch (err: any) {
      setSyncMsg(`Server list creation failed: ${err?.message || err}`);
      setTimeout(() => setSyncMsg(null), 6000);
    }
  }

  // "Delete": remove the list and its tasks from Daynizer, AND from the server
  // when the list is linked (collection DELETE on the calendar URL). If the
  // server refuses (DAViCal / Synology return 405 on collection DELETE), delete
  // locally anyway and warn that the server calendar is still there.
  async function deleteList(id: string) {
    const list = lists.find((l) => l.id === id);
    if (list?.caldav_account_id && list.caldav_calendar_url) {
      try {
        await window.api.accounts.deleteServerCalendar(list.caldav_account_id, list.caldav_calendar_url);
      } catch (err: any) {
        setSyncMsg(`List deleted here, but its calendar couldn't be removed on the server: ${err?.message || err}`);
        setTimeout(() => setSyncMsg(null), 8000);
      }
    }
    await window.api.lists.delete(id);
    if (scope === id) setScope("all");
    await loadLists();
    await loadTasks();
  }

  async function renameList(id: string, name: string) {
    await window.api.lists.update(id, { name } as Partial<TaskList>);
    await loadLists();
  }

  async function exportList(id: string) {
    try {
      const res = await window.api.lists.export(id);
      if (res?.ok) {
        setSyncMsg(`Exported ${res.count} item(s) to ${res.path}`);
        setTimeout(() => setSyncMsg(null), 5000);
      }
    } catch (err: any) {
      setSyncMsg(`Export failed: ${err?.message || err}`);
      setTimeout(() => setSyncMsg(null), 6000);
    }
  }

  // "Unlink": make a linked list local-only. Unlink from CalDAV so no future
  // sync touches the server, but KEEP the list and its tasks here (and on the
  // server) -- syncing simply stops for this list. (Contrast deleteList, which
  // removes both copies.)
  async function removeList(id: string) {
    const list = lists.find((l) => l.id === id);
    if (list?.caldav_account_id) await window.api.accounts.unlinkList(id);
    await loadLists();
    await loadTasks();
  }

  /** @param auto true for timer-driven background syncs: quiet unless something
   *  was pulled/pushed or went wrong. Manual syncs always show a result. */
  async function runSync(auto = false) {
    if (syncInFlight.current) return;
    syncInFlight.current = true;
    setSyncing(true);
    if (!auto) setSyncMsg(null);
    try {
      const accounts = await window.api.accounts.all();
      let pulled = 0, pushed = 0, errors: string[] = [];
      for (const acc of accounts) {
        const res = await window.api.accounts.sync(acc.id);
        for (const r of res) { pulled += r.pulled; pushed += r.pushed; errors.push(...r.errors); }
      }
      await loadTasks();
      await loadLists();
      await loadEvents();
      await loadContacts();
      await loadAddressBooks();
      if (errors.length) setSyncMsg(`Synced with errors: ${errors[0]}`);
      else if (!auto || pulled || pushed) setSyncMsg(`Synced — ${pulled} pulled, ${pushed} pushed.`);
    } catch (err: any) {
      setSyncMsg(err?.message || String(err));
    } finally {
      syncInFlight.current = false;
      setSyncing(false);
      setTimeout(() => setSyncMsg(null), 6000);
    }
  }

  /** Sync a single account immediately (used right after linking a calendar to a list,
   *  so its tasks show up without waiting for the next manual Sync Now). */
  async function syncAccountNow(accountId: string) {
    const res = await window.api.accounts.sync(accountId);
    await loadTasks();
    await loadLists();
    await loadEvents();
    // Contacts + address books must reload too, or a book linked/synced here
    // (e.g. from Settings) won't show its pulled contacts until the next full
    // "Sync now". Mirrors runSync's full reload.
    await loadContacts();
    await loadAddressBooks();
    return res;
  }

  /** Same as syncAccountNow but surfaces a toolbar message — used by the sidebar's
   *  per-list "Sync now" right-click action. */
  async function syncListAccount(accountId: string) {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await syncAccountNow(accountId);
      let pulled = 0, pushed = 0, errors: string[] = [];
      for (const r of res) { pulled += r.pulled; pushed += r.pushed; errors.push(...r.errors); }
      setSyncMsg(errors.length ? `Synced with errors: ${errors[0]}` : `Synced — ${pulled} pulled, ${pushed} pushed.`);
    } catch (err: any) {
      setSyncMsg(err?.message || String(err));
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(null), 6000);
    }
  }

  const scopeTitle =
    scope === "all" ? "All Tasks" : scope === "today" ? "Today & Overdue" : lists.find((l) => l.id === scope)?.name || "Tasks";

  const dueFilterShortLabel: Record<typeof dueFilter, string> = {
    all: "Due: All", today: "Due: Today", week: "Due: Week", month: "Due: Month"
  };
  const dueFilterFullLabel: Record<typeof dueFilter, string> = {
    all: "Due: All", today: "Due: Today", week: "Due: This week", month: "Due: This month"
  };
  const dueFilterLabel = dueFocused ? dueFilterFullLabel : dueFilterShortLabel;

  const sortModeShortLabel: Record<SortMode, string> = {
    priority: "Sort: Pri", due: "Sort: Due", title: "Sort: Title", manual: "Sort: Man"
  };
  const sortModeFullLabel: Record<SortMode, string> = {
    priority: "Sort: Priority", due: "Sort: Due date", title: "Sort: Title", manual: "Sort: Manual"
  };
  const sortModeLabel = sortFocused ? sortModeFullLabel : sortModeShortLabel;

  const categoryFilterLabel = categoryFilter === "all"
    ? (categoryFocused ? "Category: All" : "All")
    : (categoryFocused ? `Category: ${categoryFilter}` : categoryFilter);

  // In the Thunderbird add-on there's no native File/Edit/View/… menu bar (that
  // was Electron-only), so we render an in-app toolbar there. Detected via the
  // WebExtension `browser` global; the Electron desktop keeps its native menu.
  const isAddon = typeof (globalThis as any).browser !== "undefined" && !!(globalThis as any).browser?.runtime?.id;

  // Every label currently in use across all contacts, for the "add existing
  // label" dropdown in the contact editor (own CATEGORIES + group-card labels).
  const existingLabels = useMemo(() => {
    const set = new Set<string>();
    for (const c of contacts) for (const l of contactLabels(c)) set.add(l);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [contacts]);

  return (
    <div className={`app ${railCollapsed ? "rail-collapsed" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      {mainView === "contacts" ? (
        <ContactsSidebar
          addressBooks={addressBooks}
          contacts={contacts}
          accounts={accounts.map((a) => ({ id: a.id, label: a.label }))}
          filter={contactFilter}
          onSelect={setContactFilter}
          onCreateBook={createAddressBook}
          onCreateServerBook={createServerBook}
          onRenameBook={renameAddressBook}
          labelColors={labelColors}
          onSetLabelColor={setLabelColor}
          onDeleteLabel={deleteLabel}
          onDisconnectBook={disconnectBook}
          onDeleteBook={deleteBook}
          onSync={() => runSync()}
          syncing={syncing}
          onOpenSettings={() => setShowSettings(true)}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
      ) : (
      <Sidebar
        lists={lists}
        tasks={tasks}
        accounts={accounts.map((a) => ({ id: a.id, label: a.label }))}
        selectedListId={scope}
        onSelect={setScope}
        onCreateList={createList}
        onCreateServerList={createServerList}
        onDeleteList={deleteList}
        onRemoveList={removeList}
        onRenameList={renameList}
        onExportList={exportList}
        onSyncList={syncListAccount}
        onOpenSettings={() => setShowSettings(true)}
        onSync={() => runSync()}
        syncing={syncing}
        syncMsg={syncMsg}
        forceAdding={forceAddingList}
        onForceAddingHandled={() => setForceAddingList(false)}
        smartFilters={smartFilters}
        onApplyFilter={applySmartFilter}
        onDeleteFilter={(id) => setSmartFilters((prev) => prev.filter((f) => f.id !== id))}
        calendarListFilter={calendarListFilter}
        onSetCalendarListFilter={setCalendarListFilter}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      )}

      <div className="main">
        {isAddon && (
          <AddonMenuBar
            onNewTask={() => createTaskInScope()}
            onNewList={() => setForceAddingList(true)}
            onUndo={() => undoRef.current()}
            onSettings={() => setShowSettings(true)}
            onSearch={() => searchInputRef.current?.focus()}
            onAbout={() => setShowAbout(true)}
            onSync={() => runSync()}
            onSetView={setMainView}
            syncing={syncing}
          />
        )}
        <div className="view-tabs">
          <button className={mainView === "tasks" ? "active" : ""} onClick={() => setMainView("tasks")}>Tasks</button>
          <button className={mainView === "calendar" ? "active" : ""} onClick={() => setMainView("calendar")}>Calendar</button>
          <button className={mainView === "contacts" ? "active" : ""} onClick={() => setMainView("contacts")}>Contacts</button>
        </div>
        {mainView === "calendar" ? (
          <CalendarView
            events={events}
            tasks={tasks}
            lists={lists}
            calendarShow={calendarShow}
            onSetCalendarShow={setCalendarShow}
            selectedTaskId={selectedTaskId}
            selectedEventId={selectedEventId}
            onSelectTask={selectTask}
            onSelectEvent={selectEvent}
            onCreateEvent={createEventOnDate}
            onCreateTask={createTaskOnDate}
            listFilter={calendarListFilter}
            onSetListFilter={setCalendarListFilter}
            onUpdateEvent={updateEvent}
            onUpdateTask={updateTask}
          />
        ) : mainView === "contacts" ? (
          contactsMode === "duplicates" ? (
            <MergeDuplicatesView
              clusters={duplicateClusters}
              onMerge={mergeContacts}
              onDismiss={dismissDupPairs}
              onBack={() => setContactsMode("list")}
            />
          ) : (
          <ContactsView
            contacts={contacts}
            filter={contactFilter}
            labelColors={labelColors}
            selectedContactId={selectedContactId}
            onSelect={selectContact}
            onCreate={createContact}
            onImport={() => setShowImport(true)}
            onFindDuplicates={() => setContactsMode("duplicates")}
            duplicateCount={duplicateClusters.length}
          />
          )
        ) : (
        <>
        <div className="toolbar">
          <h2>{scopeTitle}</h2>
          <input
            ref={searchInputRef}
            className="search-box"
            placeholder="Search tasks (Ctrl+F)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="primary" onClick={createTaskInScope}>+ New task (Ctrl+N)</button>
        </div>
        <div className="toolbar-filters">
          {scope !== "today" && (<>
            <select
              className="due-filter-select"
              value={dueFilter}
              style={{ width: selectWidth(dueFilterLabel[dueFilter]) }}
              onFocus={() => setDueFocused(true)}
              onBlur={() => setDueFocused(false)}
              onChange={(e) => setDueFilter(e.target.value as typeof dueFilter)}
            >
              <option value="all">{dueFilterLabel.all}</option>
              <option value="today">{dueFilterLabel.today}</option>
              <option value="week">{dueFilterLabel.week}</option>
              <option value="month">{dueFilterLabel.month}</option>
            </select>
            {categoriesInScope.length > 0 && (
              <select
                className="due-filter-select"
                value={categoryFilter}
                style={{ width: selectWidth(categoryFilterLabel) }}
                onFocus={() => setCategoryFocused(true)}
                onBlur={() => setCategoryFocused(false)}
                onChange={(e) => setCategoryFilter(e.target.value)}
              >
                <option value="all">{categoryFocused ? "Category: All" : "All"}</option>
                {categoriesInScope.map((c) => (
                  <option key={c} value={c}>{categoryFocused ? `Category: ${c}` : c}</option>
                ))}
              </select>
            )}
          </>)}
          <select
            className="due-filter-select"
            value={sortMode}
            style={{ width: selectWidth(sortModeLabel[sortMode]) }}
            title={sortMode === "manual" ? "Drag tasks to reorder them" : "Switch to Manual to drag-reorder tasks"}
            onFocus={() => setSortFocused(true)}
            onBlur={() => setSortFocused(false)}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
          >
            <option value="priority">{sortModeLabel.priority}</option>
            <option value="due">{sortModeLabel.due}</option>
            <option value="title">{sortModeLabel.title}</option>
            <option value="manual">{sortModeLabel.manual}</option>
          </select>
          <div className="toolbar-filters-right">
          <label className="hide-completed-toggle">
            <input type="checkbox" checked={hideCompleted} onChange={(e) => setHideCompleted(e.target.checked)} />
            Hide completed
          </label>
          <label className="hide-completed-toggle" title="Show tasks whose start date is still in the future">
            <input type="checkbox" checked={showScheduled} onChange={(e) => setShowScheduled(e.target.checked)} />
            Show scheduled
          </label>
          {savingView ? (
            <input
              className="save-view-input"
              autoFocus
              placeholder="Filter name… (Enter)"
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveCurrentView(viewName);
                if (e.key === "Escape") { setSavingView(false); setViewName(""); }
              }}
            />
          ) : (
            <button className="save-view-btn" title="Save the current scope, search, filters and toggles as a smart filter in the sidebar" onClick={() => setSavingView(true)}>
              ☆ Save view
            </button>
          )}
          </div>
        </div>
        {syncMsg && <div style={{ padding: "4px 16px", fontSize: 12, color: "#9aa0a6" }}>{syncMsg}</div>}
        <TaskTable
          tasks={visibleTasks}
          selectedTaskId={selectedTaskId}
          onSelect={selectTask}
          onToggleComplete={toggleComplete}
          dragEnabled={sortMode === "manual"}
          onReorder={reorderTask}
          onContextMenu={(e, taskId) => {
            e.preventDefault();
            selectTask(taskId);
            setMenu({ x: e.clientX, y: e.clientY, taskId });
          }}
        />
        </>
        )}
      </div>

      <div className="right-rail">
        {mainView === "contacts" ? (
          <ContactsRail
            contacts={contacts}
            onSelectContact={selectContact}
            collapsed={railCollapsed}
            onToggleCollapsed={() => setRailCollapsed(!railCollapsed)}
          />
        ) : (
          <TodayPane
            tasks={tasks}
            events={events}
            lists={lists}
            onSelectTask={selectTask}
            onSelectEvent={selectEvent}
            collapsed={railCollapsed}
            onToggleCollapsed={() => setRailCollapsed(!railCollapsed)}
          />
        )}
        {!railCollapsed && (selectedContactId ? (
          <ContactDetailPanel
            contact={contacts.find((c) => c.id === selectedContactId) || null}
            addressBooks={addressBooks}
            existingLabels={existingLabels}
            onUpdate={updateContact}
            onDelete={deleteContact}
          />
        ) : selectedEventId ? (
          <EventDetailPanel
            event={events.find((e) => e.id === selectedEventId) || null}
            lists={lists}
            allCategories={allCategories}
            occurrenceStart={selectedEventOccurrence}
            onUpdate={updateEvent}
            onDelete={deleteEvent}
            onUpdateScoped={updateEventScoped}
            onDeleteScoped={deleteEventScoped}
            autoFocusTitle={focusTitleId === selectedEventId}
            onTitleFocused={() => setFocusTitleId(null)}
          />
        ) : (
          <DetailPanel
            task={selectedTask}
            lists={lists}
            subtasks={subtasksOfSelected}
            allCategories={allCategories}
            onUpdate={updateTask}
            onDelete={deleteTask}
            onAddSubtask={addSubtask}
            onToggleComplete={toggleComplete}
            onSelectTask={selectTask}
            autoFocusTitle={!!selectedTask && focusTitleId === selectedTask.id}
            onTitleFocused={() => setFocusTitleId(null)}
          />
        ))}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Mark complete / incomplete", onClick: () => toggleComplete(menu.taskId) },
            { label: "Snooze until tomorrow", onClick: () => snoozeTask(menu.taskId, "tomorrow") },
            { label: "Snooze 3 days", onClick: () => snoozeTask(menu.taskId, "3days") },
            { label: "Snooze until next week", onClick: () => snoozeTask(menu.taskId, "nextweek") },
            { label: "Duplicate", onClick: async () => {
                const t = tasks.find((x) => x.id === menu.taskId);
                if (t) { await window.api.tasks.create({ list_id: t.list_id, title: `${t.title} (copy)`, notes: t.notes, due_date: t.due_date, priority: t.priority, tags: t.tags }); await loadTasks(); scheduleDirtySync(); }
              } },
            { label: "Delete", danger: true, onClick: () => deleteTask(menu.taskId) }
          ]}
        />
      )}

      {showSettings && (
        <SettingsModal
          lists={lists}
          addressBooks={addressBooks}
          initialPane={settingsPane}
          onClose={() => { setShowSettings(false); setSettingsPane(undefined); }}
          onListsChanged={() => { loadLists(); loadTasks(); loadAccounts(); loadAddressBooks(); loadContacts(); }}
          onSyncAccount={syncAccountNow}
          onReviewDuplicates={() => { setShowSettings(false); setMainView("contacts"); setContactsMode("duplicates"); }}
          onImportVCard={() => { setShowSettings(false); setMainView("contacts"); setShowImport(true); }}
        />
      )}

      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}

      {showImport && (
        <ImportVCardModal
          addressBooks={addressBooks}
          defaultBookId={contactFilter.kind === "book" ? contactFilter.value : (addressBooks.find((b) => b.carddav_addressbook_url)?.id ?? addressBooks[0]?.id ?? null)}
          onClose={() => setShowImport(false)}
          onImported={() => { loadContacts(); scheduleDirtySync(); }}
        />
      )}
    </div>
  );
}
