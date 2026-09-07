import { QemuRuntime } from "./runtime.js";
import { BrowserAudio } from "./audio.js";
import {
  formatFirmwareSize,
  resolveFirmwarePresetId,
  validateFirmwareFile,
} from "./firmware.js";
import {
  UartConsoleBuffer,
  encodeUartCommand,
} from "./uart-console.js";
import {
  REGISTER_NAMES,
  formatHex32,
} from "./inspector.js";
import { showSimulatorNoticeOnce } from "./simulator-notice.js";

const DOUBLE_CLICK_WINDOW_MS = 300;
const LONG_PRESS_MS = 300;


const runtime = new QemuRuntime();
const audio = new BrowserAudio((bytes) => runtime.sendMicrophone(bytes));
const display = document.querySelector("#qemu-display");
const context = display.getContext("2d", { alpha: false });
const overlay = document.querySelector("#screen-overlay");
const runtimeState = document.querySelector("#runtime-state");
const runtimeLight = document.querySelector("#runtime-light");
const logElement = document.querySelector("#event-log");
const uploadControl = document.querySelector("#firmware-upload");
const uploadLabel = uploadControl.querySelector(".upload-label");
const firmwareInput = document.querySelector("#firmware-file");
const firmwareGuidance = document.querySelector("#firmware-guidance");
const firmwareGuidanceTitle = document.querySelector("#firmware-guidance-title");
const simulatorNotice = document.querySelector("#simulator-notice");
const confirmFirmwareUpload = document.querySelector("#confirm-firmware-upload");
const firmwareSourceTabList = document.querySelector(".firmware-source-tabs");
const firmwareSourceTabs = [...document.querySelectorAll(".firmware-source-tab")];
const firmwareSourcePanels = [...document.querySelectorAll(".firmware-source-panel")];
const communityPlayUrl = document.querySelector("#community-play-url");
const presetButtons = [...document.querySelectorAll(".firmware-preset")];
const presetButtonsById = new Map(
  presetButtons.map((button) => [button.dataset.firmwareId, button]),
);
const initialPresetId = resolveFirmwarePresetId(
  window.location.search,
  presetButtonsById.keys(),
);
const initialPresetButton = presetButtonsById.get(initialPresetId);
const presetFeedback = document.querySelector("#preset-feedback");
const inspectorToggle = document.querySelector("#inspector-toggle");
const fullscreenToggle = document.querySelector("#fullscreen-toggle");
const simulatorStage = document.querySelector("#simulator-stage");
const audioEnable = document.querySelector("#audio-enable");
const microphoneToggle = document.querySelector("#microphone-toggle");
const inspectorPanel = document.querySelector("#debug-panel");
const debugSource = document.querySelector("#debug-source");
const debugPc = document.querySelector("#debug-pc");
const debugCycles = document.querySelector("#debug-cycles");
const debugSp = document.querySelector("#debug-sp");
const debugSampleState = document.querySelector("#debug-sample-state");
const registerGrid = document.querySelector("#register-grid");
const uartState = document.querySelector("#uart-state");
const uartStats = document.querySelector("#uart-stats");
const uartOutput = document.querySelector("#uart-output");
const uartEmpty = document.querySelector("#uart-empty");
const uartAutoscroll = document.querySelector("#uart-autoscroll");
const uartPause = document.querySelector("#uart-pause");
const uartClear = document.querySelector("#uart-clear");
const uartInputForm = document.querySelector("#uart-input-form");
const uartInput = document.querySelector("#uart-input");
const networkState = document.querySelector("#network-state");
const networkStateLight = document.querySelector("#network-state-light");
const networkGateway = document.querySelector("#network-gateway");
const networkPolicy = document.querySelector("#network-policy");
const networkTx = document.querySelector("#network-tx");
const networkTxFrames = document.querySelector("#network-tx-frames");
const networkRx = document.querySelector("#network-rx");
const networkRxFrames = document.querySelector("#network-rx-frames");
const networkEvents = document.querySelector("#network-events");
const networkEmpty = document.querySelector("#network-empty");
let activeFirmwareName = initialPresetButton.dataset.firmwareName;
let activePresetId = initialPresetId;
let pendingPresetId = initialPresetId;
let currentRuntimeState = "waiting";
let activeDebugTab = "cpu";
let latestDebugSnapshot = null;
let renderedRegisters = new Uint32Array(32);
const uartBuffer = new UartConsoleBuffer();
let uartPaused = false;
let uartRenderPending = false;
let allowLocalFirmwareUpload = false;
let fullscreenFallback = false;
const heldPointerButtons = new Set();
const heldKeyboardButtons = new Set();
const activeButtonGestures = new Map();
const pendingButtonClicks = new Map();

