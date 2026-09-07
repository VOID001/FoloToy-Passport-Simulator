const DISPLAY_WIDTH = 240;
const DISPLAY_HEIGHT = 320;

export class QemuRuntime extends EventTarget {
  #worker = null;
  #ready = false;
  #manifest = null;
  #networkDebug = false;

  async start(firmwareUrl) {
    const manifest = await this.#loadManifest();
    const response = await fetch(firmwareUrl || manifest.firmware, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Firmware request failed: ${response.status}`);
    }
    this.#launchWorker(manifest, await response.arrayBuffer());
  }

  async loadFirmware(firmware) {
    const manifest = await this.#loadManifest();
    this.#launchWorker(manifest, firmware);
  }

  async #loadManifest() {
    if (this.#manifest) return this.#manifest;

    const manifestResponse = await fetch("/wasm/manifest.json", { cache: "no-store" });
    if (!manifestResponse.ok) {
      throw new Error("WASM QEMU runtime is not installed.");
    }

    this.#manifest = await manifestResponse.json();
    return this.#manifest;
  }

  #launchWorker(manifest, firmware) {
    this.#worker?.terminate();
    this.#ready = false;
    this.dispatchEvent(new CustomEvent("state", { detail: "loading" }));
    this.dispatchEvent(new CustomEvent("firmware", {
      detail: { bytes: new Uint8Array(firmware.slice(0)) },
    }));

    this.#worker = new Worker(manifest.worker, { type: "module" });
    this.#worker.addEventListener("message", (event) => this.#onMessage(event));
    const message = {
      type: "start",
      firmware,
      networkDebug: this.#networkDebug,
    };
    this.#worker.postMessage(message, [firmware]);
  }

  setButton(name, pressed) {
    if (!this.#ready || !this.#worker) return false;
    const button = qemuButtonState(name, pressed);
    this.#worker.postMessage({ type: "button", ...button });
    return true;
  }

  sendButtonGesture(name, gesture) {
    if (!this.#ready || !this.#worker) return false;
    const button = qemuButtonGesture(name, gesture);
    this.#worker.postMessage({ type: "button-gesture", ...button });
    return true;
  }

  releaseButtons() {
    if (!this.#ready || !this.#worker) return false;
    this.#worker.postMessage({ type: "release-buttons" });
    return true;
  }

  sendMicrophone(bytes) {
    if (!this.#ready || !this.#worker) return false;
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.#worker.postMessage({ type: "microphone", bytes: data }, [data.buffer]);
    return true;
  }

  sendUart(bytes) {
    if (!this.#ready || !this.#worker) return false;
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.#worker.postMessage({ type: "uart-input", bytes: data }, [data.buffer]);
    return true;
  }

  setNetworkDebug(enabled) {
    this.#networkDebug = Boolean(enabled);
    this.#worker?.postMessage({
      type: "network-debug",
      enabled: this.#networkDebug,
    });
  }

  restart() {
    if (!this.#worker) return false;
    this.#ready = false;
    this.dispatchEvent(new CustomEvent("state", { detail: "restarting" }));
    this.#worker.postMessage({ type: "restart" });
    return true;
  }

  #onMessage(event) {
    const { type } = event.data;
    if (type === "state") {
      this.dispatchEvent(new CustomEvent("state", { detail: event.data.state }));
    } else if (type === "ready") {
      this.#ready = true;
      this.dispatchEvent(new CustomEvent("state", { detail: "running" }));
    } else if (type === "frame") {
      this.dispatchEvent(new CustomEvent("frame", { detail: event.data }));
    } else if (type === "uart") {
      this.dispatchEvent(new CustomEvent("uart", { detail: event.data.data }));
    } else if (type === "audio_config") {
      this.dispatchEvent(new CustomEvent("audio-config", { detail: event.data }));
    } else if (type === "audio") {
      this.dispatchEvent(new CustomEvent("audio", { detail: event.data }));
    } else if (type === "debug") {
      this.dispatchEvent(new CustomEvent("debug", { detail: event.data }));
    } else if (type === "warning") {
      this.dispatchEvent(new CustomEvent("warning", { detail: event.data.message }));
    } else if (type === "network-status") {
      this.dispatchEvent(new CustomEvent("network-status", {
        detail: event.data.detail,
      }));
    } else if (type === "network-event") {
      this.dispatchEvent(new CustomEvent("network-event", {
        detail: event.data.detail,
      }));
    } else if (type === "unsupported-feature") {
      this.#ready = false;
      this.dispatchEvent(new CustomEvent("unsupported-feature", {
        detail: { feature: event.data.feature },
      }));
    } else if (type === "error") {
      this.dispatchEvent(new CustomEvent("error", { detail: event.data.message }));
    }
  }
}

const qemuButtons = new Set(["UP", "DOWN", "OK"]);
const qemuButtonGestures = new Set(["CLICK", "DOUBLE", "LONG"]);

export function qemuButtonState(key, pressed) {
  if (!qemuButtons.has(key)) {
    throw new RangeError(`Unsupported QEMU button: ${key}`);
  }
  if (typeof pressed !== "boolean") {
    throw new TypeError("Button state must be boolean");
  }
  return { name: key, pressed };
}

export function qemuButtonGesture(key, gesture) {
  if (!qemuButtons.has(key)) {
    throw new RangeError(`Unsupported QEMU button: ${key}`);
  }
  if (!qemuButtonGestures.has(gesture)) {
    throw new RangeError(`Unsupported QEMU button gesture: ${gesture}`);
  }
  return { name: key, gesture };
}
