#!/usr/bin/env python3
"""Drive the TUI in a pty and dump the reconstructed final screen as text.

Text-based "screenshot" for a full-screen TUI: no window, no screen-recording
permission. Feeds a scripted key sequence, then replays the raw pty stream
through a minimal ANSI emulator (CUP, ED, EL, SGR ignored) and prints the grid.

    tui-capture.py --wait 8 --send l --wait 3 --send $'\\x1b' --wait 3

Keys are sent as literal bytes; $'\\x1b' style escapes are NOT interpreted by the
shell here, so pass escaped bytes directly (e.g. --send '\\x1b').
"""
import argparse
import codecs
import fcntl
import os
import pty
import select
import struct
import sys
import termios
import time

ESC = 0x1B

# The repository this script lives in, so the default stays correct whatever the
# checkout directory is called (or wherever it was cloned).
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--cmd", default="./run.sh --auto")
    p.add_argument("--cwd", default=REPO)
    p.add_argument("--cols", type=int, default=190)
    p.add_argument("--rows", type=int, default=46)
    p.add_argument("--wait", type=float, default=0.0, help="wait this long before the next --send")
    p.add_argument(
        "--hold",
        type=float,
        default=4.0,
        help="keep watching this long after the last --send, so batched work can land",
    )
    p.add_argument(
        "--send",
        action="append",
        default=[],
        help="bytes to send; a 'SECONDS:' prefix overrides the wait for that one send",
    )
    return p.parse_args()


def send_delay(value, default):
    """A --send value may carry its own delay: '0.3:hello'."""
    head, sep, rest = value.partition(":")
    if sep and rest and head.replace(".", "", 1).isdigit():
        return float(head), rest
    return default, value


def decode(s):
    return s.encode().decode("unicode_escape").encode("latin-1")


class Screen:
    def __init__(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.reset()

    def reset(self):
        self.grid = [[" "] * self.cols for _ in range(self.rows)]
        self.r = self.c = 0
        self.pending = ""
        self.saved = (0, 0)
        # box-drawing characters are multi-byte and get split across reads too
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def put(self, ch):
        if self.r < self.rows and self.c < self.cols:
            self.grid[self.r][self.c] = ch
        self.c += 1
        if self.c >= self.cols:
            self.c = 0
            self.r = min(self.rows - 1, self.r + 1)

    def feed(self, data):
        # A read can split an escape sequence in half; hold the tail until the
        # rest arrives rather than printing the remainder as text.
        text = self.pending + self.decoder.decode(data)
        self.pending = ""
        i = 0
        while i < len(text):
            ch = text[i]
            if ch == "\x1b":
                res = self.escape(text, i)
                if res == "incomplete":
                    # an escape sequence cut in half by the read boundary: keep
                    # the tail and replay it with the next chunk
                    self.pending = text[i:]
                    return
                i = res
                continue
            if ch == "\n":
                self.r = min(self.rows - 1, self.r + 1)
                self.c = 0
                i += 1
                continue
            if ch == "\r":
                self.c = 0
                i += 1
                continue
            if ch == "\b":
                self.c = max(0, self.c - 1)
                i += 1
                continue
            if ch >= " ":
                self.put(ch)
            i += 1 

    def escape(self, text, i):
        if i + 1 >= len(text):
            return "incomplete"
        nxt = text[i + 1]
        if nxt == "[":  # CSI
            j = i + 2
            while j < len(text) and not ("@" <= text[j] <= "~"):
                j += 1
            if j >= len(text):
                return "incomplete"
            final = text[j]
            params = text[i + 2 : j]
            nums = [int(p) for p in params.replace("?", "").split(";") if p.isdigit()]
            if final in "Hf":
                self.r = (nums[0] - 1) if nums else 0
                self.c = (nums[1] - 1) if len(nums) > 1 else 0
            elif final == "J":
                mode = nums[0] if nums else 0
                if mode == 2:
                    self.reset()
                elif mode == 0:
                    for c in range(self.c, self.cols):
                        self.grid[self.r][c] = " "
                    for r in range(self.r + 1, self.rows):
                        self.grid[r] = [" "] * self.cols
            elif final == "K":
                mode = nums[0] if nums else 0
                if mode == 0:
                    for c in range(self.c, self.cols):
                        self.grid[self.r][c] = " "
                elif mode == 2:
                    self.grid[self.r] = [" "] * self.cols
            return j + 1
        if nxt == "]":  # OSC ... BEL or ST
            j = i + 2
            while j < len(text) and text[j] not in ("\x07",):
                if text[j] == "\x1b":
                    break
                j += 1
            return min(len(text), j + 2)
        if nxt in "78":  # save/restore cursor
            if nxt == "7":
                self.saved = (self.r, self.c)
            else:
                self.r, self.c = getattr(self, "saved", (0, 0))
            return i + 2
        if nxt == "M":
            self.r = max(0, self.r - 1)
            return i + 2
        if nxt == "D":
            self.r = min(self.rows - 1, self.r + 1)
            return i + 2
        if nxt == "E":
            self.r = min(self.rows - 1, self.r + 1)
            self.c = 0
            return i + 2
        if nxt == "(":
            return i + 3
        return i + 2

    def dump(self):
        lines = ["".join(row).rstrip() for row in self.grid]
        while lines and not lines[-1]:
            lines.pop()
        return "\n".join(lines)


def main():
    args = parse_args()
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(args.cwd)
        os.environ["TERM"] = "xterm-256color"
        os.execv("/bin/bash", ["/bin/bash", "-lc", args.cmd])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", args.rows, args.cols, 0, 0))

    screen = Screen(args.cols, args.rows)

    # Each --send fires `--wait` seconds after the previous one, so a sequence of
    # waits gives every frame time to land before the next key. --hold keeps the
    # app alive afterwards: a remote that batches its device calls (or waits for a
    # typing pause before syncing) has work still in flight at the last keystroke,
    # and killing it there would hide exactly what the run was meant to show.
    plan = []
    at = args.wait
    for s in args.send:
        delay, payload = send_delay(s, args.wait)
        at += delay
        plan.append((at, decode(payload)))

    start = time.time()
    idx = 0
    while time.time() - start < at + args.hold:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            screen.feed(data)
        while idx < len(plan) and time.time() - start >= plan[idx][0]:
            os.write(fd, plan[idx][1])
            idx += 1
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
    print(screen.dump())


if __name__ == "__main__":
    main()
