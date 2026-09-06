// ESP32-C3 ROM symbols _text_start_btdm_rom and _text_end_btdm_rom from the
// ROM ELF embedded in ESP-EMU v0.42.0. The runtime checksum is pinned by
// tools/verify-board-runtime.mjs.
export const ESP32C3_BLE_ROM = Object.freeze({
  start: 0x40001f4c,
  end: 0x400318b2,
});

export function detectUnsupportedFeature(programCounter) {
  const pc = programCounter >>> 0;
  if (pc >= ESP32C3_BLE_ROM.start && pc < ESP32C3_BLE_ROM.end) {
    return "ble";
  }
  return null;
}
