const I2S_BASE = 0x6002d000;
const I2S_RX_CONF = I2S_BASE + 0x20;
const I2S_TX_CONF = I2S_BASE + 0x24;
const I2S_RX_CONF1 = I2S_BASE + 0x28;
const I2S_TX_CONF1 = I2S_BASE + 0x2c;
const I2S_RX_CLKM_CONF = I2S_BASE + 0x30;
const I2S_TX_CLKM_CONF = I2S_BASE + 0x34;
const I2S_RX_CLKM_DIV_CONF = I2S_BASE + 0x38;
const I2S_TX_CLKM_DIV_CONF = I2S_BASE + 0x3c;
const I2S_RX_TDM_CTRL = I2S_BASE + 0x50;
const I2S_TX_TDM_CTRL = I2S_BASE + 0x54;
const I2S_START = 1 << 2;

const GDMA_BASE = 0x6003f000;
const GDMA_CHANNEL_STRIDE = 0xc0;
const GDMA_IN_LINK = 0x80;
const GDMA_IN_PERI = 0xa0;
const GDMA_OUT_LINK = 0xe0;
const GDMA_OUT_PERI = 0x100;
const GDMA_LINK_ADDR_MASK = 0x000fffff;
const GDMA_LINK_START = 1 << 21;
const GDMA_PERIPHERAL_I2S = 3;
const GDMA_MACHINE_OFFSET = 5040;
const GDMA_MACHINE_STRIDE = 56;
const DRAM_ADDRESS_PREFIX = 0x3fc00000;
const GDMA_IRQ_BASE = 44;
const DESCRIPTOR_LIMIT = 256;

function countActiveChannels(mask) {
  let bits = mask & 0xffff;
  let count = 0;
  while (bits) {
    bits &= bits - 1;
    count += 1;
  }
  return count;
}

function decodeDmaChannels(conf, tdmCtrl) {
  const skipInactiveSlots = Boolean(tdmCtrl & (1 << 20));
  const totalSlots = ((tdmCtrl >>> 16) & 0xf) + 1;
  const activeChannels = countActiveChannels(tdmCtrl);
  const dmaChannels = skipInactiveSlots ? totalSlots : activeChannels;
  if (dmaChannels === 1 || dmaChannels === 2) return dmaChannels;
  return conf & (1 << 5) ? 1 : 2;
}

function decodeI2sFormat(registers, fallback) {
  const { conf, conf1, clkmConf, clkmDivConf, tdmCtrl = 0 } = registers;
  if (!(conf & I2S_START) || (conf & (1 << 3)) || (conf & (1 << 20))) {
    return { ...fallback };
  }
  const sourceSelection = (clkmConf >>> 27) & 0x3;
  const sourceClock = sourceSelection === 0
    ? 40_000_000
    : sourceSelection === 2 ? 160_000_000 : 0;
  const integer = clkmConf & 0xff;
  const yn1 = (clkmDivConf >>> 27) & 0x1;
  const x = (clkmDivConf >>> 18) & 0x1ff;
  const y = (clkmDivConf >>> 9) & 0x1ff;
  const z = clkmDivConf & 0x1ff;
  const denominator = z ? (x + 1) * z + y : 1;
  const fraction = z
    ? (yn1 ? 1 - z / denominator : z / denominator)
    : 0;
  const bclkDiv = ((conf1 >>> 7) & 0x3f) + 1;
  const bits = ((conf1 >>> 13) & 0x1f) + 1;
  const slotBits = ((conf1 >>> 18) & 0x3f) + 1;
  const clockDivider = integer + fraction;
  const sampleRate = Math.round(
    sourceClock / clockDivider / bclkDiv / (2 * slotBits),
  );
  if (
    !sourceClock ||
    clockDivider <= 0 ||
    bits !== 16 ||
    sampleRate < 1000 ||
    sampleRate > 384000
  ) {
    return { ...fallback };
  }
  return {
    sampleRate,
    bits,
    channels: decodeDmaChannels(conf, tdmCtrl),
  };
}

function descriptorFields(word) {
  return {
    size: word & 0xfff,
    length: (word >>> 12) & 0xfff,
    eof: Boolean(word & 0x40000000),
    owner: Boolean(word & 0x80000000),
  };
}

function replaceDescriptorLength(word, length) {
  return (
    (word & ~0x00fff000) |
    ((length & 0xfff) << 12)
  ) >>> 0;
}

function transferDurationMs(bytes, format) {
  if (!bytes) return 0;
  return bytes * 1000 /
    (format.sampleRate * format.channels * (format.bits / 8));
}

function advanceDmaDeadline(previous, now, intervalMs) {
  if (!previous || now - previous > intervalMs * 4) {
    return now + intervalMs;
  }
  return previous + intervalMs;
}

function emitAudioPacket(onAudio, packet) {
  const byteLength = packet.bytes.byteLength;
  onAudio(packet);
  return byteLength;
}

