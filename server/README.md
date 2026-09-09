# Daynizer bundled sync server — build & recon (Radicale)

This folder holds everything needed to (1) run Radicale locally on Windows as a
quick "built-in server" proof, and (2) freeze it into a standalone binary we can
ship inside Daynizer. It maps to **Phase A4 (freezing reconnaissance)** and
**Phase B1 (standalone frozen server)** in `../../DAYNIZER-SERVER-PLAN.md`.

Files:
- `requirements.txt` — build-time Python deps (Radicale, passlib, bcrypt, PyInstaller).
- `radicale_entry.py` — the entry script PyInstaller freezes (thin wrapper over Radicale's CLI).
- `radicale.spec` — the PyInstaller spec (handles Radicale's runtime-loaded backends + data files).
- `config.template` — Radicale config with `{PLACEHOLDERS}` the app fills at runtime.
- `make-user.py` — writes a bcrypt htpasswd entry (cross-platform; no apache2-utils).

> **Working style:** run the commands below one at a time in PowerShell, leading
> with the `cd`. All commands assume you start in the repo root
> `C:\Users\Hunter\Documents\Claude\Projects\Tasks.org-Desktop\tasks-desktop`.

---

## 0. Python / PyInstaller version caveat (read first)

You have **Python 3.14.6**. Radicale runs fine on it, but **PyInstaller often
lags brand-new Python releases**, so the *freeze* step (Stage 2) may fail on
3.14. Stage 1 (running Radicale directly) does not care.

If Stage 2 errors on 3.14, install **Python 3.12 or 3.13** and build the freeze
with that (`py -3.13 -m venv ...`). The frozen binary bundles its own Python
runtime, so the version you freeze *with* has nothing to do with the user's
machine — it only has to be a version PyInstaller supports.

---

## Stage 1 — Local loop, no freezing (fastest "built-in server" test)

Proves Radicale runs on Windows and Daynizer can sync to a server on this
machine. ~10 minutes.

Create a venv and install deps:

```
cd C:\Users\Hunter\Documents\Claude\Projects\Tasks.org-Desktop\tasks-desktop\server
py -m venv .venv
```

```
.\.venv\Scripts\python -m pip install -r requirements.txt
```

Create a data dir + a test user (writes a bcrypt `users` file):

```
.\.venv\Scripts\python make-user.py "$env:USERPROFILE\daynizer-radicale\users" test test
```

Make a `config` from the template — for the local test, point it at that data
dir. Easiest is to write it inline:

```
@"
[server]
hosts = 0.0.0.0:5232
[auth]
type = htpasswd
htpasswd_filename = $env:USERPROFILE\daynizer-radicale\users
htpasswd_encryption = bcrypt
[storage]
filesystem_folder = $env:USERPROFILE\daynizer-radicale\collections
[rights]
type = owner_only
[logging]
level = info
"@ | Set-Content -Encoding utf8 "$env:USERPROFILE\daynizer-radicale\config"
```

Run the server:

```
.\.venv\Scripts\python -m radicale --config "$env:USERPROFILE\daynizer-radicale\config"
```

Leave that window running. Then in the Daynizer (Experimental) app, add an
account:
- Base / CalDAV URL: `http://127.0.0.1:5232/`  (or your LAN IP for a phone test)
- Username `test`, password `test`

The empty-server auto-provision should create a default Calendar + Contacts, and
the A2 round-trip checklist applies exactly as against the homelab Radicale.
Stop the server with Ctrl+C when done.

---

## Stage 2 — Freeze it into a standalone binary (the decision gate)

Proves a shippable, self-contained server binary. If this is clean, **Path 1
(bundle Radicale) is confirmed.**

From the venv (or a 3.12/3.13 venv per the caveat above):

```
cd C:\Users\Hunter\Documents\Claude\Projects\Tasks.org-Desktop\tasks-desktop\server
.\.venv\Scripts\pyinstaller radicale.spec
```

That produces `dist\daynizer-radicale\daynizer-radicale.exe` plus its support
folder. Run the frozen binary against the SAME config as Stage 1:

```
.\dist\daynizer-radicale\daynizer-radicale.exe --config "$env:USERPROFILE\daynizer-radicale\config"
```

Re-point Daynizer at `http://127.0.0.1:5232/` and confirm it serves the same
collections. If a request 500s with a `ModuleNotFoundError` for a
`radicale.<something>` backend, that backend needs adding to the spec's hidden
imports — send me the error and I'll patch `radicale.spec`.

**Exit test (A4 / B1):** the frozen binary, run by hand, serves the collections
Daynizer syncs to — no system Python required.

---

## What's next once the freeze is clean (I wire these — Phase B)

- **B2:** Electron main process spawns/supervises the frozen binary as a child —
  free-port pick, health-check, auto-restart, config + htpasswd generated at
  runtime from `config.template`, decoupled from the window so it keeps running.
- **B3:** zero-config first run — generate the sync account, auto-create default
  collections, built-in server on by default (see "Decisions locked in" in the
  plan), adopt any existing local lists into synced collections.

All of it behind a feature flag so half-built server code never ships enabled.
