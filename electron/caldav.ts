import { createDAVClient } from "tsdav";

type Client = Awaited<ReturnType<typeof createDAVClient>>;
import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  getDb,
  CaldavAccount,
  TaskList,
  Task,
  CalendarEvent,
  listsAll,
  listUpdate,
  listCreate,
  listFindByCalendar,
  davUrlKey,
  tasksByList,
  tasksByListWithUid,
  taskGet,
  taskCreate,
  taskUpdate,
  taskDelete,
  eventsByList,
  eventsByListWithUid,
  eventCreate,
  eventUpdate,
  eventDelete,
  eventsPruneMissing,
  remindersForOwner,
  mergeRemindersFromRemote,
  accountExists
} from "./db.js";
import { taskToVTodo, parseVTodo, newUid, ParsedVTodo, eventToVEvent, parseVEvent, ParsedVEvent, EventOverride } from "./ical.js";

/** Append a timestamped line to sync.log in the app's user-data folder, so sync
 *  behavior can be diagnosed after the fact. Best-effort: never breaks sync. */
export function syncLog(line: string) {
  try {
    const file = path.join(app.getPath("userData"), "sync.log");
    try {
      if (fs.statSync(file).size > 1_000_000) fs.renameSync(file, `${file}.1`);
    } catch { /* file doesn't exist yet */ }
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging must never break sync */ }
}

/** The UID a task uses on the server -- its stored caldav_uid once synced, else
 *  the same deterministic fallback taskToVTodo would generate. Used to fill a
 *  subtask's RELATED-TO with its PARENT's UID. */
function effectiveUid(t: Task): string {
  return t.caldav_uid || `${t.id}@tasks-desktop`;
}
/** The parent's server UID for a subtask, or undefined if it has no parent. */
function parentUidFor(t: Task): string | undefined {
  if (!t.parent_id) return undefined;
  const p = taskGet(t.parent_id);
  return p ? effectiveUid(p) : undefined;
}
/** Map a RELATED-TO parent UID (from a pulled VTODO) back to a local task id.
 *  Matches either the parent's stored caldav_uid or its deterministic local
 *  UID. Searches within the same list (subtasks share their parent's list).
 *  Returns null if the parent isn't present locally yet. */
function localParentId(parentUid: string | null, listId: string): string | null {
  if (!parentUid) return null;
  const candidates = tasksByList(listId);
  const byUid = candidates.find((t) => t.caldav_uid === parentUid);
  if (byUid) return byUid.id;
  const m = parentUid.match(/^(.+)@tasks-desktop$/);
  if (m) {
    const byLocal = candidates.find((t) => t.id === m[1]);
    if (byLocal) return byLocal.id;
  }
  return null;
}

/** True when an error message (or an HTTP status) indicates the resource is
 *  absent on the server: a 404 (Not Found) or 410 (Gone). Used both for the
 *  "collection is dead" pull case and the "already deleted" delete case, where
 *  absence is the desired end state, not a failure. */
function isNotFound(msgOrStatus: string | number | undefined | null): boolean {
  if (msgOrStatus == null) return false;
  if (typeof msgOrStatus === "number") return msgOrStatus === 404 || msgOrStatus === 410;
  return /\b(404|410)\b/.test(msgOrStatus);
}

/** Compare two object URLs by path only (servers report absolute or relative). */
function samePath(a: string, b: string): boolean {
  const p = (u: string) => { try { return new URL(u, "http://x").pathname; } catch { return u; } };
  return p(a) === p(b);
}

/** Date equality that tolerates formatting differences (ms, timezone spelling)
 *  but distinguishes date-only from date+time values. */
function dateEq(a: string | null, b: string | null): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null);
  const aDateOnly = a.length <= 10;
  const bDateOnly = b.length <= 10;
  if (aDateOnly !== bDateOnly) return false;
  return aDateOnly ? a === b : new Date(a).getTime() === new Date(b).getTime();
}

/** True when the remote VTODO carries the same content as the local task. Then
 *  an etag difference is just a version-stamp move — typically our own last
 *  push whose PUT response carried no ETag header — not a real remote edit. */
function sameContent(local: Task, remote: ParsedVTodo): boolean {
  const norm = (s: string | null | undefined) => (s ?? "").trim();
  const tagSet = (s: string | null | undefined) =>
    norm(s).split(",").map((t) => t.trim()).filter(Boolean).sort().join(",");
  return (
    norm(local.title) === norm(remote.title) &&
    norm(local.notes) === norm(remote.notes) &&
    dateEq(local.due_date, remote.due_date) &&
    dateEq(local.start_date, remote.start_date) &&
    (local.priority || 0) === (remote.priority || 0) &&
    (local.completed ? 1 : 0) === remote.completed &&
    norm(local.recurrence) === norm(remote.recurrence) &&
    tagSet(local.tags) === tagSet(remote.tags)
  );
}

/** True when the remote VEVENT carries the same content as the local event.
 *  Same purpose as `sameContent` for tasks -- an etag-only move (typically our
 *  own last push) shouldn't be treated as a real remote edit. */
/** Parse the JSON-text exdates/overrides columns off a local event row. */
function localExdates(e: CalendarEvent): string[] {
  try { return JSON.parse(e.exdates || "[]"); } catch { return []; }
}
function localOverrides(e: CalendarEvent): EventOverride[] {
  try { return JSON.parse(e.overrides || "[]"); } catch { return []; }
}

/** Order-independent equality for a set of occurrence dates. */
function sameExdates(local: string[], remote: string[]): boolean {
  return [...local].sort().join("|") === [...remote].sort().join("|");
}

/** Order-independent equality for override lists, compared field-by-field. */
function sameOverrides(local: EventOverride[], remote: EventOverride[]): boolean {
  const norm = (o: EventOverride) =>
    JSON.stringify({
      recurrence_id: o.recurrence_id,
      title: o.title ?? "",
      notes: o.notes ?? "",
      location: o.location ?? "",
      start_date: o.start_date,
      end_date: o.end_date ?? null,
      all_day: o.all_day
    });
  return local.map(norm).sort().join("§") === remote.map(norm).sort().join("§");
}

