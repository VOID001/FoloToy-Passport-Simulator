import assert from "node:assert/strict";
import test from "node:test";

import {
  ESP32C3_BLE_ROM,
  detectUnsupportedFeature,
} from "../public/wasm/unsupported-features.js";

test("detects execution anywhere in the ESP32-C3 ROM Bluetooth section", () => {
  assert.equal(detectUnsupportedFeature(ESP32C3_BLE_ROM.start), "ble");
  assert.equal(detectUnsupportedFeature(0x4002ee78), "ble");
  assert.equal(detectUnsupportedFeature(ESP32C3_BLE_ROM.end - 2), "ble");
});

test("does not classify adjacent ROM or normal firmware code as Bluetooth", () => {
  assert.equal(detectUnsupportedFeature(ESP32C3_BLE_ROM.start - 2), null);
  assert.equal(detectUnsupportedFeature(ESP32C3_BLE_ROM.end), null);
  assert.equal(detectUnsupportedFeature(0x400387a0), null);
  assert.equal(detectUnsupportedFeature(0x4005885c), null);
  assert.equal(detectUnsupportedFeature(0x4038b2d4), null);
  assert.equal(detectUnsupportedFeature(0x42051efc), null);
});
