import init, { WasmEmulator } from "./pkg/esp_emu.js";
import { AiPassportBoard } from "./ai-passport-board.js";
import { detectUnsupportedFeature } from "./unsupported-features.js";
import {
  EMULATOR_WIFI_PASSWORD,
  EMULATOR_WIFI_SSID,
  EmulatorNetworkBridge,
} from "./network.js";

const DEFAULT_BATCH_SIZE = 50_000;
const FRAME_BUDGET_MS = 12;
const DEBUG_INTERVAL_MS = 250;
const CLICK_CYCLES = 12_000_000;
const DOUBLE_GAP_CYCLES = 16_000_000;
const LONG_CYCLES = 180_000_000;

let wasm;
let emulator;
let board;
let network;
let networkDebugEnabled = false;
let running = false;
let generation = 0;
let lastDebugAt = 0;
let buttonTransitions = [];
let buttonBusyUntil = 0;

function reportProgress(value, stage, detail) {
  postMessage({ type: "progress", value, stage, detail });
}

function copyDirtyPixels(frame) {
  const { width, pixels, dirtyRegion } = frame;
  const output = new Uint8ClampedArray(
    dirtyRegion.width * dirtyRegion.height * 4,
  );
  for (let row = 0; row < dirtyRegion.height; row += 1) {
    const sourceOffset =
      ((dirtyRegion.y + row) * width + dirtyRegion.x) * 4;
    const targetOffset = row * dirtyRegion.width * 4;
    output.set(
      pixels.subarray(
        sourceOffset,
        sourceOffset + dirtyRegion.width * 4,
      ),
      targetOffset,
    );
  }
  return output;
}

function reportFrame(frame) {
  const pixels = copyDirtyPixels(frame);
  postMessage({
    type: "frame",
    x: frame.dirtyRegion.x,
    y: frame.dirtyRegion.y,
    width: frame.dirtyRegion.width,
    height: frame.dirtyRegion.height,
    displayOn: frame.displayOn,
    pixels,
  }, [pixels.buffer]);
}

function reportAudio(packet) {
  postMessage({
    type: "audio_config",
    sampleRate: packet.sampleRate,
    bits: packet.bits,
    channels: packet.channels,
  });
  postMessage(packet, [packet.bytes.buffer]);
}

function createBoard() {
  board = new AiPassportBoard(wasm, {
    emulator,
    onFrame: reportFrame,
    onAudio: reportAudio,
    onUnknownEvent: (event) => {
      postMessage({
        type: "warning",
        message: `Unknown board event ${event.eventType}`,
      });
    },
  });
  board.releaseButtons();
  buttonTransitions = [];
  buttonBusyUntil = emulator.cycles();
}

function queueButtonGesture(name, gesture) {
  const start = Math.max(emulator.cycles(), buttonBusyUntil);
  const transitions = [{ cycle: start, name, pressed: true }];
  if (gesture === "DOUBLE") {
    transitions.push(
      { cycle: start + CLICK_CYCLES, name, pressed: false },
      { cycle: start + CLICK_CYCLES + DOUBLE_GAP_CYCLES, name, pressed: true },
      { cycle: start + 2 * CLICK_CYCLES + DOUBLE_GAP_CYCLES, name, pressed: false },
    );
  } else {
    transitions.push({
      cycle: start + (gesture === "LONG" ? LONG_CYCLES : CLICK_CYCLES),
      name,
      pressed: false,
    });
  }
  buttonTransitions.push(...transitions);
  buttonBusyUntil = transitions.at(-1).cycle;
  serviceButtonTransitions();
}

function serviceButtonTransitions() {
  const cycles = emulator?.cycles() ?? 0;
  while (buttonTransitions.length && buttonTransitions[0].cycle <= cycles) {
    const transition = buttonTransitions.shift();
    board.setButton(transition.name, transition.pressed);
  }
}

function postDebugSnapshot(now) {
  if (!emulator || now - lastDebugAt < DEBUG_INTERVAL_MS) return;
  lastDebugAt = now;
  const registers = new Uint32Array(32);
  for (let index = 0; index < registers.length; index += 1) {
    registers[index] = emulator.get_reg(index);
  }
  postMessage({
    type: "debug",
    pc: emulator.pc(),
    cycles: emulator.cycles(),
    registers,
  }, [registers.buffer]);
}

