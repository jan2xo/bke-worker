import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import net from "node:net";

const baseUrl = process.env.BKE_RELAY_SMOKE_URL || "http://127.0.0.1:8790";
const relayToken = process.env.BKE_WORKER_RELAY_TOKEN || "";
const webhookSecret = process.env.BKE_WORKER_GITHUB_WEBHOOK_SECRET || "";

assert.ok(relayToken, "BKE_WORKER_RELAY_TOKEN required");
assert.ok(webhookSecret, "BKE_WORKER_GITHUB_WEBHOOK_SECRET required");

const url = new URL(baseUrl);
const host = url.hostname;
const port = Number(url.port || 80);
const workerId = "android-worker-a";

function encodeClientText(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = randomBytes(4);
  let header;

  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    throw new Error("smoke frame unexpectedly large");
  }

  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function parseServerFrame(buffer) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (!fin) throw new Error("fragmented server frame not supported in smoke");
  if (masked) throw new Error("server WebSocket frame must not be masked");

  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const high = buffer.readUInt32BE(2);
    const low = buffer.readUInt32BE(6);
    if (high !== 0) throw new Error("server frame too large");
    length = low;
    offset = 10;
  }

  if (buffer.length < offset + length) return null;
  const payload = buffer.subarray(offset, offset + length);
  return {
    opcode,
    payload,
    rest: buffer.subarray(offset + length),
  };
}

class RawWebSocket {
  constructor() {
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
  }

  async connect(pathname) {
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");

    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      this.socket = socket;
      let handshake = Buffer.alloc(0);

      const onError = (error) => reject(error);
      socket.once("error", onError);

      socket.on("connect", () => {
        socket.write(
          [
            `GET ${pathname} HTTP/1.1`,
            `Host: ${host}:${port}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${key}`,
            "Sec-WebSocket-Version: 13",
            `Authorization: Bearer ${relayToken}`,
            "",
            "",
          ].join("\r\n"),
        );
      });

      const onHandshakeData = (chunk) => {
        handshake = Buffer.concat([handshake, chunk]);
        const marker = handshake.indexOf("\r\n\r\n");
        if (marker < 0) return;

        socket.off("data", onHandshakeData);
        socket.removeListener("error", onError);

        const head = handshake.subarray(0, marker).toString("utf8");
        const rest = handshake.subarray(marker + 4);
        assert.match(head, /^HTTP\/1\.1 101\b/m);
        assert.ok(
          head.toLowerCase().includes(
            `sec-websocket-accept: ${expectedAccept.toLowerCase()}`,
          ),
          "WebSocket accept header mismatch",
        );

        this.buffer = Buffer.concat([this.buffer, rest]);
        socket.on("data", (data) => this.onData(data));
        socket.on("error", (error) => this.rejectWaiters(error));
        socket.on("close", () => this.rejectWaiters(new Error("websocket closed")));
        resolve();
      };

      socket.on("data", onHandshakeData);
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  rejectWaiters(error) {
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  drain() {
    while (this.waiters.length > 0) {
      const frame = parseServerFrame(this.buffer);
      if (!frame) return;
      this.buffer = frame.rest;

      if (frame.opcode === 0x8) {
        this.rejectWaiters(new Error("server closed websocket"));
        return;
      }
      if (frame.opcode === 0x9) {
        continue;
      }
      if (frame.opcode !== 0x1) {
        continue;
      }

      const waiter = this.waiters.shift();
      waiter.resolve(frame.payload.toString("utf8"));
    }
  }

  sendText(text) {
    this.socket.write(encodeClientText(text));
  }

  nextText(timeoutMs = 5000) {
    const existing = parseServerFrame(this.buffer);
    if (existing?.opcode === 0x1) {
      this.buffer = existing.rest;
      return Promise.resolve(existing.payload.toString("utf8"));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((item) => item.resolve === wrappedResolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("timed out waiting for WebSocket text frame"));
      }, timeoutMs);

      const wrappedResolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      const wrappedReject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.waiters.push({ resolve: wrappedResolve, reject: wrappedReject });
      this.drain();
    });
  }

  close() {
    this.socket?.destroy();
  }
}

async function postWebhook({ deliveryId, action, sha }) {
  const body = JSON.stringify({
    action,
    number: 13,
    repository: { full_name: "jan2xo/bke-worker" },
    pull_request: {
      number: 13,
      state: "open",
      labels: [{ name: `bke-worker:${workerId}` }],
      head: {
        ref: "test/utm-wss-relay-smoke",
        sha,
      },
    },
    ...(action === "labeled"
      ? { label: { name: `bke-worker:${workerId}` } }
      : {}),
  });
  const signature = createHmac("sha256", webhookSecret).update(body).digest("hex");

  const response = await fetch(new URL("/webhooks/github", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-GitHub-Event": "pull_request",
      "X-GitHub-Delivery": deliveryId,
      "X-Hub-Signature-256": `sha256=${signature}`,
    },
    body,
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

const ws = new RawWebSocket();
try {
  await ws.connect(`/relay/${workerId}`);
  ws.sendText(JSON.stringify({
    protocol: 1,
    type: "register",
    worker_id: workerId,
    session_id: "cloudflare-local-smoke",
  }));

  const first = await postWebhook({
    deliveryId: "cloudflare-smoke-001",
    action: "opened",
    sha: "0123456789abcdef0123456789abcdef01234567",
  });
  assert.equal(first.status, 202);
  assert.equal(first.body.accepted, true);

  const wake = JSON.parse(await ws.nextText());
  assert.deepEqual(Object.keys(wake).sort(), [
    "delivery_id",
    "expected_head_sha",
    "pr_number",
    "protocol",
    "reason",
    "repo",
    "type",
    "worker_id",
  ].sort());
  assert.equal(wake.worker_id, workerId);
  assert.equal(wake.delivery_id, "cloudflare-smoke-001");
  assert.equal(wake.expected_head_sha, "0123456789abcdef0123456789abcdef01234567");

  ws.sendText(JSON.stringify({
    protocol: 1,
    type: "ack",
    worker_id: workerId,
    delivery_id: wake.delivery_id,
    state: "accepted",
  }));
  ws.sendText(JSON.stringify({
    protocol: 1,
    type: "ack",
    worker_id: workerId,
    delivery_id: wake.delivery_id,
    state: "completed",
  }));

  await new Promise((resolve) => setTimeout(resolve, 100));

  const duplicate = await postWebhook({
    deliveryId: "cloudflare-smoke-001",
    action: "opened",
    sha: "0123456789abcdef0123456789abcdef01234567",
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.relay.state, "duplicate");

  const second = await postWebhook({
    deliveryId: "cloudflare-smoke-002",
    action: "synchronize",
    sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.equal(second.status, 202);

  const wake2 = JSON.parse(await ws.nextText());
  assert.equal(wake2.delivery_id, "cloudflare-smoke-002");
  assert.equal(wake2.expected_head_sha, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  ws.sendText(JSON.stringify({
    protocol: 1,
    type: "ack",
    worker_id: workerId,
    delivery_id: wake2.delivery_id,
    state: "completed",
  }));

  console.log("BKE Worker Cloudflare local runtime smoke: PASS");
} finally {
  ws.close();
}
