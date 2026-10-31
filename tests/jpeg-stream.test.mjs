import test from 'node:test';
import assert from 'node:assert/strict';
import { jpegFrames } from '../src/jpeg-stream.mjs';

function frame(...values) {
  const bytes = new Uint8Array(4 + values.length);
  new DataView(bytes.buffer).setUint32(0, values.length);
  bytes.set(values, 4);
  return bytes;
}
function stream(chunks) {
  return new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } });
}
async function collect(body) {
  const frames = [];
  for await (const bytes of jpegFrames(body)) frames.push([...bytes]);
  return frames;
}

test('preview decodes frames split across arbitrary network chunks', async () => {
  const bytes = frame(255, 216, 10, 255, 217);
  assert.deepEqual(await collect(stream([bytes.slice(0, 2), bytes.slice(2, 6), bytes.slice(6)])), [[255, 216, 10, 255, 217]]);
});
test('preview drops queued old frames and renders the latest', async () => {
  const bytes = new Uint8Array([...frame(1), ...frame(2), ...frame(3)]);
  assert.deepEqual(await collect(stream([bytes])), [[3]]);
});
test('preview rejects invalid sizes and incomplete frames without allocating huge buffers', async () => {
  await assert.rejects(collect(stream([new Uint8Array([255, 255, 255, 255])])), /Invalid/);
  await assert.rejects(collect(stream([frame(1, 2).slice(0, 5)])), /Incomplete/);
});
test('stopping preview cancels the network reader', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(frame(1)); }, cancel() { cancelled = true; } });
  for await (const bytes of jpegFrames(body)) { assert.equal(bytes[0], 1); break; }
  assert.equal(cancelled, true);
});
