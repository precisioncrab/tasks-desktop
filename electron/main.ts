import { app, BrowserWindow, ipcMain, Menu, Notification, Tray, nativeImage, shell, dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;
import {
  listsAll,
  listCreate,
  listUpdate,
  listDelete,
  countDirtyItems,
  tasksAll,
  tasksByList,
  taskCreate,
  taskUpdate,
  taskToggleComplete,
  taskDelete,
  subtasksOf,
  accountsAll,
  accountCreate,
  accountUpdate,
  davRepairOrphanedLinks,
  accountDelete,
  settingsAll,
  settingSet,
  eventsAll,
  eventsByList,
  eventCreate,
  eventUpdate,
  eventDelete,
  remindersForOwner,
  reminderCreateForOwner,
  reminderDeleteForOwner,
  remindersDueForNotification,
  reminderMarkFired,
  addressBooksAll,
  addressBookCreate,
  addressBookUpdate,
  addressBookDelete,
  contactsAll,
  contactsAllForUi,
  contactsByBook,
  contactCreate,
  contactUpdate,
  contactDelete,
  contactsMerge,
  dedupeDatabase
} from "./db.js";
import { testConnection, discoverCalendars, linkListToCalendar, unlinkList, syncAccount, createServerCalendar, deleteServerCalendar, encryptPassword, connectCalendar, syncLog, pushCalendarName } from "./caldav.js";
import { taskToVTodo, eventToVEvent, bundleIcs } from "./ical.js";
import { discoverAddressBooks, linkAddressBook, unlinkAddressBook, syncAccountContacts, connectAddressBook, importVCards, createServerAddressBook, pushAddressBookName } from "./carddav.js";
import { serverManager, type ServerStatus } from "./serverManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
// The experimental build is packaged with productName "Daynizer (Experimental)",
// so electron-builder names its exe/install dir accordingly. Detect it from the exe
// path (no build-time flag needed) so it can wear the distinct orange icon + identity,
// the same way dev runs do — handy since it shares the stable app's database.
const isExperimental = /experimental/i.test(app.getPath("exe"));
// Runs that should look distinct from an installed production build (orange icon).
const isDistinctBuild = isDev || isExperimental;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuiting = false;
// Set while a "sync before closing" run is in flight, so the programmatic quit
// afterwards doesn't re-open the same prompt.
let syncingBeforeQuit = false;

/** Sync every account (calendars + contacts) before the app quits. Best-effort:
 *  failures are logged, never block the quit. Used by the close prompt. */
async function syncAllForQuit(): Promise<void> {
  for (const account of accountsAll()) {
    try {
      await syncAccount(account);
      const hasBooks = addressBooksAll().some((b) => b.carddav_account_id === account.id && b.carddav_addressbook_url);
      if (hasBooks) {
        try { await syncAccountContacts(account); } catch (err: any) { syncLog(`quit-sync carddav FAILED "${account.label}": ${err?.message || err}`); }
      }
      accountUpdate(account.id, { last_sync_at: new Date().toISOString(), last_sync_status: "ok" } as any);
    } catch (err: any) {
      syncLog(`quit-sync FAILED "${account.label}": ${err?.message || err}`);
    }
  }
}

const SETTING_DEFAULTS: Record<string, string> = {
  notificationsEnabled: "1",
  reminderTime: "18:00", // when date-only tasks fire
  closeToTray: "0", // off by default: the X button really quits; opt in via settings
  launchAtLogin: "0",
  launchHidden: "1", // when autostarting, boot to the tray with no window (C1)
  syncIntervalMinutes: "60", // background auto-sync; matches Tasks.org's default; "0" = manual only
  syncHotkey: "CmdOrCtrl+R", // accelerator for Sync Now; "" = no hotkey
  allowInsecureCerts: "0" // opt-in: accept self-signed TLS certs (self-hosted LAN servers)
};

function getSetting(key: string): string {
  return settingsAll()[key] ?? SETTING_DEFAULTS[key] ?? "";
}

/** Opt-in acceptance of self-signed certificates for self-hosted servers on the
 *  LAN (e.g. Synology DSM's default HTTPS cert on :5001). Off by default; when
 *  on it turns off TLS verification for the app's Node fetches (undici honors
 *  NODE_TLS_REJECT_UNAUTHORIZED via tls.connect), so it's clearly labeled in
 *  Settings. Applied at startup and whenever the toggle changes. */
function applyTlsSetting() {
  if (getSetting("allowInsecureCerts") === "1") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  else delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
}

// Serialize account syncs at the process level. Overlapping triggers (the
// launch sync, the auto-sync interval, a dirty-row sync, and a manual Sync now)
// must never run two passes against the synchronous SQLite DB at once -- that
// contention is what can freeze a new-contact write behind a running sync. Each
// call waits for the previous to settle; a failure never wedges the chain.
let syncChain: Promise<unknown> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = syncChain.then(fn, fn);
  syncChain = next.then(() => undefined, () => undefined);
  return next;
}

// ---------- Built-in server: auto-wired self-account (Phase B3) ----------
// So the user never types the built-in server's URL/credentials into THIS app:
// once the server is running, ensure a Daynizer account exists pointing at it
// (localhost, the generated creds), provision its default Calendar + Contacts,
// and keep it in step when the port/username/password change. Runs only when the
// server's connection details actually change (tracked by a signature persisted
// in settings), so normal launches don't redo the work.
const SELF_ACCOUNT_ID_KEY = "serverSelfAccountId";
const SELF_ACCOUNT_SIG_KEY = "serverSelfSig";
let selfAccountBusy = false;

