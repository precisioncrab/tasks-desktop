import React, { useEffect, useState } from "react";
import { CaldavAccountPublic, DiscoveredCalendar, DiscoveredAddressBook, AddressBook, TaskList, ServerStatus, ServerInfo } from "../types";

/** Renderer-side twin of db.ts's davUrlKey: normalize a CalDAV/CardDAV URL so
 *  http<->https, trailing-slash, default-port and host-casing differences don't
 *  make the same remote collection look "not connected" (which is what led the
 *  dropdown to default to "create new list" and spawn duplicates). Kept in sync
 *  with electron/db.ts. */
function davUrlKey(url: string | null | undefined): string {
  if (!url) return "";
  let s = String(url).trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").replace(/:(80|443)(\/|$)/, "$2");
  const slash = s.indexOf("/");
  const host = (slash === -1 ? s : s.slice(0, slash)).toLowerCase();
  return host + (slash === -1 ? "" : s.slice(slash));
}
function sameDavUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  return davUrlKey(a) === davUrlKey(b);
}
/** Tag a disconnected collection so it reads as distinct from the synced one. */
function toLocalName(name: string): string {
  return /\(local\)\s*$/i.test(name) ? name : `${name} (local)`;
}
/** Electron wraps every IPC handler rejection as
 *  "Error invoking remote method 'x:y': TypeError: <real message>". Strip that
 *  scaffolding (and a leading error-class name) so the banner shows only the
 *  human-readable reason we threw. */