function sameEventContent(local: CalendarEvent, remote: ParsedVEvent): boolean {
  const norm = (s: string | null | undefined) => (s ?? "").trim();
  const tagSet = (s: string | null | undefined) =>
    norm(s).split(",").map((t) => t.trim()).filter(Boolean).sort().join(",");
  return (
    norm(local.title) === norm(remote.title) &&
    norm(local.notes) === norm(remote.notes) &&
    norm(local.location) === norm(remote.location) &&
    dateEq(local.start_date, remote.start_date) &&
    dateEq(local.end_date, remote.end_date) &&
    (local.all_day ? 1 : 0) === remote.all_day &&
    norm(local.recurrence) === norm(remote.recurrence) &&
    tagSet(local.tags) === tagSet(remote.tags) &&
    sameExdates(localExdates(local), remote.exdates) &&
    sameOverrides(localOverrides(local), remote.overrides)
  );
}

export function encryptPassword(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString("base64");
  }
  return Buffer.from(plain, "utf-8").toString("base64");
}

export function decryptPassword(enc: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(enc, "base64"));
    }
  } catch {
    // fall through to base64 decode for unencrypted/legacy values
  }
  return Buffer.from(enc, "base64").toString("utf-8");
}

async function clientFor(account: CaldavAccount): Promise<Client> {
  const client = await createDAVClient({
    serverUrl: account.server_url,
    credentials: {
      username: account.username,
      password: decryptPassword(account.password_enc)
    },
    authMethod: "Basic",
    defaultAccountType: "caldav"
  });
  return client;
}

/** Yield the main-process event loop so queued IPC (create/edit/load a task,
 *  save keystrokes) is serviced between chunks of a sync. node:sqlite is
 *  synchronous, so without this a large pull monopolizes the single thread and
 *  the UI is unresponsive until it finishes. Scheduling breather only -- it
 *  changes nothing about what syncs. */
function yieldTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface DiscoveredCalendar {
  url: string;
  displayName: string;
  ctag: string | null;
  supportsTodo: boolean;
  color: string | null;
}

export async function testConnection(account: CaldavAccount): Promise<{ ok: boolean; message: string }> {
  try {
    const client = await clientFor(account);
    const calendars = await client.fetchCalendars();
    return { ok: true, message: `Connected. Found ${calendars.length} calendar(s).` };
  } catch (err: any) {
    return { ok: false, message: err?.message || String(err) };
  }
}

/** Coerce a CalDAV calendar-color property to a plain string (or null).
 *  tsdav returns whatever its XML parser produced for <calendar-color>. Most
 *  servers give a bare string ("#RRGGBBAA"), but some (e.g. Nextcloud's
 *  user-created task lists) return an object like { _cdata: "#0082C9FF" }.
 *  Passing a non-primitive straight into SQLite throws "Provided value cannot
 *  be bound to SQLite parameter 3" (the `color` column of the list INSERT),
 *  which previously made those lists impossible to connect. */
function normalizeCalendarColor(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "string") return raw.trim() || null;
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const v = o._cdata ?? o._text ?? o["#text"] ?? o._;
    if (typeof v === "string") return v.trim() || null;
  }
  return null;
}

export async function discoverCalendars(account: CaldavAccount): Promise<DiscoveredCalendar[]> {
  const client = await clientFor(account);
  const calendars = await client.fetchCalendars();
  // Previously filtered to VTODO-capable calendars only, since linking was
  // task-only. Now that the calendar view pulls VEVENTs too, event-only
  // calendars (the common case for Google/Outlook-style setups where Tasks
  // and Calendar are separate collections) need to be linkable as well.
  return calendars
    .map((cal) => ({
      url: String(cal.url),
      displayName: String(cal.displayName || cal.url),
      ctag: (cal as any).ctag ?? null,
      supportsTodo: !((cal as any).components as string[] | undefined)
        || ((cal as any).components as string[]).includes("VTODO"),
      color: normalizeCalendarColor(cal.calendarColor ?? (cal as any).color)
    }));
}

/** Link a local list to a discovered remote calendar. Any other list previously
 *  linked to this same calendar is unlinked first, so a calendar only ever
 *  points at one list at a time. */
export function linkListToCalendar(listId: string, accountId: string, calendarUrl: string) {
  // Same guard as linkAddressBook: a stale account id from the renderer would
  // persist a link that every sync gate silently skips.
  if (!accountExists(accountId)) {
    throw new Error(`Cannot link calendar: account ${accountId} no longer exists. Reopen Settings and try again.`);
  }
  // Match by normalized key so a calendar already linked under http:// isn't
  // treated as different from the same calendar under https:// -- otherwise
  // relinking after a scheme change leaves a stale orphan behind.
  const key = davUrlKey(calendarUrl);
  const previouslyLinked = listsAll().filter(
    (l) => l.caldav_account_id === accountId && davUrlKey(l.caldav_calendar_url) === key && l.id !== listId
  );
  for (const l of previouslyLinked) {
    listUpdate(l.id, { caldav_account_id: null, caldav_calendar_url: null, caldav_ctag: null } as Partial<TaskList>);
  }
  listUpdate(listId, {
    caldav_account_id: accountId,
    caldav_calendar_url: calendarUrl,
    caldav_ctag: null
  } as Partial<TaskList>);
}

/** Idempotent "connect this remote calendar" used by the Settings UI. If a
 *  local list is already linked to this calendar (matched by normalized URL,
 *  so http<->https reconnects are recognized), it is reused -- its stored URL
 *  refreshed to the current one -- instead of creating a duplicate. Only when
 *  no such list exists is a new one created. This is the single choke point
 *  that prevents the duplicate-local-list bug at its source. */