function log(message) {
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString("zh-CN", { hour12: false })}  ${message}`;
  logElement.prepend(item);
  while (logElement.children.length > 3) logElement.lastElementChild.remove();
}

function renderUartConsole() {
  uartRenderPending = false;
  const snapshot = uartBuffer.snapshot();
  uartOutput.textContent = snapshot.text;
  uartEmpty.hidden = Boolean(snapshot.text);
  uartStats.textContent =
    `${snapshot.lineCount.toLocaleString("en-US")} lines · ` +
    `${formatFirmwareSize(snapshot.totalBytes)}`;
  uartStats.title = snapshot.droppedChars ?
    `${snapshot.droppedChars.toLocaleString("en-US")} 个旧字符已丢弃` :
    "UART 缓冲区";
  if (uartAutoscroll.checked) uartOutput.scrollTop = uartOutput.scrollHeight;
}

function scheduleUartRender() {
  if (uartPaused || uartRenderPending || activeDebugTab !== "uart") return;
  uartRenderPending = true;
  requestAnimationFrame(renderUartConsole);
}

function clearUartConsole() {
  uartBuffer.clear();
  renderUartConsole();
}

function resetNetworkView() {
  networkState.textContent = "CONNECTING";
  networkStateLight.dataset.state = "connecting";
  networkTx.textContent = "0 B";
  networkTxFrames.textContent = "0 frames";
  networkRx.textContent = "0 B";
  networkRxFrames.textContent = "0 frames";
  networkEvents.replaceChildren();
  networkEmpty.hidden = false;
}

function formatNetworkBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return formatFirmwareSize(bytes);
}

function renderNetworkStatus(status) {
  const labels = {
    connected: "ONLINE",
    connecting: "CONNECTING",
    offline: "OFFLINE",
    error: "ERROR",
  };
  networkState.textContent = labels[status.state] ?? String(status.state).toUpperCase();
  networkStateLight.dataset.state = status.state;
  networkTx.textContent = formatNetworkBytes(status.txBytes);
  networkTxFrames.textContent = `${status.txFrames.toLocaleString("en-US")} frames`;
  networkRx.textContent = formatNetworkBytes(status.rxBytes);
  networkRxFrames.textContent = `${status.rxFrames.toLocaleString("en-US")} frames`;
}

function appendNetworkEvent(detail) {
  if (detail.event === "bridge-ready") {
    networkGateway.textContent = detail.gateway;
    networkPolicy.textContent = detail.privateTargets ? "LAN ENABLED" : "PUBLIC ONLY";
    return;
  }
  const labels = {
    "connection-opening": "OPENING",
    "connection-open": "OPEN",
    "connection-close": "CLOSED",
    "connection-error": "ERROR",
    "connection-blocked": "BLOCKED",
  };
  if (!labels[detail.event]) return;
  const item = document.createElement("li");
  item.className = "network-event";
  item.dataset.event = detail.event;
  const protocol = document.createElement("span");
  protocol.className = "network-event-protocol";
  protocol.textContent = detail.protocol;
  const target = document.createElement("span");
  target.className = "network-event-target";
  target.textContent = detail.target;
  target.title = detail.message ?
    `${detail.target} · ${detail.message}` :
    detail.target;
  const state = document.createElement("span");
  state.className = "network-event-state";
  state.textContent = labels[detail.event];
  item.append(protocol, target, state);
  networkEvents.prepend(item);
  while (networkEvents.children.length > 40) {
    networkEvents.lastElementChild.remove();
  }
  networkEmpty.hidden = true;
}

function setUartPaused(paused) {
  uartPaused = paused;
  uartState.textContent = paused ? "PAUSED" : "LIVE";
  uartState.parentElement.dataset.state = paused ? "paused" : "live";
  uartPause.textContent = paused ? "▶" : "Ⅱ";
  uartPause.setAttribute("aria-pressed", String(paused));
  uartPause.setAttribute("aria-label", paused ? "继续 UART 输出" : "暂停 UART 输出");
  uartPause.title = paused ? "继续" : "暂停";
  if (!paused) scheduleUartRender();
}

function setRuntimeState(state, detail) {
  currentRuntimeState = state;
  runtimeState.textContent = detail || state;
  runtimeState.title = detail || state;
  runtimeLight.dataset.state = state;
  const uartReady = state === "running";
  uartInput.disabled = !uartReady;
  uartInputForm.querySelector("button").disabled = !uartReady;
  if (state === "running") overlay.hidden = true;
  else overlay.hidden = false;
}

function setUploadBusy(busy) {
  firmwareInput.disabled = busy || !allowLocalFirmwareUpload;
  uploadControl.disabled = busy;
  uploadControl.setAttribute("aria-disabled", String(busy));
  uploadControl.setAttribute("aria-busy", String(busy));
  confirmFirmwareUpload.disabled = busy;
  communityPlayUrl.disabled = busy;
  firmwareSourceTabs.forEach((button) => {
    button.disabled = busy;
  });
  presetButtons.forEach((button) => {
    button.disabled = busy;
  });
}

function renderPresetStates() {
  presetButtons.forEach((button) => {
    const active = button.dataset.firmwareId === activePresetId;
    const loading =
      button.dataset.firmwareId === pendingPresetId &&
      currentRuntimeState === "loading";
    button.classList.toggle("is-active", active);
    button.classList.toggle("is-loading", loading);
    button.setAttribute("aria-pressed", String(active));
    button.querySelector(".preset-state").textContent =
      loading ? "加载中" : active ? "当前" : "运行";
  });
}

function clearDisplay() {
  context.fillStyle = "#02070d";
  context.fillRect(0, 0, display.width, display.height);
}

function resetScreenOverlay() {
  overlay.classList.remove("is-unsupported");
  overlay.querySelector(".loading-dot").hidden = false;
  overlay.querySelector("strong").textContent = "QEMU WASM";
}

function buildRegisterGrid() {
  const fragment = document.createDocumentFragment();
  REGISTER_NAMES.forEach((name, index) => {
    const row = document.createElement("div");
    row.className = "register";
    row.dataset.register = String(index);

    const label = document.createElement("span");
    label.className = "register-name";
    label.textContent = `x${index} · ${name}`;
    const value = document.createElement("span");
    value.className = "register-value";
    value.textContent = "0x00000000";
    row.append(label, value);
    fragment.append(row);
  });
  registerGrid.replaceChildren(fragment);
}

function renderDebugSnapshot(snapshot) {
  if (!snapshot) return;
  debugPc.textContent = formatHex32(snapshot.pc);
  debugCycles.textContent = Number(snapshot.cycles).toLocaleString("en-US");
  debugSp.textContent = formatHex32(snapshot.registers[2]);
  debugSampleState.textContent = `LIVE · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;

  registerGrid.querySelectorAll(".register").forEach((row, index) => {
    const value = Number(snapshot.registers[index]) >>> 0;
    row.classList.toggle("has-changed", renderedRegisters[index] !== value);
    row.querySelector(".register-value").textContent = formatHex32(value);
    renderedRegisters[index] = value;
  });
}