export class Esp32C3I2S {
  constructor(wasm, emulator, statePointer, options = {}) {
    this.wasm = wasm;
    this.emulator = emulator;
    this.statePointer = statePointer;
    this.machinePointer = (emulator.__wbg_ptr + 13296) >>> 0;
    this.onAudio = options.onAudio ?? (() => {});
    this.sampleRate = options.sampleRate ?? 16000;
    this.bits = 16;
    this.channels = options.channels ?? 2;
    this.defaultFormat = {
      sampleRate: this.sampleRate,
      bits: this.bits,
      channels: this.channels,
    };
    this.volume = 100;
    this.nextTx = [0, 0, 0];
    this.nextRx = [0, 0, 0];
    this.txRoots = [0, 0, 0];
    this.rxRoots = [0, 0, 0];
    this.irqAsserted = [false, false, false];
    this.microphone = [];
    this.nextTxAt = 0;
    this.nextRxAt = 0;
  }

  handleRegisterWrite(address, value) {
    // IDF can free/reallocate a DMA ring at the same root address when
    // changing slot format. A stopped/reset channel must forget its cursor.
    if (address === I2S_TX_CONF && (!(value & I2S_START) || (value & 3))) {
      this.nextTx.fill(0);
      this.txRoots.fill(0);
      this.nextTxAt = 0;
    }
    if (address === I2S_RX_CONF && (!(value & I2S_START) || (value & 3))) {
      this.nextRx.fill(0);
      this.rxRoots.fill(0);
      this.nextRxAt = 0;
    }
  }

