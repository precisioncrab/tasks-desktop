#!/usr/bin/env python3
"""Frozen entry point for the bundled Daynizer sync server.

This is a thin wrapper around Radicale's console entry so PyInstaller has a
concrete script to analyze. At runtime it behaves exactly like the `radicale`
command: all CLI args (e.g. `--config <path>`) are passed straight through, so
the Electron main process can spawn it the same way it would the real binary.

    daynizer-radicale --config <generated-config>
"""
import sys

from radicale.__main__ import run

if __name__ == "__main__":
    # Radicale reads sys.argv itself; nothing to translate.
    sys.exit(run())
