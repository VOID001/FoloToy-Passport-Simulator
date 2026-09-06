import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("shows the hardware compatibility notice when the site opens", () => {
  assert.match(html, /<dialog id="simulator-notice"/);
  assert.match(html, /这是模拟器，不是真实硬件/);
  assert.match(html, /Wi-Fi 通过 Emulator Host Bridge 联网/);
  assert.match(html, /发布固件前请在真实设备上复测/);
  assert.match(app, /simulatorNotice\.showModal\(\)/);
});
