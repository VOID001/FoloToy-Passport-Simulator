import { BoardEventBridge } from './board-events.js';
import { Esp32C3GpioState } from './gpio.js';
import { Esp32C3I2S } from './i2s.js';
import { ST7789 } from './st7789.js';


export const BUTTON_MV = Object.freeze({
  UP: 0,
  DOWN: 300,
  OK: 595,
  RELEASED: 3300,
});

export class AiPassportBoard {
  constructor(wasm, options = {}) {
    if (!options.emulator) {
      throw new Error('AiPassportBoard requires the WasmEmulator instance');
    }
    this.bridge = new BoardEventBridge(wasm, options.eventBufferBytes);
    this.gpio = new Esp32C3GpioState();
    this.display = new ST7789({
      width: 240,
      height: 320,
      byteOrder: 'big',
      strictInference: false,
      nativeInverted: true,
    });
    this.onFrame = options.onFrame ?? (() => {});
    this.onAudio = options.onAudio ?? (() => {});
    this.onUnknownEvent = options.onUnknownEvent ?? (() => {});
    this.pressedButtons = new Set();
    this.audio = new Esp32C3I2S(
      wasm,
      options.emulator,
      this.bridge.statePointer,
      { onAudio: this.onAudio },
    );
  }

  drain(options = {}) {
    for (const event of this.bridge.drain()) {
      if (event.type === 'mmio') {
        this.audio.handleRegisterWrite(event.address, event.value);
        if (event.peripheral === 1) {
          this.gpio.write(event.address, event.value);
        }
        continue;
      }
      if (event.type === 'spi' && event.bus === 1) {
        this.display.processTransaction({
          bytes: event.bytes,
          dc: this.gpio.level(20),
        });
        continue;
      }
      if (event.type === 'audio') {
        this.onAudio(event);
        continue;
      }
      this.onUnknownEvent(event);
    }

    if (options.flushFrame !== false) {
      this.flushFrame();
    }
  }

  flushFrame() {
    const dirtyRegion = this.display.consumeDirtyRegion();
    if (dirtyRegion) {
      this.onFrame({
        width: this.display.width,
        height: this.display.height,
        pixels: this.display.framebuffer,
        dirtyRegion,
        displayOn: this.display.displayOn,
      });
    }
  }

  setButton(name, pressed) {
    if (!Object.hasOwn(BUTTON_MV, name) || name === 'RELEASED') {
      throw new RangeError(`Unknown AI Passport button: ${name}`);
    }
    if (pressed) {
      this.pressedButtons.delete(name);
      this.pressedButtons.add(name);
    } else {
      this.pressedButtons.delete(name);
    }
    const active = [...this.pressedButtons].at(-1);
    this.bridge.wasm.ap_board_set_adc1_mv(
      active ? BUTTON_MV[active] : BUTTON_MV.RELEASED,
    );
    this.bridge.wasm.ap_board_set_gpio_input(
      0,
      this.pressedButtons.size === 0 ? 1 : 0,
    );
  }

  releaseButtons() {
    this.pressedButtons.clear();
    this.bridge.wasm.ap_board_set_adc1_mv(BUTTON_MV.RELEASED);
    this.bridge.wasm.ap_board_set_gpio_input(0, 1);
  }

  pushMicrophone(bytes) {
    this.audio.pushMicrophone(bytes);
  }

  pumpAudio(now, force = false) {
    return this.audio.pump(now, force);
  }

  droppedEvents() {
    return this.bridge.droppedEvents();
  }
}
