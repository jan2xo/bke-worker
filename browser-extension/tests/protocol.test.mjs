import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveConnectionState,
  isAllowedControllerUrl,
  isValidWorkerId,
  validateConfig,
} from "../dist/protocol.js";

test("worker id contract matches BKE worker identity", () => {
  assert.equal(isValidWorkerId("worker-a"), true);
  assert.equal(isValidWorkerId("worker-01"), true);
  assert.equal(isValidWorkerId("Worker-A"), false);
  assert.equal(isValidWorkerId("worker_a"), false);
  assert.equal(isValidWorkerId("-worker"), false);
});

test("controller transport is secure by default", () => {
  assert.equal(isAllowedControllerUrl(""), true);
  assert.equal(isAllowedControllerUrl("wss://control.example/bridge"), true);
  assert.equal(isAllowedControllerUrl("ws://127.0.0.1:5084/bridge"), true);
  assert.equal(isAllowedControllerUrl("ws://localhost:5084/bridge"), true);
  assert.equal(isAllowedControllerUrl("ws://192.168.1.5:5084/bridge"), false);
  assert.equal(isAllowedControllerUrl("https://control.example/bridge"), false);
  assert.equal(
    isAllowedControllerUrl("wss://user:pass@control.example/bridge"),
    false,
  );
  assert.equal(
    isAllowedControllerUrl("wss://control.example/bridge#secret"),
    false,
  );
});

test("config validation fails closed", () => {
  assert.deepEqual(validateConfig("WORKER-A", ""), {
    ok: false,
    error: "WORKER_ID_INVALID",
    value: null,
  });

  assert.deepEqual(validateConfig("worker-a", "ws://10.0.0.4/bridge"), {
    ok: false,
    error: "CONTROLLER_URL_INVALID",
    value: null,
  });
});

test("connection state does not imply authenticated transport", () => {
  assert.equal(
    deriveConnectionState({ workerId: "", controllerUrl: "" }),
    "DISABLED",
  );
  assert.equal(
    deriveConnectionState({ workerId: "worker-a", controllerUrl: "" }),
    "UNPAIRED",
  );
  assert.equal(
    deriveConnectionState({
      workerId: "worker-a",
      controllerUrl: "wss://control.example/bridge",
    }),
    "READY_FOR_TRANSPORT",
  );
});
