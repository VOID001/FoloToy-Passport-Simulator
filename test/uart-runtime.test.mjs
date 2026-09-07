import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  initSync,
  WasmEmulator,
} from "../public/wasm/pkg/esp_emu.js";

const USB_SERIAL_JTAG_EP1_REG = 0x60043000;
const UART0_FIFO_REG = 0x60000000;

test("UART input reaches both ESP32-C3 console transports", async () => {
  const wasm = initSync({
    module: await readFile(
      new URL("../public/wasm/pkg/esp_emu_bg.wasm", import.meta.url),
    ),
  });
  const emulator = new WasmEmulator("esp32c3");
  const input = Uint8Array.from(
    { length: 130 },
    (_, index) => (index % 94) + 33,
  );

  try {
    emulator.uart_input(input);

    const received = Uint8Array.from(input, () =>
      wasm.ap_board_debug_read32(
        emulator.__wbg_ptr,
        USB_SERIAL_JTAG_EP1_REG,
      ) & 0xff
    );
    assert.deepEqual(received, input);

    const uartReceived = Uint8Array.from(input, () =>
      wasm.ap_board_debug_read32(emulator.__wbg_ptr, UART0_FIFO_REG) & 0xff
    );
    assert.deepEqual(uartReceived, input);
  } finally {
    emulator.free();
  }
});
