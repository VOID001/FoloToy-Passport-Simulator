const GPIO_BASE = 0x60004000;
const GPIO_OUT = GPIO_BASE + 0x04;
const GPIO_OUT_W1TS = GPIO_BASE + 0x08;
const GPIO_OUT_W1TC = GPIO_BASE + 0x0c;

export class Esp32C3GpioState {
  constructor() {
    this.output = 0;
  }

  write(address, value) {
    const next = value >>> 0;
    switch (address >>> 0) {
      case GPIO_OUT:
        this.output = next;
        return true;
      case GPIO_OUT_W1TS:
        this.output = (this.output | next) >>> 0;
        return true;
      case GPIO_OUT_W1TC:
        this.output = (this.output & ~next) >>> 0;
        return true;
      default:
        return false;
    }
  }

  level(pin) {
    if (!Number.isInteger(pin) || pin < 0 || pin > 31) {
      throw new RangeError('GPIO pin must be between 0 and 31');
    }
    return Boolean(this.output & (1 << pin));
  }
}

export {
  GPIO_BASE,
  GPIO_OUT,
  GPIO_OUT_W1TC,
  GPIO_OUT_W1TS,
};