async function ensureSelfAccount(): Promise<void> {
  if (!serverManager.isEnabled() || selfAccountBusy) return;
  const info = serverManager.getInfo();
  if (!info.running || !info.localUrl) return; // only wire against a live server

  const sig = `${info.localUrl}|${info.username}|${info.password}`;
  const selfId = getSetting(SELF_ACCOUNT_ID_KEY);
  const existing = selfId ? accountsAll().find((a) => a.id === selfId) : undefined;
  // Nothing to do if the config is unchanged AND the account still exists.
  if (sig === getSetting(SELF_ACCOUNT_SIG_KEY) && existing) return;

  selfAccountBusy = true;
  try {
    let account = existing;
    if (account) {
      accountUpdate(account.id, {
        server_url: info.localUrl,
        carddav_url: info.localUrl,
        username: info.username,
        password_enc: encryptPassword(info.password)
      } as any);
      account = accountsAll().find((a) => a.id === account!.id);
    } else {
      account = accountCreate({
        label: "Built-in server",
        server_url: info.localUrl,
        carddav_url: info.localUrl,
        username: info.username,
        password_enc: encryptPassword(info.password)
      } as any);
      settingSet(SELF_ACCOUNT_ID_KEY, account.id);
    }
    if (!account) return;

    // Provision default collections if the (possibly newly re-homed) principal is
    // empty. Idempotent: a no-op when Calendar / Contacts already exist.
    try {
      const cals = await discoverCalendars(account);
      if (cals.length === 0) await createServerCalendar(account, "Calendar");
    } catch (err: any) { syncLog(`self-account: default calendar: ${err?.message || err}`); }
    try {
      const books = await discoverAddressBooks(account);
      if (books.length === 0) await createServerAddressBook(account, "Contacts");
    } catch (err: any) { syncLog(`self-account: default contacts: ${err?.message || err}`); }

    // First sync so the local lists/books link up and appear in the UI.
    try {
      await syncAccount(account);
      const hasBooks = addressBooksAll().some((b) => b.carddav_account_id === account!.id && b.carddav_addressbook_url);
      if (hasBooks) { try { await syncAccountContacts(account); } catch { /* logged elsewhere */ } }
      accountUpdate(account.id, { last_sync_at: new Date().toISOString(), last_sync_status: "ok" } as any);
    } catch (err: any) {
      syncLog(`self-account sync: ${err?.message || err}`);
    }

    settingSet(SELF_ACCOUNT_SIG_KEY, sig);
    mainWindow?.webContents.send("server:accountReady");
  } catch (err: any) {
    syncLog(`ensureSelfAccount failed: ${err?.message || err}`);
  } finally {
    selfAccountBusy = false;
  }
}

function showMainWindow() {
  if (!mainWindow) { createWindow(); return; }
  // A window created hidden for a background start skips the taskbar; restore it
  // now that the user is opening it.
  mainWindow.setSkipTaskbar(false);
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  // Windows blocks a background process from stealing the foreground, so a plain
  // focus() on a notification/tray click only flashes the taskbar button -- the
  // window restores but stays behind, which reads as "clicking did nothing." A
  // brief always-on-top flip reliably raises it to the front, then we drop the
  // flag so it behaves normally afterward.
  mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  mainWindow.setAlwaysOnTop(false);
  mainWindow.focus();
}

function createWindow(show = true) {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 520,
    title: "Daynizer",
    // Start hidden when autostarted in the background (C1): the app boots straight
    // to the tray with the server running and no window. showMainWindow() reveals it.
    show,
    // Don't flash a taskbar button for a background start; showMainWindow re-enables it.
    skipTaskbar: !show,
    // Explicit window icon so the taskbar button always shows the app icon
    // regardless of how the exe was launched (installed shortcut, portable
    // unpacked exe, or dev). Without this, Windows falls back to the generic
    // Electron icon when no matching AppUserModelID shortcut is registered.
    icon: nativeImage.createFromPath(iconPath(isDistinctBuild ? "32x32-dev.png" : "256x256.png")),
    backgroundColor: "#1e1f22",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Right-click Cut/Copy/Paste on inputs (and Copy on any selected text).
  mainWindow.webContents.on("context-menu", (_e, params) => {
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      template.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll" }
      );
    } else if (params.selectionText && params.selectionText.trim()) {
      template.push({ role: "copy" }, { type: "separator" }, { role: "selectAll" });
    }
    if (template.length && mainWindow) Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Close-to-tray: the X button hides the window instead of quitting when EITHER
  // the user opted in (closeToTray) OR the built-in server is running — the server
  // is meant to be an always-on background service (C1), so closing the window must
  // not take it down. Quitting is always available from the tray menu and File > Exit.
  mainWindow.on("close", (e) => {
    const keepAliveForServer = serverManager.isEnabled() && serverManager.isUserEnabled();
    if (!isQuiting && (getSetting("closeToTray") === "1" || keepAliveForServer)) {
      e.preventDefault();
      mainWindow?.hide();
      mainWindow?.setSkipTaskbar(true);
      return;
    }
    // Real quit. If there are local edits that haven't reached the server yet,
    // offer to sync before closing. (Skipped on the programmatic re-close after
    // the user chose "Sync now".)
    if (!syncingBeforeQuit && accountsAll().length > 0) {
      const dirty = countDirtyItems();
      if (dirty > 0) {
        const choice = dialog.showMessageBoxSync(mainWindow!, {
          type: "question",
          buttons: ["Sync now", "Close without syncing", "Cancel"],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
          message: "You have unsynced changes",
          detail: `${dirty} change${dirty === 1 ? "" : "s"} haven't been pushed to the server yet.`
        });
        if (choice === 2) { e.preventDefault(); return; }          // Cancel — stay open
        if (choice === 0) {                                        // Sync, then quit
          e.preventDefault();
          syncingBeforeQuit = true;
          syncAllForQuit().finally(() => { isQuiting = true; app.quit(); });
          return;
        }
        // choice === 1: fall through and let the window close without syncing.
      }
    }
  });
}

