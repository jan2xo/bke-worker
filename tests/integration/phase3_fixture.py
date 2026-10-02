#!/usr/bin/env python3
import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

state_lock = threading.Lock()
state = {
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
        state["prompts"].clear()
        state["busy"] = False
        state["auth_required"] = False
        state["show_project"] = True
        state["show_conversation"] = True
        state["show_composer"] = True
        state["project_failures_remaining"] = 0
        state["block_send"] = False


def html_page(body):
    return (
        "<!doctype html><html><head>"
        "<meta charset='utf-8'><title>BKE Fixture</title>"
        f"</head><body>{body}</body></html>"
    ).encode()


def client_state_sync_script():
    return """
<script>
async function syncFixtureState() {
  try {
    const response = await fetch('/admin/state', {cache: 'no-store'});
    const current = await response.json();
    const path = window.location.pathname;

    let login = document.getElementById('bke-fixture-login');
    if (current.auth_required && !login) {
      login = document.createElement('button');
      login.id = 'bke-fixture-login';
      login.type = 'button';
      login.textContent = 'Log in';
      document.body.appendChild(login);
    } else if (!current.auth_required && login) {
      login.remove();
    }

    const inConversation =
      path.endsWith('/projects/bke-worker/worker-engineering');
    let stop = document.getElementById('bke-fixture-stop');
    if (current.busy && inConversation && !stop) {
      stop = document.createElement('button');
      stop.id = 'bke-fixture-stop';
      stop.type = 'button';
      stop.textContent = 'Stop generating';
      document.body.appendChild(stop);
    } else if ((!current.busy || !inConversation) && stop) {
      stop.remove();
    }

    const composer = document.getElementById('bke-fixture-composer');
    if (composer) {
      composer.hidden = !current.show_composer;
    }

    if (!current.show_project && path.includes('/projects/bke-worker')) {
      window.location.replace('/projects');
      return;
    }

    if (!current.show_conversation && inConversation) {
      window.location.replace('/projects/bke-worker');
    }
  } catch (_) {
    // Normal browser assertions fail if controlled state cannot be observed.
  }
}
setInterval(syncFixtureState, 50);
syncFixtureState();
</script>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "BKEGitHubNativeFixture/1.0"

    def log_message(self, fmt, *args):
        print(
            f"fixture: {self.address_string()} {fmt % args}",
            flush=True,
        )

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
        self.send_header(
            "Content-Type",
            "text/html; charset=utf-8",
        )
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
            content = (
                "<button id='bke-fixture-login' type='button'>"
                "Log in</button>"
            )
        return html_page(
            f"{content}{client_state_sync_script()}"
        )

    def record_prompt(self, instruction):
        with state_lock:
            state["prompts"].append(instruction)

    def set_flag(self, name, value):
        with state_lock:
            state[name] = value

        if name in {
            "busy",
            "auth_required",
            "show_project",
            "show_conversation",
            "show_composer",
        }:
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

        if path in ("/chatgpt", "/chatgpt/"):
            self.send_html(
                200,
                self.chat_body(
                    "<a href='/projects'>Projects</a>"
                ),
            )
            return

        if path == "/projects":
            current = snapshot()
            show_project = current["show_project"]
            if current["project_failures_remaining"] > 0:
                show_project = False
                with state_lock:
                    state["project_failures_remaining"] -= 1
            project = (
                "<a href='/projects/bke-worker'>BKE Worker</a>"
                if show_project
                else ""
            )
            self.send_html(
                200,
                self.chat_body(
                    f"<a href='/projects'>Projects</a>{project}"
                ),
            )
            return

        if path == "/projects/bke-worker":
            current = snapshot()
            conversation = (
                "<a href='/projects/bke-worker/worker-engineering'>"
                "Worker Engineering</a>"
                if current["show_conversation"]
                else ""
            )
            self.send_html(
                200,
                self.chat_body(
                    f"<a href='/projects'>Projects</a>{conversation}"
                ),
            )
            return

        if path == "/projects/bke-worker/worker-engineering":
            current = snapshot()
            stop = (
                "<button id='bke-fixture-stop' type='button'>"
                "Stop generating</button>"
                if current["busy"]
                else ""
            )
            hidden = (
                " hidden"
                if not current["show_composer"]
                else ""
            )

            if current["block_send"]:
                composer = f"""
<div id='bke-fixture-composer'{hidden}>
<form method='post' action='/admin/prompts-block'>
<textarea name='instruction' aria-label='Message'></textarea>
<button type='submit' aria-label='Send message'>Send</button>
</form>
</div>
"""
            else:
                composer = f"""
<div id='bke-fixture-composer'{hidden}>
<textarea aria-label='Message'></textarea>
<button type='button' aria-label='Send message' onclick='sendPrompt()'>Send</button>
</div>
<script>
async function sendPrompt() {{
  const box = document.querySelector('#bke-fixture-composer textarea');
  await fetch('/admin/prompts', {{
    method: 'POST',
    headers: {{'Content-Type': 'application/json'}},
    body: JSON.stringify({{instruction: box.value}})
  }});
  box.value = '';
}}
</script>
"""

            self.send_html(
                200,
                self.chat_body(
                    f"<a href='/projects'>Projects</a>{composer}{stop}"
                ),
            )
            return

        self.send_json(
            404,
            {"error": "NOT_FOUND", "path": path},
        )

    def do_POST(self):
        path = urlparse(self.path).path

        if path == "/admin/prompts":
            payload = self.read_json()
            self.record_prompt(
                str(payload.get("instruction", ""))
            )
            self.send_json(200, {"accepted": True})
            return

        if path == "/admin/prompts-block":
            raw = self.read_body().decode()
            fields = parse_qs(raw)
            self.record_prompt(
                fields.get("instruction", [""])[0]
            )
            time.sleep(30)
            try:
                self.send_html(
                    200,
                    self.chat_body(
                        "<p>blocked send released</p>"
                    ),
                )
            except (
                BrokenPipeError,
                ConnectionResetError,
            ):
                pass
            return

        if path == "/admin/reset":
            reset_state()
            self.send_json(200, snapshot())
            return

        flag_routes = {
            "/admin/busy/on": ("busy", True),
            "/admin/busy/off": ("busy", False),
            "/admin/auth/on": ("auth_required", True),
            "/admin/auth/off": ("auth_required", False),
            "/admin/project/on": ("show_project", True),
            "/admin/project/off": ("show_project", False),
            "/admin/conversation/on":
                ("show_conversation", True),
            "/admin/conversation/off":
                ("show_conversation", False),
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

        self.send_json(
            404,
            {"error": "NOT_FOUND", "path": path},
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=5091)
    args = parser.parse_args()
    server = ThreadingHTTPServer(
        ("127.0.0.1", args.port),
        Handler,
    )
    print(
        "BKE GitHub-native fixture listening on "
        f"127.0.0.1:{args.port}",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
