'use strict';

const WIDTH = 240;
const HEIGHT = 320;

const COMMANDS = Object.freeze({
  SWRESET: 0x01,
  SLPOUT: 0x11,
  INVOFF: 0x20,
  INVON: 0x21,
  DISPOFF: 0x28,
  DISPON: 0x29,
  CASET: 0x2a,
  RASET: 0x2b,
  RAMWR: 0x2c,
  MADCTL: 0x36,
  COLMOD: 0x3a,
  RAMWRC: 0x3c,
});

const PARAMETER_LENGTHS = new Map([
  [COMMANDS.SWRESET, 0],
  [COMMANDS.SLPOUT, 0],
  [COMMANDS.INVOFF, 0],
  [COMMANDS.INVON, 0],
  [COMMANDS.DISPOFF, 0],
  [COMMANDS.DISPON, 0],
  [COMMANDS.CASET, 4],
  [COMMANDS.RASET, 4],
  [COMMANDS.RAMWR, 0],
  [COMMANDS.MADCTL, 1],
  [COMMANDS.COLMOD, 1],
  [COMMANDS.RAMWRC, 0],
]);

const MEMORY_COMMANDS = new Set([COMMANDS.RAMWR, COMMANDS.RAMWRC]);

function toBytes(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value);
  }
  throw new TypeError('transaction.bytes must be an ArrayBuffer, typed array, or byte array');
}

function normalizeByteOrder(options) {
  const value = options.byteOrder ?? options.rgb565Endian ?? options.pixelByteOrder ?? 'big';
  if (value !== 'big' && value !== 'little') {
    throw new RangeError("RGB565 byte order must be 'big' or 'little'");
  }
  return value;
}

class ST7789 {
  constructor(options = {}) {
    this.width = options.width ?? WIDTH;
    this.height = options.height ?? HEIGHT;
    if (!Number.isInteger(this.width) || this.width <= 0 ||
        !Number.isInteger(this.height) || this.height <= 0) {
      throw new RangeError('display dimensions must be positive integers');
    }

    this.byteOrder = normalizeByteOrder(options);
    this.strictInference = options.strictInference !== false;
    this.csActiveLow = options.csActiveLow !== false;
    this.nativeInverted = options.nativeInverted === true;
    this.framebuffer = new Uint8ClampedArray(this.width * this.height * 4);
    this._dirty = null;
    this._initialize(false);
  }

  _initialize(markDirty) {
    this.sleeping = true;
    this.displayOn = false;
    this.inverted = false;
    this.pixelFormat = 0x55;
    this.madctl = 0;
    this.columnStart = 0;
    this.columnEnd = this.width - 1;
    this.rowStart = 0;
    this.rowEnd = this.height - 1;
    this.cursorX = this.columnStart;
    this.cursorY = this.rowStart;
    this.command = null;
    this._parameters = [];
    this._expectedParameters = 0;
    this._pixelByte = null;

    for (let offset = 0; offset < this.framebuffer.length; offset += 4) {
      this.framebuffer[offset] = 0;
      this.framebuffer[offset + 1] = 0;
      this.framebuffer[offset + 2] = 0;
      this.framebuffer[offset + 3] = 255;
    }
    this._dirty = markDirty
      ? { x: 0, y: 0, width: this.width, height: this.height }
      : null;
  }

  reset() {
    this._initialize(true);
    return this._result();
  }

  processTransaction(transaction) {
    if (!transaction || typeof transaction !== 'object') {
      throw new TypeError('transaction must be an object');
    }

    const bytes = toBytes(transaction.bytes);
    if (bytes.length === 0 || !this._isSelected(transaction.cs)) {
      return this._result();
    }

    if (transaction.dc === false || transaction.dc === 0) {
      this._processCommands(bytes);
    } else if (transaction.dc === true || transaction.dc === 1) {
      this._processData(bytes);
    } else if (transaction.dc === undefined || transaction.dc === null) {
      this._processInferred(bytes);
    } else {
      throw new TypeError('transaction.dc must be a boolean when provided');
    }

    return this._result();
  }

  feed(transaction) {
    return this.processTransaction(transaction);
  }

  write(transaction) {
    return this.processTransaction(transaction);
  }

  _isSelected(cs) {
    if (cs === undefined || cs === null) {
      return true;
    }
    if (typeof cs !== 'boolean' && cs !== 0 && cs !== 1) {
      throw new TypeError('transaction.cs must be a boolean when provided');
    }
    return this.csActiveLow ? !Boolean(cs) : Boolean(cs);
  }

