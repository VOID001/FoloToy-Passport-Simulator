const DEFAULT_MAX_CHARS = 250_000;
const ANSI_OSC_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const ANSI_CSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function normalizeUartText(value) {
  return String(value ?? "")
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "");
}

export function encodeUartCommand(value) {
  return new TextEncoder().encode(`${String(value ?? "")}\r`);
}

export class UartConsoleBuffer {
  #maxChars;
  #text = "";
  #totalBytes = 0;
  #droppedChars = 0;

  constructor({ maxChars = DEFAULT_MAX_CHARS } = {}) {
    if (!Number.isInteger(maxChars) || maxChars < 1) {
      throw new RangeError("maxChars must be a positive integer");
    }
    this.#maxChars = maxChars;
  }

  append(value) {
    const text = normalizeUartText(value);
    if (!text) return this.snapshot();
    this.#totalBytes += new TextEncoder().encode(text).byteLength;
    this.#text += text;
    if (this.#text.length > this.#maxChars) {
      const overflow = this.#text.length - this.#maxChars;
      const newline = this.#text.indexOf("\n", overflow);
      const removed = newline >= 0 ? newline + 1 : overflow;
      this.#text = this.#text.slice(removed);
      this.#droppedChars += removed;
    }
    return this.snapshot();
  }

  clear() {
    this.#text = "";
    this.#totalBytes = 0;
    this.#droppedChars = 0;
    return this.snapshot();
  }

  snapshot() {
    const trailingLine = this.#text && !this.#text.endsWith("\n") ? 1 : 0;
    const lineCount = (this.#text.match(/\n/g) || []).length + trailingLine;
    return {
      text: this.#text,
      lineCount,
      totalBytes: this.#totalBytes,
      droppedChars: this.#droppedChars,
    };
  }
}
