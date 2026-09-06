import assert from "node:assert/strict";
import test from "node:test";

import { qemuButtonGesture, qemuButtonState } from "../public/runtime.js";

test("formats physical button states for the ADC ladder", () => {
  assert.deepEqual(qemuButtonState("UP", true), { name: "UP", pressed: true });
  assert.deepEqual(qemuButtonState("DOWN", false), { name: "DOWN", pressed: false });
  assert.deepEqual(qemuButtonState("OK", true), { name: "OK", pressed: true });
  assert.throws(() => qemuButtonState("POWER", true), /Unsupported QEMU button/);
  assert.throws(() => qemuButtonState("UP", "pressed"), /must be boolean/);
});

test("validates firmware button gestures", () => {
  assert.deepEqual(qemuButtonGesture("DOWN", "CLICK"), {
    name: "DOWN",
    gesture: "CLICK",
  });
  assert.deepEqual(qemuButtonGesture("OK", "DOUBLE"), {
    name: "OK",
    gesture: "DOUBLE",
  });
  assert.throws(() => qemuButtonGesture("POWER", "CLICK"), /Unsupported QEMU button/);
  assert.throws(() => qemuButtonGesture("UP", "HOLD"), /Unsupported QEMU button gesture/);
});
