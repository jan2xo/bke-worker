// Chrome native-messaging standard: uint32-LE byte length, then one UTF-8 JSON.
// Never print debug text to stdout: it is a binary protocol channel.
export const MAX_FRAME_BYTES = 16_384;
export const MAX_RESPONSE_BYTES = 4_096;

export function encodeFrame(value, maximum = MAX_FRAME_BYTES) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.length === 0 || bytes.length > maximum) throw Error("NATIVE_FRAME_OVERSIZE");
  const out = Buffer.allocUnsafe(bytes.length + 4);
  out.writeUInt32LE(bytes.length, 0);
  bytes.copy(out, 4);
  return out;
}

export function nativeFrameReader(stream, maximum = MAX_FRAME_BYTES) {
  const iterator = stream[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  let closed = false;
  return Object.freeze({
    async next() {
      if (closed) throw Error("NATIVE_CHANNEL_CLOSED");
      while (pending.length < 4) {
        const item = await iterator.next();
        if (item.done) throw Error("NATIVE_FRAME_TRUNCATED");
        pending = Buffer.concat([pending, Buffer.from(item.value)]);
        if (pending.length > maximum * 2 + 8) throw Error("NATIVE_FRAME_OVERFLOW");
      }
      const length = pending.readUInt32LE(0);
      if (length === 0 || length > maximum) throw Error("NATIVE_FRAME_OVERSIZE");
      while (pending.length < length + 4) {
        const item = await iterator.next();
        if (item.done) throw Error("NATIVE_FRAME_TRUNCATED");
        pending = Buffer.concat([pending, Buffer.from(item.value)]);
        if (pending.length > maximum * 2 + 8) throw Error("NATIVE_FRAME_OVERFLOW");
      }
      const body = pending.subarray(4, length + 4);
      pending = pending.subarray(length + 4);
      let decoded;
      try {
        const text = new TextDecoder("utf-8", {fatal:true}).decode(body);
        decoded = JSON.parse(text);
      } catch { throw Error("NATIVE_FRAME_INVALID_JSON"); }
      if (decoded===null||typeof decoded!=="object"||Array.isArray(decoded))
        throw Error("NATIVE_FRAME_INVALID_OBJECT");
      return decoded;
    },
    close() { closed=true; },
  });
}
export async function writeFrame(stream,value) {
  const frame=encodeFrame(value,MAX_RESPONSE_BYTES);
  if (!stream.write(frame)) {
    await new Promise((resolve,reject)=>{
      stream.once("drain",resolve);
      stream.once("error",reject);
    });
  }
}
