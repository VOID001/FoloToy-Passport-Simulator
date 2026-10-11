/** Scriptable text console. Input is never echoed or executed as JavaScript. */
export class SimulatorSerial {
  #runtime;
  #text = "";
  #cursor = 0;
  #maxChars;
  #waiters = new Set();
  #disposed = false;
  #commandPending = false;
  #state = "waiting";
  #onUart;
  #onState;
  #onFailure;

  constructor(runtime, { maxChars = 250_000 } = {}) {
    if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError("Invalid buffer size");
    this.#runtime = runtime;
    this.#maxChars = maxChars;
    this.#onUart = (event) => {
      const text = String(event.detail);
      this.#cursor += text.length;
      this.#text = (this.#text + text).slice(-this.#maxChars);
      for (const check of [...this.#waiters]) check();
    };
    this.#onState = (event) => {
      this.#state = event.detail;
      if (event.detail !== "running") this.#reset("Simulator stopped or reloaded");
    };
    runtime.addEventListener("uart", this.#onUart);
    runtime.addEventListener("state", this.#onState);
    this.#onFailure = () => { this.#state = "error"; this.#reset("Simulator error or unsupported feature"); };
    runtime.addEventListener("error", this.#onFailure);
    runtime.addEventListener("unsupported-feature", this.#onFailure);
  }

  get state() { return this.#state; }
  get cursor() { return this.#cursor; }

  read({ since = this.#cursor - this.#text.length } = {}) {
    this.#assertLive();
    if (!Number.isSafeInteger(since) || since < 0 || since > this.#cursor) {
      throw new RangeError("Invalid serial cursor");
    }
    const start = this.#cursor - this.#text.length;
    if (since < start) throw new RangeError("Serial data expired; use a new cursor");
    return { text: this.#text.slice(since - start), cursor: this.#cursor };
  }

  write(value) {
    this.#assertLive();
    if (this.#state === "error") throw new Error("Simulator is not running");
    if (typeof value !== "string" && !(value instanceof Uint8Array)) {
      throw new TypeError("Serial input must be text or Uint8Array");
    }
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
    if (!bytes.length || bytes.length > 4096) throw new RangeError("Serial write must contain 1–4096 bytes");
    const sentBytes = bytes.length;
    if (!this.#runtime.sendUart(bytes)) throw new Error("Simulator is not running");
    return { sentBytes };
  }

  waitFor(match, { since = this.#cursor, timeoutMs = 3000, signal } = {}) {
    this.#assertLive();
    if (!(typeof match === "string" && match.length) && !(match instanceof RegExp)) {
      throw new TypeError("Expected nonempty text or RegExp");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new RangeError("Timeout must be 1–120000 ms");
    }
    this.read({ since });
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, result) => {
        clearTimeout(timer);
        this.#waiters.delete(check);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => finish(new Error("Serial wait aborted"));
      const check = (error) => {
        if (error) return finish(error);
        try {
          const result = this.read({ since });
          if (match instanceof RegExp) match.lastIndex = 0;
          const found = typeof match === "string" ? result.text.includes(match) : match.test(result.text);
          if (found) finish(null, result);
        } catch (error) { finish(error); }
      };
      if (signal?.aborted) { abort(); return; }
      timer = setTimeout(() => finish(new Error("Serial response timed out")), timeoutMs);
      this.#waiters.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      check();
    });
  }

  async command(text, { terminator = "\r", match, timeoutMs, signal } = {}) {
    if (typeof text !== "string" || /[\r\n]/.test(text)) throw new TypeError("Command must be one text line");
    if (!["\r", "\n", "\r\n", ""].includes(terminator)) throw new RangeError("Invalid line terminator");
    if (this.#commandPending) throw new Error("A serial command is already awaiting its response");
    const since = this.cursor;
    if (match === undefined) return { ...this.write(text + terminator), cursor: since };
    this.#commandPending = true;
    const cancel = new AbortController();
    const abort = () => cancel.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      // Listen first, so a synchronous reply cannot be lost.
      const response = this.waitFor(match, { since, timeoutMs, signal: cancel.signal });
      response.catch(() => {});
      if (signal?.aborted) { cancel.abort(); return await response; }
      this.write(text + terminator);
      return await response;
    } finally {
      cancel.abort();
      signal?.removeEventListener("abort", abort);
      this.#commandPending = false;
    }
  }

  clear() {
    this.#assertLive();
    this.#reset("Serial buffer cleared");
  }

  dispose() {
    if (this.#disposed) return;
    this.#reset("Serial API disposed");
    this.#runtime.removeEventListener("uart", this.#onUart);
    this.#runtime.removeEventListener("state", this.#onState);
    this.#runtime.removeEventListener("error", this.#onFailure);
    this.#runtime.removeEventListener("unsupported-feature", this.#onFailure);
    this.#disposed = true;
  }

  #assertLive() {
    if (this.#disposed) throw new Error("Serial API disposed");
  }

  #reset(message) {
    for (const check of [...this.#waiters]) check(new Error(message));
    this.#text = "";
  }
}