  _processCommands(bytes) {
    for (const command of bytes) {
      this._beginCommand(command, false);
    }
  }

  _processData(bytes) {
    if (this.command === null) {
      if (this.strictInference) {
        throw new Error('data transaction received before a command');
      }
      return;
    }

    let offset = 0;
    if (this._parameters.length < this._expectedParameters) {
      const remaining = this._expectedParameters - this._parameters.length;
      const count = Math.min(remaining, bytes.length);
      for (let index = 0; index < count; index += 1) {
        this._parameters.push(bytes[index]);
      }
      offset = count;
      if (this._parameters.length === this._expectedParameters) {
        this._applyParameters();
      }
    }

    if (offset < bytes.length) {
      if (!MEMORY_COMMANDS.has(this.command)) {
        if (this.strictInference) {
          throw new Error(
            `command 0x${this.command.toString(16).padStart(2, '0')} received excess data`,
          );
        }
        return;
      }
      this._writePixels(bytes.subarray(offset));
    }
  }

  _processInferred(bytes) {
    if (this._parameters.length < this._expectedParameters) {
      const remaining = this._expectedParameters - this._parameters.length;
      if (this.strictInference && bytes.length > remaining) {
        throw new Error('transaction exceeds the pending command parameter length');
      }
      this._processData(bytes);
      return;
    }

    if (MEMORY_COMMANDS.has(this.command)) {
      if (bytes.length === 1 && PARAMETER_LENGTHS.has(bytes[0])) {
        this._beginCommand(bytes[0], true);
      } else {
        this._processData(bytes);
      }
      return;
    }

    let offset = 0;
    while (offset < bytes.length) {
      const command = bytes[offset];
      if (!PARAMETER_LENGTHS.has(command)) {
        throw new Error(
          `cannot infer DC for unsupported command 0x${command.toString(16).padStart(2, '0')}`,
        );
      }
      this._beginCommand(command, true);
      offset += 1;

      const parameterCount = PARAMETER_LENGTHS.get(command);
      const available = bytes.length - offset;
      const consumed = Math.min(parameterCount, available);
      if (consumed > 0) {
        this._processData(bytes.subarray(offset, offset + consumed));
        offset += consumed;
      }
      if (consumed < parameterCount) {
        return;
      }
      if (MEMORY_COMMANDS.has(command) && offset < bytes.length) {
        this._processData(bytes.subarray(offset));
        return;
      }
    }
  }

  _beginCommand(command, inferred) {
    if (inferred && !PARAMETER_LENGTHS.has(command)) {
      throw new Error(
        `cannot infer unsupported command 0x${command.toString(16).padStart(2, '0')}`,
      );
    }

    this.command = command;
    this._parameters = [];
    this._expectedParameters = PARAMETER_LENGTHS.get(command) ?? 0;
    this._pixelByte = null;

    switch (command) {
      case COMMANDS.SWRESET:
        this._initialize(true);
        this.command = COMMANDS.SWRESET;
        break;
      case COMMANDS.SLPOUT:
        this.sleeping = false;
        break;
      case COMMANDS.INVOFF:
        this._setInversion(false);
        break;
      case COMMANDS.INVON:
        this._setInversion(true);
        break;
      case COMMANDS.DISPOFF:
        if (this.displayOn) {
          this.displayOn = false;
          this._markAllDirty();
        }
        break;
      case COMMANDS.DISPON:
        if (!this.displayOn) {
          this.displayOn = true;
          this._markAllDirty();
        }
        break;
      case COMMANDS.RAMWR:
        this.cursorX = this.columnStart;
        this.cursorY = this.rowStart;
        break;
      default:
        break;
    }
  }

  _applyParameters() {
    switch (this.command) {
      case COMMANDS.CASET:
        this.columnStart = (this._parameters[0] << 8) | this._parameters[1];
        this.columnEnd = (this._parameters[2] << 8) | this._parameters[3];
        this.cursorX = this.columnStart;
        break;
      case COMMANDS.RASET:
        this.rowStart = (this._parameters[0] << 8) | this._parameters[1];
        this.rowEnd = (this._parameters[2] << 8) | this._parameters[3];
        this.cursorY = this.rowStart;
        break;
      case COMMANDS.MADCTL:
        this.madctl = this._parameters[0];
        break;
      case COMMANDS.COLMOD:
        this.pixelFormat = this._parameters[0];
        break;
      default:
        break;
    }
  }

