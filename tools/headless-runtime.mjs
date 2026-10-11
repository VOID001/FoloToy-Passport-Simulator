import { readFile } from "node:fs/promises";
import { initSync, WasmEmulator } from "../public/wasm/pkg/esp_emu.js";
import { AiPassportBoard } from "../public/wasm/ai-passport-board.js";
import { detectUnsupportedFeature } from "../public/wasm/unsupported-features.js";

/** One emulator per process; no browser, HTTP listener, or network bridge. */
export class HeadlessRuntime extends EventTarget {
  #emulator;
  #board;
  #disposed = false;

  static async create(firmware) {
    const wasm = initSync({ module: await readFile(new URL("../public/wasm/pkg/esp_emu_bg.wasm", import.meta.url)) });
    const runtime = new HeadlessRuntime();
    runtime.#emulator = new WasmEmulator("esp32c3");
    try {
      runtime.#emulator.load_default_rom();
      runtime.#emulator.set_boot_from_rom(true);
      runtime.#emulator.load_firmware(firmware);
      runtime.#board = new AiPassportBoard(wasm, { emulator: runtime.#emulator });
      runtime.#board.releaseButtons();
      return runtime;
    } catch (error) { runtime.dispose(); throw error; }
  }

  sendUart(bytes) {
    if (this.#disposed) return false;
    this.#emulator.uart_input(bytes);
    return true;
  }

  async runFor(milliseconds, { signal } = {}) {
    if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 120_000) {
      throw new RangeError("Run duration must be 0–120000 virtual ms");
    }
    if (this.#disposed) throw new Error("Headless runtime disposed");
    const end = this.#emulator.cycles() + milliseconds * 160_000;
    let lastYield = performance.now();
    while (this.#emulator.cycles() < end) {
      if (signal?.aborted) return;
      const text = this.#emulator.run_batch(50_000);
      this.#board.drain();
      this.#board.pumpAudio(this.#emulator.cycles() / 160_000);
      if (text) this.dispatchEvent(new CustomEvent("uart", { detail: text }));
      const unsupported = detectUnsupportedFeature(this.#emulator.pc());
      if (unsupported) throw new Error(`Unsupported simulated feature: ${unsupported}`);
      if (performance.now() - lastYield > 8) {
        await new Promise((resolve) => setImmediate(resolve));
        lastYield = performance.now();
      }
    }
  }

  snapshot() {
    if (this.#disposed) throw new Error("Headless runtime disposed");
    return { width: this.#board.display.width, height: this.#board.display.height,
      pixels: this.#board.display.framebuffer.slice() };
  }

  dispose() {
    if (this.#disposed) return;
    this.dispatchEvent(new CustomEvent("state", { detail: "stopped" }));
    this.#emulator?.free();
    this.#disposed = true;
  }
}
