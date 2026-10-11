import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import test from "node:test";
import { framePng } from "../tools/frame-png.mjs";

test("headless PNG preserves native RGBA pixels and dimensions", () => {
  const pixels = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255]);
  const png = framePng({ width: 1, height: 2, pixels });
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1);
  assert.equal(png.readUInt32BE(20), 2);
  const dataSize = png.readUInt32BE(33);
  assert.equal(png.subarray(37, 41).toString(), "IDAT");
  assert.deepEqual([...inflateSync(png.subarray(41, 41 + dataSize))], [0, 255, 0, 0, 255, 0, 0, 255, 0, 255]);
  assert.throws(() => framePng({ width: 2, height: 2, pixels }), /Invalid/);
});