function iconPath(name: string): string {
  return path.join(app.getAppPath(), "build", "icons", name);
}

function setupTray() {
  try {
    // Dev/experimental runs use a distinct orange icon file (build/icons/32x32-dev.png)
    // so they're never confused with an installed production build at a glance.
    tray = new Tray(nativeImage.createFromPath(iconPath(isDistinctBuild ? "32x32-dev.png" : "32x32.png")));
    tray.setToolTip(isDev ? "Daynizer (dev)" : isExperimental ? "Daynizer (Experimental)" : "Daynizer");
    rebuildTrayMenu();
    tray.on("click", () => showMainWindow());
    tray.on("double-click", () => showMainWindow());
  } catch (err) {
    console.error("[tray] failed to create tray icon:", err);
  }
}

/** (Re)build the tray context menu. Includes a built-in-server status line +
 *  start/stop when the server feature is enabled, so its state is visible and
 *  controllable without a window (Syncthing-style; the full status UI is C1). */
/** "just now" / "3 min ago" / "2 h ago" / "4 d ago" for the tray activity line. */
function relativeTime(epochMs: number): string {
  const s = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function rebuildTrayMenu() {
  if (!tray) return;
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: "Open Daynizer", click: () => showMainWindow() }
  ];
  if (serverManager.isEnabled()) {
    const s = serverManager.getStatus();
    const label = !s.available
      ? "Built-in server: unavailable"
      : s.running
        ? `Built-in server: running on :${s.port}`
        : !s.enabled
          ? "Built-in server: off"
          : s.error
            ? `Built-in server: ${s.error}`
            : "Built-in server: stopped";
    items.push(
      { type: "separator" },
      { label, enabled: false }
    );
    if (s.running && s.lastActivity) {
      items.push({ label: `Last device sync: ${relativeTime(s.lastActivity)}`, enabled: false });
    }
    items.push(
      s.running
        ? { label: "Stop server", click: () => { serverManager.setEnabled(false); } }
        : { label: "Start server", enabled: s.available, click: () => { serverManager.setEnabled(true); } }
    );
  }
  items.push(
    { type: "separator" },
    { label: "Quit", click: () => { isQuiting = true; app.quit(); } }
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

/** app.setLoginItemSettings covers Windows/macOS; on Linux we write (or
 *  remove) a freedesktop autostart entry instead. When `hidden` is set, the
 *  autostart launch carries `--hidden` (and macOS's openAsHidden) so the app
 *  boots straight to the tray with no window (C1). */
function applyLaunchAtLogin(enabled: boolean, hidden = getSetting("launchHidden") !== "0") {
  if (process.platform === "linux") {
    try {
      const dir = path.join(os.homedir(), ".config", "autostart");
      const file = path.join(dir, "daynizer.desktop");
      if (enabled) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, `[Desktop Entry]
Type=Application
Name=Daynizer
Exec="${process.execPath}"${hidden ? " --hidden" : ""}
X-GNOME-Autostart-enabled=true
`);
      } else if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (err) {
      console.error("[autostart] failed:", err);
    }
    return;
  }
  // Windows: args are appended to the registry Run command, so `--hidden` reaches
  // the autostarted process. macOS: openAsHidden hides the app at login.
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: enabled && hidden && process.platform === "darwin",
    args: hidden ? ["--hidden"] : []
  });
}

// ---------- Reminders ----------
function parseReminderTime(): { hh: number; mm: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(getSetting("reminderTime"));
  if (!m) return { hh: 18, mm: 0 };
  return { hh: Math.min(23, Number(m[1])), mm: Math.min(59, Number(m[2])) };
}

