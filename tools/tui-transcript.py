#!/usr/bin/env python3
"""Drive the TUI in a pty with a scripted key plan and collect its whole log.

tools/tui-capture.py prints only the final screen, and the app's log panel keeps the
last 8 lines — which is not enough to prove a sequence (probe, handoff, key, restart).
This replays the pty stream through the same minimal ANSI emulator and records every
log line the first time it appears on screen, reading the HISTORY panel's own box and
joining the rows the panel wraps.

    tui-transcript.py plan.json
    plan.json: {"cmd": "TV_REMOTE_CONFIG_DIR=$(mktemp -d) ./run.sh --auto",
                "hold": 20, "keys": [[13.0, "n"], [18.0, "3"], [26.0, "\\x1b[A"]]}

Keys are literal bytes (a launch key, letters, arrow escape sequences); `hold` keeps
the app alive after the last one, so batched or debounced work can land. Like
tui-capture.py it ends the run with SIGKILL, so the app's own teardown never runs:
check `adb forward --list` and the TV's monkey JVMs afterwards.
"""
import fcntl
import importlib.util
import json
import os
import pty
import re
import select
import struct
import sys
import termios
import time

SPEC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tui-capture.py")
_spec = importlib.util.spec_from_file_location("tui_capture", SPEC)
tc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tc)

COLS, ROWS = 190, 46
# Box drawing, light and heavy: the panel's own border sits in front of every row.
BOX = re.compile(r"[\u2500-\u257f]")
MARK = re.compile(r"^[✓✗ℹ·⚠⌨]")
KEY_LEN = 20


def decode(s):
    return s.encode().decode("unicode_escape").encode("latin-1")


def panel_bounds(screen):
    """The log panel: (first content row, left, right).

    The HISTORY label is a tab drawn *above* the panel's own box and shares its grid
    row with the other panels, so the box is taken from the border row under the label:
    the nearest ┏ at or left of the label's column, and its ┓.
    """
    text_rows = ["".join(row) for row in screen.grid]
    for i, text in enumerate(text_rows):
        col = text.find("HISTORY")
        if col < 0 or i + 1 >= len(text_rows):
            continue
        if BOX.sub("", text[col:col + 7]) != "HISTORY":
            continue
        border = text_rows[i + 1]
        left = border.rfind("┏", 0, col + 1)
        right = border.find("┓", left) if left >= 0 else -1
        if left >= 0 and right > left:
            return i + 2, left, right
    return None


def panel_rows(screen):
    """The log panel's rows, top (newest) to bottom, with wrapped rows joined back."""
    bounds = panel_bounds(screen)
    if not bounds:
        return []
    top, left, right = bounds
    raw = []
    for i in range(top, len(screen.grid)):
        row = "".join(screen.grid[i])
        if row[left:left + 1] != "┃":  # the panel's own bottom border
            break
        raw.append(BOX.sub("", row[left + 1:right]).strip())

    out = []
    for text in raw:
        if MARK.match(text):
            out.append(text)
        elif text and out:
            # A wrapped tail: the panel breaks the line at its own width, so a full row
            # continues with no space between the halves.
            width = right - left - 1
            if len(out[-1]) >= width - 1:
                out[-1] += text
            else:
                out[-1] += " " + text
    return out


def main():
    plan = json.load(open(sys.argv[1]))
    cmd = plan.get("cmd", "./run.sh --auto")
    hold = float(plan.get("hold", 20))
    keys = [(float(d), decode(p)) for d, p in plan.get("keys", [])]

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(plan.get("cwd", "~/Projects/zapette"))
        os.environ["TERM"] = "xterm-256color"
        os.execv("/bin/bash", ["/bin/bash", "-lc", cmd])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

    screen = tc.Screen(COLS, ROWS)
    seen = {}  # key -> index in order, so a line that grows is updated in place
    order = []
    index = 0
    start = time.time()
    end = max([d for d, _ in keys] + [0]) + hold

    while time.time() - start < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            screen.feed(data)
            for line in reversed(panel_rows(screen)):  # oldest of this frame first
                key = line[:KEY_LEN]
                if key in seen:
                    if order[seen[key]] != line:  # the same line grew a wrapped tail
                        order[seen[key]] = line
                        print(f"[{time.time() - start:6.1f}s]   …{line}", flush=True)
                    continue
                seen[key] = len(order)
                order.append(line)
                print(f"[{time.time() - start:6.1f}s] {line}", flush=True)
        while index < len(keys) and time.time() - start >= keys[index][0]:
            os.write(fd, keys[index][1])
            index += 1

    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
    print("\n===== final screen =====")
    print(screen.dump())


if __name__ == "__main__":
    main()