function updateInspectorSource() {
  debugSource.textContent = activeFirmwareName;
}

function syncNetworkDebugState() {
  const enabled =
    activeDebugTab === "network" &&
    inspectorPanel.classList.contains("is-open");
  runtime.setNetworkDebug(enabled);
}

function selectDebugTab(tab) {
  activeDebugTab = tab;
  document.querySelectorAll("[data-debug-tab]").forEach((button) => {
    const selected = button.dataset.debugTab === tab;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  document.querySelectorAll("[data-debug-view]").forEach((view) => {
    const selected = view.dataset.debugView === tab;
    view.classList.toggle("is-active", selected);
    view.hidden = !selected;
  });
  if (tab === "cpu") renderDebugSnapshot(latestDebugSnapshot);
  if (tab === "uart") renderUartConsole();
  syncNetworkDebugState();
}

function setInspectorOpen(open) {
  document.body.classList.toggle("inspector-open", open);
  inspectorPanel.classList.toggle("is-open", open);
  inspectorPanel.setAttribute("aria-hidden", String(!open));
  inspectorPanel.inert = !open;
  inspectorToggle.setAttribute("aria-expanded", String(open));
  if (open) {
    selectDebugTab(activeDebugTab);
    document.querySelector(`[data-debug-tab="${activeDebugTab}"]`).focus();
  } else {
    inspectorToggle.focus();
  }
  syncNetworkDebugState();
}

function isSimulatorFullscreen() {
  return document.fullscreenElement === simulatorStage || fullscreenFallback;
}

function syncFullscreenState() {
  const active = isSimulatorFullscreen();
  simulatorStage.classList.toggle("is-fullscreen", active);
  document.body.classList.toggle("simulator-fullscreen", fullscreenFallback);
  fullscreenToggle.setAttribute("aria-pressed", String(active));
  fullscreenToggle.setAttribute(
    "aria-label",
    active ? "退出模拟器全屏" : "全屏显示模拟器",
  );
  fullscreenToggle.title = active ? "退出模拟器全屏" : "全屏显示模拟器";
}

async function enterSimulatorFullscreen() {
  if (inspectorPanel.classList.contains("is-open")) setInspectorOpen(false);
  fullscreenFallback = true;
  syncFullscreenState();
  if (typeof simulatorStage.requestFullscreen === "function") {
    try {
      await simulatorStage.requestFullscreen();
      fullscreenFallback = false;
      syncFullscreenState();
      return;
    } catch {
      // Keep the viewport-filling mode when fullscreen is unavailable.
    }
  }
}

async function exitSimulatorFullscreen() {
  fullscreenFallback = false;
  if (document.fullscreenElement === simulatorStage) {
    await document.exitFullscreen();
  }
  syncFullscreenState();
}

async function toggleSimulatorFullscreen() {
  if (isSimulatorFullscreen()) {
    await exitSimulatorFullscreen();
    fullscreenToggle.focus();
    return;
  }
  await enterSimulatorFullscreen();
}

function drawFrame({ pixels, x = 0, y = 0, width, height }) {
  if (x + width > display.width || y + height > display.height) return;
  context.putImageData(
    new ImageData(new Uint8ClampedArray(pixels), width, height),
    x,
    y,
  );
}

function dispatchButtonEvent(key, event, visible = true) {
  let delivered = true;
  if (event === "PRESS") {
    delivered = key === "POWER" ? runtime.restart() : currentRuntimeState === "running";
  } else if (event === "LONG" && key !== "POWER") {
    delivered = runtime.setButton(key, true);
  } else if (["CLICK", "DOUBLE"].includes(event) && key !== "POWER") {
    delivered = runtime.sendButtonGesture(key, event);
  }
  if (visible) {
    const labels = {
      PRESS: "按下",
      CLICK: "单击",
      DOUBLE: "双击",
      LONG: "长按",
    };
    log(`${key} ${labels[event] || event}${delivered ? "" : "，等待运行时"}`);
  }
}

function queueButtonClick(key) {
  const pending = pendingButtonClicks.get(key);
  if (pending !== undefined) {
    window.clearTimeout(pending);
    pendingButtonClicks.delete(key);
    dispatchButtonEvent(key, "DOUBLE");
    return;
  }
  pendingButtonClicks.set(key, window.setTimeout(() => {
    pendingButtonClicks.delete(key);
    dispatchButtonEvent(key, "CLICK");
  }, DOUBLE_CLICK_WINDOW_MS));
}

function startButtonPress(key) {
  if (key === "POWER") {
    dispatchButtonEvent(key, "PRESS");
    return;
  }
  if (activeButtonGestures.has(key)) return;
  const state = { long: false, longTimer: 0 };
  activeButtonGestures.set(key, state);
  dispatchButtonEvent(key, "PRESS");
  state.longTimer = window.setTimeout(() => {
    if (activeButtonGestures.get(key) !== state) return;
    state.long = true;
    dispatchButtonEvent(key, "LONG");
  }, LONG_PRESS_MS);
}

function finishButtonPress(key, cancelled = false) {
  const state = activeButtonGestures.get(key);
  if (!state) return;
  window.clearTimeout(state.longTimer);
  if (state.long) runtime.setButton(key, false);
  activeButtonGestures.delete(key);
  if (!cancelled && !state.long) queueButtonClick(key);
}

function resetButtonGestures() {
  for (const [key, state] of activeButtonGestures) {
    window.clearTimeout(state.longTimer);
    if (state.long) runtime.setButton(key, false);
  }
  activeButtonGestures.clear();
  for (const timer of pendingButtonClicks.values()) window.clearTimeout(timer);
  pendingButtonClicks.clear();
  heldPointerButtons.clear();
  heldKeyboardButtons.clear();
}

function releasePointerButton(button, cancelled = false) {
  const key = button.dataset.key;
  if (!heldPointerButtons.delete(key)) return;
  finishButtonPress(key, cancelled);
}

runtime.addEventListener("state", (event) => {
  const state = event.detail;
  if (state === "loading" || state === "restarting") {
    audio.reset();
    resetScreenOverlay();
  }
  if (state === "running") {
    if (pendingPresetId !== undefined) activePresetId = pendingPresetId;
    pendingPresetId = undefined;
    setUploadBusy(false);
    setRuntimeState(state, `${activeFirmwareName} 已运行`);
    overlay.querySelector("small").textContent = "等待运行时镜像";
    presetFeedback.textContent = `${activeFirmwareName} 已刷写并运行`;
    log(`${activeFirmwareName} 已自动运行`);
  } else if (state === "loading") {
    resetButtonGestures();
    setUploadBusy(true);
    setRuntimeState(state, `正在加载 ${activeFirmwareName}`);
    overlay.querySelector("small").textContent = `正在加载 ${activeFirmwareName}`;
  } else {
    setRuntimeState(state, "QEMU 重启中");
    log("QEMU hard restart");
  }
  renderPresetStates();
});
runtime.addEventListener("frame", (event) => drawFrame(event.detail));
runtime.addEventListener("audio-config", (event) => audio.configure(event.detail));
runtime.addEventListener("audio", (event) => audio.play(event.detail));
runtime.addEventListener("firmware", () => {
  clearUartConsole();
  resetNetworkView();
  updateInspectorSource();
});
runtime.addEventListener("debug", (event) => {
  latestDebugSnapshot = event.detail;
  if (inspectorPanel.classList.contains("is-open") && activeDebugTab === "cpu") {
    renderDebugSnapshot(latestDebugSnapshot);
  }
});
runtime.addEventListener("uart", (event) => {
  uartBuffer.append(event.detail);
  scheduleUartRender();
  if (/\\b(error|fail|panic|abort)\\b/i.test(event.detail)) log(event.detail);
});
runtime.addEventListener("warning", (event) => log(event.detail));
runtime.addEventListener("network-status", (event) => {
  renderNetworkStatus(event.detail);
});
runtime.addEventListener("network-event", (event) => {
  if (
    activeDebugTab !== "network" ||
    !inspectorPanel.classList.contains("is-open")
  ) {
    return;
  }
  appendNetworkEvent(event.detail);
  if (event.detail.event === "connection-blocked") {
    log(`网络请求已阻止：${event.detail.target}`);
  }
});
runtime.addEventListener("unsupported-feature", (event) => {
  if (event.detail.feature !== "ble") return;
  audio.reset();
  setUploadBusy(false);
  setRuntimeState("unsupported", "检测到 BLE，模拟器已暂停");
  overlay.classList.add("is-unsupported");
  overlay.querySelector(".loading-dot").hidden = true;
  overlay.querySelector("strong").textContent = "模拟器暂不支持蓝牙";
  overlay.querySelector("small").textContent = "This Emulator Does Not Support BLE";
  presetFeedback.textContent = `${activeFirmwareName} 需要 BLE，已停止运行`;
  log(`${activeFirmwareName} 使用了暂不支持的 BLE`);
});
runtime.addEventListener("error", (event) => {
  pendingPresetId = undefined;
  setUploadBusy(false);
  setRuntimeState("error", "运行时不可用");
  overlay.querySelector("small").textContent = event.detail;
  presetFeedback.textContent = `加载失败：${event.detail}`;
  renderPresetStates();
  log(event.detail);
});

document.querySelectorAll("[data-key]").forEach((button) => {
  button.addEventListener("click", (event) => {
    if (event.detail === 0) {
      startButtonPress(button.dataset.key);
      finishButtonPress(button.dataset.key);
    }
  });
  button.addEventListener("pointerdown", (event) => {
    button.classList.add("is-pressed");
    audio.enableOutput().catch(() => {});
    if (!heldPointerButtons.has(button.dataset.key)) {
      heldPointerButtons.add(button.dataset.key);
      button.setPointerCapture?.(event.pointerId);
      startButtonPress(button.dataset.key);
    }
  });
  button.addEventListener("pointerup", () => {
    button.classList.remove("is-pressed");
    releasePointerButton(button);
  });
  button.addEventListener("pointercancel", () => {
    button.classList.remove("is-pressed");
    releasePointerButton(button, true);
  });
  button.addEventListener("pointerleave", () => button.classList.remove("is-pressed"));
});
document.querySelector("#restart-runtime").addEventListener("click", () => {
  if (!runtime.restart()) log("无法硬重启：WASM runtime 未安装");
});
audioEnable.addEventListener("click", async () => {
  try {
    await audio.enableOutput();
    audioEnable.classList.add("is-active");
    audioEnable.setAttribute("aria-pressed", "true");
    log("扬声器输出已启用");
  } catch (error) {
    log(`扬声器启用失败：${error.message}`);
  }
});
microphoneToggle.addEventListener("click", async () => {
  if (audio.microphoneActive) {
    audio.stopMicrophone();
    return;
  }
  try {
    await audio.startMicrophone();
  } catch (error) {
    log(`麦克风启用失败：${error.message}`);
  }
});
audio.addEventListener("microphone", (event) => {
  microphoneToggle.classList.toggle("is-active", event.detail);
  microphoneToggle.setAttribute("aria-pressed", String(event.detail));
  microphoneToggle.textContent = event.detail ? "MIC 已授权" : "授权 MIC";
  log(event.detail ? "麦克风输入已启用" : "麦克风输入已关闭");
});
inspectorToggle.addEventListener("click", () => {
  setInspectorOpen(!inspectorPanel.classList.contains("is-open"));
});
document.querySelector("#inspector-close").addEventListener("click", () => setInspectorOpen(false));
fullscreenToggle.addEventListener("click", toggleSimulatorFullscreen);
document.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement !== simulatorStage) fullscreenFallback = false;
  syncFullscreenState();
});
document.querySelectorAll("[data-debug-tab]").forEach((button) => {
  button.addEventListener("click", () => selectDebugTab(button.dataset.debugTab));
});
uartPause.addEventListener("click", () => setUartPaused(!uartPaused));
uartClear.addEventListener("click", clearUartConsole);
uartAutoscroll.addEventListener("change", () => {
  if (uartAutoscroll.checked) uartOutput.scrollTop = uartOutput.scrollHeight;
});
uartInputForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const command = uartInput.value;
  if (!runtime.sendUart(encodeUartCommand(command))) {
    log("UART 输入失败：运行时未就绪");
    return;
  }
  uartInput.value = "";
});
let selectedFirmwareSource = "community";
const uploadError = document.querySelector("#firmware-upload-error");

