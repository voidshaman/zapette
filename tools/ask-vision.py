#!/usr/bin/env python3
"""Send the TUI screenshot to opencode-go's deepseek-v4-flash-vision-exp for a UI critique."""
import base64
import json
import os
import re
import sys
import urllib.request

ENV_PATH = os.path.expanduser("~/.hermes/.env")
BASE_URL = "https://opencode.ai/zen/go/v1/chat/completions"
MODEL = "deepseek-v4-flash-vision-exp"
IMG = sys.argv[1] if len(sys.argv) > 1 else "/tmp/tv-ui-small.png"
PROMPT_FILE = sys.argv[2] if len(sys.argv) > 2 else None


def api_key():
    key = os.environ.get("OPENCODE_GO_API_KEY")
    if key:
        return key
    with open(ENV_PATH) as fh:
        for line in fh:
            m = re.match(r"\s*(?:export\s+)?OPENCODE_GO_API_KEY\s*=\s*(.+)\s*$", line)
            if m:
                return m.group(1).strip().strip("'\"")
    raise SystemExit("OPENCODE_GO_API_KEY not found")


PROMPT = """You are reviewing a screenshot of a terminal (TUI) application I built. It is a remote
control for an Android TV over ADB, written with OpenTUI. The intended layout is:

  - top: a header bar with connection info
  - left column: a vertical volume bar with - and + buttons
  - middle column: a D-pad (arrow keys + OK)
  - right column: a text input bar, and BELOW it a module for switching send mode between
    "Instantané" (send each character immediately) and "Bloc" (send the whole string at once)

Please report, concretely and in this order:
1. What you can actually see in the image (so I can confirm the app rendered and is legible).
2. Whether the layout matches the intended structure, and any misalignment, clipping, overflow,
   wasted space or contrast problem you can see.
3. Specific, actionable improvements to make it look cleaner and more modern.

Be blunt and specific; mention exact locations in the image. Do not be encouraging for its own sake."""


def main():
    prompt = PROMPT
    if PROMPT_FILE:
        with open(PROMPT_FILE) as fh:
            prompt = fh.read()
    with open(IMG, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode()
    body = {
        "model": MODEL,
        "max_tokens": 16000,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                ],
            }
        ],
    }
    req = urllib.request.Request(
        BASE_URL,
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key()}",
            # The default Python-urllib UA trips Cloudflare error 1010 on this host.
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Accept": "application/json",
            # OpenCode's relay routes on this opaque per-conversation id.
            "x-opencode-session": os.environ.get("OPENCODE_SESSION") or "hermes-tv-remote-tui",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()[:1500]}")
        raise SystemExit(1)
    msg = data["choices"][0]["message"]
    text = msg.get("content") or ""
    if not text.strip():
        # Reasoning models can spend the whole budget in the reasoning channel.
        text = msg.get("reasoning_content") or msg.get("reasoning") or "(empty response)"
    print("=" * 72)
    print(f"MODEL: {data.get('model', MODEL)}   (image: {IMG})")
    print("=" * 72)
    print(text)
    usage = data.get("usage") or {}
    if usage:
        print("\n-- usage:", json.dumps(usage))


if __name__ == "__main__":
    main()
