import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("keeps Wi-Fi diagnostics inside the unified inspector", () => {
  assert.doesNotMatch(html, /id="network-toggle"/);
  assert.match(html, /data-debug-tab="network"[^>]*>Wi-Fi<\/button>/);
});

test("records network activity only while the Wi-Fi inspector is visible", () => {
  assert.match(
    app,
    /activeDebugTab !== "network"[\s\S]*!inspectorPanel\.classList\.contains\("is-open"\)[\s\S]*return;/,
  );
  assert.match(app, /runtime\.setNetworkDebug\(enabled\)/);
});
