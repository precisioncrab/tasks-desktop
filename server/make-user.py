#!/usr/bin/env python3
"""Create/append a bcrypt htpasswd entry for the bundled Radicale server.

Cross-platform (no apache2-utils needed on Windows). Uses the `bcrypt` library
directly rather than passlib, so it doesn't depend on passlib<->bcrypt version
quirks (passlib 1.7.4 + bcrypt >=4.1 logs a noisy "error reading bcrypt version"
warning). The resulting `$2b$...` hash is standard bcrypt and is read fine by
Radicale's htpasswd auth (htpasswd_encryption = bcrypt).

The Electron main process will do the equivalent at runtime when it generates
the sync account (Phase B3); this script is for the manual recon/test loop.

Usage:
    py make-user.py <users-file> <username> <password>

Example:
    py make-user.py %USERPROFILE%\\daynizer-radicale\\users test s3cret
"""
import sys
from pathlib import Path

import bcrypt


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: make-user.py <users-file> <username> <password>", file=sys.stderr)
        return 2
    users_file, username, password = sys.argv[1], sys.argv[2], sys.argv[3]
    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("ascii")
    entry = f"{username}:{hashed}\n"
    path = Path(users_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(entry)
    print(f"wrote user '{username}' to {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
