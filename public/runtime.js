const DISPLAY_WIDTH = 240;
const DISPLAY_HEIGHT = 320;

export class QemuRuntime extends EventTarget {
  #worker = null;
  #ready = false;
  #manifest = null;
  #networkDebug = false;

  async start(firmwareUrl) {
    this.#ready = false;
    this.dispatchEvent(new CustomEvent("state", { detail: "loading" }));
    this.#reportProgress(3, "正在读取运行配置", "定位 QEMU WASM 运行时");
    const manifest = await this.#loadManifest();
    this.#reportProgress(7, "正在请求固件", firmwareUrl || manifest.firmware);
    const response = await fetch(firmwareUrl || manifest.firmware, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Firmware request failed: ${response.status}`);
    }
    const firmware = await this.#readFirmwareResponse(response);
    this.#launchWorker(manifest, firmware);
  }

  async loadFirmware(firmware) {
    this.#reportProgress(64, "正在准备虚拟设备", "加载 QEMU WASM 运行配置");
    const manifest = await this.#loadManifest();
    this.#launchWorker(manifest, firmware);
  }

  #reportProgress(value, stage, detail) {
    this.dispatchEvent(new CustomEvent("progress", {
      detail: { value, stage, detail },
    }));
  }

  async #readFirmwareResponse(response) {
    const total = Number(response.headers.get("content-length")) || 0;
    if (!response.body) {
      const firmware = await response.arrayBuffer();
      this.#reportProgress(60, "固件下载完成", formatProgressBytes(firmware.byteLength));
      return firmware;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      const progress = total > 0
        ? 8 + (loaded / total) * 52
        : Math.min(58, 8 + Math.log2(loaded / 1024 + 1) * 5);
      const detail = total > 0
        ? `${formatProgressBytes(loaded)} / ${formatProgressBytes(total)}`
        : `${formatProgressBytes(loaded)} 已下载`;
      this.#reportProgress(progress, "正在下载固件", detail);
    }

    const bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.#reportProgress(60, "固件下载完成", formatProgressBytes(loaded));
    return bytes.buffer;
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
    this.#reportProgress(66, "正在启动工作线程", "创建隔离的模拟器运行环境");
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
    this.#reportProgress(18, "正在重启虚拟设备", "重置处理器与外设状态");
    this.#worker.postMessage({ type: "restart" });
    return true;
  }

  #onMessage(event) {
    const { type } = event.data;
    if (type === "state") {
      this.dispatchEvent(new CustomEvent("state", { detail: event.data.state }));
    } else if (type === "progress") {
      this.#reportProgress(
        event.data.value,
        event.data.stage,
        event.data.detail,
      );
    } else if (type === "ready") {
      this.#ready = true;
      this.#reportProgress(100, "装载完成", "固件已启动");
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

function formatProgressBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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
