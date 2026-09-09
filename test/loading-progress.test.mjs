import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const publicRoot = new URL("../public/", import.meta.url);
const [html, css, app, runtime, worker] = await Promise.all([
  readFile(new URL("index.html", publicRoot), "utf8"),
  readFile(new URL("styles.css", publicRoot), "utf8"),
  readFile(new URL("app.js", publicRoot), "utf8"),
  readFile(new URL("runtime.js", publicRoot), "utf8"),
  readFile(new URL("wasm/qemu-worker.js", publicRoot), "utf8"),
]);

test("replaces the blinking dot with an accessible percentage progress bar", () => {
  assert.doesNotMatch(html, /loading-dot/);
  assert.match(html, /id="loading-progress"[\s\S]*role="progressbar"/);
  assert.match(html, /aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"/);
  assert.match(html, /id="loading-percent">0%<\/output>/);
  assert.match(css, /\.loading-progress-track/);
  assert.match(css, /transition: width/);
});

test("reports download bytes and detailed emulator startup stages", () => {
  assert.match(app, /response\.body\.getReader\(\)/);
  assert.match(app, /aria-valuetext/);
  assert.match(runtime, /new CustomEvent\("progress"/);
  for (const stage of [
    "正在初始化 WebAssembly",
    "正在创建虚拟设备",
    "正在载入系统 ROM",
    "正在刷写固件镜像",
    "正在连接虚拟外设",
    "正在启动固件",
  ]) {
    assert.match(worker, new RegExp(stage));
  }
});
