import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(directory, "..", "public");
const firmwarePath = path.join(
  publicRoot,
  "assets",
  "firmware",
  "folotoy-demo.bin",
);
const wasmPath = path.join(publicRoot, "wasm", "pkg", "esp_emu_bg.wasm");
const wrapperPath = path.join(publicRoot, "wasm", "pkg", "esp_emu.js");

const firmware = await readFile(firmwarePath);
const wasmBytes = await readFile(wasmPath);

assert.equal(
  createHash("sha256").update(firmware).digest("hex"),
  "38c8f5f611cb670085354e3d08a7d67c6f026cb1ef43d9bba92a6822d749045c",
  "official firmware checksum mismatch",
);
assert.equal(
  createHash("sha256").update(wasmBytes).digest("hex"),
  "cc6e1de345521da73176019cbd0bc2963d71bed80c11fbbb3e57d52fb99ecfc8",
  "patched ESP-EMU checksum mismatch",
);

const { default: init } = await import(pathToFileURL(wrapperPath));
const wasm = await init({ module_or_path: wasmBytes });
assert.equal(wasm.ap_board_abi_version(), 1, "unsupported board ABI");

process.stdout.write(
  `Verified official firmware (${firmware.byteLength} bytes) and board ABI v1\n`,
);
