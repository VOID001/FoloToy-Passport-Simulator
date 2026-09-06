import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MAX_FIRMWARE_BYTES } from "../public/firmware.js";

const publicRoot = new URL("../public/", import.meta.url);
const expectedPresets = new Map([
  [
    "/assets/firmware/music-keychain.bin",
    "fc16e29a643551a342d899f2515941bf555a7a7eaa193c012aec38789d6e7280",
  ],
  [
    "/assets/firmware/answer-book.bin",
    "b4eedd4df80a101e7ad217827b7b826908983ac76b82df82b00c8458752d5f7d",
  ],
  [
    "/assets/firmware/folotoy-demo.bin",
    "38c8f5f611cb670085354e3d08a7d67c6f026cb1ef43d9bba92a6822d749045c",
  ],
]);

test("ships every firmware preset referenced by the sidebar", async () => {
  const html = await readFile(new URL("index.html", publicRoot), "utf8");
  const catalog = JSON.parse(
    await readFile(new URL("assets/firmware/catalog.json", publicRoot), "utf8"),
  );
  const urls = [...html.matchAll(/data-firmware-url="([^"]+)"/g)]
    .map((match) => match[1]);

  assert.deepEqual(urls, [...expectedPresets.keys()]);
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.default, "official-demo");
  assert.deepEqual(
    catalog.firmwares.map((firmware) => firmware.file),
    [...expectedPresets.keys()],
  );

  for (const [index, [url, expectedSha256]] of [...expectedPresets].entries()) {
    const firmware = await readFile(new URL(url.slice(1), publicRoot));
    assert.ok(firmware.byteLength > 0);
    assert.ok(firmware.byteLength <= MAX_FIRMWARE_BYTES);
    assert.equal(catalog.firmwares[index].bytes, firmware.byteLength);
    assert.equal(catalog.firmwares[index].sha256, expectedSha256);
    assert.equal(
      createHash("sha256").update(firmware).digest("hex"),
      expectedSha256,
    );
  }
});
