# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec to freeze Radicale into a standalone Daynizer sync server.
#
# Build (from this folder, inside the venv):
#     pyinstaller radicale.spec
# Output: dist/daynizer-radicale/daynizer-radicale(.exe)  (onedir)
#
# Why the collect_all / collect_submodules dance:
#   Radicale loads its auth / storage / rights / web backends by DOTTED NAME at
#   runtime (config values like `auth = htpasswd`), so PyInstaller's static
#   analysis can't see them and would ship a binary that dies with
#   "ModuleNotFoundError: radicale.auth.htpasswd" the moment a request arrives.
#   Pulling the whole backend subpackages in as hidden imports fixes that.
#   Radicale also ships data files (the built-in web UI), and the hashing libs
#   (passlib / libpass / bcrypt) have data + native bits -- collect_all grabs
#   data + binaries + hidden imports. Radicale 3.8 depends on `libpass` (a
#   passlib fork) for htpasswd, so both names are tried; missing ones are skipped.

from PyInstaller.utils.hooks import collect_all, collect_submodules

datas, binaries, hiddenimports = [], [], []

for pkg in ("radicale", "passlib", "libpass", "bcrypt", "vobject", "defusedxml"):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception as exc:  # package not installed under this name -- skip
        print(f"[radicale.spec] collect_all({pkg!r}) skipped: {exc}")

# Runtime-selected backends -- make sure every option is bundled, not just the
# defaults, so switching config values later never needs a rebuild.
for pkg in ("radicale.auth", "radicale.storage", "radicale.rights", "radicale.web"):
    try:
        hiddenimports += collect_submodules(pkg)
    except Exception as exc:
        print(f"[radicale.spec] collect_submodules({pkg!r}) skipped: {exc}")

a = Analysis(
    ["radicale_entry.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Radicale is headless; drop the GUI toolkit. passlib.tests is pulled in by the
    # passlib hook but is test-only bloat — exclude it to shrink the artifact.
    excludes=["tkinter", "passlib.tests"],
    noarchive=False,
)

pyz = PYZ(a.pure)

# onedir build: a lean launcher exe + a folder of support files. Easier to
# debug and faster to start than onefile (no per-launch temp extraction), and it
# ships fine inside the Electron app's resources. Switch to onefile later if a
# single artifact is preferred.
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="daynizer-radicale",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # No console window: the Electron main process spawns this with windowsHide
    # and pipes its stdout/stderr into the app log, so a visible console would just
    # be a stray black window on every server start. (Was True during recon.)
    console=False,
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="daynizer-radicale",
)