function selectFirmwareSource(source) {
  if (source === "local" && !allowLocalFirmwareUpload) {
    source = "community";
  }
  selectedFirmwareSource = source;
  uploadError.textContent = "";
  firmwareSourceTabs.forEach((button) => {
    const selected = button.id === `firmware-source-${source}-tab`;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  firmwareSourcePanels.forEach((panel) => {
    panel.hidden = panel.id !== `firmware-source-${source}`;
  });
  if (source === "community") {
    confirmFirmwareUpload.textContent = "导入并运行";
    window.setTimeout(() => communityPlayUrl.focus(), 0);
  } else {
    confirmFirmwareUpload.textContent = "选择固件";
  }
}

async function configureFirmwareSources() {
  try {
    const response = await fetch("/api/runtime-config", { cache: "no-store" });
    if (!response.ok) throw new Error(`运行配置请求失败: ${response.status}`);
    const config = await response.json();
    allowLocalFirmwareUpload = config.allowLocalFirmwareUpload === true;
  } catch (error) {
    allowLocalFirmwareUpload = false;
    log(`本地固件入口保持关闭：${error.message}`);
  }

  firmwareSourceTabList.hidden = !allowLocalFirmwareUpload;
  firmwareInput.disabled = !allowLocalFirmwareUpload;
  uploadControl.disabled = false;
  uploadControl.setAttribute("aria-disabled", "false");
  uploadLabel.textContent = allowLocalFirmwareUpload ? "上传固件" : "社区固件";
  firmwareGuidanceTitle.textContent =
    allowLocalFirmwareUpload ? "上传固件" : "加载社区固件";
  selectFirmwareSource(allowLocalFirmwareUpload ? "local" : "community");
}

async function loadPresetFirmware(button) {
  const firmwareName = button.dataset.firmwareName;
  const firmwareUrl = button.dataset.firmwareUrl;
  const previousFirmwareName = activeFirmwareName;
  const previousRuntimeState = currentRuntimeState;
  const previousRuntimeDetail = runtimeState.textContent;
  const previousPendingPresetId = pendingPresetId;

  try {
    pendingPresetId = button.dataset.firmwareId;
    activeFirmwareName = firmwareName;
    setUploadBusy(true);
    setRuntimeState("loading", `正在下载 ${firmwareName}`);
    overlay.querySelector("small").textContent = `正在读取 ${firmwareName}`;
    presetFeedback.textContent = `正在加载 ${firmwareName}`;
    renderPresetStates();

    const response = await fetch(firmwareUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`镜像请求失败: ${response.status}`);
    const firmware = await response.arrayBuffer();
    validateFirmwareFile({ name: firmwareUrl, size: firmware.byteLength });
    log(`加载 ${firmwareName} (${formatFirmwareSize(firmware.byteLength)})`);
    await runtime.loadFirmware(firmware);
  } catch (error) {
    pendingPresetId = previousPendingPresetId;
    activeFirmwareName = previousFirmwareName;
    setUploadBusy(false);
    setRuntimeState(previousRuntimeState, previousRuntimeDetail);
    presetFeedback.textContent = `${firmwareName} 加载失败：${error.message}`;
    renderPresetStates();
    log(`${firmwareName} 加载失败：${error.message}`);
  }
}

presetButtons.forEach((button) => {
  button.addEventListener("click", () => loadPresetFirmware(button));
});

firmwareSourceTabs.forEach((button) => {
  button.addEventListener("click", () => {
    selectFirmwareSource(button.id === "firmware-source-community-tab" ? "community" : "local");
  });
});

uploadControl.addEventListener("click", () => {
  selectFirmwareSource(allowLocalFirmwareUpload ? "local" : "community");
  firmwareGuidance.showModal();
});

async function importCommunityFirmware() {
  if (!communityPlayUrl.reportValidity()) return;
  const previousFirmwareName = activeFirmwareName;
  const previousRuntimeState = currentRuntimeState;
  const previousRuntimeDetail = runtimeState.textContent;
  const previousPendingPresetId = pendingPresetId;

  try {
    pendingPresetId = null;
    setUploadBusy(true);
    confirmFirmwareUpload.textContent = "正在导入…";
    setRuntimeState("loading", "正在读取社区固件");
    overlay.querySelector("small").textContent = "正在从 FoloToy 社区下载";
    presetFeedback.textContent = "正在导入社区固件";
    renderPresetStates();

    const response = await fetch("/api/community-firmware", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: communityPlayUrl.value.trim() }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || `社区固件请求失败: ${response.status}`);
    }

    const firmware = await response.arrayBuffer();
    let firmwareName = response.headers.get("x-firmware-name") || "社区固件";
    try {
      firmwareName = decodeURIComponent(firmwareName);
    } catch {
      firmwareName = "社区固件";
    }
    validateFirmwareFile({ name: `${firmwareName}.bin`, size: firmware.byteLength });
    activeFirmwareName = firmwareName;
    firmwareGuidance.close();
    log(`导入 ${firmwareName} (${formatFirmwareSize(firmware.byteLength)})`);
    await runtime.loadFirmware(firmware);
  } catch (error) {
    pendingPresetId = previousPendingPresetId;
    activeFirmwareName = previousFirmwareName;
    setUploadBusy(false);
    setRuntimeState(previousRuntimeState, previousRuntimeDetail);
    confirmFirmwareUpload.textContent = "导入并运行";
    uploadError.textContent = error.message;
    presetFeedback.textContent = `社区固件导入失败：${error.message}`;
    renderPresetStates();
    log(`社区固件导入失败：${error.message}`);
    if (!firmwareGuidance.open) firmwareGuidance.showModal();
  }
}

