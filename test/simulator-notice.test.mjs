import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SIMULATOR_NOTICE_STORAGE_KEY,
  showSimulatorNoticeOnce,
} from "../public/simulator-notice.js";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("includes the hardware compatibility notice", () => {
  assert.match(html, /<dialog id="simulator-notice"/);
  assert.match(html, /此模拟器仅供娱乐体验使用，非硬件真实完整模拟/);
  assert.doesNotMatch(html, /当前网页版兼容情况/);
  assert.match(html, /<dt>屏幕显示<\/dt>\s*<dd class="is-supported">兼容<\/dd>/);
  assert.match(html, /<dt>音频<\/dt>\s*<dd class="is-supported">兼容<\/dd>/);
  assert.match(html, /<dt>Wifi<\/dt>\s*<dd class="is-virtual">虚拟网络<\/dd>/);
  assert.match(html, /<dt>按键<\/dt>\s*<dd class="is-supported">兼容<\/dd>/);
  for (const feature of ["BLE", "NFC", "Battery"]) {
    assert.match(html, new RegExp(`<dt>${feature}</dt>\\s*<dd class="is-unsupported">不支持</dd>`));
  }
  assert.match(html, /发布固件前请在真实设备上复测/);
  assert.match(app, /showSimulatorNoticeOnce\(simulatorNotice\)/);
});

test("shows the notice only once after it is first presented", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  let openCount = 0;
  const dialog = {
    showModal() {
      openCount += 1;
    },
  };

  assert.equal(showSimulatorNoticeOnce(dialog, storage), true);
  assert.equal(values.get(SIMULATOR_NOTICE_STORAGE_KEY), "1");
  assert.equal(showSimulatorNoticeOnce(dialog, storage), false);
  assert.equal(openCount, 1);
});

test("still shows the notice when browser storage is unavailable", () => {
  const storage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  let openCount = 0;

  assert.doesNotThrow(() => {
    showSimulatorNoticeOnce({
      showModal() {
        openCount += 1;
      },
    }, storage);
  });
  assert.equal(openCount, 1);
});
