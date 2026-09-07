import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_FIRMWARE_PRESET_ID,
  FIRMWARE_PRESET_IDS_BY_URL_ID,
  MAX_FIRMWARE_BYTES,
  formatFirmwareSize,
  resolveFirmwarePresetId,
  validateFirmwareFile,
} from "../public/firmware.js";

const availablePresetIds = Object.values(FIRMWARE_PRESET_IDS_BY_URL_ID);

test("maps URL IDs 1 through 4 to the fixed firmware allowlist", () => {
  const expectedIds = [
    "music-keychain",
    "answer-book",
    DEFAULT_FIRMWARE_PRESET_ID,
    "feishu-calendar-assistant",
  ];

  for (const [index, expectedId] of expectedIds.entries()) {
    assert.equal(
      resolveFirmwarePresetId(`?id=${index + 1}`, availablePresetIds),
      expectedId,
    );
  }
});

test("uses the official demo unless the URL ID is exactly 1 through 4", () => {
  for (const search of [
    "",
    "?debug=network",
    "?id=",
    "?id=0",
    "?id=5",
    "?id=01",
    "?id=answer-book",
    "?id=../answer-book",
    "?firmware=answer-book",
  ]) {
    assert.equal(
      resolveFirmwarePresetId(search, availablePresetIds),
      DEFAULT_FIRMWARE_PRESET_ID,
    );
  }
});

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
