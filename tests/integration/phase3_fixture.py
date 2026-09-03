#!/usr/bin/env python3
import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

GATE_1 = "11111111-1111-1111-1111-111111111111"
GATE_2 = "22222222-2222-2222-2222-222222222222"
TARGET_BLOCK = "33333333-3333-3333-3333-333333333333"

state_lock = threading.Lock()
state = {
    "gates": [
        {"id": GATE_1, "text": "Phase 3 gate one", "checked": False},
        {"id": GATE_2, "text": "Phase 3 gate two", "checked": False},
    ],
    "prompts": [],
    "busy": False,
    "auth_required": False,
    "show_project": True,
    "show_conversation": True,
    "show_composer": True,
    "project_failures_remaining": 0,
    "block_send": False,
}


def snapshot():
    with state_lock:
        return json.loads(json.dumps(state))


def reset_state():
    with state_lock:
        for gate in state["gates"]:
            gate["checked"] = False
        state["prompts"].clear()
        state["busy"] = False
        state["auth_required"] = False
        state["show_project"] = True
        state["show_conversation"] = True
        state["show_composer"] = True
        state["project_failures_remaining"] = 0
        state["block_send"] = False


def html_page(body):
    return f"<!doctype html><html><head><meta charset='utf-8'><title>BKE Fixture</title></head><body>{body}</body></html>".encode()


def notion_target_block():
    return {
        "object": "block",
        "id": TARGET_BLOCK,
        "type": "callout",
        "has_children": False,
        "callout": {
            "rich_text": [{
                "plain_text": "[BKE WORKER TARGET]\nPROJECT=BKE Worker\nCHAT=Worker Engineering\nOVERRIDE_URL="
            }],
        },
    }


def turn_state_sync_script():
    # Real ChatGPT mutates the current conversation DOM when generation starts/stops.
    # The controlled fixture must do the same now that the live adapter deliberately
    # keeps the already-resolved conversation open instead of navigating on every wake.
    return """
<script>
async function syncTurnState() {
  try {
    const response = await fetch('/admin/state', {cache: 'no-store'});
    const current = await response.json();
    let stop = document.getElementById('bke-fixture-stop');
    if (current.busy && !stop) {
      stop = document.createElement('button');
      stop.id = 'bke-fixture-stop';
      stop.type = 'button';
      stop.textContent = 'Stop generating';
      document.body.appendChild(stop);
    } else if (!current.busy && stop) {
      stop.remove();
    }
  } catch (_) {
    // The fixture fails through normal browser assertions if state cannot be read.
  }
}
setInterval(syncTurnState, 50);
syncTurnState();
</script>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "BKEPhase3Fixture/1.3"

    def log_message(self, fmt, *args):
        print(f"fixture: {self.address_string()} {fmt % args}", flush=True)

    def send_json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_html(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        return self.rfile.read(length) if length else b""

    def read_json(self):
        raw = self.read_body()
        return json.loads(raw.decode() or "{}")

    def chat_body(self, content):
        current = snapshot()
        if current["auth_required"]:
            return html_page("<button type='button'>Log in</button>")
        return html_page(content)

    def record_prompt(self, instruction):
        with state_lock:
            state["prompts"].append(instruction)

    def set_flag(self, name, value):
        with state_lock:
            state[name] = value

        # Busy is represented by live DOM state. Give the already-open controlled
        # conversation enough time to observe the state transition before the admin
        # call returns to the test driver, making busy/on and busy/off deterministic.
        if name == "busy":
            time.sleep(0.25)

        self.send_json(200, snapshot())

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/fixture-health":
            self.send_json(200, {"status": "ok"})
            return

        if path == "/admin/state":
            self.send_json(200, snapshot())
            return

        if path.startswith("/v1/blocks/") and path.endswith("/children"):
            current = snapshot()
            results = [notion_target_block()]
            for gate in current["gates"]:
                results.append({
                    "object": "block",
                    "id": gate["id"],
                    "type": "to_do",
                    "has_children": False,
                    "to_do": {
                        "checked": gate["checked"],
                        "rich_text": [{"plain_text": gate["text"]}],
                    },
                })
            self.send_json(200, {"results": results, "has_more": False, "next_cursor": None})
            return

        if path in ("/chatgpt", "/chatgpt/"):
            self.send_html(200, self.chat_body("<a href='/projects'>Projects</a>"))
            return

        if path == "/projects":
            current = snapshot()
            show_project = current["show_project"]
            if current["project_failures_remaining"] > 0:
                show_project = False
                with state_lock:
                    state["project_failures_remaining"] -= 1
            project = "<a href='/projects/bke-worker'>BKE Worker</a>" if show_project else ""
            self.send_html(200, self.chat_body(f"<a href='/projects'>Projects</a>{project}"))
            return

        if path == "/projects/bke-worker":
            current = snapshot()
            conversation = (
                "<a href='/projects/bke-worker/worker-engineering'>Worker Engineering</a>"
                if current["show_conversation"] else ""
            )
            self.send_html(200, self.chat_body(f"<a href='/projects'>Projects</a>{conversation}"))
            return

        if path == "/projects/bke-worker/worker-engineering":
            current = snapshot()
            stop = "<button id='bke-fixture-stop' type='button'>Stop generating</button>" if current["busy"] else ""
            sync = turn_state_sync_script()
            if not current["show_composer"]:
                self.send_html(200, self.chat_body(f"<a href='/projects'>Projects</a>{stop}{sync}"))
                return
            if current["block_send"]:
                body = f"""
