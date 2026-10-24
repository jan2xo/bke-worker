#!/usr/bin/env python3
"""F1-03: Fail-closed macOS Google Chrome publisher pin (read-only).

Only an owner-chosen exact installed application is checked. Nothing is
installed, launched, re-signed or allowed to exercise worker authority.
The codesign runner is injectable for offline negative tests; the CLI never
accepts a runner, alternate codesign path, team override or bypass switch.
"""
from __future__ import annotations
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

TEAM_ID = "EQHXZ8M8AV"
IDENTIFIER = "com.google.Chrome"
REQUIREMENT = (
    'anchor apple generic and identifier "com.google.Chrome" '
    'and certificate leaf[subject.OU] = "EQHXZ8M8AV"'
)
CODESIGN = "/usr/bin/codesign"
PASS = "BKE_CHROME_GOOGLE_SIGNER_VERIFIED"
class SignerBlocked(Exception):
    pass

def _blocked():
    raise SignerBlocked("CHROME_PUBLISHER_NOT_VERIFIED")

def _parse_display(output: str, executable: str) -> bool:
    # The display output is defense in depth, NOT signature authentication.
    # The separately evaluated -R requirement is authoritative.
    fields = {}
    for line in output.splitlines():
        match = re.fullmatch(r"(Identifier|TeamIdentifier|Executable)=(.*)", line.strip())
        if match:
            if match.group(1) in fields:
                return False
            fields[match.group(1)] = match.group(2)
    return (fields.get("Identifier") == IDENTIFIER
            and fields.get("TeamIdentifier") == TEAM_ID
            and fields.get("Executable") == executable)

def verify_google_chrome_publisher(executable: str, *, runner=subprocess.run) -> bool:
    if not isinstance(executable, str) or not executable.startswith("/") or "\0" in executable:
        _blocked()
    path = Path(executable)
    if (os.path.normpath(executable) != executable or
        path.name != "Google Chrome" or
        path.parent.name != "MacOS" or
        path.parent.parent.name != "Contents" or
        path.parent.parent.parent.name != "Google Chrome.app"):
        _blocked()
    app = path.parent.parent.parent
    # Preserve the identity of the exact binary the owner script selected.
    # No symlink may redirect ANY of the four bundle components.
    for component, expected_dir in (
        (app, True), (path.parent.parent, True),
        (path.parent, True), (path, False),
    ):
        try:
            mode = component.lstat().st_mode
            if stat.S_ISLNK(mode) or (
                not stat.S_ISDIR(mode) if expected_dir else not stat.S_ISREG(mode)
            ):
                _blocked()
        except (OSError, ValueError):
            _blocked()
    if os.path.realpath(executable) != executable or os.path.realpath(str(app)) != str(app):
        _blocked()

    # Fail closed against a self-signed clone or arbitrary Developer ID:
    # certificate chain must anchor to Apple, bundle identifier must be exact,
    # and the signer must be Google's independently pinned Team ID.
    required = "=" + REQUIREMENT
    commands = (
        (CODESIGN, "--verify", "--deep", "--strict", "--verbose=2", "-R", required, str(app)),
        (CODESIGN, "--verify", "--strict", "--verbose=2", "-R", required, executable),
        (CODESIGN, "--display", "--verbose=4", executable),
    )
    try:
        results = [runner(list(command), check=False, capture_output=True,
                          text=True, timeout=30) for command in commands]
        if any(result.returncode != 0 for result in results):
            _blocked()
        detail = results[-1].stderr + "\n" + results[-1].stdout
        if not _parse_display(detail, executable):
            _blocked()
    except (OSError, ValueError, subprocess.SubprocessError):
        _blocked()
    return True

def main(args: list[str]) -> int:
    if len(args) != 1 or sys.platform != "darwin":
        print("BKE_CHROME_SIGNER=BLOCKED", file=sys.stderr)
        return 2
    try:
        verify_google_chrome_publisher(args[0])
    except SignerBlocked:
        print("BKE_CHROME_SIGNER=BLOCKED", file=sys.stderr)
        return 2
    print(PASS)
    return 0

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
