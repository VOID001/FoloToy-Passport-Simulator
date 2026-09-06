import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("offers an accessible simulator-only fullscreen mode", () => {
  assert.match(html, /id="fullscreen-toggle"/);
  assert.match(html, /aria-controls="simulator-stage"/);
  assert.match(html, /id="fullscreen-exit"/);
  assert.match(html, /aria-label="退出全屏"/);
  assert.match(app, /simulatorStage\.requestFullscreen\(\)/);
  assert.match(app, /document\.exitFullscreen\(\)/);
  assert.match(app, /document\.addEventListener\("fullscreenchange"/);
});

test("keeps the simulator fitted to fullscreen viewports with a fallback", () => {
  assert.match(css, /\.stage:fullscreen,/);
  assert.match(css, /100svh/);
  assert.match(css, /body\.simulator-fullscreen \.stage\.is-fullscreen/);
  assert.match(app, /fullscreenFallback = true/);
});