<a href='/projects'>Projects</a>
<form method='post' action='/admin/prompts-block'>
<textarea name='instruction' aria-label='Message'></textarea>
<button type='submit' aria-label='Send message'>Send</button>
</form>
{stop}
{sync}
"""
            else:
                body = f"""
<a href='/projects'>Projects</a>
<textarea aria-label='Message'></textarea>
<button type='button' aria-label='Send message' onclick='sendPrompt()'>Send</button>
{stop}
<script>
async function sendPrompt() {{
  const box = document.querySelector('textarea');
  await fetch('/admin/prompts', {{
    method: 'POST',
    headers: {{'Content-Type': 'application/json'}},
    body: JSON.stringify({{instruction: box.value}})
  }});
  box.value = '';
}}
</script>
{sync}
"""
            self.send_html(200, self.chat_body(body))
            return

        self.send_json(404, {"error": "NOT_FOUND", "path": path})

    def do_POST(self):
        path = urlparse(self.path).path

        if path == "/admin/prompts":
            payload = self.read_json()
            self.record_prompt(str(payload.get("instruction", "")))
            self.send_json(200, {"accepted": True})
            return

        if path == "/admin/prompts-block":
            raw = self.read_body().decode()
            fields = parse_qs(raw)
            self.record_prompt(fields.get("instruction", [""])[0])
            time.sleep(30)
            try:
                self.send_html(200, self.chat_body("<p>blocked send released</p>"))
            except (BrokenPipeError, ConnectionResetError):
                pass
            return

        if path == "/admin/reset":
            reset_state()
            self.send_json(200, snapshot())
            return

        if path == "/admin/gates/1/check":
            with state_lock:
                state["gates"][0]["checked"] = True
            self.send_json(200, snapshot())
            return

        if path == "/admin/gates/all/check":
            with state_lock:
                for gate in state["gates"]:
                    gate["checked"] = True
            self.send_json(200, snapshot())
            return

        flag_routes = {
            "/admin/busy/on": ("busy", True),
            "/admin/busy/off": ("busy", False),
            "/admin/auth/on": ("auth_required", True),
            "/admin/auth/off": ("auth_required", False),
            "/admin/project/on": ("show_project", True),
            "/admin/project/off": ("show_project", False),
            "/admin/conversation/on": ("show_conversation", True),
            "/admin/conversation/off": ("show_conversation", False),
            "/admin/composer/on": ("show_composer", True),
            "/admin/composer/off": ("show_composer", False),
            "/admin/block-send/on": ("block_send", True),
            "/admin/block-send/off": ("block_send", False),
        }
        if path in flag_routes:
            name, value = flag_routes[path]
            self.set_flag(name, value)
            return

        if path == "/admin/project/fail-once":
            with state_lock:
                state["project_failures_remaining"] = 1
            self.send_json(200, snapshot())
            return

        self.send_json(404, {"error": "NOT_FOUND", "path": path})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5091)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"BKE Phase 3 fixture listening on 127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
