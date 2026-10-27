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
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_FRAME_BYTES)
    throw Error("NATIVE_FRAME_LIMIT_INVALID");
  const iterator = stream[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  let closed = false;
  let reading = false;
  const cancel=()=>{
    if(closed)return;
    closed=true;
    if(typeof stream.destroy==="function"&&!stream.destroyed)
      stream.destroy();
  };
  // The stream is untrusted. Refuse an oversized chunk BEFORE Buffer.concat,
  // not after allocating/copying a potentially unbounded incoming payload.
  const appendBounded = async () => {
    let item;
    try { item = await iterator.next(); }
    catch (error) {
      if (closed) throw Error("NATIVE_CHANNEL_CLOSED");
      throw error;
    }
    // close() can race a next() already waiting on untrusted input. No late
    // bytes may complete an expired, disconnected or uncertain host session.
    if (closed) throw Error("NATIVE_CHANNEL_CLOSED");
    if (item.done) throw Error("NATIVE_FRAME_TRUNCATED");
    const chunk = item.value;
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array))
      throw Error("NATIVE_FRAME_INVALID_CHUNK");
    const limit = maximum * 2 + 8;
    if (chunk.byteLength > limit - pending.length)
      throw Error("NATIVE_FRAME_OVERFLOW");
    pending = Buffer.concat([pending, chunk], pending.length + chunk.byteLength);
  };
  return Object.freeze({
    async next() {
      if (closed) throw Error("NATIVE_CHANNEL_CLOSED");
      // The buffer and stream iterator are shared mutable state. Two pending
      // reads are ambiguous, not independent messages: cancel BOTH attempts
      // rather than guessing which frame belongs to which caller.
      if(reading){
        cancel();
        throw Error("NATIVE_FRAME_CONCURRENT_READ_DENIED");
      }
      reading=true;
      try{
        while (pending.length < 4) await appendBounded();
        const length = pending.readUInt32LE(0);
        if (length === 0 || length > maximum) throw Error("NATIVE_FRAME_OVERSIZE");
        while (pending.length < length + 4) await appendBounded();
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
      }catch(error){
        // A malformed or truncated message poisons this authenticated
        // channel. Never let a later valid frame revive the same reader.
        // Preserve the causal first error while denying every later read.
        cancel();
        throw error;
      }finally{reading=false;}
    },
    close() {cancel();},
  });
}
export async function writeFrame(stream,value,timeoutMs=15_000) {
  if (!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>15_000)
    throw Error("NATIVE_FRAME_TIMEOUT_INVALID");
  const frame=encodeFrame(value,MAX_RESPONSE_BYTES);
  if (!stream.write(frame)) {
    // Backpressure can end in close/finish without drain or error.
    // Reject rather than leaving a controller/native-host write unresolved.
    await new Promise((resolve,reject)=>{
      let settled=false;
      let timer;
      const finish=(error)=>{
        if(settled)return;
        settled=true;
        clearTimeout(timer);
        stream.off("drain",onDrain);
        stream.off("error",onError);
        stream.off("close",onClose);
        stream.off("finish",onFinish);
        if(error)reject(error);else resolve();
      };
      const onDrain=()=>finish();
      const onError=error=>finish(error);
      const onClose=()=>finish(Error("NATIVE_FRAME_CHANNEL_CLOSED"));
      const onFinish=()=>finish(Error("NATIVE_FRAME_CHANNEL_ENDED"));
      stream.once("drain",onDrain);
      stream.once("error",onError);
      stream.once("close",onClose);
      stream.once("finish",onFinish);
      // Close/error is not guaranteed: a silent but open pipe can stall.
      // Settling this promise removes all listeners and denies the handshake.
      timer=setTimeout(()=>finish(Error("NATIVE_FRAME_BACKPRESSURE_TIMEOUT")),timeoutMs);
      if(stream.destroyed)onClose();
      else if(stream.writableEnded)onFinish();
    });
  }
}