function cleanErr(err: any): string {
  let m = String(err?.message ?? err ?? "Unknown error");
  m = m.replace(/^Error invoking remote method '[^']*':\s*/i, "");
  m = m.replace(/^(?:[A-Z]\w*Error):\s*/, "");
  return m.trim() || "Unknown error";
}
/** "just now" / "3 min ago" / "2 h ago" / "4 d ago" for the last-device-sync line. */
function relTime(epochMs: number): string {
  const s = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

type SettingsPane = "accounts" | "calendars" | "contacts" | "sync" | "server" | "notifications";

interface Props {
  lists: TaskList[];
  addressBooks: AddressBook[];
  onClose: () => void;
  onListsChanged: () => void;
  onSyncAccount: (accountId: string) => Promise<{ listId: string; pulled: number; pushed: number; errors: string[] }[]>;
  onReviewDuplicates: () => void;
  onImportVCard: () => void;
  /** Pane to open on mount (e.g. "server" for the first-run server setup cue). */
  initialPane?: SettingsPane;
}

export default function SettingsModal({ lists, addressBooks, onClose, onListsChanged, onSyncAccount, onReviewDuplicates, onImportVCard, initialPane }: Props) {
  const [accounts, setAccounts] = useState<CaldavAccountPublic[]>([]);
  const [label, setLabel] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [draftCarddavUrl, setDraftCarddavUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [calendarsByAccount, setCalendarsByAccount] = useState<Record<string, DiscoveredCalendar[]>>({});
  const [carddavUrlByAccount, setCarddavUrlByAccount] = useState<Record<string, string>>({});
  const [addressBooksByAccount, setAddressBooksByAccount] = useState<Record<string, DiscoveredAddressBook[]>>({});
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // Pending (unsaved) dropdown selections, keyed by calendar URL. Nothing here
  // takes effect until the single "Save changes" button is clicked.
  const [pendingByCal, setPendingByCal] = useState<Record<string, string>>({});
  const [pendingByBook, setPendingByBook] = useState<Record<string, string>>({});
  const [advancedLinking, setAdvancedLinking] = useState(() => localStorage.getItem("advancedListLinking") === "1");
  const [version, setVersion] = useState<string>("");
  const [update, setUpdate] = useState<{ state: string; detail?: any } | null>(null);
  const [prefs, setPrefs] = useState<Record<string, string>>({});
  type Pane = SettingsPane;
  const [activePane, setActivePane] = useState<Pane>(initialPane ?? "accounts");

  // ---- Built-in sync server (desktop only) ----
  const [srv, setSrv] = useState<ServerInfo | null>(null);
  const [srvUser, setSrvUser] = useState("");
  const [srvPass, setSrvPass] = useState("");
  const [srvPort, setSrvPort] = useState("");
  const [showSrvPass, setShowSrvPass] = useState(false);
  const [srvBusy, setSrvBusy] = useState(false);
  const [srvMsg, setSrvMsg] = useState<string | null>(null);

  async function loadServer() {
    if (!window.api.server) return;
    try {
      const info = await window.api.server.info();
      setSrv(info);
      setSrvUser(info.username);
      setSrvPass(info.password);
      setSrvPort(String(info.preferredPort));
    } catch { /* server IPC unavailable */ }
  }
  // Load when the pane opens; keep status fresh from main-process events (tray).
  useEffect(() => { if (activePane === "server") loadServer(); }, [activePane]);
  useEffect(() => {
    if (!window.api.server) return;
    return window.api.on("server:status", (s: ServerStatus) => {
      setSrv((prev) => (prev ? { ...prev, ...s } : prev));
    });
  }, []);

  async function srvToggle(on: boolean) {
    if (!window.api.server) return;
    setSrvBusy(true); setSrvMsg(null);
    try {
      await window.api.server.setEnabled(on);
      await loadServer();
      // Enabling the server auto-turns-on start-at-login the first time; re-read
      // prefs so that checkbox reflects it.
      window.api.settings?.all().then(setPrefs).catch(() => {});
    }
    catch (err: any) { setSrvMsg(cleanErr(err)); }
    finally { setSrvBusy(false); }
  }
  async function srvApplyCreds() {
    if (!window.api.server || !srv) return;
    const usernameChanged = srvUser.trim() !== srv.username;
    if (usernameChanged) {
      const ok = window.confirm(
        "Change the server username?\n\nThe server stores each user's calendars and contacts under their name, " +
        "so any data already on the built-in server stays under the OLD username and the apps you've connected " +
        "will see an empty account until you re-point them. The password can be changed safely on its own.\n\nContinue?"
      );
      if (!ok) return;
    }
    setSrvBusy(true); setSrvMsg(null);
    try {
      await window.api.server.setCredentials({ username: srvUser.trim(), password: srvPass });
      await loadServer();
      setSrvMsg("Saved. Update this username/password in any other apps you've connected.");
    } catch (err: any) { setSrvMsg(cleanErr(err)); }
    finally { setSrvBusy(false); }
  }
  async function srvApplyPort() {
    if (!window.api.server) return;
    setSrvBusy(true); setSrvMsg(null);
    try {
      await window.api.server.setPort(Number(srvPort));
      await loadServer();
      setSrvMsg("Port updated.");
    } catch (err: any) { setSrvMsg(cleanErr(err)); }
    finally { setSrvBusy(false); }
  }
  async function srvRegenerate() {
    if (!window.api.server) return;
    setSrvBusy(true); setSrvMsg(null);
    try {
      const info = await window.api.server.regeneratePassword();
      setSrv(info); setSrvPass(info.password); setShowSrvPass(true);
      setSrvMsg("New password generated. Update it in any connected apps.");
    } catch (err: any) { setSrvMsg(cleanErr(err)); }
    finally { setSrvBusy(false); }
  }
  function srvCopy(text: string, what: string) {
    navigator.clipboard?.writeText(text).then(
      () => setSrvMsg(`${what} copied.`),
      () => setSrvMsg(`Couldn't copy ${what} — select and copy manually.`)
    );
  }
  async function srvOpenFirewall() {
    if (!window.api.server) return;
    setSrvBusy(true); setSrvMsg(null);
    try {
      const r = await window.api.server.openFirewall();
      setSrvMsg(r.message);
      window.api.settings?.all().then(setPrefs).catch(() => {});
    } catch (err: any) { setSrvMsg(cleanErr(err)); }
    finally { setSrvBusy(false); }
  }

  useEffect(() => {
    window.api.app?.version().then(setVersion).catch(() => {});
    window.api.settings?.all().then(setPrefs).catch(() => {});
    return window.api.on("update:status", (state: string, detail?: any) => setUpdate({ state, detail }));
  }, []);

  function setPref(key: string, value: string) {
    setPrefs((prev) => ({ ...prev, [key]: value }));
    window.api.settings?.set(key, value);
  }

  useEffect(() => {
    localStorage.setItem("advancedListLinking", advancedLinking ? "1" : "0");
  }, [advancedLinking]);

  async function refresh() {
    setAccounts(await window.api.accounts.all());
  }
  useEffect(() => { refresh(); }, []);

  // Auto-list calendars and address books for each account when Settings opens
  // (and when the account set changes), so they show up without a manual
  // "Find…" click -- just pick "Connected" and Save changes.
  const accountIds = accounts.map((a) => a.id).join(",");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const acc of accounts) {
        try {
          const cals = await window.api.accounts.discoverCalendars(acc.id);
          if (!cancelled) setCalendarsByAccount((p) => ({ ...p, [acc.id]: cals }));
        } catch { /* server unreachable / not configured -- ignore */ }
        if (acc.carddav_url) {
          try {
            const found = (await window.api.addressbooks?.discover(acc.id)) ?? [];
            if (!cancelled) setAddressBooksByAccount((p) => ({ ...p, [acc.id]: found }));
          } catch { /* ignore */ }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [accountIds]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function addAccount() {
    // A CalDAV URL is no longer required: an account can be CardDAV-only (just a
    // CardDAV URL + credentials). Require at least one of the two URLs.
    if ((!serverUrl && !draftCarddavUrl) || !username || !password) {
      setTestMsg("Enter a CalDAV URL or a CardDAV URL, plus username and password, before saving.");
      return;
    }
    setBusy(true);
    setTestMsg(null);
    // Snapshot the URLs entered, since the fields are cleared before the slow
    // (backgrounded) provisioning step runs.
    const hadCalUrl = !!serverUrl;
    const hadCardUrl = !!draftCarddavUrl;
    let createdId = "";
    try {
      // Request host permission for whichever URL(s) were entered (CalDAV and
      // CardDAV can live on different hosts) in ONE call -- a second
      // permissions.request() after an await loses the click's user gesture.
      if (!(await window.api.accounts.ensureHostPermission([serverUrl, draftCarddavUrl].filter(Boolean)))) {
        setTestMsg("Permission to contact that server was denied.");
        setBusy(false);
        return;
      }
      const created = await window.api.accounts.create({ label: label || serverUrl || draftCarddavUrl, server_url: serverUrl, username, password });
      createdId = created.id;
      if (draftCarddavUrl) await window.api.accounts.update(created.id, { carddav_url: draftCarddavUrl });
      setLabel(""); setServerUrl(""); setUsername(""); setPassword(""); setDraftCarddavUrl("");
      await refresh();
    } catch (err: any) {
      setTestMsg(err?.message || String(err));
      setBusy(false);
      return;
    }
    // The account exists and the form is cleared, so release the form NOW: the
    // default-collection provisioning and discovery below each hit the network
    // (several round-trips on a fresh server) and previously held the Add
    // Account form disabled until they finished. Run them in the background and
    // update state as results arrive.
    setBusy(false);
    void (async () => {
      // Auto-provision default collections on a server that has none yet (e.g. a
      // fresh self-hosted CalDAV/CardDAV server). A no-op on servers that already
      // have collections (Synology, Nextcloud, ...).
      try {
        const made = await window.api.accounts.bootstrapDefaults?.(createdId);
        const parts = [made?.calendar && "calendar", made?.addressBook && "contacts book"].filter(Boolean);
        if (parts.length) setTestMsg(`Created a default ${parts.join(" and ")} on the server.`);
      } catch (err: any) {
        // Non-fatal -- the account is still added; the user can create lists by hand.
        setTestMsg(`Account added, but default collections could not be created: ${cleanErr(err)}`);
      }
      // Refresh App's account + list/book state so the new account and any
      // bootstrapped collections appear immediately (without this, the sidebar's
      // "+ New list -> On server" dropdown stayed stale until an app restart).
      onListsChanged();
      // Refresh this modal's calendar/book panes for the new account WITHOUT the
      // busy flag, so the Add Account form stays responsive. Re-read the account
      // first: bootstrap may have set carddav_url on a unified server (Radicale).
      if (hadCalUrl) {
        try {
          const cals = await window.api.accounts.discoverCalendars(createdId);
          setCalendarsByAccount((p) => ({ ...p, [createdId]: cals }));
        } catch { /* ignore */ }
      }
      try {
        const acc = (await window.api.accounts.all()).find((a) => a.id === createdId);
        if ((hadCardUrl || acc?.carddav_url) && window.api.addressbooks) {
          const books = (await window.api.addressbooks.discover(createdId)) ?? [];
          setAddressBooksByAccount((p) => ({ ...p, [createdId]: books }));
        }
      } catch { /* ignore */ }
    })();
  }

  async function testDraft() {
    if ((!serverUrl && !draftCarddavUrl) || !username || !password) {
      setTestMsg("Enter a CalDAV URL or a CardDAV URL, plus username and password, before testing.");
      return;
    }
    setBusy(true);
    setTestMsg(null);
    try {
      if (!(await window.api.accounts.ensureHostPermission([serverUrl, draftCarddavUrl].filter(Boolean)))) {
        setTestMsg("Permission to contact that server was denied.");
        return;
      }
      const res = await window.api.accounts.testConnection({ server_url: serverUrl, carddav_url: draftCarddavUrl || undefined, username, password });
      setTestMsg(res.message);
    } catch (err: any) {
      setTestMsg(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function discover(accountId: string) {
    setBusy(true);
    try {
      const account = accounts.find((a) => a.id === accountId);
      if (account && !(await window.api.accounts.ensureHostPermission(account.server_url))) {
        setTestMsg("Permission to contact that server was denied.");
        return;
      }
      const cals = await window.api.accounts.discoverCalendars(accountId);
      setCalendarsByAccount((prev) => ({ ...prev, [accountId]: cals }));
    } catch (err: any) {
      setTestMsg(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function discoverBooks(accountId: string) {
    setBusy(true);
    setTestMsg(null);
    try {
      const url = carddavUrlByAccount[accountId] ?? (accounts.find((a) => a.id === accountId)?.carddav_url || "");
      // Persist the CardDAV URL first -- discovery reads it off the account.
      await window.api.accounts.update(accountId, { carddav_url: url });
      await refresh();
      const books = (await window.api.addressbooks?.discover(accountId)) ?? [];
      setAddressBooksByAccount((prev) => ({ ...prev, [accountId]: books }));
      if (books.length === 0) setTestMsg("No address books found at that CardDAV URL.");
    } catch (err: any) {
      setTestMsg(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function linkBook(accountId: string, book: DiscoveredAddressBook) {
    setBusy(true);
    setTestMsg(null);
    try {
      const b = await window.api.addressbooks?.create(book.displayName);
      if (b) await window.api.addressbooks?.link(b.id, accountId, book.url);
      onListsChanged(); // reloads address books + contacts in App
      const res = await onSyncAccount(accountId);
      const errs = res.flatMap((r) => r.errors);
      setTestMsg(errs.length ? `Linked with errors: ${errs[0]}` : `Linked "${book.displayName}" and synced.`);
    } catch (err: any) {
      setTestMsg(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function test(account: CaldavAccountPublic) {
    setBusy(true);
    try {
      if (!(await window.api.accounts.ensureHostPermission(account.server_url))) {
        setTestMsg("Permission to contact that server was denied.");
        return;
      }
      const res = await window.api.accounts.testConnection(account);
      setTestMsg(res.message);
    } finally {
      setBusy(false);
    }
  }

  /** Commits every pending calendar-link change across all accounts at once:
   *  links, creates+links, or unlinks as needed, then runs one sync per affected
   *  account so newly-linked lists show up right away. Nothing is written until
   *  this is called — closing the modal beforehand discards pending choices. */
  async function saveAllChanges() {
    const entries = Object.entries(pendingByCal);
    const bookEntries = Object.entries(pendingByBook);
    if (entries.length === 0 && bookEntries.length === 0) return;
    setBusy(true);
    setTestMsg(null);
    const accountsToSync = new Set<string>();
    const errors: string[] = [];
    try {
      for (const [calUrl, selected] of entries) {
        let accountId: string | undefined;
        let cal: DiscoveredCalendar | undefined;
        for (const [accId, cals] of Object.entries(calendarsByAccount)) {
          const found = cals.find((c) => c.url === calUrl);
          if (found) { accountId = accId; cal = found; break; }
        }
        if (!accountId || !cal) continue;
        const linkedList = lists.find((l) => sameDavUrl(l.caldav_calendar_url, calUrl));
        try {
          if (selected === "__new__") {
            // Idempotent: reuses an existing list for this calendar (matched by
            // normalized URL) instead of creating a duplicate on reconnect.
            await window.api.accounts.connectCalendar(accountId, calUrl, cal.displayName, cal.color ?? null);
            accountsToSync.add(accountId);
          } else if (selected === "") {
            if (linkedList) {
              // Disconnect: unlink so no future sync touches the server, then
              // KEEP the list and its tasks but rename it "(local)" so it's
              // clearly distinct from the synced copy. The remote calendar is
              // untouched. (Was: delete the list entirely.)
              await window.api.accounts.unlinkList(linkedList.id);
              await window.api.lists.update(linkedList.id, { name: toLocalName(linkedList.name) });
            }
          } else {
            await window.api.accounts.linkList(selected, accountId, calUrl);
            accountsToSync.add(accountId);
          }
        } catch (err: any) {
          errors.push(`${cal.displayName}: ${cleanErr(err)}`);
        }
      }
      for (const [bookUrl, selected] of bookEntries) {
        let accountId: string | undefined;
        let book: DiscoveredAddressBook | undefined;
        for (const [accId, books] of Object.entries(addressBooksByAccount)) {
          const found = books.find((b) => b.url === bookUrl);
          if (found) { accountId = accId; book = found; break; }
        }
        if (!accountId || !book) continue;
        const linkedBook = addressBooks.find((ab) => sameDavUrl(ab.carddav_addressbook_url, bookUrl));
        try {
          if (selected === "__new__") {
            // Idempotent connect -- reuses an existing linked book, never
            // duplicates it (duplicate books are what triplicate contacts).
            await window.api.addressbooks?.connect(accountId, bookUrl, book.displayName);
            accountsToSync.add(accountId);
          } else if (selected === "") {
            if (linkedBook) {
              // Keep the book + contacts, just unlink and mark "(local)".
              await window.api.addressbooks?.unlink(linkedBook.id);
              await window.api.addressbooks?.update(linkedBook.id, { name: toLocalName(linkedBook.name) });
            }
          }
        } catch (err: any) {
          errors.push(`${book.displayName}: ${cleanErr(err)}`);
        }
      }
    } finally {
      // The link/unlink/create calls above are already committed to the database
      // at this point (each has its own try/catch, so one failure doesn't stop
      // the rest). The pending selections have effectively been "saved" no
      // matter what happens next, so clear them now -- otherwise a slow or
      // failing sync below would leave the UI stuck showing "unsaved changes"
      // with no way to clear it, even though the actual link already succeeded.
      onListsChanged();
      setPendingByCal({});
      setPendingByBook({});
    }

    try {
      for (const accId of accountsToSync) {
        const res = await onSyncAccount(accId);
        errors.push(...res.flatMap((r) => r.errors));
      }
    } catch (err: any) {
      errors.push(err?.message || String(err));
    }
    setTestMsg(errors.length ? `Saved with errors: ${errors[0]}` : "Changes saved.");
    setBusy(false);
  }

  /** Repairs duplicate *collections* left over from connect/disconnect cycles:
   *  consolidates lists and address books that point at the same remote, and
   *  removes exact-duplicate contact rows and group-card phantoms. Previews the
   *  changes first and asks for confirmation. Never deletes tasks, and never
   *  deletes contact data on the server (heuristic contact merging lives in the
   *  manual "Merge duplicates" review instead). */
  async function repairDuplicates() {
    if (!window.api.maintenance) { setTestMsg("Repair not available in this build."); return; }
    setBusy(true);
    setTestMsg(null);
    try {
      const preview = await window.api.maintenance.dedupe(true); // dry run — rolls back
      const total = preview.listsMerged + preview.listsRenamedLocal + preview.booksMerged + preview.booksRenamedLocal + preview.contactsRemoved;
      if (total === 0) { setTestMsg("No duplicate lists or address books found."); return; }
      const ok = window.confirm(
        "Repair these duplicates?\n\n• " + preview.details.join("\n• ") +
        "\n\nYour tasks and your contacts on the server are not deleted."
      );
      if (!ok) return;
      const r = await window.api.maintenance.dedupe(false); // apply
      onListsChanged();
      await refresh();
      setTestMsg(r.details.join(" "));
    } catch (err: any) {
      setTestMsg(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeAccount(id: string) {
    await window.api.accounts.delete(id);
    await refresh();
    onListsChanged();
  }

  async function syncNow(accountId: string) {
    setBusy(true);
    setTestMsg(null);
    try {
      const account = accounts.find((a) => a.id === accountId);
      if (account && !(await window.api.accounts.ensureHostPermission(account.server_url))) {
        setTestMsg("Permission to contact that server was denied.");
        return;
      }
      const results = await onSyncAccount(accountId);
      await refresh();
      const pulled = results.reduce((sum, r) => sum + r.pulled, 0);
      const pushed = results.reduce((sum, r) => sum + r.pushed, 0);
      const errors = results.flatMap((r) => r.errors);
      if (!results.length) {
        setTestMsg("No lists are linked to a calendar on this account yet.");
      } else {
        setTestMsg(errors.length ? `Sync had errors: ${errors[0]}` : `Synced — ${pulled} pulled, ${pushed} pushed.`);
      }
    } catch (err: any) {
      setTestMsg(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  const PANES: { id: Pane; label: string }[] = [
    { id: "accounts", label: "Accounts" },
    { id: "calendars", label: "Calendars & Lists" },
    { id: "contacts", label: "Contacts" },
    { id: "sync", label: "Sync" },
    // Built-in sync server pane: desktop only (the add-on has no server) and only
    // when the feature is compiled in.
    ...(window.api.server ? [{ id: "server" as Pane, label: "Sync Server" }] : []),
    // The Thunderbird add-on has no settings/reminder subsystem (window.api.settings
    // is undefined there), so hide the empty Notifications & Startup pane for it.
    ...(window.api.settings ? [{ id: "notifications" as Pane, label: "Notifications & Startup" }] : [])
  ];
  const pendingCount = Object.keys(pendingByCal).length + Object.keys(pendingByBook).length;
  const linkedCalCount = (acc: CaldavAccountPublic) =>
    (calendarsByAccount[acc.id] ?? []).filter((c) => lists.some((l) => sameDavUrl(l.caldav_calendar_url, c.url))).length;
  const linkedBookCount = (acc: CaldavAccountPublic) =>
    (addressBooksByAccount[acc.id] ?? []).filter((bk) => addressBooks.some((ab) => sameDavUrl(ab.carddav_addressbook_url, bk.url))).length;

  /** Per-account calendar-link rows -- rendered in the Calendars & Lists pane. */
  function renderCalendarRows(acc: CaldavAccountPublic) {
    const cals = calendarsByAccount[acc.id];
    if (!cals || cals.length === 0) return <div className="status">No calendars discovered yet — use "Find calendars" on the Accounts tab.</div>;
    return cals.map((cal) => {
      const linkedList = lists.find((l) => sameDavUrl(l.caldav_calendar_url, cal.url));
      const current = linkedList?.id ?? "";
      const isConnected = current !== "";
      const pending = pendingByCal[cal.url];
      const selected = pending ?? current;
      const dirty = pending !== undefined;
      return (
        <div className="calendar-pick" key={cal.url}>
          <span>{cal.displayName}</span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {dirty && <span style={{ fontSize: 11, color: "#e8a23d" }}>Unsaved</span>}
            <select
              value={selected}
              disabled={busy}
              onChange={(e) => {
                const val = e.target.value;
                setPendingByCal((prev) => {
                  const next = { ...prev };
                  if (val === current) delete next[cal.url];
                  else next[cal.url] = val;
                  return next;
                });
              }}
            >
              {isConnected ? (
                <>
                  <option value={current} disabled>Connected</option>
                  <option value="">Not linked</option>
                </>
              ) : (
                <>
                  <option value="">Not linked</option>
                  <option value="__new__">Connected</option>
                </>
              )}
              {advancedLinking &&
                lists.filter((l) => l.id !== current).map((l) => (
                  <option key={l.id} value={l.id}>Add to {l.name}</option>
                ))}
            </select>
          </div>
        </div>
      );
    });
  }

  /** Per-account CardDAV URL + address-book-link rows -- Contacts pane. */
  function renderContactBlock(acc: CaldavAccountPublic) {
    return (
      <div style={{ display: "flex", gap: 6, flexDirection: "column" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", width: "100%" }}>
          <input
            style={{ flex: 1, background: "#26272a", border: "1px solid #34353a", borderRadius: 6, color: "#e6e6e6", padding: "5px 8px", fontSize: 12 }}
            placeholder="CardDAV URL (e.g. http://host:5000/carddav.php/…)"
            value={carddavUrlByAccount[acc.id] ?? (acc.carddav_url || "")}
            onChange={(e) => setCarddavUrlByAccount((prev) => ({ ...prev, [acc.id]: e.target.value }))}
          />
          <button onClick={() => discoverBooks(acc.id)} disabled={busy}>Find address books</button>
        </div>
        {addressBooksByAccount[acc.id]?.map((book) => {
          const linkedBook = addressBooks.find((ab) => sameDavUrl(ab.carddav_addressbook_url, book.url));
          const current = linkedBook?.id ?? "";
          const isConnected = current !== "";
          const pending = pendingByBook[book.url];
          const selected = pending ?? current;
          const dirty = pending !== undefined;
          return (
            <div className="calendar-pick" key={book.url} style={{ width: "100%" }}>
              <span>{book.displayName}</span>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {dirty && <span style={{ fontSize: 11, color: "#e8a23d" }}>Unsaved</span>}
                <select
                  value={selected}
                  disabled={busy}
                  onChange={(e) => {
                    const val = e.target.value;
                    setPendingByBook((prev) => {
                      const next = { ...prev };
                      if (val === current) delete next[book.url];
                      else next[book.url] = val;
                      return next;
                    });
                  }}
                >
                  {isConnected ? (
                    <>
                      <option value={current} disabled>Connected</option>
                      <option value="">Not linked</option>
                    </>
                  ) : (
                    <>
                      <option value="">Not linked</option>
                      <option value="__new__">Connected</option>
                    </>
                  )}
                </select>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  const saveBar = pendingCount > 0 ? (
    <div className="settings-save-bar">
      <span style={{ fontSize: 12, color: "#9aa0a6" }}>
        {pendingCount} unsaved change{pendingCount === 1 ? "" : "s"}
      </span>
      <button className="primary" disabled={busy} onClick={saveAllChanges}>Save changes</button>
    </div>
  ) : null;

  return (
    <div className="overlay">
      <div className="settings-modal settings-modal-paned" style={{ position: "relative" }}>
        <button className="modal-close" onClick={onClose}>×</button>
        <nav className="settings-nav">
          <div className="settings-nav-title">Settings</div>
          {PANES.map((p) => (
            <button
              key={p.id}
              className={`settings-nav-item ${activePane === p.id ? "active" : ""}`}
              onClick={() => setActivePane(p.id)}
            >
              {p.label}
            </button>
          ))}
          <div className="settings-nav-about">
            <div>Daynizer{version ? ` v${version}` : ""}</div>
            <div style={{ marginTop: 4 }}>
              {update?.state === "checking" && "Checking for updates…"}
              {update?.state === "none" && "Up to date"}
              {update?.state === "available" && `Downloading v${update.detail}…`}
              {update?.state === "downloading" && `Downloading update… ${update.detail}%`}
              {update?.state === "error" && `Update check failed: ${update.detail}`}
              {update?.state === "downloaded" && (
                <button className="primary" onClick={() => window.api.app?.installUpdate()}>
                  Restart to update to v{update.detail}
                </button>
              )}
            </div>
          </div>
        </nav>

        <div className="settings-pane">
          <h2>{PANES.find((p) => p.id === activePane)?.label}</h2>

          {activePane === "accounts" && (
            <>
              <p style={{ color: "#9aa0a6", fontSize: 12 }}>
                Connect a CalDAV server (Nextcloud, Tasks.org sync provider, DAVx5-compatible server, etc.).
                One account's credentials are shared by its calendars and contacts.
              </p>
              {accounts.length === 0 && <div className="status">No accounts yet — add one below.</div>}
              {accounts.map((acc) => (
                <div className="account-card" key={acc.id}>
                  <div className="row">
                    <strong>{acc.label}</strong>
                    <div>
                      <button onClick={() => test(acc)} disabled={busy}>Test</button>{" "}
                      <button onClick={() => discover(acc.id)} disabled={busy}>Find calendars</button>{" "}
                      <button onClick={() => syncNow(acc.id)} disabled={busy}>Sync now</button>{" "}
                      <button onClick={() => removeAccount(acc.id)} disabled={busy}>Remove</button>
                    </div>
                  </div>
                  <div className="status">{acc.server_url || acc.carddav_url} — {acc.username}</div>
                  <div className="status">{linkedCalCount(acc)} calendar(s), {linkedBookCount(acc)} address book(s) linked</div>
                  {acc.last_sync_at && (
                    <div className={`status ${acc.last_sync_status === "error" ? "error" : ""}`}>
                      Last sync: {new Date(acc.last_sync_at).toLocaleString()} ({acc.last_sync_status})
                    </div>
                  )}
                </div>
              ))}
            </>
          )}

          {activePane === "calendars" && (
            <>
              <div className="prefs-grid" style={{ marginBottom: 14 }}>
                <label className="pref-row" title="Where a new task goes when you're not already viewing a specific list.">
                  Default list for new tasks
                  <select value={prefs.defaultTaskListId ?? ""} onChange={(e) => setPref("defaultTaskListId", e.target.value)}>
                    <option value="">Auto (first synced list)</option>
                    {lists.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}{l.caldav_calendar_url ? "" : " (local)"}</option>
                    ))}
                  </select>
                </label>
                <label className="pref-row" title="Where a new event goes when you're not filtered to a specific calendar.">
                  Default calendar for new events
                  <select value={prefs.defaultEventListId ?? ""} onChange={(e) => setPref("defaultEventListId", e.target.value)}>
                    <option value="">Auto (first synced list)</option>
                    {lists.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}{l.caldav_calendar_url ? "" : " (local)"}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#9aa0a6", marginBottom: 10 }}>
                <input type="checkbox" checked={advancedLinking} onChange={(e) => setAdvancedLinking(e.target.checked)} />
                Additional list linking options (link a calendar to an existing list)
              </label>
              {accounts.length === 0 && <div className="status">Add an account first (Accounts tab).</div>}
              {accounts.map((acc) => (
                <div className="account-card" key={acc.id}>
                  <div className="row"><strong>{acc.label}</strong></div>
                  {renderCalendarRows(acc)}
                </div>
              ))}
            </>
          )}

          {activePane === "contacts" && (
            <>
              {accounts.length === 0 && <div className="status">Add an account first (Accounts tab).</div>}
              {accounts.map((acc) => (
                <div className="account-card" key={acc.id}>
                  <div className="row"><strong>{acc.label}</strong></div>
                  {renderContactBlock(acc)}
                </div>
              ))}
            </>
          )}

          {(activePane === "calendars" || activePane === "contacts") && saveBar}

          {activePane === "accounts" && (
            <label
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#9aa0a6", marginTop: 12 }}
              title="Enable if your server uses a self-signed certificate (e.g. Synology DSM over HTTPS on your LAN). Turns off certificate verification for the app's sync connections — only use on servers you trust."
            >
              <input
                type="checkbox"
                checked={prefs.allowInsecureCerts === "1"}
                onChange={(e) => setPref("allowInsecureCerts", e.target.checked ? "1" : "0")}
              />
              Allow self-signed certificates (self-hosted servers on your LAN)
            </label>
          )}

          {activePane === "contacts" && (
            <>
              <h3 style={{ marginTop: 18 }}>Contacts &amp; maintenance</h3>
              <div className="settings-tools">
                <button
                  disabled={busy}
                  onClick={repairDuplicates}
                  title="Consolidates duplicate task lists and address books left over from connect/disconnect cycles, and removes exact-duplicate contact rows. Shows a preview and asks before applying. Never deletes tasks or your contacts on the server."
                >
                  Repair duplicate lists &amp; books
                </button>
                <button onClick={onReviewDuplicates} title="Review possible duplicate contacts and merge them manually — this is where contacts are combined.">
                  Merge duplicates…
                </button>
                <button onClick={onImportVCard} title="Import contacts from a .vcf file, optionally adding a label to all of them.">
                  Import from vCard…
                </button>
              </div>
            </>
          )}

          {activePane === "accounts" && (
          <>
          <h3 style={{ marginTop: 18 }}>Add account</h3>
          <div className="form-grid">
          <input placeholder="Label (e.g. My Nextcloud)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <input placeholder="CalDAV URL — tasks & calendars (optional)" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
          <input placeholder="CardDAV URL — contacts (optional)" value={draftCarddavUrl} onChange={(e) => setDraftCarddavUrl(e.target.value)} />
          <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <div className="password-field">
            <input
              placeholder="Password / app token"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => setShowPassword((v) => !v)}
              title={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? "🙈" : "👁"}
            </button>
          </div>
          <div className="form-actions">
            <button onClick={testDraft} disabled={busy}>Test connection</button>
            <button className="primary" onClick={addAccount} disabled={busy}>Save account</button>
          </div>
          </div>
          </>
          )}
          {testMsg && <p style={{ fontSize: 12, color: "#9aa0a6" }}>{testMsg}</p>}

          {activePane === "sync" && window.api.settings && (
            <>
              <h3 style={{ marginTop: 18 }}>Sync</h3>
            <div className="prefs-grid">
              <label className="pref-row" title="Syncs all CalDAV accounts in the background. Manual sync (Ctrl+R) always works too.">
                Sync automatically every
                <select
                  value={prefs.syncIntervalMinutes ?? "60"}
                  onChange={(e) => setPref("syncIntervalMinutes", e.target.value)}
                >
                  <option value="1">1 minute</option>
                  <option value="5">5 minutes</option>
                  <option value="10">10 minutes</option>
                  <option value="30">30 minutes</option>
                  <option value="60">60 minutes (Tasks.org default)</option>
                  <option value="0">Off — manual only</option>
                </select>
              </label>
              <label className="pref-row" title="Change or disable this if it conflicts with another app's hotkey. Applies immediately.">
                "Sync Now" hotkey
                <select
                  value={prefs.syncHotkey ?? "CmdOrCtrl+R"}
                  onChange={(e) => setPref("syncHotkey", e.target.value)}
                >
                  <option value="CmdOrCtrl+R">Ctrl+R</option>
                  <option value="CmdOrCtrl+Shift+S">Ctrl+Shift+S</option>
                  <option value="CmdOrCtrl+Alt+R">Ctrl+Alt+R</option>
                  <option value="F9">F9</option>
                  <option value="">No hotkey (menu only)</option>
                </select>
              </label>
            </div>
            </>
          )}

          {activePane === "server" && (
            <>
              <p style={{ color: "#9aa0a6", fontSize: 12 }}>
                Daynizer can host its own CalDAV/CardDAV sync server, so your tasks, calendar and
                contacts sync across devices with no third-party account. One address serves both
                calendars and contacts — add it to Daynizer on another computer, or to apps like
                DAVx5, Tasks.org, Apple Calendar or Thunderbird.
              </p>

              {srv && srv.available && !srv.configured && (
                <div className="account-card" style={{ borderColor: "#4a90d9" }}>
                  <strong>Your sync server is ready</strong>
                  <p style={{ fontSize: 12, color: "#9aa0a6", margin: "6px 0" }}>
                    We generated a username and password for you (below). Use them as they are, or
                    change them now — then click "Got it". Daynizer will start with your computer and
                    keep the server running quietly in the tray, so your other devices can always sync.
                    You can change any of this here later.
                  </p>
                  <button
                    className="primary"
                    disabled={srvBusy}
                    onClick={async () => {
                      await window.api.server!.markConfigured();
                      await loadServer();
                      window.api.settings?.all().then(setPrefs).catch(() => {});
                    }}
                  >
                    Got it
                  </button>
                </div>
              )}

              {srv && !srv.available && (
                <div className="status error">The bundled server isn't available in this build.</div>
              )}

              <label className="pref-row" style={{ marginTop: 4 }} title="Runs the built-in server in the background. It keeps running while Daynizer is in the tray.">
                <input
                  type="checkbox"
                  checked={!!srv?.enabled}
                  disabled={srvBusy || !srv?.available}
                  onChange={(e) => srvToggle(e.target.checked)}
                />
                Run the built-in sync server
              </label>

              {window.api.settings && (
                <label className="pref-row pref-indent" title="Starts Daynizer automatically when you log in and boots straight to the tray (no window), so the server is always available for your other devices.">
                  <input
                    type="checkbox"
                    checked={prefs.launchAtLogin === "1"}
                    disabled={srvBusy || !srv?.enabled}
                    onChange={(e) => { setPref("launchAtLogin", e.target.checked ? "1" : "0"); if (e.target.checked) setPref("launchHidden", "1"); }}
                  />
                  Start at login and run in the background (recommended)
                </label>
              )}

              <div className="status">
                Status:{" "}
                {srv?.running
                  ? `running on port ${srv.port}`
                  : srv?.enabled
                    ? (srv.error ? `not running (${srv.error})` : "starting…")
                    : "off"}
              </div>
              {srv?.note && <div className="status" style={{ color: "#e8a23d" }}>{srv.note}</div>}
              {srv?.running && srv.lastActivity && (
                <div className="status">Last device sync: {relTime(srv.lastActivity)}</div>
              )}

              {srv?.running && (
                <>
                  <h3 style={{ marginTop: 18 }}>Connect other apps</h3>
                  <p style={{ color: "#9aa0a6", fontSize: 12 }}>
                    Use this one address in any CalDAV/CardDAV app — it finds both your calendars
                    and your contacts. On the same computer, use the local address instead.
                  </p>
                  <div className="prefs-grid">
                    <label className="pref-row">
                      Address (other devices)
                      <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input readOnly value={srv.baseUrl ?? ""} style={{ width: 260 }} />
                        <button onClick={() => srvCopy(srv.baseUrl ?? "", "Address")}>Copy</button>
                      </span>
                    </label>
                    <label className="pref-row">
                      Address (this computer)
                      <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input readOnly value={srv.localUrl ?? ""} style={{ width: 260 }} />
                        <button onClick={() => srvCopy(srv.localUrl ?? "", "Local address")}>Copy</button>
                      </span>
                    </label>
                  </div>
                  {srv.platform === "win32" && (
                    <div style={{ marginTop: 10 }}>
                      {prefs.firewallRuleAdded === "1" ? (
                        <div className="status">Windows Firewall: other devices allowed ✓</div>
                      ) : (
                        <>
                          <button onClick={srvOpenFirewall} disabled={srvBusy}>Allow other devices through Windows Firewall</button>
                          <div style={{ fontSize: 11, color: "#9aa0a6", marginTop: 4 }}>
                            A one-time Windows permission prompt so phones and other computers on your
                            network can reach the server. Without it, Windows may block them.
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}

              <h3 style={{ marginTop: 18 }}>Credentials</h3>
              <div className="prefs-grid">
                <label className="pref-row">
                  Username
                  <input value={srvUser} onChange={(e) => setSrvUser(e.target.value)} disabled={srvBusy} style={{ width: 200 }} />
                </label>
                <label className="pref-row">
                  Password
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type={showSrvPass ? "text" : "password"}
                      value={srvPass}
                      onChange={(e) => setSrvPass(e.target.value)}
                      disabled={srvBusy}
                      style={{ width: 200 }}
                    />
                    <button type="button" onClick={() => setShowSrvPass((v) => !v)} title={showSrvPass ? "Hide password" : "Show password"}>
                      {showSrvPass ? "🙈" : "👁"}
                    </button>
                    <button onClick={() => srvCopy(srvPass, "Password")}>Copy</button>
                  </span>
                </label>
              </div>
              <div className="settings-tools" style={{ marginTop: 8 }}>
                <button className="primary" onClick={srvApplyCreds} disabled={srvBusy}>Save credentials</button>
                <button onClick={srvRegenerate} disabled={srvBusy}>Regenerate password</button>
              </div>
              <div style={{ fontSize: 11, color: "#9aa0a6", marginTop: 6 }}>
                Changing the password is safe. Changing the username starts a fresh account on the
                server (existing data stays under the old name).
              </div>

              <h3 style={{ marginTop: 18 }}>Port</h3>
              <label className="pref-row" style={{ maxWidth: 360 }}>
                Server port
                <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="number" min={1024} max={65535} value={srvPort} onChange={(e) => setSrvPort(e.target.value)} disabled={srvBusy} style={{ width: 90 }} />
                  <button onClick={srvApplyPort} disabled={srvBusy}>Apply</button>
                </span>
              </label>
              <div style={{ fontSize: 11, color: "#9aa0a6", marginTop: 6 }}>
                Default 5232 (the standard CalDAV/CardDAV port). Keeping it fixed means connected
                apps don't need reconfiguring. If it's ever already in use, Daynizer temporarily
                picks another and notes it above.
              </div>

              <h3 style={{ marginTop: 18 }}>How to connect</h3>
              <details>
                <summary style={{ cursor: "pointer", fontSize: 13, marginBottom: 4 }}>DAVx5 + Tasks.org (Android)</summary>
                <ol style={{ fontSize: 12, color: "#c8c8c8", lineHeight: 1.7, marginTop: 4 }}>
                  <li>Make sure the phone is on the same Wi-Fi as this computer.</li>
                  <li>In DAVx5: <strong>+</strong> → "Login with URL and user name".</li>
                  <li>Base URL: the <em>other devices</em> address above. Username / password: the ones above.</li>
                  <li>Finish, then tick the calendars, contacts and task lists it finds.</li>
                  <li>For tasks, install <strong>Tasks.org</strong> (or OpenTasks) so DAVx5 can sync them.</li>
                </ol>
              </details>
              <details>
                <summary style={{ cursor: "pointer", fontSize: 13, marginBottom: 4 }}>Apple Calendar / Contacts (macOS, iPhone)</summary>
                <ol style={{ fontSize: 12, color: "#c8c8c8", lineHeight: 1.7, marginTop: 4 }}>
                  <li>Settings → Calendar → Accounts → Add Account → Other → Add CalDAV account.</li>
                  <li>Account type "Advanced"; Server: this computer's IP; Port: the port above; turn SSL off (LAN).</li>
                  <li>Use the username and password above. Repeat under Contacts for a CardDAV account.</li>
                </ol>
              </details>
              <details>
                <summary style={{ cursor: "pointer", fontSize: 13, marginBottom: 4 }}>Thunderbird</summary>
                <ol style={{ fontSize: 12, color: "#c8c8c8", lineHeight: 1.7, marginTop: 4 }}>
                  <li>New Calendar → On the Network → paste the address above, enter the username/password.</li>
                  <li>Address Book → New → CardDAV Address Book → same address and credentials.</li>
                </ol>
              </details>
              <p style={{ fontSize: 12, marginTop: 10 }}>
                <a href="https://precisioncrab.com/daynizer/connect/" target="_blank" rel="noreferrer" style={{ color: "#4a90d9" }}>
                  Full connection guide →
                </a>
              </p>

              {srvMsg && <p style={{ fontSize: 12, color: "#9aa0a6" }}>{srvMsg}</p>}
            </>
          )}

          {activePane === "notifications" && window.api.settings && (
            <>
              <h3 style={{ marginTop: 18 }}>Notifications &amp; startup</h3>
            <div className="prefs-grid">
              <label className="pref-row">
                <input
                  type="checkbox"
                  checked={prefs.notificationsEnabled === "1"}
                  onChange={(e) => setPref("notificationsEnabled", e.target.checked ? "1" : "0")}
                />
                Remind me when tasks are due
              </label>
              <label className="pref-row pref-indent" title="Tasks with a due time are reminded at that time; tasks with only a date are reminded at this time of day">
                Remind date-only tasks at
                <input
                  type="time"
                  value={prefs.reminderTime || "18:00"}
                  disabled={prefs.notificationsEnabled !== "1"}
                  onChange={(e) => setPref("reminderTime", e.target.value || "18:00")}
                />
              </label>
              <label className="pref-row" title="Closing the window keeps the app in the tray so reminders and sync keep working">
                <input
                  type="checkbox"
                  checked={prefs.closeToTray === "1"}
                  onChange={(e) => setPref("closeToTray", e.target.checked ? "1" : "0")}
                />
                Keep running in the tray when the window is closed
              </label>
              <label className="pref-row">
                <input
                  type="checkbox"
                  checked={prefs.launchAtLogin === "1"}
                  onChange={(e) => setPref("launchAtLogin", e.target.checked ? "1" : "0")}
                />
                Start Daynizer when the computer starts
              </label>
            </div>
          </>
        )}

        </div>
      </div>
    </div>
  );
}
