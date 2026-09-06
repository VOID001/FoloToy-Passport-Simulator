import assert from "node:assert/strict";
import test from "node:test";

import {
  REGISTER_NAMES,
  formatHex32,
} from "../public/inspector.js";

test("defines the CPU register labels and formats 32-bit values", () => {
  assert.equal(REGISTER_NAMES.length, 32);
  assert.equal(REGISTER_NAMES[2], "sp");
  assert.equal(formatHex32(0x123), "0x00000123");
});