  setFormat({ sampleRate, bits = 16, channels = 2 }) {
    if (!Number.isInteger(sampleRate) || sampleRate <= 0 || bits !== 16 ||
        (channels !== 1 && channels !== 2)) {
      throw new RangeError('Only positive-rate 16-bit mono/stereo PCM is supported');
    }
    this.sampleRate = sampleRate;
    this.bits = bits;
    this.channels = channels;
    this.defaultFormat = { sampleRate, bits, channels };
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(100, volume));
  }

  pushMicrophone(bytes) {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (const value of input) this.microphone.push(value);
  }

  pump(now = performance.now(), force = false) {
    const txReady = force || now >= this.nextTxAt;
    const rxReady = force || now >= this.nextRxAt;
    const txFormat = this._format('tx');
    const rxFormat = this._format('rx');
    let txBytes = 0;
    let rxBytes = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      // IRQ acknowledgement is independent of the next audio deadline.
      // Leaving a cleared level asserted until then traps the CPU in its ISR.
      if (this._serviceDmaIrq(channel)) continue;
      if (txReady) txBytes += this._pumpTx(channel, txFormat);
      if (rxReady) rxBytes += this._pumpRx(channel);
    }
    const txDelayMs = transferDurationMs(txBytes, txFormat);
    const rxDelayMs = transferDurationMs(rxBytes, rxFormat);
    if (txBytes) {
      this.nextTxAt = advanceDmaDeadline(
        this.nextTxAt,
        now,
        Math.max(1, txDelayMs),
      );
    }
    if (rxBytes) {
      this.nextRxAt = advanceDmaDeadline(
        this.nextRxAt,
        now,
        Math.max(1, rxDelayMs),
      );
    }
    return txBytes + rxBytes;
  }

  _pumpTx(channel, format) {
    if (!(this._i2sRegister(I2S_TX_CONF) & I2S_START)) return 0;
    const channelBase = this._channelBase(channel);
    if (this._memory().getUint32(channelBase + 36, true) !==
        GDMA_PERIPHERAL_I2S) return 0;

    const descriptor = this._currentDescriptor(
      channel,
      'tx',
      GDMA_OUT_LINK,
      this.nextTx,
      this.txRoots,
    );
    if (!descriptor) return 0;
    const first = this._readDescriptor(descriptor);
    if (!first.fields.owner || first.fields.length === 0) return 0;

    const packet = [];
    let current = descriptor;
    let last = descriptor;
    let next = 0;
    for (let count = 0; count < DESCRIPTOR_LIMIT; count += 1) {
      const item = this._readDescriptor(current);
      if (!item.fields.owner) break;
      for (let offset = 0; offset < item.fields.length; offset += 1) {
        packet.push(this._readGuest8(item.buffer + offset));
      }
      last = current;
      next = item.next;
      if (item.fields.eof || !next) break;
      current = next;
    }
    if (packet.length === 0) return 0;

    this.nextTx[channel] = next;
    this._completeDma(channel, 'tx', last);
    const bytes = Uint8Array.from(packet);
    return emitAudioPacket(this.onAudio, {
      type: 'audio',
      port: 0,
      ...format,
      volume: this.volume,
      bytes,
    });
  }

  _pumpRx(channel) {
    if (!(this._i2sRegister(I2S_RX_CONF) & I2S_START)) return 0;
    const channelBase = this._channelBase(channel);
    if (this._memory().getUint32(channelBase + 16, true) !==
        GDMA_PERIPHERAL_I2S) return 0;

    const descriptor = this._currentDescriptor(
      channel,
      'rx',
      GDMA_IN_LINK,
      this.nextRx,
      this.rxRoots,
    );
    if (!descriptor) return 0;
    const item = this._readDescriptor(descriptor);
    if (!item.fields.owner || item.fields.size === 0) return 0;

    for (let offset = 0; offset < item.fields.size; offset += 1) {
      this._writeGuest8(
        item.buffer + offset,
        this.microphone.length ? this.microphone.shift() : 0,
      );
    }
    this._writeGuest32(
      descriptor,
      replaceDescriptorLength(item.word, item.fields.size),
    );
    this.nextRx[channel] = item.next;
    this._completeDma(channel, 'rx', descriptor);
    return item.fields.size;
  }

  _currentDescriptor(channel, direction, linkOffset, cursors, roots) {
    const link = this._readMmio(
      GDMA_BASE + channel * GDMA_CHANNEL_STRIDE + linkOffset,
    );
    if (!(link & GDMA_LINK_START) && !(link & GDMA_LINK_ADDR_MASK)) return 0;
    const root =
      (DRAM_ADDRESS_PREFIX | (link & GDMA_LINK_ADDR_MASK)) >>> 0;
    if (roots[channel] !== root) {
      roots[channel] = root;
      cursors[channel] = root;
    }
    return cursors[channel] || root;
  }

  _readDescriptor(address) {
    const word = this._readGuest32(address);
    return {
      word,
      fields: descriptorFields(word),
      buffer: this._readGuest32(address + 4),
      next: this._readGuest32(address + 8),
    };
  }

  _completeDma(channel, direction, descriptor) {
    const view = this._memory();
    const base = this._channelBase(channel);
    if (direction === 'tx') {
      view.setUint32(base + 32, descriptor, true);
      view.setUint32(base + 48, view.getUint32(base + 48, true) | (1 << 4), true);
    } else {
      view.setUint32(base + 12, descriptor, true);
      view.setUint32(base + 40, view.getUint32(base + 40, true) | (1 << 1), true);
    }
    this._setDmaIrq(channel, true);
  }

  _serviceDmaIrq(channel) {
    const view = this._memory();
    const base = this._channelBase(channel);
    const pending =
      (view.getUint32(base + 40, true) &
        view.getUint32(base + 44, true)) |
      (view.getUint32(base + 48, true) &
        view.getUint32(base + 52, true));
    if (!this.irqAsserted[channel] && pending === 0) return false;
    this._setDmaIrq(channel, pending !== 0);
    return true;
  }

  _setDmaIrq(channel, asserted) {
    this.wasm.ap_board_set_irq(
      this.emulator.__wbg_ptr,
      GDMA_IRQ_BASE + channel,
      asserted ? 1 : 0,
    );
    this.irqAsserted[channel] = asserted;
  }

  _channelBase(channel) {
    return this.machinePointer +
      GDMA_MACHINE_OFFSET +
      channel * GDMA_MACHINE_STRIDE;
  }

  _memory() {
    return new DataView(this.wasm.memory.buffer);
  }

  _i2sRegister(address) {
    return this._memory().getUint32(
      this.statePointer + address - I2S_BASE,
      true,
    );
  }

  _format(direction) {
    const tx = direction === 'tx';
    return decodeI2sFormat({
      conf: this._i2sRegister(tx ? I2S_TX_CONF : I2S_RX_CONF),
      conf1: this._i2sRegister(tx ? I2S_TX_CONF1 : I2S_RX_CONF1),
      clkmConf: this._i2sRegister(
        tx ? I2S_TX_CLKM_CONF : I2S_RX_CLKM_CONF,
      ),
      clkmDivConf: this._i2sRegister(
        tx ? I2S_TX_CLKM_DIV_CONF : I2S_RX_CLKM_DIV_CONF,
      ),
      tdmCtrl: this._i2sRegister(
        tx ? I2S_TX_TDM_CTRL : I2S_RX_TDM_CTRL,
      ),
    }, this.defaultFormat);
  }

  _readMmio(address) {
    return this.wasm.ap_board_debug_read32(
      this.emulator.__wbg_ptr,
      address,
    ) >>> 0;
  }

  _readGuest8(address) {
    return this.wasm.ap_board_read_guest8(
      this.emulator.__wbg_ptr,
      address,
    ) & 0xff;
  }

  _readGuest32(address) {
    return this.wasm.ap_board_read_guest32(
      this.emulator.__wbg_ptr,
      address,
    ) >>> 0;
  }

  _writeGuest8(address, value) {
    this.wasm.ap_board_write_guest8(
      this.emulator.__wbg_ptr,
      address,
      value,
    );
  }

  _writeGuest32(address, value) {
    this.wasm.ap_board_write_guest32(
      this.emulator.__wbg_ptr,
      address,
      value,
    );
  }
}

export {
  advanceDmaDeadline,
  decodeDmaChannels,
  decodeI2sFormat,
  descriptorFields,
  emitAudioPacket,
  replaceDescriptorLength,
  transferDurationMs,
};
