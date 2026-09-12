# Radicale — behavior we inherit by bundling it (Phase A4 findings)

_The catalog of Radicale-specific behavior a bundled Daynizer build has to reckon with, plus the
PyInstaller freeze reconnaissance that decides bundle-vs-reimplement. Written against **Radicale
3.8.0** on **Windows 11** (Python 3.14.6), the platform Daynizer ships first._

> **Decision gate outcome: PATH 1 — BUNDLE RADICALE. Confirmed 2026-09-10.**
> The freeze is clean and the frozen binary serves the same collections Daynizer syncs to with no
> system Python. Nothing found here argues for reimplementing the CalDAV/CardDAV surface in Node.

---

## 1. PyInstaller freeze reconnaissance (the decision input)

- **Toolchain:** PyInstaller **6.22.2** on **Python 3.14.6**, in the `server/.venv`. The 3.12/3.13
  fallback the plan hedged for was **not needed** — 6.22.2 supports 3.14. (The frozen runtime is
  self-contained, so the freezing Python has nothing to do with the user's machine either way.)
- **Spec:** `server/radicale.spec`, onedir build off `radicale_entry.py` (a thin wrapper over
  `radicale.__main__.run`). `collect_all` pulls data+binaries+hidden-imports for
  `radicale, passlib, libpass, bcrypt, vobject, defusedxml`; `collect_submodules` force-bundles the
  runtime-selected backend packages (`radicale.auth/.storage/.rights/.web`) so switching a config
  value never needs a rebuild. This is essential — Radicale loads those by dotted name at runtime,
  invisible to PyInstaller's static analysis.
- **Build result:** clean. Output `dist/daynizer-radicale/` = a **7.2 MB** launcher exe +
  `_internal/` (bundled Python runtime + deps). onedir (no per-launch temp extraction; faster start,
  easier to debug; ships fine inside Electron resources).
- **Runs standalone:** the frozen `daynizer-radicale.exe --config <config>` starts with **no system
  Python**, logging `python=3.14.6 radicale=3.8.0 vobject=0.9.9 passlib=1.9.3 defusedxml=0.7.1
  bcrypt=5.0.0`, reads the bcrypt htpasswd user, opens `multifilesystem` storage, binds
  `0.0.0.0:5232`, and reaches `Radicale server ready`.
- **Serves the real client:** Daynizer (tsdav, logged `using 'node'`) discovered `/` and `/test/`
  (207), REPORTed the existing `calendar-…` and `contacts-…` collections (207 Multi-Status w/
  getetag), and round-tripped a VTODO write (PUT 201) — all against the FROZEN binary. Exit test met.

### Build warnings (both harmless, noted for the ship build)
- `Hidden import "_cffi_backend" not found!` — modern **bcrypt 5.0.0** ships a Rust extension, not a
  cffi backend, so the speculative import bcrypt's PyInstaller hook adds simply isn't present and
  isn't used. Auth works (bcrypt logins succeed in the frozen binary).
- The passlib hook drags in **all of `passlib.tests.*`** — dead weight, no correctness impact. Trim
  with an `excludes=["passlib.tests"]` in the spec when we want a leaner ship artifact.
- `collect_data_files/collect_dynamic_libs ... 'libpass' is not a package` — expected; here `passlib`
  is installed under its own name, so the `libpass` branch is a harmless skip.

### Freeze TODO before ship (not blockers for the gate)
- Set `console=False` in the spec for the shipped build (console stays on now so recon logs are
  visible); the Electron supervisor captures stdio instead.
- Add `excludes=["passlib.tests", "tkinter"]` (tkinter already excluded) to shrink the artifact.
- Re-freeze per platform for macOS/Linux at Phase E (the runtime is per-OS).
- Watch for **antivirus false-positives** on a bundled Python exe (a general PyInstaller risk).

---

## 2. On-disk storage layout (what we ship / back up)

- Backend: `radicale.storage.multifilesystem`.
- Data dir → `collections/collection-root/` beneath the configured `filesystem_folder`. That
  `collection-root` tree is the unit to ship-as-empty, back up, and migrate across app versions.
- Per-user home is a subfolder (`collection-root/<user>/`); each calendar / address book is a
  collection folder under it; items are individual files inside.

## 3. Config surface to template from app settings

Templated in `server/config.template` (`{PLACEHOLDERS}` filled by the Electron main process at B2):
- `[server] hosts = {HOSTS}` — `0.0.0.0:<port>` for LAN/phone reach, `127.0.0.1:<port>` for
  local-only. Port picked + persisted by the app.
- `[auth] type = htpasswd`, `htpasswd_filename = {USERS_FILE}`, `htpasswd_encryption = bcrypt`.
- `[storage] filesystem_folder = {COLLECTIONS_DIR}`.
- `[rights] type = owner_only` — each account sees only its own collections.
- `[logging] level = info`.

## 4. Auth / htpasswd hash schemes

- `htpasswd_encryption = bcrypt` works end-to-end in the frozen binary (login succeeds).
- Creds are generated with `server/make-user.py`, which calls the **`bcrypt` lib directly** (not
  passlib) to sidestep the passlib↔bcrypt version-detection warning; output is a standard `$2b$…`
  hash Radicale reads fine. The Electron app does the equivalent at B3.
- `auth.delay` defaults to 1s (anti-brute-force); fine for us.

## 5. sync-collection / ctag / etag

- Confirmed against the **frozen binary** this session: `PROPFIND /test/` depth 1 returns
  `(sync-token getctag): 207 Multi-Status`, and REPORT depth 1 returns `(getetag): 207` with the
  gzip payload growing as items are added. Daynizer's incremental sync drives off these and
  round-trips cleanly (create → PUT 201 → REPORT reflects the new etags).

## 6. Windows-specific behavior a bundled Windows build inherits

- **`GROUPS` collections folder auto-disabled** — `file system is not case-sensitive`. Harmless (we
  don't use server-side groups) but it's a real, logged platform difference.
- Storage self-probe on NTFS: `collision free: False` (case-insensitive), **no** trailing-whitespace
  or problematic-char filenames, unicode + softlinks OK, mtime resolution 100 ns. Radicale adapts its
  on-disk encoding to these automatically.
- Storage-location permissions log `owner=UNKNOWN(0) group=UNKNOWN(0) mode=40777` — cosmetic; POSIX
  perms don't map to Windows ACLs.

## 7. PROPPATCH (display name / color) & VALARM/VTODO fidelity

- Carried over from the A2 homelab round-trip (rename/recolor stuck; VALARM + VTODO fields survived).
  **Not re-exercised against the frozen binary this session** beyond the VTODO write — the freeze
  changes packaging, not Radicale's store logic, so no divergence is expected. Flag to re-verify if
  any field/rename issue surfaces once the server is embedded (B2).

---

## 8. Bottom line for Phase B

Bundling is confirmed viable and cheap: one `pyinstaller radicale.spec`, a ~self-contained onedir
under the app's resources, spawned as a child process. No blockers found. Proceed to **B2**
(Electron main-process lifecycle: free-port pick, config+htpasswd generation, health-check +
auto-restart, decouple from the window) behind the server feature flag.