function formatDueForBody(due: string, hh: number, mm: number): string {
  const d = new Date(due.length <= 10 ? `${due}T00:00:00` : due);
  if (due.length <= 10) d.setHours(hh, mm, 0, 0);
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function checkReminders() {
  if (getSetting("notificationsEnabled") !== "1" || !Notification.isSupported()) return;
  const { hh, mm } = parseReminderTime();
  const due = remindersDueForNotification(hh, mm);
  if (due.length === 0) return;
  const icon = nativeImage.createFromPath(iconPath("128x128.png"));
  if (due.length > 3) {
    // One pile-up notification (typically right after launch) instead of a burst.
    const n = new Notification({ title: `${due.length} reminders`, body: due.map((r) => r.title).slice(0, 5).join(", ") + (due.length > 5 ? ", …" : ""), icon });
    n.on("click", () => showMainWindow());
    n.show();
    for (const r of due) reminderMarkFired(r.reminderId);
    return;
  }
  for (const r of due) {
    const n = new Notification({ title: r.title, body: `${r.ownerType === "task" ? "Due" : "Starts"} ${formatDueForBody(r.due, hh, mm)}`, icon });
    n.on("click", () => {
      showMainWindow();
      mainWindow?.webContents.send(r.ownerType === "task" ? "notify:select-task" : "notify:select-event", r.ownerId);
    });
    n.show();
    reminderMarkFired(r.reminderId);
  }
}

/** Combine the sync logs (current + rotated) with a short diagnostics header
 *  into one text file the user can save and share. No credentials are included
 *  -- just app/version/platform, the data-folder path, and list/account counts.
 *  Reveals the saved file in the OS file manager. */
async function exportLogs() {
  try {
    const dir = app.getPath("userData");
    const parts: string[] = [
      "Daynizer diagnostics",
      `Generated:   ${new Date().toISOString()}`,
      `App version: ${app.getVersion()}`,
      `Platform:    ${process.platform} ${process.arch}`,
      `User data:   ${dir}`
    ];
    try {
      const lists = listsAll();
      parts.push(`Lists:       ${lists.length} (linked to a server: ${lists.filter((l) => l.caldav_calendar_url).length})`);
      parts.push(`Accounts:    ${accountsAll().length}`);
    } catch { /* non-fatal */ }
    parts.push("");
    let anyLog = false;
    for (const name of ["sync.log.1", "sync.log"]) {
      try {
        const content = fs.readFileSync(path.join(dir, name), "utf8");
        parts.push(`===== ${name} =====`, content, "");
        anyLog = true;
      } catch { /* file may not exist */ }
    }
    if (!anyLog) parts.push("(no sync log has been written yet)");

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const res = await dialog.showSaveDialog(mainWindow!, {
      title: "Export Logs",
      defaultPath: path.join(app.getPath("desktop"), `daynizer-logs-${stamp}.txt`),
      filters: [{ name: "Text", extensions: ["txt"] }]
    });
    if (res.canceled || !res.filePath) return;
    fs.writeFileSync(res.filePath, parts.join("\n"), "utf8");
    shell.showItemInFolder(res.filePath);
  } catch (err: any) {
    dialog.showErrorBox("Export Logs failed", String(err?.message || err));
  }
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Task",
          accelerator: "CmdOrCtrl+N",
          click: () => mainWindow?.webContents.send("shortcut:new-task")
        },
        {
          label: "New List",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => mainWindow?.webContents.send("shortcut:new-list")
        },
        { type: "separator" },
        {
          label: "Export Logs…",
          click: () => { exportLogs(); }
        },
        {
          label: "Open Logs Folder",
          click: () => { shell.openPath(app.getPath("userData")); }
        },
        { type: "separator" },
        ...(isMac
          ? [{ role: "close" as const }]
          : [{
              label: "Exit",
              click: () => { isQuiting = true; app.quit(); }
            }])
      ]
    },
    {
      label: "Edit",
      submenu: [
        {
          // App-level undo (restores the last task action: delete, edit,
          // complete-toggle, create, snooze, reorder). registerAccelerator is
          // false so the renderer's focus-aware keydown owns Ctrl/Cmd+Z —
          // that keeps native undo working inside text fields while typing.
          // The accelerator is still shown here for discoverability, and
          // clicking the item dispatches the same undo.
          label: "Undo",
          accelerator: "CmdOrCtrl+Z",
          registerAccelerator: false,
          click: () => mainWindow?.webContents.send("shortcut:undo")
        },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        {
          label: "Settings…",
          click: () => mainWindow?.webContents.send("shortcut:open-settings")
        }
      ]
    },
    {
      label: "View",
      submenu: [
        {
          label: "Find / Search",
          accelerator: "CmdOrCtrl+F",
          click: () => mainWindow?.webContents.send("shortcut:focus-search")
        },
        { type: "separator" },
        // Explicit F5: the role's default (CmdOrCtrl+R) collided with Sync Now.
        { role: "reload", accelerator: "F5" },
        { role: "toggleDevTools" },
        { type: "separator" },
        {
          label: "About Daynizer",
          click: () => mainWindow?.webContents.send("shortcut:open-about")
        }
      ]
    },
    {
      label: "Account",
      submenu: [
        {
          label: "CalDAV Accounts…",
          accelerator: "CmdOrCtrl+,",
          click: () => mainWindow?.webContents.send("shortcut:open-settings")
        }
      ]
    },
    {
      label: "Sync",
      submenu: [
        {
          label: "Sync Now",
          // Configurable so it can be changed/disabled on hotkey conflicts.
          ...(getSetting("syncHotkey") ? { accelerator: getSetting("syncHotkey") } : {}),
          click: () => mainWindow?.webContents.send("shortcut:sync-now")
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Auto-update (Windows/NSIS only). deb/flatpak installs update through the
 *  package manager or a manual download, and electron-updater can't help there. */
function setupAutoUpdater() {
  if (!app.isPackaged || process.platform !== "win32") return;
  const send = (state: string, detail?: unknown) =>
    mainWindow?.webContents.send("update:status", state, detail);
  autoUpdater.on("checking-for-update", () => send("checking"));
  autoUpdater.on("update-available", (info: any) => send("available", info.version));
  autoUpdater.on("update-not-available", () => send("none"));
  autoUpdater.on("download-progress", (p: any) => send("downloading", Math.round(p.percent)));
  autoUpdater.on("update-downloaded", (info: any) => send("downloaded", info.version));
  autoUpdater.on("error", (err: any) => send("error", err?.message || String(err)));
  autoUpdater.checkForUpdates().catch(() => {});
}

function registerIpc() {
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("update:install", () => autoUpdater.quitAndInstall());

  ipcMain.handle("settings:all", () => ({ ...SETTING_DEFAULTS, ...settingsAll() }));
  ipcMain.handle("settings:set", (_e, key: string, value: string) => {
    settingSet(key, value);
    if (key === "launchAtLogin") applyLaunchAtLogin(value === "1");
    // Re-register the login item so a hidden/visible-start change takes effect.
    if (key === "launchHidden") applyLaunchAtLogin(getSetting("launchAtLogin") === "1", value !== "0");
    if (key === "syncHotkey") buildMenu(); // apply new accelerator immediately
    if (key === "allowInsecureCerts") applyTlsSetting();
  });

  ipcMain.handle("lists:all", () => listsAll());
  ipcMain.handle("lists:create", (_e, name: string, color?: string) => listCreate(name, color));
  ipcMain.handle("lists:update", async (_e, id: string, patch: any) => {
    const before = listsAll().find((l) => l.id === id);
    const updated = listUpdate(id, patch);
    // A rename of a linked list must reach the server too (was local-only).
    // PROPPATCH the calendar's DAV:displayname. Best-effort: a failure leaves
    // the local rename in place and is retried the next time it's renamed.
    if (
      patch && typeof patch.name === "string" &&
      before && patch.name !== before.name &&
      updated.caldav_account_id && updated.caldav_calendar_url
    ) {
      const account = accountsAll().find((a) => a.id === updated.caldav_account_id);
      if (account) {
        try {
          await pushCalendarName(account, updated.caldav_calendar_url, updated.name);
        } catch (err) {
          console.error("Failed to push list rename to server:", err);
        }
      }
    }
    return updated;
  });
  ipcMain.handle("lists:delete", (_e, id: string) => listDelete(id));
  ipcMain.handle("lists:export", async (_e, listId: string) => {
    const list = listsAll().find((l) => l.id === listId);
    if (!list) throw new Error("List not found");
    // Serialize every task (VTODO) and event (VEVENT) in the list the same way
    // the sync push does -- reminders as VALARMs, and recurring events with their
    // exdates/overrides -- then bundle into one VCALENDAR.
    const items: string[] = [];
    const listTasks = tasksByList(listId);
    // Map each task to its effective UID so a subtask's RELATED-TO can carry the
    // PARENT's UID (matches the sync serializer).
    const uidById = new Map(listTasks.map((t) => [t.id, t.caldav_uid || `${t.id}@tasks-desktop`]));
    for (const t of listTasks) {
      const offsets = remindersForOwner("task", t.id).map((r) => r.offset_minutes);
      const parentUid = t.parent_id ? uidById.get(t.parent_id) : undefined;
      items.push(taskToVTodo(t, undefined, offsets, parentUid).ics);
    }
    for (const ev of eventsByList(listId)) {
      const offsets = remindersForOwner("event", ev.id).map((r) => r.offset_minutes);
      const exdates = (() => { try { return JSON.parse(ev.exdates || "[]"); } catch { return []; } })();
      const overrides = (() => { try { return JSON.parse(ev.overrides || "[]"); } catch { return []; } })();
      items.push(eventToVEvent(ev, undefined, offsets, exdates, overrides).ics);
    }
    const ics = bundleIcs(items);

    const slug = list.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "list";
    const stamp = new Date().toISOString().slice(0, 10);
    const res = await dialog.showSaveDialog(mainWindow!, {
      title: "Export List",
      defaultPath: path.join(app.getPath("desktop"), `${slug}-${stamp}.ics`),
      filters: [{ name: "iCalendar", extensions: ["ics"] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, ics, "utf8");
    shell.showItemInFolder(res.filePath);
    return { ok: true, count: items.length, path: res.filePath };
  });

  ipcMain.handle("tasks:all", () => tasksAll());
  ipcMain.handle("tasks:byList", (_e, listId: string) => tasksByList(listId));
  ipcMain.handle("tasks:subtasks", (_e, parentId: string) => subtasksOf(parentId));
  ipcMain.handle("tasks:create", (_e, input: any) => taskCreate(input));
  ipcMain.handle("tasks:update", (_e, id: string, patch: any) => taskUpdate(id, patch));
  ipcMain.handle("tasks:toggleComplete", (_e, id: string) => taskToggleComplete(id));
  ipcMain.handle("tasks:delete", (_e, id: string, hard?: boolean) => taskDelete(id, hard));

  ipcMain.handle("events:all", () => eventsAll());
  ipcMain.handle("events:create", (_e, input: any) => eventCreate(input));
  ipcMain.handle("events:update", (_e, id: string, patch: any) => eventUpdate(id, patch));
  ipcMain.handle("events:delete", (_e, id: string, hard?: boolean) => eventDelete(id, hard));

  ipcMain.handle("addressbooks:all", () => addressBooksAll());
  ipcMain.handle("addressbooks:create", (_e, name: string, color?: string) => addressBookCreate(name, color));
  ipcMain.handle("addressbooks:update", async (_e, id: string, patch: any) => {
    const before = addressBooksAll().find((b) => b.id === id);
    const updated = addressBookUpdate(id, patch);
    // A rename of a linked address book must reach the server too -- PROPPATCH
    // the collection's DAV:displayname (mirrors the list-rename path). Best-effort:
    // a failure leaves the local rename in place, retried next rename.
    if (
      patch && typeof patch.name === "string" &&
      before && patch.name !== before.name &&
      updated.carddav_account_id && updated.carddav_addressbook_url
    ) {
      const account = accountsAll().find((a) => a.id === updated.carddav_account_id);
      if (account) {
        try {
          await pushAddressBookName(account, updated.carddav_addressbook_url, updated.name);
        } catch (err) {
          console.error("Failed to push address book rename to server:", err);
        }
      }
    }
    return updated;
  });
  ipcMain.handle("addressbooks:delete", (_e, id: string) => addressBookDelete(id));
  ipcMain.handle("addressbooks:discover", async (_e, accountId: string) => {
    const account = accountsAll().find((a) => a.id === accountId);
    if (!account) throw new Error("Account not found");
    return discoverAddressBooks(account);
  });
  ipcMain.handle("addressbooks:link", (_e, bookId: string, accountId: string, url: string) => linkAddressBook(bookId, accountId, url));
  // Idempotent connect: reuse the existing linked book (matched by normalized
  // URL) rather than creating a duplicate that would triplicate contacts.
  ipcMain.handle("addressbooks:connect", (_e, accountId: string, url: string, displayName: string) =>
    connectAddressBook(accountId, url, displayName)
  );
  ipcMain.handle("addressbooks:unlink", (_e, bookId: string) => unlinkAddressBook(bookId));

  ipcMain.handle("contacts:all", () => contactsAllForUi());
  ipcMain.handle("contacts:byBook", (_e, bookId: string) => contactsByBook(bookId));
  ipcMain.handle("contacts:create", (_e, input: any) => contactCreate(input));
  ipcMain.handle("contacts:update", (_e, id: string, patch: any) => contactUpdate(id, patch));
  ipcMain.handle("contacts:delete", (_e, id: string, hard?: boolean) => contactDelete(id, hard));
  ipcMain.handle("contacts:import", async (_e, opts: { label: string; bookId: string; createNew: boolean }) => {
    const res = await dialog.showOpenDialog({
      title: "Import contacts from vCard",
      filters: [{ name: "vCard", extensions: ["vcf", "vcard"] }],
      properties: ["openFile"]
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const text = fs.readFileSync(res.filePaths[0], "utf8");
    const summary = importVCards(text, opts);
    return { canceled: false, ...summary };
  });
  ipcMain.handle("contacts:merge", (_e, keeperId: string, loserIds: string[], patch: any) => contactsMerge(keeperId, loserIds, patch));

  ipcMain.handle("reminders:for", (_e, ownerType: "task" | "event", ownerId: string) => remindersForOwner(ownerType, ownerId));
  ipcMain.handle("reminders:create", (_e, ownerType: "task" | "event", ownerId: string, offsetMinutes: number) =>
    reminderCreateForOwner(ownerType, ownerId, offsetMinutes)
  );
  ipcMain.handle("reminders:delete", (_e, id: string) => reminderDeleteForOwner(id));

  ipcMain.handle("accounts:all", () => accountsAll().map(({ password_enc, ...rest }) => rest));
  ipcMain.handle("accounts:create", (_e, input: any) => {
    const created = accountCreate({ ...input, password_enc: encryptPassword(input.password) });
    const { password_enc, ...rest } = created;
    return rest;
  });
  ipcMain.handle("accounts:update", (_e, id: string, patch: any) => {
    const p = { ...patch };
    if (p.password) {
      p.password_enc = encryptPassword(p.password);
      delete p.password;
    }
    const updated = accountUpdate(id, p);
    const { password_enc, ...rest } = updated;
    return rest;
  });
  ipcMain.handle("accounts:delete", (_e, id: string) => accountDelete(id));
  ipcMain.handle("accounts:testConnection", async (_e, account: any) => {
    const full = accountsAll().find((a) => a.id === account.id) || { ...account, password_enc: encryptPassword(account.password || "") };
    const cal = await testConnection(full as any);
    // Also probe CardDAV address books -- uses carddav_url, else falls back to
    // server_url in clientFor -- so testing a draft (before the account is
    // saved) already reports address books if the URL is a contacts endpoint.
    // Silent on failure (a plain CalDAV URL just isn't a CardDAV collection).
    let books = "";
    try {
      const found = await discoverAddressBooks(full as any);
      if (found.length > 0) books = ` Found ${found.length} address book(s).`;
    } catch { /* not a CardDAV endpoint / unreachable — omit */ }
    return { ok: cal.ok, message: cal.message + books };
  });
  ipcMain.handle("accounts:discoverCalendars", async (_e, accountId: string) => {
    const account = accountsAll().find((a) => a.id === accountId);
    if (!account) throw new Error("Account not found");
    return discoverCalendars(account);
  });
  ipcMain.handle("accounts:linkList", (_e, listId: string, accountId: string, calendarUrl: string) =>
    linkListToCalendar(listId, accountId, calendarUrl)
  );
  // Idempotent connect: reuses an existing list for this calendar (matched by
  // normalized URL) instead of ever creating a duplicate local list.
  ipcMain.handle("accounts:connectCalendar", (_e, accountId: string, calendarUrl: string, displayName: string, color?: string | null) =>
    connectCalendar(accountId, calendarUrl, displayName, color)
  );
  ipcMain.handle("accounts:unlinkList", (_e, listId: string) => unlinkList(listId));
  // One-shot cleanup of duplicate lists / address books / contacts already in
  // the database (the http<->https reconnect fallout). Non-destructive to tasks.
  ipcMain.handle("maintenance:dedupe", (_e, dryRun?: boolean) => dedupeDatabase(!!dryRun));
  ipcMain.handle("accounts:createServerCalendar", async (_e, accountId: string, name: string) => {
    const account = accountsAll().find((a) => a.id === accountId);
    if (!account) throw new Error("Account not found");
    return createServerCalendar(account, name);
  });
  ipcMain.handle("accounts:deleteServerCalendar", async (_e, accountId: string, calendarUrl: string) => {
    const account = accountsAll().find((a) => a.id === accountId);
    if (!account) throw new Error("Account not found");
    return deleteServerCalendar(account, calendarUrl);
  });
  ipcMain.handle("addressbooks:createServer", async (_e, accountId: string, name: string) => {
    const account = accountsAll().find((a) => a.id === accountId);
    if (!account) throw new Error("Account not found");
    return createServerAddressBook(account, name);
  });
  // Auto-provision default collections on an otherwise-empty server so a
  // freshly-added account is immediately usable without the server's own admin
  // UI. Creates a "Calendar" (holds tasks + events) when the CalDAV home has no
  // calendars, and a "Contacts" book when the CardDAV home has none. A no-op
  // where collections already exist (Synology, Nextcloud, ...); each half is
  // best-effort so a failure on one never blocks the other or the account itself.
  ipcMain.handle("accounts:bootstrapDefaults", async (_e, accountId: string) => {
    const account = accountsAll().find((a) => a.id === accountId);
    if (!account) throw new Error("Account not found");
    const created: { calendar?: string; addressBook?: string } = {};
    if (account.server_url) {
      try {
        const cals = await discoverCalendars(account);
        if (cals.length === 0) {
          await createServerCalendar(account, "Calendar");
          created.calendar = "Calendar";
        }
      } catch (err: any) {
        syncLog(`bootstrap: default calendar not created for "${account.label}": ${err?.message || err}`);
      }
    }
    // Contacts: prefer a dedicated CardDAV URL, but fall back to the CalDAV/base
    // URL -- unified servers (Radicale, Baikal) serve CardDAV at the SAME address,
    // so a user who entered only a CalDAV URL still wants a contacts book. On a
    // CalDAV-only host (e.g. Synology's calendar endpoint), discoverAddressBooks
    // throws and this is a safe no-op. (clientFor uses carddav_url || server_url.)
    if (account.carddav_url || account.server_url) {
      try {
        const books = await discoverAddressBooks(account);
        if (books.length === 0) {
          await createServerAddressBook(account, "Contacts");
          created.addressBook = "Contacts";
        }
        // Discovery succeeded off the base URL with no separate CardDAV URL set,
        // so this server does CardDAV at the same address: record it so future
        // syncs and the Settings Contacts pane treat this as a CardDAV account.
        if (!account.carddav_url) {
          accountUpdate(account.id, { carddav_url: account.server_url } as any);
        }
      } catch (err: any) {
        syncLog(`bootstrap: default contacts book not created for "${account.label}": ${err?.message || err}`);
      }
    }
    return created;
  });
  ipcMain.handle("accounts:sync", (_e, accountId: string) => runExclusive(async () => {
    const account = accountsAll().find((a) => a.id === accountId);
    if (!account) throw new Error("Account not found");
    const results = await syncAccount(account);
    // Also sync contacts, but only if this account has a linked address book --
    // avoids opening a CardDAV client (and a spurious error) on calendar-only
    // accounts. Contact results fold into the same list the UI aggregates.
    const hasBooks = addressBooksAll().some((b) => b.carddav_account_id === accountId && b.carddav_addressbook_url);
    if (hasBooks) {
      try {
        const contactResults = await syncAccountContacts(account);
        for (const r of contactResults) results.push({ listId: r.bookId, pulled: r.pulled, pushed: r.pushed, errors: r.errors });
      } catch (err: any) {
        // Must reach sync.log AND the UI. Swallowing this into console.error
        // hid a completely dead contact sync for eight days -- the packaged
        // build has no console anyone reads.
        const msg = err?.message || String(err);
        syncLog(`carddav sync FAILED for account "${account.label}": ${msg}`);
        results.push({ listId: "", pulled: 0, pushed: 0, errors: [`Contact sync failed: ${msg}`] });
      }
    } else {
      // A silent skip here is indistinguishable from "nothing to do", which is
      // exactly how the orphaned-book bug stayed invisible. Say why.
      const books = addressBooksAll().filter((b) => b.carddav_addressbook_url);
      syncLog(
        `carddav: skipped account "${account.label}" — no linked address book ` +
          `(${books.length} book(s) have a URL but none point at this account id ${accountId})`
      );
    }
    accountUpdate(accountId, {
      last_sync_at: new Date().toISOString(),
      last_sync_status: results.some((r) => r.errors.length) ? "error" : "ok"
    } as any);
    return results;
  }));

  // ---------- Built-in sync server (Phase B2) ----------
  // Status is safe to expose broadly; getInfo() additionally returns the
  // generated password (for the pairing screen / manual account add in C3) and
  // is only reachable over this IPC channel, never broadcast.
  ipcMain.handle("server:status", () => serverManager.getStatus());
  ipcMain.handle("server:info", () => serverManager.getInfo());
  ipcMain.handle("server:start", async () => { await serverManager.start(); return serverManager.getStatus(); });
  ipcMain.handle("server:stop", async () => { await serverManager.stop(); return serverManager.getStatus(); });
  ipcMain.handle("server:restart", async () => { await serverManager.restart(); return serverManager.getStatus(); });
  // Config surface (B3/C3): the Settings "Sync Server" pane drives these.
  ipcMain.handle("server:setEnabled", (_e, on: boolean) => serverManager.setEnabled(!!on));
  ipcMain.handle("server:setPort", (_e, port: number) => serverManager.setPort(Number(port)));
  ipcMain.handle("server:setCredentials", (_e, opts: { username?: string; password?: string }) => serverManager.setCredentials(opts || {}));
  ipcMain.handle("server:regeneratePassword", () => serverManager.regeneratePassword());
  ipcMain.handle("server:markConfigured", () => {
    const status = serverManager.markConfigured();
    // First-run consent point ("Got it"): make the server a real always-on service
    // by enabling start-at-login (hidden, to the tray). Done once; the user can turn
    // it off in the Sync Server pane afterwards.
    if (getSetting("serverAutostartInit") !== "1") {
      settingSet("serverAutostartInit", "1");
      settingSet("launchAtLogin", "1");
      settingSet("launchHidden", "1");
      applyLaunchAtLogin(true, true);
    }
    return status;
  });
}

// Single-instance lock. A second launch (double-click, autostart race, or a
// stale copy that never fully quit) must not start a second process: two
// instances share the same userData database, and with synchronous node:sqlite
// their syncs contend on the DB lock -- which can freeze the UI for minutes (a
// new-contact write stuck behind the other instance's sync). Hand the launch
// off to the running window and exit.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  // Distinct AppUserModelID in dev so a raw `electron .` run doesn't register a
  // shortcut under the packaged app's identity — that collision is what made
  // Windows show the Electron icon on the installed app's taskbar button.
  if (process.platform === "win32") app.setAppUserModelId(isDev ? "com.precisioncrab.daynizer.dev" : isExperimental ? "com.precisioncrab.daynizer.experimental" : "com.precisioncrab.daynizer"); // required for toasts; matches the experimental build's appId so its taskbar button/toasts stay separate from stable
  // Heal links left pointing at a deleted account before any sync runs. This
  // state is invisible in the UI -- the list/book still looks connected -- but
  // every sync gate skips it, so it fails 100% silently until someone reads
  // the database. Cheap to check, so check every launch.
  for (const l of davRepairOrphanedLinks()) syncLog(`startup: ${l}`);

  registerIpc();
  buildMenu();
  // Background start (C1): when launched at login with --hidden (or macOS's
  // openAsHidden), boot straight to the tray with no window. The server still
  // starts below and the tray is created; showMainWindow() reveals the window.
  const startHidden = process.argv.includes("--hidden") || app.getLoginItemSettings().wasOpenedAsHidden;
  createWindow(!startHidden);
  setupTray();
  setupAutoUpdater();
  applyLaunchAtLogin(getSetting("launchAtLogin") === "1");
  applyTlsSetting();

  // Built-in sync server (Phase B2). No-op unless SERVER_BUILTIN is on. Lifecycle
  // is tied to the APP, not the window: it starts here and stops on before-quit,
  // so it keeps running while the window is hidden to tray. On any state change,
  // refresh the tray status line and push status to the renderer (Settings/status
  // UI subscribes via api.on("server:status", …); the UI itself lands in C1/C3).
  serverManager.init({
    log: syncLog,
    onStatus: (status: ServerStatus) => {
      rebuildTrayMenu();
      mainWindow?.webContents.send("server:status", status);
      // When the server is up, make sure Daynizer's own account points at it
      // (creating it on first run, updating it after a port/credential change).
      // Serialized with other syncs; guarded so unchanged configs are a no-op.
      if (status.running) runExclusive(() => ensureSelfAccount());
    }
  });

  // First reminder pass shortly after launch (catches anything that came due
  // while the app was off), then once a minute.
  setTimeout(checkReminders, 5000);
  setInterval(checkReminders, 60_000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  isQuiting = true;
  // Best-effort clean shutdown of the built-in server child. before-quit can't
  // await; the manager sends SIGTERM (then SIGKILL after a grace period), and the
  // child was spawned with detached:false so it dies with the parent regardless.
  serverManager.stop();
});

app.on("window-all-closed", () => {
  // NOTE: this quits on window close (non-mac) unless "close to tray" is on, which
  // also tears down the built-in server. Keeping the server alive headlessly after
  // a window close in the default (non-tray) case is Phase C1 (background + boot +
  // tray, with close-to-tray becoming the default once the server ships).
  if (process.platform !== "darwin") app.quit();
});
