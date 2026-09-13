import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createAppServer,
  localFirmwareUploadEnabled,
} from "../server.mjs";

test("local firmware upload requires an explicit server capability", () => {
  assert.equal(localFirmwareUploadEnabled({ env: {}, argv: [] }), false);
  assert.equal(
    localFirmwareUploadEnabled({
      env: {},
      argv: ["node", "server.mjs", "--allow-local-firmware-upload"],
    }),
    true,
  );
  assert.equal(
    localFirmwareUploadEnabled({
      env: { EMULATOR_ALLOW_LOCAL_FIRMWARE_UPLOAD: "1" },
      argv: [],
    }),
    true,
  );
  assert.equal(
    localFirmwareUploadEnabled({
      env: { EMULATOR_ALLOW_LOCAL_FIRMWARE_UPLOAD: "0" },
      argv: ["node", "server.mjs", "--allow-local-firmware-upload"],
    }),
    false,
  );
});

test("runtime config exposes the server-selected firmware policy", async (t) => {
  const server = createAppServer({ allowLocalFirmwareUpload: false });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/runtime-config`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    allowLocalFirmwareUpload: false,
    analytics: null,
  });
});

test("firmware UI starts in fail-closed community mode", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(html, /id="firmware-file"[\s\S]*aria-label="选择固件文件" disabled/);
  assert.match(html, /class="firmware-source-tabs"[^>]*hidden/);
  assert.match(
    html,
    /id="firmware-source-community-tab" class="firmware-source-tab is-active"/,
  );
  assert.match(app, /let allowLocalFirmwareUpload = false/);
  assert.match(app, /if \(!allowLocalFirmwareUpload\) return;/);
});
