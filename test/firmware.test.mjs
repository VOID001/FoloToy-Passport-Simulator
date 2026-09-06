import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_FIRMWARE_BYTES,
  formatFirmwareSize,
  validateFirmwareFile,
} from "../public/firmware.js";

test("accepts non-empty .bin files up to the Flash capacity", () => {
  assert.doesNotThrow(() => validateFirmwareFile({
    name: "FoloToy-AI-Passport-full.BIN",
    size: MAX_FIRMWARE_BYTES,
  }));
});

test("rejects unsupported, empty, and oversized firmware files", () => {
  assert.throws(
    () => validateFirmwareFile({ name: "firmware.zip", size: 1024 }),
    /请选择 \.bin 固件镜像/,
  );
  assert.throws(
    () => validateFirmwareFile({ name: "firmware.bin", size: 0 }),
    /固件文件为空/,
  );
  assert.throws(
    () => validateFirmwareFile({ name: "firmware.bin", size: MAX_FIRMWARE_BYTES + 1 }),
    /8 MB Flash/,
  );
});

test("formats firmware sizes for the upload status", () => {
  assert.equal(formatFirmwareSize(1024), "1 KB");
  assert.equal(formatFirmwareSize(1_353_184), "1.29 MB");
});
