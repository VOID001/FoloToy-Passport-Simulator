export const EMULATOR_WIFI_SSID = "Emulator Host Bridge";
export const EMULATOR_WIFI_PASSWORD = "";
const MAX_RECONNECT_DELAY_MS = 30_000;

export function reconnectDelayMs(attempt, random = Math.random) {
  const normalizedAttempt = Number.isSafeInteger(attempt) && attempt > 0
    ? attempt
    : 0;
  const base = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * (2 ** normalizedAttempt));
  const randomValue = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.round(base * (0.5 + randomValue * 0.5));
}

export function unpackEthernetFrames(bytes) {
  const frames = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength) {
      throw new Error(`Truncated Wi-Fi frame prefix at ${offset}`);
    }
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length < 14 || offset + length > bytes.byteLength) {
      throw new Error(`Invalid Wi-Fi Ethernet frame length ${length}`);
    }
    frames.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  return frames;
}

export class EmulatorNetworkBridge {
  constructor(emulator, options = {}) {
    this.emulator = emulator;
    this.url = options.url;
    this.WebSocketClass = options.WebSocketClass ?? WebSocket;
    this.onStatus = options.onStatus ?? (() => {});
    this.onEvent = options.onEvent ?? (() => {});
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimeout ??
      ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
    this.socket = null;
    this.stats = {
      state: "connecting",
      txFrames: 0,
      txBytes: 0,
      rxFrames: 0,
      rxBytes: 0,
    };
    this.lastReportedAt = 0;
    this.retryAttempt = 0;
    this.retryTimer = null;
    this.stopped = true;
    this.debugEnabled = false;
  }

  connect() {
    this.close();
    this.stopped = false;
    this.retryAttempt = 0;
    this.#open();
  }

  #open() {
    this.stats.state = "connecting";
    this.#report(true);
    const socket = new this.WebSocketClass(this.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.stats.state = "connected";
      this.retryAttempt = 0;
      socket.send(JSON.stringify({
        type: "network-debug",
        enabled: this.debugEnabled,
      }));
      this.#report(true);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stats.state = "offline";
      this.#report(true);
      if (!this.stopped) {
        const delayMs = reconnectDelayMs(this.retryAttempt, this.random);
        this.retryAttempt += 1;
        this.retryTimer = this.setTimer(() => {
          this.retryTimer = null;
          if (!this.stopped) this.#open();
        }, delayMs);
      }
    });
    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.stats.state = "error";
      this.#report(true);
      socket.close();
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data === "string") {
        try {
          const detail = JSON.parse(event.data);
          if (this.debugEnabled || detail.event === "bridge-ready") {
            this.onEvent(detail);
          }
        } catch {
          this.onEvent({ event: "warning", message: "Invalid network bridge event" });
        }
        return;
      }
      const frame = new Uint8Array(event.data);
      if (frame.byteLength < 14) return;
      this.emulator.wifi_rx_push(frame);
      this.stats.rxFrames += 1;
      this.stats.rxBytes += frame.byteLength;
      this.#report();
    });
  }

  drain() {
    if (
      !this.socket ||
      this.socket.readyState !== this.WebSocketClass.OPEN
    ) {
      return;
    }
    const packed = this.emulator.wifi_tx_drain();
    for (const frame of unpackEthernetFrames(packed)) {
      this.socket.send(frame);
      this.stats.txFrames += 1;
      this.stats.txBytes += frame.byteLength;
    }
    this.#report();
  }

  setDebugEnabled(enabled) {
    this.debugEnabled = Boolean(enabled);
    if (
      this.socket &&
      this.socket.readyState === this.WebSocketClass.OPEN
    ) {
      this.socket.send(JSON.stringify({
        type: "network-debug",
        enabled: this.debugEnabled,
      }));
    }
  }

  close() {
    this.stopped = true;
    this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close();
  }

  #report(force = false) {
    const now = performance.now();
    if (!force && now - this.lastReportedAt < 250) return;
    this.lastReportedAt = now;
    this.onStatus({ ...this.stats });
  }
}