async function start(firmware, debugEnabled = false) {
  running = false;
  network?.close();
  networkDebugEnabled = Boolean(debugEnabled);
  const currentGeneration = ++generation;
  reportProgress(70, "正在初始化 WebAssembly", "编译并载入 ESP32-C3 模拟核心");
  wasm = await init();
  reportProgress(80, "正在创建虚拟设备", "初始化 ESP32-C3 处理器");
  emulator = new WasmEmulator("esp32c3");
  reportProgress(86, "正在载入系统 ROM", "配置启动模式与虚拟 Wi-Fi");
  emulator.load_default_rom();
  emulator.set_boot_from_rom(true);
  emulator.set_wifi_config(EMULATOR_WIFI_SSID, EMULATOR_WIFI_PASSWORD);
  reportProgress(91, "正在刷写固件镜像", "写入虚拟 Flash");
  emulator.load_firmware(new Uint8Array(firmware));
  reportProgress(95, "正在连接虚拟外设", "启动显示、音频与网络桥接");
  const protocol = self.location.protocol === "https:" ? "wss:" : "ws:";
  network = new EmulatorNetworkBridge(emulator, {
    url: `${protocol}//${self.location.host}/api/emulator-network`,
    onStatus: (detail) => postMessage({ type: "network-status", detail }),
    onEvent: (detail) => postMessage({ type: "network-event", detail }),
  });
  network.setDebugEnabled(networkDebugEnabled);
  network.connect();
  createBoard();
  reportProgress(98, "正在启动固件", "等待模拟器进入运行状态");
  running = true;
  lastDebugAt = 0;
  postMessage({ type: "ready" });
  runLoop(currentGeneration);
}

function restart() {
  if (!emulator) return;
  const resumeLoop = !running;
  postMessage({ type: "state", state: "restarting" });
  reportProgress(42, "正在重置处理器", "清理当前执行状态");
  emulator.restart();
  reportProgress(76, "正在恢复虚拟外设", "重新连接按键、显示与音频");
  createBoard();
  running = true;
  reportProgress(98, "正在启动固件", "等待模拟器恢复运行");
  postMessage({ type: "ready" });
  if (resumeLoop) runLoop(++generation);
}

function runLoop(currentGeneration) {
  if (!running || currentGeneration !== generation || !emulator) return;
  const started = performance.now();
  let uart = "";
  while (
    running &&
    currentGeneration === generation &&
    performance.now() - started < FRAME_BUDGET_MS
  ) {
    serviceButtonTransitions();
    uart += emulator.run_batch(DEFAULT_BATCH_SIZE);
    const unsupportedFeature = detectUnsupportedFeature(emulator.pc());
    if (unsupportedFeature) {
      running = false;
      generation += 1;
      postMessage({ type: "unsupported-feature", feature: unsupportedFeature });
      break;
    }
    serviceButtonTransitions();
    board.drain();
    board.pumpAudio(performance.now());
    network?.drain();
    if (emulator.needs_restart()) restart();
  }
  if (uart) {
    postMessage({ type: "uart", data: uart });
  }
  const now = performance.now();
  postDebugSnapshot(now);
  const dropped = board.droppedEvents();
  if (dropped) {
    postMessage({
      type: "warning",
      message: `${dropped} board events were dropped`,
    });
  }
  setTimeout(() => runLoop(currentGeneration), 0);
}

self.addEventListener("message", async (event) => {
  try {
    switch (event.data.type) {
      case "start":
        await start(event.data.firmware, event.data.networkDebug);
        break;
      case "button":
        // A physical hold supersedes any synthetic gesture for this key.
        buttonTransitions = buttonTransitions.filter(t => t.name !== event.data.name);
        buttonBusyUntil = buttonTransitions.at(-1)?.cycle ?? emulator?.cycles() ?? 0;
        board?.setButton(event.data.name, event.data.pressed);
        break;
      case "button-gesture":
        if (board) queueButtonGesture(event.data.name, event.data.gesture);
        break;
      case "release-buttons":
        buttonTransitions = [];
        buttonBusyUntil = emulator?.cycles() ?? 0;
        board?.releaseButtons();
        break;
      case "microphone":
        board?.pushMicrophone(event.data.bytes);
        break;
      case "uart-input":
        emulator?.uart_input(new Uint8Array(event.data.bytes));
        break;
      case "network-debug":
        networkDebugEnabled = Boolean(event.data.enabled);
        network?.setDebugEnabled(networkDebugEnabled);
        break;
      case "restart":
        restart();
        break;
      case "stop":
        running = false;
        generation += 1;
        network?.close();
        postMessage({ type: "state", state: "stopped" });
        break;
      default:
        throw new Error(`Unknown worker message: ${event.data.type}`);
    }
  } catch (error) {
    running = false;
    postMessage({
      type: "error",
      message: error?.message || String(error),
    });
  }
});
