#!/usr/bin/env python3
"""Enter mobile SDK credentials locally without placing them in chat or shell history."""

from getpass import getpass
from pathlib import Path
import re


def value(prompt, hidden=False, default=""):
    entered = getpass(prompt) if hidden else input(prompt)
    entered = entered.strip() or default
    if not entered or any(ord(c) < 32 or c in '\\"' for c in entered):
        raise SystemExit("Missing or invalid value. No credentials were written.")
    return entered


config = Path(__file__).resolve().parents[1] / "local.properties"
settings = {
    "INDOORATLAS_API_KEY": value("IndoorAtlas mobile SDK key (hidden): ", hidden=True),
    "INDOORATLAS_API_SECRET": value("IndoorAtlas mobile SDK secret (hidden): ", hidden=True),
    "INDOORATLAS_VENUE_ID": value(
        "Venue ID [0d3ece20-da98-11f1-95cb-e11cd22c6739]: ",
        default="0d3ece20-da98-11f1-95cb-e11cd22c6739",
    ),
    "INDOORATLAS_ROOM221_POI_ID": value(
        "Room 221 POI ID [e8679fc0-da9a-11f1-b91e-6591398611dd]: ",
        default="e8679fc0-da9a-11f1-b91e-6591398611dd",
    ),
}
existing = config.read_text() if config.exists() else ""
for key, entry in settings.items():
    pattern = re.compile(rf"^{re.escape(key)}\s*[=:].*$", re.MULTILINE)
    if pattern.search(existing):
        existing = pattern.sub(lambda _: f"{key}={entry}", existing)
    else:
        existing = existing.rstrip() + f"\n{key}={entry}\n"
config.write_text(existing.lstrip("\n"))
config.chmod(0o600)
print("Saved SDK configuration to ignored android/local.properties. Values were not printed.")
