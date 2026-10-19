// WebExtension-origin, per-profile P-256 device identity. SOURCE-ONLY signing
// primitive, NOT an authenticated connection, worker pairing or PR lease.
// The exported signer MUST only be called by a separately authenticated native
// messaging / controller adapter. Never expose it via runtime.onMessage.
import { isValidWorkerId } from "./protocol.js";

export const DEVICE_CHALLENGE_AUDIENCE =
  "bke-command-center/preproduction/device-key-possession/v1";
const DB_NAME = "bke-worker-private-device-identity-v1";
const DB_VERSION = 1;
const STORE = "identity";
const RECORD = "active";
const SHA = /^[0-9a-f]{64}$/;
const INSTALL = /^[1-9][0-9]{0,19}$/;
const B64 = /^[A-Za-z0-9_-]{43}$/;
const LIMIT = 100;
const utf8 = new TextEncoder();
export const DEVICE_IDENTITY_STATES = Object.freeze({
  NOT_PROVISIONED: "NOT_PROVISIONED",
  PROVISIONED: "PROVISIONED",
  BLOCKED: "BLOCKED",
} as const);
type P256PublicKey = { crv: "P-256"; kty: "EC"; x: string; y: string };
type UsedChallenge = { nonce: string; expires_at_ms: number };
type IdentityRecord = {
  schema: 1;
  worker_id: string;
  public_key: P256PublicKey;
  private_key: CryptoKey;
  used: UsedChallenge[];
};
export type DeviceChallenge = {
  installation_id: string;
  worker_id: string;
  proposal_sha256: string;
  subject_sha256: string;
  nonce: string;
  expires_at_ms: number;
};
export type IdentitySummary = {
  state: "NOT_PROVISIONED" | "PROVISIONED" | "BLOCKED";
  code?: string;
  worker_id?: string;
  public_key_sha256?: string;
};
type PublicIdentity = {
  state: "READY";
  worker_id: string;
  public_key: P256PublicKey;
  public_key_sha256: string;
};
type Block = { state: "BLOCKED"; code: string };
type Signed = { state: "SIGNED"; device_signature: string };
type Tx = {
  get(): Promise<unknown>;
  put(value: IdentityRecord): Promise<void>;
};
export type IdentityStore = { atomic<T>(f: (tx: Tx) => Promise<T>): Promise<T> };
type CryptoAPI = Pick<Crypto, "subtle" | "getRandomValues">;
const block = (code: string): Block => ({ state: "BLOCKED", code });
function exact(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...names].sort().join(",");
}
function validWorker(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= 63 && isValidWorkerId(value) && value === value.trim();
}
function validPublic(value: unknown): value is P256PublicKey {
  return exact(value, ["crv", "kty", "x", "y"]) &&
    value.crv === "P-256" && value.kty === "EC" &&
    typeof value.x === "string" && B64.test(value.x) &&
    typeof value.y === "string" && B64.test(value.y);
}
function validRecord(value: unknown): value is IdentityRecord {
  if (!exact(value, ["schema", "worker_id", "public_key", "private_key", "used"]) ||
      value.schema !== 1 || !validWorker(value.worker_id) ||
      !validPublic(value.public_key) ||
      !(value.private_key instanceof CryptoKey) ||
      value.private_key.type !== "private" ||
      value.private_key.extractable !== false ||
      value.private_key.algorithm.name !== "ECDSA" ||
      (value.private_key.algorithm as EcKeyAlgorithm).namedCurve !== "P-256" ||
      !value.private_key.usages.includes("sign") ||
      !Array.isArray(value.used) || value.used.length > LIMIT) return false;
  const seen = new Set<string>();
  for (const entry of value.used) {
    if (!exact(entry, ["nonce", "expires_at_ms"]) ||
      typeof entry.nonce !== "string" || !SHA.test(entry.nonce) ||
      !Number.isSafeInteger(entry.expires_at_ms) ||
      entry.expires_at_ms <= 0 || seen.has(entry.nonce)) return false;
    seen.add(entry.nonce);
  }
  return true;
}
function canonicalPublic(value: JsonWebKey): P256PublicKey | null {
  if (value.crv !== "P-256" || value.kty !== "EC" ||
    typeof value.x !== "string" || typeof value.y !== "string") return null;
  const key = { crv: "P-256" as const, kty: "EC" as const, x: value.x, y: value.y };
  return validPublic(key) ? key : null;
}
function toB64(data: Uint8Array): string {
  // ECDSA-P256 WebCrypto outputs 64-byte IEEE-P1363, not ASN.1 DER.
  return btoa(Array.from(data, b => String.fromCharCode(b)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function sha256(data: Uint8Array, cryptoImpl: CryptoAPI): Promise<string> {
  return cryptoImpl.subtle.digest("SHA-256", data).then(
    hash => Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join(""),
  );
}
function clockNow(now: () => number): number | null {
  try {
    const n = now();
    return Number.isSafeInteger(n) && n > 0 && n < Number.MAX_SAFE_INTEGER - 31_000 ? n : null;
  } catch { return null; }
}
function validChallenge(value: unknown, worker: string, now: number): value is DeviceChallenge {
  return exact(value, ["installation_id", "worker_id", "proposal_sha256",
    "subject_sha256", "nonce", "expires_at_ms"]) &&
    typeof value.installation_id === "string" && INSTALL.test(value.installation_id) &&
    value.worker_id === worker &&
    typeof value.proposal_sha256 === "string" && SHA.test(value.proposal_sha256) &&
    typeof value.subject_sha256 === "string" && SHA.test(value.subject_sha256) &&
    typeof value.nonce === "string" && SHA.test(value.nonce) &&
    typeof value.expires_at_ms === "number" && Number.isSafeInteger(value.expires_at_ms) &&
    value.expires_at_ms > now && value.expires_at_ms <= now + 30_000;
}
export function canonicalDeviceChallenge(value: DeviceChallenge): string {
  return JSON.stringify([
    DEVICE_CHALLENGE_AUDIENCE, "prepare", value.installation_id, value.worker_id,
    value.proposal_sha256, value.subject_sha256, value.nonce, value.expires_at_ms,
  ]);
}
function assertProfile(record: unknown, worker: string): IdentityRecord | Block {
  if (record === undefined) return block("IDENTITY_NOT_PROVISIONED");
  if (!validRecord(record)) return block("IDENTITY_STORAGE_CORRUPT");
  if (record.worker_id !== worker) return block("IDENTITY_WORKER_MISMATCH");
  return record;
}

// Native IndexedDB is separate for each browser profile/extension origin.
// Non-exportable CryptoKey objects can be structured-cloned by IndexedDB;
// no private key is serialized into chrome.storage, page messages or logs.
// Readwrite transaction serializes competing nonce claims and initial creation.
export function createIndexedDbIdentityStore(idb: IDBFactory = indexedDB): IdentityStore {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = idb.open(DB_NAME, DB_VERSION); }
    catch { reject(Error("IDENTITY_DB_UNAVAILABLE")); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(Error("IDENTITY_DB_UNAVAILABLE"));
    request.onblocked = () => reject(Error("IDENTITY_DB_BLOCKED"));
  });

  return {
    async atomic<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
      const db = await open();
      try {
        return await new Promise<T>((resolve, reject) => {
          let tx: IDBTransaction, output: T;
          try { tx = db.transaction(STORE, "readwrite"); }
          catch { reject(Error("IDENTITY_DB_UNAVAILABLE")); return; }
          const store = tx.objectStore(STORE);
          const requestPromise = <V>(req: IDBRequest<V>): Promise<V> =>
            new Promise<V>((ok, fail) => {
              req.onsuccess = () => ok(req.result);
              req.onerror = () => fail(Error("IDENTITY_DB_OPERATION_FAILED"));
            });
          tx.oncomplete = () => resolve(output);
          tx.onabort = () => reject(Error("IDENTITY_DB_ROLLBACK"));
          tx.onerror = () => reject(Error("IDENTITY_DB_OPERATION_FAILED"));
          // Only IndexedDB requests run inside a transaction. No crypto or
          // network await is allowed in operation(), avoiding auto-commit races.
          Promise.resolve().then(() => operation({
            get: () => requestPromise(store.get(RECORD)),
            put: async value => { await requestPromise(store.put(value, RECORD)); },
          })).then(value => { output = value; })
            .catch(() => { try { tx.abort(); } catch { /* already closed */ } });
        });
      } finally { db.close(); }
    },
  };
}

