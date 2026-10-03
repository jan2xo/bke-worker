#!/usr/bin/env python3
import argparse
import asyncio
import hmac
import json
import ssl
from pathlib import Path

import websockets

PROTOCOL = 1
CONTROL_REPO = "jan2xo/bke-worker"


def parse_args():
    p = argparse.ArgumentParser(description="BKE Worker UTM WSS smoke relay")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--cert", required=True)
    p.add_argument("--key", required=True)
    p.add_argument("--token", required=True)
    p.add_argument("--worker-id", default="android-worker-a")
    p.add_argument("--pr", type=int, required=True)
    p.add_argument("--head-sha", required=True)
    p.add_argument("--reason", default="utm_wss_smoke")
    p.add_argument("--delivery-id", default="utm-smoke-001")
    return p.parse_args()


def exact_keys(obj, expected):
    return isinstance(obj, dict) and set(obj.keys()) == set(expected)


def validate_register(raw, worker_id):
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return False
    return (
        exact_keys(obj, ["protocol", "type", "worker_id", "session_id"])
        and obj.get("protocol") == PROTOCOL
        and obj.get("type") == "register"
        and obj.get("worker_id") == worker_id
        and isinstance(obj.get("session_id"), str)
        and 1 <= len(obj["session_id"]) <= 128
    )


def build_wake(args):
    if args.pr <= 0:
        raise SystemExit("--pr must be positive")
    if len(args.head_sha) != 40 or any(c not in "0123456789abcdef" for c in args.head_sha):
        raise SystemExit("--head-sha must be a lowercase 40-character SHA")
    return {
        "protocol": PROTOCOL,
        "type": "wake",
        "worker_id": args.worker_id,
        "repo": CONTROL_REPO,
        "pr_number": args.pr,
        "expected_head_sha": args.head_sha,
        "reason": args.reason,
        "delivery_id": args.delivery_id,
    }


async def run(args):
    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_context.load_cert_chain(args.cert, args.key)
    wake = build_wake(args)

    async def handler(ws):
        auth = ws.request.headers.get("Authorization", "")
        expected = f"Bearer {args.token}"
        if not hmac.compare_digest(auth, expected):
            print("REJECT unauthorized client")
            await ws.close(code=1008, reason="unauthorized")
            return

        print("CONNECTED")
        raw = await asyncio.wait_for(ws.recv(), timeout=15)
        if not validate_register(raw, args.worker_id):
            print("REJECT invalid register:", raw)
            await ws.close(code=1008, reason="invalid register")
            return

        print("REGISTER:", raw)
        payload = json.dumps(wake, separators=(",", ":"))
        await ws.send(payload)
        print("WAKE:", payload)

        async for message in ws:
            print("ACK:", message)

    async with websockets.serve(
        handler,
        args.host,
        args.port,
        ssl=ssl_context,
        max_size=16 * 1024,
        ping_interval=25,
        ping_timeout=20,
    ):
        print(f"BKE UTM RELAY READY wss://{args.host}:{args.port}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(run(parse_args()))