  _writePixels(bytes) {
    if (this.pixelFormat !== 0x55 && this.pixelFormat !== 0x05) {
      if (this.strictInference) {
        throw new Error(
          `unsupported COLMOD 0x${this.pixelFormat.toString(16).padStart(2, '0')}`,
        );
      }
      return;
    }

    for (const byte of bytes) {
      if (this._pixelByte === null) {
        this._pixelByte = byte;
        continue;
      }
      const rgb565 = this.byteOrder === 'big'
        ? (this._pixelByte << 8) | byte
        : (byte << 8) | this._pixelByte;
      this._pixelByte = null;
      this._writePixel(rgb565);
    }
  }

  _writePixel(rgb565) {
    const sourceX = this.cursorX;
    const sourceY = this.cursorY;
    this._advanceCursor();

    const point = this._mapCoordinate(sourceX, sourceY);
    if (point.x < 0 || point.x >= this.width || point.y < 0 || point.y >= this.height) {
      return;
    }

    let red = Math.round(((rgb565 >> 11) & 0x1f) * 255 / 31);
    const green = Math.round(((rgb565 >> 5) & 0x3f) * 255 / 63);
    let blue = Math.round((rgb565 & 0x1f) * 255 / 31);
    if (this.madctl & 0x08) {
      [red, blue] = [blue, red];
    }

    const offset = (point.y * this.width + point.x) * 4;
    const invertOutput = this.inverted !== this.nativeInverted;
    this.framebuffer[offset] = invertOutput ? 255 - red : red;
    this.framebuffer[offset + 1] = invertOutput ? 255 - green : green;
    this.framebuffer[offset + 2] = invertOutput ? 255 - blue : blue;
    this.framebuffer[offset + 3] = 255;
    this._markDirty(point.x, point.y);
  }

  _advanceCursor() {
    if (this.columnStart > this.columnEnd || this.rowStart > this.rowEnd) {
      return;
    }
    this.cursorX += 1;
    if (this.cursorX > this.columnEnd) {
      this.cursorX = this.columnStart;
      this.cursorY += 1;
      if (this.cursorY > this.rowEnd) {
        this.cursorY = this.rowStart;
      }
    }
  }

  _mapCoordinate(x, y) {
    const mx = Boolean(this.madctl & 0x40);
    const my = Boolean(this.madctl & 0x80);
    const mv = Boolean(this.madctl & 0x20);

    if (!mv) {
      return {
        x: mx ? this.width - 1 - x : x,
        y: my ? this.height - 1 - y : y,
      };
    }
    return {
      x: my ? this.width - 1 - y : y,
      y: mx ? this.height - 1 - x : x,
    };
  }

  _setInversion(inverted) {
    if (this.inverted === inverted) {
      return;
    }
    this.inverted = inverted;
    for (let offset = 0; offset < this.framebuffer.length; offset += 4) {
      this.framebuffer[offset] = 255 - this.framebuffer[offset];
      this.framebuffer[offset + 1] = 255 - this.framebuffer[offset + 1];
      this.framebuffer[offset + 2] = 255 - this.framebuffer[offset + 2];
    }
    this._markAllDirty();
  }

  _markDirty(x, y) {
    if (this._dirty === null) {
      this._dirty = { x, y, width: 1, height: 1 };
      return;
    }
    const right = Math.max(this._dirty.x + this._dirty.width - 1, x);
    const bottom = Math.max(this._dirty.y + this._dirty.height - 1, y);
    this._dirty.x = Math.min(this._dirty.x, x);
    this._dirty.y = Math.min(this._dirty.y, y);
    this._dirty.width = right - this._dirty.x + 1;
    this._dirty.height = bottom - this._dirty.y + 1;
  }

  _markAllDirty() {
    this._dirty = { x: 0, y: 0, width: this.width, height: this.height };
  }

  getDirtyRegion() {
    return this._dirty === null ? null : { ...this._dirty };
  }

  consumeDirtyRegion() {
    const dirtyRegion = this.getDirtyRegion();
    this._dirty = null;
    return dirtyRegion;
  }

  _result() {
    return {
      framebuffer: this.framebuffer,
      dirtyRegion: this.getDirtyRegion(),
    };
  }
}

const ST7789P3 = ST7789;

export { COMMANDS, HEIGHT, ST7789, ST7789P3, WIDTH };
export default ST7789;
