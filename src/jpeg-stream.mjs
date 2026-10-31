// Each JPEG has a four-byte unsigned big-endian byte length. HTTP chunks may
// split either part or contain multiple frames; keep only the newest complete
// frame in each chunk so a slow renderer catches up rather than falling behind.
export async function* jpegFrames(body) {
  const reader = body.getReader();
  let pending = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (pending.length) throw new Error('Incomplete camera frame');
        return;
      }
      const bytes = new Uint8Array(pending.length + value.length);
      bytes.set(pending); bytes.set(value, pending.length);
      let offset = 0, latest;
      while (bytes.length - offset >= 4) {
        const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
        if (size === 0 || size > 4 * 1024 * 1024) throw new Error('Invalid camera frame size');
        if (bytes.length - offset < 4 + size) break;
        latest = bytes.slice(offset + 4, offset + 4 + size);
        offset += 4 + size;
      }
      pending = bytes.slice(offset);
      if (latest) yield latest;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