confirmFirmwareUpload.addEventListener("click", async () => {
  if (selectedFirmwareSource === "community") {
    await importCommunityFirmware();
    return;
  }
  if (!allowLocalFirmwareUpload) {
    selectFirmwareSource("community");
    uploadError.textContent = "当前部署不允许加载本地固件";
    return;
  }
  firmwareGuidance.close();
  firmwareInput.click();
});
communityPlayUrl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  importCommunityFirmware();
});
firmwareInput.addEventListener("change", async () => {
  const [file] = firmwareInput.files;
  firmwareInput.value = "";
  if (!allowLocalFirmwareUpload) return;
  if (!file) return;

  const previousFirmwareName = activeFirmwareName;
  const previousRuntimeState = currentRuntimeState;
  const previousRuntimeDetail = runtimeState.textContent;
  try {
    validateFirmwareFile(file);
    pendingPresetId = null;
    activeFirmwareName = file.name;
    setUploadBusy(true);
    setRuntimeState("loading", `正在读取 ${file.name}`);
    overlay.querySelector("small").textContent = `${formatFirmwareSize(file.size)} · 本地固件`;
    presetFeedback.textContent = `正在加载本地固件 ${file.name}`;
    renderPresetStates();
    log(`加载 ${file.name} (${formatFirmwareSize(file.size)})`);
    await runtime.loadFirmware(await file.arrayBuffer());
  } catch (error) {
    pendingPresetId = undefined;
    activeFirmwareName = previousFirmwareName;
    setUploadBusy(false);
    setRuntimeState(previousRuntimeState, previousRuntimeDetail);
    presetFeedback.textContent = `本地固件加载失败：${error.message}`;
    renderPresetStates();
    log(error.message);
    uploadError.textContent = error.message;
    firmwareGuidance.showModal();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && fullscreenFallback) {
    event.preventDefault();
    exitSimulatorFullscreen().then(() => fullscreenToggle.focus());
    return;
  }
  if (event.key === "Escape" && inspectorPanel.classList.contains("is-open")) {
    event.preventDefault();
    setInspectorOpen(false);
    return;
  }
  if (event.target.closest("input, select, button")) return;
  const keys = { ArrowUp: "UP", ArrowDown: "DOWN", Enter: "OK", p: "POWER", P: "POWER" };
  const key = keys[event.key];
  if (!key) return;
  event.preventDefault();
  if (event.repeat) return;
  if (heldKeyboardButtons.has(key)) return;
  heldKeyboardButtons.add(key);
  startButtonPress(key);
});
document.addEventListener("keyup", (event) => {
  const keys = { ArrowUp: "UP", ArrowDown: "DOWN", Enter: "OK", p: "POWER", P: "POWER" };
  const key = keys[event.key];
  if (!key || !heldKeyboardButtons.delete(key)) return;
  event.preventDefault();
  finishButtonPress(key);
});
window.addEventListener("blur", () => {
  for (const key of heldPointerButtons) finishButtonPress(key, true);
  heldPointerButtons.clear();
  for (const key of heldKeyboardButtons) finishButtonPress(key, true);
  heldKeyboardButtons.clear();
});

buildRegisterGrid();
renderUartConsole();
resetNetworkView();
setRuntimeState("waiting", "等待运行时");
clearDisplay();
renderPresetStates();

async function startApplication() {
  await configureFirmwareSources();
  showSimulatorNoticeOnce(simulatorNotice);
  runtime.start(initialPresetButton.dataset.firmwareUrl).catch((error) => {
    setUploadBusy(false);
    setRuntimeState("waiting", "等待 WASM QEMU");
    overlay.querySelector("small").textContent = "放入 /public/wasm/manifest.json 后自动启动";
    log(error.message);
  });
}

startApplication();
