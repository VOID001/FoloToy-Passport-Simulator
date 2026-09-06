export const BOARD_ABI_VERSION = 1;

export const BoardEventType = Object.freeze({
  SPI_TX: 1,
  MMIO_WRITE: 2,
  I2S_TX: 3,
});

const HEADER_BYTES = 8;

export class BoardEventBridge {
  constructor(wasm, capacity = 2 * 1024 * 1024) {
    if (wasm.ap_board_abi_version() !== BOARD_ABI_VERSION) {
      throw new Error(`Unsupported board ABI: ${wasm.ap_board_abi_version()}`);
    }
    if (capacity < 64 * 1024) {
      throw new Error("Board event buffer must be at least 64 KiB");
    }
    this.wasm = wasm;
    this.capacity = capacity;
    this.statePointer = wasm.__wbindgen_export2(4096, 4) >>> 0;
    this.pointer = wasm.__wbindgen_export2(capacity, 1) >>> 0;
    if (!this.pointer || !this.statePointer) {
      throw new Error("Unable to allocate board runtime buffers");
    }
    new Uint8Array(wasm.memory.buffer, this.statePointer, 4096).fill(0);
    wasm.ap_board_set_state_buffer(this.statePointer);
    wasm.ap_board_set_event_buffer(this.pointer, capacity);
  }

  drain() {
    const length = this.wasm.ap_board_take_events() >>> 0;
    if (length > this.capacity) {
      throw new Error(`Invalid board event length: ${length}`);
    }
    const bytes = new Uint8Array(
      this.wasm.memory.buffer,
      this.pointer,
      length,
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const events = [];

    for (let offset = 0; offset < length;) {
      if (offset + HEADER_BYTES > length) {
        throw new Error(`Truncated board event header at ${offset}`);
      }
      const type = bytes[offset];
      const channel = bytes[offset + 1];
      const payloadLength = view.getUint32(offset + 4, true);
      const end = offset + HEADER_BYTES + payloadLength;
      if (end > length) {
        throw new Error(`Truncated board event payload at ${offset}`);
      }
      const payload = bytes.slice(offset + HEADER_BYTES, end);
      if (type === BoardEventType.SPI_TX) {
        events.push({ type: "spi", bus: channel, bytes: payload });
      } else if (
        type === BoardEventType.MMIO_WRITE &&
        payloadLength === 8
      ) {
        const payloadView = new DataView(
          payload.buffer,
          payload.byteOffset,
          payload.byteLength,
        );
        events.push({
          type: "mmio",
          peripheral: channel,
          address: payloadView.getUint32(0, true),
          value: payloadView.getUint32(4, true),
        });
      } else if (type === BoardEventType.I2S_TX) {
        events.push({ type: "audio", port: channel, bytes: payload });
      } else {
        events.push({ type: "unknown", eventType: type, channel, payload });
      }
      offset = end;
    }
    return events;
  }

  droppedEvents() {
    return this.wasm.ap_board_dropped() >>> 0;
  }
}