export function createDeviceIdentityBridge({
  store, cryptoImpl = crypto, now = () => Date.now(),
}: { store: IdentityStore; cryptoImpl?: CryptoAPI; now?: () => number }) {
  const validDeps = typeof store?.atomic === "function" &&
    typeof cryptoImpl?.subtle?.generateKey === "function" &&
    typeof cryptoImpl?.subtle?.sign === "function";
  async function read(worker_id: string): Promise<PublicIdentity | Block> {
    if (!validDeps) return block("IDENTITY_ADAPTER_INVALID");
    if (!validWorker(worker_id)) return block("IDENTITY_WORKER_INVALID");
    let row: unknown;
    try { row = await store.atomic(async tx => tx.get()); }
    catch { return block("IDENTITY_STORAGE_UNAVAILABLE"); }
    const record = assertProfile(row, worker_id);
    if ("state" in record) return record;
    return {
      state: "READY", worker_id,
      public_key: record.public_key,
      public_key_sha256: await sha256(utf8.encode(JSON.stringify(record.public_key)), cryptoImpl),
    };
  }
  async function initialize(worker_id: string): Promise<PublicIdentity | Block> {
    if (!validDeps) return block("IDENTITY_ADAPTER_INVALID");
    if (!validWorker(worker_id)) return block("IDENTITY_WORKER_INVALID");
    try {
      // A candidate is never persisted until we verify the browser generated
      // a nonexportable private key and a canonical P-256 public key.
      const keys = await cryptoImpl.subtle.generateKey({
        name: "ECDSA", namedCurve: "P-256",
      }, false, ["sign", "verify"]) as CryptoKeyPair;
      const pub = canonicalPublic(await cryptoImpl.subtle.exportKey("jwk", keys.publicKey));
      if (!pub || keys.privateKey.extractable !== false ||
          keys.privateKey.type !== "private") return block("IDENTITY_KEY_GENERATION_FAILED");
      const candidate: IdentityRecord = {
        schema: 1, worker_id, public_key: pub, private_key: keys.privateKey, used: [],
      };
      const outcome = await store.atomic(async tx => {
        const old = await tx.get();
        if (old !== undefined) {
          const prior = assertProfile(old, worker_id);
          return "state" in prior ? prior : { state: "ALREADY_EXISTS" as const };
        }
        await tx.put(candidate);
        return { state: "CREATED" as const };
      });
      if (outcome.state === "BLOCKED") return outcome;
      // Re-read only the profile's public identity. No CryptoKey returned.
      return read(worker_id);
    } catch { return block("IDENTITY_STORAGE_OR_CRYPTO_UNAVAILABLE"); }
  }
  async function sign(
    worker_id: string, challenge: unknown,
  ): Promise<Signed | Block> {
    if (!validDeps) return block("IDENTITY_ADAPTER_INVALID");
    if (!validWorker(worker_id)) return block("IDENTITY_WORKER_INVALID");
    const current = clockNow(now);
    if (current === null || !validChallenge(challenge, worker_id, current)) {
      return block("IDENTITY_CHALLENGE_REJECTED");
    }
    const typed = challenge as DeviceChallenge;
    let claimed: IdentityRecord | Block;
    // Reserve the nonce durably BEFORE signing. An uncertain failure never
    // returns a valid signature; a failed sign leaves the nonce spent.
    try {
      claimed = await store.atomic(async tx => {
        const record = assertProfile(await tx.get(), worker_id);
        if ("state" in record) return record;
        const seen = record.used.filter(x => x.expires_at_ms > current);
        if (seen.some(x => x.nonce === typed.nonce))return block("IDENTITY_CHALLENGE_REPLAY");
        if (seen.length >= LIMIT)return block("IDENTITY_REPLAY_REGISTRY_FULL");
        await tx.put({ ...record, used: [...seen, {
          nonce: typed.nonce, expires_at_ms: typed.expires_at_ms,
        }] });
        return record;
      });
    } catch { return block("IDENTITY_STORAGE_UNAVAILABLE"); }
    if ("state" in claimed) return claimed;
    try {
      const fresh = clockNow(now);
      if (fresh === null || typed.expires_at_ms <= fresh) {
        return block("IDENTITY_CHALLENGE_EXPIRED");
      }
      const message = canonicalDeviceChallenge(typed);
      const signature = new Uint8Array(await cryptoImpl.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" }, claimed.private_key, utf8.encode(message),
      ));
      if (signature.length !== 64)return block("IDENTITY_SIGNATURE_INVALID");
      // Verify against the persisted public key, so a damaged, swapped or
      // imported keypair cannot authorize a device enrollment proposal.
      const publicKey = await cryptoImpl.subtle.importKey("jwk", claimed.public_key,
        { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const verified = await cryptoImpl.subtle.verify({
        name: "ECDSA", hash: "SHA-256",
      }, publicKey, signature, utf8.encode(message));
      return verified ? { state: "SIGNED", device_signature: toB64(signature) }
        : block("IDENTITY_KEYPAIR_MISMATCH");
    } catch { return block("IDENTITY_SIGNING_FAILED"); }
  }
  return Object.freeze({ read, initialize, sign });
}

// Read-only local status for the popup. A message may never trigger signing.
export async function publicIdentitySummary(
  bridge: ReturnType<typeof createDeviceIdentityBridge>, worker_id: string,
): Promise<IdentitySummary> {
  const result = await bridge.read(worker_id);
  if (result.state === "READY") return {
    state: "PROVISIONED", worker_id: result.worker_id,
    public_key_sha256: result.public_key_sha256,
  };
  return result.code === "IDENTITY_NOT_PROVISIONED"
    ? { state: "NOT_PROVISIONED" } : result;
}
