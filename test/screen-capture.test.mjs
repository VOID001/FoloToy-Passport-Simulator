import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canvasToPngBlob,
  copyCanvasPngToClipboard,
} from "../public/screen-capture.js";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("offers an accessible control for copying the simulator screen", () => {
  const shellStart = html.indexOf('<div class="passport-shell">');
  const captureButton = html.indexOf('id="screenshot-copy"');

  assert.ok(captureButton > shellStart);
  assert.match(html, /aria-label="截取模拟器屏幕并复制到剪贴板"/);
  assert.match(html, /id="screenshot-feedback"[\s\S]*aria-live="polite"/);
  assert.match(app, /copyCanvasPngToClipboard\(display\)/);
});

test("copies a PNG while clipboard access is still in the click task", async () => {
  const events = [];
  const blob = new Blob(["screen"], { type: "image/png" });
  const canvas = {
    toBlob(callback, type) {
      events.push(`encode:${type}`);
      queueMicrotask(() => {
        events.push("encoded");
        callback(blob);
      });
    },
  };
  class FakeClipboardItem {
    constructor(data) {
      events.push("item");
      this.data = data;
    }
  }
  const clipboard = {
    async write([item]) {
      events.push("write");
      assert.equal(await item.data["image/png"], blob);
    },
  };

  const result = await copyCanvasPngToClipboard(canvas, {
    clipboard,
    ClipboardItemClass: FakeClipboardItem,
  });

  assert.equal(result, blob);
  assert.deepEqual(events.slice(0, 3), ["encode:image/png", "item", "write"]);
});

test("reports unavailable clipboard image support", async () => {
  await assert.rejects(
    copyCanvasPngToClipboard({ toBlob() {} }, {
      clipboard: {},
      ClipboardItemClass: undefined,
    }),
    /当前浏览器不支持复制图片到剪贴板/,
  );
});

test("rejects when the canvas cannot produce a PNG", async () => {
  await assert.rejects(
    canvasToPngBlob({
      toBlob(callback) {
        callback(null);
      },
    }),
    /无法生成屏幕截图/,
  );
});