export function connectCalendar(
  accountId: string,
  calendarUrl: string,
  displayName: string,
  color?: string | null
): TaskList {
  const existing = listFindByCalendar(accountId, calendarUrl);
  if (existing) {
    // Refresh the raw URL to the current scheme/host so future exact-match
    // paths line up, but keep the user's name and existing tasks.
    return listUpdate(existing.id, { caldav_calendar_url: calendarUrl } as Partial<TaskList>);
  }
  const list = listCreate(displayName, color ?? undefined);
  linkListToCalendar(list.id, accountId, calendarUrl);
  return listsAll().find((l) => l.id === list.id)!;
}

/** XML-escape a text value for a DAV request body. */
function xmlEscape(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Push a renamed list's title to the server as the calendar collection's
 *  DAV:displayname via PROPPATCH, so a rename in the app propagates to
 *  Nextcloud / Synology / Tasks.org instead of staying local. Best-effort: any
 *  failure (offline, or a server that rejects the property) is logged and
 *  thrown to the caller, which swallows it so the local rename still stands. */
export async function pushCalendarName(account: CaldavAccount, calendarUrl: string, name: string): Promise<void> {
  const client = await clientFor(account);
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop>` +
    `<d:displayname>${xmlEscape(name)}</d:displayname>` +
    `</d:prop></d:set></d:propertyupdate>`;
  const res = await client.davRequest({
    url: calendarUrl,
    init: {
      method: "PROPPATCH",
      headers: { "content-type": "application/xml; charset=utf-8" },
      body
    },
    convertIncoming: false,
    parseOutgoing: false
  });
  const ok = !Array.isArray(res) || res.every((r) => r.ok !== false && (r.status ? r.status < 400 : true));
  syncLog(`PROPPATCH displayname ${calendarUrl} -> "${name}": ${ok ? "ok" : JSON.stringify(res)}`);
  if (!ok) throw new Error(`Server rejected displayname change (${JSON.stringify(res)})`);
}

/** Remove the calendar link from a list (sets it back to local-only). */
export function unlinkList(listId: string) {
  listUpdate(listId, {
    caldav_account_id: null,
    caldav_calendar_url: null,
    caldav_ctag: null
  } as Partial<TaskList>);
}

/** Delete a calendar collection on the server (HTTP DELETE on the collection URL).
 *  Removes the calendar and everything in it. NOTE: some servers (DAViCal, and
 *  Synology's CalDAV backend) return 405 Method Not Allowed on a collection
 *  DELETE -- the caller treats a throw here as "the server won't remove it",
 *  deletes the list locally anyway, and warns. Nextcloud/Radicale/Baikal honor
 *  it. Best-effort: throws on any non-2xx so the caller can react. */
export async function deleteServerCalendar(account: CaldavAccount, calendarUrl: string): Promise<void> {
  const client = await clientFor(account);
  const res = await client.davRequest({
    url: calendarUrl,
    init: { method: "DELETE", headers: {}, body: "" },
    convertIncoming: false,
    parseOutgoing: false
  });
  const first = Array.isArray(res) ? res[0] : (res as any);
  const status: number | undefined = first?.status;
  const ok = !Array.isArray(res) || res.every((r) => r.ok !== false && (r.status ? r.status < 400 : true));
  syncLog(`DELETE collection ${calendarUrl}: ${ok ? "ok" : JSON.stringify(res)}`);
  if (!ok) throw new Error(`Server rejected calendar delete${status ? ` (HTTP ${status})` : ""}`);
}

/** Create a new calendar on the server, make a local list, and link them together. */
export async function createServerCalendar(account: CaldavAccount, name: string): Promise<TaskList> {
  const client = await clientFor(account);

  // Determine the calendar-home URL. Prefer the principal's calendar-home-set,
  // resolved via tsdav account discovery -- this works even when the server has
  // ZERO calendars (e.g. a fresh Radicale user), which is exactly the case the old
  // "derive from an existing calendar" approach could not handle: it threw, so the
  // very first list could never be created. Fall back to deriving the home from an
  // existing calendar for any server that doesn't cleanly advertise the home.
  let calHomeUrl = "";
  try {
    const acct = await client.createAccount({
      account: { serverUrl: account.server_url, accountType: "caldav" },
      loadCollections: false,
      loadObjects: false
    });
    if (acct?.homeUrl) calHomeUrl = String(acct.homeUrl).replace(/\/?$/, "/");
  } catch {
    /* discovery failed -- fall back to the existing-calendar derivation below */
  }

  if (!calHomeUrl) {
    const calendars = await client.fetchCalendars();
    if (calendars.length === 0) {
      throw new Error(
        "Could not determine where to create the calendar: the server advertised no calendar-home-set and has no existing calendars to derive it from."
      );
    }
    const existingUrl = String(calendars[0].url).replace(/\/?$/, "/");
    calHomeUrl = existingUrl.replace(/[^/]+\/$/, "");
  }

  // Build a URL-safe slug from the name.
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "list";
  const newCalUrl = `${calHomeUrl}${slug}-${Date.now()}/`;

  // Declare the component set explicitly. A calendar created with only a
  // displayname gets an EMPTY <supported-calendar-component-set> on SabreDAV
  // (Synology's backend): Synology Calendar then hides it and Tasks.org refuses
  // to subscribe, even though DAVx5 still lists it. A list here holds both tasks
  // and events, so advertise VEVENT + VTODO. (tsdav serializes props via xml-js,
  // so the nested c:comp elements below become <c:comp name="…"/>.)
  await client.makeCalendar({
    url: newCalUrl,
    props: {
      displayname: name,
      "c:supported-calendar-component-set": {
        "c:comp": [
          { _attributes: { name: "VEVENT" } },
          { _attributes: { name: "VTODO" } }
        ]
      }
    } as any
  });

  const newList = listCreate(name);
  linkListToCalendar(newList.id, account.id, newCalUrl);
  return newList;
}

export interface SyncResult {
  listId: string;
  pulled: number;
  pushed: number;
  errors: string[];
}

/** Two-way sync for every list linked to this account. */
export async function syncAccount(account: CaldavAccount): Promise<SyncResult[]> {
  const client = await clientFor(account);

  // Best-effort: pull calendar colors from server and apply them to linked lists.
  try {
    const calendars = await client.fetchCalendars();
    const calByUrl = new Map(calendars.map((c) => [String(c.url), c]));
    for (const list of listsAll().filter((l) => l.caldav_account_id === account.id && l.caldav_calendar_url)) {
      const cal = calByUrl.get(list.caldav_calendar_url!);
      const color = normalizeCalendarColor(cal?.calendarColor);
      if (color) listUpdate(list.id, { color } as Partial<TaskList>);
    }
  } catch { /* non-fatal */ }

  const linkedLists = listsAll().filter((l) => l.caldav_account_id === account.id && l.caldav_calendar_url);
  const results: SyncResult[] = [];
  for (const list of linkedLists) {
    results.push(await syncList(client, list));
    // Two-way sync for this calendar's VEVENTs. Runs after task sync.
    // Recurring events stay read-only (server always wins); non-recurring
    // events get the same etag/dirty/conflict handling as tasks. Failures are
    // logged but never surfaced as sync errors (see syncEvents).
    await syncEvents(client, list);
  }
  return results;
}

/** Two-way sync of VEVENTs for a linked list's calendar. Recurring events
 *  (have an RRULE) are still read-only — the server's version always wins, no
 *  local edits are possible for them yet (see docs/roadmap.md "Recurring
 *  event editing"). Non-recurring events get full create/edit/delete with the
 *  same etag/dirty/conflict-copy handling `syncList` uses for tasks. */
async function syncEvents(client: Client, list: TaskList) {
  const calendarUrl = list.caldav_calendar_url!;
  try {
    const objects = await Promise.race([
      client.fetchCalendarObjects({
        calendar: { url: calendarUrl } as any,
        filters: [
          {
            "comp-filter": {
              _attributes: { name: "VCALENDAR" },
              "comp-filter": {
                _attributes: { name: "VEVENT" }
              }
            }
          }
        ] as any
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("fetchCalendarObjects (events) timed out after 15s")), 15000)
      )
    ]);
    const remoteByUid = new Map<string, { url: string; etag: string; parsed: ParsedVEvent }>();
    const remoteUids = new Set<string>();
    let evParseIdx = 0;
    for (const obj of objects) {
      if ((evParseIdx++ % 20) === 0) await yieldTick();
      const parsed = parseVEvent(obj.data || "");
      if (!parsed) continue;
      // TEMP diagnostic -- comparing Tasks Desktop's own pushed VALARM
      // against Thunderbird's, to see why Android isn't firing ours. Remove
      // once resolved.
      if ((obj.data || "").includes("VALARM")) {
        syncLog(`VALARM-DEBUG event "${parsed.title}":\n${obj.data}`);
      }
      remoteUids.add(parsed.uid);
      remoteByUid.set(parsed.uid, { url: obj.url, etag: obj.etag || "", parsed });
    }

    // Includes soft-deleted rows (unlike eventsByList) -- a local delete that
    // hasn't been pushed yet must not be mistaken for "never seen this event"
    // and resurrected by the pull loop below.
    const localByUid = eventsByListWithUid(list.id);

    let pulled = 0;
    let pushed = 0;

    // Pull.
    let evPullIdx = 0;
    for (const [uid, remote] of remoteByUid) {
      if ((evPullIdx++ % 20) === 0) await yieldTick();
      const parsed = remote.parsed;
      const local = localByUid.get(uid);
      // Recurring events flow through the same etag/dirty/conflict path as
      // non-recurring ones (below), so local per-occurrence edits (exdates /
      // overrides) survive a pull instead of being clobbered by the server copy.
      if (local?.deleted) {
        // Already deleted locally, just not pushed yet -- don't resurrect it
        // here. The push-delete phase below removes it from the server this
        // same round.
        continue;
      }
      if (!local) {
        const created = eventCreate({
          list_id: list.id,
          title: parsed.title,
          notes: parsed.notes,
          location: parsed.location,
          start_date: parsed.start_date,
          end_date: parsed.end_date,
          all_day: parsed.all_day,
          recurrence: parsed.recurrence,
          exdates: JSON.stringify(parsed.exdates),
          overrides: JSON.stringify(parsed.overrides),
          tags: parsed.tags,
          caldav_uid: uid,
          caldav_href: remote.url,
          caldav_etag: remote.etag,
          dirty: 0
        });
        mergeRemindersFromRemote("event", created.id, parsed.reminderOffsets);
        pulled++;
        continue;
      }
      if (local.caldav_etag !== remote.etag) {
        if (sameEventContent(local, parsed)) {
          syncLog(`event etag-only catchup for "${local.title}" (${uid}): ${local.caldav_etag} -> ${remote.etag}`);
          eventUpdate(local.id, { caldav_href: remote.url, caldav_etag: remote.etag });
          mergeRemindersFromRemote("event", local.id, parsed.reminderOffsets);
          continue;
        }
        if (local.dirty) {
          syncLog(`CONFLICT on event "${local.title}" (${uid}): remote wins, local edits saved as "(conflicted copy)"`);
          const localOffsets = remindersForOwner("event", local.id).map((r) => r.offset_minutes);
          const conflictCopy = eventCreate({
            list_id: list.id,
            title: `${local.title} (conflicted copy)`,
            notes: local.notes,
            location: local.location,
            start_date: local.start_date,
            end_date: local.end_date,
            all_day: local.all_day,
            recurrence: local.recurrence,
            exdates: local.exdates,
            overrides: local.overrides,
            tags: local.tags,
            dirty: 1
          });
          // The copy exists to preserve local edits that hadn't synced yet --
          // that includes any reminders configured locally, not just the
          // core fields above.
          mergeRemindersFromRemote("event", conflictCopy.id, localOffsets);
        } else {
          syncLog(`pull overwrite of clean event "${local.title}" (${uid}): ${local.caldav_etag} -> ${remote.etag}`);
        }
        eventUpdate(local.id, {
          title: parsed.title,
          notes: parsed.notes,
          location: parsed.location,
          start_date: parsed.start_date,
          end_date: parsed.end_date,
          all_day: parsed.all_day,
          recurrence: parsed.recurrence,
          exdates: JSON.stringify(parsed.exdates),
          overrides: JSON.stringify(parsed.overrides),
          tags: parsed.tags,
          caldav_href: remote.url,
          caldav_etag: remote.etag
        });
        mergeRemindersFromRemote("event", local.id, parsed.reminderOffsets);
        pulled++;
      }
    }

    // Push: local events that are new or have unpushed edits, recurring or
    // not. A recurring master serializes its RRULE plus any EXDATEs (removed
    // occurrences) and per-occurrence overrides (RECURRENCE-ID VEVENTs) into
    // the single resource.
    const needEtagRefresh: { id: string; href: string; title: string }[] = [];
    const freshLocalEvents = eventsByList(list.id);
    for (const local of freshLocalEvents) {
      if (!local.caldav_uid) {
        const uid = newUid();
        const offsets = remindersForOwner("event", local.id).map((r) => r.offset_minutes);
        const { ics } = eventToVEvent(local, uid, offsets, localExdates(local), localOverrides(local));
        const filename = `${uid}.ics`;
        try {
          const created = await client.createCalendarObject({
            calendar: { url: calendarUrl } as any,
            filename,
            iCalString: ics
          });
          const href = created.url || `${calendarUrl}${filename}`;
          const etag = created.headers?.get?.("etag") || null;
          eventUpdate(local.id, { caldav_uid: uid, caldav_href: href, caldav_etag: etag } as Partial<CalendarEvent>);
          if (!etag) needEtagRefresh.push({ id: local.id, href, title: local.title });
          // remoteUids was captured before this push, so it doesn't include
          // the object we just created -- without this, eventsPruneMissing
          // below would treat it as "deleted on the server" and hard-delete
          // the event we just successfully pushed.
          remoteUids.add(uid);
          syncLog(`pushed new event "${local.title}" (${uid})${etag ? "" : " — no etag in response"}`);
          pushed++;
        } catch (err: any) {
          syncLog(`push create FAILED for event "${local.title}": ${err?.message || err}`);
        }
      } else {
        if (!local.dirty) continue;
        const remote = remoteByUid.get(local.caldav_uid);
        if (!remote) {
          // The object is gone from the server. The old code compared a null
          // remote etag against the stored one, never matched, and skipped --
          // on this sync and every future one, wedging the edit forever (this
          // is what stranded "pork delivery"). eventsPruneMissing won't clear
          // it either, since that deliberately skips dirty rows. Re-create it
          // under the same UID so the local edit survives.
          const offsets = remindersForOwner("event", local.id).map((r) => r.offset_minutes);
          // Serialize exdates + overrides here too, exactly like the new-event
          // and update push paths above/below. This re-create path came from the
          // etag-wedge fix, written before recurring events existed; without
          // these args a wedged recurring event would be re-created as a bare
          // series, silently dropping its per-occurrence deletions/edits.
          const { ics } = eventToVEvent(local, local.caldav_uid, offsets, localExdates(local), localOverrides(local));
          const filename = `${local.caldav_uid}.ics`;
          try {
            const created = await client.createCalendarObject({
              calendar: { url: calendarUrl } as any,
              filename,
              iCalString: ics
            });
            const href = created.url || `${calendarUrl}${filename}`;
            const etag = created.headers?.get?.("etag") || null;
            eventUpdate(local.id, { caldav_href: href, caldav_etag: etag } as Partial<CalendarEvent>);
            if (!etag) needEtagRefresh.push({ id: local.id, href, title: local.title });
            remoteUids.add(local.caldav_uid);
            syncLog(`re-created missing event "${local.title}" (${local.caldav_uid}) to unwedge a dirty edit`);
            pushed++;
          } catch (err: any) {
            syncLog(`re-create FAILED for missing event "${local.title}": ${err?.message || err}`);
          }
          continue;
        }
        if (remote.etag !== local.caldav_etag) {
          // Genuine remote change; the pull phase already reconciled content.
          syncLog(`push skipped for dirty event "${local.title}": etag moved this round (${local.caldav_etag} vs ${remote.etag})`);
          continue;
        }
        const offsets = remindersForOwner("event", local.id).map((r) => r.offset_minutes);
        const { ics } = eventToVEvent(local, undefined, offsets, localExdates(local), localOverrides(local));
        const href = local.caldav_href || remote?.url || "";
        try {
          const updated = await client.updateCalendarObject({
            calendarObject: { url: href, data: ics, etag: local.caldav_etag || "" }
          });
          const etag = updated.headers?.get?.("etag") || null;
          eventUpdate(local.id, { caldav_etag: etag || local.caldav_etag } as Partial<CalendarEvent>);
          if (!etag) needEtagRefresh.push({ id: local.id, href, title: local.title });
          syncLog(`pushed update event "${local.title}" (${local.caldav_uid})${etag ? "" : " — no etag in response"}`);
          pushed++;
        } catch (err: any) {
          syncLog(`push update FAILED for event "${local.title}": ${err?.message || err}`);
        }
      }
    }

    if (needEtagRefresh.length) {
      try {
        const fresh = await client.fetchCalendarObjects({
          calendar: { url: calendarUrl } as any,
          objectUrls: needEtagRefresh.map((o) => o.href)
        });
        for (const o of needEtagRefresh) {
          const obj = fresh.find((f) => samePath(f.url, o.href));
          if (obj?.etag) eventUpdate(o.id, { caldav_etag: obj.etag } as Partial<CalendarEvent>);
          syncLog(`etag refresh for event "${o.title}": ${obj?.etag ?? "NOT FOUND"}`);
        }
      } catch (err: any) {
        syncLog(`event etag refresh failed: ${err?.message || err}`);
      }
    }

    // Local deletions (soft-deleted events that were already synced).
    const db = getDb();
    const deletedWithRemote = db
      .prepare(`SELECT * FROM events WHERE list_id = ? AND deleted = 1 AND caldav_uid IS NOT NULL`)
      .all(list.id) as unknown as CalendarEvent[];
    for (const e of deletedWithRemote) {
      // Same guard as tasks: only hard-delete locally once the server copy is
      // gone (2xx or 404/410). A failed delete keeps the tombstone so the pull
      // can't resurrect the event and it retries next sync.
      let gone = false;
      try {
        const res: any = await client.deleteCalendarObject({
          calendarObject: { url: e.caldav_href || "", etag: e.caldav_etag || "" }
        });
        gone = res?.ok === true || isNotFound(res?.status);
        if (!gone) {
          syncLog(`event delete kept pending for "${e.title}" (${e.caldav_uid}): HTTP ${res?.status ?? "?"}`);
        }
      } catch (err: any) {
        syncLog(`event delete FAILED for "${e.title}": ${err?.message || err}`);
      }
      if (gone) eventDelete(e.id, true);
    }

    eventsPruneMissing(list.id, remoteUids);
    syncLog(`events: synced list "${list.name}" — pulled ${pulled}, pushed ${pushed}`);
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (isNotFound(msg)) {
      // Same dead-collection case as the task pull; already non-fatal here
      // (event errors never surface as sync errors), just log it clearly.
      syncLog(`events: list "${list.name}" calendar is gone on the server (404 at ${calendarUrl}); skipped.`);
    } else {
      syncLog(`events sync FAILED for list "${list.name}": ${msg}`);
    }
  }
}

async function syncList(client: Client, list: TaskList): Promise<SyncResult> {
  const result: SyncResult = { listId: list.id, pulled: 0, pushed: 0, errors: [] };
  const calendarUrl = list.caldav_calendar_url!;
  syncLog(`--- sync start: list "${list.name}" (${calendarUrl})`);

  try {
    const calendar = { url: calendarUrl } as any;
    // tsdav defaults to a VEVENT comp-filter when none is given, which silently
    // excludes VTODO items (our tasks) from the server's response. Request VTODO
    // explicitly so to-dos actually come back.
    console.log(`[caldav] fetchCalendarObjects starting for ${calendarUrl}`);
    let objects: Awaited<ReturnType<typeof client.fetchCalendarObjects>>;
    try {
      objects = await Promise.race([
        client.fetchCalendarObjects({
          calendar,
          filters: [
            {
              "comp-filter": {
                _attributes: { name: "VCALENDAR" },
                "comp-filter": {
                  _attributes: { name: "VTODO" }
                }
              }
            }
          ] as any
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fetchCalendarObjects timed out after 15s")), 15000))
      ]);
    } catch (err: any) {
      // A 404 on the collection query means this list is linked to a calendar
      // that no longer exists on the server (deleted, or moved to a new URL).
      // tsdav throws "Collection query failed: 404 ...". Nothing can pull or
      // push against a dead collection, so stop this list with a clear,
      // actionable message instead of the raw library error -- and DON'T run
      // the delete phase below, so pending deletions stay queued for a
      // re-linked calendar rather than being silently dropped.
      const msg = err?.message || String(err);
      if (isNotFound(msg)) {
        const clear = `List "${list.name}" is linked to a calendar that no longer exists on the server (404 at ${calendarUrl}). Re-link this list to a current calendar in Settings, or remove it.`;
        syncLog(clear);
        result.errors.push(clear);
        return result;
      }
      throw err;
    }
    console.log(`[caldav] fetchCalendarObjects returned ${objects.length} object(s) for ${calendarUrl}`);
    const remoteByUid = new Map<string, { url: string; etag: string; data: string }>();
    let tParseIdx = 0;
    for (const obj of objects) {
      if ((tParseIdx++ % 20) === 0) await yieldTick();
      const parsed = parseVTodo(obj.data || "");
      if (parsed) remoteByUid.set(parsed.uid, { url: obj.url, etag: obj.etag || "", data: obj.data || "" });
      // TEMP diagnostic -- comparing Tasks Desktop's own pushed VALARM
      // against Thunderbird's, to see why Android isn't firing ours. Remove
      // once resolved.
      if (parsed && (obj.data || "").includes("VALARM")) {
        syncLog(`VALARM-DEBUG task "${parsed.title}":\n${obj.data}`);
      }
    }

    // Includes soft-deleted rows -- a local delete not yet pushed must not be
    // mistaken for "never seen this task" and resurrected by the pull loop.
    const localByUid = tasksByListWithUid(list.id);

    // Pull: remote items that are new or changed (by etag) get applied locally.
    let tPullIdx = 0;
    for (const [uid, remote] of remoteByUid) {
      if ((tPullIdx++ % 20) === 0) await yieldTick();
      const parsed = parseVTodo(remote.data)!;
      const local = localByUid.get(uid);
      if (local?.deleted) {
        // Deleted locally, not yet pushed -- don't resurrect it. The push-delete
        // phase below removes it from the server this same round.
        continue;
      }
      if (!local) {
        const created = taskCreate({
          list_id: list.id,
          title: parsed.title,
          notes: parsed.notes,
          due_date: parsed.due_date,
          start_date: parsed.start_date,
          priority: parsed.priority,
          completed: parsed.completed,
          completed_at: parsed.completed_at,
          recurrence: parsed.recurrence,
          tags: parsed.tags,
          // Nest under the RELATED-TO parent when it's already present
          // locally. When the parent hasn't been created yet (map iteration is
          // unordered, and Nextcloud/Tasks.org emit nested VTODOs this way),
          // this resolves to null here and is healed by the reconcile pass that
          // runs right after this loop.
          parent_id: localParentId(parsed.parent_uid, list.id),
          caldav_uid: uid,
          caldav_href: remote.url,
          caldav_etag: remote.etag
        });
        mergeRemindersFromRemote("task", created.id, parsed.reminderOffsets);
        result.pulled++;
      } else if (local.caldav_etag !== remote.etag) {
        if (sameContent(local, parsed)) {
          // Same content, different version stamp — usually our own previous
          // push whose PUT response carried no ETag header. Record the etag;
          // there is nothing to pull and nothing left to push.
          syncLog(`etag-only catchup for "${local.title}" (${uid}): ${local.caldav_etag} -> ${remote.etag}`);
          taskUpdate(local.id, { caldav_href: remote.url, caldav_etag: remote.etag });
          mergeRemindersFromRemote("task", local.id, parsed.reminderOffsets);
          continue;
        }
        if (local.dirty) {
          // Both sides changed since the last sync. The remote version wins on
          // the synced task, but the local edits are preserved as a new,
          // unsynced task (which the push phase below uploads), so neither
          // side's work is silently lost.
          syncLog(`CONFLICT on "${local.title}" (${uid}): remote wins, local edits saved as "(conflicted copy)"`);
          const localOffsets = remindersForOwner("task", local.id).map((r) => r.offset_minutes);
          const conflictCopy = taskCreate({
            list_id: list.id,
            parent_id: local.parent_id,
            title: `${local.title} (conflicted copy)`,
            notes: local.notes,
            due_date: local.due_date,
            start_date: local.start_date,
            priority: local.priority,
            completed: local.completed,
            completed_at: local.completed_at,
            recurrence: local.recurrence,
            tags: local.tags
          });
          // The copy exists to preserve local edits that hadn't synced yet --
          // that includes any reminders configured locally, not just the
          // core fields above.
          mergeRemindersFromRemote("task", conflictCopy.id, localOffsets);
        } else {
          syncLog(`pull overwrite of clean task "${local.title}" (${uid}): ${local.caldav_etag} -> ${remote.etag}`);
        }
        taskUpdate(local.id, {
          title: parsed.title,
          notes: parsed.notes,
          due_date: parsed.due_date,
          start_date: parsed.start_date,
          priority: parsed.priority,
          completed: parsed.completed,
          completed_at: parsed.completed_at,
          recurrence: parsed.recurrence,
          tags: parsed.tags,
          caldav_href: remote.url,
          caldav_etag: remote.etag
        });
        mergeRemindersFromRemote("task", local.id, parsed.reminderOffsets);
        result.pulled++;
      }
    }

    // Reconcile subtask nesting now that EVERY pulled task exists locally.
    // The pull loop above creates tasks in unordered map order, so a child can
    // be inserted before its parent and orphan to the top level; the etag
    // update path also never re-resolves parent_id, so such an orphan would
    // otherwise never re-nest. Re-derive each child's parent from its
    // RELATED-TO here. This is a clean sync write (carries caldav_etag ->
    // dirty stays 0), so it never triggers a re-push. We only SET a resolved
    // parent; we don't clear one when the server reports none, to avoid
    // clobbering local nesting that hasn't been pushed yet.
    {
      const afterPull = tasksByList(list.id);
      const byUidNow = new Map<string, Task>();
      for (const t of afterPull) if (t.caldav_uid) byUidNow.set(t.caldav_uid, t);
      for (const [uid, remote] of remoteByUid) {
        const parsed2 = parseVTodo(remote.data);
        if (!parsed2 || !parsed2.parent_uid) continue;
        const child = byUidNow.get(uid);
        if (!child) continue;
        const resolved = localParentId(parsed2.parent_uid, list.id);
        if (resolved && resolved !== child.id && child.parent_id !== resolved) {
          syncLog(`re-nesting "${child.title}" (${uid}) under parent ${parsed2.parent_uid}`);
          taskUpdate(child.id, { parent_id: resolved, caldav_etag: child.caldav_etag });
        }
      }
    }

    // Push: local items with no UID (new) or modified after last known etag.
    // Servers commonly omit the ETag header on PUT responses; anything pushed
    // without one gets its real etag fetched afterwards (see below) so the
    // next sync doesn't mistake our own upload for a remote change.
    const needEtagRefresh: { id: string; href: string; title: string }[] = [];
    const freshLocalTasks = tasksByList(list.id);
    let tPushIdx = 0;
    for (const local of freshLocalTasks) {
      if ((tPushIdx++ % 20) === 0) await yieldTick();
      if (local.deleted) continue;
      if (!local.caldav_uid) {
        const uid = newUid();
        const offsets = remindersForOwner("task", local.id).map((r) => r.offset_minutes);
        const { ics } = taskToVTodo(local, uid, offsets, parentUidFor(local));
        const filename = `${uid}.ics`;
        try {
          const created = await client.createCalendarObject({
            calendar: { url: calendarUrl } as any,
            filename,
            iCalString: ics
          });
          const href = created.url || `${calendarUrl}${filename}`;
          const etag = created.headers?.get?.("etag") || null;
          taskUpdate(local.id, {
            caldav_uid: uid,
            caldav_href: href,
            caldav_etag: etag
          } as Partial<Task>);
          if (!etag) needEtagRefresh.push({ id: local.id, href, title: local.title });
          syncLog(`pushed new "${local.title}" (${uid})${etag ? "" : " — no etag in response"}`);
          result.pushed++;
        } catch (err: any) {
          syncLog(`push create FAILED for "${local.title}": ${err?.message || err}`);
          result.errors.push(`Create failed for "${local.title}": ${err?.message || err}`);
        }
      } else {
        // Only push tasks the user actually changed since the last sync.
        // Re-uploading unchanged tasks churns server etags, which makes every
        // OTHER device see a phantom "remote change" and clobber its own
        // pending local edits with stale data.
        if (!local.dirty) continue;
        const remote = remoteByUid.get(local.caldav_uid);
        if (!remote) {
          // Gone from the server. See the matching comment in the event push:
          // comparing a null remote etag skipped this row on every future sync,
          // and pruneMissing skips dirty rows, so the edit could never escape.
          const offsets = remindersForOwner("task", local.id).map((r) => r.offset_minutes);
          const { ics } = taskToVTodo(local, local.caldav_uid, offsets, parentUidFor(local));
          const filename = `${local.caldav_uid}.ics`;
          try {
            const created = await client.createCalendarObject({
              calendar: { url: calendarUrl } as any,
              filename,
              iCalString: ics
            });
            const href = created.url || `${calendarUrl}${filename}`;
            const etag = created.headers?.get?.("etag") || null;
            taskUpdate(local.id, { caldav_href: href, caldav_etag: etag } as Partial<Task>);
            if (!etag) needEtagRefresh.push({ id: local.id, href, title: local.title });
            // No remoteUids bookkeeping here: unlike events, the task path has
            // no prune step, so there is no set that would mistake this
            // just-created object for one deleted on the server.
            syncLog(`re-created missing "${local.title}" (${local.caldav_uid}) to unwedge a dirty edit`);
            result.pushed++;
          } catch (err: any) {
            syncLog(`re-create FAILED for missing "${local.title}": ${err?.message || err}`);
            result.errors.push(`Re-create failed for "${local.title}": ${err?.message || err}`);
          }
          continue;
        }
        if (remote.etag !== local.caldav_etag) {
          // Real content conflicts were already handled in the pull phase.
          syncLog(`push skipped for dirty "${local.title}": etag moved this round (${local.caldav_etag} vs ${remote.etag})`);
          continue;
        }
        const offsets = remindersForOwner("task", local.id).map((r) => r.offset_minutes);
        const { ics } = taskToVTodo(local, undefined, offsets, parentUidFor(local));
        const href = local.caldav_href || remote?.url || "";
        try {
          const updated = await client.updateCalendarObject({
            calendarObject: {
              url: href,
              data: ics,
              etag: local.caldav_etag || ""
            }
          });
          const etag = updated.headers?.get?.("etag") || null;
          taskUpdate(local.id, {
            caldav_etag: etag || local.caldav_etag
          } as Partial<Task>);
          if (!etag) needEtagRefresh.push({ id: local.id, href, title: local.title });
          syncLog(`pushed update "${local.title}" (${local.caldav_uid})${etag ? "" : " — no etag in response"}`);
          result.pushed++;
        } catch (err: any) {
          syncLog(`push update FAILED for "${local.title}": ${err?.message || err}`);
          result.errors.push(`Update failed for "${local.title}": ${err?.message || err}`);
        }
      }
    }

    // Fetch real etags for anything the server didn't stamp on PUT.
    if (needEtagRefresh.length) {
      try {
        const fresh = await client.fetchCalendarObjects({
          calendar: { url: calendarUrl } as any,
          objectUrls: needEtagRefresh.map((o) => o.href)
        });
        for (const o of needEtagRefresh) {
          const obj = fresh.find((f) => samePath(f.url, o.href));
          if (obj?.etag) taskUpdate(o.id, { caldav_etag: obj.etag } as Partial<Task>);
          syncLog(`etag refresh for "${o.title}": ${obj?.etag ?? "NOT FOUND"}`);
        }
      } catch (err: any) {
        // Non-fatal: the content comparison in the pull phase makes a stale
        // etag self-healing on the next sync.
        syncLog(`etag refresh failed: ${err?.message || err}`);
      }
    }

    // Handle local deletions (soft-deleted tasks that still have a caldav_uid).
    const db = getDb();
    const deletedWithRemote = db
      .prepare(`SELECT * FROM tasks WHERE list_id = ? AND deleted = 1 AND caldav_uid IS NOT NULL`)
      .all(list.id) as unknown as Task[];
    for (const t of deletedWithRemote) {
      // Only hard-delete locally once the server copy is actually gone.
      // deleteCalendarObject returns a Response (it does NOT throw on an HTTP
      // error status), so a failed delete used to be ignored while the local
      // tombstone was destroyed anyway -- the next pull then re-created the
      // task from the still-present server copy (the "deleted tasks come back"
      // bug). Now: 2xx or 404/410 means gone -> complete the delete locally;
      // anything else (network throw, 5xx, 412) keeps the tombstone so the pull
      // can't resurrect it (it skips deleted rows) and it retries next sync.
      let gone = false;
      try {
        const res: any = await client.deleteCalendarObject({
          calendarObject: { url: t.caldav_href || "", etag: t.caldav_etag || "" }
        });
        gone = res?.ok === true || isNotFound(res?.status);
        if (!gone) {
          const detail = `HTTP ${res?.status ?? "?"}${res?.statusText ? ` ${res.statusText}` : ""}`;
          result.errors.push(`Delete failed for "${t.title}": ${detail} — will retry next sync`);
          syncLog(`task delete kept pending for "${t.title}" (${t.caldav_uid}): ${detail}`);
        }
      } catch (err: any) {
        result.errors.push(`Delete failed for "${t.title}": ${err?.message || err} — will retry next sync`);
        syncLog(`task delete threw for "${t.title}" (${t.caldav_uid}): ${err?.message || err}`);
      }
      if (gone) taskDelete(t.id, true);
    }
  } catch (err: any) {
    syncLog(`sync FAILED for list "${list.name}": ${err?.message || err}`);
    result.errors.push(err?.message || String(err));
  }

  syncLog(`--- sync done: list "${list.name}" — pulled ${result.pulled}, pushed ${result.pushed}, errors ${result.errors.length}`);
  return result;
}
