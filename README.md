# Daynizer

A keyboard-and-mouse desktop app for **tasks, calendar, and contacts**, kept in sync with your
own server over **CalDAV and CardDAV**. Daynizer reimplements the core of
[Tasks.org](https://tasks.org) (lists, subtasks, due/start dates, priorities, recurrence, tags) and
adds a full calendar and contacts manager on top — all two-way syncable with the same
Tasks.org-compatible setup you already use on mobile (DAVx5 / Nextcloud / Synology / any
CalDAV+CardDAV server). Built with Electron + React + TypeScript.

> **Beta software (v0.4.x).** Daynizer is still in active development and hasn't reached a stable
> 1.0. Expect rough edges, and keep a backup of anything important — while sync is two-way, don't
> rely on this as the only copy of your data yet. Bug reports are welcome on the
> [issue tracker](https://github.com/precisioncrab/daynizer-desktop/issues).

## What Daynizer does

- **Tasks** — lists, one level of subtasks, start/due dates, priorities, tags, and recurrence
  (RRULE), fully compatible with Tasks.org VTODOs over CalDAV.
- **Calendar** — a month/week/day calendar that shows tasks and events together; create, edit, and
  delete events (including recurring events) and sync them two-way over CalDAV.
- **Contacts** — a dedicated contacts manager with address books and color-coded labels,
  synced two-way over CardDAV.
- **One server, both protocols** — point Daynizer at your CalDAV/CardDAV server (Synology, Nextcloud,
  Baïkal, Radicale, …) and it discovers and links your calendars, task lists, and address books.
- **Reminders** — multiple reminders per task/event, fired as native desktop notifications and synced
  as CalDAV VALARMs so your phone fires them too.
- **Keyboard-first** — every action has a shortcut; no touch gestures anywhere.

## Installation

Grab the latest build for your platform from the
[Releases page](https://github.com/precisioncrab/daynizer-desktop/releases/latest).

### Windows (.exe)

Download `Daynizer-Setup-x.y.z.exe` and run it. It installs per-user (no admin prompt) and
**automatically replaces any previously installed version** — your settings and database are kept.
The Windows app also **updates itself**: it checks this repo's releases on startup, downloads new
versions in the background, and offers "Restart to update" in Settings, so you only download the
installer once. To remove it: Windows Settings → Apps → Installed apps → Daynizer → Uninstall.

### Debian / Ubuntu (.deb)

```bash
sudo apt install ./tasks-desktop_x.y.z_amd64.deb
```

`apt` resolves the dependencies automatically (plain `dpkg -i` works too, followed by
`sudo apt -f install` if it complains). Launch from your app menu, or run `daynizer`.
Update by installing a newer .deb the same way; remove with `sudo apt remove daynizer`.

### Flatpak (auto-updating)

Daynizer is published as a proper Flatpak repository, so you install it once and then
`flatpak update` (or GNOME Software / KDE Discover) keeps it current automatically:

```bash
# install once from the repository (pulls the runtimes it needs from Flathub)
flatpak install --from https://precisioncrab.github.io/daynizer-desktop/daynizer-desktop.flatpakref

# run it
flatpak run com.precisioncrab.daynizer
```

After that it appears in your app menu like any other app. To update:

```bash
flatpak update
```

Remove it with `flatpak uninstall com.precisioncrab.daynizer`. (If you have a Flathub remote already, the
required runtimes install automatically; if not, the `.flatpakref` points at Flathub so they're fetched
on first install.)

A standalone `.flatpak` bundle is also attached to each [GitHub release](https://github.com/precisioncrab/daynizer-desktop/releases/latest)
for offline installs, but the repository above is the recommended path since it's the one that
auto-updates.

### macOS (.dmg)

Two dmgs are published: `arm64` for Apple Silicon (M1 and later) and `x64` for Intel Macs — pick the
one matching your machine (About This Mac shows which chip you have). Open it and drag **Daynizer**
into **Applications**. The build is not code-signed, so the first launch is blocked by Gatekeeper —
right-click (or Ctrl-click) the app in Applications and choose **Open**, then confirm. This is only
needed once. Update by installing a newer .dmg over the old copy; remove by deleting the app from
Applications.

## Built-in sync server (no external server needed)

Don't have a CalDAV/CardDAV server? Daynizer can run its own. When you turn it on, Daynizer starts a
bundled sync server in the background, wires *itself* up to it automatically, and gives you one address
you can point your phone and other computers at — so your tasks, calendar, and contacts sync across your
devices with no third-party account, no NAS, and no cloud.

**Turn it on:** open **Settings → Sync Server** and tick **Run the built-in sync server**. That's it —
Daynizer creates a "Built-in server" account for itself with default Calendar and Contacts lists, and
the server keeps running in the background (and in the tray when the window is closed). The pane shows
the one **address** to use, plus the **username** and **password** (both editable and copyable).

**Add your other devices:** point any CalDAV/CardDAV app at the address shown — the **same address serves
both calendars and contacts**, and clients discover both from it:

- **Android:** [DAVx5](https://www.davx5.com/) with the address + username/password, then **Tasks.org**
  (or OpenTasks) for the task lists.
- **iPhone / macOS:** Settings → add an **Advanced CalDAV account** (and a **CardDAV account**) using the
  server IP, port, username, and password (turn SSL off for a plain-`http` LAN address).
- **Thunderbird / another Daynizer:** paste the address and credentials into a new network calendar /
  address book, or into another Daynizer's **Add account** form.

Both devices must be on the **same network**. The server uses port **5232** by default (changeable in the
pane); if it's ever in use, Daynizer picks another and tells you. On Windows you may need to allow the port
through the firewall the first time. Step-by-step instructions for each app are in **Settings → Sync
Server → How to connect**, and online at
[precisioncrab.com/daynizer/connect](https://precisioncrab.com/daynizer/connect/).

> The built-in server is for your **own devices on your own network**. It's plain HTTP on the LAN (fine
> for a trusted home network; DAVx5 shows a one-time warning). Exposing it to the public internet is not
> recommended.

## Connecting a CalDAV / CardDAV server (Synology, Nextcloud, …)

Prefer your own server (Synology, Nextcloud, Baïkal, Radicale, …)? Daynizer syncs **tasks & calendars
over CalDAV** and **contacts over CardDAV**. Open **Settings**
(the "CalDAV / CardDAV accounts…" button in the sidebar) → **Add account** and fill in:

- **CalDAV URL** — the calendars/tasks endpoint (optional if you only want contacts).
- **CardDAV URL** — the contacts endpoint (optional if you only want tasks/calendars). On some
  servers this is a *different* address than CalDAV (notably Synology); on others (Nextcloud) it's
  the same base URL. At least one of the two is required.
- **Username** and **Password / app token**.

Click **Test connection** — it reports how many calendars **and** address books it found, so you can
confirm the URLs before saving. After saving, use the account's **Find calendars** to link lists, and
the **Contacts (CardDAV)** section to **Find address books** and link them.

> **Self-hosted server over HTTPS?** NAS boxes (Synology, etc.) usually use a **self-signed
> certificate**, which the app rejects by default. If HTTPS gives "fetch failed" but HTTP works, tick
> **Allow self-signed certificates** in Settings — only do this for servers you trust on your own network.

### Synology — Calendar and Contacts URLs live in different places

Synology serves CalDAV and CardDAV as **separate services at different addresses**, so enter both.

- **CalDAV (Calendar):** open the **Synology Calendar** app → **Settings** (gear, top-right) → **CalDAV
  Account**. The URL looks like:

  ```
  http://<nas-ip>:5000/caldav.php/          # or https://<nas-ip>:5001/caldav.php/ over HTTPS
  ```

- **CardDAV (Contacts):** the contacts service is separate and, by default, listens only on the loopback
  address (port 5555). Give it a reachable HTTPS port first:
  **Control Panel → System → Login Portal → Applications → Synology Contacts → set an HTTPS port**
  (e.g. your DSM HTTPS port, 5001). Then the CardDAV base URL is:

  ```
  https://<nas-ip>:<https-port>/carddav/    # e.g. https://192.168.50.3:5001/carddav/
  ```

- DSM's HTTPS cert is self-signed, so enable **Allow self-signed certificates** (see the note above).

### Nextcloud — one base URL for both

Nextcloud auto-discovers calendars **and** contacts from a single DAV base, so put the **same URL** in
both the CalDAV and CardDAV fields:

```
https://<your-nextcloud-host>/remote.php/dav/
```

(In-app you can also copy the exact addresses: **Calendar → Settings, bottom-left → "Copy primary CalDAV
address"**; contacts live under `/remote.php/dav/addressbooks/users/<user>/`.)

### Other servers

Most CalDAV/CardDAV servers auto-discover from a base URL — paste that and the app finds the collections:

- **Baïkal:** `https://<host>/dav.php/` (discovers both calendars and address books).
- **Radicale:** `http://<host>:5232/` (or `http://<host>:5232/<user>/`).
- **Generic / DAVx5-compatible:** if a single base URL doesn't discover everything, enter the specific
  collection URLs — `.../calendars/<user>/` for CalDAV and `.../addressbooks/<user>/` for CardDAV.

Notes: usernames with spaces can break discovery on some servers — avoid them if possible. Synology
doesn't support two-factor auth for third-party CalDAV/CardDAV clients; use your normal password.

## Features

**Tasks**
- Lists sidebar (custom lists, "All Tasks", "Today & Overdue"); create and select lists.
- Right-click a list to rename it, export it to `.ics`, **Unlink** it, or **Delete** it. *Unlink* makes
  a linked list local-only: your tasks stay both on this computer and on the server, but that list
  stops syncing. *Delete* removes the list and its tasks from Daynizer, and from the server too when
  the list is linked (see the note under Known limitations about whole-list deletion on DAViCal /
  Synology).
- Title, notes, start date, due date, priority (None/High/Medium/Low), tags, and recurrence (RRULE,
  with quick presets for daily/weekly/monthly/yearly plus a custom-RRULE field).
- Subtasks (one level), shown nested under their parent and in the detail panel.
- Search across title/notes/tags; right-click context menu (complete / duplicate / delete).

**Calendar**
- Month / week / day views showing tasks and events together, with a tasks/events/both toggle and
  task display modes (due date, start date, or start→due range), plus list/category filters.
- Double-click or right-click a day or time slot to create an item there. Drag an event's bar to
  reschedule it, or **drag its top or bottom edge to resize it** (change the start or end time) in the
  week and day views.
- Calendar events: create / edit / delete, including recurring events (whole series) using the same
  RRULE presets tasks use — all synced two-way over CalDAV.

**Contacts**
- Dedicated Contacts view with a list, detail panel, and a contacts-aware sidebar (address books
  and labels with colors).
- Two-way CardDAV sync: create, edit, and delete contacts alongside your tasks and calendars.
- Birthdays & anniversaries, year-less birthdays, per-label colors, label filtering, and a
  merge-duplicates tool. Delete a label to remove that category from every contact and sync the change.

**Sync & reminders**
- Two-way sync engine (`electron/caldav.ts` / `carddav.ts`): pulls new/changed remote items into the
  local DB, pushes new/changed local items to the server, and propagates deletions.
- CalDAV accounts screen: add a server (label, CalDAV URL, CardDAV URL, username, password/app-token),
  test the connection, discover calendars and address books, and link local lists/books to remote ones.
- Reminders: multiple reminders per task/event (at time, or minutes/hours/days before); native desktop
  notifications that jump to the item when clicked, synced as CalDAV VALARMs so Android clients
  (DAVx5 + Etar, Tasks.org mobile) fire them too.
- Self-signed HTTPS support for self-hosted servers; a "Clean up duplicates" tool for lists / address
  books / contacts left over from earlier connect-disconnect cycles.

**Interface**
- One-level undo (Ctrl/Cmd+Z, or Edit ▸ Undo) across tasks and events.
- Settings organized into left-nav panes (Accounts, Calendars & Lists, Contacts, Sync, Notifications &
  Startup); choose a default list for new tasks and a default calendar for new events.
- Collapsible sidebar and right rail (with re-expand tabs) to give the calendar/list more room.
- Keyboard shortcuts: Ctrl+N new task, Ctrl+Shift+N new list, Ctrl+F search, Ctrl+R sync, Delete to
  remove the selected task — fully mouse/keyboard driven, no touch gestures.

## Known limitations

- Sync conflicts (the same item edited on two devices between syncs) keep the server version and
  preserve the local edits as a "(conflicted copy)"; there's no merge UI yet.
- Only one level of subtasks is modeled (no infinitely nested subtasks).
- Recurring events are edited as a whole series only (no per-occurrence exceptions), and the calendar
  grid draws a recurring event on its first occurrence rather than expanding it across every date; the
  RRULE itself is stored and synced correctly.
- On **DAViCal-based servers (including Synology Calendar)**, deleting a whole list removes it locally
  but cannot remove the calendar collection from the server — DAViCal rejects `DELETE` on a collection
  (`405`). Individual tasks/events still delete and sync normally; only whole-calendar deletion is
  server-side manual (remove it in the server's own UI).

## Stack

- Electron (main process) + Node's built-in `node:sqlite` for local storage (no native compiler required)
- React + TypeScript (renderer), built with Vite
- `tsdav` for CalDAV/CardDAV discovery and sync, `ical.js` for VTODO/VEVENT parsing and generation

## Setup

```bash
cd daynizer-desktop
npm install
```

No native build tools (Visual Studio Build Tools, Python, etc.) are required — storage uses Node's
built-in `node:sqlite` module instead of a compiled native addon, so this installs cleanly on both
Windows and Linux with just Node and npm.

If `node:sqlite` isn't available in the Electron version that gets installed (it needs an Electron build
on Node 22.5+), run `npm install electron@latest` to pick up a newer one. If the app still fails to start
with an error mentioning `node:sqlite` or `ERR_UNKNOWN_BUILTIN_MODULE`, add `--experimental-sqlite` to the
`electron .` command in the `dev:electron` / `start` scripts in `package.json`.

## Running in development

Open two terminals from the project folder:

```bash
# terminal 1 — Vite dev server for the renderer
npm run dev

# terminal 2 — compile + launch Electron, pointed at the dev server
npm run dev:electron
```

## Production-style run / packaging

```bash
npm start        # build renderer + electron main, then launch
npm run package  # build + bundle as DMG / NSIS installer / deb + flatpak via electron-builder
```
