import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(directory, "..");
const outputRoot = path.join(projectRoot, "dist");

const checksums = (await readFile(path.join(outputRoot, "SHA256SUMS"), "utf8"))
  .trim()
  .split("\n")
  .map((line) => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    assert.ok(match, `invalid checksum line: ${line}`);
    return { expected: match[1], filename: match[2] };
  });

for (const { expected, filename } of checksums) {
  const bytes = await readFile(path.join(outputRoot, filename));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    expected,
    `${filename} checksum mismatch`,
  );
}

for (const required of [
  "server.mjs",
  "community-import.mjs",
  "logging.mjs",
  "package.json",
  "release-manifest.json",
  "public/index.html",
  "public/assets/firmware/catalog.json",
  "public/wasm/pkg/esp_emu_bg.wasm",
]) {
  assert.ok((await stat(path.join(outputRoot, required))).isFile(), `${required} is missing`);
}

const releaseManifest = JSON.parse(
  await readFile(path.join(outputRoot, "release-manifest.json"), "utf8"),
);
assert.equal(releaseManifest.entrypoint, "server.mjs");
assert.equal(releaseManifest.healthcheck, "/healthz");

process.stdout.write(`Verified dist/ (${checksums.length} checksums)\n`);
